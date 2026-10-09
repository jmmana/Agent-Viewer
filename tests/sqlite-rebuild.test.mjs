// Issue #52: on startup, SQLiteEventStore replays every stored event through the shared reducer (applyEvent,
// server/serverState.ts) and rebuilds all derived state from it. These tests exercise that rebuild at the store
// level: parity after a close/reopen cycle, replay order, corrupt rows, readiness progress and concurrent
// ingestion while a rebuild is running. HTTP-level readiness gating (503 store_rebuilding) is covered by
// tests/sqlite-http.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteEventStore } from '../server/store.ts';
import { applyEvent, createServerState } from '../server/serverState.ts';

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-rebuild-'));
  return { dir, file: path.join(dir, `${name}.db`) };
}

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return `evt_${prefix}_${seq}`;
}

/**
 * A mixed fixture covering every side effect `applyEvent` owns, built the same way the live HTTP routes build
 * their events after issue #52 (every resolved field in the payload, never left for the reducer to default).
 */
function mixedFixture() {
  const t0 = 1_700_000_000_000;
  const events = [];
  let t = t0;
  const at = () => (t += 1);

  // agent.registered through POST /agents, with role and status (issue #52 route shape).
  events.push({
    schemaVersion: '1.0',
    id: nextId('reg'),
    type: 'agent.registered',
    timestamp: at(),
    source: 'agent:writer-1',
    agentId: 'writer-1',
    severity: 'normal',
    summary: 'Registered Writer One',
    payload: {
      id: 'writer-1',
      name: 'Writer One',
      roleTitle: 'Senior Writer',
      role: 'writer',
      provider: 'Anthropic',
      model: 'claude-sonnet',
      workspace: 'production',
      status: 'CODING',
      statusText: 'Drafting',
    },
  });

  // agent.updated through PATCH /agents/:id.
  events.push({
    schemaVersion: '1.0',
    id: nextId('upd'),
    type: 'agent.updated',
    timestamp: at(),
    source: 'agent:writer-1',
    agentId: 'writer-1',
    severity: 'normal',
    summary: 'writer-1 profile updated',
    payload: { name: 'Writer One Renamed', statusText: 'Editing' },
  });

  // runtime.connected for a brand-new runtime, framework resolved by the route (default 'custom').
  events.push({
    schemaVersion: '1.0',
    id: nextId('rt'),
    type: 'runtime.connected',
    timestamp: at(),
    runtimeId: 'rt-new',
    source: 'runtime:rt-new',
    severity: 'normal',
    summary: 'Runtime rt-new connected',
    payload: { id: 'rt-new', name: 'New Runtime', framework: 'langgraph', version: '1.0.0', metadata: { region: 'us' } },
  });

  // A runtime auto-created by an unrelated event (framework default 'external' in the reducer).
  events.push({
    schemaVersion: '1.0',
    id: nextId('msg'),
    type: 'agent.message.sent',
    timestamp: at(),
    runtimeId: 'rt-auto',
    sessionId: 'session-1',
    source: 'agent:writer-1',
    agentId: 'writer-1',
    severity: 'normal',
    summary: 'Hello from an auto-created runtime',
    payload: { text: 'hi' },
  });

  // runtime.connected for that SAME auto-created runtime: the reducer must now update it, not leave it alone.
  events.push({
    schemaVersion: '1.0',
    id: nextId('rt'),
    type: 'runtime.connected',
    timestamp: at(),
    runtimeId: 'rt-auto',
    source: 'runtime:rt-auto',
    severity: 'normal',
    summary: 'Runtime rt-auto connected',
    payload: { id: 'rt-auto', name: 'Now Named', framework: 'custom', version: '2.0.0', metadata: {} },
  });

  // Sessions: session-1 already exists from the message above; bump it again.
  events.push({
    schemaVersion: '1.0',
    id: nextId('sess'),
    type: 'agent.message.sent',
    timestamp: at(),
    runtimeId: 'rt-auto',
    sessionId: 'session-1',
    source: 'agent:writer-1',
    agentId: 'writer-1',
    severity: 'normal',
    summary: 'Second message',
    payload: { text: 'again' },
  });

  // Tasks through every status.
  const taskId = 'task-1';
  events.push({
    schemaVersion: '1.0',
    id: nextId('task'),
    type: 'task.progress',
    timestamp: at(),
    taskId,
    agentId: 'writer-1',
    source: 'agent:writer-1',
    severity: 'normal',
    summary: 'Task started',
    payload: { taskId, title: 'Write the report', progress: 10 },
  });
  events.push({
    schemaVersion: '1.0',
    id: nextId('task'),
    type: 'task.blocked',
    timestamp: at(),
    taskId,
    agentId: 'writer-1',
    source: 'agent:writer-1',
    severity: 'normal',
    summary: 'Task blocked',
    payload: { taskId },
  });
  events.push({
    schemaVersion: '1.0',
    id: nextId('task'),
    type: 'task.progress',
    timestamp: at(),
    taskId,
    agentId: 'writer-1',
    source: 'agent:writer-1',
    severity: 'normal',
    summary: 'Task resumed',
    payload: { taskId, progress: 80 },
  });
  events.push({
    schemaVersion: '1.0',
    id: nextId('task'),
    type: 'task.completed',
    timestamp: at(),
    taskId,
    agentId: 'writer-1',
    source: 'agent:writer-1',
    severity: 'normal',
    summary: 'Task completed',
    payload: { taskId },
  });
  const failedTaskId = 'task-2';
  events.push({
    schemaVersion: '1.0',
    id: nextId('task'),
    type: 'task.failed',
    timestamp: at(),
    taskId: failedTaskId,
    agentId: 'writer-1',
    source: 'agent:writer-1',
    severity: 'high',
    summary: 'Task failed',
    payload: { taskId: failedTaskId },
  });

  // Meetings started and ended.
  events.push({
    schemaVersion: '1.0',
    id: nextId('meet'),
    type: 'meeting.started',
    timestamp: at(),
    source: 'agent:writer-1',
    severity: 'normal',
    summary: 'Standup started',
    payload: { meetingId: 'meeting-1', title: 'Standup', participantIds: ['writer-1'] },
  });
  events.push({
    schemaVersion: '1.0',
    id: nextId('meet'),
    type: 'meeting.ended',
    timestamp: at(),
    source: 'agent:writer-1',
    severity: 'normal',
    summary: 'Standup ended',
    payload: { meetingId: 'meeting-1' },
  });
  events.push({
    schemaVersion: '1.0',
    id: nextId('meet'),
    type: 'meeting.started',
    timestamp: at(),
    source: 'agent:writer-1',
    severity: 'normal',
    summary: 'Retro started',
    payload: { meetingId: 'meeting-2', title: 'Retro', participantIds: ['writer-1'] },
  });

  // llm.usage: known cost, missing cost, and two different currencies.
  events.push({
    schemaVersion: '1.0',
    id: nextId('usage'),
    type: 'llm.usage',
    timestamp: at(),
    agentId: 'writer-1',
    source: 'agent:writer-1',
    severity: 'normal',
    summary: 'Usage with known cost',
    payload: { provider: 'Anthropic', model: 'claude-sonnet', inputTokens: 100, outputTokens: 50, cost: 0.02, currency: 'USD', costSource: 'provider-reported' },
  });
  events.push({
    schemaVersion: '1.0',
    id: nextId('usage'),
    type: 'llm.usage',
    timestamp: at(),
    agentId: 'writer-1',
    source: 'agent:writer-1',
    severity: 'normal',
    summary: 'Usage with missing cost',
    payload: { provider: 'Anthropic', model: 'claude-sonnet', inputTokens: 40, outputTokens: 20 },
  });
  events.push({
    schemaVersion: '1.0',
    id: nextId('usage'),
    type: 'llm.usage',
    timestamp: at(),
    agentId: 'writer-1',
    source: 'agent:writer-1',
    severity: 'normal',
    summary: 'Usage in a second currency',
    payload: { provider: 'Anthropic', model: 'claude-sonnet', inputTokens: 10, outputTokens: 5, cost: 0.01, currency: 'EUR', costSource: 'provider-reported' },
  });
  events.push({
    schemaVersion: '1.0',
    id: nextId('fail'),
    type: 'llm.failed',
    timestamp: at(),
    agentId: 'writer-1',
    source: 'agent:writer-1',
    severity: 'high',
    summary: 'Call failed',
    payload: { provider: 'Anthropic', model: 'claude-sonnet' },
  });

  return events;
}

test('parity: snapshot, runtimes, sessions and agents survive a close, reopen and rebuild unchanged', async () => {
  const { dir, file } = tempDbPath('parity');
  let store = new SQLiteEventStore(file, { backup: 'off' });
  try {
    for (const event of mixedFixture()) {
      const result = await store.append(event);
      assert.equal(result.outcome, 'accepted', `expected ${event.id} to be accepted`);
    }

    const before = await store.snapshot();
    const runtimesBefore = await store.listRuntimes();
    const sessionsBefore = await store.listSessions();
    const agentsBefore = await store.listAgents();

    await store.close();
    store = new SQLiteEventStore(file, { backup: 'off' });
    await store.init();

    assert.equal(store.readiness().ready, true);
    const after = await store.snapshot();
    assert.deepEqual({ ...after, timestamp: 0 }, { ...before, timestamp: 0 }, 'snapshot (ignoring timestamp) is identical after a rebuild');
    assert.deepEqual(await store.listRuntimes(), runtimesBefore);
    assert.deepEqual(await store.listSessions(), sessionsBefore);
    assert.deepEqual(await store.listAgents(), agentsBefore);

    // The rebuilt runtime that was only auto-created, and the one explicitly connected, both show up correctly.
    const rtAuto = (await store.listRuntimes()).find((r) => r.id === 'rt-auto');
    assert.equal(rtAuto.framework, 'custom');
    assert.equal(rtAuto.name, 'Now Named');
    const rtNew = (await store.listRuntimes()).find((r) => r.id === 'rt-new');
    assert.equal(rtNew.framework, 'langgraph');

    const writer = await store.getAgent('writer-1');
    assert.equal(writer.name, 'Writer One Renamed');
    assert.equal(writer.role, 'writer');
    assert.equal(writer.status, 'CODING');
    assert.equal(writer.statusText, 'Editing');

    const usage = await store.usageSummary();
    assert.equal(usage.total.calls, 3);
    assert.equal(usage.total.failed.calls, 1);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pre-0.2.0 rows (no event_json) are replayed from their reconstructed columns', async () => {
  const { dir, file } = tempDbPath('legacy-rebuild');
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
  insert.run('evt_legacy_reg', 'agent.registered', 100, null, null, 'legacy-agent', null, 'normal', 'Registered', JSON.stringify({ id: 'legacy-agent', name: 'Legacy Agent' }), 1);
  insert.run(
    'evt_legacy_usage',
    'llm.usage',
    200,
    null,
    null,
    'legacy-agent',
    null,
    'normal',
    'Usage',
    JSON.stringify({ provider: 'OldProvider', model: 'old-model', inputTokens: 10, outputTokens: 5, cost: 0.01, currency: 'USD', costSource: 'provider-reported' }),
    2
  );
  legacy.close();

  const store = new SQLiteEventStore(file, { backup: 'off' });
  try {
    await store.init();
    const agent = await store.getAgent('legacy-agent');
    assert.equal(agent.name, 'Legacy Agent');
    assert.equal(agent.tokensInput, 10);
    assert.equal(agent.tokensOutput, 5);
    assert.equal(agent.cost, 0.01);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replay follows seq, not rowid: a rowid swap after the fact does not change the outcome', async () => {
  const { dir, file } = tempDbPath('seq-order');
  let store = new SQLiteEventStore(file, { backup: 'off' });
  try {
    const agentEvent = (id, timestamp, name) => ({
      schemaVersion: '1.0',
      id,
      type: 'agent.updated',
      timestamp,
      agentId: 'order-agent',
      source: 'agent:order-agent',
      severity: 'normal',
      summary: `renamed to ${name}`,
      payload: { name },
    });
    await store.append({ ...agentEvent('evt_order_reg', 1, 'Seed'), type: 'agent.registered', payload: { id: 'order-agent', name: 'Seed' } });
    await store.append(agentEvent('evt_order_a', 2, 'A'));
    await store.append(agentEvent('evt_order_b', 3, 'B'));
    await store.append(agentEvent('evt_order_c', 4, 'C'));
    await store.close();

    // Swap the rowid of the first and last `agent.updated` rows (A and C). Their `seq` column values travel with
    // the row's content, not with rowid, so seq order stays A, B, C even though rowid order is now C, B, A.
    const raw = new DatabaseSync(file);
    const rowA = raw.prepare('SELECT rowid AS rid FROM events WHERE id = ?').get('evt_order_a');
    const rowC = raw.prepare('SELECT rowid AS rid FROM events WHERE id = ?').get('evt_order_c');
    const freeRowid = raw.prepare('SELECT MAX(rowid) + 1000 AS rid FROM events').get().rid;
    raw.prepare('UPDATE events SET rowid = ? WHERE id = ?').run(freeRowid, 'evt_order_a');
    raw.prepare('UPDATE events SET rowid = ? WHERE id = ?').run(rowA.rid, 'evt_order_c');
    raw.prepare('UPDATE events SET rowid = ? WHERE id = ?').run(rowC.rid, 'evt_order_a');
    raw.close();

    store = new SQLiteEventStore(file, { backup: 'off' });
    await store.init();
    const agent = await store.getAgent('order-agent');
    assert.equal(agent.name, 'C', 'the highest-seq update wins, even though its rowid is now the smallest');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a row with seq IS NULL at startup is assigned the next values in rowid order', async () => {
  const { dir, file } = tempDbPath('null-seq');
  let store = new SQLiteEventStore(file, { backup: 'off' });
  await store.append({
    schemaVersion: '1.0',
    id: 'evt_nullseq_reg',
    type: 'agent.registered',
    timestamp: 1,
    agentId: 'nullseq-agent',
    source: 'agent:nullseq-agent',
    severity: 'normal',
    summary: 'Registered',
    payload: { id: 'nullseq-agent', name: 'Seed' },
  });
  await store.close();

  // Simulate an older server (pre-migration-4) appending rows directly, without ever setting `seq`.
  const raw = new DatabaseSync(file);
  const insert = raw.prepare(
    `INSERT INTO events (id, type, timestamp, runtime_id, session_id, agent_id, task_id, severity, summary, payload, event_json, created_at, content_hash, request_provider, request_id, duplicate_of, matches_original, seq)
     VALUES (?, ?, ?, NULL, NULL, ?, NULL, 'normal', ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`
  );
  const eventB = { schemaVersion: '1.0', id: 'evt_nullseq_b', type: 'agent.updated', timestamp: 2, agentId: 'nullseq-agent', source: 'agent:nullseq-agent', severity: 'normal', summary: 'b', payload: { name: 'B' } };
  const eventC = { schemaVersion: '1.0', id: 'evt_nullseq_c', type: 'agent.updated', timestamp: 3, agentId: 'nullseq-agent', source: 'agent:nullseq-agent', severity: 'normal', summary: 'c', payload: { name: 'C' } };
  insert.run(eventB.id, eventB.type, eventB.timestamp, eventB.agentId, eventB.summary, JSON.stringify(eventB.payload), JSON.stringify(eventB), Date.now());
  insert.run(eventC.id, eventC.type, eventC.timestamp, eventC.agentId, eventC.summary, JSON.stringify(eventC.payload), JSON.stringify(eventC), Date.now());
  const rows = raw.prepare('SELECT id, seq FROM events ORDER BY rowid').all();
  raw.close();
  assert.deepEqual(rows.map((r) => r.seq), [1, null, null], 'the two new rows start with no seq');

  store = new SQLiteEventStore(file, { backup: 'off' });
  try {
    await store.init();
    const raw2 = new DatabaseSync(file);
    const seqRows = raw2.prepare('SELECT id, seq FROM events ORDER BY rowid').all();
    raw2.close();
    assert.equal(seqRows[0].seq, 1);
    assert.equal(seqRows[1].seq, 2, 'assigned in rowid order, right after the existing max');
    assert.equal(seqRows[2].seq, 3);
    assert.equal((await store.getAgent('nullseq-agent')).name, 'C', 'both backfilled rows were still replayed');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a row that cannot be parsed is skipped, counted and logged; the rest of the rebuild completes', async (t) => {
  const warnings = [];
  const { dir, file } = tempDbPath('corrupt-rows');
  let store = new SQLiteEventStore(file, { backup: 'off' });
  await store.append({
    schemaVersion: '1.0',
    id: 'evt_corrupt_good_1',
    type: 'agent.registered',
    timestamp: 1,
    agentId: 'corrupt-agent',
    source: 'agent:corrupt-agent',
    severity: 'normal',
    summary: 'Registered',
    payload: { id: 'corrupt-agent', name: 'Good Agent' },
  });
  await store.close();

  const raw = new DatabaseSync(file);
  // Row 1: neither event_json nor payload parses as JSON at all.
  raw.prepare(
    `INSERT INTO events (id, type, timestamp, severity, summary, payload, event_json, created_at, seq)
     VALUES (?, 'agent.updated', 2, 'normal', 'corrupt', '{not json', '{not json either', ?, ?)`
  ).run('evt_corrupt_unparseable', Date.now(), 2);
  // Row 2: valid JSON, but not a usable event shape (a bare number has no id/type/timestamp).
  raw.prepare(
    `INSERT INTO events (id, type, timestamp, severity, summary, payload, event_json, created_at, seq)
     VALUES (?, 'agent.updated', 3, 'normal', 'wrong shape', '{}', '42', ?, ?)`
  ).run('evt_corrupt_wrong_shape', Date.now(), 3);
  raw.prepare(
    `INSERT INTO events (id, type, timestamp, agent_id, severity, summary, payload, event_json, created_at, seq)
     VALUES (?, 'agent.updated', 4, 'corrupt-agent', 'normal', 'good', ?, ?, ?, ?)`
  ).run(
    'evt_corrupt_good_2',
    JSON.stringify({ name: 'Still Good' }),
    JSON.stringify({ schemaVersion: '1.0', id: 'evt_corrupt_good_2', type: 'agent.updated', timestamp: 4, agentId: 'corrupt-agent', source: 'agent:corrupt-agent', severity: 'normal', summary: 'good', payload: { name: 'Still Good' } }),
    Date.now(),
    4
  );
  raw.close();

  store = new SQLiteEventStore(file, {
    backup: 'off',
    logger: { info() {}, warn: (msg) => warnings.push(msg), error() {} },
  });
  try {
    await store.init();
    const readiness = store.readiness();
    assert.equal(readiness.rebuild.state, 'done');
    assert.equal(readiness.rebuild.skippedEvents, 2);
    assert.deepEqual(readiness.rebuild.skippedEventIds.sort(), ['evt_corrupt_unparseable', 'evt_corrupt_wrong_shape'].sort());
    assert.equal(warnings.length, 2, 'one warning per skipped row');
    assert.ok(warnings.every((line) => line.includes('Skipped unreadable event during rebuild')));

    // The rows around the corrupt ones were still applied.
    assert.equal((await store.getAgent('corrupt-agent')).name, 'Still Good');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent ingestion: an event appended mid-rebuild is applied exactly once', async () => {
  const { dir, file } = tempDbPath('concurrent');
  let store = new SQLiteEventStore(file, { backup: 'off' });
  // Seed a backlog bigger than one page so the rebuild actually pauses between pages.
  for (let i = 0; i < 5; i++) {
    await store.append({
      schemaVersion: '1.0',
      id: `evt_seed_${i}`,
      type: 'agent.registered',
      timestamp: i + 1,
      agentId: `seed-agent-${i}`,
      source: `agent:seed-agent-${i}`,
      severity: 'normal',
      summary: 'seed',
      payload: { id: `seed-agent-${i}`, name: `Seed ${i}` },
    });
  }
  await store.close();

  // The hook fires once per page. Its very first call happens synchronously inside the `new SQLiteEventStore(...)`
  // call below, before that expression has returned and before this `store` variable has been reassigned to it;
  // referencing `store` from the hook at that point would still see the old, closed instance. Injecting on the
  // *second* call sidesteps that: by then the constructor has long since returned (the loop only reaches a
  // second page after genuinely yielding to the event loop between pages), so `store` is the new instance.
  let injected = false;
  let pageCalls = 0;
  store = new SQLiteEventStore(file, {
    backup: 'off',
    rebuildPageSize: 2,
    logger: { info() {}, warn() {}, error() {} },
    yieldBetweenPages: async () => {
      pageCalls++;
      if (pageCalls !== 2) return;
      injected = true;
      const result = await store.append({
        schemaVersion: '1.0',
        id: 'evt_mid_rebuild_usage',
        type: 'llm.usage',
        timestamp: 999,
        agentId: 'seed-agent-0',
        source: 'agent:seed-agent-0',
        severity: 'normal',
        summary: 'mid-rebuild usage',
        payload: { provider: 'MidRebuild', model: 'm', inputTokens: 7, outputTokens: 3 },
      });
      assert.equal(result.outcome, 'accepted');
    },
  });
  try {
    await store.init();
    assert.equal(injected, true, 'the hook actually ran mid-rebuild');
    const usage = await store.usageSummary();
    assert.equal(usage.total.calls, 1, 'the mid-rebuild event was applied exactly once');
    assert.equal(usage.total.tokens.input.sum, 7);
    assert.equal((await store.snapshot()).eventsCount, 6);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readiness: ready is false while the rebuild runs and processedEvents grows page by page, then true', async () => {
  const { dir, file } = tempDbPath('readiness');
  let store = new SQLiteEventStore(file, { backup: 'off' });
  for (let i = 0; i < 6; i++) {
    await store.append({
      schemaVersion: '1.0',
      id: `evt_ready_seed_${i}`,
      type: 'agent.message.sent',
      timestamp: i + 1,
      agentId: 'ready-agent',
      source: 'agent:ready-agent',
      severity: 'normal',
      summary: 'seed',
      payload: { text: `msg ${i}` },
    });
  }
  await store.close();

  // The hook only touches its own closure state (`progressSamples`), never the `store` variable below: its first
  // call happens synchronously inside the `new SQLiteEventStore(...)` expression, before that expression has
  // returned and before `store` has been reassigned to it (see the same note in the concurrent-ingestion test above).
  const progressSamples = [];
  store = new SQLiteEventStore(file, {
    backup: 'off',
    rebuildPageSize: 2,
    logger: { info() {}, warn() {}, error() {} },
    yieldBetweenPages: (progress) => {
      progressSamples.push(progress.processedEvents);
    },
  });
  try {
    assert.equal(store.readiness().ready, false, 'not ready right after construction: a real backlog needs at least one more page');
    await store.init();
    assert.equal(store.readiness().ready, true);
    assert.deepEqual(progressSamples, [2, 4, 6]);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replay determinism: applying the same events twice gives deep-equal state, whatever Date.now() returns', async (t) => {
  const events = mixedFixture();
  const realNow = Date.now;

  t.mock.method(Date, 'now', () => 111);
  const stateA = createServerState();
  for (const event of events) applyEvent(stateA, event);
  const summaryA = { ...stateA, usage: stateA.usage.summary() };

  Date.now = () => 222;
  const stateB = createServerState();
  for (const event of events) applyEvent(stateB, event);
  const summaryB = { ...stateB, usage: stateB.usage.summary() };
  Date.now = realNow;

  assert.deepEqual(
    { runtimes: [...stateA.runtimes.entries()], sessions: [...stateA.sessions.entries()], agents: [...stateA.agents.entries()], tasks: [...stateA.tasks.entries()], meetings: [...stateA.meetings.entries()], usage: summaryA.usage },
    { runtimes: [...stateB.runtimes.entries()], sessions: [...stateB.sessions.entries()], agents: [...stateB.agents.entries()], tasks: [...stateB.tasks.entries()], meetings: [...stateB.meetings.entries()], usage: summaryB.usage }
  );
});
