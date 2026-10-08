# Agent Viewer — Integration Framework Guide

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

// 4. Report LLM tokens and cost telemetry
await agent.usage({
  provider: 'Google',
  model: 'gemini-2.5-pro',
  inputTokens: 4500,
  outputTokens: 900,
  cost: 0.0075,
});

// 5. Conclude task
await agent.done('Research completed successfully');
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
    cost=0.0075,
)

agent.done("Documentation analyzed")
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
| **Telemetry** | `llm.usage` | Reports prompt/completion tokens, latency, cost. |
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
- `GET /health`: Health status, server version, connected SSE client count.
- `GET /ready`: Verification that storage engine is ready.

### Events
- `POST /api/v1/events`: Ingest a single canonical event. Supports `Idempotency-Key` header.
- `POST /api/v1/events/batch`: Ingest multiple events (up to 100 per batch).
- `GET /api/v1/events`: Query events with filters (`limit`, `since`, `afterId`, `runtimeId`, `sessionId`, `agentId`, `type`).
- `GET /api/v1/events/stream`: Server-Sent Events (SSE) live stream with `Last-Event-ID` missed event replay.
- `GET /api/v1/snapshot`: Returns full aggregate snapshot (agents, tasks, meetings, runtimes, tokens, total cost).

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
  "total": 2,
  "results": [
    { "id": "evt_b1", "duplicate": false },
    { "id": "evt_b2", "duplicate": false }
  ]
}
```

Duplicate event IDs are skipped idempotently without throwing errors.

---

## 🔑 5. Idempotency & Replays

Every event must provide a stable `id` or the request must supply an `Idempotency-Key` header:

```bash
curl -X POST http://localhost:8787/api/v1/events \
  -H "Idempotency-Key: evt_req_9921" \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

If the server receives an event ID that has already been ingested, it returns HTTP 200:

```json
{
  "accepted": true,
  "duplicate": true,
  "id": "evt_req_9921"
}
```

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

Report token usage using the canonical schema:

```json
{
  "provider": "Google",
  "model": "gemini-2.5-pro",
  "inputTokens": 5000,
  "outputTokens": 1000,
  "cachedTokens": 2500,
  "reasoningTokens": 0,
  "latencyMs": 940,
  "requestId": "req_123",
  "cost": 0.013,
  "costSource": "provider-reported"
}
```

### When Cost is Unknown:
```json
{
  "cost": null,
  "costSource": "unknown"
}
```
*Note: Unknown cost is preserved as `null`, never converted to zero.*

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
2. **`sqlite`**: Persistent storage using the `node:sqlite` module built into Node.js (Node.js 24 or later, the version this project requires). Stores events, runtimes, sessions, and agent aggregates in `./data/agent-viewer.db`.

To enable SQLite persistence:
```env
AGENT_VIEWER_STORAGE=sqlite
AGENT_VIEWER_SQLITE_PATH=./data/agent-viewer.db
```

---

## 🧩 10. Framework Adapters

Functional adapter implementations are available in `examples/`:

- **LangGraph** (`examples/langgraph-adapter.ts`): Node start, tool callbacks, model usage, step completion.
- **CrewAI** (`examples/crewai-adapter.py`): Crew agent registration, task delegation, step actions, token telemetry.
- **AutoGen** (`examples/autogen-adapter.py`): ConversableAgent and GroupChat dialogues, tool returns, and token counts.
- **OpenAI Agents SDK** (`examples/openai-agents-adapter.ts`): Agent runs, handoffs between agents, tools, usage.
- **Google ADK** (`examples/google-adk-adapter.ts`): Gemini turns, function calling, grounding, token telemetry.

All adapters adhere to the **Trust Boundary Principle**: Only observable states, dialogues, and telemetry are transmitted; internal chain-of-thought scratchpads are never leaked.
