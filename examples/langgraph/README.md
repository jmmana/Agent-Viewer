# LangGraph example

A small, runnable LangGraph graph (`researcher` -> `writer`, one local `word_count` tool) that reports to Agent
Viewer through the real [`@warlockcode/agent-viewer-langgraph`](../../packages/langgraph/README.md) package. The
chat model is a fake (`FakeChatModel` in [`main.ts`](main.ts)): fixed replies, made-up token counts, no provider,
no API key, no network call except the events sent to your Agent Viewer server.

It replaces the old hand-written `examples/langgraph-adapter.ts`, which mapped callbacks by hand and was never
wired into LangChain's callback system.

## Run it

```bash
# 1. From the repository root: start Agent Viewer, then build the two packages the example links to.
npm install
npm run build --workspace packages/sdk --workspace packages/langgraph

# 2. Here: install (as real copies, so @langchain/core resolves once) and run.
cd examples/langgraph
npm install --install-links
npm start
```

`AGENT_VIEWER_URL` (default `http://localhost:8787`) and `AGENT_VIEWER_API_TOKEN` point it at your server. With
no server listening the graph still runs; the failed sends show up in the printed `stats()`.

In the office you should see the `researcher` and `writer` agents move to Thinking and Done, one `word_count`
tool call, and two `llm.usage` events for the `fake` provider, all in session `example-thread-1` (the graph's
`thread_id`).

Outside this repository, depend on the published packages instead of the `file:` links:

```bash
npm install @warlockcode/agent-viewer-langgraph @warlockcode/agent-viewer-sdk @langchain/core @langchain/langgraph
```
