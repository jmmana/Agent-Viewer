# LangGraph adapter

[Versión en español](langgraph.es.md)

`AgentViewerCallbackHandler` reports a LangGraph run to Agent Viewer through LangChain's own callback system. It
ships for both languages, with the same events and the same privacy rules:

| Language | Install | Import |
|---|---|---|
| TypeScript | `npm install @warlockcode/agent-viewer-langgraph @warlockcode/agent-viewer-sdk @langchain/core` | `import { AgentViewerCallbackHandler } from '@warlockcode/agent-viewer-langgraph'` |
| Python | `pip install "agent-viewer[langgraph]"` | `from agent_viewer_langgraph import AgentViewerCallbackHandler` |

`@langchain/core` and `@warlockcode/agent-viewer-sdk` are peer dependencies of the npm package, so it uses the
copies your app already has.

## TypeScript

```ts
import { AgentViewerCallbackHandler } from '@warlockcode/agent-viewer-langgraph';

const handler = new AgentViewerCallbackHandler({ url: 'http://localhost:8787', runtimeId: 'my-graph' });
await graph.invoke(inputs, { callbacks: [handler], configurable: { thread_id: 'thread-1' } });
await handler.flush(); // before a short script exits
```

Options (all optional): `viewer` (an existing `AgentViewer` client), `url`, `apiKey`, `runtimeId` (default
`'langgraph'`), `agentForNode(node, metadata)` (default: the node name is the agent id), `sessionFor(metadata)`
(default: `thread_id`), `taskFor(metadata)`, `toolInputSummary` / `toolOutputSummary` (opt-in, off by default),
`reportedCost(result)`, `maxQueue` (1000), `batchSize` (50), `onError`, `debug`. `handler.stats()` returns the
`sent`, `failed`, `dropped` and `callsWithoutUsage` counters.

A runnable project with a fake chat model (no provider, no API key) is in
[`examples/langgraph/`](../../examples/langgraph/README.md).

## Python

```python
from agent_viewer_langgraph import AgentViewerCallbackHandler

handler = AgentViewerCallbackHandler(url="http://localhost:8787", runtime_id="my-graph")
graph.invoke(inputs, config={"callbacks": [handler], "configurable": {"thread_id": "thread-1"}})
handler.flush()
```

Events are sent from a daemon thread through a bounded queue and flushed at interpreter exit. `handler.stats()`,
`handler.flush(timeout)` and `handler.close(timeout)` are available.

## What is reported

| LangGraph callback | Agent Viewer event |
|---|---|
| First run of a node | `agent.registered` (the node's agent) |
| Node starts | `agent.status.changed` → Thinking |
| Node ends | `agent.status.changed` → Done |
| Node fails | `agent.status.changed` → Blocked (Waiting for an interrupt: `GraphInterrupt`, `NodeInterrupt`, ...) |
| Tool starts, ends, fails | `tool.started`, `tool.completed`, `tool.failed` |
| Model call ends | `llm.usage`, only when the provider reported both input and output tokens |
| Model call fails | `llm.failed`, with an `errorKind` derived from the error class name |

- Event ids are deterministic, `lg:<runtimeId>:<runId>:<eventKind>`, so a replayed callback is an idempotent
  duplicate on the server.
- Provider and model come from `ls_provider` and `ls_model_name`. Token counts come from the message's
  `usage_metadata`, then the provider's `llmOutput`. A count the provider did not report is never set to 0, and
  a cost is never estimated: only `reportedCost` sends one.
- `thread_id` becomes the session. Nothing is invented when it is missing.

## Privacy

Only names, counts and timings leave the process. Prompts, completions, tool inputs and outputs, and error
messages are never sent (tool summaries are opt-in). Callback metadata is filtered through `METADATA_WHITELIST`:
`langgraph_node`, `thread_id`, `ls_provider`, `ls_model_name`, `ls_model_type`.

## Reliability

No callback awaits the network: each one enqueues its events and returns, so a slow or unreachable server never
blocks the graph. A full queue drops the event and counts it. Nothing raised by the handler reaches the graph.

## Migrating from `examples/langgraph-adapter.ts`

The old hand-written example (`LangGraphViewerAdapter` with `onNodeStart`, `onToolStart`, `onModelUsage`, ...) was
removed. Delete your copy and the manual calls, and pass the handler instead:

```diff
- import { LangGraphViewerAdapter } from './langgraph-adapter';
+ import { AgentViewerCallbackHandler } from '@warlockcode/agent-viewer-langgraph';
+ await graph.invoke(inputs, { callbacks: [new AgentViewerCallbackHandler({ runtimeId: 'my-graph' })] });
```
