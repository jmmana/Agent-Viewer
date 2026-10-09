import http.server
import importlib.util
import json
import logging
import os
import sys
import threading
import time
import socket
import subprocess
import unittest
import urllib.request

sys.path.insert(0, ".")

from sdk.python.agent_viewer import AgentViewer, AgentHandle, AgentViewerError

_VECTORS_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "usage-correlation-vectors.json")
with open(_VECTORS_PATH, "r", encoding="utf-8") as _f:
    USAGE_CORRELATION_VECTORS = json.load(_f)

_EXAMPLES_DIR = os.path.join(os.path.dirname(__file__), "..", "examples")


def _load_example_module(filename):
    """Loads an example adapter module by file path. The example files have hyphens in their names
    (``autogen-adapter.py``, ``crewai-adapter.py``), so they cannot be imported with a normal ``import``.
    """
    path = os.path.join(_EXAMPLES_DIR, filename)
    module_name = filename.replace("-", "_").replace(".py", "")
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _capture_adapter_viewer(adapter):
    """Patches the adapter's internal AgentViewer so emitted events are captured instead of sent over the
    network. Returns the list that each emitted event body is appended to, in order.
    """
    captured = []

    def fake_post_with_retry(endpoint, body, idempotency_key=None):
        captured.append(body)
        return {"accepted": True, "duplicate": False}

    adapter.viewer._post_with_retry = fake_post_with_retry
    return captured


def get_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class CapturingViewer(AgentViewer):
    """Client that records each request body instead of sending it."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.captured = []

    def _post_with_retry(self, endpoint, body, idempotency_key=None):
        self.captured.append(body)
        return {"accepted": True, "duplicate": False}

    def usage_events(self):
        return [e for e in self.captured if e["type"] == "llm.usage"]


class LogCapture(logging.Handler):
    """Collects records of the agent_viewer logger (assertNoLogs needs Python 3.10)."""

    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.records = []

    def emit(self, record):
        self.records.append(record)

    def __enter__(self):
        logging.getLogger("agent_viewer").addHandler(self)
        return self

    def __exit__(self, *exc):
        logging.getLogger("agent_viewer").removeHandler(self)
        return False


class _ConflictHandler(http.server.BaseHTTPRequestHandler):
    """Answers every POST with a 409 conflicting_duplicate and counts the attempts."""

    attempts = 0

    def do_POST(self):  # noqa: N802 (http.server naming)
        type(self).attempts += 1
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        body = json.dumps({
            "error": "conflicting_duplicate",
            "message": 'An event with id "evt_x" was already stored with different content. The new event was not applied.',
            "id": "evt_x",
            "fingerprint": "sha256:b",
            "storedFingerprint": "sha256:a",
        }).encode("utf-8")
        self.send_response(409)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class TestPythonSDK(unittest.TestCase):
    def test_default_event_ids_are_full_uuid4_hex(self):
        viewer = CapturingViewer(url="http://localhost:8787")
        viewer.emit("agent.status.changed", "s", {"status": "IDLE"})
        viewer.emit("agent.status.changed", "s", {"status": "IDLE"})
        viewer.emit_batch([{"type": "tool.started", "payload": {"tool": "a"}}, {"type": "tool.started", "payload": {"tool": "b"}}])
        ids = [viewer.captured[0]["id"], viewer.captured[1]["id"]] + [e["id"] for e in viewer.captured[2]["events"]]
        for event_id in ids:
            self.assertRegex(event_id, r"^evt_[0-9a-f]{32}$")
            self.assertEqual(len(event_id), 36)
        self.assertEqual(len(set(ids)), len(ids))

    def test_conflicting_duplicate_raises_with_code_after_one_attempt(self):
        _ConflictHandler.attempts = 0
        httpd = http.server.HTTPServer(("127.0.0.1", 0), _ConflictHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            viewer = AgentViewer(url=f"http://127.0.0.1:{httpd.server_address[1]}", max_retries=3, timeout=5.0)
            with self.assertRaises(AgentViewerError) as ctx:
                viewer.emit("agent.status.changed", "s", {"status": "IDLE"}, event_id="evt_x")
            self.assertEqual(ctx.exception.status_code, 409)
            self.assertEqual(ctx.exception.code, "conflicting_duplicate")
            self.assertEqual(_ConflictHandler.attempts, 1)

            _ConflictHandler.attempts = 0
            with self.assertRaises(AgentViewerError) as batch_ctx:
                viewer.emit_batch([{"id": "evt_x", "type": "tool.started", "payload": {"tool": "a"}}])
            self.assertEqual(batch_ctx.exception.code, "conflicting_duplicate")
            self.assertEqual(_ConflictHandler.attempts, 1)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=5)

    def test_agent_viewer_error_code_defaults_to_none(self):
        err = AgentViewerError("boom", 400)
        self.assertIsNone(err.code)
        self.assertEqual(err.status_code, 400)

    def test_agent_handle_initialization(self):
        viewer = AgentViewer(url="http://localhost:8787", runtime_id="py-test")
        agent = viewer.agent("researcher", name="Research Agent")
        self.assertEqual(agent.id, "researcher")
        self.assertEqual(agent.name, "Research Agent")
        self.assertEqual(agent.workspace, "development")

    def test_emit_payload_structure_without_none_keys(self):
        events_captured = []

        class MockViewer(AgentViewer):
            def _post_with_retry(self, endpoint, body, idempotency_key=None):
                events_captured.append(body)
                return {"accepted": True, "duplicate": False}

        viewer = MockViewer(url="http://localhost:8787")  # No runtime_id or session_id
        agent = viewer.agent("coder", name="Coder Agent")
        agent.thinking("Planning architecture")
        agent.message("Looking into architecture")
        agent.tool_started("git_fetch")
        agent.tool_completed("git_fetch")
        with self.assertLogs("agent_viewer", level="WARNING"):
            agent.usage(
                provider="Anthropic",
                model="claude-3-5-sonnet",
                input_tokens=1500,
                output_tokens=300,
                cost=0.012,
            )

        for event in events_captured:
            # None keys must NOT be present in envelope or payload
            for key, val in event.items():
                self.assertIsNotNone(val, f"Key {key} in envelope had None value")
            if isinstance(event.get("payload"), dict):
                for pkey, pval in event["payload"].items():
                    self.assertIsNotNone(pval, f"Key {pkey} in payload had None value")

        usage_evt = events_captured[-1]
        self.assertEqual(usage_evt["type"], "llm.usage")
        # A bare cost is never claimed as provider-reported.
        self.assertEqual(usage_evt["payload"]["costSource"], "unknown")
        self.assertEqual(usage_evt["payload"]["cost"], 0.012)
        self.assertNotIn("cachedTokens", usage_evt["payload"])
        self.assertNotIn("reasoningTokens", usage_evt["payload"])

    def test_usage_omitted_and_zero_token_fields(self):
        viewer = CapturingViewer(url="http://localhost:8787")
        agent = viewer.agent("coder")
        agent.usage("OpenAI", "gpt-4o", 10, 5)
        agent.usage("OpenAI", "gpt-4o", 10, 5, cached_tokens=0, reasoning_tokens=0)
        omitted, zeros = [e["payload"] for e in viewer.usage_events()]
        for key in ("cachedTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "cost", "currency"):
            self.assertNotIn(key, omitted)
        self.assertEqual(omitted["costSource"], "unknown")
        self.assertEqual(zeros["cachedTokens"], 0)
        self.assertEqual(zeros["reasoningTokens"], 0)

    def test_usage_forwards_stated_cost_source(self):
        for source in ("provider-reported", "estimated", "unknown"):
            with self.subTest(cost_source=source):
                viewer = CapturingViewer(url="http://localhost:8787")
                with LogCapture() as logs:
                    viewer.agent("coder").usage("OpenAI", "gpt-4o", 10, 5, cost=0.02, cost_source=source)
                payload = viewer.usage_events()[-1]["payload"]
                self.assertEqual(payload["costSource"], source)
                self.assertEqual(payload["cost"], 0.02)
                self.assertEqual(logs.records, [])

    def test_usage_unstated_cost_source_warns_once(self):
        viewer = CapturingViewer(url="http://localhost:8787")
        first = viewer.agent("a")
        second = viewer.agent("b")
        with self.assertLogs("agent_viewer", level="WARNING") as logs:
            first.usage("OpenAI", "gpt-4o", 10, 5, cost=0.01)
            second.usage("OpenAI", "gpt-4o", 10, 5, cost=0.02)
            first.usage("OpenAI", "gpt-4o", 10, 5, cost=0, cost_source=None)
        self.assertEqual(len(logs.records), 1)
        self.assertIn('costSource="unknown"', logs.records[0].getMessage())
        payloads = [e["payload"] for e in viewer.usage_events()]
        self.assertEqual([p["costSource"] for p in payloads], ["unknown"] * 3)
        self.assertEqual([p["cost"] for p in payloads], [0.01, 0.02, 0])

        # A second client warns again, also for a cost of 0, and still sends the 0.
        other = CapturingViewer(url="http://localhost:8787")
        with self.assertLogs("agent_viewer", level="WARNING") as logs:
            other.agent("a").usage("OpenAI", "gpt-4o", 10, 5, cost=0)
        self.assertEqual(len(logs.records), 1)
        self.assertEqual(other.usage_events()[-1]["payload"]["cost"], 0)
        self.assertEqual(other.usage_events()[-1]["payload"]["costSource"], "unknown")

        # No cost means no warning, even on a client that never warned.
        quiet = CapturingViewer(url="http://localhost:8787", debug=True)
        with LogCapture() as captured:
            quiet.agent("a").usage("OpenAI", "gpt-4o", 10, 5)
            quiet.agent("a").usage("OpenAI", "gpt-4o", 10, 5, cost=None, cost_source="provider-reported")
        self.assertEqual(captured.records, [])
        payloads = [e["payload"] for e in quiet.usage_events()]
        self.assertEqual(payloads[0]["costSource"], "unknown")
        self.assertEqual(payloads[1]["costSource"], "provider-reported")
        self.assertNotIn("cost", payloads[1])

    def test_usage_invalid_cost_source_raises(self):
        viewer = CapturingViewer(url="http://localhost:8787")
        agent = viewer.agent("coder")
        with self.assertRaises(ValueError) as ctx:
            agent.usage("OpenAI", "gpt-4o", 10, 5, cost=0.01, cost_source="provider")
        self.assertEqual(
            str(ctx.exception),
            'costSource must be one of provider-reported, estimated, unknown (got "provider")',
        )
        with self.assertRaises(ValueError):
            viewer.llm_usage("coder", "OpenAI", "gpt-4o", 10, 5, cost_source="")
        self.assertEqual(viewer.captured, [])
        self.assertFalse(agent._registered)

    def test_usage_new_fields(self):
        viewer = CapturingViewer(url="http://localhost:8787")
        agent = viewer.agent("builder")
        agent.usage(
            "Anthropic", "claude-sonnet-4-5", 1800, 450,
            cost=0.012, cost_source="provider-reported",
            cache_read_tokens=1200, cache_write_tokens=300,
            currency="USD", request_id="req_01", task_id="task_42",
        )
        agent.usage("Anthropic", "claude-sonnet-4-5", 10, 5, cache_read_tokens=0, cache_write_tokens=0, currency="usd")
        stated, zeros = viewer.usage_events()
        self.assertEqual(stated["taskId"], "task_42")
        self.assertEqual(stated["payload"], {
            "provider": "Anthropic",
            "model": "claude-sonnet-4-5",
            "inputTokens": 1800,
            "outputTokens": 450,
            "cacheReadTokens": 1200,
            "cacheWriteTokens": 300,
            "cost": 0.012,
            "costSource": "provider-reported",
            "currency": "USD",
            "requestId": "req_01",
        })
        self.assertNotIn("taskId", zeros)
        self.assertEqual(zeros["payload"]["cacheReadTokens"], 0)
        self.assertEqual(zeros["payload"]["cacheWriteTokens"], 0)
        self.assertNotIn("cachedTokens", zeros["payload"])
        # Currency is forwarded as given; the server checks the format.
        self.assertEqual(zeros["payload"]["currency"], "usd")

        agent.usage("Anthropic", "claude-sonnet-4-5", 10, 5, cost=0.001, cost_source="estimated")
        self.assertNotIn("currency", viewer.usage_events()[-1]["payload"])

    def test_llm_usage_legacy_rules(self):
        viewer = CapturingViewer(url="http://localhost:8787")

        # No hard-coded "unknown": a stated source is forwarded.
        viewer.llm_usage("a", "OpenAI", "gpt-4o", 10, 5, cost=0.02, cost_source="estimated")
        payload = viewer.usage_events()[-1]["payload"]
        self.assertEqual(payload["costSource"], "estimated")
        self.assertNotIn("cachedTokens", payload)
        self.assertNotIn("reasoningTokens", payload)

        # A bare cost gives "unknown" plus the warning shared with usage() on the same client.
        with self.assertLogs("agent_viewer", level="WARNING") as logs:
            viewer.llm_usage("a", "OpenAI", "gpt-4o", 10, 5, cost=0.02)
            viewer.agent("b").usage("OpenAI", "gpt-4o", 10, 5, cost=0.03)
        self.assertEqual(len(logs.records), 1)
        self.assertEqual(viewer.usage_events()[-2]["payload"]["costSource"], "unknown")

        # New keyword arguments are forwarded.
        viewer.llm_usage(
            "a", "OpenAI", "gpt-4o", 100, 50,
            reasoning_tokens=20, cache_read_tokens=40, cache_write_tokens=0,
            request_id="req_legacy", currency="EUR", task_id="task_7",
            cost=0.5, cost_source="provider-reported",
        )
        event = viewer.usage_events()[-1]
        self.assertEqual(event["taskId"], "task_7")
        self.assertNotIn("taskId", event["payload"])
        for key, value in (
            ("reasoningTokens", 20), ("cacheReadTokens", 40), ("cacheWriteTokens", 0),
            ("requestId", "req_legacy"), ("currency", "EUR"), ("costSource", "provider-reported"),
        ):
            self.assertEqual(event["payload"][key], value)

        # Positional calls from 0.2.x keep working.
        viewer.llm_usage("a", "OpenAI", "gpt-4o", 10, 5, 0, 0.01, "estimated", 120)
        payload = viewer.usage_events()[-1]["payload"]
        self.assertEqual(payload["cachedTokens"], 0)
        self.assertEqual(payload["cost"], 0.01)
        self.assertEqual(payload["costSource"], "estimated")
        self.assertEqual(payload["latencyMs"], 120)
        viewer.agent("a").usage("OpenAI", "gpt-4o", 10, 5)
        self.assertEqual(viewer.usage_events()[-1]["payload"]["inputTokens"], 10)

    # -------------------------------------------------------------
    # Usage correlation block (issue #64)
    # -------------------------------------------------------------

    def test_usage_correlation_fields_forwarded_and_omitted(self):
        viewer = CapturingViewer(url="http://localhost:8787")
        agent = viewer.agent("coder")
        agent.usage(
            "OpenAI", "gpt-4o", 10, 5,
            trace_id="trace_1", parent_id="span_1", tool_call_id="call_1",
            meeting_id="meeting_1", user_id="usr_1", tags=["env:prod", "feature:x"],
        )
        agent.usage("OpenAI", "gpt-4o", 10, 5)
        with_correlation, without = [e["payload"] for e in viewer.usage_events()]
        self.assertEqual(with_correlation["traceId"], "trace_1")
        self.assertEqual(with_correlation["parentId"], "span_1")
        self.assertEqual(with_correlation["toolCallId"], "call_1")
        self.assertEqual(with_correlation["meetingId"], "meeting_1")
        self.assertEqual(with_correlation["userId"], "usr_1")
        self.assertEqual(with_correlation["tags"], ["env:prod", "feature:x"])
        for key in ("traceId", "parentId", "toolCallId", "meetingId", "userId", "tags"):
            self.assertNotIn(key, without)

    def test_tool_helpers_forward_tool_call_id(self):
        viewer = CapturingViewer(url="http://localhost:8787")
        agent = viewer.agent("coder")
        agent.tool_started("git.commit", tool_call_id="call_started")
        agent.tool_completed("git.commit", tool_call_id="call_completed")
        agent.tool_failed("git.commit", tool_call_id="call_failed")
        agent.tool_started("git.push")
        tool_events = [e for e in viewer.captured if e["type"].startswith("tool.")]
        started, completed, failed, plain = tool_events
        self.assertEqual(started["payload"]["toolCallId"], "call_started")
        self.assertEqual(completed["payload"]["toolCallId"], "call_completed")
        self.assertEqual(failed["payload"]["toolCallId"], "call_failed")
        self.assertNotIn("toolCallId", plain["payload"])

    def test_usage_correlation_id_vectors_match_the_shared_fixture(self):
        viewer = CapturingViewer(url="http://localhost:8787")
        agent = viewer.agent("coder")
        for field in USAGE_CORRELATION_VECTORS["idFields"]:
            kwarg = {
                "traceId": "trace_id", "parentId": "parent_id", "toolCallId": "tool_call_id",
                "meetingId": "meeting_id", "userId": "user_id",
            }[field]
            for vector in USAGE_CORRELATION_VECTORS["idCases"]:
                with self.subTest(field=field, case=vector["name"]):
                    if vector["valid"]:
                        agent.usage("OpenAI", "gpt-4o", 10, 5, **{kwarg: vector["value"]})
                    else:
                        with self.assertRaises(ValueError):
                            agent.usage("OpenAI", "gpt-4o", 10, 5, **{kwarg: vector["value"]})

    def test_usage_tags_vectors_match_the_shared_fixture(self):
        viewer = CapturingViewer(url="http://localhost:8787")
        agent = viewer.agent("coder")
        for vector in USAGE_CORRELATION_VECTORS["tagCases"]:
            with self.subTest(case=vector["name"]):
                if vector["valid"]:
                    agent.usage("OpenAI", "gpt-4o", 10, 5, tags=vector["tags"])
                else:
                    with self.assertRaises(ValueError):
                        agent.usage("OpenAI", "gpt-4o", 10, 5, tags=vector["tags"])

    def test_tags_as_str_raises_type_error(self):
        viewer = CapturingViewer(url="http://localhost:8787")
        agent = viewer.agent("coder")
        with self.assertRaises(TypeError):
            agent.usage("OpenAI", "gpt-4o", 10, 5, tags="env:prod")
        with self.assertRaises(TypeError):
            agent.usage("OpenAI", "gpt-4o", 10, 5, tags=b"env:prod")
        self.assertEqual(viewer.captured, [])

    def test_non_string_correlation_id_raises_type_error(self):
        viewer = CapturingViewer(url="http://localhost:8787")
        agent = viewer.agent("coder")
        with self.assertRaises(TypeError):
            agent.usage("OpenAI", "gpt-4o", 10, 5, trace_id=12345)
        self.assertEqual(viewer.captured, [])

    def test_utf16_length_parity_with_astral_characters(self):
        from sdk.python.agent_viewer import _utf16_length, CORRELATION_ID_MAX_LENGTH

        emoji = "\U0001F600"  # one astral character, 2 UTF-16 code units
        exactly_at_limit = emoji * (CORRELATION_ID_MAX_LENGTH // 2)
        self.assertEqual(_utf16_length(exactly_at_limit), CORRELATION_ID_MAX_LENGTH)

        viewer = CapturingViewer(url="http://localhost:8787")
        agent = viewer.agent("coder")
        # Exactly at the limit (128 UTF-16 code units) must validate.
        agent.usage("OpenAI", "gpt-4o", 10, 5, trace_id=exactly_at_limit)
        # One more astral character pushes it to 130 UTF-16 units: rejected.
        with self.assertRaises(ValueError):
            agent.usage("OpenAI", "gpt-4o", 10, 5, trace_id=exactly_at_limit + emoji)

    def test_whitespace_set_parity_u0085_and_ufeff(self):
        viewer = CapturingViewer(url="http://localhost:8787")
        agent = viewer.agent("coder")
        # U+0085 (NEL) is stripped by Python's str.strip() but is NOT in the JavaScript trim set used by the
        # contract, so a leading or trailing U+0085 must be accepted, not rejected.
        agent.usage("OpenAI", "gpt-4o", 10, 5, trace_id="\u0085leading")
        agent.usage("OpenAI", "gpt-4o", 10, 5, trace_id="trailing\u0085")
        # U+FEFF (BOM) IS in the JavaScript trim set, so it must be rejected at the edges.
        with self.assertRaises(ValueError):
            agent.usage("OpenAI", "gpt-4o", 10, 5, trace_id="﻿leading")
        with self.assertRaises(ValueError):
            agent.usage("OpenAI", "gpt-4o", 10, 5, trace_id="trailing﻿")

    def test_llm_failed_helper(self):
        viewer = CapturingViewer(url="http://localhost:8787")
        agent = viewer.agent("coder")
        agent.llm_failed(
            "OpenAI", "gpt-4.1", "rate_limited",
            http_status=429, retryable=True,
            trace_id="trace_failed", tags=["env:prod"], task_id="task_1",
        )
        failed = [e for e in viewer.captured if e["type"] == "llm.failed"][-1]
        self.assertEqual(failed["taskId"], "task_1")
        self.assertNotIn("taskId", failed["payload"])
        self.assertEqual(failed["severity"], "high")
        self.assertEqual(failed["payload"]["provider"], "OpenAI")
        self.assertEqual(failed["payload"]["model"], "gpt-4.1")
        self.assertEqual(failed["payload"]["errorKind"], "rate_limited")
        self.assertEqual(failed["payload"]["httpStatus"], 429)
        self.assertEqual(failed["payload"]["retryable"], True)
        self.assertEqual(failed["payload"]["traceId"], "trace_failed")
        self.assertEqual(failed["payload"]["tags"], ["env:prod"])

        agent.llm_failed("OpenAI")
        bare = [e for e in viewer.captured if e["type"] == "llm.failed"][-1]
        self.assertNotIn("model", bare["payload"])
        self.assertNotIn("errorKind", bare["payload"])

        with self.assertRaises(ValueError):
            agent.llm_failed("OpenAI", trace_id="")

    def test_live_server_integration(self):
        port = get_free_port()
        env = os.environ.copy()
        env["PORT"] = str(port)
        env["AGENT_VIEWER_STORAGE"] = "memory"

        proc = subprocess.Popen(
            ["./node_modules/.bin/tsx", "-e", f"import('./server/index.ts').then(m => m.startServer({port}))"],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        try:
            # Wait for server to start
            url = f"http://127.0.0.1:{port}"
            viewer = AgentViewer(url=url, max_retries=1, timeout=5.0)

            server_ready = False
            for _ in range(50):
                try:
                    h = viewer.health()
                    if h.get("ok"):
                        server_ready = True
                        break
                except Exception:
                    time.sleep(0.2)

            self.assertTrue(server_ready, "Server failed to start in time")

            # Execute real operations against the server
            agent = viewer.agent("py_bot", name="Python Bot", role_title="Integration Agent")
            agent.thinking("Running real integration test")
            agent.message("Greeting from Python SDK")
            agent.tool_started("analyze_code", input_summary="Scanning repository")
            agent.tool_completed("analyze_code", output_summary="Found 0 defects")
            agent.usage(
                provider="OpenAI",
                model="gpt-4o",
                input_tokens=500,
                output_tokens=120,
                cost=0.005,
                cost_source="provider-reported",
                currency="USD",
            )

            # Create the task first, so the usage event does not create a placeholder task.
            viewer.emit(
                "task.created",
                "Integration task",
                {"id": "task_py_42", "title": "Integration task"},
                agent_id="py_bot",
                task_id="task_py_42",
            )
            agent.usage(
                "Anthropic", "claude-sonnet-4-5", 1800, 450,
                cost=0.012, cost_source="estimated",
                cache_read_tokens=1200, cache_write_tokens=300,
                reasoning_tokens=0, latency_ms=900,
                currency="USD", request_id="req_py_01", task_id="task_py_42",
            )
            agent.done("All tasks passed successfully")

            req = urllib.request.Request(f"{url}/api/v1/events?type=llm.usage&agentId=py_bot&limit=50", method="GET")
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                stored = json.loads(resp.read().decode("utf-8"))["events"]
            by_model = {e["payload"]["model"]: e for e in stored}

            simple = by_model["gpt-4o"]["payload"]
            self.assertEqual(simple["costSource"], "provider-reported")
            self.assertEqual(simple["currency"], "USD")
            self.assertEqual(simple["cost"], 0.005)
            self.assertNotIn("cachedTokens", simple)
            self.assertNotIn("reasoningTokens", simple)

            full = by_model["claude-sonnet-4-5"]
            self.assertEqual(full["taskId"], "task_py_42")
            self.assertNotIn("taskId", full["payload"])
            for key, value in (
                ("inputTokens", 1800), ("outputTokens", 450),
                ("cacheReadTokens", 1200), ("cacheWriteTokens", 300),
                ("reasoningTokens", 0), ("latencyMs", 900),
                ("cost", 0.012), ("costSource", "estimated"),
                ("currency", "USD"), ("requestId", "req_py_01"),
            ):
                self.assertEqual(full["payload"][key], value, key)
            self.assertNotIn("cachedTokens", full["payload"])

            # Batch: an identical copy is a duplicate and the same id with other content is a conflict.
            item = {"id": "evt_py_batch_a", "type": "tool.started", "timestamp": 1700000000000, "agentId": "py_bot", "payload": {"tool": "grep"}}
            batch = viewer.emit_batch([item, dict(item), dict(item, payload={"tool": "sed"}), dict(item, id="evt_py_batch_b")])
            self.assertEqual((batch["accepted"], batch["duplicates"], batch["conflicts"]), (2, 1, 1))
            self.assertEqual([r["status"] for r in batch["results"]], ["accepted", "duplicate", "conflict", "accepted"])
            self.assertEqual(batch["results"][2]["error"], "conflicting_duplicate")
            self.assertEqual(batch["results"][2]["storedFingerprint"], batch["results"][0]["fingerprint"])

            # A single event that reuses a stored id with other content is a 409 with the code.
            with self.assertRaises(AgentViewerError) as conflict:
                viewer.emit("tool.started", "again", {"tool": "awk"}, agent_id="py_bot", event_id="evt_py_batch_a")
            self.assertEqual(conflict.exception.status_code, 409)
            self.assertEqual(conflict.exception.code, "conflicting_duplicate")

            # Verify snapshot contains the agent
            snapshot = viewer.snapshot()
            agents = snapshot.get("agents", [])
            bot_agent = next((a for a in agents if a["id"] == "py_bot"), None)
            self.assertIsNotNone(bot_agent, "Registered agent not found in server snapshot")
            self.assertEqual(bot_agent["name"], "Python Bot")

            # Usage aggregates round trip
            summary = viewer.usage_summary()
            self.assertEqual(summary["schemaVersion"], "1.0")
            self.assertEqual(summary, snapshot["usage"])
            bot_usage = next((a for a in summary["byAgent"] if a["agentId"] == "py_bot"), None)
            self.assertIsNotNone(bot_usage, "Agent missing from the usage summary")
            self.assertEqual(bot_usage["calls"], 2)
            self.assertEqual(bot_usage["tokens"]["input"]["sum"], 500 + 1800)
            gpt = next(m for m in bot_usage["byModel"] if m["provider"] == "OpenAI" and m["model"] == "gpt-4o")
            self.assertEqual(gpt["calls"], 1)
            # The SDK sends the stated currency and cost source, so each call lands in its own pair.
            self.assertEqual(
                [(c["currency"], c["costSource"], c["amountExact"], c["calls"]) for c in gpt["byCurrency"]],
                [("USD", "provider-reported", "0.005", 1)],
            )
            self.assertEqual(gpt["currencyMissingCount"], 0)
            # One call is provider-reported and the other estimated: two pairs, so no single legacy figure.
            self.assertIsNone(snapshot["totalCost"])

        finally:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()


class TestExampleAdapters(unittest.TestCase):
    """One test per Python example adapter (issue #64): checks the trace/parent/tool-call-id mapping
    table and the "omitted when not exposed" cases, with a fake viewer that captures emitted payloads.
    """

    def test_autogen_adapter_forwards_call_id_and_trace_id_only_when_given(self):
        autogen_adapter = _load_example_module("autogen-adapter.py")
        adapter = autogen_adapter.AutoGenViewerAdapter()
        captured = _capture_adapter_viewer(adapter)

        adapter.on_function_call("researcher", "web_search", "query", call_id="call_abc")
        adapter.on_function_return("researcher", "web_search", "done", call_id="call_abc")
        adapter.on_function_call("researcher", "web_search")  # AutoGen gave no call id this time
        adapter.on_llm_response(
            "researcher", "OpenAI", "gpt-4.1", 100, 20,
            trace_id="trace_autogen", tool_call_id="call_abc", tags=["env:prod"],
        )
        adapter.on_llm_response("researcher", "OpenAI", "gpt-4.1", 10, 2)

        tool_started = [e for e in captured if e["type"] == "tool.started"]
        tool_completed = [e for e in captured if e["type"] == "tool.completed"]
        self.assertEqual(tool_started[0]["payload"]["toolCallId"], "call_abc")
        self.assertEqual(tool_completed[0]["payload"]["toolCallId"], "call_abc")
        self.assertNotIn("toolCallId", tool_started[1]["payload"])

        usage_events = [e for e in captured if e["type"] == "llm.usage"]
        with_correlation, without = usage_events
        self.assertEqual(with_correlation["payload"]["traceId"], "trace_autogen")
        self.assertEqual(with_correlation["payload"]["toolCallId"], "call_abc")
        self.assertEqual(with_correlation["payload"]["tags"], ["env:prod"])
        # AutoGen exposes no parent span id at this layer: the adapter never sends one.
        self.assertNotIn("parentId", with_correlation["payload"])
        for field in ("traceId", "parentId", "toolCallId", "tags"):
            self.assertNotIn(field, without["payload"])

    def test_crewai_adapter_omits_tool_call_id_unless_the_caller_passes_one(self):
        crewai_adapter = _load_example_module("crewai-adapter.py")
        adapter = crewai_adapter.CrewAIViewerAdapter()
        captured = _capture_adapter_viewer(adapter)

        adapter.register_crew_agent("writer", "Writer", "Write the report")
        adapter.on_tool_start("writer", "file.read", "report.md")  # CrewAI gives no tool call id
        adapter.on_tool_start("writer", "file.read", "report.md", tool_call_id="explicit_1")
        adapter.on_tool_end("writer", "file.read", "contents", tool_call_id="explicit_1")
        adapter.on_token_usage(
            "writer", "OpenAI", "gpt-4.1", 100, 20,
            trace_id="trace_crewai", tool_call_id="explicit_1", tags=["tier:pro"],
        )
        adapter.on_token_usage("writer", "OpenAI", "gpt-4.1", 10, 2)

        tool_started = [e for e in captured if e["type"] == "tool.started"]
        tool_completed = [e for e in captured if e["type"] == "tool.completed"]
        self.assertNotIn("toolCallId", tool_started[0]["payload"])
        self.assertEqual(tool_started[1]["payload"]["toolCallId"], "explicit_1")
        self.assertEqual(tool_completed[0]["payload"]["toolCallId"], "explicit_1")

        usage_events = [e for e in captured if e["type"] == "llm.usage"]
        with_correlation, without = usage_events
        self.assertEqual(with_correlation["payload"]["traceId"], "trace_crewai")
        self.assertEqual(with_correlation["payload"]["toolCallId"], "explicit_1")
        self.assertEqual(with_correlation["payload"]["tags"], ["tier:pro"])
        self.assertNotIn("parentId", with_correlation["payload"])
        for field in ("traceId", "parentId", "toolCallId", "tags"):
            self.assertNotIn(field, without["payload"])


if __name__ == "__main__":
    unittest.main()
