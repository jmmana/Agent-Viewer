import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEventLog, MAX_EVENT_LOG_SIZE_BYTES } from '../src/integrations/eventLogParser.ts';
import { SessionReplayPlayer } from '../src/integrations/replayEngine.ts';
import { createLiveSimulationState } from '../src/engine/simulationEngine.ts';

test('Event log parser: parses valid Canonical JSONL V1 lines', async () => {
  const jsonl = [
    JSON.stringify({
      schemaVersion: '1.0',
      id: 'evt_01',
      type: 'agent.registered',
      timestamp: 1000,
      source: 'test',
      summary: 'Agent Registered',
      payload: { name: 'Bot 1' },
    }),
    JSON.stringify({
      schemaVersion: '1.0',
      id: 'evt_02',
      type: 'agent.status.changed',
      timestamp: 2000,
      source: 'test',
      agentId: 'Bot 1',
      summary: 'Status changed',
      payload: { status: 'THINKING' },
    }),
  ].join('\n');

  const res = await parseEventLog(jsonl);
  assert.equal(res.events.length, 2);
  assert.equal(res.issues.length, 0);
  assert.equal(res.format, 'jsonl');
  assert.equal(res.events[0].id, 'evt_01');
  assert.equal(res.events[1].id, 'evt_02');
});

test('Event log parser: captures invalid and malformed lines without aborting valid lines', async () => {
  const lines = [
    JSON.stringify({
      schemaVersion: '1.0',
      id: 'evt_valid_1',
      type: 'agent.status.changed',
      timestamp: 1000,
      source: 'test',
      summary: 'Valid event 1',
      payload: { status: 'IDLE' },
    }),
    '{ malformed json here',
    JSON.stringify({
      schemaVersion: '1.0',
      id: '', // invalid empty ID
      type: 'agent.status.changed',
      timestamp: 2000,
      source: 'test',
      summary: 'Invalid event',
      payload: { status: 'IDLE' },
    }),
    JSON.stringify({
      schemaVersion: '1.0',
      id: 'evt_valid_2',
      type: 'agent.message.sent',
      timestamp: 3000,
      source: 'test',
      summary: 'Valid event 2',
      payload: { text: 'Hello' },
    }),
  ].join('\n');

  const res = await parseEventLog(lines);
  assert.equal(res.events.length, 2);
  assert.equal(res.events[0].id, 'evt_valid_1');
  assert.equal(res.events[1].id, 'evt_valid_2');
  assert.equal(res.issues.length, 2);
  assert.equal(res.issues[0].line, 2); // malformed
  assert.equal(res.issues[1].line, 3); // invalid schema
});

test('Event log parser: accepts llm.failed lines and keeps unknown figures absent', async () => {
  const jsonl = [
    JSON.stringify({
      schemaVersion: '1.0',
      id: 'evt_usage_log',
      type: 'llm.usage',
      timestamp: 1000,
      source: 'agent:researcher',
      summary: 'Usage report',
      payload: { provider: 'Anthropic', model: 'claude-sonnet', inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000 },
    }),
    JSON.stringify({
      schemaVersion: '1.0',
      id: 'evt_failed_log',
      type: 'llm.failed',
      timestamp: 2000,
      source: 'agent:researcher',
      summary: 'Anthropic/claude-sonnet call failed (overloaded)',
      payload: { provider: 'Anthropic', model: 'claude-sonnet', errorKind: 'overloaded', httpStatus: 529, retryable: true },
    }),
  ].join('\n');

  const res = await parseEventLog(jsonl);
  assert.equal(res.issues.length, 0);
  assert.equal(res.events.length, 2);
  const failed = res.events.find((event) => event.id === 'evt_failed_log');
  assert.equal(failed.type, 'llm.failed');
  assert.equal(failed.agentId, 'researcher');
  assert.equal(failed.payload.errorKind, 'overloaded');
  assert.equal(failed.payload.cost, null);
  assert.equal('inputTokens' in failed.payload, false);
  const usage = res.events.find((event) => event.id === 'evt_usage_log');
  assert.equal(usage.payload.cacheReadTokens, 1000);
  assert.equal('cachedTokens' in usage.payload, false);
  assert.equal('reasoningTokens' in usage.payload, false);
});

test('Event log parser: keeps the usage correlation fields, tags deduplicated (issue #64)', async () => {
  const jsonl = JSON.stringify({
    schemaVersion: '1.0',
    id: 'evt_usage_correlation_log',
    type: 'llm.usage',
    timestamp: 1000,
    source: 'agent:researcher',
    summary: 'Usage report with correlation',
    payload: {
      provider: 'Anthropic',
      model: 'claude-sonnet',
      inputTokens: 1200,
      outputTokens: 80,
      traceId: 'trace_log_parser',
      parentId: 'span_log_parser',
      toolCallId: 'call_log_parser',
      meetingId: 'meeting_log_parser',
      userId: 'usr_log_parser',
      tags: ['env:prod', 'env:prod'],
    },
  });

  const res = await parseEventLog(jsonl);
  assert.equal(res.issues.length, 0);
  assert.equal(res.events.length, 1);
  const [event] = res.events;
  assert.equal(event.payload.traceId, 'trace_log_parser');
  assert.equal(event.payload.parentId, 'span_log_parser');
  assert.equal(event.payload.toolCallId, 'call_log_parser');
  assert.equal(event.payload.meetingId, 'meeting_log_parser');
  assert.equal(event.payload.userId, 'usr_log_parser');
  assert.deepEqual(event.payload.tags, ['env:prod']);
});

test('Event log parser: rejects payloads exceeding 25 MB limit', async () => {
  // Create an artificial oversized string
  const giant = 'a'.repeat(MAX_EVENT_LOG_SIZE_BYTES + 10);
  await assert.rejects(
    async () => {
      await parseEventLog(giant);
    },
    {
      message: /exceeds maximum allowed size of 25 MB/,
    }
  );
});

test('Replay engine: step, jumpTo, and seekRatio work accurately', async () => {
  const events = [
    {
      schemaVersion: '1.0',
      id: 'evt_1',
      type: 'agent.registered',
      timestamp: 1000,
      source: 'test',
      summary: 'Reg',
      payload: { id: 'agent_1', name: 'Alpha' },
    },
    {
      schemaVersion: '1.0',
      id: 'evt_2',
      type: 'agent.status.changed',
      timestamp: 2000,
      source: 'test',
      agentId: 'agent_1',
      summary: 'Status',
      payload: { status: 'CODING' },
    },
    {
      schemaVersion: '1.0',
      id: 'evt_3',
      type: 'agent.message.sent',
      timestamp: 3000,
      source: 'test',
      agentId: 'agent_1',
      summary: 'Msg',
      payload: { text: 'Done' },
    },
  ];

  const player = new SessionReplayPlayer(events);
  assert.equal(player.totalEvents, 3);

  // Jump to index 2
  const state2 = player.jumpTo(2, () => createLiveSimulationState());
  assert.equal(state2.agents.length, 1);
  assert.equal(state2.agents[0].id, 'agent_1');
  assert.equal(state2.agents[0].status, 'CODING');

  // Jump to index 3 (all events applied)
  const state3 = player.jumpTo(3, () => createLiveSimulationState());
  assert.equal(state3.agents.length, 1);
  assert.equal(state3.agents[0].speechBubble?.text, 'Done');

  // Seek ratio 0
  const state0 = player.seekRatio(0, () => createLiveSimulationState());
  assert.equal(state0.agents.length, 0);
});
