import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryEventStore, SQLiteEventStore, parseMaxEvents, createEventStore } from '../server/store.ts';
import { eventFingerprint } from '../server/eventFingerprint.ts';
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

test('Usage aggregates: re-sending any id stored in SQLite does not change the summary, however many events were stored after it', async () => {
  const { dir, file } = tempDbPath('usage-dedup');
  const store = new SQLiteEventStore(file);
  try {
    const events = loadUsageFixture('docs-example');
    await store.appendBatch(events);
    const before = await store.usageSummary();

    // SQLite has no ring buffer (issue #52): unlike MemoryEventStore, eventsCount is the true stored count, not
    // capped at 10,000, and the dedup index never forgets an original however many events came after it.
    const filler = Array.from({ length: 10_000 }, (_, index) => storeEvent(`evt_filler_${index}`, 10 + index));
    await store.appendBatch(filler);
    assert.equal((await store.snapshot()).eventsCount, events.length + 10_000);

    assert.equal((await store.append(events[2])).duplicate, true);
    const batch = await store.appendBatch(events);
    assert.equal(batch.accepted, 0);
    assert.deepStrictEqual(await store.usageSummary(), before);
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

      // Cost stays null: the event's payload never reported a currency, so legacyCost() cannot single out one
      // (currency, costSource) pair to add up (issue #52 removed the direct `memoryFallback` this used to poke).
      assert.equal((await store.upsertAgent({ id: 'upsert-agent', name: 'Updated again' })).cost, null);
    }
  } finally {
    for (const store of stores) await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent.registered applies statusText (and status) when present, and agent.updated can still change it afterwards', async () => {
  // Issue #52: `POST /api/v1/agents` now resolves status/statusText itself and puts them in the `agent.registered`
  // payload, so a rebuild from storage reaches the same values the live route returned. The reducer must apply
  // them on `agent.registered`, not only on `agent.updated`.
  const store = new MemoryEventStore();
  await store.upsertAgent({ id: 'updated-status-text', name: 'Status Text' });
  await store.append(storeEvent('evt_status_text_registered', 5500, {
    type: 'agent.registered',
    agentId: 'updated-status-text',
    payload: { statusText: 'Registration text', status: 'CODING' },
  }));
  assert.equal((await store.getAgent('updated-status-text')).statusText, 'Registration text');
  assert.equal((await store.getAgent('updated-status-text')).status, 'CODING');
  await store.append(storeEvent('evt_status_text_updated', 6000, {
    type: 'agent.updated',
    agentId: 'updated-status-text',
    payload: { statusText: 'Updated profile text' },
  }));
  assert.equal((await store.getAgent('updated-status-text')).statusText, 'Updated profile text');
});

// -------------------------------------------------------------
// Ingestion integrity: duplicate vs conflict (issue #47)
// -------------------------------------------------------------

const sqliteFixtures = path.join(import.meta.dirname, 'fixtures/sqlite');

/** A validated llm.usage event, exactly as the server would store it. */
function usageEvent(id, payload = {}, envelope = {}) {
  const result = validateCanonicalEvent({
    id,
    type: 'llm.usage',
    timestamp: 1_700_000_000_000,
    source: 'agent:auditor',
    agentId: 'auditor',
    summary: 'Audited call',
    payload: { provider: 'p', model: 'm', inputTokens: 100, outputTokens: 10, cost: 0.01, currency: 'USD', costSource: 'provider-reported', ...payload },
    ...envelope,
  });
  assert.equal(result.success, true, JSON.stringify(result.issues));
  return result.data;
}

function withoutPayloadKey(event, key) {
  const payload = { ...event.payload };
  delete payload[key];
  return { ...event, payload };
}

const STORE_FACTORIES = [
  ['MemoryEventStore', () => ({ store: new MemoryEventStore(), cleanup: async () => {} })],
  ['SQLiteEventStore', () => {
    const { dir, file } = tempDbPath('integrity');
    const store = new SQLiteEventStore(file);
    return { store, file, cleanup: async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
  }],
];

for (const [label, create] of STORE_FACTORIES) {
  test(`${label}: accepted, duplicate and conflict outcomes, and the stored event never changes`, async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const { store, cleanup } = create();
    try {
      const original = usageEvent('evt_int_1');
      const first = await store.append(original);
      assert.deepEqual(first, {
        outcome: 'accepted',
        id: 'evt_int_1',
        fingerprint: eventFingerprint(original),
        seq: first.seq,
        duplicate: false,
        accepted: true,
      });
      assert.equal(typeof first.seq, 'number', 'an accepted event gets a seq (issue #54)');

      const retry = await store.append(JSON.parse(JSON.stringify(original)));
      assert.deepEqual(retry, {
        outcome: 'duplicate',
        id: 'evt_int_1',
        fingerprint: first.fingerprint,
        seq: null,
        duplicate: true,
        accepted: true,
        duplicateReason: 'event_id',
      });

      const before = await store.snapshot();
      const variants = [
        usageEvent('evt_int_1', { inputTokens: 101 }),
        usageEvent('evt_int_1', { cost: 0.02 }),
        usageEvent('evt_int_1', { cost: 0 }),
        withoutPayloadKey(original, 'cost'),
        { ...original, timestamp: original.timestamp + 1 },
      ];
      for (const variant of variants) {
        const conflict = await store.append(variant);
        assert.equal(conflict.outcome, 'conflict');
        assert.equal(conflict.duplicate, false);
        assert.equal(conflict.accepted, false);
        assert.equal(conflict.fingerprint, eventFingerprint(variant));
        assert.equal(conflict.storedFingerprint, first.fingerprint);
        assert.notEqual(conflict.fingerprint, conflict.storedFingerprint);
      }

      const after = await store.snapshot();
      assert.deepStrictEqual({ ...after, timestamp: 0 }, { ...before, timestamp: 0 }, 'totals unchanged after conflicts');
      const listed = await store.list({ limit: 10 });
      assert.equal(listed.length, 1);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(listed[0])), JSON.parse(JSON.stringify(original)));
      assert.deepEqual(store.ingestionCounters(), { conflicts: variants.length, legacyUnverifiedDuplicates: 0 });

      const conflictLines = warn.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('conflicting duplicate'));
      assert.equal(conflictLines.length, variants.length, 'one warn line per conflict');
      for (const line of conflictLines) {
        assert.ok(!line.includes('\n'), 'a single line');
        const logged = JSON.parse(line.slice(line.indexOf('{')));
        assert.deepEqual(Object.keys(logged).sort(), ['agentId', 'fingerprint', 'id', 'source', 'storedFingerprint', 'type']);
        assert.equal(logged.id, 'evt_int_1');
        assert.equal(logged.storedFingerprint, first.fingerprint);
        assert.ok(!line.includes('inputTokens') && !line.includes('payload'), 'the payload is never logged');
      }
    } finally {
      await cleanup();
    }
  });

  test(`${label}: a batch [A, A, A', B] is accepted, duplicate, conflict, accepted, and A' never replaces A`, async (t) => {
    t.mock.method(console, 'warn', () => {});
    const { store, cleanup } = create();
    try {
      const a = usageEvent('evt_batch_a');
      const aPrime = usageEvent('evt_batch_a', { outputTokens: 99 });
      const b = usageEvent('evt_batch_b', { inputTokens: 7 });
      const batch = await store.appendBatch([a, { ...a }, aPrime, b]);

      assert.equal(batch.accepted, 2);
      assert.equal(batch.duplicates, 1);
      assert.equal(batch.conflicts, 1);
      assert.deepEqual(batch.results.map(({ outcome }) => outcome), ['accepted', 'duplicate', 'conflict', 'accepted']);
      assert.deepEqual(batch.results.map(({ id }) => id), ['evt_batch_a', 'evt_batch_a', 'evt_batch_a', 'evt_batch_b']);
      assert.equal(batch.results[2].storedFingerprint, eventFingerprint(a));
      assert.equal(batch.results[2].fingerprint, eventFingerprint(aPrime));
      assert.deepEqual(batch.acceptedEvents.map(({ id }) => id), ['evt_batch_a', 'evt_batch_b']);
      assert.strictEqual(batch.acceptedEvents[0], a);

      const stored = await store.list({ limit: 10 });
      assert.deepEqual(stored.map(({ id }) => id).sort(), ['evt_batch_a', 'evt_batch_b']);
      assert.equal(stored.find(({ id }) => id === 'evt_batch_a').payload.outputTokens, 10, 'A is kept');
      const summary = await store.usageSummary();
      assert.equal(summary.total.calls, 2);
      assert.equal(summary.total.tokens.output.sum, 20);
      assert.deepEqual(store.ingestionCounters(), { conflicts: 1, legacyUnverifiedDuplicates: 0 });

      // Across requests: the same rules, and the counters keep adding up.
      const again = await store.appendBatch([b, aPrime]);
      assert.deepEqual(again.results.map(({ outcome }) => outcome), ['duplicate', 'conflict']);
      assert.deepEqual(again.acceptedEvents, []);
      assert.deepEqual(store.ingestionCounters(), { conflicts: 2, legacyUnverifiedDuplicates: 0 });
    } finally {
      await cleanup();
    }
  });

  test(`${label}: a type alias resolved by validation is a duplicate, not a conflict`, async () => {
    const { store, cleanup } = create();
    try {
      const body = { id: 'evt_alias_store', timestamp: 9, source: 'agent:ana', summary: 'hi', payload: { text: 'hola' } };
      const canonical = validateCanonicalEvent({ ...body, type: 'agent.message.sent' }).data;
      const alias = validateCanonicalEvent({ ...body, type: 'message.sent' }).data;
      assert.equal((await store.append(canonical)).outcome, 'accepted');
      assert.equal((await store.append(alias)).outcome, 'duplicate');
      assert.deepEqual(store.ingestionCounters(), { conflicts: 0, legacyUnverifiedDuplicates: 0 });
    } finally {
      await cleanup();
    }
  });
}

test('SQLiteEventStore: content_hash is written on every insert and equals the fingerprint', async () => {
  const { dir, file } = tempDbPath('content-hash');
  const store = new SQLiteEventStore(file);
  try {
    const single = usageEvent('evt_hash_single');
    const batch = [usageEvent('evt_hash_b1'), storeEvent('evt_hash_b2', 10)];
    await store.append(single);
    await store.appendBatch(batch);
    const db = new DatabaseSync(file);
    const rows = db.prepare('SELECT id, content_hash, event_json FROM events ORDER BY rowid').all();
    db.close();
    assert.deepEqual(rows.map(({ id }) => id), ['evt_hash_single', 'evt_hash_b1', 'evt_hash_b2']);
    for (const [index, event] of [single, ...batch].entries()) {
      assert.equal(rows[index].content_hash, eventFingerprint(event));
      assert.equal(rows[index].content_hash, eventFingerprint(JSON.parse(rows[index].event_json)));
    }
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLiteEventStore: a batch where one insert fails leaves no rows and runs no memory side effects', async () => {
  const { dir, file } = tempDbPath('batch-atomic');
  const store = new SQLiteEventStore(file);
  try {
    await store.append(usageEvent('evt_atomic_seed', { inputTokens: 5 }));
    const snapshotBefore = await store.snapshot();
    const countersBefore = store.ingestionCounters();

    // The insert statement throws on the second row of the batch.
    const realPrepareInsert = store.prepareInsert.bind(store);
    store.prepareInsert = () => {
      const statement = realPrepareInsert();
      let calls = 0;
      return {
        run: (...args) => {
          calls++;
          if (calls === 2) throw new Error('disk I/O error (test stub)');
          return statement.run(...args);
        },
      };
    };
    await assert.rejects(
      store.appendBatch([usageEvent('evt_atomic_1'), usageEvent('evt_atomic_2'), usageEvent('evt_atomic_3')]),
      /disk I\/O error \(test stub\)/
    );
    store.prepareInsert = realPrepareInsert;

    const db = new DatabaseSync(file);
    assert.deepEqual(db.prepare('SELECT id FROM events ORDER BY rowid').all().map(({ id }) => id), ['evt_atomic_seed']);
    db.close();
    const snapshotAfter = await store.snapshot();
    assert.deepStrictEqual({ ...snapshotAfter, timestamp: 0 }, { ...snapshotBefore, timestamp: 0 });
    assert.deepEqual(store.ingestionCounters(), countersBefore);

    // The store is usable afterwards: the transaction was rolled back, not left open.
    const retry = await store.appendBatch([usageEvent('evt_atomic_1'), usageEvent('evt_atomic_2')]);
    assert.deepEqual(retry.results.map(({ outcome }) => outcome), ['accepted', 'accepted']);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLiteEventStore: a UNIQUE violation on insert is classified, never surfaced as an error', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { dir, file } = tempDbPath('unique-backstop');
  const store = new SQLiteEventStore(file);
  try {
    const original = usageEvent('evt_race');
    await store.append(original);

    // Simulate a lookup that missed the row (another writer inserted it in between): the insert then hits the key.
    const realPrepareLookup = store.prepareLookup.bind(store);
    store.prepareLookup = () => {
      const statement = realPrepareLookup();
      let calls = 0;
      return { get: (...args) => (++calls === 1 ? undefined : statement.get(...args)) };
    };
    assert.equal((await store.append(original)).outcome, 'duplicate');
    const conflict = await store.append(usageEvent('evt_race', { inputTokens: 1 }));
    assert.equal(conflict.outcome, 'conflict');
    assert.equal(conflict.storedFingerprint, eventFingerprint(original));
    const batch = await store.appendBatch([usageEvent('evt_race', { inputTokens: 2 })]);
    assert.deepEqual(batch.results.map(({ outcome }) => outcome), ['conflict']);
    store.prepareLookup = realPrepareLookup;
    assert.deepEqual(store.ingestionCounters(), { conflicts: 2, legacyUnverifiedDuplicates: 0 });
    assert.equal((await store.usageSummary()).total.calls, 1);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLiteEventStore: a 0.2.1 database migrates, backfills content_hash and then rejects a conflict on a backfilled row', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const { dir, file } = tempDbPath('backfill-021');
  fs.copyFileSync(path.join(sqliteFixtures, 'agent-viewer-0.2.1.db'), file);
  const store = new SQLiteEventStore(file, { backup: 'off' });
  try {
    assert.deepEqual(store.migration.applied.map(({ name }) => name), ['baseline', 'content-hash', 'request-key-dedup', 'events-seq']);
    const db = new DatabaseSync(file);
    const rows = db.prepare('SELECT id, event_json, content_hash FROM events ORDER BY rowid').all();
    db.close();
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.match(row.content_hash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(row.content_hash, eventFingerprint(JSON.parse(row.event_json)));
    }

    const stored = JSON.parse(rows[0].event_json);
    const retry = await store.append(stored);
    assert.equal(retry.outcome, 'duplicate');
    const changed = { ...stored, payload: { ...stored.payload, inputTokens: stored.payload.inputTokens + 1 } };
    const conflict = await store.append(changed);
    assert.equal(conflict.outcome, 'conflict');
    assert.equal(conflict.storedFingerprint, rows[0].content_hash);
    assert.deepEqual(store.ingestionCounters(), { conflicts: 1, legacyUnverifiedDuplicates: 0 });
    const listed = (await store.list({ limit: 100 })).find(({ id }) => id === stored.id);
    assert.deepStrictEqual(listed, stored, 'the stored row is unchanged');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLiteEventStore: pre-0.2.0 rows keep a NULL hash, count as unverified duplicates and warn once per process', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const { dir, file } = tempDbPath('legacy-null-hash');
  fs.copyFileSync(path.join(sqliteFixtures, 'agent-viewer-0.1.x-2b00789.db'), file);
  const store = new SQLiteEventStore(file, { backup: 'off' });
  try {
    const db = new DatabaseSync(file);
    const rows = db.prepare('SELECT id, content_hash, event_json FROM events ORDER BY rowid').all();
    db.close();
    assert.ok(rows.length > 0);
    assert.ok(rows.every(({ content_hash, event_json }) => content_hash === null && event_json === null));

    const [legacy] = (await store.list({ limit: 100 })).filter(({ id }) => id === rows[0].id);
    const before = await store.usageSummary();
    // Whatever the content, a row that cannot be compared is a duplicate: never a conflict, never stored again.
    const same = await store.append(legacy);
    const different = await store.append({ ...legacy, timestamp: legacy.timestamp + 5, summary: 'other content' });
    const batch = await store.appendBatch([{ ...legacy, summary: 'third' }]);
    assert.equal(same.outcome, 'duplicate');
    assert.equal(different.outcome, 'duplicate');
    assert.equal(different.storedFingerprint, undefined);
    assert.deepEqual(batch.results.map(({ outcome }) => outcome), ['duplicate']);
    assert.deepEqual(store.ingestionCounters(), { conflicts: 0, legacyUnverifiedDuplicates: 3 });
    assert.deepStrictEqual(await store.usageSummary(), before);

    const legacyLines = warn.mock.calls.filter((call) => String(call.arguments[0]).includes('without content_hash'));
    assert.equal(legacyLines.length, 1, 'one warn line per process');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLiteEventStore: rows with unparseable or empty event_json keep a NULL hash after the migration', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const { dir, file } = tempDbPath('unparseable');
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
      created_at INTEGER NOT NULL,
      event_json TEXT
    );
  `);
  const insert = legacy.prepare(
    'INSERT INTO events (id, type, timestamp, runtime_id, session_id, agent_id, task_id, severity, summary, payload, created_at, event_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const good = storeEvent('evt_good_json', 700);
  insert.run('evt_good_json', good.type, 700, null, null, 'writer', null, 'normal', good.summary, JSON.stringify(good.payload), 1, JSON.stringify(good));
  insert.run('evt_bad_json', 'agent.message.sent', 701, null, null, 'writer', null, 'normal', 'Bad', '{"text":"x"}', 2, '{not json');
  insert.run('evt_empty_json', 'agent.message.sent', 702, null, null, 'writer', null, 'normal', 'Empty', '{"text":"y"}', 3, '');
  legacy.close();

  const store = new SQLiteEventStore(file, { backup: 'off' });
  try {
    const db = new DatabaseSync(file);
    const hashes = Object.fromEntries(db.prepare('SELECT id, content_hash FROM events').all().map(({ id, content_hash }) => [id, content_hash]));
    db.close();
    assert.equal(hashes.evt_good_json, eventFingerprint(good));
    assert.equal(hashes.evt_bad_json, null);
    assert.equal(hashes.evt_empty_json, null);

    assert.equal((await store.append(storeEvent('evt_bad_json', 999))).outcome, 'duplicate');
    assert.equal((await store.append(storeEvent('evt_empty_json', 999))).outcome, 'duplicate');
    assert.equal((await store.append({ ...good, timestamp: 999 })).outcome, 'conflict');
    assert.deepEqual(store.ingestionCounters(), { conflicts: 1, legacyUnverifiedDuplicates: 2 });
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('MemoryEventStore: ingestionCounters never reports legacy rows and exists() stays an id-only check', async () => {
  const store = new MemoryEventStore();
  await store.append(usageEvent('evt_exists'));
  assert.equal(await store.exists('evt_exists'), true);
  assert.equal(await store.exists('evt_missing'), false);
  assert.deepEqual(store.ingestionCounters(), { conflicts: 0, legacyUnverifiedDuplicates: 0 });
});

// -------------------------------------------------------------
// Request-id deduplication (issue #48): (provider, requestId) is a second dedup key for llm.usage/llm.failed.
// -------------------------------------------------------------

function failedEvent(id, payload = {}) {
  const result = validateCanonicalEvent({
    id,
    type: 'llm.failed',
    timestamp: 1_700_000_000_000,
    source: 'agent:auditor',
    agentId: 'auditor',
    summary: 'Failed call',
    payload: { provider: 'p', model: 'm', errorKind: 'rate_limited', ...payload },
  });
  assert.equal(result.success, true, JSON.stringify(result.issues));
  return result.data;
}

for (const [label, create] of STORE_FACTORIES) {
  test(`${label}: a request_id duplicate is stored as a reference, never counted, never listed, and findByRequest/listDuplicates see it`, async () => {
    const { store, cleanup } = create();
    try {
      const original = usageEvent('evt_rk_original', { provider: 'OpenAI', requestId: ' req-1 ' });
      const first = await store.append(original);
      assert.equal(first.outcome, 'accepted');

      const beforeSnapshot = await store.snapshot();

      const duplicate = usageEvent('evt_rk_duplicate', { provider: ' openai', requestId: 'req-1', inputTokens: 500 });
      const second = await store.append(duplicate);
      assert.equal(second.outcome, 'duplicate');
      assert.equal(second.duplicateReason, 'request_id');
      assert.equal(second.id, 'evt_rk_original');
      assert.equal(second.submittedId, 'evt_rk_duplicate');
      assert.equal(second.matchesOriginal, false);

      // exists() is true for the duplicate's own id, but list() and the snapshot's event list never include it.
      assert.equal(await store.exists('evt_rk_duplicate'), true);
      const listed = await store.list({ limit: 100 });
      assert.ok(!listed.some((e) => e.id === 'evt_rk_duplicate'));
      assert.ok(listed.some((e) => e.id === 'evt_rk_original'));

      const afterSnapshot = await store.snapshot();
      assert.deepStrictEqual(
        { ...afterSnapshot, timestamp: 0, usageDuplicates: null },
        { ...beforeSnapshot, timestamp: 0, usageDuplicates: null },
        'totals and agent fields unchanged by a request_id duplicate'
      );
      assert.deepStrictEqual(afterSnapshot.usageDuplicates, { count: 1, mismatched: 1, unverified: 0 });

      const found = await store.findByRequest('OPENAI', ' req-1 ');
      assert.deepEqual(found, { id: 'evt_rk_original' });
      assert.equal(await store.findByRequest('openai', 'unknown-request'), null);

      const duplicates = await store.listDuplicates();
      assert.equal(duplicates.length, 1);
      assert.equal(duplicates[0].id, 'evt_rk_duplicate');
      assert.equal(duplicates[0].duplicateOf, 'evt_rk_original');
      assert.equal(duplicates[0].provider, 'openai');
      assert.equal(duplicates[0].requestId, 'req-1');
      assert.equal(duplicates[0].matchesOriginal, false);
      // SQLite round-trips through JSON, which drops undefined fields; compare the JSON-normalized shape.
      assert.deepStrictEqual(JSON.parse(JSON.stringify(duplicates[0].event)), JSON.parse(JSON.stringify(duplicate)));

      assert.deepEqual(await store.listDuplicates({ provider: 'someone-else' }), []);
      assert.deepEqual(await store.listDuplicates({ duplicateOf: 'evt_rk_original' }), duplicates);
      assert.deepEqual(await store.listDuplicates({ requestId: 'req-1' }), duplicates);

      // Resending the duplicate's own id resolves to the original as an event_id duplicate.
      const resend = await store.append(duplicate);
      assert.equal(resend.outcome, 'duplicate');
      assert.equal(resend.duplicateReason, 'event_id');
      assert.equal(resend.id, 'evt_rk_original');
      assert.equal(resend.submittedId, 'evt_rk_duplicate');

      // list({ afterId }) never resurrects a duplicate reference either.
      const another = usageEvent('evt_rk_after', { provider: 'openai', requestId: 'req-after' });
      await store.append(another);
      const afterIdResults = await store.list({ afterId: 'evt_rk_original' });
      assert.ok(!afterIdResults.some((e) => e.id === 'evt_rk_duplicate'));
      assert.ok(afterIdResults.some((e) => e.id === 'evt_rk_after'));
    } finally {
      await cleanup();
    }
  });

  test(`${label}: the same requestId under two different providers is counted twice (two originals)`, async () => {
    const { store, cleanup } = create();
    try {
      const a = usageEvent('evt_rk_provA', { provider: 'provider-a', requestId: 'shared' });
      const b = usageEvent('evt_rk_provB', { provider: 'provider-b', requestId: 'shared' });
      assert.equal((await store.append(a)).outcome, 'accepted');
      assert.equal((await store.append(b)).outcome, 'accepted');
      assert.equal((await store.usageSummary()).total.calls, 2);
    } finally {
      await cleanup();
    }
  });

  test(`${label}: events without a requestId, or with a blank one, are never linked by the request key`, async () => {
    const { store, cleanup } = create();
    try {
      const none = usageEvent('evt_rk_none', { provider: 'noreq' });
      const blank = usageEvent('evt_rk_blank', { provider: 'noreq', requestId: '   ' });
      assert.equal((await store.append(none)).outcome, 'accepted');
      const result = await store.append(blank);
      assert.equal(result.outcome, 'accepted', 'a blank requestId never links two different ids');
      assert.equal(await store.findByRequest('noreq', ''), null);
    } finally {
      await cleanup();
    }
  });

  test(`${label}: llm.failed followed by llm.usage with the same key is a request_id duplicate; a third report points to the original`, async () => {
    const { store, cleanup } = create();
    try {
      const failed = failedEvent('evt_rk_failed', { provider: 'anthropic', requestId: 'req-mixed' });
      assert.equal((await store.append(failed)).outcome, 'accepted');

      const usage = usageEvent('evt_rk_usage', { provider: 'anthropic', requestId: 'req-mixed' });
      const second = await store.append(usage);
      assert.equal(second.outcome, 'duplicate');
      assert.equal(second.duplicateReason, 'request_id');
      assert.equal(second.id, 'evt_rk_failed');
      assert.equal(second.matchesOriginal, false, 'llm.failed and llm.usage can never match: type differs');

      const third = usageEvent('evt_rk_third', { provider: 'anthropic', requestId: 'req-mixed' });
      const thirdResult = await store.append(third);
      assert.equal(thirdResult.id, 'evt_rk_failed', 'a third report still points to the original, never to a duplicate');

      const duplicates = await store.listDuplicates({ duplicateOf: 'evt_rk_failed' });
      assert.equal(duplicates.length, 2);
    } finally {
      await cleanup();
    }
  });

  test(`${label}: a cost of null against a stored cost of 0 (or the reverse) is a mismatch; unknown is never zero`, async () => {
    const { store, cleanup } = create();
    try {
      const original = usageEvent('evt_rk_cost_null', { provider: 'costp', requestId: 'req-cost', cost: null, currency: null, costSource: 'unknown' });
      assert.equal((await store.append(original)).outcome, 'accepted');
      const zeroCost = usageEvent('evt_rk_cost_zero', { provider: 'costp', requestId: 'req-cost', cost: 0, currency: 'USD', costSource: 'provider-reported' });
      const result = await store.append(zeroCost);
      assert.equal(result.matchesOriginal, false);
    } finally {
      await cleanup();
    }
  });

  test(`${label}: a matching request_id duplicate reports matchesOriginal true and logs no warning`, async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const { store, cleanup } = create();
    try {
      const original = usageEvent('evt_rk_match_1', { provider: 'matchp', requestId: 'req-match' });
      await store.append(original);
      const matching = usageEvent('evt_rk_match_2', { provider: 'matchp', requestId: 'req-match' });
      const result = await store.append(matching);
      assert.equal(result.matchesOriginal, true);
      const mismatchLines = warn.mock.calls.filter((call) => String(call.arguments[0]).includes('does not match its original'));
      assert.equal(mismatchLines.length, 0);
    } finally {
      await cleanup();
    }
  });

  test(`${label}: in a batch, two events sharing a key resolve as original then request_id duplicate, in input order`, async () => {
    const { store, cleanup } = create();
    try {
      const first = usageEvent('evt_rk_batch_1', { provider: 'batchp', requestId: 'req-batch' });
      const second = usageEvent('evt_rk_batch_2', { provider: 'batchp', requestId: 'req-batch', inputTokens: 1 });
      const plainResend = { ...first };
      const batch = await store.appendBatch([first, second, plainResend]);
      assert.equal(batch.results.length, 3);
      assert.equal(batch.results[0].outcome, 'accepted');
      assert.equal(batch.results[1].outcome, 'duplicate');
      assert.equal(batch.results[1].duplicateReason, 'request_id');
      assert.equal(batch.results[1].id, 'evt_rk_batch_1');
      assert.equal(batch.results[1].submittedId, 'evt_rk_batch_2');
      assert.equal(batch.results[2].outcome, 'duplicate');
      assert.equal(batch.results[2].duplicateReason, 'event_id');
      assert.deepEqual(batch.acceptedEvents.map((e) => e.id), ['evt_rk_batch_1']);
    } finally {
      await cleanup();
    }
  });
}

test('MemoryEventStore: a report with the same key is still a duplicate, and totals do not change, after the original falls off the retained window', async () => {
  const store = new MemoryEventStore(3);
  const original = usageEvent('evt_rk_evict_original', { provider: 'evictp', requestId: 'req-evict' });
  await store.append(original);
  await store.append(usageEvent('evt_rk_evict_filler_1'));
  await store.append(usageEvent('evt_rk_evict_filler_2'));
  await store.append(usageEvent('evt_rk_evict_filler_3'));
  // The retained window holds only maxEvents (3), so the original is no longer listed, but the dedup index
  // never forgets an accepted id (issue #53): exists() and a retry of the id itself must both still see it.
  assert.equal(await store.exists('evt_rk_evict_original'), true);

  const before = await store.usageSummary();
  const late = usageEvent('evt_rk_evict_late', { provider: 'evictp', requestId: 'req-evict', inputTokens: 99999 });
  const result = await store.append(late);
  assert.equal(result.outcome, 'duplicate');
  assert.equal(result.duplicateReason, 'request_id');
  assert.equal(result.id, 'evt_rk_evict_original');

  const after = await store.usageSummary();
  assert.deepStrictEqual(after, before, 'totals unchanged by a duplicate reported after the original was evicted');
});

test('SQLiteEventStore: a 0.2.1-shaped database with two same-key usage rows migrates with duplicate_of set and matches_original NULL', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  const { dir, file } = tempDbPath('request-key-legacy');
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
  const insert = legacy.prepare(
    'INSERT INTO events (id, type, timestamp, runtime_id, session_id, agent_id, task_id, severity, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  // A row written before event_json existed (migration 0001's own legacy case), unrelated to the request key.
  insert.run('evt_legacy_no_json', 'agent.status.changed', 100, null, null, 'old-agent', null, 'normal', 'Legacy row', '{"status":"IDLE"}', 1);
  // Two usage rows sharing a (provider, requestId) key: the earlier one (lowest rowid) must become the original.
  insert.run(
    'evt_legacy_usage_1', 'llm.usage', 200, null, null, 'auditor', null, 'normal', 'First',
    JSON.stringify({ provider: 'Legacy-Provider', model: 'm', inputTokens: 10, outputTokens: 5, requestId: 'legacy-req-1' }), 2
  );
  insert.run(
    'evt_legacy_usage_2', 'llm.usage', 300, null, null, 'auditor', null, 'normal', 'Second',
    JSON.stringify({ provider: 'legacy-provider', model: 'm', inputTokens: 10, outputTokens: 5, requestId: ' legacy-req-1 ' }), 3
  );
  legacy.close();

  let store = new SQLiteEventStore(file, { backup: 'off' });
  try {
    const db = new DatabaseSync(file);
    const columns = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
    for (const column of ['request_provider', 'request_id', 'duplicate_of', 'matches_original']) {
      assert.ok(columns.includes(column), `expected column ${column}`);
    }
    const indexNames = db.prepare('PRAGMA index_list(events)').all().map((i) => i.name);
    assert.ok(indexNames.includes('idx_events_request_key'));
    assert.ok(!indexNames.includes('idx_events_request_lookup_tmp'));

    const rows = Object.fromEntries(
      db.prepare('SELECT id, request_provider, request_id, duplicate_of, matches_original FROM events').all().map((r) => [r.id, r])
    );
    db.close();
    assert.equal(rows.evt_legacy_no_json.request_id, null);
    assert.equal(rows.evt_legacy_usage_1.duplicate_of, null);
    assert.equal(rows.evt_legacy_usage_2.duplicate_of, 'evt_legacy_usage_1');
    assert.equal(rows.evt_legacy_usage_2.matches_original, null, 'legacy content was never compared under this rule');

    const duplicates = await store.listDuplicates();
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].id, 'evt_legacy_usage_2');
    assert.equal(duplicates[0].duplicateOf, 'evt_legacy_usage_1');
    assert.equal(duplicates[0].matchesOriginal, null);

    const snapshot = await store.snapshot();
    assert.deepStrictEqual(snapshot.usageDuplicates, { count: 1, mismatched: 0, unverified: 1 });

    const listed = (await store.list({ limit: 100 })).map((e) => e.id);
    assert.ok(!listed.includes('evt_legacy_usage_2'));
    assert.ok(listed.includes('evt_legacy_usage_1'));

    await store.close();

    // Reopening is a no-op: migration 3 does not run twice and the shape stays the same.
    store = new SQLiteEventStore(file, { backup: 'off' });
    assert.equal(store.migration.applied.length, 0);
    const reopened = await store.listDuplicates();
    assert.deepStrictEqual(reopened, duplicates);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLiteEventStore: a UNIQUE violation on the request key is classified as a duplicate, never surfaced as an error, and never reaches the memory fallback', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { dir, file } = tempDbPath('request-key-race');
  const store = new SQLiteEventStore(file);
  try {
    const original = usageEvent('evt_race_rk_original', { provider: 'racep', requestId: 'req-race' });
    await store.append(original);

    // Force the race path: the lookup misses the row once (another writer inserted it in between), so the plain
    // insert runs and hits the UNIQUE index on (request_provider, request_id); the store must recover from that.
    const realLookupRequestKey = store.lookupRequestKey.bind(store);
    let calls = 0;
    store.lookupRequestKey = (...args) => (++calls === 1 ? null : realLookupRequestKey(...args));

    const duplicate = usageEvent('evt_race_rk_duplicate', { provider: 'racep', requestId: 'req-race', inputTokens: 1 });
    const result = await store.append(duplicate);
    store.lookupRequestKey = realLookupRequestKey;

    assert.equal(result.outcome, 'duplicate');
    assert.equal(result.duplicateReason, 'request_id');
    assert.equal(result.id, 'evt_race_rk_original');
    assert.equal(result.submittedId, 'evt_race_rk_duplicate');

    const db = new DatabaseSync(file);
    const row = db.prepare('SELECT duplicate_of FROM events WHERE id = ?').get('evt_race_rk_duplicate');
    db.close();
    assert.equal(row.duplicate_of, 'evt_race_rk_original');

    // The race path never forwards the event to the memory fallback: only an 'accepted' outcome does that.
    assert.equal((await store.usageSummary()).total.calls, 1);

    // A true primary-key violation on events.id is still classified normally and never mistaken for the race.
    const idConflict = await store.append({ ...original, timestamp: original.timestamp + 1 });
    assert.equal(idConflict.outcome, 'conflict');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Issue #53: no silent loss, no double counting after eviction, configurable cap
// -------------------------------------------------------------

test('MemoryEventStore: constructor options are backward compatible with a bare number, and reject an invalid maxEvents', async () => {
  const legacy = new MemoryEventStore(50);
  assert.equal((await legacy.retention()).maxEvents, 50);

  const viaOptions = new MemoryEventStore({ maxEvents: 7 });
  assert.equal((await viaOptions.retention()).maxEvents, 7);

  const defaulted = new MemoryEventStore();
  assert.equal((await defaulted.retention()).maxEvents, 10000);

  for (const bad of [0, -1, 1.5, NaN]) {
    assert.throws(() => new MemoryEventStore({ maxEvents: bad }));
  }
});

test('MemoryEventStore: retrying an evicted event id via append() is a duplicate; totals, runtimes, sessions and agents do not change', async () => {
  const store = new MemoryEventStore(3);
  const original = usageEvent('evt_evict_retry', { inputTokens: 1000 }, { runtimeId: 'rt_evict', sessionId: 'ses_evict' });
  await store.append(original);
  await store.append(usageEvent('evt_evict_filler_1'));
  await store.append(usageEvent('evt_evict_filler_2'));
  await store.append(usageEvent('evt_evict_filler_3'));

  assert.equal(await store.exists('evt_evict_retry'), true);
  const before = await store.snapshot();

  const retry = await store.append(original);
  assert.equal(retry.outcome, 'duplicate');
  assert.equal(retry.accepted, true);
  assert.equal(retry.duplicate, true);

  const after = await store.snapshot();
  assert.deepStrictEqual(after.usage, before.usage);
  assert.deepStrictEqual(after.totalTokens, before.totalTokens);
  assert.equal(after.totalCost, before.totalCost);
  assert.deepStrictEqual(after.runtimes, before.runtimes);
  assert.deepStrictEqual(after.sessions, before.sessions);
  assert.deepStrictEqual(after.agents, before.agents);
  assert.deepStrictEqual(after.retention, before.retention, 'a duplicate never moves a retention counter');
});

test('MemoryEventStore: appendBatch retries an evicted id, mixes it with new ids, and repeats a new id twice in one batch', async () => {
  const store = new MemoryEventStore(3);
  const original = usageEvent('evt_evict_batch_retry', { inputTokens: 500 });
  await store.append(original);
  await store.appendBatch([usageEvent('evt_evict_batch_f1'), usageEvent('evt_evict_batch_f2'), usageEvent('evt_evict_batch_f3')]);
  assert.equal(await store.exists('evt_evict_batch_retry'), true);

  const before = await store.usageSummary();
  const newEvent = usageEvent('evt_evict_batch_new', { inputTokens: 7 });
  const batch = await store.appendBatch([original, newEvent, { ...newEvent }]);
  assert.equal(batch.results[0].outcome, 'duplicate');
  assert.equal(batch.results[1].outcome, 'accepted');
  assert.equal(batch.results[2].outcome, 'duplicate');
  assert.equal(batch.accepted, 1);
  assert.equal(batch.duplicates, 2);

  const after = await store.usageSummary();
  assert.equal(after.total.calls - before.total.calls, 1, 'only the genuinely new event is counted, once');
});

test('MemoryEventStore: exists() stays true for a plain event id (no request key) after it falls off the retained window', async () => {
  const store = new MemoryEventStore(2);
  await store.append(storeEvent('evt_plain_evict', 1));
  await store.append(storeEvent('evt_plain_filler_1', 2));
  await store.append(storeEvent('evt_plain_filler_2', 3));
  assert.equal(await store.exists('evt_plain_evict'), true);
  assert.deepEqual((await store.list()).map((e) => e.id), ['evt_plain_filler_2', 'evt_plain_filler_1']);
});

test('MemoryEventStore: retention counters and since follow the injected clock, and since is null before any eviction', async () => {
  let clock = 1_000;
  const store = new MemoryEventStore({ maxEvents: 2, now: () => clock });

  await store.append(storeEvent('evt_ret_1', 1));
  let retention = await store.retention();
  assert.deepEqual(retention, {
    storage: 'memory',
    maxEvents: 2,
    retainedEvents: 1,
    acceptedEvents: 1,
    droppedEvents: 0,
    since: null,
    totalsSince: 1_000,
  });

  clock = 2_000;
  await store.append(storeEvent('evt_ret_2', 2));
  retention = await store.retention();
  assert.equal(retention.droppedEvents, 0);
  assert.equal(retention.since, null);

  clock = 3_000;
  await store.append(storeEvent('evt_ret_3', 3)); // evicts evt_ret_1, received at clock 1000
  retention = await store.retention();
  assert.equal(retention.retainedEvents, 2);
  assert.equal(retention.acceptedEvents, 3);
  assert.equal(retention.droppedEvents, 1);
  assert.equal(retention.since, 2_000, 'oldest retained event (evt_ret_2) was received at clock 2000');
  assert.equal(retention.totalsSince, 1_000);

  // A retry of the evicted id is a duplicate: it must not move any retention counter.
  const before = retention;
  const retry = await store.append(storeEvent('evt_ret_1', 1));
  assert.equal(retry.duplicate, true);
  assert.deepEqual(await store.retention(), before);
});

test('MemoryEventStore: a single batch larger than maxEvents is fully counted in totals and acceptedEvents, and retains exactly the newest maxEvents', async () => {
  const store = new MemoryEventStore(5);
  const events = Array.from({ length: 12 }, (_, i) => usageEvent(`evt_bigbatch_${i}`, { inputTokens: 1 }));
  const batch = await store.appendBatch(events);
  assert.equal(batch.accepted, 12);

  const retention = await store.retention();
  assert.equal(retention.acceptedEvents, 12);
  assert.equal(retention.retainedEvents, 5);
  assert.equal(retention.droppedEvents, 7);

  const retainedIds = (await store.list({ limit: 100 })).map((e) => e.id);
  assert.deepEqual(retainedIds, ['evt_bigbatch_11', 'evt_bigbatch_10', 'evt_bigbatch_9', 'evt_bigbatch_8', 'evt_bigbatch_7']);

  const summary = await store.usageSummary();
  assert.equal(summary.total.calls, 12, 'every accepted event counts toward totals, evicted or not');
});

/** Reference (non-ring) implementation of `list()`, mirroring the array semantics this store replaced. */
function referenceList(acceptedNewestFirst, options = {}) {
  let result = acceptedNewestFirst;
  if (options.runtimeId) result = result.filter((e) => e.runtimeId === options.runtimeId);
  if (options.sessionId) result = result.filter((e) => e.sessionId === options.sessionId);
  if (options.agentId) result = result.filter((e) => e.agentId === options.agentId);
  if (options.type) result = result.filter((e) => e.type === options.type);
  if (options.since !== undefined) result = result.filter((e) => e.timestamp >= options.since);
  if (options.afterId) {
    const index = result.findIndex((e) => e.id === options.afterId);
    if (index >= 0) result = result.slice(0, index);
  }
  const limit = options.limit && options.limit > 0 ? options.limit : 100;
  return result.slice(0, limit).map((e) => e.id);
}

/** Deterministic seeded PRNG (mulberry32), so the differential and invariant tests below are reproducible. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return function () {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('MemoryEventStore: list() matches a reference array implementation across random filters (seeded differential test)', async () => {
  const rand = mulberry32(53);
  const maxEvents = 15;
  const store = new MemoryEventStore(maxEvents);
  const runtimes = ['rt_a', 'rt_b', undefined];
  const sessions = ['ses_a', 'ses_b', undefined];
  const agents = ['agent_a', 'agent_b', undefined];
  const types = ['agent.message.sent', 'llm.usage'];
  const acceptedNewestFirst = [];

  const totalEvents = 60;
  for (let i = 0; i < totalEvents; i++) {
    const type = types[Math.floor(rand() * types.length)];
    const candidate = {
      id: `evt_diff_${i}`,
      type,
      timestamp: 1000 + i,
      runtimeId: runtimes[Math.floor(rand() * runtimes.length)],
      sessionId: sessions[Math.floor(rand() * sessions.length)],
      agentId: agents[Math.floor(rand() * agents.length)],
      source: 'agent:diff',
      summary: `Event ${i}`,
      payload: type === 'llm.usage' ? { provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1 } : { text: 'x' },
    };
    const validated = validateCanonicalEvent(candidate);
    assert.equal(validated.success, true, JSON.stringify(validated.issues));
    await store.append(validated.data);
    acceptedNewestFirst.unshift(validated.data);
  }
  // The store only retains the newest maxEvents; slicing the full newest-first reference the same way lets the
  // rest of the comparison reuse the exact filter order of the previous array implementation.
  const retained = acceptedNewestFirst.slice(0, maxEvents);

  const scenarios = [
    {},
    { limit: 5 },
    { runtimeId: 'rt_a' },
    { sessionId: 'ses_b', limit: 3 },
    { agentId: 'agent_a' },
    { type: 'llm.usage' },
    { since: 1000 + totalEvents - maxEvents + 2 },
    { afterId: retained[5]?.id },
    { afterId: 'evt_unknown' },
    { runtimeId: 'rt_b', type: 'llm.usage', limit: 2 },
  ];

  for (const options of scenarios) {
    const actual = (await store.list(options)).map((e) => e.id);
    const expected = referenceList(retained, options);
    assert.deepEqual(actual, expected, `scenario ${JSON.stringify(options)}`);
  }
});

test('MemoryEventStore: seeded randomized sequence keeps acceptedEvents == retainedEvents + droppedEvents, and totals equal the sum over unique accepted ids', async () => {
  const rand = mulberry32(9311);
  const maxEvents = 6;
  const store = new MemoryEventStore(maxEvents);
  const allIds = [];
  const expectedInputById = new Map();

  const operations = 300;
  for (let i = 0; i < operations; i++) {
    const retryExisting = allIds.length > 0 && rand() < 0.4;
    let id;
    let inputTokens;
    if (retryExisting) {
      id = allIds[Math.floor(rand() * allIds.length)];
      inputTokens = expectedInputById.get(id); // same content as the original: a duplicate, never a conflict
    } else {
      id = `evt_rand_${i}`;
      inputTokens = Math.floor(rand() * 1000);
      allIds.push(id);
      expectedInputById.set(id, inputTokens);
    }
    const result = await store.append(usageEvent(id, { inputTokens }));
    assert.notEqual(result.outcome, 'conflict', `unexpected conflict for ${id} at operation ${i}`);

    const retention = await store.retention();
    assert.equal(retention.acceptedEvents, retention.retainedEvents + retention.droppedEvents, `invariant broken at operation ${i}`);
  }

  const expectedTotal = Array.from(expectedInputById.values()).reduce((sum, value) => sum + value, 0);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.totalTokens.input, expectedTotal);
  assert.equal((await store.retention()).acceptedEvents, allIds.length);
});

test('MemoryEventStore: 200,000 appends with maxEvents=100000 finish well under 5s, and a huge cap does not preallocate', async () => {
  const store = new MemoryEventStore(100_000);
  const start = Date.now();
  for (let i = 0; i < 200_000; i++) {
    await store.append(storeEvent(`evt_perf_${i}`, i));
  }
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `expected under 5000ms, took ${elapsed}ms`);
  assert.equal((await store.retention()).retainedEvents, 100_000);
  assert.equal((await store.retention()).droppedEvents, 100_000);

  // A cap of 1e9 must not allocate a proportional array up front.
  const before = process.memoryUsage().heapUsed;
  const huge = new MemoryEventStore(1_000_000_000);
  const after = process.memoryUsage().heapUsed;
  assert.ok(after - before < 10 * 1024 * 1024, `constructing a store with a 1e9 cap used ${after - before} bytes`);
  assert.equal((await huge.retention()).retainedEvents, 0);
});

test('MemoryEventStore: logs the known-ids memory warning once when crossing 1,000,000 ids, not per event', { timeout: 60_000 }, async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const store = new MemoryEventStore(1);
  for (let i = 0; i < 1_000_001; i++) {
    await store.append(storeEvent(`evt_warn_${i}`, i));
  }
  const matches = warn.mock.calls.filter((call) => String(call.arguments[0]).includes('memory store has seen'));
  assert.equal(matches.length, 1);
  assert.match(String(matches[0].arguments[0]), /has seen 1000000 event ids/);
});

test('SQLiteEventStore: retention() reports the sqlite shape, eventsCount is the true row count, and the fallback forgets evicted ids', async () => {
  const { dir, file } = tempDbPath('retention-sqlite');
  const store = new SQLiteEventStore(file, { maxEvents: 2 });
  try {
    await store.append(usageEvent('evt_sqlite_ret_1'));
    await store.append(storeEvent('evt_sqlite_ret_2', 2));
    await store.append(storeEvent('evt_sqlite_ret_3', 3)); // evicts evt_sqlite_ret_1 from the fallback only

    const retention = await store.retention();
    assert.equal(retention.storage, 'sqlite');
    assert.equal(retention.maxEvents, null);
    assert.equal(retention.droppedEvents, 0);
    assert.equal(retention.since, null);
    assert.equal(retention.retainedEvents, 3, 'every row counts, not just the fallback window');
    assert.equal(retention.acceptedEvents, 3);

    // SQLite itself still knows the id (dedup source of truth is the table), unaffected by the fallback's cap.
    assert.equal(await store.exists('evt_sqlite_ret_1'), true);
    const retry = await store.append(usageEvent('evt_sqlite_ret_1'));
    assert.equal(retry.outcome, 'duplicate');

    const snapshot = await store.snapshot();
    assert.equal(snapshot.eventsCount, 3);
    assert.equal(snapshot.retention.storage, 'sqlite');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLiteEventStore: retention() never runs a per-call COUNT(*) (the SSE heartbeat polls it every 15s)', async () => {
  const { dir, file } = tempDbPath('retention-no-count');
  const store = new SQLiteEventStore(file);
  try {
    await store.append(usageEvent('evt_no_count_1'));
    const originalPrepare = store.db.prepare.bind(store.db);
    let countCalls = 0;
    store.db.prepare = (sql, ...rest) => {
      if (/COUNT\(/i.test(sql)) countCalls++;
      return originalPrepare(sql, ...rest);
    };
    await store.retention();
    await store.retention();
    await store.append(usageEvent('evt_no_count_2'));
    await store.retention();
    assert.equal(countCalls, 0);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseMaxEvents: valid values, defaults, and the documented invalid cases all throw', () => {
  assert.equal(parseMaxEvents('5'), 5);
  assert.equal(parseMaxEvents(undefined), 10000);
  assert.equal(parseMaxEvents(''), 10000);
  assert.equal(parseMaxEvents('   '), 10000);
  assert.equal(parseMaxEvents(' 25 '), 25);
  assert.equal(parseMaxEvents(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);

  const invalid = ['0', '-1', 'abc', '1e3', '10.5', '007', `${Number.MAX_SAFE_INTEGER}0`, '99999999999999999999'];
  for (const raw of invalid) {
    assert.throws(
      () => parseMaxEvents(raw),
      /AGENT_VIEWER_MAX_EVENTS must be a positive integer/,
      `expected "${raw}" to throw`
    );
  }
});

test('createEventStore: AGENT_VIEWER_MAX_EVENTS caps the memory store, and an invalid value throws at startup', (t) => {
  const previousStorage = process.env.AGENT_VIEWER_STORAGE;
  const previousMaxEvents = process.env.AGENT_VIEWER_MAX_EVENTS;
  t.after(() => {
    if (previousStorage === undefined) delete process.env.AGENT_VIEWER_STORAGE;
    else process.env.AGENT_VIEWER_STORAGE = previousStorage;
    if (previousMaxEvents === undefined) delete process.env.AGENT_VIEWER_MAX_EVENTS;
    else process.env.AGENT_VIEWER_MAX_EVENTS = previousMaxEvents;
  });

  delete process.env.AGENT_VIEWER_STORAGE;
  process.env.AGENT_VIEWER_MAX_EVENTS = '5';
  const store = createEventStore();
  assert.ok(store instanceof MemoryEventStore);

  process.env.AGENT_VIEWER_MAX_EVENTS = 'not-a-number';
  assert.throws(() => createEventStore(), /AGENT_VIEWER_MAX_EVENTS must be a positive integer/);
});

test('createEventStore: in SQLite mode, AGENT_VIEWER_MAX_EVENTS has no effect and logs once that it is ignored', (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const previousStorage = process.env.AGENT_VIEWER_STORAGE;
  const previousMaxEvents = process.env.AGENT_VIEWER_MAX_EVENTS;
  const previousPath = process.env.AGENT_VIEWER_SQLITE_PATH;
  const { dir, file } = tempDbPath('create-event-store-sqlite');
  t.after(() => {
    if (previousStorage === undefined) delete process.env.AGENT_VIEWER_STORAGE;
    else process.env.AGENT_VIEWER_STORAGE = previousStorage;
    if (previousMaxEvents === undefined) delete process.env.AGENT_VIEWER_MAX_EVENTS;
    else process.env.AGENT_VIEWER_MAX_EVENTS = previousMaxEvents;
    if (previousPath === undefined) delete process.env.AGENT_VIEWER_SQLITE_PATH;
    else process.env.AGENT_VIEWER_SQLITE_PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  process.env.AGENT_VIEWER_STORAGE = 'sqlite';
  process.env.AGENT_VIEWER_SQLITE_PATH = file;
  process.env.AGENT_VIEWER_MAX_EVENTS = '7';
  const store = createEventStore();
  assert.ok(store instanceof SQLiteEventStore);
  const notice = log.mock.calls.find((call) => String(call.arguments[0]).includes('AGENT_VIEWER_MAX_EVENTS has no effect in SQLite mode'));
  assert.ok(notice, 'expected a one-time notice that AGENT_VIEWER_MAX_EVENTS has no effect in SQLite mode');
});

// -------------------------------------------------------------
// Seq methods for SSE reconnect replay (issue #54)
// -------------------------------------------------------------

for (const [label, create] of STORE_FACTORIES) {
  test(`${label}: resolveCursor resolves a stored id and is null for an unknown one`, async () => {
    const { store, cleanup } = create();
    try {
      assert.equal(await store.resolveCursor('evt_seq_missing'), null);
      assert.equal(await store.headSeq(), null);

      const a = await store.append(storeEvent('evt_seq_a', 1));
      const b = await store.append(storeEvent('evt_seq_b', 2));
      assert.equal(typeof a.seq, 'number');
      assert.equal(typeof b.seq, 'number');
      assert.ok(b.seq > a.seq, 'seqs grow with each insertion');

      assert.equal(await store.resolveCursor('evt_seq_a'), a.seq);
      assert.equal(await store.resolveCursor('evt_seq_b'), b.seq);
      assert.equal(await store.resolveCursor('evt_seq_missing'), null);
      assert.equal(await store.headSeq(), b.seq);
    } finally {
      await cleanup();
    }
  });

  test(`${label}: a duplicate or a conflict never gets a seq`, async () => {
    const { store, cleanup } = create();
    try {
      const original = storeEvent('evt_seq_dup', 1);
      const first = await store.append(original);
      const duplicate = await store.append(JSON.parse(JSON.stringify(original)));
      const conflict = await store.append({ ...original, summary: 'different' });
      assert.equal(typeof first.seq, 'number');
      assert.equal(duplicate.seq, null);
      assert.equal(conflict.seq, null);
    } finally {
      await cleanup();
    }
  });

  test(`${label}: appendBatch returns acceptedSeqs aligned with acceptedEvents, growing with each insertion`, async () => {
    const { store, cleanup } = create();
    try {
      const events = [storeEvent('evt_seq_batch_1', 1), storeEvent('evt_seq_batch_2', 2), storeEvent('evt_seq_batch_3', 3)];
      const result = await store.appendBatch(events);
      assert.equal(result.acceptedEvents.length, 3);
      assert.equal(result.acceptedSeqs.length, 3);
      assert.ok(result.acceptedSeqs.every((seq) => typeof seq === 'number'));
      assert.ok(result.acceptedSeqs[0] < result.acceptedSeqs[1]);
      assert.ok(result.acceptedSeqs[1] < result.acceptedSeqs[2]);

      // A resend in a second batch is a duplicate: no seq, and acceptedSeqs stays aligned with acceptedEvents.
      const second = await store.appendBatch([events[0], storeEvent('evt_seq_batch_4', 4)]);
      assert.equal(second.acceptedEvents.length, 1);
      assert.equal(second.acceptedEvents[0].id, 'evt_seq_batch_4');
      assert.equal(second.acceptedSeqs.length, 1);
      assert.ok(second.acceptedSeqs[0] > result.acceptedSeqs[2]);
    } finally {
      await cleanup();
    }
  });

  test(`${label}: countBetween and listBetween return exactly the events after the cursor, ascending, with no gaps or overlap across a page boundary`, async () => {
    const { store, cleanup } = create();
    try {
      const seqs = [];
      for (let i = 0; i < 1200; i++) {
        const result = await store.append(storeEvent(`evt_seq_page_${i}`, i));
        seqs.push(result.seq);
      }
      const head = await store.headSeq();
      assert.equal(head, seqs.at(-1));

      const cursor = seqs[99]; // after the 100th event
      const total = await store.countBetween(cursor, head);
      assert.equal(total, 1100);

      // Page through with a page size that does not evenly divide the remainder, like the server does.
      const pageSize = 500;
      const pages = [];
      let afterSeq = cursor;
      for (;;) {
        const page = await store.listBetween(afterSeq, head, pageSize);
        if (page.length === 0) break;
        pages.push(page);
        afterSeq = page.at(-1).seq;
      }
      const allIds = pages.flat().map((entry) => entry.event.id);
      const expectedIds = seqs.slice(100).map((_, index) => `evt_seq_page_${index + 100}`);
      assert.deepStrictEqual(allIds, expectedIds, 'ascending, no gaps, no overlap, no duplicates');
      assert.deepStrictEqual(
        pages.map((page) => page.length),
        [500, 500, 100],
        'pages split exactly on the page-size boundary'
      );

      // Every page's seqs are ascending and the last seq of one page is less than the first of the next.
      let previousLast = cursor;
      for (const page of pages) {
        assert.ok(page[0].seq > previousLast);
        for (let i = 1; i < page.length; i++) assert.ok(page[i].seq > page[i - 1].seq);
        previousLast = page.at(-1).seq;
      }

      assert.deepStrictEqual(await store.listBetween(head, head, 10), [], 'nothing after the head itself');
      assert.equal(await store.countBetween(head, head), 0);
    } finally {
      await cleanup();
    }
  });
}

test('MemoryEventStore: an evicted cursor resolves to null, never to an unrelated event', async () => {
  const store = new MemoryEventStore(50);
  for (let i = 0; i < 60; i++) {
    await store.append(storeEvent(`evt_seq_evict_${i}`, i));
  }
  // The oldest 10 events fell off the 50-event ring.
  assert.equal(await store.resolveCursor('evt_seq_evict_0'), null);
  assert.equal(await store.resolveCursor('evt_seq_evict_9'), null);
  const stillThere = await store.resolveCursor('evt_seq_evict_10');
  assert.equal(typeof stillThere, 'number');
  const head = await store.headSeq();
  assert.equal(await store.countBetween(stillThere, head), 49);
});

test('SQLiteEventStore: events appended with descending timestamps still come back from listBetween in insertion order, and the seq from append equals the stored row seq', async () => {
  const { dir, file } = tempDbPath('seq-insertion-order');
  const store = new SQLiteEventStore(file);
  try {
    const first = await store.append(storeEvent('evt_seq_sqlite_old', 5_000));
    const second = await store.append(storeEvent('evt_seq_sqlite_mid', 3_000));
    const third = await store.append(storeEvent('evt_seq_sqlite_new', 1_000));

    const db = new DatabaseSync(file);
    for (const [id, result] of [
      ['evt_seq_sqlite_old', first],
      ['evt_seq_sqlite_mid', second],
      ['evt_seq_sqlite_new', third],
    ]) {
      const row = db.prepare('SELECT seq FROM events WHERE id = ?').get(id);
      assert.equal(result.seq, Number(row.seq), `${id}: append()'s seq equals the stored row's seq`);
    }
    db.close();

    const head = await store.headSeq();
    const page = await store.listBetween(0, head, 10);
    assert.deepStrictEqual(
      page.map((entry) => entry.event.id),
      ['evt_seq_sqlite_old', 'evt_seq_sqlite_mid', 'evt_seq_sqlite_new'],
      'ascending by insertion seq, not by the descending client timestamps'
    );
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLiteEventStore: resolveCursor, headSeq, countBetween and listBetween never see a duplicate reference row', async () => {
  const { dir, file } = tempDbPath('seq-duplicate-of');
  const store = new SQLiteEventStore(file);
  try {
    const original = usageEvent('evt_seq_dup_original', { provider: 'seqp', requestId: 'req-seq' });
    const originalResult = await store.append(original);
    const dup = usageEvent('evt_seq_dup_second', { provider: 'seqp', requestId: 'req-seq', inputTokens: 999 });
    const dupResult = await store.append(dup);
    assert.equal(dupResult.outcome, 'duplicate');
    assert.equal(dupResult.seq, null);

    // The duplicate's own id resolves to nothing: it was never broadcast, so it is never a valid cursor.
    assert.equal(await store.resolveCursor('evt_seq_dup_second'), null);

    const marker = await store.append(storeEvent('evt_seq_dup_marker', 1));
    const between = await store.listBetween(originalResult.seq, marker.seq, 10);
    assert.deepStrictEqual(
      between.map((entry) => entry.event.id),
      ['evt_seq_dup_marker'],
      'the duplicate reference row in between is never replayed'
    );
    assert.equal(await store.countBetween(originalResult.seq, marker.seq), 1);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
