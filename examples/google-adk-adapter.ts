/**
 * Google ADK (Agent Development Kit / Gemini API) Adapter for Agent Viewer
 *
 * Visualizes Google GenAI / Gemini-based agents, function calls, and token telemetry
 * in Agent Viewer.
 */

import { AgentViewer } from '../sdk/typescript/index';

export class GoogleADKViewerAdapter {
  private viewer: AgentViewer;

  constructor(options: {
    url?: string;
    apiKey?: string;
    runtimeId?: string;
  } = {}) {
    this.viewer = new AgentViewer({
      url: options.url ?? process.env.AGENT_VIEWER_URL ?? 'http://localhost:8787',
      apiKey: options.apiKey ?? process.env.AGENT_VIEWER_API_TOKEN ?? process.env.AGENT_VIEWER_API_KEY,
      runtimeId: options.runtimeId ?? 'google-adk-runtime',
      source: 'runtime:google-adk',
    });
  }

  /**
   * Registers a Gemini agent in the virtual office.
   */
  async registerAgent(agentId: string, name: string, model = 'gemini-2.5-pro'): Promise<void> {
    const handle = this.viewer.agent({
      id: agentId,
      name,
      provider: 'Google',
      model,
      roleTitle: 'Gemini Agent',
      workspace: 'research_area',
    });
    await handle.idle('Ready for prompts');
  }

  /**
   * Called when Gemini begins processing a prompt or turn.
   */
  async onPromptStart(agentId: string, promptSummary: string): Promise<void> {
    const agent = this.viewer.agent(agentId);
    await agent.thinking(`Processing: ${promptSummary.slice(0, 50)}`);
  }

  /**
   * Called when a Gemini function call / tool is invoked. `callId` is the ADK function call's `id`
   * (`genai.types.FunctionCall.id` in the Google GenAI SDK), never invented when it is absent.
   */
  async onFunctionCall(agentId: string, functionName: string, argsSummary?: string, callId?: string): Promise<void> {
    const agent = this.viewer.agent(agentId);
    await agent.toolStarted(functionName, argsSummary, { toolCallId: callId });
  }

  /**
   * Called when function call result is provided back to Gemini. Same function call `id` as
   * `onFunctionCall` for the matching call.
   */
  async onFunctionResponse(agentId: string, functionName: string, resultSummary?: string, callId?: string): Promise<void> {
    const agent = this.viewer.agent(agentId);
    await agent.toolCompleted(functionName, resultSummary, { toolCallId: callId });
  }

  /**
   * Called when Gemini emits a text response for the user.
   */
  async onModelResponse(agentId: string, text: string): Promise<void> {
    const agent = this.viewer.agent(agentId);
    await agent.message(text);
  }

  /**
   * Called when GenAI usageMetadata is received.
   *
   * `costEstimate` is a cost the host app estimated from its own price list (Gemini responses
   * carry no cost), so it is always sent as `estimated`. Leave it out when the host does not
   * estimate cost. The counts are forwarded as reported: a missing cache count stays unknown,
   * and a call without both prompt and candidate counts is not reported, because the contract
   * requires them and the adapter never fills them with 0.
   *
   * `traceId` is the ADK `invocation_id` (the id ADK assigns to one `run_async` invocation), forwarded
   * only when the host passes it. ADK does not expose a parent span id at this layer, so `parentId` is
   * never sent by this adapter. `toolCallId` is forwarded here only when this usage was itself produced
   * inside a function call's execution, not the id of a function Gemini is about to call. `tags` is never
   * read from ADK's own session state or metadata (unbounded, can carry prompt text): it is only ever an
   * explicit value the host chooses to pass.
   */
  async onUsageMetadata(
    agentId: string,
    metadata: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      cachedContentTokenCount?: number;
      model?: string;
      costEstimate?: number | null;
      traceId?: string;
      toolCallId?: string;
      tags?: readonly string[];
    }
  ): Promise<void> {
    if (metadata.promptTokenCount === undefined || metadata.candidatesTokenCount === undefined) return;
    const agent = this.viewer.agent(agentId);
    const cost = metadata.costEstimate ?? null;
    await agent.usage({
      provider: 'Google',
      model: metadata.model ?? 'gemini-2.5-pro',
      inputTokens: metadata.promptTokenCount,
      outputTokens: metadata.candidatesTokenCount,
      cachedTokens: metadata.cachedContentTokenCount,
      cost,
      costSource: cost !== null ? 'estimated' : 'unknown',
      traceId: metadata.traceId,
      toolCallId: metadata.toolCallId,
      tags: metadata.tags,
    });
  }

  /**
   * Called when turn completes.
   */
  async onTurnComplete(agentId: string): Promise<void> {
    const agent = this.viewer.agent(agentId);
    await agent.done('Turn completed');
  }
}

export default GoogleADKViewerAdapter;
