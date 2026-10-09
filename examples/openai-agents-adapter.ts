/**
 * OpenAI Agents SDK / Swarm Adapter for Agent Viewer
 *
 * Connects OpenAI agent runs, function tools, and handoffs
 * to the Agent Viewer virtual office observability layer.
 */

import { AgentViewer, type CostSource } from '../sdk/typescript/index';

export class OpenAIAgentsViewerAdapter {
  private viewer: AgentViewer;
  private currentAgentId: string;

  constructor(options: {
    url?: string;
    apiKey?: string;
    runtimeId?: string;
    initialAgentId?: string;
  } = {}) {
    this.viewer = new AgentViewer({
      url: options.url ?? process.env.AGENT_VIEWER_URL ?? 'http://localhost:8787',
      apiKey: options.apiKey ?? process.env.AGENT_VIEWER_API_TOKEN ?? process.env.AGENT_VIEWER_API_KEY,
      runtimeId: options.runtimeId ?? 'openai-agents-runtime',
      source: 'runtime:openai-agents',
    });
    this.currentAgentId = options.initialAgentId ?? 'assistant';
  }

  /**
   * Called when an agent begins execution.
   */
  async onAgentStart(agent: { id?: string; name: string; instructions?: string; model?: string }): Promise<void> {
    const id = agent.id ?? agent.name.toLowerCase().replace(/\s+/g, '-');
    this.currentAgentId = id;
    const handle = this.viewer.agent({
      id,
      name: agent.name,
      model: agent.model ?? 'gpt-4o',
      provider: 'OpenAI',
      workspace: 'development',
    });
    await handle.thinking(`Processing user request`);
  }

  /**
   * Called when an agent hands off execution to another agent.
   */
  async onHandoff(fromAgentName: string, toAgentName: string, reason?: string): Promise<void> {
    const fromId = fromAgentName.toLowerCase().replace(/\s+/g, '-');
    const toId = toAgentName.toLowerCase().replace(/\s+/g, '-');

    const fromAgent = this.viewer.agent(fromId);
    await fromAgent.message(`Transferring control to ${toAgentName}${reason ? `: ${reason}` : ''}`, toAgentName);
    await fromAgent.idle('Handoff complete');

    const toAgent = this.viewer.agent(toId);
    this.currentAgentId = toId;
    await toAgent.thinking(`Taking over conversation`);
  }

  /**
   * Called when the agent invokes a tool/function. `callId` is the Agents SDK function tool call id
   * (`FunctionToolCall.call_id` in the OpenAI Agents SDK), never invented when the framework omits it.
   */
  async onToolCall(toolName: string, argsSummary?: string, callId?: string): Promise<void> {
    const agent = this.viewer.agent(this.currentAgentId);
    await agent.toolStarted(toolName, argsSummary, { toolCallId: callId });
  }

  /**
   * Called when a tool returns output. Same `call_id` as `onToolCall` for the matching call.
   */
  async onToolResult(toolName: string, outputSummary?: string, callId?: string): Promise<void> {
    const agent = this.viewer.agent(this.currentAgentId);
    await agent.toolCompleted(toolName, outputSummary, { toolCallId: callId });
  }

  /**
   * Called when tool fails. Same `call_id` as `onToolCall` for the matching call.
   */
  async onToolError(toolName: string, error: string, callId?: string): Promise<void> {
    const agent = this.viewer.agent(this.currentAgentId);
    await agent.toolFailed(toolName, error, { toolCallId: callId });
  }

  /**
   * Called when the agent produces a message to the user.
   */
  async onMessage(text: string): Promise<void> {
    const agent = this.viewer.agent(this.currentAgentId);
    await agent.message(text);
  }

  /**
   * Called when usage tokens are reported by OpenAI API response.
   *
   * `costSource` says where `totalCost` comes from and defaults to `unknown`: pass
   * `provider-reported` only when the provider returned the cost, or `estimated` when the
   * host app computed it. A `totalCost` of 0 is a real cost and is kept.
   *
   * `traceId` is the Agents SDK run trace id (`trace_...`, see the Agents SDK tracing docs) and
   * `parentId` the parent span id in the same trace; both are forwarded only when the host passes them,
   * never invented. `toolCallId` is forwarded here only when the usage was itself produced inside a tool
   * call (a sub-agent run started by a tool), not the id of a tool the model is about to call. `tags` is
   * never read from the framework's own metadata (unbounded, can carry prompt text): it is only ever an
   * explicit value the host chooses to pass.
   */
  async onUsage(usage: {
    promptTokens: number;
    completionTokens: number;
    model?: string;
    totalCost?: number | null;
    costSource?: CostSource;
    traceId?: string;
    parentId?: string;
    toolCallId?: string;
    tags?: readonly string[];
  }): Promise<void> {
    const agent = this.viewer.agent(this.currentAgentId);
    await agent.usage({
      provider: 'OpenAI',
      model: usage.model ?? 'gpt-4o',
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      cost: usage.totalCost ?? null,
      costSource: usage.costSource ?? 'unknown',
      traceId: usage.traceId,
      parentId: usage.parentId,
      toolCallId: usage.toolCallId,
      tags: usage.tags,
    });
  }

  /**
   * Called when agent finishes execution.
   */
  async onDone(summary = 'Run completed'): Promise<void> {
    const agent = this.viewer.agent(this.currentAgentId);
    await agent.done(summary);
  }
}

export default OpenAIAgentsViewerAdapter;
