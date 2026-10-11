# Library host example: reading real spend from the rollup API

A worked, runnable example of the path from the Agent Viewer server's usage ledger to pixels in an embedded
`<AgentOffice>`: a host fetches the usage rollup (`GET /api/v1/usage/rollup`, issue #66) and the recent calls
list (`GET /api/v1/usage/calls`, issue #67), maps them with pure functions, and passes the result as props. The
component itself never fetches, sums or prices anything; this example shows the one place that does: your own
backend.

See the ["Getting figures from the server"](../../docs/library.md#getting-figures-from-the-server) section of
the library guide for the four rules this example follows.

## Files

| File | Purpose |
|---|---|
| `usageFromRollup.ts` | Pure mappers `rollupToUsage` and `callsToDetail`: server shapes in, library display types out. No arithmetic, no coercion of a missing value to `0`. |
| `HostOffice.tsx` | Fetches the rollup and the calls list from the proxy below on mount and every 15 seconds, maps them, and renders `<AgentOffice showUsage showUsageBadges showCallDetails ...>`. |
| `main.tsx`, `index.html`, `vite.config.ts` | A minimal page and its own Vite dev server. |
| `proxy.ts` | A small `node:http` proxy that holds the server's API token so the browser never does. |
| `seed.jsonl`, `seed.sh` | A fixed set of `llm.usage`/`llm.failed` events for five agents, covering a known cost, an unknown cost, mixed currencies and a failed call. |

## Running it

This example is not part of the root build; nothing here changes a root script.

1. **Start the Agent Viewer server** with a token you choose (never let it generate one for this walkthrough,
   since the proxy and the seed script both need to know it):

   ```bash
   AGENT_VIEWER_API_TOKEN=dev-local-token npx @warlockcode/agent-viewer --no-open
   ```

2. **Seed the example events**, from the repository root:

   ```bash
   examples/library-host/seed.sh dev-local-token
   ```

3. **Start the proxy**, with the same token:

   ```bash
   AGENT_VIEWER_API_TOKEN=dev-local-token npx tsx examples/library-host/proxy.ts
   ```

4. **Start the example page**, in another terminal:

   ```bash
   npx vite --config examples/library-host/vite.config.ts
   ```

   Open the printed local URL. The office shows five agents: `builder` (known cost), `planner` (mixed
   currencies, so its cost reads "unknown"), `researcher` (explicitly unknown cost), `qa` (one failed call,
   no usage) and `writer` (absent from the seed data entirely, so it gets no badge at all). Click an agent to
   open its call detail panel.

## The proxy's warning

`proxy.ts` has no login of its own. It injects the server's own `Authorization: Bearer $AGENT_VIEWER_API_TOKEN`
header into every allowlisted request; anyone who can reach the proxy's port can read every spend figure that
token can see. It binds `127.0.0.1` only, which is enough for this local walkthrough, but a real deployment
must put it behind your own application's authentication (a logged-in session check before the request ever
reaches this proxy), never expose it directly to the internet, and never add its own `token=`/`api_key=` query
parameter workaround.

`AGENT_VIEWER_API_TOKEN` is read only by `proxy.ts` (and mentioned only here and in `proxy.ts` itself, by
design, see `tests/library-host-proxy.test.mjs`); the browser bundle (`HostOffice.tsx`, `usageFromRollup.ts`,
`main.tsx`) never imports it, references it or receives it over the network. `seed.sh` takes the token as a
command-line argument instead, so it never needs to read that environment variable by name either.

## A known gap in the example, not in your app

The shipped rollup response has no single combined `totalTokens` field, only a per-kind breakdown (`tokens.
input.sum`, `tokens.output.sum`, ...). `usageFromRollup.ts` does not add `input.sum + output.sum` to make one:
that would be exactly the client-side arithmetic a mapper feeding this library must never do. `totalTokens`
therefore reads "unknown" on the compact badge in this example until the rollup API grows a combined field; the
per-kind breakdown, the cost figures and the call detail panel all show real numbers regardless. See the
module doc comment in `usageFromRollup.ts` for the full reasoning.
