# Prometheus metrics (`GET /metrics`)

`GET /metrics` (issue #103) serves the Prometheus text exposition format 0.0.4. It is off by default: enable it
with `AGENT_VIEWER_METRICS=1` (CLI: `--metrics`), and scrape it with `Authorization: Bearer <token>`, where the token
is `AGENT_VIEWER_METRICS_TOKEN` when set, else the API token. `AGENT_VIEWER_METRICS_AUTH=off` disables the
credential check for a private network or sidecar scrape. The route has its own rate-limit bucket and is never
CORS-enabled. See [cli.md](cli.md) for the flag and the README configuration table for every variable.

```bash
curl -H "Authorization: Bearer $AGENT_VIEWER_METRICS_TOKEN" http://localhost:8787/metrics
```

```yaml
# prometheus.yml
scrape_configs:
  - job_name: agent-viewer
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/agent-viewer.token
    static_configs:
      - targets: ["agent-viewer:8787"]
```

This export is read-only. The ledger-derived families below reuse the same server-side figures the usage ledger
(#65) already holds, through the rollup query (#66) and the export row stream (#69); it is never a second, less
careful aggregation path. The rules that protect the numbers everywhere else in this product apply here too:

- **Unknown is never zero.** A missing cost, an unreported token kind or an empty ledger never turns into a `0`
  sample; it is either omitted entirely or counted in a dedicated `*_unreported_calls_total`/`*_unknown_calls_total`
  family instead.
- **Currencies are never summed.** Every cost family carries a `currency` label; there is no combined
  "total cost" series, and a missing currency gets its own `currency="unknown"` series rather than being merged
  into another one.
- **Reported and estimated cost are never merged.** `agent_viewer_cost_reported_total` and
  `agent_viewer_cost_estimated_total` are separate families; nothing adds them together.
- **No unbounded-cardinality labels.** Only `provider`, `model`, `kind`, `currency`, `cost_kind`, `status`,
  `error_kind`, `le`, `type`, `method`, `route` and `status_class` ever appear. No agent id, task id, session id,
  `requestId`, user, tag or payload text. Per-agent attribution stays in the rollup API (#66), which is where that
  unbounded dimension belongs.

Every family has `# HELP` and `# TYPE`, even when it has zero samples (an absent series, not a zero).

## Ledger-derived metrics

Issue #348. Computed at scrape time from the usage ledger (#65), cached for `AGENT_VIEWER_METRICS_CACHE_MS`. They
survive a restart (SQLite mode) and respect the ledger's own deduplication (#47/#48: a call is one ledger row
regardless of how many times its event was resent). Rows are both `ok` and `failed` calls unless a family says
otherwise.

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `agent_viewer_tokens_total` | counter | `provider`, `model`, `kind` = `input\|output\|cache_read\|cache_write\|reasoning` | Tokens by kind, summed only over rows that **reported** that kind (including a partially billed failed call). |
| `agent_viewer_token_kind_unreported_calls_total` | counter | `provider`, `model`, `kind` | Rows where that kind was null (not reported). Shows "unknown" instead of a misleading `0`. |
| `agent_viewer_cost_reported_total` | counter | `provider`, `model`, `currency` | Sum of `cost` over rows with `costSource=provider-reported` and a non-null cost, one series per currency. A row with a cost but `costSource=unknown` is never summed here. |
| `agent_viewer_cost_estimated_total` | counter | `provider`, `model`, `currency` | Sum of the ledger's own ingestion-time estimate (#84), per currency. Never added to `agent_viewer_cost_reported_total`. |
| `agent_viewer_cost_unknown_calls_total` | counter | `provider`, `model`, `cost_kind` = `reported\|estimated` | **Successful** (`status=ok`) rows for which that cost kind is unknown: no cost, `costSource=unknown`, or no estimate (model not priced). |
| `agent_viewer_llm_calls_total` | counter | `provider`, `model`, `status` = `ok\|failed` | Model calls, one per ledger row (already deduplicated by `requestId` at ingestion time, so this never double-counts a resend). |
| `agent_viewer_llm_failures_total` | counter | `provider`, `model`, `error_kind` | Failed calls (`llm.failed`, #46). `error_kind` is the closed set `rate_limited, overloaded, timeout, invalid_request, auth, server_error, cancelled, unknown`; any other stored value folds into `unknown`. The sum over `error_kind` equals `agent_viewer_llm_calls_total{status="failed"}` for each `(provider, model)`. |
| `agent_viewer_llm_latency_seconds` | histogram | `provider`, `model` | Model-call latency from the reported `latencyMs` (not measured by the server), over both `ok` and `failed` rows. Rows without `latencyMs` are not observed, so `_count` can be lower than `agent_viewer_llm_calls_total`. Buckets: `0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, +Inf`. `_sum` is the sum of reported `latencyMs` divided by 1000. |
| `agent_viewer_ledger_retained_since_seconds` | gauge | none | Unix time (`received_at`) of the oldest retained ledger row. Omitted when the ledger is empty. |
| `agent_viewer_ledger_last_usage_timestamp_seconds` | gauge | none | Unix time (`received_at`) of the newest ledger row, for a "no usage received for N minutes" alert. Omitted when the ledger is empty, never a false `0`. |

Excerpt:

```text
# HELP agent_viewer_tokens_total Tokens reported by model calls, by kind. Summed only over rows that reported that kind; see agent_viewer_token_kind_unreported_calls_total for the rest.
# TYPE agent_viewer_tokens_total counter
agent_viewer_tokens_total{provider="anthropic",model="claude-sonnet-4",kind="input"} 1843200
agent_viewer_tokens_total{provider="anthropic",model="claude-sonnet-4",kind="cache_read"} 902112
# HELP agent_viewer_cost_reported_total Provider-reported cost, per currency. Never summed across currencies.
# TYPE agent_viewer_cost_reported_total counter
agent_viewer_cost_reported_total{provider="anthropic",model="claude-sonnet-4",currency="USD"} 18.4021
agent_viewer_cost_reported_total{provider="openai",model="gpt-4o",currency="EUR"} 3.1
agent_viewer_cost_unknown_calls_total{provider="anthropic",model="claude-sonnet-4",cost_kind="reported"} 12
agent_viewer_llm_failures_total{provider="openai",model="gpt-4o",error_kind="rate_limited"} 4
agent_viewer_llm_latency_seconds_bucket{provider="openai",model="gpt-4o",le="1"} 210
agent_viewer_llm_latency_seconds_bucket{provider="openai",model="gpt-4o",le="+Inf"} 260
agent_viewer_llm_latency_seconds_sum{provider="openai",model="gpt-4o"} 148.2
agent_viewer_llm_latency_seconds_count{provider="openai",model="gpt-4o"} 260
```

### Cardinality cap

`AGENT_VIEWER_METRICS_MAX_MODELS` (default `100`). The first N distinct `(provider, model)` pairs by **first
appearance in the ledger** keep their own series; the rest fold into `provider="__other__",model="__other__"`
(both labels, so an unbounded provider set cannot grow cardinality either). Ordering by first appearance, not by
volume, keeps series stable across scrapes: a top-N-by-volume scheme would make a counter appear to go backwards
whenever the ranking reshuffled. First appearance is recomputed from whatever the ledger currently holds, so if
retention (`AGENT_VIEWER_USAGE_RETENTION_DAYS`) ever purges the rows that first introduced a pair, a later scrape
can recompute a different "first N" from what remains; this is a documented, accepted edge case, not a bug.

Label hygiene: `provider` and `model` are stripped of control characters and capped at 100 characters (same
sanitizer as every other label, `server/metrics.ts`) **before** grouping, so two raw values that collapse to the
same sanitized string already merge into one series here, never two. A `null` provider or model (never reported
by the client) becomes the literal label `"unknown"`, mirroring the `currency="unknown"` convention above. (In
practice `provider` is required by the canonical contract and is never actually `null`; only `model` can be,
for an `llm.failed` row from a connection failure before a model was chosen, issue #59.)

### Scrape cost control

Ledger-derived families are computed with a `store.rollup()` call (to pin the ledger's current end-of-sequence and
read the global oldest/newest `received_at`) plus one pass over `store.iterateExportRows()` (the same streaming
primitive `GET /api/v1/usage/export` uses), and the result is cached for `AGENT_VIEWER_METRICS_CACHE_MS` (default
`5000`, `0` disables the cache). Concurrent scrapes within that window share one in-flight computation instead of
each re-querying the ledger. In-process families (below) are never cached. If the ledger query fails, the scrape
answers `503 {"error":"metrics_unavailable"}` (never a partial body missing the ledger families: an absent series
must not look like zero), and the failure is never cached, so the next scrape retries immediately.

This v1 reuses the same per-row streaming primitive the export endpoint already uses rather than a dedicated
grouped SQL aggregation; for a very large ledger (hundreds of thousands of rows), a future revision could add a
grouped query the way `server/usage/rollup.ts` does for the rollup endpoint. The cache bounds how often this
happens regardless.

### Retention and memory-mode caveats

- **Retention (#70).** Ledger rows have their own `AGENT_VIEWER_USAGE_RETENTION_DAYS`. A purge only ever removes
  rows; it never recomputes history into a smaller cumulative figure. If a purge removes enough of the ledger,
  these counters can only go down the way any Prometheus counter does after a restart: a wraparound Prometheus
  itself detects and handles as a reset. `agent_viewer_ledger_retained_since_seconds` makes a purge's effect
  visible on the next scrape.
- **Memory mode.** The usage ledger (its own array, capped independently by `AGENT_VIEWER_USAGE_LEDGER_MAX_ROWS`,
  default 100000) is a separate structure from the much smaller in-memory events ring buffer
  (`AGENT_VIEWER_MAX_EVENTS`): appending more events than the ring holds evicts old *events*, never ledger rows,
  so these families are never lowered by that eviction. Once the ledger's own cap is reached, further rows (and
  their skip decisions) are refused, same as every other ledger-backed read in this product; the ledger-derived
  families from that point on only reflect what was kept.
- **Pricing recompute (#296).** `agent_viewer_cost_estimated_total` reads each row's *currently stored* estimate.
  An explicit pricing recompute can change past rows' estimates, which appears as a step (up or down) in this
  counter rather than a steady increase. Alert on `increase()` over a bounded window, not on the counter's
  lifetime total, the same caveat `docs/pricing.md` gives for the rollup API's own `estimated` figures.

## Server state

Every family below is in-process: computed by the server itself, reset only by a restart, and never read from the
ledger.

| Family | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `agent_viewer_build_info` | gauge | `version`, `storage` (`memory` or `sqlite`) | Always `1`; the facts are in the labels. |
| `agent_viewer_sse_clients` | gauge | none | Open Server-Sent Events stream connections. |

## In-process ingestion counters

Issue #365. Counted by one middleware mounted before every body parser, rate limiter and auth check, so a request
rejected anywhere (including a malformed or oversized JSON body) is still observed. A failure inside this
instrumentation is caught and never changes the response a client gets.

| Family | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `agent_viewer_events_accepted_total` | counter | `type` | Canonical events newly stored by `store.append`/`appendBatch`, from every ingestion path (`/api/v1/events`, `/api/v1/events/batch`, `/api/v1/webhooks/generic`, `/v1/logs`, `/v1/traces`). |
| `agent_viewer_events_duplicate_total` | counter | `kind` = `identical` \| `conflicting` | An already-stored id sent again. `identical` is a safe retry (answered `200 duplicate`, or a duplicate item of a batch); `conflicting` is the same id with different content, not applied (`409 conflicting_duplicate`, a `conflict` item of a batch, or a webhook `409 event_id_conflict`). Counted per event, not per request. |
| `agent_viewer_events_rejected_total` | counter | `endpoint`, `reason` | A request refused before any event was stored. One increment per rejected request. |
| `agent_viewer_http_request_duration_seconds` | histogram | `method`, `route`, `status_class` | Server request handling time, from the first middleware to the end of the response. |

`endpoint` is derived from the request path (the middleware runs before any route matches): `events`,
`events_batch`, `webhook_generic`, `otlp_logs`, `otlp_metrics`, `otlp_traces`, `metrics`, or `other` for every
other path (for example a `401` on `GET /api/v1/sessions`).

`reason` is one of:

| `reason` | When |
| --- | --- |
| `validation` | The body parsed but failed validation: an invalid canonical event, a non-array batch, an invalid batch item, a reserved `budget.alert` type or id, an `Idempotency-Key` mismatch, an invalid webhook payload or idempotency key. |
| `empty_batch` | `POST /api/v1/events/batch` with zero events. |
| `batch_too_large` | More than `AGENT_VIEWER_MAX_BATCH_SIZE` events in one batch (`413`). |
| `malformed_json` | A body that is not valid JSON (`400 Malformed JSON payload`, or the OTLP receivers' body-parser errors). |
| `payload_too_large` | A body over the size limit (`413`, from the global JSON parser or an OTLP receiver), or an OTLP request over `AGENT_VIEWER_OTLP_MAX_RECORDS`. |
| `unrecognized_payload` | A webhook with no agent activity (`unrecognized_webhook_payload`), an OTLP body that is not the expected request shape or does not decode, or an unsupported OTLP content type (`415`). |
| `unauthorized` | A missing or wrong Bearer token (`401`), an invalid stream ticket, a `?token=` query, an open-mode guard `403`, or `/metrics`'s own `401`/`403 metrics_require_token`. |
| `rate_limited` | `429` from the `/api/v1`, OTLP or `/metrics` rate limiter. |
| `signature` | A webhook with missing or invalid `X-Agent-Viewer-Signature`/`X-Agent-Viewer-Timestamp` headers. |
| `replay` | A webhook whose timestamp is outside the replay window (`replay_detected_or_clock_skew`). |

A `409` conflict is not a rejection: it is counted as `agent_viewer_events_duplicate_total{kind="conflicting"}`.
Server-side failures (`5xx`, such as `503` storage unavailable) are not rejections either; they show up in the
duration histogram's `status_class="5xx"`.

The duration histogram:

- `route` is the Express route template, for example `/api/v1/sessions/:sessionId`, never the raw URL, so ids
  never become label values. A request no route matched (a `404`, or one rejected by middleware before any route
  ran) is `__unmatched__`.
- `status_class` is `2xx`, `3xx`, `4xx` or `5xx`.
- Buckets (seconds): `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10`, plus `+Inf`.
- `/metrics` itself is excluded, and so is the SSE stream `GET /api/v1/events/stream`, whose duration is the life
  of the connection rather than a handling time.

## PromQL examples

```promql
# Reported cost by currency, last 24h (never a bare sum(): that would add currencies together).
sum by (currency) (increase(agent_viewer_cost_reported_total[24h]))

# p95 latency per model, from the histogram.
histogram_quantile(0.95, sum by (le, provider, model) (rate(agent_viewer_llm_latency_seconds_bucket[5m])))

# Failure ratio by error_kind per model.
sum by (provider, model, error_kind) (rate(agent_viewer_llm_failures_total[5m]))
  /
  ignoring (error_kind) group_left
  sum by (provider, model) (rate(agent_viewer_llm_calls_total[5m]))

# Alert: no usage received for 30 minutes.
(time() - agent_viewer_ledger_last_usage_timestamp_seconds) > 1800

# Accepted events per second, by type
sum by (type) (rate(agent_viewer_events_accepted_total[5m]))

# Rejection ratio per endpoint
sum by (endpoint) (rate(agent_viewer_events_rejected_total[5m]))

# p95 handling time per route
histogram_quantile(0.95, sum by (le, route) (rate(agent_viewer_http_request_duration_seconds_bucket[5m])))
```

Recording rule example (daily reported cost per provider/model/currency, cheaper to graph over long ranges than
re-running `increase()` on the raw counter every time):

```yaml
groups:
  - name: agent-viewer-cost
    rules:
      - record: agent_viewer:cost_reported_total:increase1d
        expr: increase(agent_viewer_cost_reported_total[1d])
```
