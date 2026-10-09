import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_STORAGE_KEY,
  SESSION_SCHEMA_VERSION,
  clearSession,
  deserializeSession,
  loadSession,
  saveSession,
  serializeSession,
} from '../src/engine/sessionStorage.ts';

function state() {
  return {
    agents: [],
    tasks: [],
    meetings: [],
    events: [],
    activeMeetingId: null,
    roomReservations: [],
    socialActivities: [],
    coffeeSeatAssignments: [],
    totalTokens: { input: 1, output: 2, cached: 3, reasoning: 4 },
    totalCost: 0.25,
  };
}

function agentFixture(id, overrides = {}) {
  return {
    id,
    tokensInput: 1000,
    tokensOutput: 500,
    cachedTokens: 200,
    cost: 0.5,
    ...overrides,
  };
}

function storage() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, value); },
    removeItem(key) { data.delete(key); },
    data,
  };
}

test('session snapshot round-trips through storage', () => {
  const store = storage();
  const original = state();
  saveSession(store, original);
  assert.deepEqual(loadSession(store), original);
});

test('corrupted session data is ignored safely', () => {
  assert.equal(deserializeSession('{broken'), null);
  const store = storage();
  store.setItem(SESSION_STORAGE_KEY, '{broken');
  assert.equal(loadSession(store), null);
});

test('incompatible session versions are ignored', () => {
  const raw = JSON.stringify({ schemaVersion: 999, savedAt: Date.now(), state: state() });
  assert.equal(deserializeSession(raw), null);
});

test('clearSession removes the persisted snapshot', () => {
  const store = storage();
  store.setItem(SESSION_STORAGE_KEY, serializeSession(state()));
  clearSession(store);
  assert.equal(store.getItem(SESSION_STORAGE_KEY), null);
});

test('a v1 session with one evt-burst-* event migrates to v2: event removed, counters reduced and clamped at 0', () => {
  const base = state();
  base.agents = [agentFixture('agent-a'), agentFixture('agent-b')];
  base.totalTokens = { input: 1500, output: 600, cached: 300, reasoning: 0 };
  base.totalCost = 0.6;
  base.events = [
    {
      id: 'evt-burst-1700000000000-ab12',
      type: 'llm.usage',
      timestamp: 1700000000000,
      source: 'agent-a',
      target: 'server_room',
      severity: 'normal',
      summary: 'burst',
      payload: {
        provider: 'OpenAI',
        model: 'gpt-4o',
        inputTokens: 2000, // larger than the agent's own tokensInput, to exercise clamping at 0
        outputTokens: 100,
        cachedTokens: 50,
        cost: 0.3,
      },
    },
    { id: 'evt-other-1', type: 'agent.status.changed', timestamp: 1700000001000, source: 'agent-b', summary: 'ok', payload: {} },
  ];

  const raw = JSON.stringify({ schemaVersion: 1, savedAt: Date.now(), state: base });
  const migrated = deserializeSession(raw);

  assert.ok(migrated);
  // The burst event is gone, the unrelated event stays.
  assert.deepEqual(migrated.events.map((e) => e.id), ['evt-other-1']);

  const agentA = migrated.agents.find((a) => a.id === 'agent-a');
  // 1000 - 2000 clamped at 0 (agent-a's own tokensInput was smaller than the burst).
  assert.equal(agentA.tokensInput, 0);
  assert.equal(agentA.tokensOutput, 400); // 500 - 100
  assert.equal(agentA.cachedTokens, 150); // 200 - 50
  assert.equal(agentA.cost, 0.2); // 0.5 - 0.3, rounded by floating point addition below

  // agent-b is untouched (the burst's source was agent-a).
  const agentB = migrated.agents.find((a) => a.id === 'agent-b');
  assert.deepEqual(agentB, agentFixture('agent-b'));

  // Office totals reduced by the burst's values, clamped at 0 where applicable.
  assert.equal(migrated.totalTokens.input, 0); // 1500 - 2000 clamped
  assert.equal(migrated.totalTokens.output, 500); // 600 - 100
  assert.equal(migrated.totalTokens.cached, 250); // 300 - 50
  assert.ok(Math.abs(migrated.totalCost - 0.3) < 1e-9); // 0.6 - 0.3
});

test('a v2 session loads unchanged (no migration applied)', () => {
  const base = state();
  base.agents = [agentFixture('agent-a')];
  const raw = JSON.stringify({ schemaVersion: SESSION_SCHEMA_VERSION, savedAt: Date.now(), state: base });
  assert.deepEqual(deserializeSession(raw), base);
});

test('a v1 session with no burst events loads unchanged', () => {
  const base = state();
  base.events = [{ id: 'evt-normal-1', type: 'agent.status.changed', timestamp: 1, source: 'x', summary: 's', payload: {} }];
  const raw = JSON.stringify({ schemaVersion: 1, savedAt: Date.now(), state: base });
  assert.deepEqual(deserializeSession(raw), base);
});
