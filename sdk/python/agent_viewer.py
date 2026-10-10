"""Agent Viewer Python SDK.

Simple, production-grade integration client for connecting external AI agents
to Agent Viewer virtual office observability.
"""

from __future__ import annotations

import json
import logging
import random
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple, Union

logger = logging.getLogger("agent_viewer")

COST_SOURCES = ("provider-reported", "estimated", "unknown")

_UNSTATED_COST_SOURCE_WARNING = (
    'Agent Viewer: a cost was reported without cost_source, so it is sent as costSource="unknown". '
    'Pass cost_source="provider-reported" or "estimated" to state where the cost comes from.'
)

# -------------------------------------------------------------
# Usage correlation block (issue #64): traceId, parentId, toolCallId, meetingId, userId, tags.
#
# This SDK ships standalone and does not import the server contract, so the three limits and the
# whitespace rule are kept here as an explicit copy. tests/fixtures/usage-correlation-vectors.json is the
# shared test-vector file that keeps this copy, the server contract and the TypeScript SDK from drifting.
# -------------------------------------------------------------

CORRELATION_ID_MAX_LENGTH = 128
USAGE_TAGS_MAX = 20
USAGE_TAG_MAX_LENGTH = 64

# Same exact whitespace set as ECMAScript's String.prototype.trim (value !== value.trim()). Deliberately NOT
# str.strip(): Python's default whitespace set differs (for example it strips U+001C-U+001F and U+0085,
# which are not in this set) and does not include U+00A0 or U+FEFF, which are.
_TRIMMABLE_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d   "
    "           "
    "    　﻿"
)


def _utf16_length(value: str) -> int:
    """Counts UTF-16 code units, matching JavaScript's String.length for astral characters."""
    return len(value.encode("utf-16-le")) // 2


def _has_control_character(value: str) -> bool:
    return any(ord(ch) <= 0x1F or ord(ch) == 0x7F for ch in value)


def _has_leading_or_trailing_whitespace(value: str) -> bool:
    return bool(value) and (value[0] in _TRIMMABLE_WHITESPACE or value[-1] in _TRIMMABLE_WHITESPACE)


def _validate_correlation_id(name: str, value: Any) -> None:
    """Validates one correlation id field with the server's exact rules. Raises ``TypeError`` for a
    non-string value and ``ValueError`` naming the argument for anything else that is invalid. ``None``
    means "not reported" and is always accepted; never truncates.
    """
    if value is None:
        return
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string (got {type(value).__name__})")
    length = _utf16_length(value)
    if length < 1:
        raise ValueError(f"{name} must not be empty")
    if length > CORRELATION_ID_MAX_LENGTH:
        raise ValueError(f"{name} must be at most {CORRELATION_ID_MAX_LENGTH} characters")
    if _has_control_character(value):
        raise ValueError(f"{name} must not contain control characters")
    if _has_leading_or_trailing_whitespace(value):
        raise ValueError(f"{name} must not have leading or trailing whitespace")


def _validate_tags(tags: Any) -> None:
    """Validates ``tags`` with the server's exact rules. A ``str`` or ``bytes`` raises ``TypeError`` (a
    ``str`` is itself a ``Sequence`` and would otherwise be split into one tag per character).
    """
    if tags is None:
        return
    if isinstance(tags, (str, bytes)):
        raise TypeError("tags must be a sequence of strings, not a single str or bytes")
    if not isinstance(tags, Sequence):
        raise TypeError("tags must be a sequence of strings")
    tags_list = list(tags)
    if len(tags_list) > USAGE_TAGS_MAX:
        raise ValueError(f"At most {USAGE_TAGS_MAX} tags are allowed")
    for index, tag in enumerate(tags_list):
        if not isinstance(tag, str):
            raise TypeError(f"tags[{index}] must be a string")
        length = _utf16_length(tag)
        if length < 1:
            raise ValueError(f"tags[{index}] must not be empty")
        if length > USAGE_TAG_MAX_LENGTH:
            raise ValueError(f"tags[{index}] must be at most {USAGE_TAG_MAX_LENGTH} characters")
        if _has_control_character(tag):
            raise ValueError(f"tags[{index}] must not contain control characters")
        if _has_leading_or_trailing_whitespace(tag):
            raise ValueError(f"tags[{index}] must not have leading or trailing whitespace")


def _validate_usage_correlation(
    trace_id: Optional[str],
    parent_id: Optional[str],
    tool_call_id: Optional[str],
    meeting_id: Optional[str],
    user_id: Optional[str],
    tags: Optional[Sequence[str]],
) -> None:
    _validate_correlation_id("trace_id", trace_id)
    _validate_correlation_id("parent_id", parent_id)
    _validate_correlation_id("tool_call_id", tool_call_id)
    _validate_correlation_id("meeting_id", meeting_id)
    _validate_correlation_id("user_id", user_id)
    _validate_tags(tags)


def _correlation_payload(
    trace_id: Optional[str],
    parent_id: Optional[str],
    tool_call_id: Optional[str],
    meeting_id: Optional[str],
    user_id: Optional[str],
    tags: Optional[Sequence[str]],
) -> Dict[str, Any]:
    """Builds the payload keys for the six correlation fields, only when given (never ``None`` on the wire)."""
    payload: Dict[str, Any] = {}
    if trace_id is not None:
        payload["traceId"] = trace_id
    if parent_id is not None:
        payload["parentId"] = parent_id
    if tool_call_id is not None:
        payload["toolCallId"] = tool_call_id
    if meeting_id is not None:
        payload["meetingId"] = meeting_id
    if user_id is not None:
        payload["userId"] = user_id
    if tags is not None:
        payload["tags"] = list(tags)
    return payload


class AgentViewerError(Exception):
    """Exception raised by Agent Viewer API client.

    ``code`` is the ``error`` field of the response body when there is one. ``"conflicting_duplicate"``
    (``status_code`` 409) means an event with the same id was already stored with different content: the
    new event was not applied, and resending it will never succeed. The client never retries a 409.
    """

    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        issues: Optional[List[Dict[str, Any]]] = None,
        code: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.issues = issues
        self.code = code


def _append_repeatable(
    params: List[Tuple[str, str]], key: str, value: Optional[Union[str, Sequence[str]]]
) -> None:
    """Appends one query parameter per value of a repeatable filter (issue #67's ``list_calls``): a single
    string becomes one pair, a sequence becomes one pair per item, sent as repeated query parameters."""
    if value is None:
        return
    values: Sequence[str] = [value] if isinstance(value, str) else list(value)
    for v in values:
        params.append((key, v))


def _default_event_id() -> str:
    """Full 128-bit random id. Two distinct events never share an id by chance."""
    return f"evt_{uuid.uuid4().hex}"


class AgentHandle:
    """Convenience handle for interacting with an individual agent in Agent Viewer."""

    def __init__(
        self,
        viewer: "AgentViewer",
        agent_id: str,
        name: Optional[str] = None,
        role_title: Optional[str] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        workspace: Optional[str] = None,
    ) -> None:
        self.viewer = viewer
        self.id = agent_id
        self.name = name or agent_id
        self.role_title = role_title or "AI Agent"
        self.provider = provider or "Custom"
        self.model = model or "Custom"
        self.workspace = workspace or "development"
        self._registered = False

    def _ensure_registered(self) -> None:
        if not self._registered and self.viewer.auto_register:
            try:
                self.viewer.emit(
                    "agent.registered",
                    f"Registered {self.name}",
                    {
                        "id": self.id,
                        "name": self.name,
                        "roleTitle": self.role_title,
                        "provider": self.provider,
                        "model": self.model,
                        "workspace": self.workspace,
                    },
                    agent_id=self.id,
                    source=f"agent:{self.id}",
                )
                self._registered = True
            except Exception as err:
                if self.viewer.debug:
                    logger.warning("Auto-registration warning for agent %s: %s", self.id, err)

    def status(self, status: str, status_text: Optional[str] = None, workspace: Optional[str] = None) -> None:
        """Update agent status."""
        self._ensure_registered()
        payload: Dict[str, Any] = {"status": status.upper()}
        if status_text:
            payload["statusText"] = status_text
        if workspace or self.workspace:
            payload["workspace"] = workspace or self.workspace

        self.viewer.emit(
            "agent.status.changed",
            status_text or f"{self.id} -> {status}",
            payload,
            agent_id=self.id,
            source=f"agent:{self.id}",
        )

    def idle(self, summary: str = "Idle and awaiting tasks") -> None:
        """Set agent to idle state."""
        self.status("IDLE", status_text=summary)

    def thinking(self, summary: str = "Thinking and processing") -> None:
        """Set agent to thinking state."""
        self.status("THINKING", status_text=summary)

    def researching(self, summary: str = "Researching information") -> None:
        """Set agent to researching state."""
        self.status("RESEARCHING", status_text=summary, workspace="research_area")

    def coding(self, summary: str = "Writing code") -> None:
        """Set agent to coding state."""
        self.status("CODING", status_text=summary, workspace="development")

    def testing(self, summary: str = "Running test suite") -> None:
        """Set agent to testing state."""
        self.status("TESTING", status_text=summary, workspace="qa_lab")

    def waiting(self, summary: str = "Waiting for dependencies") -> None:
        """Set agent to waiting state."""
        self.status("WAITING", status_text=summary)

    def blocked(self, reason: str = "Execution blocked") -> None:
        """Set agent to blocked state."""
        self.status("BLOCKED", status_text=reason)

    def done(self, summary: str = "Task completed successfully") -> None:
        """Set agent to done state."""
        self.status("DONE", status_text=summary)

    def message(self, text: str, target_agent_name: Optional[str] = None) -> None:
        """Display an observable speech bubble for the agent."""
        self._ensure_registered()
        payload = {"text": text}
        if target_agent_name is not None:
            payload["targetAgentName"] = target_agent_name
        self.viewer.emit(
            "agent.message.sent",
            f"{self.name}: {text[:60]}",
            payload,
            agent_id=self.id,
            source=f"agent:{self.id}",
        )

    def tool_started(
        self, tool: str, input_summary: Optional[str] = None, *, tool_call_id: Optional[str] = None
    ) -> None:
        """Report tool call start."""
        self._ensure_registered()
        payload = {"tool": tool}
        if input_summary is not None:
            payload["inputSummary"] = input_summary
        if tool_call_id is not None:
            payload["toolCallId"] = tool_call_id
        self.viewer.emit(
            "tool.started",
            f"Started {tool}: {input_summary}" if input_summary else f"Started tool {tool}",
            payload,
            agent_id=self.id,
            source=f"agent:{self.id}",
        )

    def tool_completed(
        self, tool: str, output_summary: Optional[str] = None, *, tool_call_id: Optional[str] = None
    ) -> None:
        """Report tool call completion."""
        self._ensure_registered()
        payload = {"tool": tool}
        if output_summary is not None:
            payload["outputSummary"] = output_summary
        if tool_call_id is not None:
            payload["toolCallId"] = tool_call_id
        self.viewer.emit(
            "tool.completed",
            f"Completed {tool}: {output_summary}" if output_summary else f"Completed tool {tool}",
            payload,
            agent_id=self.id,
            source=f"agent:{self.id}",
        )

    def tool_failed(
        self, tool: str, error_summary: Optional[str] = None, *, tool_call_id: Optional[str] = None
    ) -> None:
        """Report tool call failure."""
        self._ensure_registered()
        payload = {"tool": tool, "error": error_summary}
        if tool_call_id is not None:
            payload["toolCallId"] = tool_call_id
        self.viewer.emit(
            "tool.failed",
            f"Failed {tool}: {error_summary}" if error_summary else f"Failed tool {tool}",
            payload,
            agent_id=self.id,
            source=f"agent:{self.id}",
        )

    def usage(
        self,
        provider: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cached_tokens: Optional[int] = None,
        reasoning_tokens: Optional[int] = None,
        cost: Optional[float] = None,
        cost_source: Optional[str] = None,
        latency_ms: Optional[int] = None,
        request_id: Optional[str] = None,
        *,
        cache_read_tokens: Optional[int] = None,
        cache_write_tokens: Optional[int] = None,
        currency: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        parent_id: Optional[str] = None,
        tool_call_id: Optional[str] = None,
        meeting_id: Optional[str] = None,
        user_id: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
    ) -> None:
        """Report the token and cost usage of one model call, exactly as the caller knows it.

        A figure that is not given stays unknown: it is left out of the payload, never sent as 0.
        ``cost_source`` is never inferred. A cost given without it is sent as ``"unknown"`` and
        the client logs one warning. ``task_id`` goes to the envelope ``taskId``. ``trace_id``,
        ``parent_id``, ``tool_call_id``, ``meeting_id``, ``user_id`` and ``tags`` (issue #64) are validated
        locally with the same limits as the server and raise ``ValueError`` (or ``TypeError`` for a wrong
        type) naming the argument before anything is sent.
        """
        if cost_source is not None and cost_source not in COST_SOURCES:
            raise ValueError(
                f'costSource must be one of {", ".join(COST_SOURCES)} (got "{cost_source}")'
            )
        _validate_usage_correlation(trace_id, parent_id, tool_call_id, meeting_id, user_id, tags)
        if cost is not None and cost_source is None:
            self.viewer._warn_unstated_cost_source()
        self._ensure_registered()
        payload = {
            "provider": provider,
            "model": model,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "cachedTokens": cached_tokens,
            "cacheReadTokens": cache_read_tokens,
            "cacheWriteTokens": cache_write_tokens,
            "reasoningTokens": reasoning_tokens,
            "cost": cost,
            "costSource": cost_source if cost_source is not None else "unknown",
            "currency": currency,
            "latencyMs": latency_ms,
            "requestId": request_id,
        }
        payload.update(_correlation_payload(trace_id, parent_id, tool_call_id, meeting_id, user_id, tags))
        self.viewer.emit(
            "llm.usage",
            f"{provider}/{model} tokens ({input_tokens}+{output_tokens})",
            {k: v for k, v in payload.items() if v is not None},
            agent_id=self.id,
            source=f"agent:{self.id}",
            task_id=task_id,
        )

    def llm_failed(
        self,
        provider: str,
        model: Optional[str] = None,
        error_kind: Optional[str] = None,
        *,
        http_status: Optional[int] = None,
        retryable: Optional[bool] = None,
        request_id: Optional[str] = None,
        provider_error_code: Optional[str] = None,
        attempts: Optional[int] = None,
        latency_ms: Optional[int] = None,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        cache_read_tokens: Optional[int] = None,
        cache_write_tokens: Optional[int] = None,
        reasoning_tokens: Optional[int] = None,
        cost: Optional[float] = None,
        cost_source: Optional[str] = None,
        currency: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        parent_id: Optional[str] = None,
        tool_call_id: Optional[str] = None,
        meeting_id: Optional[str] = None,
        user_id: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
    ) -> None:
        """Report one failed model call attempt (issue #64). A figure that is not given stays unknown and
        is left out, never sent as 0. There is no free-text error field on purpose: provider messages can
        echo prompts or credentials. A retry that succeeds is reported as a separate ``usage()`` call.
        """
        if cost_source is not None and cost_source not in COST_SOURCES:
            raise ValueError(
                f'costSource must be one of {", ".join(COST_SOURCES)} (got "{cost_source}")'
            )
        _validate_usage_correlation(trace_id, parent_id, tool_call_id, meeting_id, user_id, tags)
        if cost is not None and cost_source is None:
            self.viewer._warn_unstated_cost_source()
        self._ensure_registered()
        payload = {
            "provider": provider,
            "model": model,
            "errorKind": error_kind,
            "httpStatus": http_status,
            "retryable": retryable,
            "requestId": request_id,
            "providerErrorCode": provider_error_code,
            "attempts": attempts,
            "latencyMs": latency_ms,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "cacheReadTokens": cache_read_tokens,
            "cacheWriteTokens": cache_write_tokens,
            "reasoningTokens": reasoning_tokens,
            "cost": cost,
            "costSource": cost_source if cost_source is not None else "unknown",
            "currency": currency,
        }
        payload.update(_correlation_payload(trace_id, parent_id, tool_call_id, meeting_id, user_id, tags))
        summary = f"{provider}/{model} call failed" if model else f"{provider} call failed"
        self.viewer.emit(
            "llm.failed",
            summary,
            {k: v for k, v in payload.items() if v is not None},
            agent_id=self.id,
            source=f"agent:{self.id}",
            task_id=task_id,
            severity="high",
        )


class AgentViewer:
    """Client for connecting any agent framework to Agent Viewer."""

    def __init__(
        self,
        url: Optional[str] = None,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        token: Optional[str] = None,
        runtime_id: Optional[str] = None,
        session_id: Optional[str] = None,
        source: Optional[str] = None,
        timeout: float = 10.0,
        max_retries: int = 3,
        auto_register: bool = True,
        debug: bool = False,
    ) -> None:
        target_url = url or base_url or "http://localhost:8787"
        self.url = target_url.rstrip("/")
        self.token = api_key or token
        self.runtime_id = runtime_id
        self.session_id = session_id
        self.source = source or (f"runtime:{runtime_id}" if runtime_id else "external-runtime")
        self.timeout = timeout
        self.max_retries = max_retries
        self.auto_register = auto_register
        self.debug = debug
        self._agents: Dict[str, AgentHandle] = {}
        self._warned_unstated_cost_source = False

    def _warn_unstated_cost_source(self) -> None:
        """Log, once per client, that a cost was sent without a stated source."""
        if not self._warned_unstated_cost_source:
            self._warned_unstated_cost_source = True
            logger.warning(_UNSTATED_COST_SOURCE_WARNING)

    def agent(
        self,
        id: str,
        name: Optional[str] = None,
        role_title: Optional[str] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        workspace: Optional[str] = None,
    ) -> AgentHandle:
        """Get or initialize an agent handle."""
        if id in self._agents:
            return self._agents[id]
        handle = AgentHandle(
            viewer=self,
            agent_id=id,
            name=name,
            role_title=role_title,
            provider=provider,
            model=model,
            workspace=workspace,
        )
        self._agents[id] = handle
        return handle

    def emit(
        self,
        event_type: str,
        summary: str,
        payload: Dict[str, Any],
        *,
        agent_id: Optional[str] = None,
        source: Optional[str] = None,
        target: Optional[str] = None,
        task_id: Optional[str] = None,
        severity: str = "normal",
        event_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Emit a single canonical event to the Agent Viewer API."""
        raw_event = {
            "schemaVersion": "1.0",
            "id": event_id or _default_event_id(),
            "type": event_type,
            "timestamp": int(time.time() * 1000),
            "runtimeId": self.runtime_id,
            "sessionId": self.session_id,
            "source": source or self.source,
            "target": target,
            "taskId": task_id,
            "agentId": agent_id,
            "severity": severity,
            "summary": summary,
            "payload": {k: v for k, v in payload.items() if v is not None} if isinstance(payload, dict) else payload,
        }
        event = {k: v for k, v in raw_event.items() if v is not None}
        return self._post_with_retry("/api/v1/events", event, idempotency_key=event["id"])

    def emit_batch(self, events: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Emit a batch of canonical events.

        Returns the server response. The server answers 202 even when some items were not applied, so
        read ``conflicts`` and each item's ``status`` in ``results``: ``"conflict"`` means the id was
        already stored with different content (``error == "conflicting_duplicate"``) and the item was dropped.
        """
        normalized_events = []
        for raw in events:
            evt = {
                "schemaVersion": "1.0",
                "id": raw.get("id") or _default_event_id(),
                "type": raw["type"],
                "timestamp": raw.get("timestamp") or int(time.time() * 1000),
                "runtimeId": raw.get("runtimeId") or self.runtime_id,
                "sessionId": raw.get("sessionId") or self.session_id,
                "source": raw.get("source") or self.source,
                "agentId": raw.get("agentId"),
                "taskId": raw.get("taskId"),
                "severity": raw.get("severity", "normal"),
                "summary": raw.get("summary", f"{raw['type']} event"),
                "payload": raw.get("payload", {}),
            }
            normalized_events.append(evt)
        return self._post_with_retry("/api/v1/events/batch", {"events": normalized_events})

    def heartbeat(self, active_agents_count: Optional[int] = None) -> None:
        """Send a runtime heartbeat event."""
        self.emit(
            "runtime.heartbeat",
            f"Heartbeat from {self.runtime_id or 'runtime'}",
            {
                "runtimeId": self.runtime_id,
                "status": "healthy",
                "activeAgentsCount": active_agents_count or len(self._agents),
            },
        )

    def health(self) -> Dict[str, Any]:
        """Check server health."""
        req = urllib.request.Request(f"{self.url}/health", headers=self._build_headers(), method="GET")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def snapshot(self) -> Dict[str, Any]:
        """Fetch current snapshot from the server."""
        req = urllib.request.Request(f"{self.url}/api/v1/snapshot", headers=self._build_headers(), method="GET")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def usage_summary(self) -> Dict[str, Any]:
        """Fetch the usage aggregates from ``GET /api/v1/usage``.

        The summary groups every ``llm.usage`` call by agent and by ``(provider, model)``, with failed calls
        (``llm.failed``) kept under ``failed``. A token ``sum`` may be ``None``: it means no call reported that
        kind, never zero; ``unreportedCount`` says how many calls left it out. Amounts are listed per currency
        and cost source in ``byCurrency`` and are never summed across them.
        """
        req = urllib.request.Request(f"{self.url}/api/v1/usage", headers=self._build_headers(), method="GET")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def list_calls(
        self,
        *,
        start: Optional[Union[int, str]] = None,
        end: Optional[Union[int, str]] = None,
        time_basis: Optional[str] = None,
        agent_id: Optional[Union[str, Sequence[str]]] = None,
        session_id: Optional[Union[str, Sequence[str]]] = None,
        runtime_id: Optional[Union[str, Sequence[str]]] = None,
        task_id: Optional[Union[str, Sequence[str]]] = None,
        provider: Optional[Union[str, Sequence[str]]] = None,
        model: Optional[Union[str, Sequence[str]]] = None,
        status: Optional[Union[str, Sequence[str]]] = None,
        cost_source: Optional[Union[str, Sequence[str]]] = None,
        currency: Optional[Union[str, Sequence[str]]] = None,
        request_id: Optional[Union[str, Sequence[str]]] = None,
        trace_id: Optional[str] = None,
        order: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Fetch one page of ``GET /api/v1/usage/calls`` (issue #67): read-only, metadata-only ledger rows
        (never prompt, completion, message or error text), with a stable, opaque cursor.

        ``start``/``end`` map to the server's ``from``/``to`` query parameters (``from`` is a reserved word in
        Python); both accept epoch milliseconds or an ISO 8601 date-time with an explicit offset, sent through
        unmodified, never reformatted. Every repeatable filter accepts one value or a sequence of values, sent
        as repeated query parameters (OR within the key, AND across keys). ``cursor`` is the opaque
        ``page["nextCursor"]`` of a previous page; use :meth:`iter_calls` to follow it automatically.

        Returns the raw response body (``schemaVersion``, ``asOf``, ``storage``, ``data``, ``page``). ``None``
        values in ``data`` are never defaulted to ``0``; nothing is summed or priced here.
        """
        params: List[Tuple[str, str]] = []
        if start is not None:
            params.append(("from", str(start)))
        if end is not None:
            params.append(("to", str(end)))
        if time_basis is not None:
            params.append(("timeBasis", time_basis))
        _append_repeatable(params, "agentId", agent_id)
        _append_repeatable(params, "sessionId", session_id)
        _append_repeatable(params, "runtimeId", runtime_id)
        _append_repeatable(params, "taskId", task_id)
        _append_repeatable(params, "provider", provider)
        _append_repeatable(params, "model", model)
        _append_repeatable(params, "status", status)
        _append_repeatable(params, "costSource", cost_source)
        _append_repeatable(params, "currency", currency)
        _append_repeatable(params, "requestId", request_id)
        if trace_id is not None:
            params.append(("traceId", trace_id))
        if order is not None:
            params.append(("order", order))
        if limit is not None:
            params.append(("limit", str(limit)))
        if cursor is not None:
            params.append(("cursor", cursor))

        query = urllib.parse.urlencode(params)
        endpoint = "/api/v1/usage/calls" + (f"?{query}" if query else "")
        return self._get_with_retry(endpoint)

    def iter_calls(self, **kwargs: Any) -> Iterator[Dict[str, Any]]:
        """Walks every page of :meth:`list_calls` by following ``page["nextCursor"]`` until ``hasMore`` is
        false, yielding one call record (a ``dict``) at a time. Accepts the same keyword arguments as
        :meth:`list_calls` except ``cursor``, which this method manages itself (an initial ``cursor`` may still
        be passed to resume a previous walk). Raises :class:`AgentViewerError` if the server ever returns the
        same cursor twice in a row, instead of looping forever.
        """
        cursor = kwargs.pop("cursor", None)
        while True:
            page = self.list_calls(cursor=cursor, **kwargs)
            for call in page.get("data", []):
                yield call
            page_info = page.get("page") or {}
            if not page_info.get("hasMore"):
                return
            next_cursor = page_info.get("nextCursor")
            if not next_cursor or next_cursor == cursor:
                raise AgentViewerError(
                    "Agent Viewer usage calls walk did not advance: the server returned the same cursor twice in a row."
                )
            cursor = next_cursor

    # Legacy method compatibility
    def register_agent(
        self,
        agent_id: str,
        name: str,
        role_title: str = "External Agent",
        provider: str = "Unknown",
        model: str = "Unknown",
    ) -> None:
        """Register an agent (legacy helper)."""
        handle = self.agent(agent_id, name=name, role_title=role_title, provider=provider, model=model)
        handle._ensure_registered()

    def agent_status(self, agent_id: str, status: str, workspace: Optional[str] = None) -> None:
        """Set agent status (legacy helper)."""
        self.agent(agent_id).status(status, workspace=workspace)

    def message(self, agent_id: str, text: str, target_agent_name: Optional[str] = None) -> None:
        """Send message (legacy helper)."""
        self.agent(agent_id).message(text, target_agent_name=target_agent_name)

    def llm_usage(
        self,
        agent_id: str,
        provider: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cached_tokens: Optional[int] = None,
        cost: Optional[float] = None,
        cost_source: Optional[str] = None,
        latency_ms: Optional[int] = None,
        *,
        reasoning_tokens: Optional[int] = None,
        cache_read_tokens: Optional[int] = None,
        cache_write_tokens: Optional[int] = None,
        request_id: Optional[str] = None,
        currency: Optional[str] = None,
        task_id: Optional[str] = None,
        trace_id: Optional[str] = None,
        parent_id: Optional[str] = None,
        tool_call_id: Optional[str] = None,
        meeting_id: Optional[str] = None,
        user_id: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
    ) -> None:
        """Report LLM usage (legacy helper). Same rules as ``AgentHandle.usage()``."""
        self.agent(agent_id).usage(
            provider=provider,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_tokens=cached_tokens,
            reasoning_tokens=reasoning_tokens,
            cost=cost,
            cost_source=cost_source,
            latency_ms=latency_ms,
            request_id=request_id,
            cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens,
            currency=currency,
            task_id=task_id,
            trace_id=trace_id,
            parent_id=parent_id,
            tool_call_id=tool_call_id,
            meeting_id=meeting_id,
            user_id=user_id,
            tags=tags,
        )

    def _build_headers(self, idempotency_key: Optional[str] = None) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        return headers

    def _post_with_retry(
        self,
        endpoint: str,
        body: Dict[str, Any],
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        data = json.dumps(body).encode("utf-8")
        headers = self._build_headers(idempotency_key)
        url = f"{self.url}{endpoint}"

        attempt = 0
        delay = 0.3

        while attempt <= self.max_retries:
            try:
                req = urllib.request.Request(url, data=data, headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    resp_bytes = resp.read()
                    return json.loads(resp_bytes.decode("utf-8")) if resp_bytes else {"ok": True}
            except urllib.error.HTTPError as err:
                error_body = err.read().decode("utf-8")
                issues = None
                code = None
                try:
                    parsed = json.loads(error_body)
                    issues = parsed.get("issues") or parsed.get("errors")
                    if isinstance(parsed.get("error"), str):
                        code = parsed["error"]
                except Exception:
                    pass

                # Client errors (4xx except 429) should fail immediately. A 409 conflicting_duplicate is final.
                if 400 <= err.code < 500 and err.code != 429:
                    raise AgentViewerError(f"Agent Viewer rejected event: {err.code} {error_body}", err.code, issues, code)

                attempt += 1
                if attempt > self.max_retries:
                    raise AgentViewerError(f"Agent Viewer request failed: {err.code} {error_body}", err.code, issues, code)

                time.sleep(delay + random.uniform(0, 0.1))
                delay = min(delay * 2, 5.0)
            except urllib.error.URLError as err:
                attempt += 1
                if attempt > self.max_retries:
                    raise AgentViewerError(f"Agent Viewer connection error: {err.reason}")
                time.sleep(delay + random.uniform(0, 0.1))
                delay = min(delay * 2, 5.0)

        raise AgentViewerError(f"Agent Viewer request failed after {self.max_retries} retries")

    def _get_with_retry(self, endpoint: str) -> Dict[str, Any]:
        """Shared GET helper (issue #67). ``snapshot()`` and ``usage_summary()`` predate it and keep their own
        direct ``urlopen`` call with no error mapping; a failed call to either raises a raw ``urllib.error``
        instead of :class:`AgentViewerError`. Sends the token only in the ``Authorization`` header, never in the
        URL. 400, 401 and 410 fail immediately; 429 and 5xx are retried with the same backoff as
        ``_post_with_retry``, since a GET is always safe to repeat.
        """
        url = f"{self.url}{endpoint}"
        headers = self._build_headers()

        attempt = 0
        delay = 0.3

        while attempt <= self.max_retries:
            try:
                req = urllib.request.Request(url, headers=headers, method="GET")
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    resp_bytes = resp.read()
                    return json.loads(resp_bytes.decode("utf-8")) if resp_bytes else {}
            except urllib.error.HTTPError as err:
                error_body = err.read().decode("utf-8")
                issues = None
                code = None
                try:
                    parsed = json.loads(error_body)
                    issues = parsed.get("issues") or parsed.get("errors")
                    if isinstance(parsed.get("error"), str):
                        code = parsed["error"]
                except Exception:
                    pass

                # Client errors (4xx except 429) fail immediately: 400 invalid_filter/invalid_cursor/cursor_mismatch,
                # 401 unauthorized and 410 cursor_expired are all final, never retried.
                if 400 <= err.code < 500 and err.code != 429:
                    raise AgentViewerError(f"Agent Viewer rejected request: {err.code} {error_body}", err.code, issues, code)

                attempt += 1
                if attempt > self.max_retries:
                    raise AgentViewerError(f"Agent Viewer request failed: {err.code} {error_body}", err.code, issues, code)

                time.sleep(delay + random.uniform(0, 0.1))
                delay = min(delay * 2, 5.0)
            except urllib.error.URLError as err:
                attempt += 1
                if attempt > self.max_retries:
                    raise AgentViewerError(f"Agent Viewer connection error: {err.reason}")
                time.sleep(delay + random.uniform(0, 0.1))
                delay = min(delay * 2, 5.0)

        raise AgentViewerError(f"Agent Viewer request failed after {self.max_retries} retries")


# Backward compatibility alias
AgentViewerClient = AgentViewer
