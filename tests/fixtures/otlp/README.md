# OTLP fixtures

Fixtures for the OTLP request shapes the server and the library's `parseEventLog` both read.

## `logs-request.json` / `.pb`, `metrics-request.json` / `.pb`

Recorded for issue #73 (binary `http/protobuf` support for `/v1/logs` and `/v1/metrics`). Built by
`generate.mjs`, not captured from a real exporter: see the header comment in that script for why.

## `claude-code-logs.pretty.json`, `claude-code-logs.ndjson`, `claude-code-metrics.json`, `mixed.ndjson`

Recorded for issue #74 (`parseEventLog` OTLP file import, release 0.4.0 "usage ledger"). These are **not** a
new live capture: issue #59 already captured and scrubbed real Claude Code OTLP/HTTP logs traffic into
`tests/fixtures/claude-code-otlp/` (see that directory's own `README.md` for the recording method). This
item's fixtures are built from those same six already-scrubbed records, read with `node:fs` and recombined,
with every remaining personal attribute (`user.email`, `user.account_uuid`, `user.account_id`,
`organization.id`, `user.id`) stripped as a second pass: those fixtures kept a synthetic-but-`@`-shaped email
for the live-receiver tests, which this item's own privacy test (`tests/event-log-parser.test.mjs`, "the
fixtures contain no email-like string") would otherwise fail on. The mapper never reads any of the five
stripped attributes, so removing them changes nothing about what is being tested.

- `claude-code-logs.pretty.json`: one `ExportLogsServiceRequest`, pretty-printed, holding six log records in
  one `scopeLogs[0].logRecords` array:
  1. `api-request.json`'s record (full cache and cost figures).
  2. The same record with `cost_usd`/`cost_usd_micros` removed, so the converted event's cost stays
     unknown instead of becoming a reported zero.
  3. The same record with `cache_read_tokens`/`cache_creation_tokens` removed, so the converted event's cache
     figures stay unknown.
  4. `api-error-http.json`'s record (maps to `llm.failed`).
  5. `api-request.json`'s record again, with `timeUnixNano`, `observedTimeUnixNano` and the `event.timestamp`
     attribute all removed: no record of a usable time survives, so the parser must reject it
     (`otlp-record-skipped`) instead of stamping it with the moment the file was opened.
  6. `content-logging.json`'s non-usage record (`claude_code.user_prompt`), with a `prompt` attribute added
     holding the sentinel string `SENTINEL_PROMPT_TEXT_DO_NOT_LEAK`. The mapper does not read `user_prompt`
     records at all (by event name), so this string must never appear anywhere in `parseEventLog`'s result.
  Every record was also given a distinct `session.id` suffix so the six records do not collide into a single
  agent identity by coincidence.
- `claude-code-logs.ndjson`: the same six records, one `ExportLogsServiceRequest` per physical line (one record
  per line), the shape an OpenTelemetry Collector `file` exporter actually writes (one export per flush
  interval). Parsing this file and `claude-code-logs.pretty.json` must produce the same four converted events
  (same ids, timestamps and payloads): record placement across requests does not change the mapper's output.
- `claude-code-metrics.json`: a copy of `metrics-request.json` (issue #73's `ExportMetricsServiceRequest`
  fixture). Metrics never carry per-call usage or personal attributes, so no further scrubbing was needed; it
  is kept as its own file under this item's own name for a self-contained metrics-only test.
- `mixed.ndjson`: four physical lines exercising every signal and canonical JSONL in one file: a canonical
  `agent.registered` line, an `ExportLogsServiceRequest` line (the full-figures record plus the non-usage
  sentinel record above), the `claude-code-metrics.json` request, and a minimal `ExportTraceServiceRequest`
  with no spans. `parseEventLog` must return `format: 'otlp'`, the canonical event, the one converted
  `llm.usage` event, one `otlp-metrics-not-replayable` issue and one `otlp-traces-not-supported` issue, with
  `otlp.signals` equal to `['logs', 'metrics', 'traces']`.

No prompt, tool, file or account text from a real Claude Code session appears in any of these four files
beyond the one invented sentinel string above, which exists only to prove it is dropped.
