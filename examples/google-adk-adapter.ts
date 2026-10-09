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
   * Called when a Gemini function call / tool is invoked.
   */
  async onFunctionCall(agentId: string, functionName: string, argsSummary?: string): Promise<void> {
    const agent = this.viewer.agent(agentId);
    await agent.toolStarted(functionName, argsSummary);
  }

  /**
   * Called when function call result is provided back to Gemini.
   */
  async onFunctionResponse(agentId: string, functionName: string, resultSummary?: string): Promise<void> {
    const agent = this.viewer.agent(agentId);
    await agent.toolCompleted(functionName, resultSummary);
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
   */
  async onUsageMetadata(
    agentId: string,
    metadata: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      cachedContentTokenCount?: number;
      model?: string;
      costEstimate?: number | null;
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
