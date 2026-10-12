/**
 * Minimal setup: register the processor once, run your agents, and let the SDK's own tracing pipeline do
 * the reporting. No network call is awaited on the hot path; `shutdown()` flushes before a short script exits.
 */
import { Agent, run } from '@openai/agents';
import { instrumentOpenAIAgents } from './processor';

const { shutdown } = instrumentOpenAIAgents({
  url: process.env.AGENT_VIEWER_URL,
  apiKey: process.env.AGENT_VIEWER_API_TOKEN ?? process.env.AGENT_VIEWER_API_KEY,
  runtimeId: 'openai-agents',
});

const assistant = new Agent({
  name: 'Assistant',
  instructions: 'You are a concise, helpful assistant.',
});

async function main(): Promise<void> {
  const result = await run(assistant, 'What is the capital of Colombia?');
  console.log(result.finalOutput);
  await shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
