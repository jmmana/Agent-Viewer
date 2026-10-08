import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-store-'));
  return { dir, file: path.join(dir, `${name}.db`) };
}

function storeEvent(id, timestamp, extra = {}) {
  return {
    schemaVersion: '1.0',
    id,
    type: 'agent.message.sent',
    timestamp,
    source: 'agent:writer',
    agentId: 'writer',
    severity: 'normal',
    summary: `Message ${id}`,
    payload: { text: `Text ${id}` },
    ...extra,
  };
}

test('SQLiteEventStore: afterId returns only events newer than the given id, like MemoryEventStore', async () => {
  const { dir, file } = tempDbPath('after-id');
  const sqlite = new SQLiteEventStore(file);
  const memory = new MemoryEventStore();

  try {
    const events = [storeEvent('evt_a', 1000), storeEvent('evt_b', 2000), storeEvent('evt_c', 3000)];
    for (const event of events) {
      await sqlite.append(event);
      await memory.append(event);
    }

    const sqliteIds = (await sqlite.list({ afterId: 'evt_a' })).map((e) => e.id);
    const memoryIds = (await memory.list({ afterId: 'evt_a' })).map((e) => e.id);
    assert.deepEqual(sqliteIds, ['evt_c', 'evt_b']);
    assert.deepEqual(sqliteIds, memoryIds);

    assert.deepEqual((await sqlite.list({ afterId: 'evt_c' })).map((e) => e.id), []);
    // An unknown id behaves like the memory store: no cursor is applied.
    assert.deepEqual(
      (await sqlite.list({ afterId: 'evt_unknown' })).map((e) => e.id),
      (await memory.list({ afterId: 'evt_unknown' })).map((e) => e.id)
    );
  } finally {
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLiteEventStore: persists the full canonical event so it round-trips identically', async () => {
  const { dir, file } = tempDbPath('round-trip');
  const event = storeEvent('evt_round_trip', 4000, {
    type: 'task.progress',
    source: 'runtime:rt_round',
    runtimeId: 'rt_round',
    sessionId: 'ses_round',
    agentId: 'planner',
    taskId: 'task_round',
    severity: 'high',
    summary: 'Planner moved the task forward',
    payload: { taskId: 'task_round', progress: 40, artifacts: [{ name: 'plan.md' }] },
  });

  let store = new SQLiteEventStore(file);
  try {
    await store.append(event);
    await store.close();

    // A fresh instance reads from disk only, not from the in-memory side store.
    store = new SQLiteEventStore(file);
    const [listed] = await store.list({ runtimeId: 'rt_round' });
    assert.deepStrictEqual(listed, JSON.parse(JSON.stringify(event)));
    assert.equal(listed.source, 'runtime:rt_round');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLiteEventStore: migrates databases created before the event_json column and keeps legacy rows readable', async () => {
  const { dir, file } = tempDbPath('legacy');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      runtime_id TEXT,
      session_id TEXT,
      agent_id TEXT,
      task_id TEXT,
      severity TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  legacy
    .prepare('INSERT INTO events (id, type, timestamp, runtime_id, session_id, agent_id, task_id, severity, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('evt_legacy', 'agent.status.changed', 500, null, null, 'old-agent', null, 'normal', 'Legacy row', '{"status":"IDLE"}', 1);
  legacy.close();

  const store = new SQLiteEventStore(file);
  try {
    const columns = new DatabaseSync(file).prepare('PRAGMA table_info(events)').all().map((c) => c.name);
    assert.ok(columns.includes('event_json'));

    const [legacyEvent] = await store.list();
    assert.equal(legacyEvent.id, 'evt_legacy');
    assert.equal(legacyEvent.source, 'agent:old-agent');
    assert.deepEqual(legacyEvent.payload, { status: 'IDLE' });

    await store.append(storeEvent('evt_after_migration', 600));
    assert.deepEqual((await store.list({ afterId: 'evt_legacy' })).map((e) => e.id), ['evt_after_migration']);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent profile upserts preserve usage from events and preserve unknown cost', async () => {
  const { dir, file } = tempDbPath('upsert-usage');
  const stores = [new MemoryEventStore(), new SQLiteEventStore(file)];
  try {
    for (const store of stores) {
      await store.append({
        schemaVersion: '1.0',
        id: `usage-${stores.indexOf(store)}`,
        type: 'llm.usage',
        timestamp: 5000,
        source: 'agent:upsert-agent',
        agentId: 'upsert-agent',
        severity: 'normal',
        summary: 'Usage',
        payload: {
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 3,
          reasoningTokens: 2,
          cost: 0.25,
        },
      });
      const usageBefore = await store.getAgent('upsert-agent');
      await store.upsertAgent({ id: 'upsert-agent', name: 'Updated once' });
      const afterFirst = await store.upsertAgent({ id: 'upsert-agent', model: 'updated-model' });
      assert.deepEqual(
        {
          tokensInput: afterFirst.tokensInput,
          tokensOutput: afterFirst.tokensOutput,
          cachedTokens: afterFirst.cachedTokens,
          reasoningTokens: afterFirst.reasoningTokens,
          cost: afterFirst.cost,
        },
        {
          tokensInput: usageBefore.tokensInput,
          tokensOutput: usageBefore.tokensOutput,
          cachedTokens: usageBefore.cachedTokens,
          reasoningTokens: usageBefore.reasoningTokens,
          cost: usageBefore.cost,
        },
      );

      const memoryStore = store instanceof SQLiteEventStore ? store.memoryFallback : store;
      memoryStore.agents.get('upsert-agent').cost = null;
      assert.equal((await store.upsertAgent({ id: 'upsert-agent', name: 'Updated again' })).cost, null);
    }
  } finally {
    for (const store of stores) await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent.updated applies statusText without changing agent.registered behavior', async () => {
  const store = new MemoryEventStore();
  await store.upsertAgent({ id: 'updated-status-text', name: 'Status Text' });
  await store.append(storeEvent('evt_status_text_registered', 5500, {
    type: 'agent.registered',
    agentId: 'updated-status-text',
    payload: { statusText: 'Registration text' },
  }));
  assert.equal((await store.getAgent('updated-status-text')).statusText, 'Active');
  await store.append(storeEvent('evt_status_text_updated', 6000, {
    type: 'agent.updated',
    agentId: 'updated-status-text',
    payload: { statusText: 'Updated profile text' },
  }));
  assert.equal((await store.getAgent('updated-status-text')).statusText, 'Updated profile text');
});
