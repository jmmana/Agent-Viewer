// Issue #70: the retention baseline. Covers `EventStore.purge`/`retentionStatus`/`recordRetentionRun`/
// `finishRetentionRun` on both `MemoryEventStore` and `SQLiteEventStore`: the age cutoff uses the server receive
// time (not the client timestamp), the boundary at the cutoff, independence of the two windows, batching with an
// event-loop yield (SQLite), and the resend-after-purge invariant that must never double count a total.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryEventStore, SQLiteEventStore } from '../server/store.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-retention-'));
  return { dir, file: path.join(dir, `${name}.db`) };
}

function usageEvent(id, { timestamp = 1_700_000_000_000, payload = {}, ...envelope } = {}) {
  const result = validateCanonicalEvent({
    id,
    type: 'llm.usage',
    timestamp,
    source: 'agent:auditor',
    agentId: 'auditor',
    summary: 'Audited call',
    payload: {
      provider: 'p',
      model: 'm',
      inputTokens: 100,
      outputTokens: 10,
      cost: 0.01,
      currency: 'USD',
      costSource: 'provider-reported',
      ...payload,
    },
    ...envelope,
  });
  assert.equal(result.success, true, JSON.stringify(result.issues));
  return result.data;
}

/** Runs the same body against a fresh memory store and a fresh (temp-file) SQLite store, with cleanup. */
async function withEachStore(fn) {
  const memory = new MemoryEventStore({ maxEvents: 10_000 });
  try {
    await fn(memory, 'memory');
  } finally {
    await memory.close();
  }

  const { dir, file } = tempDbPath('store');
  const sqlite = new SQLiteEventStore(file, { backup: 'off' });
  await sqlite.init();
  try {
    await fn(sqlite, 'sqlite');
  } finally {
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('purge: age cutoff is the server receive time, not the client timestamp', async () => {
  await withEachStore(async (store, label) => {
    // An old client timestamp (a replayed log, issue #70's own example) must survive when freshly received.
    await store.append(usageEvent('evt_old_ts', { timestamp: 1_000_000_000_000 }), { receivedAt: 2_000_000_000_000 });
    const result = await store.purge({ eventsCutoffMs: 1_500_000_000_000 });
    assert.equal(result.eventsDeleted, 0, `${label}: an old client timestamp alone must not be purged`);
    const events = await store.list({});
    assert.equal(events.length, 1);
  });
});

test('purge: a row exactly at the cutoff survives; one millisecond older is deleted', async () => {
  await withEachStore(async (store, label) => {
    await store.append(usageEvent('evt_at_cutoff'), { receivedAt: 1_000 });
    await store.append(usageEvent('evt_before_cutoff'), { receivedAt: 999 });
    const result = await store.purge({ eventsCutoffMs: 1_000 });
    assert.equal(result.eventsDeleted, 1, label);
    const remaining = (await store.list({})).map((e) => e.id);
    assert.deepEqual(remaining, ['evt_at_cutoff'], label);
  });
});

test('purge: events and the usage ledger are independent; only the configured window is ever touched', async () => {
  await withEachStore(async (store, label) => {
    await store.append(usageEvent('evt_1'), { receivedAt: 1_000 });
    await store.append(usageEvent('evt_2'), { receivedAt: 5_000 });

    const eventsOnly = await store.purge({ eventsCutoffMs: 2_000 });
    assert.equal(eventsOnly.eventsDeleted, 1, `${label}: events purge deletes the old row`);
    assert.equal(eventsOnly.ledgerDeleted, 0, `${label}: no ledgerCutoffMs means the ledger is untouched`);
    const ledgerStatusAfterEvents = await store.usageLedgerStatus();
    assert.equal(ledgerStatusAfterEvents.rows, 2, `${label}: the ledger still has both rows after an events-only purge`);

    const ledgerOnly = await store.purge({ ledgerCutoffMs: 6_000 });
    assert.equal(ledgerOnly.eventsDeleted, 0, `${label}: no eventsCutoffMs means events are untouched`);
    assert.equal(ledgerOnly.ledgerDeleted, 2, `${label}: both ledger rows are older than the ledger cutoff`);
    const remainingEvents = await store.list({});
    assert.equal(remainingEvents.length, 1, `${label}: the one remaining event row is untouched by the ledger purge`);
  });
});

test('purge: resending a purged event id never creates a second ledger row or double counts totals', async () => {
  await withEachStore(async (store, label) => {
    const event = usageEvent('evt_resend', { payload: { inputTokens: 1000, outputTokens: 100, cost: 1 } });
    await store.append(event, { receivedAt: 1_000 });

    const before = await store.usageSummary();
    assert.equal(before.total.calls, 1, label);

    // Purge the event row, but keep the ledger (independent windows): the exact scenario the issue's own
    // "Current behavior" section calls out as newly reachable once a purge exists.
    const purgeResult = await store.purge({ eventsCutoffMs: 2_000 });
    assert.equal(purgeResult.eventsDeleted, 1, label);
    assert.equal((await store.list({})).length, 0, label);

    // Resend the exact same event. SQLite accepts it again at the storage level (nothing left in `events` to
    // recognize it by: this is the exact gap the issue calls out); the memory store still recognizes the id from
    // its own dedup memory, which a time-based purge never clears (only the count-based cap eviction can, and
    // only when `rememberEvictedIds` is turned off, which the default store never does). Either way, the ledger
    // must still only hold one row for it, and the usage totals must not move.
    const resendResult = await store.append(event, { receivedAt: 9_000 });
    assert.ok(['accepted', 'duplicate'].includes(resendResult.outcome), label);

    const ledgerStatus = await store.usageLedgerStatus();
    assert.equal(ledgerStatus.rows, 1, `${label}: still exactly one ledger row for this call`);

    const after = await store.usageSummary();
    assert.deepEqual(after, before, `${label}: usageSummary (agent/global totals) must be unchanged by the resend`);
  });
});

test('purge: a purge never rewinds session or runtime eventsCount', async () => {
  await withEachStore(async (store, label) => {
    const event = usageEvent('evt_counters', { sessionId: 'ses_1', runtimeId: 'rt_1' });
    await store.append(event, { receivedAt: 1_000 });
    const sessionBefore = await store.getSession('ses_1');
    const runtimesBefore = await store.listRuntimes();
    await store.purge({ eventsCutoffMs: 2_000 });
    const sessionAfter = await store.getSession('ses_1');
    const runtimesAfter = await store.listRuntimes();
    assert.equal(sessionAfter.eventsCount, sessionBefore.eventsCount, label);
    assert.equal(runtimesAfter.find((r) => r.id === 'rt_1').eventsCount, runtimesBefore.find((r) => r.id === 'rt_1').eventsCount, label);
  });
});

test('purge: with no cutoffs given at all, nothing is deleted', async () => {
  await withEachStore(async (store, label) => {
    await store.append(usageEvent('evt_keep'), { receivedAt: 1_000 });
    const result = await store.purge({});
    assert.deepEqual([result.eventsDeleted, result.ledgerDeleted], [0, 0], label);
  });
});

test('retentionStatus: oldestReceivedAt and count reflect what purge left behind; null on an empty table', async () => {
  await withEachStore(async (store, label) => {
    const empty = await store.retentionStatus();
    assert.equal(empty.events.count, 0, label);
    assert.equal(empty.events.oldestReceivedAt, null, label);
    assert.equal(empty.events.purgedBefore, null, label);
    assert.equal(empty.events.deletedTotal, 0, label);

    await store.append(usageEvent('evt_a'), { receivedAt: 1_000 });
    await store.append(usageEvent('evt_b'), { receivedAt: 5_000 });
    await store.purge({ eventsCutoffMs: 2_000 });

    const status = await store.retentionStatus();
    assert.equal(status.events.count, 1, label);
    assert.equal(status.events.oldestReceivedAt, 5_000, label);
    assert.equal(status.events.purgedBefore, 2_000, label);
    assert.equal(status.events.deletedTotal, 1, label);
  });
});

test('retentionStatus: purgedBefore only ever moves forward, and deletedTotal accumulates across runs', async () => {
  await withEachStore(async (store, label) => {
    await store.append(usageEvent('evt_a'), { receivedAt: 1_000 });
    await store.append(usageEvent('evt_b'), { receivedAt: 2_000 });
    await store.append(usageEvent('evt_c'), { receivedAt: 3_000 });

    await store.purge({ eventsCutoffMs: 1_500 });
    let status = await store.retentionStatus();
    assert.equal(status.events.purgedBefore, 1_500, label);
    assert.equal(status.events.deletedTotal, 1, label);

    // A second run whose cutoff is smaller than the first must not move purgedBefore backwards, and nothing is
    // deleted since nothing is older than this cutoff any more.
    await store.purge({ eventsCutoffMs: 1_200 });
    status = await store.retentionStatus();
    assert.equal(status.events.purgedBefore, 1_500, label);
    assert.equal(status.events.deletedTotal, 1, label);

    await store.purge({ eventsCutoffMs: 2_500 });
    status = await store.retentionStatus();
    assert.equal(status.events.purgedBefore, 2_500, label);
    assert.equal(status.events.deletedTotal, 2, label);
  });
});

test('recordRetentionRun / finishRetentionRun: a round trip is reflected in retentionStatus, newest first', async () => {
  await withEachStore(async (store, label) => {
    const id1 = await store.recordRetentionRun({ startedAt: 1_000, trigger: 'startup' });
    await store.finishRetentionRun(id1, {
      finishedAt: 1_010,
      status: 'ok',
      eventsWindowDays: 30,
      eventsCutoffMs: 999,
      eventsDeleted: 0,
      ledgerWindowDays: null,
      ledgerCutoffMs: null,
      ledgerDeleted: 0,
      error: null,
    });
    const id2 = await store.recordRetentionRun({ startedAt: 2_000, trigger: 'schedule', skip: true });

    const status = await store.retentionStatus();
    assert.equal(status.lastRun.id, id2, label);
    assert.equal(status.lastRun.status, 'skipped', label);
    assert.equal(status.runs.length, 2, label);
    assert.equal(status.runs[0].id, id2, label);
    assert.equal(status.runs[1].id, id1, label);
    assert.equal(status.runs[1].eventsWindowDays, 30, label);
    assert.equal(status.events.lastCutoffMs, 999, `${label}: the last *finished* run with a configured events window`);
    assert.equal(status.events.lastDeleted, 0, label);
  });
});

test('recordRetentionRun / finishRetentionRun: run history is capped at 500 rows', async () => {
  await withEachStore(async (store, label) => {
    for (let i = 0; i < 505; i++) {
      const id = await store.recordRetentionRun({ startedAt: i, trigger: 'schedule' });
      await store.finishRetentionRun(id, {
        finishedAt: i + 1,
        status: 'ok',
        eventsWindowDays: null,
        eventsCutoffMs: null,
        eventsDeleted: 0,
        ledgerWindowDays: null,
        ledgerCutoffMs: null,
        ledgerDeleted: 0,
        error: null,
      });
    }
    const status = await store.retentionStatus(500);
    assert.equal(status.runs.length, 500, label);
    assert.equal(status.lastRun.startedAt, 504, `${label}: the newest run is kept`);
    assert.equal(status.runs.at(-1).startedAt, 5, `${label}: the oldest 5 runs (0..4) were pruned`);
  });
});

// -------------------------------------------------------------
// SQLite-only: batching and the event-loop yield between batches.
// -------------------------------------------------------------

test('SQLite purge: a purge larger than one batch runs in batches and yields the event loop between them', async () => {
  const { dir, file } = tempDbPath('batching');
  const store = new SQLiteEventStore(file, { backup: 'off' });
  await store.init();
  try {
    const total = 12;
    for (let i = 0; i < total; i++) {
      await store.append(usageEvent(`evt_batch_${i}`, { payload: { requestId: `req-${i}` } }), { receivedAt: 1_000 + i });
    }

    let immediateFired = false;
    setImmediate(() => {
      immediateFired = true;
    });

    const result = await store.purge({ eventsCutoffMs: 2_000, batchSize: 3 });
    assert.equal(result.eventsDeleted, total);
    assert.equal(
      immediateFired,
      true,
      'a setImmediate scheduled concurrently with the purge must fire before the purge resolves (event-loop yield between batches)'
    );
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite purge: batching deletes originals and duplicate references alike, and decrements eventsCount only for originals', async () => {
  const { dir, file } = tempDbPath('originals');
  const store = new SQLiteEventStore(file, { backup: 'off' });
  await store.init();
  try {
    await store.append(usageEvent('evt_orig', { payload: { requestId: 'req-dup' } }), { receivedAt: 1_000 });
    // Same (provider, requestId): stored as a duplicate reference, inline in `events` with `duplicate_of` set.
    await store.append(usageEvent('evt_dup', { payload: { requestId: 'req-dup' } }), { receivedAt: 1_000 });

    const snapshotBefore = await store.snapshot();
    assert.equal(snapshotBefore.eventsCount, 1);

    const result = await store.purge({ eventsCutoffMs: 2_000, batchSize: 1 });
    assert.equal(result.eventsDeleted, 2, 'both the original row and its duplicate reference row are deleted');

    const snapshotAfter = await store.snapshot();
    assert.equal(snapshotAfter.eventsCount, 0);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite purge: rollups over the retained ledger are byte-for-byte identical before and after an events purge, and after reopening the database', async () => {
  const { dir, file } = tempDbPath('restart');
  let store = new SQLiteEventStore(file, { backup: 'off' });
  await store.init();
  await store.append(usageEvent('evt_keep', { payload: { requestId: 'req-keep' } }), { receivedAt: 10_000 });
  await store.append(usageEvent('evt_gone', { payload: { requestId: 'req-gone' } }), { receivedAt: 1_000 });

  function ledgerRowsSnapshot(s) {
    // Raw ledger rows (never a sum of tokens/cost, per the store's own rule): if these are unchanged, any
    // ledger-based rollup computed over them (#66) is unchanged too.
    return s.db.prepare('SELECT * FROM usage_ledger ORDER BY seq').all();
  }

  const ledgerBefore = ledgerRowsSnapshot(store);
  assert.equal(ledgerBefore.length, 2);

  await store.purge({ eventsCutoffMs: 2_000 });
  const ledgerAfterPurge = ledgerRowsSnapshot(store);
  assert.deepEqual(ledgerAfterPurge, ledgerBefore, 'purging events never touches the ledger table');

  await store.close();
  store = new SQLiteEventStore(file, { backup: 'off' });
  await store.init();
  try {
    const ledgerAfterRestart = ledgerRowsSnapshot(store);
    assert.deepEqual(ledgerAfterRestart, ledgerBefore, 'a restart after the purge leaves the ledger exactly as it was');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
