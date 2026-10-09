import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalJson, eventFingerprint } from '../server/eventFingerprint.ts';
import { CANONICAL_EVENT_TYPES, validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';

test('canonicalJson: key order does not matter, at any depth', () => {
  const cases = [
    [{ a: 1, b: 2 }, { b: 2, a: 1 }],
    [{ outer: { z: 1, y: { q: true, p: null } }, x: 'x' }, { x: 'x', outer: { y: { p: null, q: true }, z: 1 } }],
    [{ list: [{ b: 1, a: 2 }, { d: [{ f: 1, e: 2 }], c: 3 }] }, { list: [{ a: 2, b: 1 }, { c: 3, d: [{ e: 2, f: 1 }] }] }],
  ];
  for (const [left, right] of cases) {
    assert.equal(canonicalJson(left), canonicalJson(right));
  }
  assert.equal(canonicalJson({ b: 2, a: 1, c: { y: 1, x: 2 } }), '{"a":1,"b":2,"c":{"x":2,"y":1}}');
});

test('canonicalJson: keys are sorted by UTF-16 code units', () => {
  // "Z" (0x5A) sorts before "a" (0x61); "é" (0xE9) after both; an astral character sorts by its high surrogate.
  assert.equal(canonicalJson({ a: 1, 'é': 2, Z: 3, '😀': 4, '￿': 5 }), '{"Z":3,"a":1,"é":2,"😀":4,"￿":5}');
});

test('canonicalJson: arrays keep their order', () => {
  assert.notEqual(canonicalJson([1, 2, 3]), canonicalJson([3, 2, 1]));
  assert.equal(canonicalJson(['b', 'a', { d: 1, c: 2 }]), '["b","a",{"c":2,"d":1}]');
});

test('canonicalJson: undefined object values are dropped and undefined array items become null', () => {
  assert.equal(canonicalJson({ a: undefined, b: 1 }), canonicalJson({ b: 1 }));
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(canonicalJson([1, undefined, 3]), '[1,null,3]');
  assert.equal(canonicalJson([1, , 3]), '[1,null,3]');
  assert.equal(canonicalJson({ nested: { gone: undefined, kept: [undefined] } }), '{"nested":{"kept":[null]}}');
  // Same as JSON.stringify for each of these.
  for (const value of [{ a: undefined, b: 1 }, [1, undefined, 3], { f: () => 1, s: Symbol('x'), k: 1 }]) {
    assert.equal(canonicalJson(value), JSON.stringify(value));
  }
});

test('canonicalJson: 0, null and a missing value are three different things', () => {
  const zero = canonicalJson({ cost: 0 });
  const nul = canonicalJson({ cost: null });
  const missing = canonicalJson({});
  assert.equal(new Set([zero, nul, missing]).size, 3);
  assert.equal(canonicalJson({ cost: false }) === zero, false);
  assert.equal(canonicalJson({ cost: '0' }) === zero, false);
});

test('canonicalJson: numbers follow JSON.stringify rules', () => {
  assert.equal(canonicalJson({ n: 1 }), canonicalJson({ n: 1.0 }));
  assert.equal(canonicalJson({ n: -0 }), canonicalJson({ n: 0 }));
  assert.equal(canonicalJson({ n: 0.1 + 0.2 }), '{"n":0.30000000000000004}');
  assert.equal(canonicalJson({ n: 1e21 }), '{"n":1e+21}');
  assert.equal(canonicalJson({ n: Number.NaN }), '{"n":null}');
  assert.notEqual(canonicalJson({ n: 100 }), canonicalJson({ n: 101 }));
});

test('canonicalJson: a "__proto__" key is hashed, not swallowed', () => {
  const parsed = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
  assert.equal(canonicalJson(parsed), '{"__proto__":{"polluted":true},"a":1}');
  assert.notEqual(canonicalJson(parsed), canonicalJson({ a: 1 }));
  assert.notEqual(canonicalJson(parsed), canonicalJson(JSON.parse('{"__proto__":{"polluted":false},"a":1}')));
  assert.equal({}.polluted, undefined, 'nothing leaked into Object.prototype');
});

test('canonicalJson: strings are escaped like JSON.stringify', () => {
  const tricky = 'quote " backslash \\ newline \n tab \t nul \u0000 lone \uD800 東京';
  assert.equal(canonicalJson({ s: tricky }), `{"s":${JSON.stringify(tricky)}}`);
  assert.deepEqual(JSON.parse(canonicalJson({ s: tricky })), { s: tricky });
});

test('canonicalJson: circular structures and BigInt are rejected', () => {
  const loop = { a: 1 };
  loop.self = loop;
  assert.throws(() => canonicalJson(loop), TypeError);
  assert.throws(() => canonicalJson({ n: 1n }), TypeError);
  // The same object twice, not nested in itself, is fine.
  const shared = { x: 1 };
  assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
});

/** One valid body per canonical type, so the round trip is checked on every payload schema. */
const PAYLOADS = {
  'agent.registered': { id: 'ana', name: 'Ana', roleTitle: 'Planner' },
  'agent.updated': { name: 'Ana B', statusText: 'Renamed' },
  'agent.status.changed': { status: 'CODING', statusText: 'Writing' },
  'agent.message.sent': { text: 'hola', targetAgentId: 'bruno', kind: 'question' },
  'task.created': { id: 'task_1', title: 'Plan', collaboratorIds: ['bruno'] },
  'task.assigned': { taskId: 'task_1', assignedAgentId: 'ana' },
  'task.progress': { taskId: 'task_1', progress: 40, artifacts: [{ name: 'plan.md', size: 10 }, null] },
  'task.completed': { taskId: 'task_1', summary: 'Done', durationMs: 1200 },
  'task.failed': { taskId: 'task_1', error: 'boom' },
  'task.blocked': { taskId: 'task_1' },
  'tool.started': { tool: 'web.search', toolCallId: 'call_1' },
  'tool.completed': { tool: 'web.search', toolCallId: 'call_1', durationMs: 30 },
  'tool.failed': { tool: 'web.search', error: 'timeout' },
  'meeting.requested': { meetingId: 'm1', title: 'Sync', participantIds: ['ana', 'bruno'] },
  'meeting.started': { meetingId: 'm1', participantIds: ['ana', 'bruno'] },
  'meeting.message': { meetingId: 'm1', text: 'Agenda' },
  'meeting.ended': { meetingId: 'm1', decisions: ['ship'] },
  'meeting.cancelled': { meetingId: 'm1', reason: 'none' },
  'llm.usage': {
    provider: 'openai', model: 'gpt-5', inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cost: 0.01,
    costSource: 'provider-reported', currency: 'USD', requestId: 'req_1',
  },
  'llm.failed': { provider: 'openai', model: 'gpt-5', errorKind: 'rate_limited', httpStatus: 429, retryable: true },
  'runtime.connected': { runtimeId: 'rt', framework: 'custom', metadata: { b: { d: 1, c: 2 }, a: [3, 2, 1] } },
  'runtime.disconnected': { runtimeId: 'rt', reason: 'bye' },
  'runtime.heartbeat': { runtimeId: 'rt', activeAgentsCount: 2 },
};

test('canonicalJson survives the JSON round trip for validated events of every canonical type', () => {
  assert.deepEqual(Object.keys(PAYLOADS).sort(), [...CANONICAL_EVENT_TYPES].sort(), 'one payload per canonical type');
  for (const type of CANONICAL_EVENT_TYPES) {
    const result = validateCanonicalEvent({
      id: `evt_${type}`,
      type,
      timestamp: 1_700_000_000_000,
      source: 'agent:ana',
      summary: `${type} sample`,
      payload: PAYLOADS[type],
    });
    assert.equal(result.success, true, `${type}: ${JSON.stringify(result.issues)}`);
    const event = result.data;
    // The validator leaves undefined envelope fields (runtimeId, sessionId, ...); JSON drops them.
    const roundTripped = JSON.parse(JSON.stringify(event));
    assert.equal(canonicalJson(roundTripped), canonicalJson(event), type);
    assert.equal(eventFingerprint(roundTripped), eventFingerprint(event), type);
  }
});

test('eventFingerprint: sha256 of the canonical JSON, with a prefix and lowercase hex', () => {
  const event = {
    schemaVersion: '1.0',
    id: 'evt_fp',
    type: 'agent.status.changed',
    timestamp: 1,
    source: 'agent:a',
    severity: 'normal',
    summary: 's',
    payload: { status: 'IDLE' },
  };
  const expected = crypto.createHash('sha256').update(canonicalJson(event), 'utf8').digest('hex');
  assert.equal(eventFingerprint(event), `sha256:${expected}`);
  assert.match(eventFingerprint(event), /^sha256:[0-9a-f]{64}$/);
  assert.equal(eventFingerprint({ ...event, payload: { status: 'IDLE' }, agentId: undefined }), eventFingerprint(event));
  assert.notEqual(eventFingerprint({ ...event, timestamp: 2 }), eventFingerprint(event));
});

test('eventFingerprint: a type alias and the canonical type give the same fingerprint after validation', () => {
  const body = { id: 'evt_alias', timestamp: 5, source: 'agent:ana', summary: 'message', payload: { text: 'hola' } };
  const canonical = validateCanonicalEvent({ ...body, type: 'agent.message.sent' });
  const alias = validateCanonicalEvent({ ...body, type: 'message.sent' });
  assert.equal(canonical.success, true);
  assert.equal(alias.success, true, JSON.stringify(alias.issues));
  assert.equal(eventFingerprint(alias.data), eventFingerprint(canonical.data));
});

test('eventFingerprint: defaults filled by the contract make omitted optional fields equal', () => {
  const body = {
    id: 'evt_defaults',
    type: 'llm.usage',
    timestamp: 5,
    source: 'agent:ana',
    summary: 'usage',
    payload: { provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1 },
  };
  const omitted = validateCanonicalEvent(body);
  const explicit = validateCanonicalEvent({
    ...body,
    schemaVersion: '1.0',
    severity: 'normal',
    payload: { ...body.payload, cost: null, costSource: 'unknown' },
  });
  assert.equal(eventFingerprint(omitted.data), eventFingerprint(explicit.data));
  // A stripped unknown key is neither stored nor compared.
  const extra = validateCanonicalEvent({ ...body, unknownEnvelopeKey: 1, payload: { ...body.payload, unknownKey: 2 } });
  assert.equal(eventFingerprint(extra.data), eventFingerprint(omitted.data));
});
