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
            api_key=api_key or os.getenv("AGENT_VIEWER_API_KEY"),
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

    def on_tool_start(self, agent_id: str, tool_name: str, tool_input: Optional[str] = None) -> None:
        """Called when a tool execution starts."""
        handle = self.agents.get(agent_id) or self.viewer.agent(agent_id)
        handle.tool_started(tool_name, tool_input)

    def on_tool_end(self, agent_id: str, tool_name: str, tool_output: Optional[str] = None) -> None:
        """Called when a tool execution finishes."""
        handle = self.agents.get(agent_id) or self.viewer.agent(agent_id)
        handle.tool_completed(tool_name, tool_output)

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
    ) -> None:
        """Report token telemetry."""
        handle = self.agents.get(agent_id) or self.viewer.agent(agent_id)
        handle.usage(
            provider=provider,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cost=cost,
            cost_source="provider-reported" if cost is not None else "unknown",
        )

    def on_task_complete(self, agent_id: str, summary: str = "Task finished") -> None:
        """Called when the task concludes."""
        handle = self.agents.get(agent_id) or self.viewer.agent(agent_id)
        handle.done(summary)
