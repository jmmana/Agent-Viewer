import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryEventStore, SQLiteEventStore } from '../server/store.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';

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

function validatedUsageWithoutCache(id) {
  const result = validateCanonicalEvent({
    id,
    type: 'llm.usage',
    timestamp: 5000,
    runtimeId: 'rt_usage_unknown',
    source: 'agent:gemini',
    agentId: 'gemini',
    summary: 'Usage without cache data',
    payload: { provider: 'Google', model: 'gemini-2.5-pro', inputTokens: 5000, outputTokens: 1000 },
  });
  assert.equal(result.success, true);
  return result.data;
}

const UNKNOWN_COUNTERS = ['cachedTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'];

test('SQLiteEventStore: llm.usage without cache fields is stored without invented zeros', async () => {
  const { dir, file } = tempDbPath('usage-unknown');
  let store = new SQLiteEventStore(file);
  try {
    await store.append(validatedUsageWithoutCache('evt_usage_unknown_sql'));
    await store.close();

    const raw = new DatabaseSync(file);
    const row = raw.prepare('SELECT event_json, payload FROM events WHERE id = ?').get('evt_usage_unknown_sql');
    raw.close();
    const eventJson = JSON.parse(row.event_json);
    const payloadJson = JSON.parse(row.payload);
    for (const key of UNKNOWN_COUNTERS) {
      assert.equal(key in eventJson.payload, false, `event_json should not hold ${key}`);
      assert.equal(key in payloadJson, false, `payload column should not hold ${key}`);
    }

    store = new SQLiteEventStore(file);
    const [listed] = await store.list({ runtimeId: 'rt_usage_unknown' });
    assert.deepStrictEqual(listed.payload, {
      provider: 'Google',
      model: 'gemini-2.5-pro',
      inputTokens: 5000,
      outputTokens: 1000,
      cost: null,
      costSource: 'unknown',
    });
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MemoryEventStore: llm.usage without cache fields is stored without invented zeros', async () => {
  const store = new MemoryEventStore();
  await store.append(validatedUsageWithoutCache('evt_usage_unknown_mem'));
  const [listed] = await store.list({ runtimeId: 'rt_usage_unknown' });
  const serialized = JSON.parse(JSON.stringify(listed));
  for (const key of UNKNOWN_COUNTERS) {
    assert.equal(key in listed.payload, false, `memory store should not hold ${key}`);
    assert.equal(key in serialized.payload, false, `serialized event should not hold ${key}`);
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

// -------------------------------------------------------------
// Usage aggregates (issue #51)
// -------------------------------------------------------------

function loadUsageFixture(name) {
  const text = fs.readFileSync(new URL(`./fixtures/usage/${name}.jsonl`, import.meta.url), 'utf8');
  return text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

function legacyOf(agent) {
  return {
    tokensInput: agent.tokensInput,
    tokensOutput: agent.tokensOutput,
    cachedTokens: agent.cachedTokens,
    reasoningTokens: agent.reasoningTokens,
    cost: agent.cost,
  };
}

const NO_USAGE = { tokensInput: 0, tokensOutput: 0, cachedTokens: 0, reasoningTokens: 0, cost: null };

test('Usage aggregates: MemoryEventStore and SQLiteEventStore produce deep-equal usage blocks', async () => {
  const events = loadUsageFixture('mixed');
  const { dir, file } = tempDbPath('usage-parity');
  const memory = new MemoryEventStore();
  const sqlite = new SQLiteEventStore(file);
  try {
    for (const event of events) await memory.append(event);
    await sqlite.appendBatch(events);

    const memorySnapshot = await memory.snapshot();
    const sqliteSnapshot = await sqlite.snapshot();
    assert.deepStrictEqual(sqliteSnapshot.usage, memorySnapshot.usage);
    assert.deepStrictEqual(await sqlite.usageSummary(), await memory.usageSummary());
    assert.deepStrictEqual(await memory.usageSummary(), memorySnapshot.usage);
    assert.equal(memorySnapshot.usage.eventsReduced, 17);
    assert.deepStrictEqual(sqliteSnapshot.totalTokens, memorySnapshot.totalTokens);
    assert.equal(sqliteSnapshot.totalCost, memorySnapshot.totalCost);
    const byId = (list) => Object.fromEntries(list.map((agent) => [agent.id, legacyOf(agent)]));
    assert.deepStrictEqual(byId(sqliteSnapshot.agents), byId(memorySnapshot.agents));
  } finally {
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Usage aggregates: legacy snapshot fields follow the single-currency rule and count agent-less calls', async () => {
  const store = new MemoryEventStore();
  for (const event of loadUsageFixture('docs-example')) await store.append(event);
  const snapshot = await store.snapshot();

  // Deprecated lower bounds: sums of reported values, agent-less calls included.
  assert.deepEqual(snapshot.totalTokens, { input: 4200, output: 950, cached: 1200, reasoning: 0 });
  // One call has no cost, so no single figure can be given.
  assert.equal(snapshot.totalCost, null);
  const planner = snapshot.agents.find((agent) => agent.id === 'planner');
  assert.deepEqual(legacyOf(planner), { tokensInput: 3000, tokensOutput: 700, cachedTokens: 1200, reasoningTokens: 0, cost: null });
  assert.equal(planner.model, 'gpt-5', 'the display model is the latest call, but no figure reads it');
  assert.deepEqual(snapshot.usage.byModel.map((entry) => [entry.model, entry.calls]), [['gpt-5', 2], ['gpt-5-mini', 1]]);
  assert.equal(snapshot.agents.some((agent) => agent.id === 'rt_doc' || agent.id === 'runtime:rt_doc'), false);

  // Every successful call in USD provider-reported with a known cost: the legacy figure is that amount.
  const priced = new MemoryEventStore();
  await priced.append(loadUsageFixture('docs-example')[1]);
  await priced.append(loadUsageFixture('docs-example')[2]);
  const pricedSnapshot = await priced.snapshot();
  assert.equal(pricedSnapshot.totalCost, pricedSnapshot.usage.total.byCurrency[0].amount);
  assert.equal(pricedSnapshot.totalCost, 0.042);
  assert.equal(pricedSnapshot.agents.find((agent) => agent.id === 'planner').cost, 0.02);

  // USD and EUR, or billed and estimated: two pairs, so null.
  const mixed = new MemoryEventStore();
  for (const event of loadUsageFixture('mixed')) await mixed.append(event);
  const mixedSnapshot = await mixed.snapshot();
  assert.equal(mixedSnapshot.totalCost, null);
  assert.equal(mixedSnapshot.agents.find((agent) => agent.id === 'builder').cost, null);
  assert.equal(mixedSnapshot.agents.find((agent) => agent.id === 'flaky').cost, null, 'failed calls only: no cost');
});

test('Usage aggregates: an agent is charged per call, whatever model it shows now', async () => {
  const store = new MemoryEventStore();
  const base = { schemaVersion: '1.0', type: 'llm.usage', source: 'agent:switcher', agentId: 'switcher', severity: 'normal', summary: 'usage' };
  await store.append({ ...base, id: 'evt_switch_a', timestamp: 1, payload: { provider: 'p', model: 'a', inputTokens: 10, outputTokens: 1 } });
  await store.append({ ...base, id: 'evt_switch_b', timestamp: 2, payload: { provider: 'p', model: 'b', inputTokens: 20, outputTokens: 2 } });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.agents[0].model, 'b');
  const [agent] = snapshot.usage.byAgent;
  assert.deepEqual(agent.byModel.map((entry) => [entry.model, entry.calls, entry.tokens.input.sum]), [['a', 1, 10], ['b', 1, 20]]);
});

for (const [label, create] of [
  ['MemoryEventStore', () => ({ store: new MemoryEventStore(), cleanup: () => {} })],
  ['SQLiteEventStore', () => {
    const { dir, file } = tempDbPath('upsert-usage');
    const store = new SQLiteEventStore(file);
    return { store, cleanup: async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
  }],
]) {
  test(`Usage aggregates: ${label}.upsertAgent ignores usage fields and a registered agent without calls has cost null`, async () => {
    const { store, cleanup } = create();
    try {
      const registered = await store.upsertAgent({ id: 'quiet', name: 'Quiet' });
      assert.deepEqual(legacyOf(registered), NO_USAGE);
      assert.deepEqual(legacyOf(await store.getAgent('quiet')), NO_USAGE);
      assert.deepEqual(legacyOf((await store.listAgents()).find((agent) => agent.id === 'quiet')), NO_USAGE);
      assert.deepEqual(legacyOf((await store.snapshot()).agents.find((agent) => agent.id === 'quiet')), NO_USAGE);

      for (const event of loadUsageFixture('docs-example')) await store.append(event);
      const before = await store.snapshot();

      const forged = await store.upsertAgent({
        id: 'planner',
        cost: 99,
        tokensInput: 99,
        tokensOutput: 99,
        cachedTokens: 99,
        reasoningTokens: 99,
      });
      const ghost = await store.upsertAgent({ id: 'ghost', cost: 99, tokensInput: 99 });
      const after = await store.snapshot();

      assert.deepEqual(legacyOf(forged), legacyOf(before.agents.find((agent) => agent.id === 'planner')));
      assert.deepEqual(legacyOf(ghost), NO_USAGE);
      assert.deepStrictEqual(after.usage, before.usage);
      assert.deepEqual(after.totalTokens, before.totalTokens);
      assert.equal(after.totalCost, before.totalCost);
      assert.deepEqual(legacyOf(after.agents.find((agent) => agent.id === 'planner')), legacyOf(forged));
    } finally {
      await cleanup();
    }
  });
}

test('Usage aggregates: re-sending a stored event id does not change the summary (memory ring)', async () => {
  const store = new MemoryEventStore(50);
  const events = loadUsageFixture('docs-example');
  for (const event of events) await store.append(event);
  const before = await store.usageSummary();

  assert.equal((await store.append(events[2])).duplicate, true);
  const batch = await store.appendBatch(events);
  assert.equal(batch.accepted, 0);
  assert.equal(batch.duplicates, events.length);
  assert.deepStrictEqual(await store.usageSummary(), before);
});

test('Usage aggregates: re-sending any id stored in SQLite does not change the summary, even after the memory ring evicted it', async () => {
  const { dir, file } = tempDbPath('usage-dedup');
  const store = new SQLiteEventStore(file);
  try {
    const events = loadUsageFixture('docs-example');
    await store.appendBatch(events);
    const before = await store.usageSummary();

    // Push the usage events out of the in-memory ring (10,000 events) with events that carry no usage.
    const filler = Array.from({ length: 10_000 }, (_, index) => storeEvent(`evt_filler_${index}`, 10 + index));
    await store.appendBatch(filler);
    // The ring keeps the newest 10,000 events, so the four usage events (stored first) are no longer in memory.
    assert.equal((await store.snapshot()).eventsCount, 10_000);

    assert.equal((await store.append(events[2])).duplicate, true);
    const batch = await store.appendBatch(events);
    assert.equal(batch.accepted, 0);
    assert.deepStrictEqual(await store.usageSummary(), before);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
