# Usage semantics: what a token or cost figure means

This is the one binding reference for what a token count, a cost or a currency means anywhere in Agent Viewer:
the server, the portal, the CLI, the SDKs and the embeddable library. Every other document links here instead of
restating the rules. Español: [usage-semantics.es.md](usage-semantics.es.md).

Read this before you report usage from your own runtime, before you read a snapshot or a `GET /api/v1/usage`
response, and before you reconcile a number Agent Viewer shows against a provider invoice.

## 1. Binding rules

- **U1. Unknown is never shown or stored as zero.** This applies to the server, the portal, the CLI and the
  SDKs. A token count, a cost or a currency that was not reported stays unknown (`null` or absent); it is never
  written, aggregated or displayed as `0`. This is the general form of the README's principle 6 ("Unknown is not
  zero, anywhere"), which itself restates the embeddable component's own rule, principle 4 ("The component never
  computes, adds up or prices usage. A missing cost is shown as unknown, never as 0").
- **U2. The embeddable component never invents, adds up or prices usage.** `<AgentOffice>` only displays the
  figures the host passes through the `usage` / `showUsage` props; `showUsage` is `false` by default. The opt-in
  `summarizeUsage(events)` helper is the only exception: it adds up what `llm.usage` events reported, and it
  never prices anything. See [docs/library.md](library.md#usage-figures).
- **U3. Costs in different currencies are never added and never converted.** A USD amount and a EUR amount stay
  in separate buckets everywhere: the server's `usage.total.byCurrency`, the library's `summarizeUsage`, and the
  portal. Agent Viewer has no exchange rate table and never will at this layer.
- **U4. Reported and estimated costs are never combined into one number.** `costSource` is part of the bucket
  key everywhere a cost is summed: a `provider-reported` USD amount and an `estimated` USD amount are two
  separate entries, never one sum.
- **U5. Server-side aggregation is allowed.** The server reducer (`server/usageAggregates.ts`) sums tokens and
  costs call by call, but it must follow U1, U3 and U4, and it must say what it covers (see
  [section 9](#9-what-a-total-covers)): which events, since when, and whether anything was dropped.

## 2. Field reference for `llm.usage`

Schema: `LlmUsagePayloadSchema` in
[`src/integrations/canonicalContract.ts`](../src/integrations/canonicalContract.ts).

| Field | Type | How "unknown" is represented | Meaning |
|---|---|---|---|
| `provider` | `string` (required) | n/a, always required | The provider's own name, as your runtime names it (`"Anthropic"`, `"OpenAI"`...). Free text, not an enum: it is also the first half of the `(provider, requestId)` dedup key. |
| `model` | `string` (required on `llm.usage`; nullable on `llm.failed`) | `null` on `llm.failed` only | The model actually called. On `llm.failed`, `null` means the call failed before a model was even chosen (for example a connection failure). |
| `inputTokens` | non-negative integer (required) | n/a, always required on `llm.usage`; nullable on `llm.failed` | All input tokens the provider processed, **including** `cacheReadTokens` and `cacheWriteTokens`. See [section 6](#6-cache-read-versus-cache-write). |
| `outputTokens` | non-negative integer (required on `llm.usage`; nullable on `llm.failed`) | nullable on `llm.failed` | Tokens the model produced, including reasoning tokens when the provider bills them as output. |
| `cacheReadTokens` | non-negative integer or `null` | absent or `null` | Part of `inputTokens` served from the provider's prompt cache (a cache hit). |
| `cacheWriteTokens` | non-negative integer or `null` | absent or `null` | Part of `inputTokens` written to the provider's prompt cache (cache creation). |
| `cachedTokens` | non-negative integer or `null` (**deprecated**) | absent or `null` | Legacy alias of `cacheReadTokens`. Still accepted, kept in the payload as sent, and copied into `cacheReadTokens` when that field is absent. A different number in both is rejected. New senders should use `cacheReadTokens` directly. |
| `reasoningTokens` | non-negative integer or `null` | absent or `null` | Tokens spent on private reasoning that the provider bills and reports separately from visible output. |
| `latencyMs` | non-negative integer or `null` | absent or `null` | Wall-clock duration of the call, in milliseconds, as measured by the sender. |
| `requestId` | `string` or `null` | absent or `null` | The provider's own request or response id, the one that also appears on the provider's side or in an invoice export. Feeds the `(provider, requestId)` dedup key (see [section 8](#8-deduplication)). Never a synthetic counter reused across sessions. |
| `cost` | non-negative number or `null` | `null` (default) | The amount of this call, in `currency`'s unit. `null` means no cost is known for this call, not "free". |
| `costSource` | `"provider-reported"` \| `"estimated"` \| `"unknown"` | `"unknown"` (default) | Where `cost` comes from. See [section 5](#5-costsource-meanings). |
| `currency` | ISO 4217 code (`^[A-Z]{3}$`) or `null` | absent or `null` | The unit of `cost`. A `cost` without a valid `currency` is kept, but counted apart (see [section 4](#4-currencies)). |

`llm.failed` carries the same token, cost, `costSource` and `currency` fields (all nullable, since most failed
calls report nothing), plus `errorKind`, `httpStatus`, `retryable`, `providerErrorCode` and `attempts`. Full
reference: [docs/integration.md](integration.md#-7-canonical-llm-usage-normalization).

## 3. Unknown versus zero

```json
{ "reasoningTokens": 0 }
```

means "the provider said zero": a call that genuinely spent no tokens on private reasoning.

```json
{ "reasoningTokens": null }
```

or the field omitted entirely, means "not reported": the sender does not know, because the provider does not
report this figure for this call, or the sender has not wired it up yet. Agent Viewer never turns the second
case into the first.

The same distinction holds for `cost`: `cost: 0` means the provider billed exactly zero (a free tier call, a
cached-only response some providers do not charge for); `cost: null` means no amount is known. Claude Code's own
telemetry is a real example of why this matters: it reports `cost_usd: 0` whenever it cannot price a call, not
when the call was free (see [docs/claude-code.md](claude-code.md#tokens-and-cost)). The receiver never rewrites
that `0` into `null`, because Claude Code's `0` really is what it sent; this is a sharp edge of that specific
telemetry source, not a rule Agent Viewer applies elsewhere.

**How an aggregate shows partial knowledge.** The server's `UsageBucket` (`server/usageAggregates.ts`) never
reports a sum next to a silent zero-fill. Each token kind has:

```json
{ "sum": 1500, "unreportedCount": 2 }
```

`sum` is `null` until at least one call in the bucket reports that kind; once some call has, `sum` is the total
of only the calls that reported it, and `unreportedCount` says how many calls in the same bucket did not. A
reader must never divide `sum` by `calls` and call the result "tokens per call" when `unreportedCount > 0`: it is
tokens per call that reported the figure. The portal renders this as the known sum plus an "N calls unreported"
note next to it, never folded into the number itself.

## 4. Currencies

- Only ISO 4217 codes are accepted (`^[A-Z]{3}$`, for example `USD`, `EUR`, `COP`). A free-text value such as
  `"usd"`, `"dollars"` or an empty string does not count as a currency.
- Totals are per currency. `usage.total.byCurrency` is an array of `(currency, costSource)` pairs, never a
  single number.
- A cost with no currency, or with an invalid one, goes into its own counter (`currencyMissingCount` on the
  server, `costWithoutCurrency` in the library) instead of being folded into any `byCurrency` entry or assumed to
  be USD.
- Agent Viewer never converts between currencies, anywhere. There is no exchange rate table at this layer and no
  plan to add one before pricing lands (0.6.0, out of scope here).

## 5. `costSource` meanings

| Value | Meaning | Who may set it |
|---|---|---|
| `provider-reported` | The provider returned this amount for this specific call (in the response body or a billing API). Agent Viewer stores it as reported and does not verify it against your invoice. | Your runtime or adapter; the SDKs only when the caller explicitly states it. |
| `estimated` | Computed from tokens and a price list, by the runtime or adapter, or (later, 0.6.0) by a server-side pricing table. Claude Code's own `cost_usd` telemetry is received as `estimated`: it is Claude Code's own on-machine estimate, not your Anthropic invoice. | Your runtime or adapter; the CLI's Claude Code telemetry mapping. |
| `unknown` | No cost is known for this call. `cost` must be `null`. This is the default: a `cost` sent without a stated `costSource` is recorded as `unknown`, not guessed as `provider-reported`. | Default, whenever nothing else is stated. |

**History.** Before issue #58, both the Python and TypeScript SDKs labelled any cost they received as
`provider-reported` by default, even when the caller had actually computed an estimate. As of 0.3.0, a `cost`
given without `cost_source` / `costSource` is sent as `unknown` instead, and each SDK client prints one warning
(Python: `logging.WARNING` on the `agent_viewer` logger; TypeScript: `console.warn`). **To fix old logs:**
events stored before this change that have `costSource: "provider-reported"` but came from code that never
stated it explicitly are not automatically corrected (Agent Viewer never rewrites stored events); treat any
`provider-reported` cost from before you upgraded your SDK as suspect unless you know your code always passed
`cost_source` explicitly, and re-emit corrected `llm.usage` events with the same `requestId` if you need the
figure fixed going forward (see [deduplication](#8-deduplication): a corrected resend with a different
`requestId` is a new call, not a correction of the old one).

## 6. Cache read versus cache write

Providers bill a cache read (serving a prompt from their cache) and a cache write (creating that cache entry) at
different rates, often much cheaper for reads. Agent Viewer records both separately and still never prices
either.

**`inputTokens` includes cache tokens.** By the convention fixed in issue #46 and used by the OTLP receiver
(#59) and the contract's own validation (`cacheReadTokens + cacheWriteTokens` must not exceed `inputTokens`),
`inputTokens` is the provider's *total* input accounting, cache included. This matches Anthropic's Messages API
exactly (`input_tokens` is billed separately from `cache_read_input_tokens` and `cache_creation_input_tokens`,
so an adapter must add all three into `inputTokens`) and matches OpenAI's own accounting (`prompt_tokens` /
`input_tokens` already include the cached portion, reported again separately only as a breakdown). Model Ops'
simulator assumption that cached tokens are a subset of input tokens (`src/engine/modelOps.ts`) holds under this
convention.

**Provider field mapping.** The full table, with each provider's own field names and the API reference checked
against the providers' current docs, lives in
[docs/integration.md](integration.md#mapping-provider-usage-fields) so there is exactly one copy to keep in
sync. Summary: Anthropic's `cache_read_input_tokens` and `cache_creation_input_tokens` map directly to
`cacheReadTokens` and `cacheWriteTokens`; OpenAI's Chat Completions `prompt_tokens_details.cached_tokens` maps to
`cacheReadTokens`, with no cache-write figure reported at all (leave `cacheWriteTokens` out, never `0`).

**Claude Code.** The OTLP telemetry receiver (`POST /v1/logs`, [docs/otlp.md](otlp.md)) maps Claude Code's own
`cache_read_tokens` and `cache_creation_tokens` attributes to `cacheReadTokens` and `cacheWriteTokens`, and adds
them (plus the raw `input_tokens`) into the reported `inputTokens`, since Claude Code's own `input_tokens`
attribute excludes cache usage (the opposite of the convention above). This is the one place in the codebase
where the receiver, not the provider, performs the addition; it is documented as an explicit exception in
[docs/claude-code.md#tokens-and-cost](claude-code.md#tokens-and-cost).

## 7. `llm.failed`

Emit `llm.failed` for one failed model call **attempt**: a provider error, a rate limit, a timeout or a client
cancellation. A retry that later succeeds is a separate `llm.usage` event with its own id (and, when the
provider gives one, its own `requestId`).

**Fields**, as shipped by issue #46: `provider` (required), `model` (nullable: a connection failure can happen
before a model is chosen), `errorKind` (one of `LLM_ERROR_KINDS`: `rate_limited`, `overloaded`, `timeout`,
`invalid_request`, `auth`, `server_error`, `cancelled`, `network`, `unknown`), `httpStatus`, `retryable`,
`requestId`, `providerErrorCode`, `attempts`, plus the same token, cost, `costSource` and `currency` fields as
`llm.usage`, all nullable. There is deliberately no free-text error message field: provider error text can echo
prompts or credentials.

**How it counts.** `llm.failed` calls are counted apart, under `failed` in every bucket of
`server/usageAggregates.ts` (`total.failed`, each model's `failed`, each agent's `failed`), never mixed into the
successful totals. A failed call's tokens and cost count only when the provider actually billed the attempt
(most do not): a failed call with no usage reported is **never** treated as a call with zero cost, it is a call
whose cost is unknown, same as any other unreported figure. `llm.failed` does not change an agent's status in
the office (a failed attempt is often retried) and does not change `agent.status.changed`-driven state; it only
registers the agent if unseen and stores its provider/model.

## 8. Deduplication

- **Event `id` idempotency.** One `id` names exactly one event, forever. The server fingerprints every stored
  event (`sha256:` over the validated event, keys sorted, defaults filled in). The same `id` with the same
  fingerprint is a true retry (`200 duplicate`, nothing recounted). The same `id` with a *different* fingerprint
  is a `409 conflicting_duplicate`: the new content is rejected outright, not merged, not partially applied.
- **`requestId` deduplication for `llm.usage` and `llm.failed`** (issue #48). On top of the `id` key, these two
  types share a second key: `(provider, requestId)`, normalized (provider trimmed and lowercased, `requestId`
  trimmed). "Same call" means the same provider request or response id, whatever `id` a retry, a replayed
  buffer, two reporting layers (an adapter and hand-written code), or a redelivered webhook used. A second report
  under the same key is stored as an auditable `duplicateOf` reference: it is never added to any total, never
  rebroadcast over SSE, and excluded from `GET /api/v1/events`, but it stays inspectable at
  `GET /api/v1/usage/duplicates`. `llm.usage` and `llm.failed` share one key space, so a call reported as failed
  and later as used under the same `requestId` is not double counted.
- **Webhook retries** (issue #49). The generic webhook derives a deterministic event id from the delivery's
  idempotency key (an `Idempotency-Key` header, a body `idempotencyKey` field, or its HMAC signature), so an
  identical retry lands on the same `id` and resolves as an ordinary duplicate. A delivery with no idempotency
  key gets a random id and is marked `source: "none"`: it is not safe to retry blindly, since the server cannot
  tell a retry from a second real event.

## 9. What a total covers

- **SQLite.** Every total is rebuilt from the database at server startup (issue #52): the server replays every
  stored event, in insertion order, through the same reducer the live path uses, so the state after a restart is
  identical to the state before it. `GET /ready` answers `503 store_rebuilding` until the replay finishes.
  `retention.maxEvents` is always `null` in this mode: the database keeps every row, nothing is evicted.
- **Memory mode (the default).** The retained event window is a ring buffer capped at `AGENT_VIEWER_MAX_EVENTS`
  (default `10000`; issue #53). Past that cap, the oldest events are evicted from the list `GET /api/v1/events`
  and SSE replay return, **but totals and per-agent figures are not reduced**: they keep counting every accepted
  event since the process started, eviction included. `snapshot.retention` (also on `GET /api/v1/events` and the
  SSE heartbeat) reports `storage`, `maxEvents`, `retainedEvents`, `acceptedEvents`, `droppedEvents` and `since`,
  so a reader can always tell when the event list is a truncated window even though the totals are not. Dedup
  never forgets either: an evicted event's id (and, for `llm.usage`/`llm.failed`, its `(provider, requestId)`
  key) stays known for the life of the process, so a late retry of something long evicted is still recognized as
  a duplicate and never recounted.
- **SSE reconnect and resync** (issue #54). A reconnecting client that missed events gets them replayed in full
  up to `AGENT_VIEWER_SSE_REPLAY_MAX` (default `10000`); past that, or when the cursor itself is unknown (never
  stored, evicted, or lost after a memory-mode restart), the server sends an explicit named `resync` frame
  instead of a silent partial replay, with `missed` as a count or `null` when truly unknown, never `0`. On a
  resync, a client must rebuild its usage figures from the snapshot's own aggregates (`usage`, not
  `totalTokens`/`totalCost`), never by re-adding the snapshot's own (capped) event list.
- **`PATCH /api/v1/agents/:agentId` can no longer change spend** (issue #50). Only descriptive profile and
  status fields are accepted; a usage or cost field in the body is rejected with `400 validation_failed`. The
  only way to report usage is an `llm.usage` (or `llm.failed`) event.
- **Timestamps are client clocks.** `event.timestamp` is whatever the sender's clock said, not when the server
  received it; `firstTimestamp`/`lastTimestamp` in a bucket reflect that. A server receive-time field is planned
  (issue #65, out of scope here) and is not available yet: do not assume `timestamp` orders events the way the
  server actually saw them under clock skew or network delay.

## 10. Where each figure on screen comes from

| Where | Source | Notes |
|---|---|---|
| Library badge or usage panel (`<AgentOffice showUsage usage={...}>`) | Whatever the host passes in the `usage` prop | The library never computes it (U2). No prop, no panel. |
| Library, `summarizeUsage(events)` | The host's own `events` array, read client-side | Opt-in only; dedup by event `id`; never prices. |
| Portal top bar (live mode) | The server's `GET /api/v1/snapshot` / SSE `usage` block | Never re-derived from the portal's own event list, so it matches the server exactly, including evicted events in memory mode. |
| Model Ops console, "live" figures | The same server `usage` aggregates, by provider and model | Real data only; never mixed with the simulator. |
| Model Ops console, Simulator tab | A local what-if calculator over the demo pricing catalog | Always tagged `simulated: true` and shown with a `SIMULATED` chip; never touches an agent's real tokens or cost, and is not rendered as an action against a live agent in live mode. An uncatalogued model (for example a live agent's real model) shows "Unknown", never a fallback price. |
| Claude Code hooks (no `--telemetry`) | Nothing: hooks never carry tokens or cost | A Claude Code session seen only through hooks correctly shows `0.0K` / unreported, not a guess. |
| Claude Code tokens and cost | `install claude-code --telemetry`, Claude Code's own OpenTelemetry logs, received at `POST /v1/logs` | `costSource: "estimated"` always (Claude Code's own on-machine estimate, see [section 5](#5-costsource-meanings)); figures cover only what the office actually received while telemetry was on and the office was running. |

## 11. Reconciling with an invoice

1. **Read `GET /api/v1/usage` (or the snapshot's `usage` block), not the deprecated `totalTokens`/`totalCost`.**
   The deprecated fields are lower bounds or `null` by design; the `usage` block is the one with per-currency,
   per-`costSource` figures.
2. **Group by currency and `costSource` before comparing anything.** Your invoice is in one currency; match it
   against the one `byCurrency` entry with that currency and `costSource: "provider-reported"`. Never sum across
   `byCurrency` entries.
3. **Subtract nothing for failed calls unless your invoice does.** Check `total.failed`: most providers do not
   bill a failed attempt, but some bill partial usage on a `rate_limited` or `timeout` response. `failed.tokens`
   and `failed.byCurrency` are kept apart precisely so you can check this instead of guessing.
4. **Account for `costUnknownCount` before concluding the totals disagree.** `costMissingCount` (no cost
   reported at all) and `currencyMissingCount` (a cost reported with no usable currency) are calls whose amount
   is not in any `byCurrency` entry. A nonzero count here, not a code bug, is usually why a sum looks short of
   the invoice.
5. **Check `retention` in memory mode.** If `droppedEvents > 0`, the event *list* is a truncated window, but the
   totals you are reconciling still cover everything since `totalsSince` (see [section 9](#9-what-a-total-covers)).
   If you need the full event-level detail and the window has evicted it, switch to `AGENT_VIEWER_STORAGE=sqlite`
   before the window you care about.
6. **Run the golden suite as the executable form of this guide.** `npm run test:golden` (issue #62) checks one
   hand-worked fixture against the memory store, the SQLite store across a restart, the portal and the library,
   and asserts all four reach the same figures. For example, its 7 successful calls plus 1 failed call (after
   resolving 2 duplicates and 1 conflicting duplicate) reconcile to `input: 3300` (`unreportedCount: 0`),
   `output: 860` (`unreportedCount: 0`), `cacheRead: 300` and `cacheWrite: 50` (`unreportedCount: 1` each, from
   the one call that genuinely did not report them), cost `USD 0.0225` plus `EUR 0.0200` (never added together),
   one call with an unknown cost and one with a cost but no usable currency. See
   [`tests/fixtures/reconciliation/README.md`](../tests/fixtures/reconciliation/README.md) for the full
   hand-worked arithmetic, line by line.
