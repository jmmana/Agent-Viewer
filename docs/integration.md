# Integrating Agent Viewer with real agents

Agent Viewer is designed to become a viewer for existing agent runtimes, not a replacement orchestrator.

## Integration model

Your runtime remains authoritative. Agent Viewer receives observable events and turns them into visual state.

Recommended transport layers:

- REST for registration, snapshots and event ingestion
- WebSocket or SSE for realtime updates
- TypeScript/JavaScript SDK
- Python SDK

## Event envelope

Proposed v1 envelope:

```json
{
  "schemaVersion": "1.0",
  "id": "evt_01J...",
  "type": "agent.status.changed",
  "timestamp": "2026-10-05T12:00:00Z",
  "source": "agent:research-1",
  "agentId": "research-1",
  "taskId": "task-42",
  "payload": {
    "status": "RESEARCHING",
    "workspace": "research_area"
  }
}
```

Every event should have a stable event ID so ingestion can be idempotent.

## Core events

### Agent

- `agent.registered`
- `agent.updated`
- `agent.status.changed`
- `agent.message.sent`
- `agent.phone_call.started`
- `agent.phone_call.ended`

### Task

- `task.created`
- `task.assigned`
- `task.progress`
- `task.completed`
- `task.blocked`

### Meeting

- `meeting.requested`
- `meeting.room.reserved`
- `meeting.started`
- `meeting.message`
- `meeting.ended`
- `meeting.cancelled`

### Tools

- `tool.started`
- `tool.completed`
- `tool.failed`

### LLM usage

- `llm.usage`

Suggested usage payload:

```json
{
  "provider": "OpenAI",
  "model": "gpt-5",
  "inputTokens": 1200,
  "outputTokens": 420,
  "cachedTokens": 800,
  "latencyMs": 1840,
  "requestId": "req_123",
  "cost": 0.0132,
  "costSource": "provider-reported"
}
```

`costSource` should be one of:

- `provider-reported`
- `estimated`
- `unknown`

## Minimal TypeScript experience

```ts
viewer.agent.status({
  agentId: "research-1",
  status: "RESEARCHING",
  workspace: "research_area"
});

viewer.llm.usage({
  agentId: "research-1",
  provider: "OpenAI",
  model: "gpt-5",
  inputTokens: 1200,
  outputTokens: 420
});
```

## Minimal Python experience

```python
viewer.agent_status(
    agent_id="research-1",
    status="RESEARCHING",
    workspace="research_area",
)

viewer.llm_usage(
    agent_id="research-1",
    provider="OpenAI",
    model="gpt-5",
    input_tokens=1200,
    output_tokens=420,
)
```

These SDK examples describe the target developer experience. They are not yet published packages.

## Trust boundary

Agent Viewer should visualize observable runtime activity. Integrations must not send private chain-of-thought. Prefer explicit status summaries, tool metadata, messages intended for display, final outputs and usage telemetry.

## Versioning

External ingestion contracts should be versioned independently from renderer internals. Breaking changes require a new schema major version. Unknown optional fields should be ignored when safe.
