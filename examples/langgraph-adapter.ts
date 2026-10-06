/**
 * LangGraph Adapter for Agent Viewer
 *
 * Demonstrates hooking LangGraph node and tool execution lifecycle callbacks
 * into Agent Viewer without leaking chain-of-thought or internal scratchpads.
 */

import { AgentViewer } from '../sdk/typescript/index';

const viewer = new AgentViewer({
  url: process.env.AGENT_VIEWER_URL ?? 'http://localhost:8787',
  apiKey: process.env.AGENT_VIEWER_API_KEY ?? process.env.AGENT_VIEWER_API_TOKEN,
  runtimeId: 'langgraph-runtime',
  source: 'runtime:langgraph',
});

export interface LangGraphNodeContext {
  nodeName: string;
  agentId?: string;
  taskId?: string;
}

export class LangGraphViewerAdapter {
  private agentCache = new Map<string, ReturnType<typeof viewer.agent>>();

  private getAgent(id: string, name?: string) {
    if (!this.agentCache.has(id)) {
      this.agentCache.set(id, viewer.agent({ id, name: name ?? id, workspace: 'development' }));
    }
    return this.agentCache.get(id)!;
  }

  /**
   * Invoked when a LangGraph node starts execution.
   */
  async onNodeStart(nodeName: string, meta?: { agentId?: string; roleTitle?: string }): Promise<void> {
    const agentId = meta?.agentId ?? nodeName;
    const agent = this.getAgent(agentId, nodeName);
    await agent.thinking(`Processing workflow step: ${nodeName}`);
  }

  /**
   * Invoked when a tool call starts inside a LangGraph node.
   */
  async onToolStart(nodeName: string, toolName: string, inputSummary?: string): Promise<void> {
    const agent = this.getAgent(nodeName);
    await agent.toolStarted(toolName, inputSummary);
  }

  /**
   * Invoked when a tool call finishes.
   */
  async onToolEnd(nodeName: string, toolName: string, outputSummary?: string): Promise<void> {
    const agent = this.getAgent(nodeName);
    await agent.toolCompleted(toolName, outputSummary);
  }

  /**
   * Invoked when a tool call encounters an error.
   */
  async onToolError(nodeName: string, toolName: string, error: string): Promise<void> {
    const agent = this.getAgent(nodeName);
    await agent.toolFailed(toolName, error);
  }

  /**
   * Invoked when a node generates a message intended for user or team visibility.
   */
  async onVisibleMessage(nodeName: string, messageText: string, targetAgent?: string): Promise<void> {
    const agent = this.getAgent(nodeName);
    await agent.message(messageText, targetAgent);
  }

  /**
   * Invoked on LLM model response to report token telemetry.
   */
  async onModelUsage(
    nodeName: string,
    usage: {
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
      latencyMs?: number;
      cost?: number | null;
    }
  ): Promise<void> {
    const agent = this.getAgent(nodeName);
    await agent.usage({
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      latencyMs: usage.latencyMs,
      cost: usage.cost ?? null,
      costSource: usage.cost !== undefined && usage.cost !== null ? 'provider-reported' : 'unknown',
    });
  }

  /**
   * Invoked when node finishes work.
   */
  async onNodeComplete(nodeName: string, finalStatus = 'Task step complete'): Promise<void> {
    const agent = this.getAgent(nodeName);
    await agent.done(finalStatus);
  }
}

export default LangGraphViewerAdapter;
