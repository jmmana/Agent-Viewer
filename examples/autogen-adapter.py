"""AutoGen Adapter for Agent Viewer.

Integrates Microsoft AutoGen ConversableAgent and GroupChat workflows with Agent Viewer:
- Agent registration
- Inter-agent conversation message mapping
- Tool execution mapping
- Token usage tracking
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, Optional

# Add project root to path for local imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from sdk.python.agent_viewer import AgentViewer


class AutoGenViewerAdapter:
    """Hooks into AutoGen conversation loops to visualize activity."""

    def __init__(
        self,
        url: Optional[str] = None,
        api_key: Optional[str] = None,
        chat_name: str = "autogen-groupchat",
    ) -> None:
        self.viewer = AgentViewer(
            url=url or os.getenv("AGENT_VIEWER_URL", "http://localhost:8787"),
            api_key=api_key or os.getenv("AGENT_VIEWER_API_TOKEN") or os.getenv("AGENT_VIEWER_API_KEY"),
            runtime_id=chat_name,
            source=f"runtime:{chat_name}",
        )
        self.registered_agents = set()

    def ensure_agent(self, agent_name: str, system_message: Optional[str] = None) -> None:
        if agent_name not in self.registered_agents:
            workspace = "leads_area" if "manager" in agent_name.lower() or "admin" in agent_name.lower() else "development"
            agent = self.viewer.agent(
                id=agent_name,
                name=agent_name,
                role_title=agent_name.replace("_", " ").title(),
                workspace=workspace,
            )
            agent.idle(f"Ready: {(system_message or '')[:40]}")
            self.registered_agents.add(agent_name)

    def on_message_sent(self, sender_name: str, recipient_name: str, content: str) -> None:
        """Called when one agent sends a message to another in GroupChat."""
        self.ensure_agent(sender_name)
        self.ensure_agent(recipient_name)

        sender = self.viewer.agent(sender_name)
        # Display observable message bubble
        sender.message(content, target_agent_name=recipient_name)

    def on_function_call(self, agent_name: str, function_name: str, arguments_summary: Optional[str] = None) -> None:
        """Called when an agent invokes a function/tool."""
        self.ensure_agent(agent_name)
        agent = self.viewer.agent(agent_name)
        agent.tool_started(function_name, arguments_summary)

    def on_function_return(self, agent_name: str, function_name: str, result_summary: Optional[str] = None) -> None:
        """Called when function returns result."""
        self.ensure_agent(agent_name)
        agent = self.viewer.agent(agent_name)
        agent.tool_completed(function_name, result_summary)

    def on_llm_response(
        self,
        agent_name: str,
        provider: str,
        model: str,
        prompt_tokens: int,
        completion_tokens: int,
    ) -> None:
        """Called when LLM completes generation."""
        self.ensure_agent(agent_name)
        agent = self.viewer.agent(agent_name)
        agent.usage(
            provider=provider,
            model=model,
            input_tokens=prompt_tokens,
            output_tokens=completion_tokens,
            cost=None,
            cost_source="unknown",
        )
