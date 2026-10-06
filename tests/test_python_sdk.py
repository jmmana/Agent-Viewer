import sys
import unittest
sys.path.insert(0, ".")

from sdk.python.agent_viewer import AgentViewer, AgentHandle, AgentViewerError

class TestPythonSDK(unittest.TestCase):
    def test_agent_handle_initialization(self):
        viewer = AgentViewer(url="http://localhost:8787", runtime_id="py-test")
        agent = viewer.agent("researcher", name="Research Agent")
        self.assertEqual(agent.id, "researcher")
        self.assertEqual(agent.name, "Research Agent")
        self.assertEqual(agent.workspace, "development")

    def test_emit_payload_structure(self):
        events_captured = []
        class MockViewer(AgentViewer):
            def _post_with_retry(self, endpoint, body, idempotency_key=None):
                events_captured.append(body)
                return {"accepted": True, "duplicate": False}

        viewer = MockViewer(url="http://localhost:8787", runtime_id="rt_mock", session_id="ses_mock")
        agent = viewer.agent("coder", name="Coder Agent")
        agent.thinking("Planning architecture")

        # Check emitted event structure
        self.assertEqual(len(events_captured), 2) # auto-register + status.changed
        reg_event = events_captured[0]
        self.assertEqual(reg_event["type"], "agent.registered")
        self.assertEqual(reg_event["agentId"], "coder")

        status_event = events_captured[1]
        self.assertEqual(status_event["type"], "agent.status.changed")
        self.assertEqual(status_event["runtimeId"], "rt_mock")
        self.assertEqual(status_event["sessionId"], "ses_mock")
        self.assertEqual(status_event["payload"]["status"], "THINKING")

if __name__ == "__main__":
    unittest.main()
