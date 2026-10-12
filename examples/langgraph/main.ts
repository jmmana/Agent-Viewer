/**
 * Runnable LangGraph example for `@warlockcode/agent-viewer-langgraph` (issue #346). A two-node graph
 * (researcher -> writer) with a fake chat model and a local tool: no model provider, no API key, no network
 * call except the events sent to your Agent Viewer server. If no server is listening, those sends fail
 * quietly and show up in `handler.stats().failed`; the graph itself still runs. See README.md.
 */

// The example installs its own dependencies (see package.json); the workspace root does not, so the root
// `tsc --noEmit` may not find these modules. With them installed (`npm install` here), their real types apply.
// Same convention as packages/langgraph/src/index.ts: `@ts-ignore`, not `@ts-expect-error`.
// @ts-ignore
import { AgentViewerCallbackHandler } from '@warlockcode/agent-viewer-langgraph';
// @ts-ignore
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
// @ts-ignore
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
// @ts-ignore
import type { ChatResult } from '@langchain/core/outputs';
// @ts-ignore
import { DynamicTool } from '@langchain/core/tools';
// @ts-ignore
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';

/** Answers from a fixed list and reports made-up token counts, so the viewer gets an `llm.usage` per call. */
class FakeChatModel extends BaseChatModel {
  private readonly replies: string[];
  private calls = 0;

  constructor(replies: string[]) {
    super({});
    this.replies = replies;
  }

  _llmType(): string {
    return 'fake';
  }

  // The provider and model names the adapter reads from the callback metadata.
  getLsParams() {
    return { ls_provider: 'fake', ls_model_name: 'fake-chat', ls_model_type: 'chat' as const };
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const text = this.replies[this.calls++ % this.replies.length];
    const inputTokens = 10 * messages.length;
    const outputTokens = text.split(/\s+/).length;
    const message = new AIMessage({
      content: text,
      usage_metadata: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    });
    return { generations: [{ text, message }] };
  }
}

const model = new FakeChatModel([
  'Bogota is the capital of Colombia.',
  'Final answer: Bogota is the capital of Colombia.',
]);

const wordCount = new DynamicTool({
  name: 'word_count',
  description: 'Counts the words in a text.',
  func: async (input: string) => String(input.split(/\s+/).filter(Boolean).length),
});

const graph = new StateGraph(MessagesAnnotation)
  .addNode('researcher', async (state: typeof MessagesAnnotation.State) => ({
    messages: [await model.invoke(state.messages)],
  }))
  .addNode('writer', async (state: typeof MessagesAnnotation.State) => {
    const draft = String(state.messages[state.messages.length - 1].content);
    const words = await wordCount.invoke(draft);
    return { messages: [await model.invoke([...state.messages, new HumanMessage(`The draft has ${words} words.`)])] };
  })
  .addEdge(START, 'researcher')
  .addEdge('researcher', 'writer')
  .addEdge('writer', END)
  .compile();

const handler = new AgentViewerCallbackHandler({
  url: process.env.AGENT_VIEWER_URL ?? 'http://localhost:8787',
  apiKey: process.env.AGENT_VIEWER_API_TOKEN ?? process.env.AGENT_VIEWER_API_KEY,
  runtimeId: 'langgraph-example',
});

const result = await graph.invoke(
  { messages: [new HumanMessage('What is the capital of Colombia?')] },
  { callbacks: [handler], configurable: { thread_id: 'example-thread-1' } },
);
console.log(String(result.messages[result.messages.length - 1].content));

// Callbacks only enqueue; wait for the queue to drain before this short script exits.
await handler.flush();
console.log('Agent Viewer:', handler.stats());
