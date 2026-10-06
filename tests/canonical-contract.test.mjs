import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCanonicalEvent,
  normalizeCanonicalEvent,
  CANONICAL_EVENT_TYPES,
} from '../src/integrations/canonicalContract.ts';

test('canonical contract: validates envelope and valid agent.status.changed event', () => {
  const event = {
    schemaVersion: '1.0',
    id: 'evt_101',
    type: 'agent.status.changed',
    timestamp: 1791190800000,
    runtimeId: 'rt_01',
    sessionId: 'session_01',
    source: 'agent:researcher',
    agentId: 'researcher',
    summary: 'Research started',
    payload: {
      status: 'RESEARCHING',
      workspace: 'research_area',
    },
  };

  const result = validateCanonicalEvent(event);
  assert.equal(result.success, true);
  assert.equal(result.data?.id, 'evt_101');
  assert.equal(result.data?.type, 'agent.status.changed');
  assert.equal(result.data?.agentId, 'researcher');
});

test('canonical contract: rejects invalid negative tokens in llm.usage payload', () => {
  const event = {
    schemaVersion: '1.0',
    id: 'evt_102',
    type: 'llm.usage',
    timestamp: 1791190800000,
    source: 'agent:researcher',
    summary: 'Usage report',
    payload: {
      provider: 'Google',
      model: 'gemini-2.5-pro',
      inputTokens: -50,
      outputTokens: 100,
    },
  };

  const result = validateCanonicalEvent(event);
  assert.equal(result.success, false);
  assert.equal(result.error, 'validation_failed');
  assert.ok(result.issues && result.issues.length > 0);
  const tokenIssue = result.issues.find((i) => i.path.includes('inputTokens'));
  assert.ok(tokenIssue, 'Expected issue for negative inputTokens');
});

test('canonical contract: preserves null cost and unknown costSource for llm.usage', () => {
  const event = {
    schemaVersion: '1.0',
    id: 'evt_103',
    type: 'llm.usage',
    timestamp: 1791190800000,
    source: 'agent:researcher',
    summary: 'Usage with unknown cost',
    payload: {
      provider: 'Google',
      model: 'gemini-2.5-pro',
      inputTokens: 1200,
      outputTokens: 400,
      cost: null,
      costSource: 'unknown',
    },
  };

  const result = validateCanonicalEvent(event);
  assert.equal(result.success, true);
  assert.equal(result.data?.payload.cost, null);
  assert.equal(result.data?.payload.costSource, 'unknown');
});

test('canonical contract: normalizes legacy alias message.sent to agent.message.sent', () => {
  const normalized = normalizeCanonicalEvent({
    type: 'message.sent',
    agentId: 'qa-agent',
    summary: 'Tests completed',
    payload: { text: 'All 24 security tests passed' },
  });

  assert.equal(normalized.type, 'agent.message.sent');
  assert.equal(normalized.schemaVersion, '1.0');
  assert.ok(normalized.id.startsWith('evt_'));
});

test('canonical contract: includes all required canonical types', () => {
  const required = [
    'agent.registered',
    'agent.updated',
    'agent.status.changed',
    'agent.message.sent',
    'task.created',
    'task.assigned',
    'task.progress',
    'task.completed',
    'task.failed',
    'task.blocked',
    'tool.started',
    'tool.completed',
    'tool.failed',
    'meeting.requested',
    'meeting.started',
    'meeting.message',
    'meeting.ended',
    'meeting.cancelled',
    'llm.usage',
    'runtime.connected',
    'runtime.disconnected',
    'runtime.heartbeat',
  ];

  for (const t of required) {
    assert.ok(CANONICAL_EVENT_TYPES.includes(t), `Missing canonical type: ${t}`);
  }
});
