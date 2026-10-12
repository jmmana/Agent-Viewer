# @warlockcode/agent-viewer-langgraph

LangGraph callback handler that reports node runs, tools and model usage to
[Agent Viewer](https://github.com/jmmana/Agent-Viewer), the live office view of your AI agents.

```bash
npm install @warlockcode/agent-viewer-langgraph @warlockcode/agent-viewer-sdk @langchain/core
```

`@langchain/core` (`>=0.3.0 <2`) and `@warlockcode/agent-viewer-sdk` (`>=0.6.0`) are peer dependencies. Node.js
22.13 or newer.

## Usage

```ts
import { AgentViewerCallbackHandler } from '@warlockcode/agent-viewer-langgraph';

const handler = new AgentViewerCallbackHandler({ url: 'http://localhost:8787', runtimeId: 'my-graph' });
await graph.invoke(inputs, { callbacks: [handler], configurable: { thread_id: 'thread-1' } });
await handler.flush(); // before a short script exits
console.log(handler.stats()); // { sent, failed, dropped, callsWithoutUsage }
```

Each LangGraph node becomes an agent in the office (`agentForNode` to change that), `thread_id` becomes the
session, tools become `tool.*` events, and model calls become `llm.usage` (only when the provider reported both
token counts) or `llm.failed`.

Only names, counts and timings are sent: never prompts, completions, tool inputs or outputs, or error messages.
No callback awaits the network, and nothing the handler raises reaches the graph.

## Learn more

- Full guide, options and event mapping: [docs/adapters/langgraph.md](https://github.com/jmmana/Agent-Viewer/blob/main/docs/adapters/langgraph.md)
- Runnable example with a fake chat model: [examples/langgraph](https://github.com/jmmana/Agent-Viewer/tree/main/examples/langgraph)
- Python: the same handler ships in the Python SDK, `pip install "agent-viewer[langgraph]"`.

## License

MIT
