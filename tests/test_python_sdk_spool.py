"""Tests for the Python SDK's durable local queue / spool (issue #101).

Shared cross-language vectors (transient classification, spool file naming, drain response handling) live
in ``tests/fixtures/sdk-queue-scenarios.json`` and are documented in ``docs/sdk-queue.md``; the TypeScript
SDK (#102) is expected to load and pass the same vectors. Style follows ``tests/test_python_sdk.py``
(``unittest``, a small scripted ``http.server`` thread for deterministic server responses).
"""

import http.server
import json
import os
import random
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request

sys.path.insert(0, ".")

from sdk.python.agent_viewer import (
    AgentViewer,
    AgentViewerError,
    FlushResult,
    SpoolStats,
    _is_transient_http_status,
    _spool_file_name,
)

_SCENARIOS_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "sdk-queue-scenarios.json")
with open(_SCENARIOS_PATH, "r", encoding="utf-8") as _f:
    SCENARIOS = json.load(_f)


def get_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _ScriptedBatchHandler(http.server.BaseHTTPRequestHandler):
    """Answers every POST to /api/v1/events/batch with the next scripted (status, body, headers) tuple,
    cycling to the last one once exhausted. ``abrupt_close`` (set per class) makes every request simply
    close the connection with no response, simulating a reset/closed-early peer. Records every raw request
    body received in ``requests`` (bytes), for byte-identity assertions.
    """

    responses = []
    requests = []
    abrupt_close = False

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        type(self).requests.append(body)
        if type(self).abrupt_close:
            self.close_connection = True
            return
        index = min(len(type(self).requests) - 1, len(type(self).responses) - 1)
        status, payload, headers = type(self).responses[index]
        response_body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response_body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(response_body)

    def log_message(self, *args):
        pass


def _run_scripted_batch_server(responses=None, abrupt_close=False):
    _ScriptedBatchHandler.responses = responses or []
    _ScriptedBatchHandler.requests = []
    _ScriptedBatchHandler.abrupt_close = abrupt_close
    httpd = http.server.HTTPServer(("127.0.0.1", 0), _ScriptedBatchHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, thread, f"http://127.0.0.1:{httpd.server_address[1]}"


def _read_spool_rows(spool_path):
    """Reads every row of the spool table directly, bypassing the SDK, for white-box assertions."""
    conn = sqlite3.connect(spool_path)
    try:
        return conn.execute("SELECT seq, event_id, event_type, event_json FROM spool ORDER BY seq ASC").fetchall()
    finally:
        conn.close()


def _spool_path_for(tmp_dir, url, runtime_id):
    return os.path.join(tmp_dir, _spool_file_name(url, runtime_id))


class TestTransientClassification(unittest.TestCase):
    """Exhaustively checks the shared ``transientClassification`` status vectors (pure function, no
    network), then spot-checks a handful of the exception categories against the real retry loop."""

    def test_status_vectors_match_shared_fixture(self):
        for case in SCENARIOS["transientClassification"]["cases"]:
            if case["kind"] != "status":
                continue
            with self.subTest(name=case["name"]):
                self.assertEqual(_is_transient_http_status(case["status"]), case["transient"], case["name"])

    def test_connection_refused_is_transient(self):
        port = get_free_port()  # nothing listens here
        viewer = AgentViewer(url=f"http://127.0.0.1:{port}", max_retries=0, timeout=1.0)
        with self.assertRaises(AgentViewerError) as ctx:
            viewer.emit("agent.status.changed", "s", {"status": "IDLE"})
        self.assertTrue(ctx.exception.transient)

    def test_connection_reset_while_reading_response_is_transient(self):
        httpd, thread, url = _run_scripted_batch_server(abrupt_close=True)
        try:
            viewer = AgentViewer(url=url, max_retries=0, timeout=2.0)
            with self.assertRaises(AgentViewerError) as ctx:
                viewer.emit("agent.status.changed", "s", {"status": "IDLE"})
            self.assertTrue(ctx.exception.transient)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_http_408_is_retried_and_transient(self):
        httpd, thread, url = _run_scripted_batch_server(responses=[(408, {"error": "request_timeout"}, {})])
        try:
            # emit() posts to /api/v1/events, not /api/v1/events/batch, but the scripted handler answers any POST.
            viewer = AgentViewer(url=url, max_retries=0, timeout=2.0)
            with self.assertRaises(AgentViewerError) as ctx:
                viewer.emit("agent.status.changed", "s", {"status": "IDLE"})
            self.assertEqual(ctx.exception.status_code, 408)
            self.assertTrue(ctx.exception.transient)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_http_400_is_not_transient_and_not_retried(self):
        httpd, thread, url = _run_scripted_batch_server(responses=[(400, {"error": "validation_failed"}, {})])
        try:
            viewer = AgentViewer(url=url, max_retries=3, timeout=2.0)
            with self.assertRaises(AgentViewerError) as ctx:
                viewer.emit("agent.status.changed", "s", {"status": "IDLE"})
            self.assertFalse(ctx.exception.transient)
            self.assertEqual(len(_ScriptedBatchHandler.requests), 1, "a conclusive 4xx must not be retried")
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)


class TestSpoolFileNaming(unittest.TestCase):
    def test_hash_vectors_match_shared_fixture(self):
        for case in SCENARIOS["spoolFileNaming"]["cases"]:
            with self.subTest(url=case["url"], runtimeId=case["runtimeId"]):
                name = _spool_file_name(case["url"], case["runtimeId"])
                self.assertEqual(name, f"spool-{case['expectedHashPrefix']}.sqlite3")

    def test_different_urls_or_runtime_ids_never_collide(self):
        names = {
            _spool_file_name("http://localhost:8787", "a"),
            _spool_file_name("http://localhost:8787", "b"),
            _spool_file_name("http://localhost:8788", "a"),
            _spool_file_name("http://localhost:8787", None),
        }
        self.assertEqual(len(names), 4)


class TestDisabledSpoolIsALegacyNoOp(unittest.TestCase):
    def test_spool_stats_and_flush_are_zeroed_and_disabled(self):
        viewer = AgentViewer(url="http://localhost:8787")
        self.assertEqual(viewer.spool_stats(), SpoolStats(state="disabled"))
        self.assertEqual(
            viewer.flush(), FlushResult(delivered=0, remaining=0, rejected=0, timed_out=False, state="disabled")
        )
        self.assertEqual(viewer.spool_rejected(), [])
        viewer.close()  # must be a no-op, never raise

    def test_default_behavior_unchanged_raises_agent_viewer_error(self):
        port = get_free_port()
        viewer = AgentViewer(url=f"http://127.0.0.1:{port}", max_retries=0, timeout=1.0)
        with self.assertRaises(AgentViewerError):
            viewer.emit("agent.status.changed", "s", {"status": "IDLE"})

    def test_invalid_constructor_arguments_raise_value_error(self):
        with self.assertRaises(ValueError):
            AgentViewer(url="http://localhost:8787", spool_max_events=0)
        with self.assertRaises(ValueError):
            AgentViewer(url="http://localhost:8787", spool_max_bytes=0)
        with self.assertRaises(ValueError):
            AgentViewer(url="http://localhost:8787", spool_overflow="drop_random")
        with self.assertRaises(ValueError):
            AgentViewer(url="http://localhost:8787", spool_batch_size=0)
        with self.assertRaises(ValueError):
            AgentViewer(url="http://localhost:8787", spool_batch_size=101)


class TestEnqueueWhenServerIsDown(unittest.TestCase):
    def test_emit_does_not_raise_and_queues_on_disk(self):
        port = get_free_port()
        with tempfile.TemporaryDirectory() as tmp:
            viewer = AgentViewer(
                url=f"http://127.0.0.1:{port}", max_retries=1, timeout=1.0, spool_dir=tmp, spool_background=False
            )
            result = viewer.emit("agent.status.changed", "s", {"status": "IDLE"}, event_id="evt_down_1")
            self.assertEqual(result, {"accepted": False, "queued": True, "duplicate": False, "id": "evt_down_1"})
            rows = _read_spool_rows(viewer._spool.path)
            self.assertEqual([r[1] for r in rows], ["evt_down_1"])
            viewer.close()

    def test_emit_batch_queues_each_event_individually(self):
        port = get_free_port()
        with tempfile.TemporaryDirectory() as tmp:
            viewer = AgentViewer(
                url=f"http://127.0.0.1:{port}", max_retries=1, timeout=1.0, spool_dir=tmp, spool_background=False
            )
            result = viewer.emit_batch(
                [
                    {"id": "evt_b1", "type": "tool.started", "payload": {"tool": "a"}},
                    {"id": "evt_b2", "type": "tool.started", "payload": {"tool": "b"}},
                ]
            )
            self.assertEqual(result, {"accepted": False, "queued": True, "total": 2, "ids": ["evt_b1", "evt_b2"]})
            self.assertEqual(viewer.spool_stats().pending_events, 2)
            viewer.close()

    def test_emit_returns_immediately_once_backlogged(self):
        port = get_free_port()
        with tempfile.TemporaryDirectory() as tmp:
            viewer = AgentViewer(
                url=f"http://127.0.0.1:{port}", max_retries=2, timeout=1.0, spool_dir=tmp, spool_background=False
            )
            # First call pays the normal retry budget before it discovers the server is down.
            viewer.emit("agent.status.changed", "s1", {"status": "IDLE"}, event_id="evt_t1")

            def _must_not_be_called(*a, **k):
                raise AssertionError("a backlogged emit() must never attempt a live send")

            viewer._post_with_retry = _must_not_be_called
            start = time.monotonic()
            viewer.emit("agent.status.changed", "s2", {"status": "IDLE"}, event_id="evt_t2")
            elapsed = time.monotonic() - start
            self.assertLess(elapsed, 0.2, "a backlogged emit() must return immediately, not pay the retry budget")
            rows = _read_spool_rows(viewer._spool.path)
            self.assertEqual([r[1] for r in rows], ["evt_t1", "evt_t2"], "order preserved across the transition")
            viewer.close()

    def test_reemitting_a_queued_id_is_a_noop_not_a_drop(self):
        port = get_free_port()
        with tempfile.TemporaryDirectory() as tmp:
            viewer = AgentViewer(
                url=f"http://127.0.0.1:{port}", max_retries=1, timeout=1.0, spool_dir=tmp, spool_background=False
            )
            viewer.emit("agent.status.changed", "s", {"status": "IDLE"}, event_id="evt_dup")
            result2 = viewer.emit("agent.status.changed", "s", {"status": "IDLE"}, event_id="evt_dup")
            self.assertEqual(result2["queued"], True)
            self.assertEqual(viewer.spool_stats().pending_events, 1)
            self.assertEqual(viewer.spool_stats().dropped_overflow_total, 0)
            viewer.close()

    def test_probe_request_never_exceeds_two_second_bound(self):
        """A drain probe uses min(timeout, 2.0)s, never the full configured timeout."""
        port = get_free_port()
        with tempfile.TemporaryDirectory() as tmp:
            viewer = AgentViewer(
                url=f"http://127.0.0.1:{port}", max_retries=0, timeout=20.0, spool_dir=tmp, spool_background=False
            )
            start = time.monotonic()
            status, parsed, headers = None, None, None
            from sdk.python.agent_viewer import _TransientNetworkError

            with self.assertRaises(_TransientNetworkError):
                viewer._raw_batch_request('{"events":[]}')
            elapsed = time.monotonic() - start
            self.assertLess(elapsed, 2.5, "a probe must never wait out the full client timeout")
            viewer.close()


class TestOverflowPolicy(unittest.TestCase):
    def _queue_n(self, viewer, n, event_type="tool.started", prefix="evt"):
        for i in range(n):
            viewer.emit(event_type, "s", {"tool": "x"}, event_id=f"{prefix}_{i}")

    def test_drop_oldest_evicts_non_usage_before_usage(self):
        port = get_free_port()
        with tempfile.TemporaryDirectory() as tmp:
            viewer = AgentViewer(
                url=f"http://127.0.0.1:{port}",
                max_retries=0,
                timeout=1.0,
                spool_dir=tmp,
                spool_background=False,
                spool_max_events=3,
                spool_overflow="drop_oldest",
            )
            viewer.emit("llm.usage", "s", {"provider": "p", "model": "m", "inputTokens": 1, "outputTokens": 1}, event_id="evt_usage_1")
            viewer.emit("tool.started", "s", {"tool": "a"}, event_id="evt_tool_1")
            viewer.emit("tool.started", "s", {"tool": "b"}, event_id="evt_tool_2")
            # Cap is 3, all 3 slots full. A 4th event must evict a non-usage row first, never the usage row.
            viewer.emit("tool.started", "s", {"tool": "c"}, event_id="evt_tool_3")
            rows = _read_spool_rows(viewer._spool.path)
            ids = [r[1] for r in rows]
            self.assertIn("evt_usage_1", ids, "usage must survive while any non-usage row remains")
            self.assertNotIn("evt_tool_1", ids, "the oldest non-usage row is evicted first")
            stats = viewer.spool_stats()
            self.assertEqual(stats.dropped_overflow_total, 1)
            self.assertEqual(stats.dropped_overflow_usage_total, 0)

            # Now evict every remaining non-usage row with more usage inserts (each still evicts the oldest
            # non-usage row first, never touching evt_usage_1, until none are left), then force a usage
            # eviction once the backlog is usage-only.
            viewer.emit("llm.usage", "s", {"provider": "p", "model": "m", "inputTokens": 2, "outputTokens": 2}, event_id="evt_usage_2")
            viewer.emit("llm.usage", "s", {"provider": "p", "model": "m", "inputTokens": 3, "outputTokens": 3}, event_id="evt_usage_3")
            rows = _read_spool_rows(viewer._spool.path)
            self.assertEqual(
                [r[1] for r in rows], ["evt_usage_1", "evt_usage_2", "evt_usage_3"],
                "every non-usage row is gone but evt_usage_1 survived as long as one was left",
            )
            viewer.emit("llm.usage", "s", {"provider": "p", "model": "m", "inputTokens": 4, "outputTokens": 4}, event_id="evt_usage_4")
            rows = _read_spool_rows(viewer._spool.path)
            ids = [r[1] for r in rows]
            self.assertNotIn("evt_usage_1", ids, "with no non-usage rows left, the oldest usage row is evicted")
            self.assertIn("evt_usage_4", ids)
            stats = viewer.spool_stats()
            self.assertEqual(stats.dropped_overflow_usage_total, 1)
            viewer.close()

    def test_drop_newest_refuses_the_incoming_event_and_evicts_nothing(self):
        port = get_free_port()
        with tempfile.TemporaryDirectory() as tmp:
            viewer = AgentViewer(
                url=f"http://127.0.0.1:{port}",
                max_retries=0,
                timeout=1.0,
                spool_dir=tmp,
                spool_background=False,
                spool_max_events=2,
                spool_overflow="drop_newest",
            )
            viewer.emit("tool.started", "s", {"tool": "a"}, event_id="evt_a")
            viewer.emit("tool.started", "s", {"tool": "b"}, event_id="evt_b")
            result = viewer.emit("tool.started", "s", {"tool": "c"}, event_id="evt_c")
            self.assertEqual(result, {"accepted": False, "queued": False, "dropped": True, "id": "evt_c"})
            rows = _read_spool_rows(viewer._spool.path)
            self.assertEqual([r[1] for r in rows], ["evt_a", "evt_b"])
            self.assertEqual(viewer.spool_stats().dropped_overflow_total, 1)
            viewer.close()

    def test_oversized_single_event_is_refused_under_either_policy(self):
        port = get_free_port()
        with tempfile.TemporaryDirectory() as tmp:
            viewer = AgentViewer(
                url=f"http://127.0.0.1:{port}",
                max_retries=0,
                timeout=1.0,
                spool_dir=tmp,
                spool_background=False,
                spool_max_bytes=100,
            )
            huge_message = "x" * 1000
            result = viewer.emit("agent.message.sent", "s", {"text": huge_message}, event_id="evt_huge")
            self.assertEqual(result["dropped"], True)
            self.assertEqual(viewer.spool_stats().pending_events, 0)
            self.assertEqual(viewer.spool_stats().dropped_overflow_total, 1)
            viewer.close()

    def test_overflow_counters_persist_across_a_restart(self):
        port = get_free_port()
        with tempfile.TemporaryDirectory() as tmp:
            viewer1 = AgentViewer(
                url=f"http://127.0.0.1:{port}",
                max_retries=0,
                timeout=1.0,
                spool_dir=tmp,
                spool_background=False,
                spool_max_events=1,
                spool_overflow="drop_newest",
            )
            viewer1.emit("tool.started", "s", {"tool": "a"}, event_id="evt_r1")
            viewer1.emit("tool.started", "s", {"tool": "b"}, event_id="evt_r2")  # refused, counted
            self.assertEqual(viewer1.spool_stats().dropped_overflow_total, 1)
            viewer1.close()

            viewer2 = AgentViewer(
                url=f"http://127.0.0.1:{port}",
                max_retries=0,
                timeout=1.0,
                spool_dir=tmp,
                spool_background=False,
                spool_max_events=1,
                spool_overflow="drop_newest",
            )
            self.assertEqual(viewer2.spool_stats().dropped_overflow_total, 1, "counters survive a restart")
            self.assertEqual(viewer2.spool_stats().pending_events, 1)
            viewer2.close()


class TestByteIdenticalReplay(unittest.TestCase):
    def test_stored_json_omits_absent_fields_and_replays_byte_identical(self):
        httpd, thread, url = _run_scripted_batch_server(
            responses=[(202, {"results": [{"id": "evt_bi", "status": "accepted", "duplicate": False}]}, {})]
        )
        try:
            with tempfile.TemporaryDirectory() as tmp:
                viewer = AgentViewer(
                    url=url, max_retries=0, timeout=1.0, spool_dir=tmp, spool_background=False, auto_register=False
                )
                # First, force server_down against an address nothing listens on so the event is spooled,
                # then point the viewer at the real scripted server for the drain/flush step.
                down_port = get_free_port()
                viewer.url = f"http://127.0.0.1:{down_port}"
                agent = viewer.agent("coder")
                agent.usage("OpenAI", "gpt-4o", 10, 5)  # no cost, no cached/reasoning tokens: must stay absent
                rows = _read_spool_rows(viewer._spool.path)
                self.assertEqual(len(rows), 1)
                stored_json = rows[0][3]
                stored = json.loads(stored_json)
                self.assertNotIn("cost", stored["payload"])
                self.assertNotIn("cachedTokens", stored["payload"])
                self.assertNotIn("reasoningTokens", stored["payload"])
                self.assertEqual(stored["payload"]["inputTokens"], 10)

                viewer.url = url
                result = viewer.flush(timeout=5)
                self.assertEqual(result.delivered, 1)
                self.assertEqual(len(_ScriptedBatchHandler.requests), 1)
                sent_body = _ScriptedBatchHandler.requests[0].decode("utf-8")
                self.assertEqual(sent_body, '{"events":[' + stored_json + "]}")
                viewer.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)


class TestDrainResponseHandlingMatchesSharedFixture(unittest.TestCase):
    """Drives ``AgentViewer._send_and_resolve`` directly (bypassing real network I/O) against every case of
    the shared ``drainResponseHandling`` fixture, so the Python drain algorithm and the documented
    cross-language contract cannot silently drift apart.
    """

    def _build_viewer_with_rows(self, tmp, n):
        viewer = AgentViewer(
            url="http://127.0.0.1:1", max_retries=0, timeout=1.0, spool_dir=tmp, spool_background=False,
            spool_max_events=1000, spool_max_bytes=10_000_000,
        )
        for i in range(1, n + 1):
            viewer._spool.enqueue(
                {"id": f"evt_{i}", "type": "tool.started", "payload": {}},
                json.dumps({"id": f"evt_{i}", "type": "tool.started", "payload": {}}),
            )
        return viewer

    def test_every_scenario(self):
        for case in SCENARIOS["drainResponseHandling"]["cases"]:
            with self.subTest(name=case["name"]):
                with tempfile.TemporaryDirectory() as tmp:
                    n = len(case["chunkSeqs"])
                    viewer = self._build_viewer_with_rows(tmp, n)
                    response = case["response"]

                    if "networkError" in response:
                        from sdk.python.agent_viewer import _TransientNetworkError

                        def fake_raw(body, _err=response["networkError"]):
                            raise _TransientNetworkError(_err)

                    else:
                        status = response["status"]
                        body = response.get("body", {})
                        headers = response.get("headers", {})

                        def fake_raw(body_str, _status=status, _body=body, _headers=headers):
                            return _status, _body, _headers

                    viewer._raw_batch_request = fake_raw
                    batch = viewer._spool.peek_batch(n)
                    outcome = viewer._send_and_resolve(batch)

                    remaining_ids = {r[1] for r in _read_spool_rows(viewer._spool.path)}
                    all_ids = {f"evt_{i}" for i in range(1, n + 1)}
                    deleted_ids = {f"evt_{seq}" for seq in case["expectedDeletedSeqs"]}
                    expected_remaining = all_ids - deleted_ids
                    self.assertEqual(remaining_ids, expected_remaining, case["name"])

                    rejected_ids = {r["event_id"] for r in viewer._spool.rejected(limit=1000)}
                    expected_rejected = {f"evt_{seq}" for seq in case["expectedRejectedSeqs"]}
                    self.assertEqual(rejected_ids, expected_rejected, case["name"])

                    action = case["expectedAction"]
                    if action in ("retry_with_backoff",):
                        self.assertEqual(outcome["stop"], "backoff", case["name"])
                    elif action == "stop_auth_failed":
                        self.assertEqual(outcome["stop"], "auth_failed", case["name"])
                    else:
                        self.assertIsNone(outcome["stop"], case["name"])

                    if "retryAfterSeconds" in case:
                        self.assertEqual(outcome.get("backoff_seconds"), case["retryAfterSeconds"], case["name"])

                    if "nextChunkSize" in case:
                        self.assertEqual(viewer._spool_chunk_size, case["nextChunkSize"], case["name"])

                    deltas = case.get("counterDeltas", {})
                    if "replayed_total" in deltas:
                        self.assertEqual(outcome["delivered"], deltas["replayed_total"], case["name"])
                    if "duplicates_acked_total" in deltas:
                        self.assertEqual(outcome["duplicates"], deltas["duplicates_acked_total"], case["name"])
                    if "rejected_total" in deltas:
                        self.assertEqual(outcome["rejected"], deltas["rejected_total"], case["name"])

                    viewer.close()


class TestPoisonEventsAnd413(unittest.TestCase):
    def test_poison_event_isolated_rest_delivered(self):
        responses = [
            (400, {"error": "validation_failed", "errors": [{"index": 1, "issues": [{"path": "payload.x", "message": "bad"}]}]}, {}),
            (202, {"results": [{"id": "evt_1", "status": "accepted", "duplicate": False}, {"id": "evt_3", "status": "accepted", "duplicate": False}]}, {}),
        ]
        httpd, thread, url = _run_scripted_batch_server(responses=responses)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                viewer = AgentViewer(url=url, max_retries=0, timeout=2.0, spool_dir=tmp, spool_background=False, spool_batch_size=10)
                for i in (1, 2, 3):
                    viewer._spool.enqueue(
                        {"id": f"evt_{i}", "type": "tool.started", "payload": {}},
                        json.dumps({"id": f"evt_{i}", "type": "tool.started", "payload": {}}),
                    )
                result = viewer.flush(timeout=5)
                self.assertEqual(result.delivered, 2)
                self.assertEqual(result.rejected, 1)
                self.assertEqual(result.remaining, 0)
                rejected = viewer.spool_rejected()
                self.assertEqual(len(rejected), 1)
                self.assertEqual(rejected[0]["event_id"], "evt_2")
                self.assertIn("bad", rejected[0]["reason"])
                viewer.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_413_shrinks_chunk_and_eventually_delivers(self):
        responses = [
            (413, {"error": "batch_too_large"}, {}),
            (202, {"results": [{"id": "evt_1", "status": "accepted", "duplicate": False}]}, {}),
            (202, {"results": [{"id": "evt_2", "status": "accepted", "duplicate": False}]}, {}),
        ]
        httpd, thread, url = _run_scripted_batch_server(responses=responses)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                viewer = AgentViewer(url=url, max_retries=0, timeout=2.0, spool_dir=tmp, spool_background=False, spool_batch_size=10)
                for i in (1, 2):
                    viewer._spool.enqueue(
                        {"id": f"evt_{i}", "type": "tool.started", "payload": {}},
                        json.dumps({"id": f"evt_{i}", "type": "tool.started", "payload": {}}),
                    )
                result = viewer.flush(timeout=5)
                self.assertEqual(result.delivered, 2)
                self.assertEqual(result.remaining, 0)
                self.assertEqual(viewer._spool_chunk_size, 1)
                viewer.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_413_at_chunk_size_one_dead_letters_the_event(self):
        httpd, thread, url = _run_scripted_batch_server(responses=[(413, {"error": "batch_too_large"}, {})])
        try:
            with tempfile.TemporaryDirectory() as tmp:
                viewer = AgentViewer(url=url, max_retries=0, timeout=2.0, spool_dir=tmp, spool_background=False, spool_batch_size=1)
                viewer._spool.enqueue(
                    {"id": "evt_solo", "type": "tool.started", "payload": {}},
                    json.dumps({"id": "evt_solo", "type": "tool.started", "payload": {}}),
                )
                result = viewer.flush(timeout=5)
                self.assertEqual(result.rejected, 1)
                self.assertEqual(result.remaining, 0)
                rejected = viewer.spool_rejected()
                self.assertEqual(rejected[0]["event_id"], "evt_solo")
                self.assertIn("413", rejected[0]["reason"])
                viewer.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)


class TestRateLimitAndAuth(unittest.TestCase):
    def test_429_with_retry_after_backs_off_without_losing_events(self):
        responses = [
            (429, {"error": "rate_limit_exceeded"}, {"Retry-After": "1"}),
            (202, {"results": [{"id": "evt_1", "status": "accepted", "duplicate": False}]}, {}),
        ]
        httpd, thread, url = _run_scripted_batch_server(responses=responses)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                viewer = AgentViewer(
                    url=url, max_retries=0, timeout=2.0, spool_dir=tmp, spool_background=False,
                    spool_probe_interval=0.1, spool_max_probe_interval=2.0,
                )
                viewer._spool.enqueue(
                    {"id": "evt_1", "type": "tool.started", "payload": {}},
                    json.dumps({"id": "evt_1", "type": "tool.started", "payload": {}}),
                )
                result = viewer.flush(timeout=5)
                self.assertEqual(result.delivered, 1)
                self.assertEqual(result.remaining, 0)
                viewer.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_401_keeps_events_then_flush_delivers_after_fixing_token(self):
        state = {"calls": 0}

        class _AuthHandler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(length)
                state["calls"] += 1
                if self.headers.get("Authorization") != "Bearer right-token":
                    body = json.dumps({"error": "unauthorized"}).encode("utf-8")
                    self.send_response(401)
                else:
                    body = json.dumps({"results": [{"id": "evt_1", "status": "accepted", "duplicate": False}]}).encode("utf-8")
                    self.send_response(202)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        httpd = http.server.HTTPServer(("127.0.0.1", 0), _AuthHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            with tempfile.TemporaryDirectory() as tmp:
                viewer = AgentViewer(
                    url=url, token="wrong-token", max_retries=0, timeout=2.0, spool_dir=tmp, spool_background=False,
                    spool_max_probe_interval=60.0,
                )
                viewer._spool.enqueue(
                    {"id": "evt_1", "type": "tool.started", "payload": {}},
                    json.dumps({"id": "evt_1", "type": "tool.started", "payload": {}}),
                )
                result = viewer.flush(timeout=2)
                self.assertEqual(result.state, "auth_failed")
                self.assertEqual(result.remaining, 1)
                self.assertEqual(viewer.spool_stats().pending_events, 1, "every event is kept on a 401")

                viewer.token = "right-token"
                result2 = viewer.flush(timeout=5)
                self.assertEqual(result2.delivered, 1)
                self.assertEqual(result2.remaining, 0)
                self.assertEqual(result2.state, "idle")
                viewer.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)


class TestFlushCloseContextManager(unittest.TestCase):
    def test_close_is_idempotent_and_context_manager_flushes(self):
        responses = [(202, {"results": [{"id": "evt_1", "status": "accepted", "duplicate": False}]}, {})]
        httpd, thread, url = _run_scripted_batch_server(responses=responses)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                with AgentViewer(url=url, max_retries=0, timeout=2.0, spool_dir=tmp, spool_background=False) as viewer:
                    viewer._spool.enqueue(
                        {"id": "evt_1", "type": "tool.started", "payload": {}},
                        json.dumps({"id": "evt_1", "type": "tool.started", "payload": {}}),
                    )
                # __exit__ ran close(), which does a final flush attempt.
                conn = sqlite3.connect(_spool_path_for(tmp, url, None))
                try:
                    remaining = conn.execute("SELECT COUNT(*) FROM spool").fetchone()[0]
                finally:
                    conn.close()
                self.assertEqual(remaining, 0)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    @unittest.skipUnless(
        os.path.exists("./node_modules/.bin/tsx"), "needs Node (tsx) to start the live TypeScript server"
    )
    def test_events_left_on_disk_survive_a_restart_and_the_next_run_delivers_them(self):
        port = get_free_port()
        with tempfile.TemporaryDirectory() as tmp:
            viewer1 = AgentViewer(
                url=f"http://127.0.0.1:{port}", max_retries=0, timeout=1.0, spool_dir=tmp, spool_background=False
            )
            viewer1.emit("agent.status.changed", "s", {"status": "IDLE"}, event_id="evt_persist_1")
            # Simulate a crash: no close(), the thread/object is simply dropped.
            del viewer1

            env = os.environ.copy()
            env["PORT"] = str(port)
            env["AGENT_VIEWER_STORAGE"] = "memory"
            proc = subprocess.Popen(
                ["./node_modules/.bin/tsx", "-e", f"import('./server/index.ts').then(m => m.startServer({port}))"],
                env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            try:
                viewer2 = AgentViewer(
                    url=f"http://127.0.0.1:{port}", max_retries=1, timeout=5.0, spool_dir=tmp, spool_background=False
                )
                self.assertEqual(viewer2.spool_stats().pending_events, 1, "the event from the dropped instance is still on disk")
                ready = False
                for _ in range(50):
                    try:
                        if viewer2.health().get("ok"):
                            ready = True
                            break
                    except Exception:
                        time.sleep(0.2)
                self.assertTrue(ready, "server failed to start in time")
                result = viewer2.flush(timeout=10)
                self.assertEqual(result.delivered, 1)
                self.assertEqual(result.remaining, 0)

                req = urllib.request.Request(f"http://127.0.0.1:{port}/api/v1/events?limit=10")
                with urllib.request.urlopen(req, timeout=5) as resp:
                    stored = json.loads(resp.read())["events"]
                self.assertEqual([e["id"] for e in stored], ["evt_persist_1"])
                viewer2.close()
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()


class TestForkSafety(unittest.TestCase):
    @unittest.skipUnless(hasattr(os, "fork"), "os.fork is POSIX-only")
    def test_forked_child_delivers_without_reusing_parent_connection(self):
        responses = [(202, {"results": [{"id": "evt_child", "status": "accepted", "duplicate": False}]}, {})]
        httpd, thread, url = _run_scripted_batch_server(responses=responses)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                viewer = AgentViewer(url=url, max_retries=0, timeout=2.0, spool_dir=tmp, spool_background=False)
                viewer._spool.pending_count()  # force the parent's connection to be created before forking

                pid = os.fork()
                if pid == 0:
                    # Child: emitting must not reuse the parent's sqlite3 connection or raise.
                    try:
                        viewer2 = AgentViewer(url=url, max_retries=0, timeout=2.0, spool_dir=tmp, spool_background=False)
                        viewer2._spool.enqueue(
                            {"id": "evt_child", "type": "tool.started", "payload": {}},
                            json.dumps({"id": "evt_child", "type": "tool.started", "payload": {}}),
                        )
                        result = viewer2.flush(timeout=5)
                        os._exit(0 if result.delivered == 1 else 1)
                    except Exception:
                        os._exit(2)
                else:
                    _, status = os.waitpid(pid, 0)
                    exit_code = os.WEXITSTATUS(status)
                    self.assertEqual(exit_code, 0, "forked child failed to deliver its own event")
                viewer.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)


class TestCorruptAndSchemaVersion(unittest.TestCase):
    def test_corrupt_spool_file_is_quarantined_and_replaced(self):
        port = get_free_port()
        with tempfile.TemporaryDirectory() as tmp:
            from sdk.python.agent_viewer import _spool_file_name

            path = os.path.join(tmp, _spool_file_name(f"http://127.0.0.1:{port}", None))
            with open(path, "wb") as f:
                f.write(b"not a sqlite database at all")

            viewer = AgentViewer(
                url=f"http://127.0.0.1:{port}", max_retries=0, timeout=1.0, spool_dir=tmp, spool_background=False
            )
            self.assertIsNotNone(viewer._spool, "a corrupt file must not disable the spool, just quarantine it")
            result = viewer.emit("agent.status.changed", "s", {"status": "IDLE"}, event_id="evt_after_corrupt")
            self.assertEqual(result["queued"], True)
            self.assertEqual(viewer.spool_stats().corrupt_spool_total, 1)
            quarantined = [f for f in os.listdir(tmp) if ".corrupt-" in f]
            self.assertEqual(len(quarantined), 1)
            viewer.close()

    def test_newer_schema_version_disables_spool_without_touching_file(self):
        port = get_free_port()
        with tempfile.TemporaryDirectory() as tmp:
            from sdk.python.agent_viewer import _spool_file_name

            path = os.path.join(tmp, _spool_file_name(f"http://127.0.0.1:{port}", None))
            conn = sqlite3.connect(path)
            conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            conn.execute("INSERT INTO meta(key, value) VALUES ('schema_version', '999')")
            conn.execute("INSERT INTO meta(key, value) VALUES ('sentinel', 'untouched')")
            conn.commit()
            conn.close()

            viewer = AgentViewer(
                url=f"http://127.0.0.1:{port}", max_retries=0, timeout=1.0, spool_dir=tmp, spool_background=False
            )
            self.assertIsNone(viewer._spool, "a newer schema_version must disable the spool for this run")
            self.assertEqual(viewer.spool_stats(), SpoolStats(state="disabled"))

            conn = sqlite3.connect(path)
            try:
                sentinel = conn.execute("SELECT value FROM meta WHERE key = 'sentinel'").fetchone()[0]
                version = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()[0]
            finally:
                conn.close()
            self.assertEqual(sentinel, "untouched")
            self.assertEqual(version, "999")


class TestPermissionsAndSecrecy(unittest.TestCase):
    @unittest.skipIf(sys.platform.startswith("win"), "POSIX permission bits only")
    def test_directory_and_file_permissions(self):
        port = get_free_port()
        with tempfile.TemporaryDirectory() as tmp:
            spool_dir = os.path.join(tmp, "nested", "spool")
            viewer = AgentViewer(
                url=f"http://127.0.0.1:{port}", max_retries=0, timeout=1.0, spool_dir=spool_dir, spool_background=False
            )
            viewer.emit("agent.status.changed", "s", {"status": "IDLE"}, event_id="evt_perm")
            self.assertEqual(os.stat(spool_dir).st_mode & 0o777, 0o700)
            self.assertEqual(os.stat(viewer._spool.path).st_mode & 0o777, 0o600)
            viewer.close()

    def test_api_token_never_appears_in_the_spool_file_bytes(self):
        port = get_free_port()
        with tempfile.TemporaryDirectory() as tmp:
            secret_token = "super-secret-token-xyz-123456"
            viewer = AgentViewer(
                url=f"http://127.0.0.1:{port}", token=secret_token, max_retries=0, timeout=1.0,
                spool_dir=tmp, spool_background=False,
            )
            viewer.agent("a").usage("OpenAI", "gpt-4o", 10, 5, request_id=secret_token)
            with open(viewer._spool.path, "rb") as f:
                raw = f.read()
            self.assertNotIn(secret_token.encode("utf-8"), raw, "a header-only secret must not land in request_id")
            viewer.close()


class TestConcurrencyRandomized(unittest.TestCase):
    def test_concurrent_emits_while_server_flaps_account_for_every_event(self):
        """Seeded randomized sequence (issue #101's 'delivered set + dropped + rejected == emitted'
        invariant): several threads emit while the scripted server alternates between failing and
        succeeding. Every id must end up either delivered or counted as dropped/rejected, never both or
        neither."""
        seed = 20261011
        rng = random.Random(seed)
        responses = []
        for _ in range(400):
            if rng.random() < 0.3:
                responses.append((503, {"error": "service_unavailable"}, {}))
            else:
                responses.append((202, {"results": None}, {}))  # filled in per-request by the handler below

        class _FlappyHandler(http.server.BaseHTTPRequestHandler):
            call_count = 0

            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                idx = min(type(self).call_count, len(responses) - 1)
                type(self).call_count += 1
                status, payload, headers = responses[idx]
                if status == 202:
                    parsed = json.loads(raw)
                    # Handles both the single-event endpoint body (a bare event dict, tried live before
                    # anything is spooled) and the batch endpoint body ({"events": [...]}, used on replay).
                    events_list = parsed.get("events", [parsed])
                    results = [{"id": e["id"], "status": "accepted", "duplicate": False} for e in events_list]
                    payload = {"results": results} if "events" in parsed else {"accepted": True, "duplicate": False, "id": parsed["id"]}
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        httpd = http.server.HTTPServer(("127.0.0.1", 0), _FlappyHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{httpd.server_address[1]}"
        try:
            with tempfile.TemporaryDirectory() as tmp:
                viewer = AgentViewer(
                    url=url, max_retries=0, timeout=1.0, spool_dir=tmp, spool_background=True,
                    spool_probe_interval=0.01, spool_max_probe_interval=0.2,
                )
                emitted_ids = []
                direct_delivered = 0
                lock = threading.Lock()

                def worker(thread_index):
                    nonlocal direct_delivered
                    for i in range(10):
                        event_id = f"evt_t{thread_index}_{i}"
                        result = viewer.emit("tool.started", "s", {"tool": "x"}, event_id=event_id)
                        with lock:
                            emitted_ids.append(event_id)
                            # A live send can still win the race and succeed on its very first try (before
                            # the spool ever sees it): that is correctly never queued and never counted in
                            # the spool's own counters, so it is tracked here instead for the invariant below.
                            if not result.get("queued"):
                                direct_delivered += 1

                threads = [threading.Thread(target=worker, args=(t,)) for t in range(5)]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join(timeout=10)

                result = viewer.flush(timeout=15)
                stats = viewer.spool_stats()
                accounted = (
                    direct_delivered
                    + stats.replayed_total
                    + stats.duplicates_acked_total
                    + stats.dropped_overflow_total
                    + stats.rejected_total
                )
                self.assertEqual(
                    accounted, len(emitted_ids),
                    f"every emitted event must be delivered, dropped or rejected exactly once "
                    f"(direct_delivered={direct_delivered}, stats={stats})",
                )
                self.assertEqual(stats.pending_events, 0, "the flush must drain everything eventually")
                viewer.close()
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
