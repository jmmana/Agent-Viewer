import json
import logging
import os
import sys
import time
import socket
import subprocess
import unittest
import urllib.request

sys.path.insert(0, ".")

from sdk.python.agent_viewer import AgentViewer, AgentHandle, AgentViewerError


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


class TestPythonSDK(unittest.TestCase):
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
            self.assertEqual(bot_usage["calls"], 1)
            self.assertEqual(bot_usage["tokens"]["input"]["sum"], 500)
            gpt = next(m for m in bot_usage["byModel"] if m["provider"] == "OpenAI" and m["model"] == "gpt-4o")
            self.assertEqual(gpt["calls"], 1)
            # The SDK sends no currency, so the cost is kept apart as unknown instead of summed.
            self.assertEqual(gpt["byCurrency"], [])
            self.assertEqual(gpt["currencyMissingCount"], 1)
            self.assertIsNone(snapshot["totalCost"])

        finally:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    unittest.main()
