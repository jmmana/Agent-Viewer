# OTLP/HTTP receivers: logs and metrics

`POST /v1/logs` is a server-side OpenTelemetry logs receiver. It is the only documented way Claude Code
reports per-request tokens and cost (see [Tokens and cost](claude-code.md#tokens-and-cost) for how to turn it
on with `agent-viewer install claude-code --telemetry`), so this item turns that telemetry into the same
`llm.usage` and `llm.failed` canonical events every other ingestion route produces. It never computes a price
or invents a figure: everything stored here comes straight from what Claude Code reported.

`POST /v1/metrics` (issue #73) is a second, independent OpenTelemetry receiver for Claude Code's metric
counters (`claude_code.token.usage`, `claude_code.cost.usage`). It is the cheapest cross-check an audit tool
can have: the logs receiver above turns each `api_request` into a ledger row, and the metrics receiver stores
the same consumption as reported by a second, independent counter. The two are kept strictly apart: a metric
point is never turned into a canonical event, never added to the ledger, the snapshot totals, SSE or any
rollup. See [OTLP metrics](#otlp-metrics-post-v1metrics) below.

Both routes accept `http/json` and, since issue #73, `http/protobuf` (see
[http/protobuf](#httpprotobuf-issue-73)); gRPC is not supported.

This is server-side ingestion only. The embeddable library is unaffected: it still never invents, sums or
prices usage, and keeps receiving figures from the host through props.

## Endpoint

```
POST /v1/logs
POST /v1/metrics
```

At the server root, not under `/api/v1`: this is the default OTLP/HTTP path, so
`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8787` (or whatever host and port the office runs on) works with
the CLI, `npm run server` and the Docker image alike without any extra configuration; exporters append
`/v1/logs` and `/v1/metrics` to that base themselves. `src/integrations/otelConstants.ts` exports both paths
as `OTLP_LOGS_PATH` and `OTLP_METRICS_PATH`, shared with the Claude Code telemetry installer
(`cli/claudeInstall.ts`, which writes the matching endpoint variables), so the sides cannot drift apart.

## Middleware order

Mounted before the server's global body parser, with its own chain per route, in this exact order:

1. Rate limiter (same per-IP, per-minute window as `/api/v1`).
2. Token check (same decision as `/api/v1`, see Auth below).
3. Content-Type and Content-Encoding check.
4. This route's own size-limited body parser (JSON or protobuf, picked by Content-Type).
5. Shape and count check.
6. The handler.

This order is deliberate: a request with a wrong token and a malformed body gets `401`, not `400`, and an
unauthenticated request's body is never parsed at all.

## Auth

Shares the exact same decision as `/api/v1` (`isRequestAuthorized` in `server/index.ts`, factored out of the
original `/api/v1` check so every OTLP route stays identical): `Authorization: Bearer <AGENT_VIEWER_API_TOKEN>`
only. A `token` or `api_key` query parameter never authenticates, on either route (issue #71). OTLP exporters
set it through `OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <token>"` (or the per-signal
`OTEL_EXPORTER_OTLP_LOGS_HEADERS`/`OTEL_EXPORTER_OTLP_METRICS_HEADERS`). Without a configured token the route
is open, exactly like `/api/v1` (the office prints a loud startup warning in that case, see
[the open-API warning](../README.md)). The response shape differs by route: `/v1/logs` and `/v1/metrics` answer
OTLP-style (`{"code":16,"message":"Valid Bearer token required"}`, or the protobuf `google.rpc.Status`
equivalent for a protobuf request), `/api/v1` keeps its own `{"error":"unauthorized",...}` body.

## Limits

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_VIEWER_OTLP_MAX_BODY` | `5mb` | Any size string `body-parser` accepts (for example `10mb`, `512kb`). Applies to the decoded size: a gzip body can be much larger on the wire. Shared by `/v1/logs` and `/v1/metrics`. An invalid value falls back to the default. |
| `AGENT_VIEWER_OTLP_MAX_RECORDS` | `5000` | Maximum log records per `/v1/logs` request (every `resourceLogs[].scopeLogs[].logRecords[]`), or data points per `/v1/metrics` request (every `resourceMetrics[].scopeMetrics[].metrics[].sum.dataPoints[]`). An invalid or non-positive value falls back to the default. |
| `AGENT_VIEWER_TELEMETRY_MAX_POINTS` | `100000` | Memory-mode cap on stored `/v1/metrics` points (SQLite mode is bounded by disk, not by this). Once full, further points are rejected through `partialSuccess`, never dropped silently. |

gzip and deflate request bodies are decoded automatically; brotli (`content-encoding: br`) is also accepted by
the underlying `body-parser` version this server uses. Anything else gets `415`.

## Status codes

Exporters only retry `429`, `502`, `503` and `504`, so everything else is final from the exporter's point of
view. `/v1/metrics` follows the exact same table, with `resourceMetrics`/`rejectedDataPoints` in place of
`resourceLogs`/`rejectedLogRecords` and its own unsupported-media message naming `/v1/metrics`:

| Case | Status | Body |
|---|---|---|
| Accepted, including a request where every record was ignored or unknown, and `{"resourceLogs":[]}` | `200` | `{}` (or an empty protobuf message for a protobuf request) |
| Some records invalid or unattributed | `200` | `{"partialSuccess":{"rejectedLogRecords":"2","errorMessage":"..."}}` |
| Malformed JSON, malformed protobuf, a corrupt compressed body, or a body without the expected top-level array | `400` | `{"code":3,"message":"Expected an OTLP ExportLogsServiceRequest with resourceLogs"}` (protobuf `google.rpc.Status` for a protobuf request) |
| Missing or wrong token | `401` | `{"code":16,"message":"Valid Bearer token required"}` |
| Body over `AGENT_VIEWER_OTLP_MAX_BODY` (decoded size) or over `AGENT_VIEWER_OTLP_MAX_RECORDS` | `413` | `{"code":3,"message":"OTLP request exceeds <limit> or <n> log records"}` |
| `Content-Type` other than `application/json` or `application/x-protobuf`, or an unsupported `Content-Encoding` | `415` | `{"code":3,"message":"Agent Viewer accepts OTLP http/json or http/protobuf on /v1/logs, uncompressed or gzip. Set OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json or http/protobuf."}` |
| Rate limited | `429` + `Retry-After` | The same body the rate limiter always sends (`{"error":"rate_limit_exceeded",...}`); the header is what matters to an exporter. |
| The store failed to write | `503` | `{"code":14,"message":"Storage unavailable, retry"}` |

`rejectedLogRecords`/`rejectedDataPoints` is a string, matching OTLP's own int64-as-string convention. Every
error and `partialSuccess` message is built only from fixed text, known event or metric names and counts: it
never repeats request content, so it is always safe to log or display.

## Mapping

Only `claude_code.api_request` and `claude_code.api_error` are mapped. The parser reads an explicit
allowlist of attributes and nothing else: `session.id`, `event.name`, `event.timestamp`, `event.sequence`,
`model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`,
`cost_usd_micros`, `duration_ms`, `request_id`, `client_request_id`, `status_code`, `attempt`, plus
`timeUnixNano`/`observedTimeUnixNano`. Everything else (emails, account and organization ids, `prompt`,
`response`, `error`, `tool_*`, `vcs.*`, raw request/response bodies) is never copied, logged or stored. The raw
`session.id` is hashed through the same identity `cli/claudeHook.ts` uses
(`src/integrations/claudeCodeIdentity.ts`), so a hook event and a telemetry record from the same session land
on the same agent; the raw value itself never leaves this function.

Both event types resolve to the session's main agent (`runtimeId: "claude-code"`, `agentId` and `source`
derived from the hashed session id). OTLP carries no subagent instance id for these events, so every call,
including one Claude Code attributes to a subagent, is counted on the main agent; per-subagent attribution is
a later item.

### `claude_code.api_request` to `llm.usage`

| Canonical field | Source | Notes |
|---|---|---|
| `provider` | constant | `"Anthropic"` |
| `model` | `model` | Required, cut to 100 characters. Missing means invalid. |
| `inputTokens` | `input_tokens + cache_read_tokens + cache_creation_tokens` | See "Why inputTokens includes cache tokens" below. `input_tokens` missing or not a non-negative integer means invalid. |
| `outputTokens` | `output_tokens` | Required non-negative integer; missing means invalid. |
| `cacheReadTokens` | `cache_read_tokens` | Non-negative integer, left out when absent. |
| `cacheWriteTokens` | `cache_creation_tokens` | Non-negative integer, left out when absent. |
| `latencyMs` | `duration_ms` | Non-negative integer, left out when absent. |
| `requestId` | `request_id` | As sent, left out when absent. Feeds the `(provider, requestId)` dedup. |
| `cost` | `cost_usd_micros / 1e6`, else `cost_usd` | `null` when both are absent. A negative or non-finite value makes the whole record invalid, never silently `null`. |
| `costSource` | constant | `"estimated"` when a cost is present, `"unknown"` otherwise. |
| `currency` | constant | `"USD"` when a cost is present, left out otherwise. |

`reasoningTokens` is never set: Claude Code does not report it.

**Why `inputTokens` includes cache tokens.** Anthropic's own accounting treats `input_tokens`,
`cache_read_tokens` and `cache_creation_tokens` as three separate, non-overlapping counters: a long
conversation can have a tiny `input_tokens` (just the newest turn) next to a huge `cache_read_tokens` (the
rest of the history, replayed from cache). The canonical contract's `LlmUsagePayloadSchema` (added before this
receiver) assumes the opposite: `cacheReadTokens + cacheWriteTokens` must never exceed `inputTokens`, because
for the providers it was designed against, a cache hit is a subset of the tokens billed as input (see the
`cacheReadTokens` comment in [docs/integration.md](integration.md)). Rather than relax that shared,
already-tested invariant, the receiver folds Claude Code's cache counters into `inputTokens` on the way in, so
the stored figure means "every prompt-side token Anthropic counted for this call", consistent with every other
source of `llm.usage`. The real, separate `cache_read_tokens`/`cache_creation_tokens` values are still kept in
their own fields, unchanged.

### `claude_code.api_error` to `llm.failed`

| Canonical field | Source | Notes |
|---|---|---|
| `provider` | constant | `"Anthropic"` |
| `model` | `model` | Left out when absent (for example a connection failure before a model was chosen). Never invented. |
| `requestId` | `request_id` | Left out when absent. |
| `httpStatus` | `status_code` | Left out when absent. |
| `errorKind` | `status_code`, see table below | |
| `attempts` | `attempt` | Left out when absent. |
| `latencyMs` | `duration_ms` | Left out when absent. |

The free-text `error` attribute is never read: provider error messages can echo prompts or credentials.

| `status_code` | `errorKind` |
|---|---|
| (absent) | `network` |
| `429` | `rate_limited` |
| `529` | `overloaded` |
| `401`, `403` | `auth` |
| `400`, `404`, `413` | `invalid_request` |
| other `5xx` | `server_error` |
| anything else | `unknown` |

`network` was added to the canonical `LlmErrorKind` vocabulary by this item: the existing set (from issue #46)
had no value for "never got an HTTP response at all", and `timeout` already means something more specific (a
request that did get a response, just too slowly, or was cancelled locally).

### Everything else

- **Ignored** (known, not mapped by this release): `user_prompt`, `assistant_response`, `tool_result`,
  `tool_decision`, `api_refusal`, `api_retries_exhausted`, `api_request_body`, `api_response_body`,
  `subagent_completed`, `compaction`, the hook/plugin/MCP/auth/settings events.
- **Unknown**: any event name not in the ignored list above, or a record whose resource `service.name` is
  neither `claude-code` nor `claude-code-desktop`.
- **Unattributed**: an `api_request`/`api_error` record with no `session.id` on the record or the resource.
- **Invalid**: an `api_request`/`api_error` record that fails the field rules above, or the shared canonical
  validator.

## Deterministic, idempotent ids

```
id = "evt_cc_otlp_" + sha256([
  "cc-otlp-1", rawSessionId, eventName, requestId, clientRequestId, eventTimestamp, eventSequence,
  timeUnixNano, model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, cost, durationMs,
  statusCode, attempt,
]).slice(0, 32)
```

Every input is the normalized, pre-combination value read from the wire (the raw `input_tokens`, not the
`inputTokens` the stored payload ends up with). The id depends only on this content: no clock, no counter, no
random value. An exporter retry resends the same bytes, so it produces the same id and the store reports it as
a duplicate; a request that failed partway through a batch is therefore safe to retry in full. The `_otlp_`
segment keeps these ids from ever colliding with the Claude Code hook's own ids (`evt_cc_<hash>`, no `otlp`
segment).

**Known limit**: two distinct records with identical content and no `request_id`, `event.sequence` or
timestamp to tell them apart would collapse into the same id. Claude Code sends `event.sequence` and
`request_id` on every real capture, so this has not been observed in practice.

## Counters: `GET /api/v1/otlp/stats`

Behind the normal `/api/v1` auth. Per-process, reset on restart, like `store.ingestionCounters()`:

```json
{
  "since": 1767225600000,
  "requests": { "accepted": 42, "rejected": 1 },
  "logRecords": {
    "received": 380,
    "mapped": 51,
    "duplicates": 3,
    "ignored": 310,
    "unknown": 12,
    "unattributed": 3,
    "invalid": 1
  },
  "mappedByType": { "llm.usage": 49, "llm.failed": 2 },
  "unknownEventNames": { "claude_code.some_new_event": 12 }
}
```

Invariant: `received = mapped + duplicates + ignored + unknown + unattributed + invalid`. `requests.rejected`
counts any non-2xx response of the route after auth (`400`, `413`, `415`, `503`); `401` and `429` are not
counted, since they never reach the route's own logic. The counters hold no token or cost sums. `since` is the
process start time. `unknownEventNames` holds at most 50 distinct names, each cut to 100 characters, and
nothing else from the record; with `AGENT_VIEWER_DEBUG=1` the server also logs one line per newly observed
unknown name, never record content.

## http/protobuf (issue #73)

Real OpenTelemetry exporters, Claude Code included, commonly default to `http/protobuf`. Both routes accept
`Content-Type: application/x-protobuf` (OTLP's wire format for `ExportLogsServiceRequest` and
`ExportMetricsServiceRequest`), decoded by a small zero-dependency reader
(`server/otlp/protobufWire.ts`, `server/otlp/otlpProtobuf.ts`) built directly from the
`opentelemetry-proto` v1 field-number table, not from a protobuf library: Agent Viewer's runtime dependencies
stay at `express`, `lucide-react` and `zod`. The decoder understands varint, 64-bit, length-delimited and
32-bit wire types, skips unknown fields, rejects wire types 3/4 (protobuf groups), rejects a truncated field,
and caps message nesting at 16 levels.

Once decoded, a protobuf body is normalized into the exact same shape the JSON mapper already reads
(lowerCamelCase keys, `int64`/`fixed64` as decimal strings, enums as integers), so `server/otlp/logs.ts` and
`server/otlp/metrics.ts` have exactly one code path regardless of which wire format arrived; a committed test
(`tests/otlp-protobuf.test.mjs`) asserts the JSON and protobuf fixtures under `tests/fixtures/otlp/` normalize
to the same result. A protobuf request gets a protobuf response (`Content-Type: application/x-protobuf`),
including for `partialSuccess` and error bodies.

gRPC is not supported: point `OTEL_EXPORTER_OTLP_PROTOCOL` (or the per-signal
`OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`/`OTEL_EXPORTER_OTLP_METRICS_PROTOCOL`) at `http/protobuf` or `http/json`.

## OTLP metrics: `POST /v1/metrics` (issue #73)

Claude Code's OTLP metrics stream is a second, independent measurement of the same consumption `/v1/logs`
turns into `llm.usage`/`llm.failed`: the cheapest cross-check an audit tool can have. Only two metric names are
stored; every other metric Claude Code exports (session counts, lines of code, active time, and so on) is
ignored without error:

| OTLP metric | Stored as | Notes |
|---|---|---|
| `claude_code.token.usage` | a `tokens` point | The `type` attribute selects which token kind (see the mapping table below). |
| `claude_code.cost.usage` | a `cost` point | Unit `USD` stores `currency: "USD"`; any other unit stores `currency: null` and the point is excluded from a future cost comparison, though it is still stored. |

`type` attribute mapping (`server/otlp/metricsMap.ts`, normalized lowercase with `_` stripped before matching):

| `type` | Field |
|---|---|
| `input` | `input` |
| `output` | `output` |
| `cacheread` (also `cache_read`) | `cacheRead` |
| `cachecreation` (also `cache_creation`) | `cacheCreation` |
| anything else, or missing | stored as given, listed in the unmapped-types count, never summed |

**Only a monotonic `Sum` is accepted.** A `Gauge`, `Histogram`, `ExponentialHistogram`, `Summary`, or a
non-monotonic `Sum`, for either tracked name, is rejected (counted in `partialSuccess`, never stored).
`aggregationTemporality` must be `1` (delta) or `2` (cumulative); `0` (unspecified) or anything else is
rejected. A point with the no-recorded-value flag (`flags` bit 0) is ignored, not rejected: it is simply not
stored, and does not count against `partialSuccess`. A value must be a non-negative number at or below 2^53,
finite, and (for a token count) a whole number; anything else is rejected, while the rest of the request is
still processed.

**Idempotency.** The unique key is `(series_key, start_time_unix_nano, time_unix_nano)`. A retried point with
the same value is a harmless duplicate (not re-counted, not reported as rejected). The same key reported again
with a *different* value is a conflicting duplicate: the first value is kept, and the retry is counted in
`partialSuccess.rejectedDataPoints` with a message, the same spirit as the logs receiver's own
`conflicting_duplicate` handling.

**Temporality.** Points are stored raw and resolved at query time: a `delta` series totals the sum of its
points, a `cumulative` series totals the latest value of each counter lifetime (grouped by
`start_time_unix_nano`), so a process restart (a new lifetime starting lower than the old one ended) adds the
new epoch's total instead of ever producing a negative number. This math lives in `server/telemetry.ts`
(`sumSeriesValue`, covered by a property test against random delta and cumulative sequences in
`tests/telemetry.test.mjs`) and is the one place a future reconciliation endpoint will read from.

**Privacy and the series key.** Only an allowlist is stored: the hashed session id (same identity as the hooks
and the logs receiver), `model`, `type`, and the resource's `service.name`/`service.version`. The raw
`session.id`, `user.email`, `user.account_uuid`, `organization.id` and any other attribute never reach storage
or a response. `series_key` (used only for deduplication and series identity, never returned by any endpoint)
is an `HMAC-SHA256` of the metric name and *every* resource and point attribute (not just the stored ones), so
two series that differ only in a dropped attribute are never merged into one. The HMAC secret is a random
32-byte value generated on first use and persisted (SQLite: a `telemetry_meta` row; memory mode: per process),
so it is never recoverable from the key and survives a restart.

**Kept apart from the ledger, on purpose.** A metric point never becomes a canonical event, is never summed
into `GET /api/v1/snapshot`, never appears on `GET /api/v1/events/stream` (SSE) or in a `--record` capture, and
never changes `store.usageSummary()`. Storage is its own table (`telemetry_metric_points`, `telemetry_meta`,
added by migration 5), queried through `EventStore.appendTelemetryPoints`/`listTelemetryPoints`, never through
the event-store's own append path.

**Deferred: `GET /api/v1/usage/reconciliation`.** The original proposal for this item also adds an endpoint
that compares the ledger's per-session totals against these metric totals and reports `match`/`drift`/
`incomplete`/etc. per field. That endpoint needs the usage ledger accessor from issue #65 (a ledger table with
the server receive time), which was still open, unmerged, when this item was built: building a reconciliation
endpoint against a ledger accessor that does not exist would mean guessing its shape twice. `sumTelemetryBySession`
in `server/telemetry.ts` is the metrics-side half that endpoint will consume once #65 lands; nothing about it
should need to change to support that.

## Out of scope

- gRPC transport (see [http/protobuf](#httpprotobuf-issue-73) above).
- OTLP traces (`/v1/traces`).
- Offline import of OTLP logs or metrics files in `parseEventLog` (issue #74).
- Attribution per subagent, per prompt or per skill.
- `GET /api/v1/usage/reconciliation` (see "Deferred" above; depends on issue #65).
- Pricing or re-estimating cost on the server: the figures stored here are exactly what Claude Code reported.
