"""CrewAI Adapter for Agent Viewer.

Visualizes CrewAI multi-agent crews in Agent Viewer:
- Agent registration with role & backstory summaries
- Task assignments and status updates
- Tool usage callbacks
- Visible conversation messages
- LLM token telemetry
"""

from __future__ import annotations

import os
import sys
from typing import Any, Dict, Optional

# Add project root to path for local imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from sdk.python.agent_viewer import AgentViewer


class CrewAIViewerAdapter:
    """Adapter bridging CrewAI callbacks with Agent Viewer."""

    def __init__(
        self,
        url: Optional[str] = None,
        api_key: Optional[str] = None,
        crew_name: str = "crewai-production",
    ) -> None:
        self.viewer = AgentViewer(
            url=url or os.getenv("AGENT_VIEWER_URL", "http://localhost:8787"),
            api_key=api_key or os.getenv("AGENT_VIEWER_API_TOKEN") or os.getenv("AGENT_VIEWER_API_KEY"),
            runtime_id=crew_name,
            source=f"runtime:{crew_name}",
        )
        self.agents = {}

    def register_crew_agent(
        self,
        agent_id: str,
        role: str,
        goal: str,
        model: str = "gpt-4o",
        provider: str = "OpenAI",
    ) -> None:
        """Register a CrewAI agent with its role."""
        workspace = "research_area" if "research" in role.lower() else "development"
        handle = self.viewer.agent(
            id=agent_id,
            name=role,
            role_title=role,
            provider=provider,
            model=model,
            workspace=workspace,
        )
        self.agents[agent_id] = handle
        handle.idle(f"Ready: {goal[:50]}")

    def on_task_start(self, agent_id: str, task_description: str) -> None:
        """Called when agent starts working on a task."""
        handle = self.agents.get(agent_id) or self.viewer.agent(agent_id)
        handle.thinking(f"Working on task: {task_description[:60]}")

    def on_step_action(self, agent_id: str, action_summary: str) -> None:
        """Called on intermediate actions."""
        handle = self.agents.get(agent_id) or self.viewer.agent(agent_id)
        handle.status("CODING" if "code" in action_summary.lower() else "RESEARCHING", action_summary)

    def on_tool_start(
        self, agent_id: str, tool_name: str, tool_input: Optional[str] = None, tool_call_id: Optional[str] = None
    ) -> None:
        """Called when a tool execution starts. CrewAI does not expose a tool call id at this callback, so
        ``tool_call_id`` is omitted unless the caller explicitly passes one.
        """
        handle = self.agents.get(agent_id) or self.viewer.agent(agent_id)
        handle.tool_started(tool_name, tool_input, tool_call_id=tool_call_id)

    def on_tool_end(
        self, agent_id: str, tool_name: str, tool_output: Optional[str] = None, tool_call_id: Optional[str] = None
    ) -> None:
        """Called when a tool execution finishes. Same note as ``on_tool_start`` about ``tool_call_id``."""
        handle = self.agents.get(agent_id) or self.viewer.agent(agent_id)
        handle.tool_completed(tool_name, tool_output, tool_call_id=tool_call_id)

    def on_agent_message(self, agent_id: str, text: str, target: Optional[str] = None) -> None:
        """Display an observable dialogue line between agents or to the user."""
        handle = self.agents.get(agent_id) or self.viewer.agent(agent_id)
        handle.message(text, target_agent_name=target)

    def on_token_usage(
        self,
        agent_id: str,
        provider: str,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cost: Optional[float] = None,
        cost_source: str = "unknown",
        trace_id: Optional[str] = None,
        tool_call_id: Optional[str] = None,
        tags: Optional[list] = None,
    ) -> None:
        """Report token telemetry.

        ``cost_source`` says where ``cost`` comes from and defaults to ``"unknown"``: pass
        ``"provider-reported"`` only when the provider returned the cost, or ``"estimated"``
        when the host app computed it. A cost of 0 is a real cost and is kept.

        CrewAI exposes no run, trace or parent span id at this callback, so ``trace_id`` and
        ``tool_call_id`` are forwarded only when the caller explicitly passes one, and no ``parent_id`` is
        ever sent. ``tags`` is never read from CrewAI's own metadata: it is only ever an explicit value the
        host chooses to pass.
        """
        handle = self.agents.get(agent_id) or self.viewer.agent(agent_id)
        handle.usage(
            provider=provider,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost=cost,
            cost_source=cost_source,
            trace_id=trace_id,
            tool_call_id=tool_call_id,
            tags=tags,
        )

    def on_task_complete(self, agent_id: str, summary: str = "Task finished") -> None:
        """Called when the task concludes."""
        handle = self.agents.get(agent_id) or self.viewer.agent(agent_id)
        handle.done(summary)
