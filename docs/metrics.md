# Prometheus metrics (`GET /metrics`)

`GET /metrics` (issue #103) serves the Prometheus text exposition format 0.0.4. It is off by default: enable it
with `AGENT_VIEWER_METRICS=1` (CLI: `--metrics`), and scrape it with `Authorization: Bearer <token>`, where the token
is `AGENT_VIEWER_METRICS_TOKEN` when set, else the API token. `AGENT_VIEWER_METRICS_AUTH=off` disables the
credential check for a private network or sidecar scrape. The route has its own rate-limit bucket and is never
CORS-enabled. See [cli.md](cli.md) for the flag and the README configuration table for every variable.

Every family below is in-process: computed by the server itself, reset only by a restart, and never read from the
ledger.

## Server state

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
| `unauthorized` | A missing or wrong Bearer token (`401`), an invalid stream ticket, a `token` query parameter (never accepted), an open-mode guard `403`, or `/metrics`'s own `401`/`403 metrics_require_token`. |
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

Example queries:

```promql
# Accepted events per second, by type
sum by (type) (rate(agent_viewer_events_accepted_total[5m]))

# Rejection ratio per endpoint
sum by (endpoint) (rate(agent_viewer_events_rejected_total[5m]))

# p95 handling time per route
histogram_quantile(0.95, sum by (le, route) (rate(agent_viewer_http_request_duration_seconds_bucket[5m])))
```
