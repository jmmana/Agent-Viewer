"""Agent Viewer LangGraph adapter (issue #345).

``AgentViewerCallbackHandler`` is a LangChain callback handler that turns LangGraph node, tool and model
callbacks into Agent Viewer canonical events. Install with ``pip install "agent-viewer[langgraph]"`` and pass
it in the graph config::

    from agent_viewer_langgraph import AgentViewerCallbackHandler

    handler = AgentViewerCallbackHandler(url="http://localhost:8787", runtime_id="my-graph")
    graph.invoke(inputs, config={"callbacks": [handler]})

Event ids are deterministic, ``lg:<runtimeId>:<runId>:<eventKind>``, so a replayed callback is an idempotent
duplicate on the server, never a second event. Only names, counts and timings are sent: prompts, completions,
tool inputs and outputs, and error messages never leave the process. Callback metadata is filtered through
``METADATA_WHITELIST`` before it is attached to any payload.

Events are sent from a daemon thread through a bounded ``queue.Queue``, so a slow or unreachable server never
blocks the graph. A full queue drops the event and counts it. Nothing here ever raises into the graph: every
failure is counted in :meth:`AgentViewerCallbackHandler.stats` and passed to ``on_error`` when given. Pending
events are flushed at interpreter exit.
"""

from __future__ import annotations

import atexit
import logging
import queue
import threading
import time
import weakref
from typing import Any, Callable, Dict, List, Optional
from uuid import UUID

try:
    from langchain_core.callbacks import BaseCallbackHandler
except ImportError:  # pragma: no cover - exercised only without the 'langgraph' extra

    class BaseCallbackHandler:  # type: ignore[no-redef]
        """Stand-in so this module imports without langchain-core. Install ``agent-viewer[langgraph]``
        to use the handler with a real graph."""

        raise_error = False
        run_inline = False


from agent_viewer import AgentViewer

logger = logging.getLogger("agent_viewer.langgraph")

# The only callback metadata keys ever forwarded. Everything else (user-supplied config metadata, checkpoint
# ids, tags) can carry arbitrary data and is dropped.
METADATA_WHITELIST = ("langgraph_node", "thread_id", "ls_provider", "ls_model_name", "ls_model_type")

DEFAULT_AGENT_ID = "langgraph"

_ErrorCallback = Callable[[BaseException, Optional[Dict[str, Any]]], None]


def _filter_metadata(metadata: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}
    return {
        key: metadata[key]
        for key in METADATA_WHITELIST
        if isinstance(metadata.get(key), (str, int, float, bool))
    }


def _error_kind(error: BaseException) -> str:
    """Maps an exception to an ``llm.failed`` ``errorKind`` from its class name only, never its message."""
    name = type(error).__name__.lower()
    if "ratelimit" in name or "rate_limit" in name:
        return "rate_limited"
    if "overload" in name:
        return "overloaded"
    if "timeout" in name:
        return "timeout"
    if "auth" in name or "permission" in name:
        return "auth"
    if "cancel" in name:
        return "cancelled"
    if "connection" in name or "network" in name:
        return "network"
    if "badrequest" in name or "invalid" in name or "validation" in name:
        return "invalid_request"
    if "server" in name or "internal" in name:
        return "server_error"
    return "unknown"


def _int_or_none(value: Any) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _extract_usage(response: Any) -> Dict[str, Optional[int]]:
    """Reads token counts from an ``LLMResult``: the message ``usage_metadata`` first, then the provider's
    ``llm_output['token_usage']``. A count that is not reported stays ``None``, never 0."""
    usage: Dict[str, Optional[int]] = {"input": None, "output": None, "cache_read": None, "reasoning": None}
    try:
        for batch in getattr(response, "generations", None) or []:
            for generation in batch or []:
                metadata = getattr(getattr(generation, "message", None), "usage_metadata", None)
                if isinstance(metadata, dict):
                    usage["input"] = _int_or_none(metadata.get("input_tokens"))
                    usage["output"] = _int_or_none(metadata.get("output_tokens"))
                    input_details = metadata.get("input_token_details") or {}
                    output_details = metadata.get("output_token_details") or {}
                    usage["cache_read"] = _int_or_none(input_details.get("cache_read"))
                    usage["reasoning"] = _int_or_none(output_details.get("reasoning"))
                    return usage
        llm_output = getattr(response, "llm_output", None) or {}
        token_usage = llm_output.get("token_usage") or llm_output.get("usage") or {}
        if isinstance(token_usage, dict):
            usage["input"] = _int_or_none(token_usage.get("prompt_tokens", token_usage.get("input_tokens")))
            usage["output"] = _int_or_none(token_usage.get("completion_tokens", token_usage.get("output_tokens")))
    except Exception:  # malformed provider output: report what was read so far
        pass
    return usage


class AgentViewerCallbackHandler(BaseCallbackHandler):
    """LangChain/LangGraph callback handler that reports to Agent Viewer. See the module docstring."""

    raise_error = False
    run_inline = True

    def __init__(
        self,
        viewer: Optional[AgentViewer] = None,
        *,
        url: Optional[str] = None,
        api_key: Optional[str] = None,
        runtime_id: str = "langgraph",
        session_id: Optional[str] = None,
        max_queue_size: int = 1000,
        flush_timeout: float = 5.0,
        on_error: Optional[_ErrorCallback] = None,
        sender: Optional[Callable[[Dict[str, Any]], Any]] = None,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        super().__init__()
        self.viewer = viewer or AgentViewer(url=url, api_key=api_key, runtime_id=runtime_id, session_id=session_id)
        self.runtime_id = self.viewer.runtime_id or runtime_id
        self.session_id = session_id if session_id is not None else self.viewer.session_id
        self.flush_timeout = flush_timeout
        self.on_error = on_error
        self._sender = sender or self._post_event
        self._clock = clock or time.time
        self._queue: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=max_queue_size)
        self._runs: Dict[str, Dict[str, Any]] = {}
        self._registered_agents: set = set()
        self._lock = threading.Lock()
        self._stats = {"enqueued": 0, "sent": 0, "dropped": 0, "failed": 0, "callback_errors": 0}
        self._worker: Optional[threading.Thread] = None
        self._closed = False

        handler_ref = weakref.ref(self)

        def _flush_at_exit() -> None:
            handler = handler_ref()
            if handler is not None:
                handler.flush(handler.flush_timeout)

        atexit.register(_flush_at_exit)

    # ---------------------------------------------------------------
    # Public API
    # ---------------------------------------------------------------

    def stats(self) -> Dict[str, int]:
        """Counters: ``enqueued``, ``sent``, ``dropped`` (queue full or handler closed), ``failed`` (send
        error) and ``callback_errors`` (an internal error while handling a callback)."""
        with self._lock:
            return dict(self._stats)

    def flush(self, timeout: Optional[float] = None) -> bool:
        """Waits until every queued event has been sent or has failed. Returns ``False`` on timeout."""
        deadline = None if timeout is None else time.monotonic() + timeout
        while self._queue.unfinished_tasks:
            if deadline is not None and time.monotonic() >= deadline:
                return False
            time.sleep(0.005)
        return True

    def close(self, timeout: Optional[float] = None) -> bool:
        """Flushes pending events and stops accepting new ones."""
        flushed = self.flush(self.flush_timeout if timeout is None else timeout)
        self._closed = True
        return flushed

    # ---------------------------------------------------------------
    # Queue and worker
    # ---------------------------------------------------------------

    def _post_event(self, event: Dict[str, Any]) -> Any:
        return self.viewer._post_with_retry("/api/v1/events", event, idempotency_key=event["id"])

    def _count(self, key: str) -> None:
        with self._lock:
            self._stats[key] += 1

    def _report_error(self, error: BaseException, event: Optional[Dict[str, Any]]) -> None:
        if self.on_error is not None:
            try:
                self.on_error(error, event)
            except Exception:
                pass
        elif self.viewer.debug:
            logger.warning("Agent Viewer LangGraph handler error: %s", error)

    def _ensure_worker(self) -> None:
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._run_worker, name="agent-viewer-langgraph", daemon=True)
            self._worker.start()

    def _run_worker(self) -> None:
        while True:
            event = self._queue.get()
            try:
                self._sender(event)
                self._count("sent")
            except Exception as err:
                self._count("failed")
                self._report_error(err, event)
            finally:
                self._queue.task_done()

    def _enqueue(self, event: Dict[str, Any]) -> None:
        if self._closed:
            self._count("dropped")
            return
        try:
            self._queue.put_nowait(event)
        except queue.Full:
            self._count("dropped")
            return
        self._count("enqueued")
        self._ensure_worker()

    # ---------------------------------------------------------------
    # Event building
    # ---------------------------------------------------------------

    def _event(
        self,
        run_id: Any,
        kind: str,
        event_type: str,
        agent_id: str,
        summary: str,
        payload: Dict[str, Any],
        metadata: Dict[str, Any],
        severity: str = "normal",
    ) -> None:
        session_id = metadata.get("thread_id")
        event = {
            "schemaVersion": "1.0",
            "id": f"lg:{self.runtime_id}:{run_id}:{kind}",
            "type": event_type,
            "timestamp": int(self._clock() * 1000),
            "runtimeId": self.runtime_id,
            "sessionId": str(session_id) if session_id is not None else self.session_id,
            "source": f"agent:{agent_id}",
            "agentId": agent_id,
            "severity": severity,
            "summary": summary,
            "payload": {k: v for k, v in payload.items() if v is not None},
        }
        if metadata:
            event["payload"]["metadata"] = dict(metadata)
        self._enqueue({k: v for k, v in event.items() if v is not None})

    def _agent_for(self, metadata: Dict[str, Any], parent_run_id: Optional[UUID]) -> str:
        node = metadata.get("langgraph_node")
        if isinstance(node, str) and node:
            return node
        parent = self._runs.get(str(parent_run_id)) if parent_run_id is not None else None
        return parent["agent_id"] if parent else DEFAULT_AGENT_ID

    def _register(self, run_id: Any, agent_id: str, metadata: Dict[str, Any]) -> None:
        if agent_id in self._registered_agents:
            return
        self._registered_agents.add(agent_id)
        self._event(
            run_id,
            "agent.registered",
            "agent.registered",
            agent_id,
            f"Registered {agent_id}",
            {"id": agent_id, "name": agent_id, "roleTitle": "LangGraph node", "provider": "LangGraph", "model": "LangGraph"},
            metadata,
        )

    def _guard(self, fn: Callable[[], None]) -> None:
        """Runs one callback body. Nothing raised here ever reaches the graph."""
        try:
            fn()
        except Exception as err:
            self._count("callback_errors")
            self._report_error(err, None)

    # ---------------------------------------------------------------
    # Node (chain) callbacks
    # ---------------------------------------------------------------

    def on_chain_start(
        self,
        serialized: Optional[Dict[str, Any]],
        inputs: Any,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        def body() -> None:
            meta = _filter_metadata(metadata)
            node = meta.get("langgraph_node")
            name = kwargs.get("name") or (serialized or {}).get("name")
            # LangGraph runs the node itself and every runnable inside it with the same langgraph_node
            # metadata; only the run whose name is the node name is the node.
            if not isinstance(node, str) or name != node:
                return
            self._runs[str(run_id)] = {"kind": "node", "agent_id": node, "meta": meta}
            self._register(run_id, node, meta)
            self._event(
                run_id, "node.start", "agent.status.changed", node, f"{node} started",
                {"status": "THINKING", "statusText": f"Running node {node}"}, meta,
            )

        self._guard(body)

    def on_chain_end(self, outputs: Any, *, run_id: UUID, **kwargs: Any) -> None:
        def body() -> None:
            run = self._runs.pop(str(run_id), None)
            if not run or run["kind"] != "node":
                return
            node = run["agent_id"]
            self._event(
                run_id, "node.end", "agent.status.changed", node, f"{node} finished",
                {"status": "DONE", "statusText": f"Finished node {node}"}, run["meta"],
            )

        self._guard(body)

    def on_chain_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        def body() -> None:
            run = self._runs.pop(str(run_id), None)
            if not run or run["kind"] != "node":
                return
            node = run["agent_id"]
            # GraphInterrupt and similar control-flow exceptions are not failures of the node.
            if type(error).__name__ in ("GraphInterrupt", "NodeInterrupt", "ParentCommand"):
                status, text, severity = "WAITING", f"Node {node} interrupted", "normal"
            else:
                status, text, severity = "BLOCKED", f"Node {node} failed ({type(error).__name__})", "high"
            self._event(
                run_id, "node.error", "agent.status.changed", node, text,
                {"status": status, "statusText": text}, run["meta"], severity=severity,
            )

        self._guard(body)

    # ---------------------------------------------------------------
    # Tool callbacks
    # ---------------------------------------------------------------

    def on_tool_start(
        self,
        serialized: Optional[Dict[str, Any]],
        input_str: str,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        def body() -> None:
            meta = _filter_metadata(metadata)
            agent_id = self._agent_for(meta, parent_run_id)
            tool = kwargs.get("name") or (serialized or {}).get("name") or "tool"
            tool_call_id = kwargs.get("tool_call_id")
            if not isinstance(tool_call_id, str):
                tool_call_id = None
            self._runs[str(run_id)] = {
                "kind": "tool", "agent_id": agent_id, "meta": meta, "tool": tool, "tool_call_id": tool_call_id,
            }
            self._register(run_id, agent_id, meta)
            self._event(
                run_id, "tool.start", "tool.started", agent_id, f"Started tool {tool}",
                {"tool": tool, "toolCallId": tool_call_id}, meta,
            )

        self._guard(body)

    def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        def body() -> None:
            run = self._runs.pop(str(run_id), None)
            if not run or run["kind"] != "tool":
                return
            self._event(
                run_id, "tool.end", "tool.completed", run["agent_id"], f"Completed tool {run['tool']}",
                {"tool": run["tool"], "toolCallId": run["tool_call_id"]}, run["meta"],
            )

        self._guard(body)

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        def body() -> None:
            run = self._runs.pop(str(run_id), None)
            if not run or run["kind"] != "tool":
                return
            error_name = type(error).__name__
            self._event(
                run_id, "tool.error", "tool.failed", run["agent_id"], f"Failed tool {run['tool']}",
                {"tool": run["tool"], "error": error_name, "toolCallId": run["tool_call_id"]}, run["meta"],
                severity="high",
            )

        self._guard(body)

    # ---------------------------------------------------------------
    # Model callbacks
    # ---------------------------------------------------------------

    def _model_start(self, run_id: UUID, parent_run_id: Optional[UUID], metadata: Optional[Dict[str, Any]]) -> None:
        meta = _filter_metadata(metadata)
        self._runs[str(run_id)] = {
            "kind": "llm", "agent_id": self._agent_for(meta, parent_run_id), "meta": meta, "started": self._clock(),
        }

    def on_llm_start(
        self,
        serialized: Optional[Dict[str, Any]],
        prompts: List[str],
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        self._guard(lambda: self._model_start(run_id, parent_run_id, metadata))

    def on_chat_model_start(
        self,
        serialized: Optional[Dict[str, Any]],
        messages: List[List[Any]],
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> None:
        self._guard(lambda: self._model_start(run_id, parent_run_id, metadata))

    def _model_identity(self, run: Dict[str, Any]) -> Dict[str, Any]:
        meta = run["meta"]
        latency = int((self._clock() - run["started"]) * 1000)
        return {
            "provider": str(meta.get("ls_provider") or "unknown"),
            "model": str(meta.get("ls_model_name") or "unknown"),
            "latencyMs": max(latency, 0),
        }

    def on_llm_end(self, response: Any, *, run_id: UUID, **kwargs: Any) -> None:
        def body() -> None:
            run = self._runs.pop(str(run_id), None)
            if not run or run["kind"] != "llm":
                return
            agent_id = run["agent_id"]
            self._register(run_id, agent_id, run["meta"])
            identity = self._model_identity(run)
            usage = _extract_usage(response)
            payload = dict(identity)
            payload.update({
                "inputTokens": usage["input"],
                "outputTokens": usage["output"],
                "cacheReadTokens": usage["cache_read"],
                "reasoningTokens": usage["reasoning"],
                "costSource": "unknown",
            })
            tokens = f"({usage['input'] if usage['input'] is not None else '?'}+" \
                     f"{usage['output'] if usage['output'] is not None else '?'})"
            self._event(
                run_id, "llm.end", "llm.usage", agent_id,
                f"{identity['provider']}/{identity['model']} tokens {tokens}", payload, run["meta"],
            )

        self._guard(body)

    def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        def body() -> None:
            run = self._runs.pop(str(run_id), None)
            if not run or run["kind"] != "llm":
                return
            agent_id = run["agent_id"]
            self._register(run_id, agent_id, run["meta"])
            payload = self._model_identity(run)
            payload.update({"errorKind": _error_kind(error), "costSource": "unknown"})
            self._event(
                run_id, "llm.error", "llm.failed", agent_id,
                f"{payload['provider']}/{payload['model']} call failed", payload, run["meta"], severity="high",
            )

        self._guard(body)
