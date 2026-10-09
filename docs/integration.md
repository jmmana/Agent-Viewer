# Agent Viewer: Integration Framework Guide

Connect your AI agents to **Agent Viewer** in under 5 minutes.

Agent Viewer provides real-time, multi-agent visual observability in an interactive animated virtual office. Your orchestrator remains authoritative; Agent Viewer receives observable lifecycle events and projects them onto the office simulation.

---

## ⚡ Quickstart (Under 5 Minutes)

### Option A: TypeScript / JavaScript

Install or copy the SDK (`sdk/typescript/index.ts`):

```ts
import { AgentViewer } from './sdk/typescript/index';

const viewer = new AgentViewer({
  url: 'http://localhost:8787',
  apiKey: process.env.AGENT_VIEWER_API_TOKEN,
  runtimeId: 'my-production-system',
  sessionId: 'run-001',
});

const agent = viewer.agent({
  id: 'researcher',
  name: 'Research Agent',
  provider: 'Google',
  model: 'gemini-2.5-pro',
});

// 1. Show state & thoughts
await agent.thinking('Analyzing documentation and project structure');

// 2. Report tool usage
await agent.toolStarted('web.search', 'query="Agent Viewer API"');
await agent.toolCompleted('web.search', 'found 14 results');

// 3. Emit observable dialogue to teammates or user
await agent.message('I found the integration specification.');

// 4. Report LLM tokens and cost telemetry, exactly as you know them
await agent.usage({
  provider: 'Google',
  model: 'gemini-2.5-pro',
  inputTokens: 4500,
  outputTokens: 900,
  cacheReadTokens: 1200, // part of inputTokens; leave out when not reported
  cacheWriteTokens: 0,
  cost: 0.0075,
  costSource: 'estimated', // computed by your app; 'provider-reported' only when the provider returned it
  currency: 'USD',
  requestId: 'req_01',
  taskId: 'task_01', // goes to the envelope taskId; create the task first with task.created
});

// 5. Conclude task
await agent.done('Research completed successfully');

// 6. Read the server's usage aggregates (GET /api/v1/usage), typed as UsageSummary
const usage = await viewer.usageSummary();
```

`viewer.snapshot()` returns the typed `ViewerSnapshot`, and `viewer.usageSummary()` returns the `UsageSummary` described in [Usage aggregates](#usage-aggregates-get-apiv1usage). Both throw `AgentViewerError` on a non-2xx response.

Events without an `id` get `evt_<uuid>` from `crypto.randomUUID()`. `AgentViewerError` carries `status` and `code` (the `error` field of the response body). `code === 'conflicting_duplicate'` (status `409`) means the id was already stored with different content: the event was not applied, and the SDK does not retry it. `emitBatch()` returns `{ accepted, duplicates, conflicts, results }`, where each result has `status` (`'accepted'`, `'duplicate'` or `'conflict'`); see [Idempotency & Replays](#-5-idempotency--replays).

```ts
try {
  await viewer.emit({ id: 'evt_call_42', type: 'llm.usage', timestamp: callTime, payload });
} catch (err) {
  if (err instanceof AgentViewerError && err.code === 'conflicting_duplicate') {
    // Another event already uses this id. Give each distinct event its own id.
  }
}
```

---

### Option B: Python

Install the SDK from a clone of this repository (it has no third-party dependencies):

```bash
pip install ./sdk/python
```

```python
import os

from agent_viewer import AgentViewer

viewer = AgentViewer(
    url="http://localhost:8787",
    api_key=os.getenv("AGENT_VIEWER_API_TOKEN"),
    runtime_id="crewai-production",
    session_id="session-2026",
)

agent = viewer.agent(
    id="researcher",
    name="Research Agent",
    provider="Google",
    model="gemini-2.5-pro",
)

agent.thinking("Analyzing documentation")
agent.tool_started("web.search", "query='agent docs'")
agent.tool_completed("web.search", "found 14 results")
agent.message("I found the information.")

agent.usage(
    provider="Google",
    model="gemini-2.5-pro",
    input_tokens=4500,
    output_tokens=900,
    cache_read_tokens=1200,  # part of input_tokens; leave out when not reported
    cache_write_tokens=0,
    cost=0.0075,
    cost_source="estimated",  # computed by your app; "provider-reported" only when the provider returned it
    currency="USD",
    request_id="req_01",
    task_id="task_01",  # goes to the envelope taskId; create the task first with task.created
)

agent.done("Documentation analyzed")

# Usage aggregates from GET /api/v1/usage (a dict): a token "sum" may be None, costs are per currency
usage = viewer.usage_summary()
```

---

### Option C: Generic Webhook (cURL / Zero Code)

Any HTTP client can send a simple webhook without building envelopes:

```bash
curl -X POST http://localhost:8787/api/v1/webhooks/generic \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "researcher",
    "status": "researching",
    "message": "Reading documentation"
  }'
```

---

## 📜 1. Canonical Event Contract V1

All events follow the single official V1 envelope:

```json
{
  "schemaVersion": "1.0",
  "id": "evt_1791190800000_abc123",
  "type": "agent.status.changed",
  "timestamp": 1791190800000,
  "runtimeId": "crewai-production",
  "sessionId": "run-2026-001",
  "source": "agent:researcher",
  "agentId": "researcher",
  "taskId": "task_01",
  "severity": "normal",
  "summary": "Research started",
  "payload": {
    "status": "RESEARCHING",
    "workspace": "research_area"
  }
}
```

### Official Event Types

| Category | Event Type | Description |
|---|---|---|
| **Agent** | `agent.registered` | Registers or updates agent profile (name, role, provider, model). |
| | `agent.updated` | Updates agent metadata or workspace. |
| | `agent.status.changed` | Changes agent status (`IDLE`, `THINKING`, `CODING`, `RESEARCHING`, `TESTING`, `WAITING`, `BLOCKED`, `DONE`, `ERROR`). |
| | `agent.message.sent` | Displays speech bubble above agent. |
| **Tasks** | `task.created` | New task registered in the virtual office. |
| | `task.assigned` | Assigns task to an agent. |
| | `task.progress` | Updates progress percentage (0-100) or intermediate state. |
| | `task.completed` | Marks task as completed. |
| | `task.failed` | Marks task as failed with error reason. |
| | `task.blocked` | Marks task as blocked. |
| **Tools** | `tool.started` | Shows agent actively using a tool. |
| | `tool.completed` | Tool execution finished. |
| | `tool.failed` | Tool execution failed. |
| **Meetings** | `meeting.requested` | Request a collaboration meeting between agents. |
| | `meeting.started` | Meeting begins in conference room. |
| | `meeting.message` | Message spoken during a meeting. |
| | `meeting.ended` | Meeting concludes. |
| | `meeting.cancelled` | Meeting cancelled. |
| **Telemetry** | `llm.usage` | Reports one successful model call: input and output tokens, cache read and cache write tokens, reasoning tokens, latency, cost. |
| | `llm.failed` | Reports one failed model call attempt: error kind, HTTP status, retryable flag, and tokens and cost only when the provider billed the attempt. |
| **Runtime** | `runtime.connected` | External runtime connects. |
| | `runtime.disconnected` | External runtime disconnects. |
| | `runtime.heartbeat` | Periodic runtime health heartbeat. |

---

## 🛡️ 2. Validation & Error Handling

Ingestion strictly validates the envelope and payload using Zod.

If validation fails, the API responds with HTTP 400 and structured issues:

```json
{
  "error": "validation_failed",
  "issues": [
    {
      "path": "payload.inputTokens",
      "message": "Expected non-negative integer"
    }
  ]
}
```

Validation rules enforced:
- `schemaVersion`: must be `"1.0"`.
- `id`: non-empty string.
- `timestamp`: positive integer timestamp in ms.
- `type`: one of the canonical event types.
- `summary`: non-empty descriptive string.
- Token counts & latency: non-negative integers.
- Cost: non-negative float or `null`.

---

## 🌐 3. REST API Reference

Base URL: `http://localhost:8787`

### Health & Readiness
- `GET /health`: Health status, server version, connected SSE client count, and current `auth` / `webhookAuth` modes. An open server still returns HTTP 200 with `ok: true`.
- `GET /ready`: Verification that storage engine is ready, plus `ingestion: { conflicts, legacyUnverifiedDuplicates }` counted since the process started. SQLite includes `database.schemaVersion`, `database.latestKnownSchemaVersion` and `database.appliedAt`; these describe the database schema, unlike `/health`'s event-contract `schemaVersion` (`1.0`).

The `auth` field is `token` or `open`; `webhookAuth` is `signature`, `token` or `open`. These fields never include the token:

```json
{
  "ok": true,
  "status": "healthy",
  "service": "agent-viewer",
  "version": "0.3.0",
  "schemaVersion": "1.0",
  "clientsConnected": 1,
  "auth": "open",
  "webhookAuth": "open"
}
```

```json
{
  "ok": true,
  "status": "healthy",
  "service": "agent-viewer",
  "version": "0.3.0",
  "schemaVersion": "1.0",
  "clientsConnected": 1,
  "auth": "token",
  "webhookAuth": "signature"
}
```

### Events
- `POST /api/v1/events`: Ingest a single canonical event. Supports `Idempotency-Key` header. Answers `202` (accepted), `200` (duplicate: same id, same content) or `409 conflicting_duplicate` (same id, different content, not applied), each with the event `fingerprint`. A header that differs from a non-empty body `id` is a `400 idempotency_key_mismatch`.
- `POST /api/v1/events/batch`: Ingest multiple events (up to 100 per batch). Each result has a `status` of `accepted`, `duplicate` or `conflict`.
- `GET /api/v1/events`: Query events with filters (`limit`, `since`, `afterId`, `runtimeId`, `sessionId`, `agentId`, `type`).
- `GET /api/v1/events/stream`: Server-Sent Events (SSE) live stream with `Last-Event-ID` missed event replay.
- `GET /api/v1/snapshot`: Aggregate snapshot: agents, tasks, meetings, runtimes, the `usage` block and the deprecated `totalTokens` and `totalCost`. `totalCost` is `null` unless every call reported a cost in one single currency with one single cost source. See [Usage aggregates](#usage-aggregates-get-apiv1usage).
- `GET /api/v1/usage`: Usage aggregates only (`UsageSummary`), without the event list.

### Agents
- `POST /api/v1/agents`: Register or upsert an agent profile.
- `PATCH /api/v1/agents/:agentId`: Update an agent's profile or status using descriptive fields only.

The PATCH allow-list is `name`, `roleTitle`, `provider`, `model`, `status`, `statusText` and `workspace`. `name`, `roleTitle`, `provider` and `model` emit `agent.updated`. `status` emits `agent.status.changed`; `statusText` and `workspace` are included in that event when `status` is present, and otherwise emit `agent.updated`. String fields are trimmed; profile fields and `workspace` must contain 1-200 characters, `statusText` may contain 0-1000 characters, and `status` must be a known status. Body `id` is ignored. Every other field is rejected, including usage, cost, and server-managed fields. Error issue codes are `usage_not_patchable`, `read_only_field`, `unknown_field`, `invalid_type`, `invalid_status`, `empty_patch` and `reserved_agent_id`.

Report token usage and cost as `llm.usage` events through `POST /api/v1/events`, or use the Python `agent.usage(...)` or TypeScript `usage()` SDK helper. For example:

```json
{
  "error": "validation_failed",
  "message": "Usage and cost cannot be edited through PATCH. Send an llm.usage event to POST /api/v1/events (or use the SDK usage() helper) so the spend is recorded and auditable.",
  "issues": [{ "path": "cost", "code": "usage_not_patchable", "message": "Report cost with an llm.usage event." }]
}
```

### Runtimes & Sessions
- `POST /api/v1/runtimes`: Register/heartbeat an external runtime.
- `GET /api/v1/runtimes`: List connected runtimes.
- `GET /api/v1/sessions`: List sessions.
- `GET /api/v1/sessions/:sessionId`: Inspect specific session and events.

### Webhook
- `POST /api/v1/webhooks/generic`: Simplified webhook intake.

---

## 📦 4. Batch Ingestion

Endpoint: `POST /api/v1/events/batch`

Accepts an array of canonical events:

```json
{
  "events": [
    {
      "schemaVersion": "1.0",
      "id": "evt_b1",
      "type": "agent.status.changed",
      "timestamp": 1791190800000,
      "source": "agent:bot",
      "agentId": "bot",
      "summary": "Started coding",
      "payload": { "status": "CODING" }
    },
    {
      "schemaVersion": "1.0",
      "id": "evt_b2",
      "type": "tool.started",
      "timestamp": 1791190801000,
      "source": "agent:bot",
      "agentId": "bot",
      "summary": "Compiling tests",
      "payload": { "tool": "npm.test" }
    }
  ]
}
```

Response:
```json
{
  "accepted": 2,
  "duplicates": 0,
  "conflicts": 0,
  "total": 2,
  "results": [
    { "id": "evt_b1", "status": "accepted", "duplicate": false, "fingerprint": "sha256:aa..." },
    { "id": "evt_b2", "status": "accepted", "duplicate": false, "fingerprint": "sha256:bb..." }
  ]
}
```

The batch answers `202` whenever validation passes, even when some or all items were not applied, so read `conflicts` and each item's `status`. Items are evaluated in order, against the store and against earlier items of the same batch. A repeated identical item is a `duplicate` (nothing stored again). A repeated id with different content is a `conflict`: it is not stored, not aggregated and not streamed, and its result adds `"error": "conflicting_duplicate"` and the `storedFingerprint`. Only accepted items are streamed. With SQLite a batch is stored all or nothing.

---

## 🔑 5. Idempotency & Replays

Every event must provide a stable `id` or the request must supply an `Idempotency-Key` header:

```bash
curl -X POST http://localhost:8787/api/v1/events \
  -H "Idempotency-Key: evt_req_9921" \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

The header becomes the id when the body has none (or an empty one). When the body has a non-empty `id` that differs from the header, nothing is stored and the server answers HTTP 400:

```json
{ "error": "idempotency_key_mismatch", "message": "Idempotency-Key \"a\" does not match the event id \"b\"." }
```

**An id must identify exactly one event.** The server keeps a `fingerprint` of every stored event: `sha256:` over the event as validated (keys sorted, unknown keys stripped, defaults such as `severity` or `costSource` filled in, aliases resolved to the canonical type). A repeated id is then compared by content:

- Same id, same fingerprint: a true retry. HTTP 200, nothing changes:

  ```json
  { "accepted": true, "duplicate": true, "id": "evt_req_9921", "fingerprint": "sha256:3f1c..." }
  ```

- Same id, different fingerprint: HTTP 409. The new event is not stored, not aggregated and not streamed, and the stored event stays as it was:

  ```json
  {
    "error": "conflicting_duplicate",
    "message": "An event with id \"evt_req_9921\" was already stored with different content. The new event was not applied.",
    "id": "evt_req_9921",
    "fingerprint": "sha256:9b0e...",
    "storedFingerprint": "sha256:3f1c..."
  }
  ```

Any stored field counts, `timestamp` included, and `0`, `null` and a missing value are three different contents (unknown is never zero). **A retry must resend the identical event, with the same `timestamp`.** A client that rebuilds the body with a new `Date.now()` on each attempt now gets `409` on the retry (the first copy is kept, so totals are right, but the client sees an error). The SDKs build each event once and resend the same object, and send `Idempotency-Key` equal to the event id. Neither SDK retries a 409: TypeScript raises `AgentViewerError` with `code === 'conflicting_duplicate'` and `status === 409`, Python raises `AgentViewerError` with `code == "conflicting_duplicate"` and `status_code == 409`.

Each conflict writes one `warn` log line on the server with the id, type, source, agent id and both fingerprints, never the payload. `GET /ready` counts them in `ingestion.conflicts` since the process started. With SQLite, rows written before 0.2.0 (or with unreadable `event_json`) have no fingerprint: a repeated id that matches one is treated as a duplicate and counted in `ingestion.legacyUnverifiedDuplicates`, with one warning per process.

Ids the server generates itself (`POST /api/v1/agents`, `PATCH /api/v1/agents/:agentId`, `POST /api/v1/runtimes` and the generic webhook) are `evt_<kind>_<uuid>`, for example `evt_reg_0b9f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4`, so two requests in the same millisecond never collide. The generic webhook response adds `duplicateCount` and `conflictCount` next to `acceptedCount`; both are `0` in normal operation.

---

## 🔒 6. Webhook Security (HMAC-SHA256)

When `AGENT_VIEWER_WEBHOOK_SECRET` is configured in `.env`, incoming webhooks must include HMAC signatures to prevent spoofing and replay attacks.

Headers:
- `X-Agent-Viewer-Signature`: Hex-encoded HMAC-SHA256 of `${timestamp}.${rawBody}`.
- `X-Agent-Viewer-Timestamp`: Millisecond timestamp of request generation.

```ts
import crypto from 'node:crypto';

const timestamp = Date.now().toString();
const signature = crypto
  .createHmac('sha256', process.env.AGENT_VIEWER_WEBHOOK_SECRET!)
  .update(`${timestamp}.${rawBody}`)
  .digest('hex');
```

The server rejects requests if `|now - timestamp| > 300_000` (5 minutes) or if signature verification fails.

---

## 💰 7. Canonical LLM Usage Normalization

Every token count and cost enters Agent Viewer through `llm.usage` (a successful call) or `llm.failed` (a failed attempt). The server stores, replays and adds up exactly what the validator accepts, so the contract never invents a figure.

**Missing means unknown, never 0.** A field that the runtime did not report is left out of the stored event (or kept as `null` when sent as `null`). The validator never turns it into `0`. A `0` in a stored event is always a zero that the sender reported.

### Token semantics

| Field | Meaning |
|---|---|
| `inputTokens` | All input tokens the provider processed for this call, **including** `cacheReadTokens` and `cacheWriteTokens`. |
| `cacheReadTokens` | Part of `inputTokens` served from the prompt cache (cache hit). |
| `cacheWriteTokens` | Part of `inputTokens` written to the prompt cache (cache creation). |
| `outputTokens` | All generated tokens, **including** `reasoningTokens` when the provider bills them as output. |
| `reasoningTokens` | Part of `outputTokens` spent on reasoning. |

With these rules, "total tokens = `inputTokens` + `outputTokens`" stays correct, and the breakdown fields never cause double counting. `reasoningTokens <= outputTokens` is the documented meaning, but schema version `1.0` does not enforce it, because some existing clients send Gemini-style separate counts.

### `llm.usage` payload

```json
{
  "provider": "Anthropic",
  "model": "claude-sonnet",
  "inputTokens": 5000,
  "outputTokens": 1000,
  "cacheReadTokens": 3000,
  "cacheWriteTokens": 500,
  "reasoningTokens": 200,
  "latencyMs": 940,
  "requestId": "req_123",
  "cost": 0.013,
  "costSource": "provider-reported",
  "currency": "USD"
}
```

| Field | Required | Rule |
|---|---|---|
| `provider`, `model` | Yes | Non-empty strings. |
| `inputTokens`, `outputTokens` | Yes | Non-negative integers. |
| `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens` | No | Non-negative integer or `null`. No default. |
| `cachedTokens` | No | **Deprecated**, see below. Non-negative integer or `null`. No default. |
| `latencyMs` | No | Non-negative integer or `null`. |
| `requestId` | No | String or `null`. |
| `cost` | No | Non-negative number or `null`. Defaults to `null` (unknown). |
| `costSource` | No | `provider-reported`, `estimated` or `unknown`. Defaults to `unknown`. |
| `currency` | No | ISO 4217 code such as `USD`, or `null`. |

Validation rules, in order:

1. **Absent stays absent.** A field that is not sent has no key in the stored payload. An explicit `null` stays `null`. Both mean "unknown".
2. **Deprecated alias.** When `cacheReadTokens` is absent and `cachedTokens` is sent (a number or `null`), the value is copied into `cacheReadTokens`. `cachedTokens` stays in the payload exactly as sent.
3. **Conflict check.** When `cachedTokens` and `cacheReadTokens` are both numbers and differ, the event is rejected at `payload.cachedTokens`. Equal values are accepted.
4. **Subset check.** When `cacheReadTokens` or `cacheWriteTokens` is sent, their sum must not exceed `inputTokens`, or the event is rejected at `payload.cacheReadTokens`. Values copied from the legacy `cachedTokens` are not part of this check, because older clients used both meanings of "cached".

A conflicting alias gets this response:

```json
{
  "error": "validation_failed",
  "issues": [
    {
      "path": "payload.cachedTokens",
      "message": "cachedTokens is deprecated and conflicts with cacheReadTokens; send only cacheReadTokens"
    }
  ]
}
```

### Usage from the SDKs

The Python and TypeScript SDKs send each figure exactly as the caller gives it, and never sum or price anything:

- A token count or `currency` that is not given (or is `None` / `null`) is left out of the payload; an explicit `0` is kept. The SDKs never work out `cachedTokens` from `cacheReadTokens` and `cacheWriteTokens`, or the reverse.
- `costSource` is exactly what the caller states. A cost given without it is sent as `"unknown"`, and each client (`AgentViewer` instance) prints one warning. With no cost, `costSource` is the stated value or `"unknown"`. A value other than `provider-reported`, `estimated` or `unknown` fails before anything is sent (`ValueError` in Python, a rejected promise with `TypeError` in TypeScript).
- `currency` is never defaulted to `USD` and never rewritten; the server checks the ISO 4217 format.
- `task_id` / `taskId` goes to the envelope `taskId`, not to the payload:

```json
{
  "schemaVersion": "1.0",
  "type": "llm.usage",
  "agentId": "builder",
  "taskId": "task_42",
  "payload": {
    "provider": "Anthropic",
    "model": "claude-sonnet-4-5",
    "inputTokens": 1800,
    "outputTokens": 450,
    "cacheReadTokens": 1200,
    "cacheWriteTokens": 300,
    "cost": 0.012,
    "costSource": "provider-reported",
    "currency": "USD",
    "requestId": "req_01"
  }
}
```

Here `cachedTokens` and `reasoningTokens` were not given, so they are missing from the payload, not set to `0`.

### `cachedTokens` is deprecated

`cachedTokens` is still accepted and means `cacheReadTokens`. Send `cacheReadTokens` instead. A sender that has both values must send the same number in both, or only `cacheReadTokens`.

### When cost or a counter is unknown

```json
{
  "provider": "Google",
  "model": "gemini-2.5-pro",
  "inputTokens": 5000,
  "outputTokens": 1000,
  "cost": null,
  "costSource": "unknown"
}
```

This is also exactly what the server stores and returns for an `llm.usage` event sent without cache, reasoning or cost data: there is no `cachedTokens: 0` and no `reasoningTokens: 0`. Unknown cost is preserved as `null`, never converted to zero.

### Mapping provider usage fields

Adapters for providers that report cache counters separately must add them into `inputTokens`. Leave a field out when the provider does not report it.

| Provider | `inputTokens` | `cacheReadTokens` | `cacheWriteTokens` | `outputTokens` | `reasoningTokens` |
|---|---|---|---|---|---|
| OpenAI (Chat Completions) | `prompt_tokens` (already includes cached tokens) | `prompt_tokens_details.cached_tokens` | Not reported, leave it out | `completion_tokens` (already includes reasoning) | `completion_tokens_details.reasoning_tokens` |
| OpenAI (Responses) | `input_tokens` | `input_tokens_details.cached_tokens` | Not reported, leave it out | `output_tokens` | `output_tokens_details.reasoning_tokens` |
| Anthropic (Messages) | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` | `cache_read_input_tokens` | `cache_creation_input_tokens` | `output_tokens` (already includes thinking) | Not reported separately, leave it out |
| Google (Gemini) | `promptTokenCount` (already includes cached content) | `cachedContentTokenCount` | Not reported per call, leave it out | `candidatesTokenCount` + `thoughtsTokenCount` | `thoughtsTokenCount` |

The Claude Code mapping from OpenTelemetry is specified separately, with the Claude Code receiver.

### `llm.failed`: failed model calls

Send one `llm.failed` event per failed **attempt**. A retry that succeeds is a separate `llm.usage` event. Give each attempt its own `requestId` when the provider returns one.

```json
{
  "id": "evt_9f2c",
  "type": "llm.failed",
  "timestamp": 1791190800000,
  "source": "agent:researcher",
  "agentId": "researcher",
  "summary": "Anthropic/claude-sonnet call failed (rate_limited)",
  "payload": {
    "provider": "Anthropic",
    "model": "claude-sonnet",
    "errorKind": "rate_limited",
    "httpStatus": 429,
    "retryable": true,
    "requestId": "req_011CA",
    "latencyMs": 212
  }
}
```

The server answers `202 Accepted` with `{ "accepted": true, "duplicate": false, "id": "evt_9f2c", "fingerprint": "sha256:..." }`, and `GET /api/v1/events?type=llm.failed` returns the payload as validated: no `inputTokens` key, `cost: null`, `costSource: "unknown"`.

| Field | Required | Rule |
|---|---|---|
| `provider`, `model` | Yes | Non-empty strings. |
| `errorKind` | No | One of the kinds below. Defaults to `unknown` when absent; `null` or an unlisted value is rejected with HTTP 400. |
| `httpStatus` | No | Integer from 100 to 599, or `null`. |
| `retryable` | No | Boolean or `null`. No default. |
| `requestId` | No | String of up to 200 characters, or `null`. |
| `providerErrorCode` | No | The provider's error code (for example `insufficient_quota`), up to 100 characters. A code, never a message. |
| `latencyMs` | No | Non-negative integer or `null`. |
| `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens` | No | Non-negative integer or `null`. Same meaning as in `llm.usage`. No default. |
| `cost`, `costSource`, `currency` | No | Same rules as in `llm.usage`. |

Token and cost fields are filled only when the provider actually billed the failed attempt (for example, a stream cut off after output started). Otherwise leave them out. Consumers must never read a missing value as `0`. The subset check of `llm.usage` applies only when `inputTokens` is sent.

There is **no free-text error field on purpose**: provider error messages can echo prompt fragments or credentials. Build the envelope `summary` from `provider`, `model` and `errorKind` only.

`llm.failed` events are stored, streamed over SSE and listed, and they register an agent the server has not seen yet, but they do not change any top-level token or cost figure: the server counts them apart, under `failed` in the [usage aggregates](#usage-aggregates-get-apiv1usage). The embedded office stores the agent's provider and model from them and never changes the agent's status, because a failed attempt is often retried.

#### Recommended `errorKind` mapping

| Condition | `errorKind` |
|---|---|
| HTTP 429, including "quota exhausted" 429s (put the provider code in `providerErrorCode`) | `rate_limited` |
| HTTP 529 or an "overloaded" provider error | `overloaded` |
| Client timeout, HTTP 408 or 504 | `timeout` |
| HTTP 400, 404, 413 or 422, context length exceeded, unknown model | `invalid_request` |
| HTTP 401 or 403, account or billing holds | `auth` |
| Any other HTTP 5xx | `server_error` |
| The caller aborted the request | `cancelled` |
| Anything else | `unknown` |

The list is exported as `LLM_ERROR_KINDS` (with the `isLlmErrorKind` guard) from `@warlockcode/agent-viewer`.

### Compatibility notes

- `schemaVersion` stays `"1.0"`. Every event that validated before still validates.
- Consumers that read `payload.cachedTokens` or `payload.reasoningTokens` and expected a number now get `undefined` or `null` when the sender did not report them.
- `cachedTokens: 0` and `reasoningTokens: 0` in events stored by 0.2.x may mean "not reported": the 0.2.x validator wrote `0` when the field was missing. Stored rows are not rewritten.
- Mixed versions: a 0.3.0 SDK needs a 0.3.0 server. A 0.2.x server rejects `llm.failed` with HTTP 400 and silently drops `cacheReadTokens` and `cacheWriteTokens`.
- The loose normalizer used by the embedded library and the generic webhook no longer writes `0` for a missing `inputTokens` or `outputTokens`. A webhook `usage` object without them is stored as an `llm.usage` event without those keys, which means unknown.

### Usage aggregates (`GET /api/v1/usage`)

The server adds up every accepted `llm.usage` call, one call at a time, by agent and by the `(provider, model)` of that call. Failed calls (`llm.failed`) are counted apart. These are the figures that hosts, dashboards and the portal should read; they can all be traced back to the stored events.

```http
GET /api/v1/usage
Authorization: Bearer <token>
```

The response is a `UsageSummary`. The same object is the `usage` block of `GET /api/v1/snapshot`. Authentication and rate limits are the same as for every `/api/v1` route (`401` without a valid token, `429` over the limit). There are no query parameters yet.

```json
{
  "schemaVersion": "1.0",
  "eventsReduced": 4,
  "total": {
    "calls": 3,
    "tokens": {
      "input":      { "sum": 4200, "unreportedCount": 0 },
      "output":     { "sum": 950,  "unreportedCount": 0 },
      "cacheRead":  { "sum": 1200, "unreportedCount": 2 },
      "cacheWrite": { "sum": null, "unreportedCount": 3 },
      "reasoning":  { "sum": null, "unreportedCount": 3 }
    },
    "byCurrency": [
      { "currency": "USD", "costSource": "provider-reported", "amount": 0.042, "amountExact": "0.042", "calls": 2 }
    ],
    "costUnknownCount": 1,
    "costMissingCount": 1,
    "currencyMissingCount": 0,
    "firstTimestamp": 1791459000000,
    "lastTimestamp": 1791459900000,
    "failed": {
      "calls": 1,
      "tokens": {
        "input":      { "sum": null, "unreportedCount": 1 },
        "output":     { "sum": null, "unreportedCount": 1 },
        "cacheRead":  { "sum": null, "unreportedCount": 1 },
        "cacheWrite": { "sum": null, "unreportedCount": 1 },
        "reasoning":  { "sum": null, "unreportedCount": 1 }
      },
      "byCurrency": [],
      "costUnknownCount": 1,
      "costMissingCount": 1,
      "currencyMissingCount": 0,
      "firstTimestamp": 1791459950000,
      "lastTimestamp": 1791459950000
    }
  },
  "byModel": [
    { "provider": "openai", "model": "gpt-5", "calls": 2, "...": "UsageAggregate fields" },
    { "provider": "openai", "model": "gpt-5-mini", "calls": 1, "...": "UsageAggregate fields" }
  ],
  "byAgent": [
    {
      "agentId": "planner",
      "calls": 2,
      "...": "UsageAggregate fields",
      "byModel": [
        { "provider": "openai", "model": "gpt-5", "calls": 1, "...": "UsageAggregate fields" },
        { "provider": "openai", "model": "gpt-5-mini", "calls": 1, "...": "UsageAggregate fields" }
      ]
    },
    { "agentId": null, "calls": 1, "...": "calls emitted by a runtime with no agent", "byModel": ["..."] }
  ]
}
```

This example comes from four events: two successful calls in USD (one by `planner`, one by a runtime with no agent), one successful call by `planner` without a cost, and one failed call by `planner`. It is kept in `tests/fixtures/usage/docs-example.jsonl` and checked by the test suite.

An empty server returns `eventsReduced: 0`, `calls: 0`, every token as `{ "sum": null, "unreportedCount": 0 }`, `byCurrency: []`, null timestamps, empty `byModel` and `byAgent`, and `failed` with the same empty shape.

#### Schema

| Type | Fields |
|---|---|
| `UsageSummary` | `schemaVersion` (`"1.0"`), `eventsReduced` (`llm.usage` + `llm.failed` events applied), `total` (`UsageAggregate`), `byModel` (`ModelUsage[]`, sorted by provider then model, nulls last), `byAgent` (`AgentUsage[]`, sorted by agent id, null last). |
| `UsageAggregate` | Every `UsageBucket` field for the successful calls, plus `failed` (a `UsageBucket` of the `llm.failed` calls). |
| `ModelUsage` | `UsageAggregate` plus `provider` and `model` of the calls themselves (`null` when the payload did not have them). |
| `AgentUsage` | `UsageAggregate` plus `agentId` (`null` for calls without an agent) and `byModel` (`ModelUsage[]` of that agent). |
| `UsageBucket` | `calls`, `tokens` (`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, each a `TokenFigure`), `byCurrency` (`CurrencyCost[]`, sorted by currency then cost source), `costUnknownCount` (= `costMissingCount` + `currencyMissingCount`), `costMissingCount`, `currencyMissingCount`, `firstTimestamp`, `lastTimestamp` (smallest and largest event `timestamp`, client clock, or `null`). |
| `TokenFigure` | `sum` (sum of the calls that reported this kind, `null` when none did) and `unreportedCount` (calls that left it out). |
| `CurrencyCost` | `currency` (ISO 4217 code as reported), `costSource`, `amount` (`Number(amountExact)`), `amountExact` (exact decimal string), `calls`. |

The TypeScript types are exported by the TypeScript SDK (`UsageSummary`, `UsageAggregate`, `UsageBucket`, `ModelUsage`, `AgentUsage`, `TokenFigure`, `CurrencyCost`, `ViewerSnapshot`).

#### Reduction rules

1. **Buckets come from the call itself.** The agent is the event's `agentId`, else its `source` without the `agent:` prefix. Calls from `system`, `external-runtime` or `runtime:*`, and calls with neither, go to the `agentId: null` bucket; they are always part of `total`. The model bucket is the `(provider, model)` of the payload exactly as sent (no trimming, case folding or aliasing); a missing value is `null` and forms its own bucket. The agent's current `provider` and `model` are never used, so switching models never moves past calls.
2. **Every call is added four times:** to `total`, to `byModel`, to `byAgent` and to that agent's `byModel`. An `llm.failed` call goes to the `failed` sub-bucket of the same four places, never to the top-level figures. A bucket that only saw failed calls has `calls: 0` and `failed.calls >= 1`.
3. **Tokens.** A reported non-negative integer adds to `sum`; a missing or `null` field adds 1 to `unreportedCount`. An explicit `0` is a reported zero. Values that are not non-negative integers (possible only on paths that skip validation) count as unreported. Token fields are `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` and `reasoningTokens`; a legacy `cachedTokens` counts through the `cacheReadTokens` that validation copies from it.
4. **Cost.** A missing, `null`, negative or non-finite `cost` adds 1 to `costMissingCount`. A valid `cost` with a missing currency or one that is not three capital letters (`"usd"` included) adds 1 to `currencyMissingCount`, and its amount is not added anywhere. Otherwise the amount is added to its `(currency, costSource)` pair; `cost: 0` is a known zero. A missing or unlisted `costSource` is `unknown`, a pair of its own that is never merged with `provider-reported` or `estimated`.
5. **No grand total.** Currencies are never converted or added together, and billed and estimated amounts are never merged. Nothing is priced on the server.
6. **Invariants.** In every bucket, `unreportedCount <= calls` for each token kind, `sum` is `null` exactly when no call reported the kind, and the `calls` of all `byCurrency` pairs plus `costUnknownCount` equal `calls`.

**Arithmetic.** Amounts are accumulated in fixed point, in nano units (1e-9 of the currency unit), so the result never depends on the order of the events: `0.1` + `0.2` gives `"0.3"`. Each amount is taken as the shortest decimal string of the number (exponent forms such as `1e-7` expanded) and rounded half-even at 9 decimals, so digits past the ninth decimal are lost. `amountExact` has no trailing zeros (`"0.042"`, `"3"`).

**Scope.** Each stored event id is reduced once: a duplicate or a conflicting duplicate is skipped before any side effect. In memory mode, totals keep counting events that the 10,000-event ring has evicted. With SQLite, the aggregates live in memory and start empty after a restart until a rebuild from stored events exists. Buckets are not capped.

#### Legacy snapshot fields (deprecated)

The snapshot keeps `totalTokens`, `totalCost` and the `AgentRecord` usage fields (`tokensInput`, `tokensOutput`, `cachedTokens`, `reasoningTokens`, `cost`) for 0.x clients. They are projections of the aggregates, read only the successful calls, and will be removed in 1.0.

- Token fields are the `sum` of the reported values, or `0` when none was reported. They are lower bounds when `unreportedCount > 0`. `cached` and `cachedTokens` are the cache-read sum.
- `totalCost` and `AgentRecord.cost` are the amount of the only `byCurrency` entry when the bucket has `calls > 0`, `costUnknownCount === 0` and exactly one `byCurrency` entry (one currency and one cost source). Otherwise they are `null`, including for an agent with no calls.
- Usage figures change only through stored `llm.usage` events: usage fields sent to `POST /api/v1/agents` or `PATCH /api/v1/agents/:agentId` never move them.

#### Auditing a figure

Every figure traces back to its calls: `GET /api/v1/events?type=llm.usage&agentId=<id>` lists the successful calls of an agent and `GET /api/v1/events?type=llm.failed&agentId=<id>` the failed ones. In memory mode that list only covers the events still in the ring.

---

## 🔄 8. Multi-Runtime & Session Tracking

You can run multiple independent crews or workflows against the same Agent Viewer instance:

```ts
const viewerA = new AgentViewer({ runtimeId: 'crewai-marketing', sessionId: 'run-01' });
const viewerB = new AgentViewer({ runtimeId: 'langgraph-engineers', sessionId: 'run-99' });
```

Events are tagged with `runtimeId` and `sessionId`, and queryable via:
- `GET /api/v1/runtimes`
- `GET /api/v1/sessions/:sessionId`
- `GET /api/v1/events?runtimeId=crewai-marketing`

---

## 💾 9. Server Persistence (SQLite & Memory)

Agent Viewer supports two persistence backends:

1. **`memory`** (Default): Fast, zero-dependency in-memory ring buffer (up to 10,000 events).
2. **`sqlite`**: Persistent event storage using the `node:sqlite` module built into Node.js (Node.js 24 or later, the version this project requires). Runtime, session, and agent state remains in memory.

To enable SQLite persistence:
```env
AGENT_VIEWER_STORAGE=sqlite
AGENT_VIEWER_SQLITE_PATH=./data/agent-viewer.db
AGENT_VIEWER_SQLITE_BACKUP=auto
```

SQLite schema migrations run automatically at startup. Existing databases are backed up next to the file before migration by default. Backups contain the same events, are never pruned automatically, and can delay startup for large databases. Set `AGENT_VIEWER_SQLITE_BACKUP=off` if backups are managed separately. A server refuses a database with a newer schema. For rollback, stop the server and restore the `.bak` file before starting an older version.

---

## 🧩 10. Framework Adapters

Functional adapter implementations are available in `examples/`:

- **LangGraph** (`examples/langgraph-adapter.ts`): Node start, tool callbacks, model usage, step completion.
- **CrewAI** (`examples/crewai-adapter.py`): Crew agent registration, task delegation, step actions, token telemetry.
- **AutoGen** (`examples/autogen-adapter.py`): ConversableAgent and GroupChat dialogues, tool returns, and token counts.
- **OpenAI Agents SDK** (`examples/openai-agents-adapter.ts`): Agent runs, handoffs between agents, tools, usage.
- **Google ADK** (`examples/google-adk-adapter.ts`): Gemini turns, function calling, grounding, token telemetry.

All adapters adhere to the **Trust Boundary Principle**: Only observable states, dialogues, and telemetry are transmitted; internal chain-of-thought scratchpads are never leaked.
