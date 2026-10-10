// Issue #67: `EventStore.listCalls`, one conformance suite run against both `MemoryEventStore` and
// `SQLiteEventStore`. Covers the pagination guarantees from section 4 of the issue: full walks at several page
// sizes and both orders, filters, concurrent inserts and deletions during a walk, the store epoch, and
// `EXPLAIN QUERY PLAN` for the SQLite-only index claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryEventStore, SQLiteEventStore } from '../server/store.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';
import { emptyUsageFilters } from '../server/usage/types.ts';

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-calls-'));
  return { dir, file: path.join(dir, `${name}.db`) };
}

function usageEvent(id, payload = {}, envelope = {}) {
  const result = validateCanonicalEvent({
    id,
    type: 'llm.usage',
    timestamp: envelope.timestamp ?? 1_700_000_000_000,
    source: 'agent:auditor',
    agentId: payload.agentId ?? 'researcher',
    sessionId: payload.sessionId ?? 'sess_1',
    summary: 'Audited call',
    payload: { provider: 'anthropic', model: 'claude', inputTokens: 10, outputTokens: 5, cost: 0.01, currency: 'USD', costSource: 'provider-reported', ...payload },
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
    agentId: payload.agentId ?? 'researcher',
    summary: 'Failed call',
    payload: { provider: 'anthropic', model: 'claude', errorKind: 'rate_limited', ...payload },
  });
  assert.equal(result.success, true, JSON.stringify(result.issues));
  return result.data;
}

/** Appends `count` usage events to `store`, one per millisecond of `clock`, returning the `seq` of each append
 * (in insertion order, which is `seq`-ascending for both stores). `make(i)` builds the event's own overrides. */
async function seedRows(store, clock, count, make) {
  const seqs = [];
  for (let i = 0; i < count; i++) {
    const { event, receivedAt } = make(i, clock.value);
    clock.value += 1;
    const result = await store.append(event, { receivedAt });
    assert.equal(result.outcome, 'accepted', `row ${i} must be accepted, got ${result.outcome}`);
    seqs.push(result.seq);
  }
  return seqs;
}

async function fullWalk(store, filters, order, limit) {
  const rows = [];
  let after;
  let guard = 0;
  while (true) {
    guard++;
    assert.ok(guard < 10_000, 'walk did not terminate');
    const page = await store.listCalls({ filters, order, limit, after });
    rows.push(...page.rows);
    if (!page.hasMore) break;
    after = { seq: page.lastSeq };
  }
  return rows;
}

test('listCalls: full walk at several page sizes and both orders, memory and sqlite', async () => {
  const { dir, file } = tempDbPath('walk');
  const memory = new MemoryEventStore();
  const sqlite = new SQLiteEventStore(file);
  try {
    for (const store of [memory, sqlite]) {
      const clock = { value: 1_700_000_000_000 };
      const expectedSeqs = await seedRows(store, clock, 25, (i, now) => ({
        event: usageEvent(`evt_walk_${store === memory ? 'm' : 's'}_${i}`, { agentId: i % 2 === 0 ? 'a1' : 'a2' }),
        receivedAt: now,
      }));
      const sortedAsc = [...expectedSeqs].sort((a, b) => a - b);
      const sortedDesc = [...sortedAsc].reverse();

      for (const limit of [1, 7, 1000]) {
        const asc = await fullWalk(store, emptyUsageFilters(), 'asc', limit);
        assert.deepEqual(asc.map((r) => r.seq), sortedAsc, `asc limit=${limit}`);
        for (let i = 1; i < asc.length; i++) assert.ok(asc[i].seq > asc[i - 1].seq, 'asc must be strictly increasing');

        const desc = await fullWalk(store, emptyUsageFilters(), 'desc', limit);
        assert.deepEqual(desc.map((r) => r.seq), sortedDesc, `desc limit=${limit}`);
        for (let i = 1; i < desc.length; i++) assert.ok(desc[i].seq < desc[i - 1].seq, 'desc must be strictly decreasing');
      }
    }
  } finally {
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listCalls: filters combine with AND across keys and OR within a repeated key', async () => {
  const { dir, file } = tempDbPath('filters');
  const memory = new MemoryEventStore();
  const sqlite = new SQLiteEventStore(file);
  try {
    for (const store of [memory, sqlite]) {
      const clock = { value: 1_700_000_100_000 };
      await seedRows(store, clock, 1, () => ({ event: usageEvent('evt_f1', { agentId: 'a1', provider: 'anthropic' }) }));
      await seedRows(store, clock, 1, () => ({ event: usageEvent('evt_f2', { agentId: 'a2', provider: 'anthropic' }) }));
      await seedRows(store, clock, 1, () => ({ event: usageEvent('evt_f3', { agentId: 'a1', provider: 'openai' }) }));
      await seedRows(store, clock, 1, () => ({ event: failedEvent('evt_f4', { agentId: 'a1' }) }));
      await seedRows(store, clock, 1, () => ({ event: usageEvent('evt_f5', { agentId: 'a1', currency: null, cost: null, costSource: 'unknown' }) }));

      // AND across keys: agentId=a1 AND provider=openai matches only evt_f3 (evt_f1/evt_f4/evt_f5 are
      // agentId=a1 too, but provider=anthropic).
      let page = await store.listCalls({ filters: { ...emptyUsageFilters(), agentId: ['a1'], provider: ['openai'] }, order: 'asc', limit: 100 });
      assert.deepEqual(page.rows.map((r) => r.eventId), ['evt_f3']);

      // OR within agentId: a1 or a2 matches everything except nothing is excluded by agentId here (all a1/a2).
      page = await store.listCalls({ filters: { ...emptyUsageFilters(), agentId: ['a1', 'a2'] }, order: 'asc', limit: 100 });
      assert.equal(page.rows.length, 5);

      // status filter: only the failed row.
      page = await store.listCalls({ filters: { ...emptyUsageFilters(), status: ['rate_limited'] }, order: 'asc', limit: 100 });
      assert.deepEqual(page.rows.map((r) => r.eventId), ['evt_f4']);
      assert.equal(page.rows[0].backfilled, false);

      // currency=none selects every row with no currency: evt_f4 (failed, never priced) and evt_f5 (usage,
      // explicitly reported with no cost).
      page = await store.listCalls({ filters: { ...emptyUsageFilters(), currency: ['none'] }, order: 'asc', limit: 100 });
      assert.deepEqual(page.rows.map((r) => r.eventId).sort(), ['evt_f4', 'evt_f5']);
      for (const row of page.rows) {
        assert.equal(row.cost, null);
        assert.equal(row.currency, null);
        assert.equal(row.costSource, 'unknown');
      }

      // currency=USD,none combined.
      page = await store.listCalls({ filters: { ...emptyUsageFilters(), currency: ['USD', 'none'] }, order: 'asc', limit: 100 });
      assert.equal(page.rows.length, 5);
    }
  } finally {
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listCalls: timeBasis switches which clock from/to apply to', async () => {
  const { dir, file } = tempDbPath('timebasis');
  const memory = new MemoryEventStore();
  const sqlite = new SQLiteEventStore(file);
  try {
    for (const store of [memory, sqlite]) {
      const occurredFarPast = 1_000_000_000_000;
      const event = usageEvent('evt_tb', {}, { timestamp: occurredFarPast });
      const receivedNow = 1_700_000_200_000;
      const result = await store.append(event, { receivedAt: receivedNow });
      assert.equal(result.outcome, 'accepted');

      const receivedWindow = { ...emptyUsageFilters(), timeBasis: 'received', from: receivedNow - 1, to: receivedNow + 1 };
      const occurredWindow = { ...emptyUsageFilters(), timeBasis: 'occurred', from: receivedNow - 1, to: receivedNow + 1 };

      const byReceived = await store.listCalls({ filters: receivedWindow, order: 'asc', limit: 10 });
      assert.equal(byReceived.rows.length, 1, 'received window must match: the row arrived at receivedNow');

      const byOccurred = await store.listCalls({ filters: occurredWindow, order: 'asc', limit: 10 });
      assert.equal(byOccurred.rows.length, 0, 'occurred window must not match: the row happened long before');
    }
  } finally {
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listCalls: rows inserted during a desc walk do not appear in it', async () => {
  const { dir, file } = tempDbPath('desc-insert');
  const memory = new MemoryEventStore();
  const sqlite = new SQLiteEventStore(file);
  try {
    for (const store of [memory, sqlite]) {
      const clock = { value: 1_700_000_300_000 };
      const tag = store === memory ? 'm' : 's';
      await seedRows(store, clock, 5, (i, now) => ({ event: usageEvent(`evt_di_${tag}_${i}`, {}), receivedAt: now }));

      const page1 = await store.listCalls({ filters: emptyUsageFilters(), order: 'desc', limit: 2 });
      assert.equal(page1.rows.length, 2);
      assert.equal(page1.hasMore, true);

      // A new row arrives mid-walk, with a higher seq.
      await seedRows(store, clock, 1, (i, now) => ({ event: usageEvent(`evt_di_${tag}_new`, {}), receivedAt: now }));

      const page2 = await store.listCalls({ filters: emptyUsageFilters(), order: 'desc', limit: 10, after: { seq: page1.lastSeq } });
      assert.ok(!page2.rows.some((r) => r.eventId === `evt_di_${tag}_new`), 'the late row must not appear in an in-progress desc walk');
      assert.equal(page2.rows.length, 3); // the 3 remaining original rows, never the new one.
    }
  } finally {
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listCalls: rows inserted during an asc walk appear exactly once when the client resumes', async () => {
  const { dir, file } = tempDbPath('asc-insert');
  const memory = new MemoryEventStore();
  const sqlite = new SQLiteEventStore(file);
  try {
    for (const store of [memory, sqlite]) {
      const clock = { value: 1_700_000_400_000 };
      const tag = store === memory ? 'm' : 's';
      await seedRows(store, clock, 3, (i, now) => ({ event: usageEvent(`evt_ai_${tag}_${i}`, {}), receivedAt: now }));

      const page1 = await store.listCalls({ filters: emptyUsageFilters(), order: 'asc', limit: 2 });
      assert.equal(page1.rows.length, 2);
      assert.equal(page1.hasMore, true);

      const page2 = await store.listCalls({ filters: emptyUsageFilters(), order: 'asc', limit: 10, after: { seq: page1.lastSeq } });
      assert.equal(page2.hasMore, false);
      assert.ok(page2.lastSeq !== null, 'an asc page with hasMore=false still carries a lastSeq to resume from');

      // A new row arrives after the walk looked "done".
      const [newSeq] = await seedRows(store, clock, 1, (i, now) => ({ event: usageEvent(`evt_ai_${tag}_new`, {}), receivedAt: now }));

      const page3 = await store.listCalls({ filters: emptyUsageFilters(), order: 'asc', limit: 10, after: { seq: page2.lastSeq } });
      assert.deepEqual(page3.rows.map((r) => r.seq), [newSeq]);
    }
  } finally {
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listCalls (SQLite): rows deleted during a walk do not cause duplicates or skip survivors', async () => {
  const { dir, file } = tempDbPath('deletion');
  const sqlite = new SQLiteEventStore(file);
  try {
    const clock = { value: 1_700_000_500_000 };
    const seqs = await seedRows(sqlite, clock, 6, (i, now) => ({ event: usageEvent(`evt_del_${i}`, {}), receivedAt: now }));

    const page1 = await sqlite.listCalls({ filters: emptyUsageFilters(), order: 'desc', limit: 2 });
    assert.equal(page1.rows.length, 2);

    // Simulate retention (#70) deleting a row that has not been read yet.
    const toDelete = seqs[0]; // the oldest row, not yet reached by a desc walk starting from the newest.
    sqlite.db.prepare('DELETE FROM usage_ledger WHERE seq = ?').run(toDelete);

    const rest = [];
    let after = { seq: page1.lastSeq };
    while (true) {
      const page = await sqlite.listCalls({ filters: emptyUsageFilters(), order: 'desc', limit: 2, after });
      rest.push(...page.rows);
      if (!page.hasMore) break;
      after = { seq: page.lastSeq };
    }
    const allSeqs = [...page1.rows, ...rest].map((r) => r.seq).sort((a, b) => a - b);
    const survivors = seqs.filter((s) => s !== toDelete).sort((a, b) => a - b);
    assert.deepEqual(allSeqs, survivors);
  } finally {
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listCalls: an event ingested late with an old client timestamp never appears in a page already served', async () => {
  const { dir, file } = tempDbPath('late-event');
  const memory = new MemoryEventStore();
  const sqlite = new SQLiteEventStore(file);
  try {
    for (const store of [memory, sqlite]) {
      const clock = { value: 1_700_000_600_000 };
      const tag = store === memory ? 'm' : 's';
      await seedRows(store, clock, 3, (i, now) => ({ event: usageEvent(`evt_late_${tag}_${i}`, {}, { timestamp: now }), receivedAt: now }));

      const page1 = await store.listCalls({ filters: emptyUsageFilters(), order: 'desc', limit: 10 });
      assert.equal(page1.hasMore, false);
      const servedIds = new Set(page1.rows.map((r) => r.eventId));

      // A late event: an old client timestamp, but it only arrives (is received) now, after page1 was served.
      await seedRows(store, clock, 1, (i, now) => ({
        event: usageEvent(`evt_late_${tag}_old`, {}, { timestamp: 1_000_000_000_000 }),
        receivedAt: now,
      }));

      assert.ok(!servedIds.has(`evt_late_${tag}_old`), 'the already-served page must not retroactively include the late event');
    }
  } finally {
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('usageLedgerEpoch: memory mode mints a new epoch per process/instance', () => {
  const a = new MemoryEventStore();
  const b = new MemoryEventStore();
  assert.notEqual(a.usageLedgerEpoch(), b.usageLedgerEpoch());
  assert.equal(typeof a.usageLedgerEpoch(), 'string');
  assert.ok(a.usageLedgerEpoch().length > 0);
});

test('usageLedgerEpoch (SQLite): persists across a restart against the same file', async () => {
  const { dir, file } = tempDbPath('epoch-restart');
  const first = new SQLiteEventStore(file);
  const epoch1 = first.usageLedgerEpoch();
  await first.close();

  const second = new SQLiteEventStore(file);
  const epoch2 = second.usageLedgerEpoch();
  try {
    assert.equal(epoch1, epoch2);
    assert.equal(typeof epoch1, 'string');
    assert.ok(epoch1.length > 0);
  } finally {
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('usageLedgerEpoch (SQLite): two different database files never share an epoch', async () => {
  const { dir: dirA, file: fileA } = tempDbPath('epoch-a');
  const { dir: dirB, file: fileB } = tempDbPath('epoch-b');
  const a = new SQLiteEventStore(fileA);
  const b = new SQLiteEventStore(fileB);
  try {
    assert.notEqual(a.usageLedgerEpoch(), b.usageLedgerEpoch());
  } finally {
    await a.close();
    await b.close();
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('listCalls (SQLite): EXPLAIN QUERY PLAN shows no temp sort and uses the expected index', async () => {
  const { dir, file } = tempDbPath('query-plan');
  const sqlite = new SQLiteEventStore(file);
  try {
    const clock = { value: 1_700_000_700_000 };
    await seedRows(sqlite, clock, 5, (i, now) => ({ event: usageEvent(`evt_plan_${i}`, { agentId: 'a1' }), receivedAt: now }));

    function plan(sql, params) {
      return sqlite.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join(' | ');
    }

    const unfiltered = await import('../server/usage/calls.ts').then((m) =>
      m.buildListCallsQuery({ filters: emptyUsageFilters(), order: 'desc', limit: 10 })
    );
    const unfilteredPlan = plan(unfiltered.sql, unfiltered.params);
    assert.ok(!/TEMP B-TREE/.test(unfilteredPlan), `unfiltered plan must not sort: ${unfilteredPlan}`);

    const { buildListCallsQuery } = await import('../server/usage/calls.ts');
    const byAgent = buildListCallsQuery({ filters: { ...emptyUsageFilters(), agentId: ['a1'] }, order: 'desc', limit: 10 });
    const byAgentPlan = plan(byAgent.sql, byAgent.params);
    assert.ok(/USING INDEX/.test(byAgentPlan), `agentId-filtered plan must use an index: ${byAgentPlan}`);
    assert.ok(!/TEMP B-TREE/.test(byAgentPlan), `agentId-filtered plan must not sort: ${byAgentPlan}`);

    const byRequestId = buildListCallsQuery({ filters: { ...emptyUsageFilters(), requestId: ['req-none'] }, order: 'desc', limit: 10 });
    const byRequestIdPlan = plan(byRequestId.sql, byRequestId.params);
    assert.ok(/USING INDEX/.test(byRequestIdPlan), `requestId-filtered plan must use an index: ${byRequestIdPlan}`);

    // A time-window-only query is only required to use the received_at/occurred_at index (never an unindexed
    // SCAN); the issue does not require it to also avoid a temp sort, since that index is not ordered by seq.
    const byTime = buildListCallsQuery({ filters: { ...emptyUsageFilters(), from: 1, to: 2_000_000_000_000 }, order: 'desc', limit: 10 });
    const byTimePlan = plan(byTime.sql, byTime.params);
    assert.ok(/USING INDEX ix_usage_ledger_received/.test(byTimePlan), `time-window plan must use the received_at index: ${byTimePlan}`);
    assert.ok(!/\bSCAN usage_ledger\b/.test(byTimePlan), `time-window plan must not be an unindexed scan: ${byTimePlan}`);
  } finally {
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
