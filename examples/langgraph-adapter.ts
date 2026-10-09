/**
 * LangGraph Adapter for Agent Viewer
 *
 * Demonstrates hooking LangGraph node and tool execution lifecycle callbacks
 * into Agent Viewer without leaking chain-of-thought or internal scratchpads.
 */

import { AgentViewer, type CostSource } from '../sdk/typescript/index';

const viewer = new AgentViewer({
  url: process.env.AGENT_VIEWER_URL ?? 'http://localhost:8787',
  apiKey: process.env.AGENT_VIEWER_API_TOKEN ?? process.env.AGENT_VIEWER_API_KEY,
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
   * Invoked when a tool call starts inside a LangGraph node. `toolCallId` is the LangChain tool
   * message's `tool_call.id` (the id LangGraph uses to pair a `ToolMessage` with the `AIMessage` that
   * requested it), never invented when the callback does not carry one.
   */
  async onToolStart(nodeName: string, toolName: string, inputSummary?: string, toolCallId?: string): Promise<void> {
    const agent = this.getAgent(nodeName);
    await agent.toolStarted(toolName, inputSummary, { toolCallId });
  }

  /**
   * Invoked when a tool call finishes. Same `tool_call.id` as `onToolStart` for the matching call.
   */
  async onToolEnd(nodeName: string, toolName: string, outputSummary?: string, toolCallId?: string): Promise<void> {
    const agent = this.getAgent(nodeName);
    await agent.toolCompleted(toolName, outputSummary, { toolCallId });
  }

  /**
   * Invoked when a tool call encounters an error. Same `tool_call.id` as `onToolStart` for the matching call.
   */
  async onToolError(nodeName: string, toolName: string, error: string, toolCallId?: string): Promise<void> {
    const agent = this.getAgent(nodeName);
    await agent.toolFailed(toolName, error, { toolCallId });
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
   *
   * `costSource` says where `cost` comes from and defaults to `unknown`: pass
   * `provider-reported` only when the provider returned the cost, or `estimated` when the
   * host app computed it. A missing cache count stays unknown, and a cost of 0 is kept.
   *
   * `traceId` is the LangGraph root run id (the top-level `run_id` from the callback manager) and
   * `parentId` is the callback's own `parentRunId`; both are forwarded only when the host passes them.
   * `toolCallId` is forwarded here only when this model call happened inside a tool's execution (a
   * sub-agent run started by a tool), not the id of a tool call the model is about to make. `tags` is
   * never read from LangGraph's own run tags or metadata (unbounded, can carry prompt text): it is only
   * ever an explicit value the host chooses to pass.
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
      costSource?: CostSource;
      traceId?: string;
      parentId?: string;
      toolCallId?: string;
      tags?: readonly string[];
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
      costSource: usage.costSource ?? 'unknown',
      traceId: usage.traceId,
      parentId: usage.parentId,
      toolCallId: usage.toolCallId,
      tags: usage.tags,
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
