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
import urllib.request
import uuid
from typing import Any, Dict, List, Optional, Union

logger = logging.getLogger("agent_viewer")


class AgentViewerError(Exception):
    """Exception raised by Agent Viewer API client."""

    def __init__(self, message: str, status_code: Optional[int] = None, issues: Optional[List[Dict[str, Any]]] = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.issues = issues


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

    def tool_started(self, tool: str, input_summary: Optional[str] = None) -> None:
        """Report tool call start."""
        self._ensure_registered()
        payload = {"tool": tool}
        if input_summary is not None:
            payload["inputSummary"] = input_summary
        self.viewer.emit(
            "tool.started",
            f"Started {tool}: {input_summary}" if input_summary else f"Started tool {tool}",
            payload,
            agent_id=self.id,
            source=f"agent:{self.id}",
        )

    def tool_completed(self, tool: str, output_summary: Optional[str] = None) -> None:
        """Report tool call completion."""
        self._ensure_registered()
        payload = {"tool": tool}
        if output_summary is not None:
            payload["outputSummary"] = output_summary
        self.viewer.emit(
            "tool.completed",
            f"Completed {tool}: {output_summary}" if output_summary else f"Completed tool {tool}",
            payload,
            agent_id=self.id,
            source=f"agent:{self.id}",
        )

    def tool_failed(self, tool: str, error_summary: Optional[str] = None) -> None:
        """Report tool call failure."""
        self._ensure_registered()
        self.viewer.emit(
            "tool.failed",
            f"Failed {tool}: {error_summary}" if error_summary else f"Failed tool {tool}",
            {"tool": tool, "error": error_summary},
            agent_id=self.id,
            source=f"agent:{self.id}",
        )

    def usage(
        self,
        provider: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cached_tokens: int = 0,
        reasoning_tokens: int = 0,
        cost: Optional[float] = None,
        cost_source: Optional[str] = None,
        latency_ms: Optional[int] = None,
        request_id: Optional[str] = None,
    ) -> None:
        """Report token and cost usage."""
        self._ensure_registered()
        resolved_cost_source = cost_source or ("provider-reported" if cost is not None else "unknown")
        payload = {
            "provider": provider,
            "model": model,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "cachedTokens": cached_tokens,
            "reasoningTokens": reasoning_tokens,
            "cost": cost,
            "costSource": resolved_cost_source,
            "latencyMs": latency_ms,
            "requestId": request_id,
        }
        self.viewer.emit(
            "llm.usage",
            f"{provider}/{model} tokens ({input_tokens}+{output_tokens})",
            {k: v for k, v in payload.items() if v is not None},
            agent_id=self.id,
            source=f"agent:{self.id}",
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
            "id": event_id or f"evt_{uuid.uuid4().hex[:12]}",
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
        """Emit a batch of canonical events."""
        normalized_events = []
        for raw in events:
            evt = {
                "schemaVersion": "1.0",
                "id": raw.get("id") or f"evt_{uuid.uuid4().hex[:12]}",
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
        cached_tokens: int = 0,
        cost: Optional[float] = None,
        cost_source: str = "unknown",
        latency_ms: Optional[int] = None,
    ) -> None:
        """Report LLM usage (legacy helper)."""
        self.agent(agent_id).usage(
            provider=provider,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_tokens=cached_tokens,
            cost=cost,
            cost_source=cost_source,
            latency_ms=latency_ms,
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
                try:
                    parsed = json.loads(error_body)
                    issues = parsed.get("issues") or parsed.get("errors")
                except Exception:
                    pass

                # Client errors (4xx except 429) should fail immediately
                if 400 <= err.code < 500 and err.code != 429:
                    raise AgentViewerError(f"Agent Viewer rejected event: {err.code} {error_body}", err.code, issues)

                attempt += 1
                if attempt > self.max_retries:
                    raise AgentViewerError(f"Agent Viewer request failed: {err.code} {error_body}", err.code, issues)

                time.sleep(delay + random.uniform(0, 0.1))
                delay = min(delay * 2, 5.0)
            except urllib.error.URLError as err:
                attempt += 1
                if attempt > self.max_retries:
                    raise AgentViewerError(f"Agent Viewer connection error: {err.reason}")
                time.sleep(delay + random.uniform(0, 0.1))
                delay = min(delay * 2, 5.0)


# Backward compatibility alias
AgentViewerClient = AgentViewer
