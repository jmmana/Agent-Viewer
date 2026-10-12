# Prometheus `/metrics`

Issue #103 ("Prometheus `/metrics` export"), built across its own sub-issues:

- #350: the endpoint itself (`GET`/`HEAD /metrics`, opt-in, auth, rate limiting, CORS exclusion, CLI `--metrics`)
  and the two in-process families computable without a ledger query (`agent_viewer_build_info`,
  `agent_viewer_sse_clients`).
- #348 (this document): the ledger-derived families (tokens, cost, calls, failures, latency, two ledger gauges),
  the cardinality cap, the scrape cache and the `503` on a failing ledger query.
- A later sub-issue: the remaining in-process ingestion counters (`agent_viewer_events_accepted_total`,
  `agent_viewer_events_duplicate_total`, `agent_viewer_events_rejected_total`,
  `agent_viewer_http_request_duration_seconds`).
- A later sub-issue: the optional OTLP metrics push.

This export is read-only and reuses the same server-side figures the usage ledger (#65) already holds through the
rollup query (#66) and the export row stream (#69). It never becomes a second, less careful aggregation path, and
the rules that protect the numbers everywhere else in this product apply here too:

- **Unknown is never zero.** A missing cost, an unreported token kind or an empty ledger never turns into a `0`
  sample; it is either omitted entirely or counted in a dedicated `*_unreported_calls_total`/`*_unknown_calls_total`
  family instead.
- **Currencies are never summed.** Every cost family carries a `currency` label; there is no combined
  "total cost" series, and a missing currency gets its own `currency="unknown"` series rather than being merged
  into another one.
- **Reported and estimated cost are never merged.** `agent_viewer_cost_reported_total` and
  `agent_viewer_cost_estimated_total` are separate families; nothing adds them together.
- **No unbounded-cardinality labels.** Only `provider`, `model`, `kind`, `currency`, `cost_kind`, `status`,
  `error_kind` and `le` ever appear. No agent id, task id, session id, `requestId`, user, tag or payload text. Per-
  agent attribution stays in the rollup API (#66), which is where that unbounded dimension belongs.

## Enabling and scraping

Off by default. See the README's Configuration table for `AGENT_VIEWER_METRICS`, `AGENT_VIEWER_METRICS_TOKEN` and
`AGENT_VIEWER_METRICS_AUTH` (the endpoint, its auth model and its opt-in are #350's scope, documented there and in
the README; this document assumes the endpoint already answers and focuses on what it serves).

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

## Metric catalog

Names follow Prometheus conventions (`agent_viewer_` prefix, `_total` counters, base units in the name, seconds
for time). Every family has `# HELP` and `# TYPE`, even when it has zero samples (an absent series, not a zero).

### In-process (#350)

Reset on restart (Prometheus handles this as a counter reset for `agent_viewer_sse_clients`, which is a gauge, not
a counter, so it is simply re-read).

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `agent_viewer_build_info` | gauge (always `1`) | `version`, `storage` | Server version and storage mode. |
| `agent_viewer_sse_clients` | gauge | none | Open Server-Sent Events stream connections. |

### Ledger-derived (#348, this document)

Computed at scrape time from the usage ledger (#65), cached for `AGENT_VIEWER_METRICS_CACHE_MS`. They survive a
restart (SQLite mode) and respect the ledger's own deduplication (#47/#48: a call is one ledger row regardless of
how many times its event was resent). Rows are both `ok` and `failed` calls unless a family says otherwise.

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

### Deferred to later sub-issues

- `agent_viewer_events_accepted_total`, `agent_viewer_events_duplicate_total`,
  `agent_viewer_events_rejected_total`, `agent_viewer_http_request_duration_seconds` (in-process ingestion
  counters, not yet wired into `server/index.ts`'s request path).
- `agent_viewer_otlp_push_total`, `agent_viewer_otlp_push_last_success_timestamp_seconds` (only present once the
  optional OTLP metrics push ships).

A scrape today simply does not include these families; that is expected, not a bug.

## Cardinality cap

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

## Scrape cost control

Ledger-derived families are computed with a `store.rollup()` call (to pin the ledger's current end-of-sequence and
read the global oldest/newest `received_at`) plus one pass over `store.iterateExportRows()` (the same streaming
primitive `GET /api/v1/usage/export` uses), and the result is cached for `AGENT_VIEWER_METRICS_CACHE_MS` (default
`5000`, `0` disables the cache). Concurrent scrapes within that window share one in-flight computation instead of
each re-querying the ledger. If the ledger query fails, the scrape answers `503 {"error":"metrics_unavailable"}`
(never a partial body missing the ledger families: an absent series must not look like zero), and the failure is
never cached, so the next scrape retries immediately.

This v1 reuses the same per-row streaming primitive the export endpoint already uses rather than a dedicated
grouped SQL aggregation; for a very large ledger (hundreds of thousands of rows), a future revision could add a
grouped query the way `server/usage/rollup.ts` does for the rollup endpoint. The cache bounds how often this
happens regardless.

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

## Retention and memory-mode caveats

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
