import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MemoryEventStore, SQLiteEventStore } from '../server/store.ts';

test('MemoryEventStore: appends events, detects duplicates, and maintains snapshot', async () => {
  const store = new MemoryEventStore(50);

  const event1 = {
    schemaVersion: '1.0',
    id: 'evt_mem_1',
    type: 'agent.status.changed',
    timestamp: 1000,
    runtimeId: 'rt_test',
    sessionId: 'session_test',
    source: 'agent:researcher',
    agentId: 'researcher',
    severity: 'normal',
    summary: 'Researcher coding',
    payload: { status: 'CODING' },
  };

  const res1 = await store.append(event1);
  assert.equal(res1.accepted, true);
  assert.equal(res1.duplicate, false);

  // Duplicate check
  const res2 = await store.append(event1);
  assert.equal(res2.accepted, true);
  assert.equal(res2.duplicate, true);

  // Snapshot check
  const snapshot = await store.snapshot();
  assert.equal(snapshot.schemaVersion, '1.0');
  assert.equal(snapshot.eventsCount, 1);
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.agents[0].id, 'researcher');
  assert.equal(snapshot.agents[0].status, 'CODING');
  assert.equal(snapshot.runtimes.length, 1);
  assert.equal(snapshot.sessions.length, 1);
});

test('SQLiteEventStore: stores events persistently and queries by runtime/session', async () => {
  const testDbPath = './data/test-store.db';
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  const store = new SQLiteEventStore(testDbPath);

  const event = {
    schemaVersion: '1.0',
    id: 'evt_sql_1',
    type: 'llm.usage',
    timestamp: 2000,
    runtimeId: 'rt_sql',
    sessionId: 'ses_sql',
    source: 'agent:gemini',
    agentId: 'gemini',
    severity: 'normal',
    summary: 'Usage 500 tokens',
    payload: {
      provider: 'Google',
      model: 'gemini-2.5-pro',
      inputTokens: 300,
      outputTokens: 200,
      cost: 0.005,
    },
  };

  const appendRes = await store.append(event);
  assert.equal(appendRes.accepted, true);
  assert.equal(appendRes.duplicate, false);

  // Query events
  const listed = await store.list({ runtimeId: 'rt_sql' });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'evt_sql_1');
  assert.equal(listed[0].payload.inputTokens, 300);

  // Duplicate check
  const dupRes = await store.append(event);
  assert.equal(dupRes.duplicate, true);

  await store.close();
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
});
