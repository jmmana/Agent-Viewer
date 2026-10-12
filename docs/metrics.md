# Prometheus metrics (`GET /metrics`)

Agent Viewer can serve its own metrics in the Prometheus text exposition format 0.0.4. The endpoint is off by default.

```bash
AGENT_VIEWER_METRICS=1 AGENT_VIEWER_METRICS_TOKEN=scrape-secret npx @warlockcode/agent-viewer
curl -H 'Authorization: Bearer scrape-secret' http://127.0.0.1:8787/metrics
```

```yaml
# prometheus.yml
scrape_configs:
  - job_name: agent-viewer
    authorization:
      credentials: scrape-secret
    static_configs:
      - targets: ['127.0.0.1:8787']
```

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `AGENT_VIEWER_METRICS` | off | `1`/`true`/`yes`/`on` serves `/metrics`. When off, `/metrics` is a plain 404. |
| `AGENT_VIEWER_METRICS_TOKEN` | the API token | Bearer token scrapers must send. A token in the query string is ignored. |
| `AGENT_VIEWER_METRICS_AUTH` | on | `off` serves `/metrics` without a token. |
| `AGENT_VIEWER_METRICS_RATE_LIMIT` | `120` | Requests per minute per client IP, separate from `/api/v1`'s limit. |
| `AGENT_VIEWER_METRICS_MAX_MODELS` | `100` | Distinct provider/model pairs that get their own labels, in order of first appearance in the ledger. Every pair after that is reported as `provider="__other__",model="__other__"`. |
| `AGENT_VIEWER_METRICS_CACHE_MS` | `5000` | How long one ledger query serves scrapes. Scrapes that arrive while a query is running wait for that query instead of starting another. `0` queries on every scrape (concurrent scrapes still share one query). |

## Families

### Process

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `agent_viewer_build_info` | gauge | `version`, `storage` | Always `1`. |
| `agent_viewer_sse_clients` | gauge | | Open SSE connections. |
| `agent_viewer_events_accepted_total` | counter | `channel` | Events stored by `POST /api/v1/events` (`events`), `/api/v1/events/batch` (`events-batch`) and `/api/v1/webhooks/generic` (`webhook`). |
| `agent_viewer_events_duplicate_total` | counter | `channel` | Events recognized as a retry of an already stored event. |
| `agent_viewer_events_rejected_total` | counter | `channel`, `reason` | Refused events or requests. `reason` is `conflict` (same id, different content), `invalid`, `unauthorized`, `too_large`, `unsupported_media_type`, `rate_limited`, `not_ready`, `error` or `other`. A batch that fails validation counts every one of its events as `invalid`; any other refused request counts once. |
| `agent_viewer_http_request_duration_seconds` | histogram | `method`, `route`, `code` | Every HTTP request, timed until its response finished. `route` is the route template (`/api/v1/agents/:id`), never the raw path; a request that matched no route is `unmatched`. |

The process counters start at zero when the server starts.

### Usage ledger

These are read from the usage ledger with the same sums as `GET /api/v1/usage/rollup` (no filters). They are totals over the rows the ledger still holds: after a retention purge (`AGENT_VIEWER_USAGE_RETENTION_DAYS`) they drop, which Prometheus treats as a counter reset. `agent_viewer_ledger_retained_since_seconds` says where the window starts.

| Name | Type | Labels | Meaning |
|---|---|---|---|
| `agent_viewer_tokens_total` | counter | `provider`, `model`, `kind` | Reported tokens. `kind` is `input`, `output`, `cache_read`, `cache_write` or `reasoning`. |
| `agent_viewer_token_kind_unreported_calls_total` | counter | `provider`, `model`, `kind` | Calls that did not report that kind of token. These are never added to `agent_viewer_tokens_total` as zero. |
| `agent_viewer_cost_reported_total` | counter | `provider`, `model`, `currency` | Cost with `costSource: provider-reported`. |
| `agent_viewer_cost_estimated_total` | counter | `provider`, `model`, `currency` | Cost the client sent with `costSource: estimated`. The server's own pricing-table estimate (`docs/pricing.md`) is not included. |
| `agent_viewer_cost_unknown_calls_total` | counter | `provider`, `model` | Calls with no cost, or `costSource: unknown`. |
| `agent_viewer_llm_calls_total` | counter | `provider`, `model`, `status` | `llm.usage` and `llm.failed` calls. `status` is `ok` for a successful call, the error kind for a failed one. |
| `agent_viewer_llm_failures_total` | counter | `provider`, `model`, `error_kind` | `llm.failed` calls. A missing or `unknown` error kind is `unspecified`. |
| `agent_viewer_llm_latency_seconds` | histogram | `provider`, `model` | Reported latency of `llm.usage` calls. Buckets: 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120 s. |
| `agent_viewer_ledger_retained_since_seconds` | gauge | | Receive time (Unix seconds) of the oldest ledger row. Absent while the ledger is empty. |
| `agent_viewer_ledger_last_usage_timestamp_seconds` | gauge | | Receive time (Unix seconds) of the newest ledger row. Absent while the ledger is empty. |

A missing provider, model or currency is labelled `unknown`. Costs are never summed across currencies.

## Errors

| Status | `error` | When |
|---|---|---|
| 401 | `unauthorized` | Missing or wrong Bearer token. |
| 403 | `metrics_require_token` | Auth is on but no token is configured. |
| 405 | `method_not_allowed` | Anything but `GET`/`HEAD`. |
| 429 | `rate_limit_exceeded` | Over `AGENT_VIEWER_METRICS_RATE_LIMIT`. |
| 503 | `metrics_unavailable` | The ledger query failed. The whole scrape fails, so Prometheus never stores a body with some families missing. A failed query is not cached; the next scrape tries again. |

Example queries:

```promql
# Tokens per model over the last hour
sum by (model) (increase(agent_viewer_tokens_total[1h]))
# p95 LLM latency
histogram_quantile(0.95, sum by (le, model) (rate(agent_viewer_llm_latency_seconds_bucket[5m])))
# Failure ratio
sum(rate(agent_viewer_llm_failures_total[5m])) / sum(rate(agent_viewer_llm_calls_total[5m]))
```
