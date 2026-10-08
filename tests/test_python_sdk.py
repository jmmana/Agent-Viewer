import os
import sys
import time
import socket
import subprocess
import unittest

sys.path.insert(0, ".")

from sdk.python.agent_viewer import AgentViewer, AgentHandle, AgentViewerError


def get_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


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
        self.assertEqual(usage_evt["payload"]["costSource"], "provider-reported")

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
            )
            agent.done("All tasks passed successfully")

            # Verify snapshot contains the agent
            snapshot = viewer.snapshot()
            agents = snapshot.get("agents", [])
            bot_agent = next((a for a in agents if a["id"] == "py_bot"), None)
            self.assertIsNotNone(bot_agent, "Registered agent not found in server snapshot")
            self.assertEqual(bot_agent["name"], "Python Bot")

        finally:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    unittest.main()
