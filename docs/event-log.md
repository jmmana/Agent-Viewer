# Canonical Event Log Specification (JSONL V1)

## Overview

The **Canonical Event Log (JSONL V1)** format is a lightweight, line-delimited JSON format for recording and replaying multi-agent executions in Agent Viewer without requiring an active server connection.

Each non-empty line represents a single UTF-8 encoded [Canonical Event Envelope](canonical-contract.md) matching schema version `1.0`.

## File Structure

- **Extension:** `.jsonl` or `.log`
- **Encoding:** UTF-8
- **Delimiter:** Standard UNIX (`\n`) or Windows (`\r\n`) newline.
- **Size Limit:** Max 25 MB per imported session log.

## Example File (`sample-run.jsonl`)

```json
{"schemaVersion":"1.0","id":"evt_01","type":"agent.registered","timestamp":1728345600000,"source":"runtime:aqa","agentId":"analyst_1","summary":"Registered Market Analyst","payload":{"name":"Market Analyst","role":"researcher"}}
{"schemaVersion":"1.0","id":"evt_02","type":"agent.status.changed","timestamp":1728345601000,"source":"runtime:aqa","agentId":"analyst_1","summary":"Status -> THINKING","payload":{"status":"THINKING","statusText":"Reading 10-K report"}}
{"schemaVersion":"1.0","id":"evt_03","type":"tool.started","timestamp":1728345602500,"source":"runtime:aqa","agentId":"analyst_1","summary":"Using sec_parser","payload":{"tool":"sec_parser","inputSummary":"Ticker: AAPL"}}
{"schemaVersion":"1.0","id":"evt_04","type":"tool.completed","timestamp":1728345604000,"source":"runtime:aqa","agentId":"analyst_1","summary":"Completed sec_parser","payload":{"tool":"sec_parser","outputSummary":"42 metrics extracted"}}
{"schemaVersion":"1.0","id":"evt_05","type":"llm.usage","timestamp":1728345604500,"source":"runtime:aqa","agentId":"analyst_1","summary":"Usage reported","payload":{"provider":"Anthropic","model":"claude-3-5-sonnet","inputTokens":1200,"outputTokens":400,"cost":null,"costSource":"unknown"}}
{"schemaVersion":"1.0","id":"evt_06","type":"agent.message.sent","timestamp":1728345605000,"source":"runtime:aqa","agentId":"analyst_1","summary":"Analysis complete","payload":{"text":"Financial review completed successfully!"}}
{"schemaVersion":"1.0","id":"evt_07","type":"agent.status.changed","timestamp":1728345606000,"source":"runtime:aqa","agentId":"analyst_1","summary":"Status -> DONE","payload":{"status":"DONE"}}
```

## Parsing Rules

1. **Empty Lines:** Blank lines or whitespace-only lines are ignored.
2. **Error Isolation:** If a line contains malformed JSON or fails the envelope schema, parser records an issue with line number and proceeds with subsequent lines.
3. **Chronological Ordering:** The player automatically sorts valid events ascending by `timestamp` in milliseconds.
4. **Token & Cost Reporting:** Missing cost fields remain `null` with `costSource: "unknown"`. Costs are never assumed to be zero.
