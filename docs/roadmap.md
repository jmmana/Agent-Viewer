# Agent Viewer roadmap: observability and audit of agent consumption

[Español](roadmap.es.md) · [README](../README.md) · [Changelog](../CHANGELOG.md)

This is the public plan for releases 0.3.0 to 0.8.0. Work items are referenced by id (for example `v030-1`); issue numbers will be added next to each id once the issues are published. Dates are deliberately absent: a release ships when its exit criteria are met, not before.

## Vision

Agent Viewer becomes a real observability and audit tool for the tokens and cost that AI agents consume, and the office stays the hero view. Nobody else shows agents working in a virtual office, so the goal is to let you see who is spending, sitting at their desk, and then prove the numbers are right.

Concretely, by 0.8.0 you will be able to:

- Ask "how much did agent X spend with model Y this week" and get a figure per currency that you can export and reconcile against the provider invoice.
- See spend where it happens in the office: a badge per agent, the detail of each call on click, cost per meeting and per tool.
- Trust that the history was not touched, with a verifiable hash chain and read-only auditor access, on your own server.

## Where we are today (0.2.1)

The visual side is finished and the event format already carries everything needed: provider, model, input, output, cache and reasoning tokens, latency, request id, cost, cost source and currency. Today, though, token and cost figures behave like a live counter, not like an audit tool. Known gaps that 0.3.0 closes before anything else is built on top:

- With SQLite the totals live only in memory and go back to zero after a restart.
- A missing cost is added as 0, a missing `cachedTokens` or `reasoningTokens` is read as 0, and different currencies are summed together.
- A `PATCH` on an agent can change token and cost totals without producing any event.
- All of an agent's history is charged to the last model it used.
- An event id re-sent with different content is accepted as a "duplicate" without comparing it, server-generated ids can collide under concurrency, and a retried webhook counts twice.
- In the default memory mode, events past the cap are dropped while totals keep counting them, and an SSE reconnect replays at most 100 missed events.
- Model Ops mixes simulated calls with real data and falls back to another model's price when a model is unknown.
- The embeddable library is honest about not inventing figures, but `summarizeUsage` still reports USD when a USD cost is mixed with a cost that has no currency, and counts a repeated event id twice.

Because of this there is no public launch (for example Show HN) until 0.3.0 is closed. A demo whose totals contradict each other would damage the project on exactly its central topic.

## Principles

These rules apply to every work item. A change that breaks one of them does not ship.

1. **Unknown is never zero.** A missing value (cost, currency, cache tokens, reasoning tokens, latency) is counted as unknown and shown as "unknown". The general rule in the [README](../README.md#-contributing) ("never show an unknown figure as zero") is binding for the server and the portal. Rule 4 of the README, about the embedded component, stays as it is.
2. **No invented prices, no mixed money.** The server never converts currencies, never uses another model's price when a price is missing, and never adds different currencies together. Reported cost and estimated cost are separate figures and are never merged into one number.
3. **Privacy by design.** Agent Viewer records what is observable, never private model reasoning. The usage ledger holds metadata only, never prompt or message text. Free text is redacted on the server before it is stored, streamed or exported. Usage panels in the library are hidden unless the host enables them.
4. **The library displays, the host computes.** The embedded component never invents, sums or prices usage. Every figure (badge, call detail, budget state) arrives already computed from the host through props. Aggregation on the server is allowed and is the source for the portal.
5. **Auditability.** Nothing changes a total without an event. Duplicates are detected and conflicting duplicates are rejected, never applied. Every figure can be traced to the rows that produce it, and from 0.8.0 the history itself is tamper-evident.

## Release overview

Effort is relative size of the whole release: S small, M medium, L large, XL very large.

| Version | Theme | Effort |
|---|---|---|
| [0.3.0](#030-true-figures) | True figures | L |
| [0.4.0](#040-usage-ledger) | Usage ledger | L |
| [0.5.0](#050-spend-in-the-office) | Spend in the office | M |
| [0.6.0](#060-pricing-and-control) | Pricing and control | M |
| [0.7.0](#070-automatic-capture-and-interoperability) | Automatic capture and interoperability | L |
| [0.8.0](#080-formal-audit) | Formal audit | XL |

## 0.3.0: True figures

### Goal

Every token and cost figure the server, the portal and the library show is true: unknown is never zero, currencies never mix, nothing is counted twice or edited without an event, totals survive a restart, and Claude Code sessions report their real tokens through its native OpenTelemetry logs. PR #42 (one-command CLI, GHCR image, Claude Code hooks) ships in this release. There is no public launch (Show HN) before this release is closed.

### Exit criteria

- PR #42 is merged into main with CI green (lint, node and Vitest suites, Python SDK tests, both Docker targets, check:package) and 0.3.0 is published to npm, GHCR and PyPI from the same tag.
- The golden reconciliation suite (v030-19) passes: the same fixture produces identical per-currency cost sums, unknown-cost counts and per-kind token sums in the memory store, the SQLite store before and after a restart, the portal reducer and the library `summarizeUsage`.
- With SQLite and 10,000 stored `llm.usage` events, the usage block of `GET /api/v1/snapshot` is identical before and after a server restart (a test asserts deep equality).
- A test corpus proves that no path turns a missing cost or a missing `cachedTokens`/`reasoningTokens` value into 0: each missing value increments an explicit unknown counter and is rendered as "unknown" in the portal and the library.
- `PATCH /api/v1/agents/:id` with any token or cost field returns 400 and leaves every total unchanged.
- Re-sending an event id with different content returns 409; re-sending identical content returns a duplicate; two `llm.usage` events with the same provider and `requestId` count once; a webhook retried 3 times with the same `Idempotency-Key` counts once.
- 200 concurrent `POST /api/v1/agents` calls produce 200 distinct stored event ids.
- An SSE client that misses 5,000 events reconnects and ends in the same state as a fresh page load (full replay or explicit resync).
- A real Claude Code session configured with `install claude-code --telemetry` shows non-null input, output, cache read and cache write tokens plus a USD cost marked "estimated" on its main agent, within 1% of Claude Code's own session cost (manual check recorded in the PR).

### Work items

| ID | Work item | Effort | Depends on |
|---|---|---|---|
| `v030-1` | **Merge PR #42: one-command CLI, GHCR image and Claude Code hooks adapter**<br>Finish the fixes in progress, rebase onto main 0.2.1, keep the embedded mode and the hook privacy guarantees (no transcript reads, no tool arguments, hashed session ids), run the new tests and both Docker targets in CI, then squash-merge. | M | none |
| `v030-2` | **Versioned SQLite migrations**<br>Replace the loose `PRAGMA table_info` check with a `schema_migrations` table and numbered, forward-only migrations run in a transaction at startup; refuse to start on a database newer than the code; test upgrades from 0.1.x and 0.2.x databases without data loss. | M | none |
| `v030-3` | **Usage contract: unknown stays unknown, cache read vs write, `llm.failed`**<br>`cachedTokens` and `reasoningTokens` become nullish with no default of 0; add `cacheReadTokens` and `cacheWriteTokens` (`cachedTokens` stays as a deprecated alias for reads); add the canonical `llm.failed` type with error kind, status, retryability and latency. | M | none |
| `v030-4` | **Ingestion integrity: conflicting duplicates and collision-free server ids**<br>Same id with identical content stays an idempotent duplicate; same id with different content is rejected with 409 and never applied; server-generated ids stop using `Date.now()` and use random UUIDs. | M | `v030-2` |
| `v030-5` | **Deduplicate `llm.usage` and `llm.failed` by `requestId`**<br>An indexed `request_id` column and a memory equivalent: an event whose (provider, `requestId`) already exists is stored as a duplicate reference and never added to totals. | S | `v030-2`, `v030-3`, `v030-4` |
| `v030-6` | **Webhook usage parity and idempotent retries**<br>The generic webhook validates usage with the same schema as the events API, and its generated event ids become deterministic per delivery so a retried delivery counts once. | S | `v030-3`, `v030-4` |
| `v030-7` | **Remove spend editing through `PATCH /agents`**<br>The endpoint accepts only descriptive fields; any token or cost field returns 400 pointing to `llm.usage`; every accepted change emits an event. Documented as a breaking change. | S | none |
| `v030-8` | **Honest server aggregates computed call by call**<br>One reducer aggregates every `llm.usage` by agent and by the (provider, model) of that call; each token kind keeps a sum plus a count of events that did not report it; cost is kept per (currency, costSource) and a missing cost increments an unknown counter instead of adding 0; the snapshot gains a `usage` block. | L | `v030-3` |
| `v030-9` | **Rebuild all state from SQLite at startup**<br>Replay stored events in insertion order through the aggregation reducer to rebuild usage, agents, sessions, runtimes, tasks and meetings; log the rebuild time; `/ready` returns 503 until it finishes. | M | `v030-2`, `v030-8` |
| `v030-10` | **Memory mode: no silent loss, no double counting after eviction**<br>The dedup set keeps the ids of evicted events, totals cover every accepted event since start, the snapshot exposes retention metadata, and the portal shows a truncated-history notice. The cap becomes configurable. | S | `v030-8` |
| `v030-11` | **SSE reconnect replays every missed event or forces a resync**<br>Replace the fixed limit of 100 with paginated replay up to a configurable maximum; beyond it, or on an unknown `Last-Event-ID`, send an explicit `resync` event that `connectEventStream` surfaces to the host. | M | none |
| `v030-12` | **Portal totals follow the unknown-is-not-zero rule**<br>The portal reducer stops adding a missing cost as 0 and stops mixing currencies; it keeps per-currency sums plus unknown counters, renders "unknown" through i18n, shows cache read and write separately, and in live mode shows the server `usage` block. | M | `v030-3`, `v030-8` |
| `v030-13` | **Library `summarizeUsage`: dedup by id and unknown on mixed or missing currency**<br>Ignore repeated event ids; cost becomes unknown when a currency is mixed with a missing currency; a missing input or output figure is unknown instead of adding 0. The component keeps `trackUsage:false`. | S | `v030-3` |
| `v030-14` | **Separate simulated Model Ops data from real data**<br>Simulated calls are labelled SIMULATED everywhere and never enter real totals, feed or matrix; an unknown model gets a null estimate instead of the gpt-4o price; live mode reads the server per-model breakdown. | M | `v030-8` |
| `v030-15` | **SDK usage fixes in Python and TypeScript**<br>Both `usage()` helpers accept currency, task id, cache read and write tokens and `requestId`; cache and reasoning tokens default to unset, not 0; `costSource` is whatever the caller states, never claimed as provider-reported on its own; the legacy Python `llm_usage` follows the same rule. | M | `v030-3` |
| `v030-16` | **OTLP/HTTP logs receiver for Claude Code token telemetry**<br>First confirm event and attribute names against the current Claude Code monitoring docs and record real fixtures; add `POST /v1/logs` (http/json, same auth as the API) mapping `api_request` to `llm.usage` (cost as USD with `costSource` "estimated") and `api_error` to `llm.failed`; tokens land on the hook's main agent; ids are derived from record content so retries are idempotent; prompt attributes are ignored. | L | `v030-1`, `v030-3`, `v030-5` |
| `v030-17` | **`install claude-code --telemetry`**<br>Optionally write the OpenTelemetry env block into `.claude/settings.local.json`, showing the diff and asking first, never enabling prompt logging; document in `docs/claude-code.md` that cost is Claude Code's estimate and how subagent calls are attributed. | S | `v030-1`, `v030-16` |
| `v030-18` | **Warn loudly when the API is open without a token**<br>Startup warning, `/health` reports `auth: "open"`, a persistent portal banner, and Docker defaults that publish ports on 127.0.0.1. The hard refusal to start comes in v040-8. | S | `v030-1` |
| `v030-19` | **Golden reconciliation test suite**<br>One fixture event log with known expected figures (mixed currencies, missing cost, missing currency, missing cache tokens, duplicate and conflicting ids, repeated `requestId`, webhook retries, `llm.failed`, a PATCH attempt) run through the memory store, SQLite across a restart, the webhook path, the portal reducer and the library, asserting identical results on every PR. | M | `v030-5`, `v030-6`, `v030-7`, `v030-9`, `v030-10`, `v030-12`, `v030-13` |
| `v030-20` | **0.3.0 docs and release**<br>New `docs/usage-semantics.md`; README cites the general rule "never show an unknown figure as zero" as binding for server and portal while rule 4 stays for the component; CHANGELOG with breaking notes; publish npm, GHCR image and Python SDK. | S | `v030-1`, `v030-14`, `v030-15`, `v030-17`, `v030-18`, `v030-19` |


## 0.4.0: Usage ledger

### Goal

The server keeps one durable row per model call with server receive time, correlation ids and attribution, answers grouped questions (agent, model, session, task, day, user, tag), exports CSV and JSONL that reconcile exactly, and does so safely: secrets are redacted before anything is stored or exported, retention is configurable and the API can no longer run open by accident.

### Exit criteria

- "How much did agent X spend with model Y this week" is answered by one `GET /api/v1/usage/rollup` call, and the golden fixture returns the expected per-currency figures.
- CSV and JSONL exports of the golden fixture reconcile exactly with the rollup API per currency, per `costSource` and per token kind; an export of 100,000 rows streams without loading all rows into memory (peak RSS growth under 100 MB in the test).
- A redaction corpus of at least 30 secret formats leaks zero secrets into stored events, SSE frames, the calls API or exports.
- The server refuses to start on a non-loopback interface without a token unless `AGENT_VIEWER_ALLOW_OPEN=1`, and no endpoint accepts the API token in the query string.
- Reloading the portal shows the same totals and agent states as before the reload (Playwright e2e).
- For a Claude Code session, the reconciliation endpoint reports drift under 1% between ledger rows (logs) and Claude Code metrics.

### Work items

| ID | Work item | Effort | Depends on |
|---|---|---|---|
| `v040-1` | **Contract: correlation and attribution fields on usage events**<br>Optional `traceId`, `parentId`, `toolCallId`, `meetingId`, `userId` and `tags` (up to 20 strings of up to 64 characters) on `llm.usage` and `llm.failed`, with validation, docs and contract tests; both SDKs accept them. | M | `v030-3`, `v030-15` |
| `v040-2` | **Usage ledger table with server receive time**<br>A migration adds `usage_ledger`: one row per accepted `llm.usage` or `llm.failed`, with `received_at` from the server clock, `occurred_at` from the client, attribution, every token kind nullable and status. Backfill from existing events; duplicates never produce rows; `receivedAt` is exposed on the events API. | L | `v030-2`, `v030-8`, `v040-1` |
| `v040-3` | **Rollup query API**<br>`GET /api/v1/usage/rollup?groupBy=agent\|model\|provider\|session\|task\|day\|user\|tag` with filters returns per-currency cost split by `costSource`, unknown-cost counts, per-kind token sums with unreported counts, and call and failure counts. Never sums different currencies, or reported with estimated cost. | L | `v040-2` |
| `v040-4` | **Calls API with cursor pagination**<br>`GET /api/v1/usage/calls` returns ledger rows (metadata only) with the same filters as the rollup and stable cursor pagination. Never returns prompt or message text. | M | `v040-2` |
| `v040-5` | **Secret redaction baseline**<br>A server-side redactor runs at ingestion on every free-text field before storage, SSE and export, with built-in patterns (provider API keys, GitHub tokens, AWS keys, bearer tokens, JWTs, private key blocks, connection strings) and configurable extras; numeric usage is never touched; the portal "mask secrets" setting is wired to every text surface. | M | none |
| `v040-6` | **CSV and JSONL export**<br>`GET /api/v1/usage/export?format=csv\|jsonl` streams ledger rows with the rollup filters, documented columns, redacted text only, protection against CSV formula injection and per-currency totals for invoice reconciliation. The portal adds an export action. | M | `v040-3`, `v040-5` |
| `v040-7` | **Retention baseline**<br>`AGENT_VIEWER_RETENTION_DAYS` purges old events on a schedule; ledger rows have their own `AGENT_VIEWER_USAGE_RETENTION_DAYS` (default: keep). Purges are logged and exposed through an admin endpoint, and purging events never changes the rollups of retained ledger rows. | M | `v040-2` |
| `v040-8` | **Close the open-API and token-in-URL gaps**<br>Refuse to bind a non-loopback interface without a token unless explicitly allowed; remove the `?token` and `?api_key` query parameters; EventSource clients use short-lived single-use tickets from `POST /api/v1/stream-tickets`; access logs never contain tokens. | M | `v030-18` |
| `v040-9` | **Portal loads full history on open**<br>On open the portal loads the snapshot, ledger rollups and recent events (paginated) before subscribing to SSE with the last event id, so a reload never resets figures. Live usage panels read only server rollups. | M | `v040-3`, `v040-4`, `v030-11` |
| `v040-10` | **OTLP metrics ingestion and http/protobuf support**<br>`POST /v1/metrics` accepts Claude Code token and cost metrics (delta and cumulative temporality) into a separate telemetry series that never enters the ledger or totals; a reconciliation endpoint compares ledger and metric sums per session and flags drift; logs and metrics also accept http/protobuf. | L | `v030-16`, `v040-2` |
| `v040-11` | **Event log parser recognizes OTLP logs and metrics files**<br>`parseEventLog` detects `resourceLogs` and converts Claude Code log records with the v030-16 mapper; `resourceMetrics` files return a clear issue saying metrics cannot be replayed as calls; `resourceSpans` still reports "not supported yet" until v070-2. | S | `v030-16` |
| `v040-12` | **0.4.0 docs and release**<br>Ledger schema, rollup, calls, export, reconciliation and stream-ticket API reference; redaction and retention guide; migration notes for the removed query token; publish npm, GHCR and SDKs. | S | `v040-6`, `v040-7`, `v040-8`, `v040-9`, `v040-10`, `v040-11` |


## 0.5.0: Spend in the office

### Goal

The office stays the hero view and now shows spend where it happens: a per-agent badge, a per-call detail on click, Model Ops fed only by real ledger data, and cost per meeting and per tool. In the embeddable library every figure arrives already computed from the host through props; the component never sums, prices or compares.

### Exit criteria

- Usage badges and call details are hidden by default in the library and appear only with the opt-in props.
- Library tests prove there is no arithmetic: for any host-provided figures the badge and the detail render exactly those values, and null renders "unknown".
- The per-call detail renders no prompt, message or tool argument text, verified with events that carry such text.
- Model Ops real-data tabs contain zero simulated entries; the simulator tab is the only place simulated calls appear, and each is labelled SIMULATED.
- Per-meeting and per-tool cost totals reconcile exactly with ledger rollups for the golden fixture.

### Work items

| ID | Work item | Effort | Depends on |
|---|---|---|---|
| `v050-1` | **Library: per-agent usage badges from host props**<br>New opt-in `showUsageBadges` prop; badge content comes from the host-provided `usage.byAgent` figures (display only); the canvas draws a compact badge per desk with accessible text; unknown renders "unknown". | M | `v030-13` |
| `v050-2` | **Library: per-call detail panel from host props**<br>New `agentCallDetails` and `onAgentSelect` props: clicking an agent opens a panel with only model, provider, tokens by kind, `requestId`, latency, status and `costSource`. The component never fetches, sums or derives figures, and the type excludes text fields. | M | `v050-1` |
| `v050-3` | **Portal: badges and call detail backed by the ledger**<br>The portal acts as the host: it fills badges from the rollup API and the detail panel from the calls API with pagination, refreshing on SSE usage events, and respects the redaction setting. | M | `v050-2`, `v040-3`, `v040-4` |
| `v050-4` | **Model Ops on real ledger data**<br>Matrix, agents and feed tabs read rollups and calls from the server (per-model by call, failures, cache read and write), replacing agent-level aggregation and the invented feed; the simulator tab stays isolated and labelled; empty states explain how to send real usage. | L | `v040-3`, `v040-4`, `v030-14` |
| `v050-5` | **Cost per meeting and per tool on the server**<br>Rollup `groupBy` meeting and tool using `meetingId` and `toolCallId`, with the tool name resolved from `tool.started` events; calls without the link are reported as unattributed, never guessed by time overlap. | M | `v040-3` |
| `v050-6` | **Portal: meeting and tool spend in the office**<br>The meeting panel and tool tooltips show server-computed cost and tokens per meeting and per tool, with unattributed counts; the library gets optional host props for the same figures, display only. | M | `v050-5`, `v050-1` |
| `v050-7` | **0.5.0 docs and release**<br>Library guide (`docs/library.md` and `docs/library.es.md`) for usage badges, call detail and the privacy rules, with an example host that reads the rollup API; publish. | S | `v050-3`, `v050-4`, `v050-6` |


## 0.6.0: Pricing and control

### Goal

The server estimates cost from a versioned pricing table that covers every billed token kind, never invents a price and never mixes estimates with reported cost; budgets raise alerts and turn desks amber or red; latency percentiles and error rates per model come only from real data.

### Exit criteria

- The pricing table supports input, output, cache read, cache write and reasoning prices per model with effective dates and per-model overrides; a model without a price gets a null estimate (tested).
- Every estimated ledger row carries `costSource` "estimated" and its `pricingVersion`; changing prices never rewrites existing rows unless an explicit recompute creates a new pricing version.
- No API response or export sums reported and estimated cost into one number (a contract test on every usage endpoint).
- A budget crossing produces an alert (event and outbound webhook) within 5 seconds of the triggering call.
- In the library, desk budget colors come only from the host prop (a test with a prop that contradicts the usage figures shows the prop state).
- p50 and p95 latency per model are computed only from rows with `latencyMs` and always shown with the sample size.

### Work items

| ID | Work item | Effort | Depends on |
|---|---|---|---|
| `v060-1` | **Versioned server pricing table**<br>Prices stored on the server (file plus admin API) per provider and model: input, output, cache read, cache write and reasoning per million tokens, currency and `effectiveFrom`; every change creates a new `pricingVersion`; per-model overrides; no default or fallback price; ships a starter table marked as estimated with its source date. | M | `v040-2` |
| `v060-2` | **Estimated cost per ledger row**<br>Each row gets `estimatedCost`, `estimatedCurrency` and `pricingVersion`, computed at ingestion from the table in force at `occurred_at` and kept separate from the reported cost; rollups and exports return both side by side; an explicit recompute endpoint writes under a new version. | M | `v060-1`, `v040-3`, `v040-6` |
| `v060-3` | **Budgets engine**<br>Budgets per agent, model, session, user or tag with period, currency, basis (reported only, or reported plus estimated, labelled) and warning and limit thresholds; the server computes the state (ok, warning, exceeded, unknown when cost is unknown) and exposes it in the snapshot and `GET /api/v1/budgets`. | M | `v060-2` |
| `v060-4` | **Budget alerts delivery**<br>Threshold crossings emit a server event and an optional signed outbound webhook with retries; alerts are deduplicated per budget and period. | S | `v060-3` |
| `v060-5` | **Library: budget state via host props**<br>New `budgetStateByAgent` prop (ok, warning, exceeded, unknown, plus an optional label); desks render amber or red with a text alternative, not by color alone; the component never compares spend with a limit; hidden unless enabled. | S | `v050-1` |
| `v060-6` | **Portal: pricing and budgets UI**<br>The pricing tab in Model Ops and the settings pricing editor read and write the server table instead of local state; budget management UI; desks colored from the server budget state through the library prop. | M | `v060-2`, `v060-3`, `v060-5` |
| `v060-7` | **Latency percentiles and error rates per model**<br>Rollups add p50 and p95 latency computed from real `latencyMs` only (rows without it excluded and counted), failure rate by error kind from `llm.failed`, and rate-limit counts, shown in Model Ops with sample sizes. | M | `v040-3` |
| `v060-8` | **0.6.0 docs and release**<br>Pricing guide (how estimates work and what is never assumed), budgets and alerts guide, webhook signature docs; publish. | S | `v060-4`, `v060-6`, `v060-7` |


## 0.7.0: Automatic capture and interoperability

### Goal

Usage arrives without hand-written instrumentation: OTLP traces with GenAI conventions, packaged LangGraph and OpenAI Agents adapters, SDK queues that survive server outages, and a `/metrics` export so existing monitoring stacks can scrape tokens and cost.

### Exit criteria

- Recorded OTLP trace fixtures from at least two GenAI instrumentations map to ledger rows with correct token kinds and no invented cost.
- The LangGraph and OpenAI Agents adapters are installable packages and capture tokens for every model call in their example runs (call count equals provider responses).
- With the server down for 10 minutes, both SDKs deliver every queued event afterwards with zero duplicates in the ledger.
- `GET /metrics` passes `promtool check metrics` and its counters match the rollups for the golden fixture.

### Work items

| ID | Work item | Effort | Depends on |
|---|---|---|---|
| `v070-1` | **OTLP traces receiver with GenAI semantic conventions**<br>`POST /v1/traces` (http/json and http/protobuf) maps `gen_ai` spans to `llm.usage` or `llm.failed` (tokens, cache attributes when present, model, latency from span duration) keeping `traceId` and `parentId`, and tool spans to tool events; deterministic ids; no cost unless the span reports it. | L | `v040-1`, `v040-10` |
| `v070-2` | **Event log parser: OTLP traces import**<br>`parseEventLog` converts `resourceSpans` files with the v070-1 mapper instead of reporting "not supported"; update the README "What it is not" section. | S | `v070-1`, `v040-11` |
| `v070-3` | **Packaged LangGraph adapter**<br>Turn the LangGraph example into a published package that captures node, tool and model usage with `requestId`, cache tokens and trace ids from callbacks; tests with recorded runs. | L | `v040-1` |
| `v070-4` | **Packaged OpenAI Agents adapter**<br>Turn the OpenAI Agents example into a published package using the SDK tracing processor to emit agents, tools, `llm.usage` and `llm.failed`; tests with recorded runs. | L | `v040-1` |
| `v070-5` | **Durable local queue in the Python SDK**<br>Optional bounded disk spool for events that fail after retries, replayed in order with their original ids when the server returns; size cap with explicit drop counters; tests with the server down. | M | `v030-15` |
| `v070-6` | **Durable local queue in the TypeScript SDK**<br>Same behaviour as v070-5 for Node (file spool) and an in-memory bounded queue for browsers; shared test scenarios. | M | `v030-15` |
| `v070-7` | **Prometheus `/metrics` export**<br>Optional, auth-protected `GET /metrics` with counters for tokens by kind, reported and estimated cost by currency (never summed across currencies), calls and failures by model and error kind, ingestion and duplicate counts, and latency histograms; optional OTLP metrics push. | M | `v040-3`, `v060-2` |
| `v070-8` | **0.7.0 docs and release**<br>Update the maturity table (packaged versus example adapters), OTLP setup guides, SDK queue configuration and a Prometheus scrape example; publish packages. | S | `v070-2`, `v070-3`, `v070-4`, `v070-5`, `v070-6`, `v070-7` |


## 0.8.0: Formal audit

### Goal

The history becomes tamper-evident and attributable: a verifiable hash chain over every stored event, named ingestion keys recorded per event, read-only auditor access, retention and redaction that keep the chain verifiable, and an offline-verifiable audit bundle.

### Exit criteria

- Changing, deleting or reordering any stored event or ledger row is detected by `agent-viewer verify` and the verify API (mutation tests).
- Every event and ledger row records the id of the key that submitted it.
- Auditor keys get 403 on every write endpoint and full read access to the ledger, rollups and exports.
- After a retention purge the chain still verifies through tombstones.
- An exported audit bundle verifies offline on a machine without the server.

### Work items

| ID | Work item | Effort | Depends on |
|---|---|---|---|
| `v080-1` | **Hash chain over stored events**<br>A migration adds `prev_hash` and `hash` (over canonical JSON, `received_at` and submitter id) computed in the insert transaction; existing data starts from a recorded genesis checkpoint; memory mode documents that it is not tamper-evident. | L | `v030-2`, `v040-2` |
| `v080-2` | **Chain verification and signed checkpoints**<br>An `agent-viewer verify` CLI command and `GET /api/v1/audit/verify` report the first broken link; periodic checkpoints signed with a server key and exportable. | M | `v080-1` |
| `v080-3` | **Named ingestion keys and submitter identity**<br>Multiple named API keys (stored hashed) replace the single shared token; each accepted event and ledger row records the submitting key id; key management CLI and API. | M | `v040-8` |
| `v080-4` | **Scoped keys: read-only auditor role**<br>Key scopes `ingest`, `read`, `audit` and `admin`; auditor keys can read the ledger, rollups, exports and verification but never write or change pricing, budgets or retention. | M | `v080-3` |
| `v080-5` | **Chain-compatible retention and redaction**<br>Retention purges and later redactions replace payloads with tombstones that keep the original hash so the chain verifies; the redaction rule version is recorded per row; purge and redaction actions are themselves chained audit events; a legal hold flag stops purges. | M | `v080-1`, `v040-5`, `v040-7` |
| `v080-6` | **Offline-verifiable audit bundle**<br>Export of ledger rows, events, chain hashes, checkpoints and the pricing versions used, plus a standalone verifier script; documented format. | M | `v080-2`, `v080-5` |
| `v080-7` | **0.8.0 docs, threat model and release**<br>Audit guide, key management, threat model (what the chain proves and what it does not, memory mode limits) and migration notes from the single token; publish. | S | `v080-4`, `v080-6` |

## Out of scope

These are deliberate decisions, not postponed work:

- **Prices or arithmetic inside the embeddable library.** Pricing lives on the server. The component only displays figures its host gives it.
- **Currency conversion, or borrowing another model's price** when a price is missing. A missing price is an unknown estimate.
- **Mixing estimated and billed cost** into one number.
- **Evaluations and datasets.** Agent Viewer observes consumption; it does not grade outputs.
- **Becoming a proxy** between the agent and the AI provider. Usage is reported by the runtime or captured from telemetry; traffic never goes through Agent Viewer.
- **Replacing the office with a generic charts dashboard.** The office stays the hero view and spend is shown in it.
- **Recording private model reasoning, prompts or message text** in the usage ledger.

## How to contribute

1. Pick a work item by id (for example `v030-13`). Items with no dependencies, or whose dependencies are already merged, can start now. Small items (S) are a good first contribution.
2. Open or claim the matching issue before you write code, and say in it which item you are taking. If the issue does not exist yet, [open one](https://github.com/jmmana/Agent-Viewer/issues/new) that references the item id.
3. Follow [CONTRIBUTING.md](../.github/CONTRIBUTING.md) and the [code of conduct](../.github/CODE_OF_CONDUCT.md), and run the same checks as CI before opening the pull request.
4. Keep to the [principles](#principles). A pull request that turns an unknown into zero, mixes currencies, or adds arithmetic to the library will be asked to change.
5. Tests are part of the item. Several items add cases to the golden reconciliation suite (`v030-19`); add yours there.

Disagree with the order, the scope of an item, or a release's exit criteria? Say so in an issue. The roadmap is a living document and changes land through pull requests to this file.
