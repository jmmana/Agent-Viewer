// Issue #65: the usage ledger. Covers `toLedgerRow`'s mapping table, `sameCall`, live-path parity between
// MemoryEventStore and SQLiteEventStore, the append-only trigger and CHECK constraints, the missing foreign key,
// transactional rollback on a simulated crash, and the memory-mode ledger cap (issue #53's rule, applied here).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryEventStore, SQLiteEventStore } from '../server/store.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';
import { toLedgerRow, sameCall, dbRowToLedgerRowInput } from '../server/usageLedger.ts';

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-ledger-'));
  return { dir, file: path.join(dir, `${name}.db`) };
}

function usageEvent(id, payload = {}, envelope = {}) {
  const result = validateCanonicalEvent({
    id,
    type: 'llm.usage',
    timestamp: 1_700_000_000_000,
    source: 'agent:auditor',
    agentId: 'auditor',
    sessionId: 'ses_ledger',
    summary: 'Audited call',
    payload: { provider: 'p', model: 'm', inputTokens: 100, outputTokens: 10, cost: 0.01, currency: 'USD', costSource: 'provider-reported', ...payload },
    ...envelope,
  });
  assert.equal(result.success, true, JSON.stringify(result.issues));
  return result.data;
}

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

const BASE_CTX = { receivedAt: 1_700_000_005_000, origin: 'live', channel: 'events', legacyContract: false };

// -------------------------------------------------------------
// toLedgerRow: the mapping table
// -------------------------------------------------------------

test('toLedgerRow: ignores every event type other than llm.usage/llm.failed', () => {
  const event = { id: 'evt_x', type: 'agent.status.changed', timestamp: 1, payload: { status: 'IDLE' } };
  assert.equal(toLedgerRow(event, BASE_CTX), null);
});

test('toLedgerRow: a non-object payload maps to null (only reachable from the backfill)', () => {
  for (const payload of [null, undefined, 'x', 42, ['a']]) {
    assert.equal(toLedgerRow({ id: 'evt_x', type: 'llm.usage', timestamp: 1, payload }, BASE_CTX), null);
  }
});

test('toLedgerRow: llm.usage basic mapping, status ok, errorKind null', () => {
  const event = usageEvent('evt_map_1', { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3, latencyMs: 120 });
  const row = toLedgerRow(event, BASE_CTX);
  assert.equal(row.eventId, 'evt_map_1');
  assert.equal(row.eventType, 'llm.usage');
  assert.equal(row.status, 'ok');
  assert.equal(row.errorKind, null);
  assert.equal(row.provider, 'p');
  assert.equal(row.model, 'm');
  assert.equal(row.inputTokens, 10);
  assert.equal(row.outputTokens, 5);
  assert.equal(row.cacheReadTokens, 2);
  assert.equal(row.cacheWriteTokens, 1);
  assert.equal(row.reasoningTokens, 3);
  assert.equal(row.latencyMs, 120);
  assert.equal(row.cost, 0.01);
  assert.equal(row.currency, 'USD');
  assert.equal(row.costSource, 'provider-reported');
  assert.equal(row.runtimeId, null);
  assert.equal(row.sessionId, 'ses_ledger');
  assert.equal(row.agentId, 'auditor');
  assert.equal(row.receivedAt, BASE_CTX.receivedAt);
  assert.equal(row.occurredAt, event.timestamp);
  assert.equal(row.origin, 'live');
  assert.equal(row.legacyContract, false);
  assert.equal(row.ingestChannel, 'events');
  assert.deepEqual(row.tags, []);
});

test('toLedgerRow: llm.failed takes status and errorKind from the payload errorKind', () => {
  const event = failedEvent('evt_map_failed', { errorKind: 'timeout', requestId: 'req-failed' });
  const row = toLedgerRow(event, BASE_CTX);
  assert.equal(row.eventType, 'llm.failed');
  assert.equal(row.status, 'timeout');
  assert.equal(row.errorKind, 'timeout');
  assert.equal(row.requestId, 'req-failed');
  assert.equal(row.inputTokens, null);
  assert.equal(row.cost, null);
  assert.equal(row.currency, null);
  assert.equal(row.costSource, 'unknown');
});

test('toLedgerRow: a missing token kind is NULL, an explicit 0 is stored as 0', () => {
  const missing = toLedgerRow(usageEvent('evt_map_missing', {}), BASE_CTX);
  assert.equal(missing.cacheReadTokens, null);
  assert.equal(missing.cacheWriteTokens, null);
  assert.equal(missing.reasoningTokens, null);
  assert.equal(missing.latencyMs, null);

  const zero = toLedgerRow(usageEvent('evt_map_zero', { cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, latencyMs: 0 }), BASE_CTX);
  assert.equal(zero.cacheReadTokens, 0);
  assert.equal(zero.cacheWriteTokens, 0);
  assert.equal(zero.reasoningTokens, 0);
  assert.equal(zero.latencyMs, 0);
});

test('toLedgerRow: a non-integer, negative or non-numeric token value becomes NULL, never fails', () => {
  for (const bad of [-1, 1.5, NaN, Infinity, '5', null]) {
    const event = { id: 'evt_bad', type: 'llm.usage', timestamp: 1, payload: { provider: 'p', model: 'm', inputTokens: bad } };
    const row = toLedgerRow(event, BASE_CTX);
    assert.equal(row.inputTokens, null, `inputTokens ${JSON.stringify(bad)} must map to NULL`);
  }
});

test('toLedgerRow: a negative or non-finite cost becomes NULL (and forces currency/costSource unknown)', () => {
  for (const bad of [-0.01, NaN, Infinity, '1', null]) {
    const event = { id: 'evt_bad_cost', type: 'llm.usage', timestamp: 1, payload: { provider: 'p', model: 'm', cost: bad, currency: 'USD', costSource: 'estimated' } };
    const row = toLedgerRow(event, BASE_CTX);
    assert.equal(row.cost, null);
    assert.equal(row.currency, null);
    assert.equal(row.costSource, 'unknown');
  }
});

test('toLedgerRow: a cost is kept with no currency; costSource is stored as reported', () => {
  const row = toLedgerRow(usageEvent('evt_cost_no_currency', { cost: 1.5, currency: undefined, costSource: 'estimated' }), BASE_CTX);
  assert.equal(row.cost, 1.5);
  assert.equal(row.currency, null);
  assert.equal(row.costSource, 'estimated');
});

test('toLedgerRow: a currency that is not exactly 3 letters becomes NULL; 3 letters is kept', () => {
  const four = toLedgerRow({ id: 'evt_cur4', type: 'llm.usage', timestamp: 1, payload: { provider: 'p', model: 'm', cost: 1, currency: 'USDX', costSource: 'estimated' } }, BASE_CTX);
  assert.equal(four.currency, null);
  const three = toLedgerRow({ id: 'evt_cur3', type: 'llm.usage', timestamp: 1, payload: { provider: 'p', model: 'm', cost: 1, currency: 'EUR', costSource: 'estimated' } }, BASE_CTX);
  assert.equal(three.currency, 'EUR');
});

test('toLedgerRow: legacy_contract=1 maps a reported 0 cached/reasoning to NULL; a positive value is kept', () => {
  const legacy = { ...BASE_CTX, legacyContract: true };
  const zeroed = toLedgerRow(usageEvent('evt_legacy_zero', { cacheReadTokens: 0, reasoningTokens: 0 }), legacy);
  assert.equal(zeroed.cacheReadTokens, null);
  assert.equal(zeroed.reasoningTokens, null);
  const positive = toLedgerRow(usageEvent('evt_legacy_pos', { cacheReadTokens: 5, reasoningTokens: 9 }), legacy);
  assert.equal(positive.cacheReadTokens, 5);
  assert.equal(positive.reasoningTokens, 9);
});

test('toLedgerRow: legacy cachedTokens alias maps to cacheReadTokens; cacheWriteTokens stays NULL', () => {
  const legacy = { ...BASE_CTX, legacyContract: true };
  const event = { id: 'evt_legacy_alias', type: 'llm.usage', timestamp: 1, payload: { provider: 'p', model: 'm', inputTokens: 10, outputTokens: 1, cachedTokens: 4 } };
  const row = toLedgerRow(event, legacy);
  assert.equal(row.cacheReadTokens, 4);
  assert.equal(row.cacheWriteTokens, null);
});

test('toLedgerRow: webhook 0 input/output tokens become NULL only when legacy_contract=1', () => {
  const legacyWebhook = { ...BASE_CTX, legacyContract: true, channel: 'webhook' };
  const legacyZeroed = toLedgerRow(usageEvent('evt_wh_legacy', { inputTokens: 0, outputTokens: 0 }), legacyWebhook);
  assert.equal(legacyZeroed.inputTokens, null);
  assert.equal(legacyZeroed.outputTokens, null);

  const liveWebhook = { ...BASE_CTX, legacyContract: false, channel: 'webhook' };
  const liveZero = toLedgerRow(usageEvent('evt_wh_live', { inputTokens: 0, outputTokens: 0 }), liveWebhook);
  assert.equal(liveZero.inputTokens, 0, 'a live webhook row never invents a missing token as 0 in the first place, so a reported 0 is real');
  assert.equal(liveZero.outputTokens, 0);

  const legacyNonWebhook = { ...BASE_CTX, legacyContract: true, channel: 'events' };
  const nonWebhookZero = toLedgerRow(usageEvent('evt_nonwh_legacy', { inputTokens: 0, outputTokens: 0 }), legacyNonWebhook);
  assert.equal(nonWebhookZero.inputTokens, 0, 'the webhook zero rule never applies outside the webhook channel');
  assert.equal(nonWebhookZero.outputTokens, 0);
});

test('toLedgerRow: tags are copied in order; non-string entries are dropped', () => {
  const event = { id: 'evt_tags', type: 'llm.usage', timestamp: 1, payload: { provider: 'p', model: 'm', tags: ['env:prod', 42, 'tier:pro', null] } };
  const row = toLedgerRow(event, BASE_CTX);
  assert.deepEqual(row.tags, ['env:prod', 'tier:pro']);
});

test('toLedgerRow: meetingId is mapped (issue #64 shipped meetingId, not spanId; see server/usageLedger.ts)', () => {
  const row = toLedgerRow(usageEvent('evt_meeting', { meetingId: 'mtg_1', traceId: 'trace_1', parentId: 'parent_1', toolCallId: 'tool_1', userId: 'user_1' }), BASE_CTX);
  assert.equal(row.meetingId, 'mtg_1');
  assert.equal(row.traceId, 'trace_1');
  assert.equal(row.parentId, 'parent_1');
  assert.equal(row.toolCallId, 'tool_1');
  assert.equal(row.userId, 'user_1');
});

// -------------------------------------------------------------
// sameCall
// -------------------------------------------------------------

test('sameCall: identical rows match; a single differing field does not', () => {
  const a = toLedgerRow(usageEvent('evt_a'), BASE_CTX);
  const b = toLedgerRow(usageEvent('evt_b'), BASE_CTX);
  assert.equal(sameCall(a, b), true, 'same figures under different event ids are the same call');
  const differentCost = toLedgerRow(usageEvent('evt_c', { cost: 0.02 }), BASE_CTX);
  assert.equal(sameCall(a, differentCost), false);
  const differentTags = toLedgerRow({ ...usageEvent('evt_d'), payload: { ...usageEvent('evt_d').payload, tags: ['x'] } }, BASE_CTX);
  assert.equal(sameCall(a, differentTags), false);
});

test('sameCall: ignores ids, both timestamps, origin, channel and legacy flag', () => {
  const a = toLedgerRow(usageEvent('evt_e'), { receivedAt: 1, origin: 'live', channel: 'events', legacyContract: false });
  const b = toLedgerRow(usageEvent('evt_f'), { receivedAt: 999999, origin: 'backfill', channel: 'webhook', legacyContract: true });
  assert.equal(sameCall(a, b), true);
});

// -------------------------------------------------------------
// Live-path parity: MemoryEventStore vs SQLiteEventStore
// -------------------------------------------------------------

function sqliteLedgerRows(store) {
  return store.db.prepare('SELECT * FROM usage_ledger ORDER BY seq').all().map(dbRowToLedgerRowInput);
}

function memoryLedgerRows(store) {
  return store.ledger.map(({ seq, ...rest }) => rest);
}

function sortByEventId(rows) {
  return [...rows].sort((a, b) => a.eventId.localeCompare(b.eventId));
}

test('Store parity: a mixed live sequence produces the same ledger rows in both stores', async () => {
  const { dir, file } = tempDbPath('parity');
  const memory = new MemoryEventStore();
  const sqlite = new SQLiteEventStore(file);
  try {
    const events = [
      usageEvent('evt_p1', { provider: 'anthropic', requestId: 'req-p1' }),
      failedEvent('evt_p2', { provider: 'openai', requestId: 'req-p2' }),
      usageEvent('evt_p3'), // no requestId
    ];
    // Both stores must share one receivedAt per event for true parity: left to each store's own Date.now(), two
    // independent calls can legitimately land a millisecond apart.
    let clock = 1_700_000_005_000;
    for (const event of events) {
      const receivedAt = clock++;
      await memory.append(event, { receivedAt });
      await sqlite.append(event, { receivedAt });
    }
    // An id resend never adds a second ledger row.
    await memory.append(events[0], { receivedAt: clock });
    await sqlite.append(events[0], { receivedAt: clock++ });
    // A request-id duplicate (same provider+requestId, same figures) is deduped at the events layer (#48)
    // before it ever reaches the ledger: no new row, and the original's row is untouched.
    const requestDuplicate = usageEvent('evt_p1_dup', { provider: 'anthropic', requestId: 'req-p1' });
    await memory.append(requestDuplicate, { receivedAt: clock });
    await sqlite.append(requestDuplicate, { receivedAt: clock++ });

    const memoryRows = sortByEventId(memoryLedgerRows(memory));
    const sqliteRows = sortByEventId(sqliteLedgerRows(sqlite));
    assert.equal(memoryRows.length, 3);
    assert.deepEqual(memoryRows, sqliteRows);

    const memoryStatus = await memory.usageLedgerStatus();
    const sqliteStatus = await sqlite.usageLedgerStatus();
    assert.equal(memoryStatus.rows, 3);
    assert.equal(sqliteStatus.rows, 3);
    assert.deepEqual(memoryStatus.skips, { duplicate: 0, conflict: 0, unparseable: 0 });
    assert.deepEqual(sqliteStatus.skips, { duplicate: 0, conflict: 0, unparseable: 0 });
    assert.equal(memoryStatus.legacyRows, 0);
    assert.equal(sqliteStatus.legacyRows, 0);
  } finally {
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Store parity: a non-usage event never produces a ledger row in either store', async () => {
  const { dir, file } = tempDbPath('parity-nonusage');
  const memory = new MemoryEventStore();
  const sqlite = new SQLiteEventStore(file);
  try {
    const event = validateCanonicalEvent({
      id: 'evt_status',
      type: 'agent.status.changed',
      timestamp: 1,
      source: 'agent:a',
      agentId: 'a',
      summary: 's',
      payload: { status: 'IDLE' },
    }).data;
    await memory.append(event);
    await sqlite.append(event);
    assert.equal((await memory.usageLedgerStatus()).rows, 0);
    assert.equal((await sqlite.usageLedgerStatus()).rows, 0);
  } finally {
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('append without options still works for non-usage callers (agent/runtime registration)', async () => {
  const { dir, file } = tempDbPath('no-options');
  const sqlite = new SQLiteEventStore(file);
  try {
    const event = validateCanonicalEvent({
      id: 'evt_runtime',
      type: 'runtime.connected',
      timestamp: 1,
      source: 'runtime:rt',
      runtimeId: 'rt',
      summary: 's',
      payload: {},
    }).data;
    const result = await sqlite.append(event);
    assert.equal(result.outcome, 'accepted');
    assert.equal(typeof result.receivedAt, 'number');
  } finally {
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Transaction rollback on a simulated crash (SQLite)
// -------------------------------------------------------------

test('SQLiteEventStore: if the ledger insert throws, the event insert rolls back too, and the store stays usable', async () => {
  const { dir, file } = tempDbPath('rollback');
  const store = new SQLiteEventStore(file);
  try {
    const originalPrepare = store.db.prepare.bind(store.db);
    store.db.prepare = (sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO usage_ledger (')) {
        throw new Error('simulated ledger insert failure');
      }
      return originalPrepare(sql);
    };

    await assert.rejects(() => store.append(usageEvent('evt_crash')), /simulated ledger insert failure/);
    store.db.prepare = originalPrepare;

    assert.equal(await store.exists('evt_crash'), false, 'the event must not exist without its ledger decision');
    assert.equal((await store.usageLedgerStatus()).rows, 0);

    // The connection must still be usable: no transaction left open.
    const after = await store.append(usageEvent('evt_after_crash'));
    assert.equal(after.outcome, 'accepted');
    assert.equal((await store.usageLedgerStatus()).rows, 1);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Append-only trigger, CHECK constraints, and no foreign key
// -------------------------------------------------------------

test('SQLiteEventStore: UPDATE usage_ledger fails with "usage_ledger is append-only"', async () => {
  const { dir, file } = tempDbPath('append-only');
  const store = new SQLiteEventStore(file);
  try {
    await store.append(usageEvent('evt_trigger'));
    assert.throws(
      () => store.db.prepare("UPDATE usage_ledger SET status = 'x' WHERE event_id = ?").run('evt_trigger'),
      /usage_ledger is append-only/
    );
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLiteEventStore: CHECK constraints reject a negative token, a bad currency length, and cost NULL with a currency', async () => {
  const { dir, file } = tempDbPath('checks');
  const store = new SQLiteEventStore(file);
  try {
    const insert = `INSERT INTO usage_ledger (
      event_id, event_type, request_id, received_at, occurred_at, origin, legacy_contract, ingest_channel,
      runtime_id, session_id, agent_id, task_id, provider, model, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, cost, currency, cost_source, latency_ms,
      status, error_kind, trace_id, parent_id, tool_call_id, meeting_id, user_id, tags
    ) VALUES (?, 'llm.usage', NULL, 1, 1, 'live', 0, 'events', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL,
      NULL, NULL, NULL, ?, ?, ?, NULL, 'ok', NULL, NULL, NULL, NULL, NULL, NULL, '[]')`;

    assert.throws(() => store.db.prepare(insert).run('evt_check_neg', -1, null, null, 'unknown'), /CHECK/);
    assert.throws(() => store.db.prepare(insert).run('evt_check_cur', null, null, 'USDX', 'unknown'), /CHECK/);
    // cost NULL with a currency set violates "cost IS NOT NULL OR (currency IS NULL AND cost_source = 'unknown')".
    assert.throws(() => store.db.prepare(insert).run('evt_check_cost', null, null, 'USD', 'unknown'), /CHECK/);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLiteEventStore: usage_ledger has no foreign key to events; deleting an event leaves its ledger row', async () => {
  const { dir, file } = tempDbPath('no-fk');
  const store = new SQLiteEventStore(file);
  try {
    await store.append(usageEvent('evt_no_fk'));
    const fkState = store.db.prepare('PRAGMA foreign_keys').get();
    assert.equal(fkState.foreign_keys, 1, 'node:sqlite opens with foreign keys on');
    store.db.prepare('DELETE FROM events WHERE id = ?').run('evt_no_fk');
    const row = store.db.prepare('SELECT event_id FROM usage_ledger WHERE event_id = ?').get('evt_no_fk');
    assert.ok(row, 'the ledger row must outlive its deleted event');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Memory-mode ledger: independent of the event ring, capped independently (issue #53's rule)
// -------------------------------------------------------------

test('MemoryEventStore: 200 usage events into a 50-event ring keep 200 ledger rows (default cap)', async () => {
  const store = new MemoryEventStore(50);
  for (let i = 0; i < 200; i++) {
    await store.append(usageEvent(`evt_mem_ledger_${i}`, {}, { timestamp: 1_700_000_000_000 + i }));
  }
  const status = await store.usageLedgerStatus();
  assert.equal(status.rows, 200);
  assert.equal(status.complete, true);
  assert.equal((await store.retention()).retainedEvents, 50, 'the event ring itself is still capped at 50');
});

test('MemoryEventStore: usageLedgerMaxRows caps the ledger and reports complete:false, never losing rows silently', async () => {
  const store = new MemoryEventStore({ maxEvents: 1000, usageLedgerMaxRows: 3 });
  for (let i = 0; i < 6; i++) {
    await store.append(usageEvent(`evt_cap_${i}`, {}, { timestamp: 1_700_000_000_000 + i }));
  }
  const status = await store.usageLedgerStatus();
  assert.equal(status.rows, 3);
  assert.equal(status.complete, false);
});

test('parseUsageLedgerMaxRows / createEventStore: AGENT_VIEWER_USAGE_LEDGER_MAX_ROWS configures the memory ledger cap', async () => {
  const { parseUsageLedgerMaxRows } = await import('../server/store.ts');
  assert.equal(parseUsageLedgerMaxRows(undefined), 100000);
  assert.equal(parseUsageLedgerMaxRows('5'), 5);
  assert.equal(parseUsageLedgerMaxRows('not-a-number'), 100000);
});

// -------------------------------------------------------------
// GET /api/v1/usage/ledger/status (issue #65)
// -------------------------------------------------------------

test('GET /api/v1/usage/ledger/status: documented shape on an empty memory server', async () => {
  const { app } = await import('../server/index.ts');
  const http = await import('node:http');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/usage/ledger/status`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.schemaVersion, '1.0');
    assert.equal(json.storage, 'memory');
    assert.equal(json.migration, null);
    assert.equal(json.oldestReceivedAt, null);
    assert.equal(json.newestReceivedAt, null);
    assert.deepEqual(json.skips, { duplicate: 0, conflict: 0, unparseable: 0 });
    assert.equal(typeof json.rows, 'number');
    assert.ok('live' in json.rowsByOrigin && 'backfill' in json.rowsByOrigin);
  } finally {
    server.close();
  }
});
