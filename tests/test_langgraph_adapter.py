"""Tests for sdk/python/agent_viewer_langgraph.py (issue #345).

Self-contained: the callbacks are driven by hand with fixed run ids and a fixed clock, so the emitted events
are fully deterministic and no network or LangGraph install is needed. One test checks the real
langchain-core base class and is skipped when the 'langgraph' extra is not installed.
"""

import os
import sys
import threading
import time
import unittest
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdk", "python"))

import agent_viewer_langgraph as lg  # noqa: E402
from agent_viewer_langgraph import AgentViewerCallbackHandler, METADATA_WHITELIST  # noqa: E402

GRAPH_RUN = uuid.UUID("00000000-0000-0000-0000-000000000001")
NODE_RUN = uuid.UUID("00000000-0000-0000-0000-000000000002")
LLM_RUN = uuid.UUID("00000000-0000-0000-0000-000000000003")
TOOL_RUN = uuid.UUID("00000000-0000-0000-0000-000000000004")
INNER_RUN = uuid.UUID("00000000-0000-0000-0000-000000000005")

SECRET = "SECRET-PROMPT-do-not-send"

NODE_METADATA = {
    "langgraph_node": "researcher",
    "thread_id": "thread-1",
    "langgraph_step": 1,
    "user_config_secret": SECRET,
    "checkpoint_ns": "researcher:abc",
}
LLM_METADATA = dict(NODE_METADATA, ls_provider="openai", ls_model_name="gpt-test", ls_model_type="chat")


class _Message:
    def __init__(self, usage_metadata):
        self.usage_metadata = usage_metadata
        self.content = SECRET


class _Generation:
    def __init__(self, message):
        self.message = message
        self.text = SECRET


class _LLMResult:
    def __init__(self, generations, llm_output=None):
        self.generations = generations
        self.llm_output = llm_output


class RateLimitError(Exception):
    pass


class _FakeClock:
    def __init__(self, start=1_700_000_000.0):
        self.now = start

    def __call__(self):
        return self.now


def _make_handler(**kwargs):
    sent = []
    clock = _FakeClock()
    kwargs.setdefault("sender", sent.append)
    handler = AgentViewerCallbackHandler(runtime_id="rt-test", clock=clock, **kwargs)
    return handler, sent, clock


def _run_fixture_graph(handler, clock):
    """One graph run: graph chain, node chain, an inner runnable, a chat model call and a tool call."""
    handler.on_chain_start({"name": "LangGraph"}, {"q": SECRET}, run_id=GRAPH_RUN, metadata={"thread_id": "thread-1"}, name="LangGraph")
    handler.on_chain_start({}, {"q": SECRET}, run_id=NODE_RUN, parent_run_id=GRAPH_RUN, metadata=NODE_METADATA, name="researcher")
    handler.on_chain_start({}, {"q": SECRET}, run_id=INNER_RUN, parent_run_id=NODE_RUN, metadata=NODE_METADATA, name="RunnableSequence")
    handler.on_chat_model_start({}, [[SECRET]], run_id=LLM_RUN, parent_run_id=INNER_RUN, metadata=LLM_METADATA)
    clock.now += 0.25
    usage = {
        "input_tokens": 12,
        "output_tokens": 7,
        "input_token_details": {"cache_read": 2},
        "output_token_details": {"reasoning": 3},
    }
    handler.on_llm_end(_LLMResult([[_Generation(_Message(usage))]]), run_id=LLM_RUN)
    handler.on_tool_start({"name": "search"}, SECRET, run_id=TOOL_RUN, parent_run_id=INNER_RUN, metadata=NODE_METADATA, tool_call_id="call_1")
    handler.on_tool_end(SECRET, run_id=TOOL_RUN)
    handler.on_chain_end({"a": SECRET}, run_id=INNER_RUN)
    handler.on_chain_end({"a": SECRET}, run_id=NODE_RUN)
    handler.on_chain_end({"a": SECRET}, run_id=GRAPH_RUN)


EXPECTED_SEQUENCE = [
    (f"lg:rt-test:{NODE_RUN}:agent.registered", "agent.registered"),
    (f"lg:rt-test:{NODE_RUN}:node.start", "agent.status.changed"),
    (f"lg:rt-test:{LLM_RUN}:llm.end", "llm.usage"),
    (f"lg:rt-test:{TOOL_RUN}:tool.start", "tool.started"),
    (f"lg:rt-test:{TOOL_RUN}:tool.end", "tool.completed"),
    (f"lg:rt-test:{NODE_RUN}:node.end", "agent.status.changed"),
]


class LangGraphAdapterTests(unittest.TestCase):
    def test_event_mapping_and_deterministic_ids(self):
        handler, sent, clock = _make_handler()
        _run_fixture_graph(handler, clock)
        self.assertTrue(handler.flush(2))
        self.assertEqual([(e["id"], e["type"]) for e in sent], EXPECTED_SEQUENCE)

        by_id = {e["id"]: e for e in sent}
        start = by_id[f"lg:rt-test:{NODE_RUN}:node.start"]
        self.assertEqual(start["agentId"], "researcher")
        self.assertEqual(start["sessionId"], "thread-1")
        self.assertEqual(start["runtimeId"], "rt-test")
        self.assertEqual(start["payload"]["status"], "THINKING")
        self.assertEqual(by_id[f"lg:rt-test:{NODE_RUN}:node.end"]["payload"]["status"], "DONE")

        usage = by_id[f"lg:rt-test:{LLM_RUN}:llm.end"]
        self.assertEqual(usage["agentId"], "researcher")
        self.assertEqual(usage["timestamp"], 1_700_000_000_250)
        p = usage["payload"]
        self.assertEqual((p["provider"], p["model"]), ("openai", "gpt-test"))
        self.assertEqual((p["inputTokens"], p["outputTokens"]), (12, 7))
        self.assertEqual((p["cacheReadTokens"], p["reasoningTokens"]), (2, 3))
        self.assertEqual(p["latencyMs"], 250)
        self.assertEqual(p["costSource"], "unknown")

        tool = by_id[f"lg:rt-test:{TOOL_RUN}:tool.start"]
        self.assertEqual(tool["payload"]["tool"], "search")
        self.assertEqual(tool["payload"]["toolCallId"], "call_1")

    def test_same_input_produces_identical_events(self):
        first_handler, first, first_clock = _make_handler()
        second_handler, second, second_clock = _make_handler()
        _run_fixture_graph(first_handler, first_clock)
        _run_fixture_graph(second_handler, second_clock)
        first_handler.flush(2)
        second_handler.flush(2)
        self.assertEqual(first, second)

    def test_privacy_whitelist(self):
        handler, sent, clock = _make_handler()
        _run_fixture_graph(handler, clock)
        handler.flush(2)
        for event in sent:
            self.assertNotIn(SECRET, repr(event))
            metadata = event["payload"].get("metadata", {})
            self.assertTrue(set(metadata) <= set(METADATA_WHITELIST), metadata)
        llm_meta = next(e for e in sent if e["type"] == "llm.usage")["payload"]["metadata"]
        self.assertEqual(
            llm_meta,
            {"langgraph_node": "researcher", "thread_id": "thread-1", "ls_provider": "openai",
             "ls_model_name": "gpt-test", "ls_model_type": "chat"},
        )

    def test_unreported_tokens_stay_unknown(self):
        handler, sent, _ = _make_handler()
        handler.on_llm_start({}, [SECRET], run_id=LLM_RUN, metadata=LLM_METADATA)
        handler.on_llm_end(_LLMResult([[_Generation(_Message(None))]], llm_output={}), run_id=LLM_RUN)
        handler.flush(2)
        payload = next(e for e in sent if e["type"] == "llm.usage")["payload"]
        self.assertNotIn("inputTokens", payload)
        self.assertNotIn("outputTokens", payload)

    def test_llm_output_token_usage_fallback(self):
        handler, sent, _ = _make_handler()
        handler.on_llm_start({}, [SECRET], run_id=LLM_RUN, metadata=LLM_METADATA)
        result = _LLMResult([[_Generation(_Message(None))]], llm_output={"token_usage": {"prompt_tokens": 5, "completion_tokens": 4}})
        handler.on_llm_end(result, run_id=LLM_RUN)
        handler.flush(2)
        payload = next(e for e in sent if e["type"] == "llm.usage")["payload"]
        self.assertEqual((payload["inputTokens"], payload["outputTokens"]), (5, 4))

    def test_errors_map_without_messages(self):
        handler, sent, _ = _make_handler()
        handler.on_chain_start({}, {}, run_id=NODE_RUN, metadata=NODE_METADATA, name="researcher")
        handler.on_chat_model_start({}, [[]], run_id=LLM_RUN, parent_run_id=NODE_RUN, metadata=LLM_METADATA)
        handler.on_llm_error(RateLimitError(SECRET), run_id=LLM_RUN)
        handler.on_tool_start({"name": "search"}, SECRET, run_id=TOOL_RUN, parent_run_id=NODE_RUN, metadata={})
        handler.on_tool_error(ValueError(SECRET), run_id=TOOL_RUN)
        handler.on_chain_error(ValueError(SECRET), run_id=NODE_RUN)
        handler.flush(2)
        by_id = {e["id"]: e for e in sent}
        failed = by_id[f"lg:rt-test:{LLM_RUN}:llm.error"]
        self.assertEqual(failed["type"], "llm.failed")
        self.assertEqual(failed["payload"]["errorKind"], "rate_limited")
        tool = by_id[f"lg:rt-test:{TOOL_RUN}:tool.error"]
        self.assertEqual(tool["agentId"], "researcher")
        self.assertEqual(tool["payload"]["error"], "ValueError")
        self.assertEqual(by_id[f"lg:rt-test:{NODE_RUN}:node.error"]["payload"]["status"], "BLOCKED")
        self.assertNotIn(SECRET, repr(sent))

    def test_sender_failure_never_raises_and_is_counted(self):
        errors = []

        def failing_sender(event):
            raise RuntimeError("server down")

        handler, _, clock = _make_handler(sender=failing_sender, on_error=lambda err, event: errors.append((err, event)))
        _run_fixture_graph(handler, clock)
        self.assertTrue(handler.flush(2))
        stats = handler.stats()
        self.assertEqual(stats["failed"], len(EXPECTED_SEQUENCE))
        self.assertEqual(stats["sent"], 0)
        self.assertEqual(len(errors), len(EXPECTED_SEQUENCE))
        self.assertIsInstance(errors[0][0], RuntimeError)

    def test_internal_callback_error_is_swallowed(self):
        errors = []
        handler, _, _ = _make_handler(on_error=lambda err, event: errors.append(err))
        # A broken clock makes the model start callback fail internally.
        handler._clock = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
        handler.on_chat_model_start({}, [[]], run_id=LLM_RUN, metadata=LLM_METADATA)
        self.assertEqual(handler.stats()["callback_errors"], 1)
        self.assertEqual(len(errors), 1)

    def test_bounded_queue_drops_when_full(self):
        release = threading.Event()

        def blocking_sender(event):
            release.wait(2)

        handler, _, _ = _make_handler(sender=blocking_sender, max_queue_size=2)
        for i in range(10):
            handler.on_tool_start({"name": "t"}, "", run_id=uuid.UUID(int=100 + i), metadata=NODE_METADATA)
        release.set()
        self.assertTrue(handler.flush(2))
        stats = handler.stats()
        self.assertGreater(stats["dropped"], 0)
        self.assertEqual(stats["enqueued"] + stats["dropped"], 11)  # 10 tool starts + 1 registration
        self.assertEqual(stats["sent"], stats["enqueued"])

    def test_sends_from_daemon_thread(self):
        threads = []
        handler, _, clock = _make_handler(sender=lambda event: threads.append(threading.current_thread()))
        _run_fixture_graph(handler, clock)
        handler.flush(2)
        self.assertTrue(threads)
        self.assertTrue(all(t.daemon and t is not threading.main_thread() for t in threads))

    def test_flush_times_out_and_close_drops_later_events(self):
        release = threading.Event()
        handler, _, _ = _make_handler(sender=lambda event: release.wait(2))
        handler.on_tool_start({"name": "t"}, "", run_id=TOOL_RUN, metadata=NODE_METADATA)
        started = time.monotonic()
        self.assertFalse(handler.flush(0.05))
        self.assertLess(time.monotonic() - started, 1)
        release.set()
        self.assertTrue(handler.close(2))
        handler.on_tool_end("", run_id=TOOL_RUN)
        self.assertEqual(handler.stats()["dropped"], 1)

    def test_handler_flags(self):
        self.assertFalse(AgentViewerCallbackHandler.raise_error)
        self.assertTrue(AgentViewerCallbackHandler.run_inline)

    def test_real_base_class_when_extra_installed(self):
        try:
            from langchain_core.callbacks import BaseCallbackHandler
        except ImportError:
            self.skipTest("langchain-core not installed (agent-viewer[langgraph] extra)")
        self.assertTrue(issubclass(AgentViewerCallbackHandler, BaseCallbackHandler))
        self.assertIs(lg.BaseCallbackHandler, BaseCallbackHandler)


if __name__ == "__main__":
    unittest.main()
