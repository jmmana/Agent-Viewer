# @warlockcode/agent-viewer-sdk

TypeScript SDK for [Agent Viewer](https://github.com/jmmana/Agent-Viewer): send canonical events (agent status,
tools, model usage and failures) to an Agent Viewer server, and read its snapshot, usage, rollup and budget APIs.

- ESM only, Node.js `>=22.13` (uses the built-in `fetch` and `node:crypto`).
- No runtime dependencies. The types it exposes are its own structural copies of the server contract.

## Install

```sh
npm install @warlockcode/agent-viewer-sdk
```

## Send events

```ts
import { AgentViewer } from '@warlockcode/agent-viewer-sdk';

const viewer = new AgentViewer({
  url: 'http://localhost:8787',
  apiKey: process.env.AGENT_VIEWER_API_TOKEN,
  runtimeId: 'my-runtime',
});

const agent = viewer.agent({ id: 'planner', name: 'Planner' });
await agent.thinking('Planning the release');
await agent.toolStarted('search', 'release notes');
await agent.toolCompleted('search', '12 results');
await agent.usage({
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  inputTokens: 1200,
  outputTokens: 300,
  cost: 0.0081,
  costSource: 'provider-reported',
  currency: 'USD',
});
await agent.done();
```

A figure you do not know is left out, never sent as `0`. A cost without `costSource` is sent as
`costSource: 'unknown'` with a one-time warning. Failed model calls go through `agent.llmFailed({ ... })`.

## Read figures

```ts
const snapshot = await viewer.snapshot();
const summary = await viewer.usageSummary();
const rollup = await viewer.usageRollup({ groupBy: ['agent', 'model'] });
const calls = await viewer.listCalls({ limit: 50 });
const budgets = await viewer.budgets();
```

`toUsageFigures()` maps a rollup group (or the totals) to the `usage` prop of the embeddable office, and
`verifyWebhookSignature()` checks the HMAC signature of an outbound Agent Viewer webhook (for example a `budget.alert` delivery).

## Errors

A request the server rejects throws an `AgentViewerError` carrying the HTTP status and the validation issues.
Transient failures are retried (`maxRetries`, default `3`) with a per-request timeout (`timeoutMs`, default
`10000`).

## License

MIT
