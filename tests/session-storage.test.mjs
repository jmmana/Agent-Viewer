import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_STORAGE_KEY,
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
