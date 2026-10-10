# Canonical Event Log Specification (JSONL V1)

## Overview

The **Canonical Event Log (JSONL V1)** format is a lightweight, line-delimited JSON format for recording and replaying multi-agent executions in Agent Viewer without requiring an active server connection.

Each non-empty line is a single UTF-8 encoded canonical event matching schema version `1.0`. The envelope, the event types and their payloads are described in the [integration guide](integration.md) and defined in [`canonicalContract.ts`](../src/integrations/canonicalContract.ts).

## File Structure

- **Extension:** `.jsonl` or `.log`
- **Encoding:** UTF-8
- **Delimiter:** Standard UNIX (`\n`) or Windows (`\r\n`) newline.
- **Size Limit:** Max 25 MB per imported session log (`MAX_EVENT_LOG_SIZE_BYTES`).

## Example File (`sample-run.jsonl`)

```json
{"schemaVersion":"1.0","id":"evt_01","type":"agent.registered","timestamp":1728345600000,"source":"runtime:my-app","agentId":"analyst_1","summary":"Registered Market Analyst","payload":{"name":"Market Analyst","roleTitle":"Research","workspace":"research_area"}}
{"schemaVersion":"1.0","id":"evt_02","type":"agent.status.changed","timestamp":1728345601000,"source":"runtime:my-app","agentId":"analyst_1","summary":"Status -> THINKING","payload":{"status":"THINKING","statusText":"Reading 10-K report"}}
{"schemaVersion":"1.0","id":"evt_03","type":"tool.started","timestamp":1728345602500,"source":"runtime:my-app","agentId":"analyst_1","summary":"Using sec_parser","payload":{"tool":"sec_parser","inputSummary":"Ticker: AAPL"}}
{"schemaVersion":"1.0","id":"evt_04","type":"tool.completed","timestamp":1728345604000,"source":"runtime:my-app","agentId":"analyst_1","summary":"Completed sec_parser","payload":{"tool":"sec_parser","outputSummary":"42 metrics extracted"}}
{"schemaVersion":"1.0","id":"evt_05","type":"llm.usage","timestamp":1728345604500,"source":"runtime:my-app","agentId":"analyst_1","summary":"Usage reported","payload":{"provider":"Anthropic","model":"claude-3-5-sonnet","inputTokens":1200,"outputTokens":400,"cost":null,"costSource":"unknown"}}
{"schemaVersion":"1.0","id":"evt_05a","type":"llm.usage","timestamp":1728345604600,"source":"runtime:my-app","agentId":"analyst_1","summary":"Usage reported with correlation","payload":{"provider":"OpenAI","model":"gpt-4.1","inputTokens":1200,"outputTokens":400,"cost":null,"costSource":"unknown","traceId":"trace_3f9a0c7d2b4e4a51b8c6d9e0f1a2b3c4","parentId":"span_7c1d2e3f4a5b6c7d8e9f0a1b","toolCallId":"call_Ab12Cd34","meetingId":"meeting-pricing-review","userId":"usr_5e1b","tags":["env:prod","feature:quote-builder"]}}
{"schemaVersion":"1.0","id":"evt_05b","type":"llm.failed","timestamp":1728345604700,"source":"runtime:my-app","agentId":"analyst_1","summary":"Anthropic/claude-3-5-sonnet call failed (rate_limited)","payload":{"provider":"Anthropic","model":"claude-3-5-sonnet","errorKind":"rate_limited","httpStatus":429,"retryable":true}}
{"schemaVersion":"1.0","id":"evt_06","type":"agent.message.sent","timestamp":1728345605000,"source":"runtime:my-app","agentId":"analyst_1","summary":"Analysis complete","payload":{"text":"Financial review completed successfully!"}}
{"schemaVersion":"1.0","id":"evt_07","type":"agent.status.changed","timestamp":1728345606000,"source":"runtime:my-app","agentId":"analyst_1","summary":"Status -> DONE","payload":{"status":"DONE"}}
```

## Parsing Rules

`parseEventLog(input)` from `@warlockcode/agent-viewer` reads a log given as a `string`, `File` or `Blob` and returns `{ events, issues, totalLines, format, otlp? }`.

1. **Empty Lines:** Blank lines or whitespace-only lines are ignored.
2. **Error Isolation:** If a line contains malformed JSON or fails the contract (envelope or payload), the parser records an issue with the line number and proceeds with subsequent lines.
3. **Chronological Ordering:** Valid events are returned sorted ascending by `timestamp` in milliseconds.
4. **Token & Cost Reporting:** Missing cost fields remain `null` with `costSource: "unknown"`. Costs are never assumed to be zero. Missing token counters (`cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`) stay absent, never `0`. `llm.failed` lines record failed model calls and carry tokens and cost only when the provider billed the attempt. An optional `currency` (ISO 4217 code such as `USD`) can accompany a reported cost. Full field-by-field meaning: [docs/usage-semantics.md](usage-semantics.md).
5. **Size:** Input larger than 25 MB is rejected with an error.

## OTLP files

Besides canonical JSONL, `parseEventLog` also reads an OTLP/JSON export written to a file: a single pretty-printed export request, or one request per line (the shape an OpenTelemetry Collector `file` exporter writes). Detection parses the content; it never searches the raw text for a substring. A file can mix canonical lines and OTLP request lines; `format` is `"otlp"` whenever at least one OTLP request was found, and `events` still includes every canonical line that parsed.

Each signal is handled differently, because only one of them carries replayable per-call usage:

- **Logs (`resourceLogs`):** converted into `llm.usage` (and `llm.failed`) events through the same Claude Code mapper the live `POST /v1/logs` receiver uses (`docs/otlp.md`, `docs/claude-code.md`). A record missing a required field, or with no usable timestamp, is skipped and counted, never invented: the parser never substitutes the current time or a `0` for an unreported figure.
- **Metrics (`resourceMetrics`):** never replayed as calls. Metrics are pre-aggregated counters: turning one into a per-call event would invent a figure nobody reported. `parseEventLog` returns no events and one issue per file explaining the alternative (export the logs signal, or send metrics to the server).
- **Traces (`resourceSpans`):** not supported yet (tracked by a later item). `parseEventLog` returns no events and one issue per file, unchanged from earlier releases.

A Collector configuration that writes Claude Code's OTLP/HTTP logs export to a file for later import:

```yaml
receivers:
  otlp:
    protocols:
      http:
exporters:
  file:
    path: ./claude-code-logs.jsonl
service:
  pipelines:
    logs:
      receivers: [otlp]
      exporters: [file]
```

`EventLogParseResult.otlp` (present whenever `format === "otlp"`) reports which signals were found, in the fixed order `logs`, `metrics`, `traces`, plus per-record counters: `logRecords` (records seen), `converted` (mapped to an event), `skipped` (not an error: a record type the mapper does not read), and `rejected` (an `otlp-record-skipped` issue, capped at 50 individually listed; the rest are still counted). The invariant `logRecords === converted + skipped + rejected` always holds.

Every issue the parser emits now carries a machine-readable `code`:

| Code | Meaning |
|---|---|
| `invalid-json` | A line (or the whole file) could not be parsed as JSON. |
| `invalid-event` | Parsed JSON that is not a recognized OTLP request failed the canonical contract. |
| `otlp-metrics-not-replayable` | The file holds OTLP metrics, which cannot become per-call events. |
| `otlp-traces-not-supported` | The file holds OTLP traces, not supported yet. |
| `otlp-record-skipped` | One OTLP logs record was missing a required field or a usable timestamp. |
| `otlp-no-usage-records` | The file's logs signal had records, but none mapped to a usable call. |

An OTLP issue never sets `raw` (a log record can carry sensitive text); only a canonical JSONL issue may.

## Replaying a Log

The parsed events are ready for `useEventReplay` and `<AgentOffice>`, or for `recordReplay` to export a video. See the [library guide](library.md).

If you replay a log by posting its events to a server (rather than only loading the file in the browser), they are
subject to retention by the server's own receive time, not by the old `timestamp` values inside the file: see
[retention.md](retention.md).
