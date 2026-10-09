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
{"schemaVersion":"1.0","id":"evt_05b","type":"llm.failed","timestamp":1728345604700,"source":"runtime:my-app","agentId":"analyst_1","summary":"Anthropic/claude-3-5-sonnet call failed (rate_limited)","payload":{"provider":"Anthropic","model":"claude-3-5-sonnet","errorKind":"rate_limited","httpStatus":429,"retryable":true}}
{"schemaVersion":"1.0","id":"evt_06","type":"agent.message.sent","timestamp":1728345605000,"source":"runtime:my-app","agentId":"analyst_1","summary":"Analysis complete","payload":{"text":"Financial review completed successfully!"}}
{"schemaVersion":"1.0","id":"evt_07","type":"agent.status.changed","timestamp":1728345606000,"source":"runtime:my-app","agentId":"analyst_1","summary":"Status -> DONE","payload":{"status":"DONE"}}
```

## Parsing Rules

`parseEventLog(input)` from `@warlockcode/agent-viewer` reads a log given as a `string`, `File` or `Blob` and returns `{ events, issues, totalLines, format }`.

1. **Empty Lines:** Blank lines or whitespace-only lines are ignored.
2. **Error Isolation:** If a line contains malformed JSON or fails the contract (envelope or payload), the parser records an issue with the line number and proceeds with subsequent lines.
3. **Chronological Ordering:** Valid events are returned sorted ascending by `timestamp` in milliseconds.
4. **Token & Cost Reporting:** Missing cost fields remain `null` with `costSource: "unknown"`. Costs are never assumed to be zero. Missing token counters (`cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`) stay absent, never `0`. `llm.failed` lines record failed model calls and carry tokens and cost only when the provider billed the attempt. An optional `currency` (ISO 4217 code such as `USD`) can accompany a reported cost.
5. **Size:** Input larger than 25 MB is rejected with an error.

## OTLP Traces

OTLP traces are not supported yet. When the input is an OTLP JSON trace (an object with `resourceSpans`), `parseEventLog` returns no events, `format: "otlp"` and a single issue: `OTLP traces are not supported yet. Export the run as canonical JSONL V1.`

## Replaying a Log

The parsed events are ready for `useEventReplay` and `<AgentOffice>`, or for `recordReplay` to export a video. See the [library guide](library.md).
