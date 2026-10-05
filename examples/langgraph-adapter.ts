import { AgentViewerClient } from '../sdk/typescript/index';

const viewer = new AgentViewerClient({
  baseUrl: process.env.AGENT_VIEWER_URL ?? 'http://localhost:8787',
  token: process.env.AGENT_VIEWER_API_TOKEN,
  source: 'langgraph',
});

// Map your graph callbacks to observable Agent Viewer events.
// This example intentionally visualizes statuses and outputs, not private chain-of-thought.
export async function onNodeStart(nodeName: string) {
  await viewer.status(nodeName, 'THINKING');
}

export async function onToolStart(nodeName: string, toolName: string) {
  await viewer.emit({
    type: 'tool.started',
    source: `agent:${nodeName}`,
    agentId: nodeName,
    summary: `${nodeName} started ${toolName}`,
    payload: { tool: toolName },
  });
}

export async function onModelUsage(
  nodeName: string,
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
) {
  await viewer.llmUsage(nodeName, {
    provider,
    model,
    inputTokens,
    outputTokens,
    costSource: 'unknown',
  });
}
