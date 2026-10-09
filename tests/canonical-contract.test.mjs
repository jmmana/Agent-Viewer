import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCanonicalEvent,
  normalizeCanonicalEvent,
  CANONICAL_EVENT_TYPES,
  LLM_ERROR_KINDS,
  isLlmErrorKind,
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
    'llm.failed',
    'runtime.connected',
    'runtime.disconnected',
    'runtime.heartbeat',
  ];

  for (const t of required) {
    assert.ok(CANONICAL_EVENT_TYPES.includes(t), `Missing canonical type: ${t}`);
  }
});

// -------------------------------------------------------------
// llm.usage: unknown stays unknown, cache fields and the deprecated alias
// -------------------------------------------------------------

let nextId = 0;
function usageEvent(payload) {
  nextId += 1;
  return {
    id: `evt_usage_${nextId}`,
    type: 'llm.usage',
    timestamp: 1791190800000,
    source: 'agent:researcher',
    summary: 'Usage report',
    payload: { provider: 'Google', model: 'gemini-2.5-pro', inputTokens: 100, outputTokens: 20, ...payload },
  };
}

function failedEvent(payload) {
  nextId += 1;
  return {
    id: `evt_failed_${nextId}`,
    type: 'llm.failed',
    timestamp: 1791190800000,
    source: 'agent:researcher',
    agentId: 'researcher',
    summary: 'Anthropic/claude-sonnet call failed',
    payload: { provider: 'Anthropic', model: 'claude-sonnet', ...payload },
  };
}

function issueAt(result, path) {
  return result.issues?.find((issue) => issue.path === path);
}

test('llm.usage: missing cache and reasoning fields stay absent, never 0', () => {
  const result = validateCanonicalEvent(usageEvent({}));
  assert.equal(result.success, true);
  const payload = result.data.payload;
  assert.equal('cachedTokens' in payload, false);
  assert.equal('reasoningTokens' in payload, false);
  assert.equal('cacheReadTokens' in payload, false);
  assert.equal('cacheWriteTokens' in payload, false);
  assert.equal(payload.cost, null);
  assert.equal(payload.costSource, 'unknown');
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), {
    provider: 'Google',
    model: 'gemini-2.5-pro',
    inputTokens: 100,
    outputTokens: 20,
    cost: null,
    costSource: 'unknown',
  });
});

test('llm.usage: explicit null stays null, and cachedTokens null is copied to cacheReadTokens', () => {
  const result = validateCanonicalEvent(usageEvent({ cachedTokens: null, reasoningTokens: null }));
  assert.equal(result.success, true);
  assert.equal(result.data.payload.cachedTokens, null);
  assert.equal(result.data.payload.reasoningTokens, null);
  assert.equal(result.data.payload.cacheReadTokens, null);

  const writeNull = validateCanonicalEvent(usageEvent({ cacheReadTokens: null, cacheWriteTokens: null }));
  assert.equal(writeNull.success, true);
  assert.equal(writeNull.data.payload.cacheReadTokens, null);
  assert.equal(writeNull.data.payload.cacheWriteTokens, null);
});

test('llm.usage: cacheReadTokens and cacheWriteTokens are kept by validation', () => {
  const result = validateCanonicalEvent(usageEvent({ cacheReadTokens: 7, cacheWriteTokens: 3 }));
  assert.equal(result.success, true);
  assert.equal(result.data.payload.cacheReadTokens, 7);
  assert.equal(result.data.payload.cacheWriteTokens, 3);
  assert.equal('cachedTokens' in result.data.payload, false);
});

test('llm.usage: cache fields must be non-negative integers', () => {
  for (const [field, value] of [
    ['cacheReadTokens', -1],
    ['cacheReadTokens', 1.5],
    ['cacheWriteTokens', -3],
    ['cacheWriteTokens', 2.25],
    ['reasoningTokens', -1],
    ['cachedTokens', -1],
  ]) {
    const result = validateCanonicalEvent(usageEvent({ [field]: value }));
    assert.equal(result.success, false, `${field}: ${value} should be rejected`);
    assert.ok(issueAt(result, `payload.${field}`), `Expected an issue at payload.${field}`);
  }
});

test('llm.usage: deprecated cachedTokens alone is copied to cacheReadTokens and kept as sent', () => {
  const result = validateCanonicalEvent(usageEvent({ inputTokens: 500, cachedTokens: 120 }));
  assert.equal(result.success, true);
  assert.equal(result.data.payload.cachedTokens, 120);
  assert.equal(result.data.payload.cacheReadTokens, 120);
});

test('llm.usage: equal cachedTokens and cacheReadTokens are accepted, different values are rejected', () => {
  const equal = validateCanonicalEvent(usageEvent({ inputTokens: 500, cachedTokens: 120, cacheReadTokens: 120 }));
  assert.equal(equal.success, true);
  assert.equal(equal.data.payload.cachedTokens, 120);
  assert.equal(equal.data.payload.cacheReadTokens, 120);

  const conflict = validateCanonicalEvent(usageEvent({ inputTokens: 500, cachedTokens: 120, cacheReadTokens: 80 }));
  assert.equal(conflict.success, false);
  assert.equal(conflict.error, 'validation_failed');
  const issue = issueAt(conflict, 'payload.cachedTokens');
  assert.ok(issue, 'Expected an issue at payload.cachedTokens');
  assert.equal(issue.message, 'cachedTokens is deprecated and conflicts with cacheReadTokens; send only cacheReadTokens');
});

test('llm.usage: cacheReadTokens + cacheWriteTokens cannot exceed inputTokens', () => {
  const tooMany = validateCanonicalEvent(usageEvent({ inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 30 }));
  assert.equal(tooMany.success, false);
  const issue = issueAt(tooMany, 'payload.cacheReadTokens');
  assert.ok(issue, 'Expected an issue at payload.cacheReadTokens');
  assert.equal(
    issue.message,
    'cacheReadTokens + cacheWriteTokens cannot exceed inputTokens (inputTokens includes cached tokens)',
  );

  const exact = validateCanonicalEvent(usageEvent({ inputTokens: 100, cacheReadTokens: 70, cacheWriteTokens: 30 }));
  assert.equal(exact.success, true);

  const writeOnly = validateCanonicalEvent(usageEvent({ inputTokens: 100, cacheWriteTokens: 101 }));
  assert.equal(writeOnly.success, false);
  assert.ok(issueAt(writeOnly, 'payload.cacheReadTokens'));
});

test('llm.usage: the legacy cachedTokens value is not part of the subset check', () => {
  const legacyOnly = validateCanonicalEvent(usageEvent({ inputTokens: 100, cachedTokens: 500 }));
  assert.equal(legacyOnly.success, true);
  assert.equal(legacyOnly.data.payload.cachedTokens, 500);
  assert.equal(legacyOnly.data.payload.cacheReadTokens, 500);

  const legacyWithWrite = validateCanonicalEvent(usageEvent({ inputTokens: 100, cachedTokens: 500, cacheWriteTokens: 30 }));
  assert.equal(legacyWithWrite.success, true);
  assert.equal(legacyWithWrite.data.payload.cacheReadTokens, 500);
  assert.equal(legacyWithWrite.data.payload.cacheWriteTokens, 30);
});

// -------------------------------------------------------------
// llm.failed
// -------------------------------------------------------------

test('llm.failed: is a canonical type and exposes the error kinds', () => {
  assert.ok(CANONICAL_EVENT_TYPES.includes('llm.failed'));
  assert.deepEqual([...LLM_ERROR_KINDS], [
    'rate_limited',
    'overloaded',
    'timeout',
    'invalid_request',
    'auth',
    'server_error',
    'cancelled',
    'unknown',
  ]);
  assert.equal(isLlmErrorKind('rate_limited'), true);
  assert.equal(isLlmErrorKind('billing'), false);
  assert.equal(isLlmErrorKind(null), false);
});

test('llm.failed: a minimal payload gets errorKind unknown, null cost and no token keys', () => {
  const result = validateCanonicalEvent(failedEvent({}));
  assert.equal(result.success, true);
  assert.equal(result.data.type, 'llm.failed');
  assert.equal(result.data.agentId, 'researcher');
  const payload = result.data.payload;
  assert.equal(payload.errorKind, 'unknown');
  assert.equal(payload.cost, null);
  assert.equal(payload.costSource, 'unknown');
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'cachedTokens']) {
    assert.equal(key in payload, false, `${key} should be absent`);
  }
  for (const key of ['httpStatus', 'retryable', 'requestId', 'providerErrorCode', 'latencyMs', 'currency']) {
    assert.equal(key in payload, false, `${key} should be absent`);
  }
});

test('llm.failed: every listed errorKind validates', () => {
  for (const kind of LLM_ERROR_KINDS) {
    const result = validateCanonicalEvent(failedEvent({ errorKind: kind }));
    assert.equal(result.success, true, `errorKind ${kind} should validate`);
    assert.equal(result.data.payload.errorKind, kind);
  }
});

test('llm.failed: an unlisted or null errorKind is rejected with the allowed values', () => {
  const billing = validateCanonicalEvent(failedEvent({ errorKind: 'billing' }));
  assert.equal(billing.success, false);
  const issue = issueAt(billing, 'payload.errorKind');
  assert.ok(issue, 'Expected an issue at payload.errorKind');
  for (const kind of LLM_ERROR_KINDS) {
    assert.ok(issue.message.includes(kind), `Message should list ${kind}: ${issue.message}`);
  }

  const nullKind = validateCanonicalEvent(failedEvent({ errorKind: null }));
  assert.equal(nullKind.success, false);
  assert.ok(issueAt(nullKind, 'payload.errorKind'));
});

test('llm.failed: httpStatus must be a valid HTTP status code', () => {
  for (const status of [42, 600, 99, 404.5]) {
    const result = validateCanonicalEvent(failedEvent({ httpStatus: status }));
    assert.equal(result.success, false, `httpStatus ${status} should be rejected`);
    assert.ok(issueAt(result, 'payload.httpStatus'));
  }
  for (const status of [100, 429, 529, 599]) {
    const result = validateCanonicalEvent(failedEvent({ httpStatus: status }));
    assert.equal(result.success, true, `httpStatus ${status} should validate`);
  }
});

test('llm.failed: negative latency, token counts and cost are rejected', () => {
  for (const field of ['latencyMs', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'cost']) {
    const result = validateCanonicalEvent(failedEvent({ [field]: -1 }));
    assert.equal(result.success, false, `${field}: -1 should be rejected`);
    assert.ok(issueAt(result, `payload.${field}`), `Expected an issue at payload.${field}`);
  }
});

test('llm.failed: requires provider and model', () => {
  const result = validateCanonicalEvent(failedEvent({ provider: '', model: undefined }));
  assert.equal(result.success, false);
  assert.ok(issueAt(result, 'payload.provider'));
  assert.ok(issueAt(result, 'payload.model'));
});

test('llm.failed: the subset check is skipped without inputTokens and applied with it', () => {
  const noInput = validateCanonicalEvent(failedEvent({ cacheReadTokens: 5 }));
  assert.equal(noInput.success, true);
  assert.equal(noInput.data.payload.cacheReadTokens, 5);
  assert.equal('inputTokens' in noInput.data.payload, false);

  const tooMany = validateCanonicalEvent(failedEvent({ inputTokens: 10, cacheReadTokens: 8, cacheWriteTokens: 5 }));
  assert.equal(tooMany.success, false);
  assert.ok(issueAt(tooMany, 'payload.cacheReadTokens'));
});

test('llm.failed: a partly billed failure keeps its tokens and cost as sent', () => {
  const payload = {
    errorKind: 'timeout',
    httpStatus: 504,
    retryable: true,
    requestId: 'req_011CA',
    providerErrorCode: 'stream_timeout',
    latencyMs: 30000,
    inputTokens: 1200,
    outputTokens: 80,
    cacheReadTokens: 1000,
    cacheWriteTokens: 0,
    reasoningTokens: 10,
    cost: 0.0042,
    costSource: 'provider-reported',
    currency: 'USD',
  };
  const result = validateCanonicalEvent(failedEvent(payload));
  assert.equal(result.success, true);
  assert.deepEqual(result.data.payload, { provider: 'Anthropic', model: 'claude-sonnet', ...payload });
});

test('llm.failed: has no free-text error field', () => {
  const result = validateCanonicalEvent(failedEvent({ error: 'Your prompt "secret" was too long', message: 'leak' }));
  assert.equal(result.success, true);
  assert.equal('error' in result.data.payload, false);
  assert.equal('message' in result.data.payload, false);
});

// -------------------------------------------------------------
// Loose normalizer
// -------------------------------------------------------------

test('normalizer: llm.usage without token fields gets no invented counts', () => {
  const normalized = normalizeCanonicalEvent({
    id: 'evt_norm_1',
    type: 'llm.usage',
    agentId: 'researcher',
    payload: { provider: 'Google', model: 'gemini-2.5-pro' },
  });
  assert.equal(normalized.type, 'llm.usage');
  assert.equal('inputTokens' in normalized.payload, false);
  assert.equal('outputTokens' in normalized.payload, false);
  assert.equal('cachedTokens' in normalized.payload, false);
  assert.equal('cacheReadTokens' in normalized.payload, false);
  assert.equal('reasoningTokens' in normalized.payload, false);
  assert.equal(normalized.payload.cost, null);
  assert.equal(normalized.payload.costSource, 'unknown');
});

test('normalizer: llm.usage copies cachedTokens into cacheReadTokens and never rejects a conflict', () => {
  const copied = normalizeCanonicalEvent({
    id: 'evt_norm_2',
    type: 'llm.usage',
    payload: { provider: 'Google', model: 'gemini-2.5-pro', inputTokens: 10, outputTokens: 2, cachedTokens: 4 },
  });
  assert.equal(copied.payload.cachedTokens, 4);
  assert.equal(copied.payload.cacheReadTokens, 4);

  const copiedNull = normalizeCanonicalEvent({
    id: 'evt_norm_3',
    type: 'llm.usage',
    payload: { provider: 'Google', model: 'gemini-2.5-pro', cachedTokens: null },
  });
  assert.equal(copiedNull.payload.cacheReadTokens, null);

  const conflict = normalizeCanonicalEvent({
    id: 'evt_norm_4',
    type: 'llm.usage',
    payload: { provider: 'Google', model: 'gemini-2.5-pro', inputTokens: 10, outputTokens: 2, cachedTokens: 9, cacheReadTokens: 3 },
  });
  assert.equal(conflict.type, 'llm.usage');
  assert.equal(conflict.payload.cachedTokens, 9);
  assert.equal(conflict.payload.cacheReadTokens, 3);
});

test('normalizer: llm.failed keeps its type and gets only label and cost defaults', () => {
  const normalized = normalizeCanonicalEvent({
    id: 'evt_norm_5',
    type: 'llm.failed',
    agentId: 'researcher',
    payload: { provider: 'Anthropic', model: 'claude-sonnet' },
  });
  assert.equal(normalized.type, 'llm.failed');
  assert.equal(normalized.payload.errorKind, 'unknown');
  assert.equal(normalized.payload.cost, null);
  assert.equal(normalized.payload.costSource, 'unknown');
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    assert.equal(key in normalized.payload, false, `${key} should be absent`);
  }
});

test('normalizer: an invalid llm.failed errorKind becomes unknown, a valid one is kept', () => {
  const invalid = normalizeCanonicalEvent({
    id: 'evt_norm_6',
    type: 'llm.failed',
    payload: { provider: 'Anthropic', model: 'claude-sonnet', errorKind: 'billing', cost: 0.01, costSource: 'estimated' },
  });
  assert.equal(invalid.payload.errorKind, 'unknown');
  assert.equal(invalid.payload.cost, 0.01);
  assert.equal(invalid.payload.costSource, 'estimated');

  const valid = normalizeCanonicalEvent({
    id: 'evt_norm_7',
    type: 'llm.failed',
    payload: { provider: 'Anthropic', model: 'claude-sonnet', errorKind: 'overloaded' },
  });
  assert.equal(valid.payload.errorKind, 'overloaded');
});
