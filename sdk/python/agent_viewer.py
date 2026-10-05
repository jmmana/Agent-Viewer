import json
import time
import urllib.request
import uuid
from typing import Any, Dict, Optional


class AgentViewerClient:
    def __init__(self, base_url: str, token: Optional[str] = None, source: str = "external-runtime"):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.source = source

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
    ) -> None:
        event = {
            "schemaVersion": "1.0",
            "id": f"evt_{uuid.uuid4().hex}",
            "type": event_type,
            "timestamp": int(time.time() * 1000),
            "source": source or self.source,
            "target": target,
            "taskId": task_id,
            "agentId": agent_id,
            "severity": "normal",
            "summary": summary,
            "payload": payload,
        }
        body = json.dumps(event).encode("utf-8")
        headers = {"content-type": "application/json"}
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"

        request = urllib.request.Request(
            f"{self.base_url}/api/v1/events",
            data=body,
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status >= 300:
                raise RuntimeError(f"Agent Viewer rejected event: {response.status}")

    def register_agent(
        self,
        agent_id: str,
        name: str,
        role_title: str = "External Agent",
        provider: str = "Unknown",
        model: str = "Unknown",
    ) -> None:
        self.emit(
            "agent.registered",
            f"Registered {name}",
            {
                "id": agent_id,
                "name": name,
                "roleTitle": role_title,
                "provider": provider,
                "model": model,
            },
            agent_id=agent_id,
            source=f"agent:{agent_id}",
        )

    def agent_status(self, agent_id: str, status: str, workspace: Optional[str] = None) -> None:
        payload: Dict[str, Any] = {"status": status}
        if workspace:
            payload["workspace"] = workspace
        self.emit(
            "agent.status.changed",
            f"{agent_id} -> {status}",
            payload,
            agent_id=agent_id,
            source=f"agent:{agent_id}",
        )

    def message(self, agent_id: str, text: str, target_agent_name: Optional[str] = None) -> None:
        self.emit(
            "message.sent",
            f"{agent_id} sent a visible message",
            {"text": text, "targetAgentName": target_agent_name},
            agent_id=agent_id,
            source=f"agent:{agent_id}",
        )

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
        self.emit(
            "llm.usage",
            f"{provider}/{model} usage reported",
            {
                "provider": provider,
                "model": model,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "cachedTokens": cached_tokens,
                "cost": cost,
                "costSource": cost_source,
                "latencyMs": latency_ms,
            },
            agent_id=agent_id,
            source=f"agent:{agent_id}",
        )
