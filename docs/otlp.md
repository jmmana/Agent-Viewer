# OTLP/HTTP logs receiver

`POST /v1/logs` is a server-side OpenTelemetry logs receiver. It is the only documented way Claude Code
reports per-request tokens and cost (see [Tokens and cost](claude-code.md#tokens-and-cost) for how to turn it
on with `agent-viewer install claude-code --telemetry`), so this item turns that telemetry into the same
`llm.usage` and `llm.failed` canonical events every other ingestion route produces. It never computes a price
or invents a figure: everything stored here comes straight from what Claude Code reported.

This is server-side ingestion only. The embeddable library is unaffected: it still never invents, sums or
prices usage, and keeps receiving figures from the host through props.

## Endpoint

```
POST /v1/logs
```

At the server root, not under `/api/v1`: this is the default OTLP/HTTP path, so
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:8787/v1/logs` (or whatever host and port the office runs
on) works with the CLI, `npm run server` and the Docker image alike without any extra configuration.
`src/integrations/otelConstants.ts` exports this path as `OTLP_LOGS_PATH`, shared with the Claude Code
telemetry installer (`cli/claudeInstall.ts`, which writes the matching `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`), so
the two sides cannot drift apart.

## Middleware order

Mounted before the server's global body parser, with its own chain, in this exact order:

1. Rate limiter (same per-IP, per-minute window as `/api/v1`).
2. Token check (same decision as `/api/v1`, see Auth below).
3. Content-Type and Content-Encoding check.
4. This route's own size- and record-limited body parser.
5. Shape and record-count check.
6. The handler.

This order is deliberate: a request with a wrong token and a malformed body gets `401`, not `400`, and an
unauthenticated request's body is never parsed at all.

## Auth

Shares the exact same decision as `/api/v1` (`isRequestAuthorized` in `server/index.ts`, factored out of the
original `/api/v1` check so both routes stay identical): `Authorization: Bearer <AGENT_VIEWER_API_TOKEN>`, or
`?token=`/`?api_key=` on the query string. OTLP exporters set it through
`OTEL_EXPORTER_OTLP_LOGS_HEADERS="Authorization=Bearer <token>"`. Without a configured token the route is
open, exactly like `/api/v1` (the office prints a loud startup warning in that case, see
[the open-API warning](../README.md)). The response shape differs by route: `/v1/logs` answers OTLP-style
(`{"code":16,"message":"Valid Bearer token required"}`), `/api/v1` keeps its own `{"error":"unauthorized",...}`
body.

## Limits

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_VIEWER_OTLP_MAX_BODY` | `5mb` | Any size string `body-parser` accepts (for example `10mb`, `512kb`). Applies to the decoded size: a gzip body can be much larger on the wire. An invalid value falls back to the default. |
| `AGENT_VIEWER_OTLP_MAX_RECORDS` | `5000` | Maximum log records per request, counted across every `resourceLogs[].scopeLogs[].logRecords[]`. An invalid or non-positive value falls back to the default. |

gzip and deflate request bodies are decoded automatically; brotli (`content-encoding: br`) is also accepted by
the underlying `body-parser` version this server uses. Anything else gets `415`.

## Status codes

Exporters only retry `429`, `502`, `503` and `504`, so everything else is final from the exporter's point of
view:

| Case | Status | Body |
|---|---|---|
| Accepted, including a request where every record was ignored or unknown, and `{"resourceLogs":[]}` | `200` | `{}` |
| Some records invalid or unattributed | `200` | `{"partialSuccess":{"rejectedLogRecords":"2","errorMessage":"..."}}` |
| Malformed JSON, a corrupt compressed body, or JSON without a `resourceLogs` array | `400` | `{"code":3,"message":"Expected an OTLP ExportLogsServiceRequest with resourceLogs"}` |
| Missing or wrong token | `401` | `{"code":16,"message":"Valid Bearer token required"}` |
| Body over `AGENT_VIEWER_OTLP_MAX_BODY` (decoded size) or over `AGENT_VIEWER_OTLP_MAX_RECORDS` | `413` | `{"code":3,"message":"OTLP request exceeds <limit> or <n> log records"}` |
| `Content-Type` other than `application/json`, or an unsupported `Content-Encoding` | `415` | `{"code":3,"message":"Agent Viewer accepts OTLP http/json on /v1/logs, uncompressed or gzip. Set OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json."}` |
| Rate limited | `429` + `Retry-After` | The same body the rate limiter always sends (`{"error":"rate_limit_exceeded",...}`); the header is what matters to an exporter. |
| The store failed to write | `503` | `{"code":14,"message":"Storage unavailable, retry"}` |

`rejectedLogRecords` is a string, matching OTLP's own int64-as-string convention. Every error and
`partialSuccess` message is built only from fixed text, known event names and counts: it never repeats
request content, so it is always safe to log or display.

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

## Out of scope

- `http/protobuf` and gRPC, and `POST /v1/metrics`.
- OTLP traces (`/v1/traces`).
- Offline import of OTLP logs or metrics files in `parseEventLog`.
- Attribution per subagent, per prompt or per skill.
- A usage ledger table with the server receive time.
- Pricing or re-estimating cost on the server: the figures stored here are exactly what Claude Code reported.
