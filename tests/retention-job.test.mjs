// Issue #70: the retention baseline. Covers `startRetention`'s scheduling behavior in isolation, against a fake
// store that only implements the three methods the job calls (`purge`, `recordRetentionRun`,
// `finishRetentionRun`), using `node:test`'s mock timers instead of real `setTimeout`/`setInterval` delays. The
// store's own correctness (batching, cutoffs, persistence) is covered by `tests/retention-store.test.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startRetention } from '../server/retention.ts';

/** A real microtask flush: lets promise chains created inside a mocked-timer callback settle before the next
 * assertion, without depending on the mocked clock (which never mocks `setImmediate` here). */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeStore {
  constructor() {
    this.runs = new Map();
    this.nextId = 1;
    this.purgeCalls = [];
    /** Queue of behaviors for successive `purge()` calls: a function, or a result object. Default: a no-op ok result. */
    this.purgeScript = [];
  }

  async purge(opts) {
    this.purgeCalls.push(opts);
    const behavior = this.purgeScript.shift();
    if (typeof behavior === 'function') return behavior(opts);
    if (behavior) return behavior;
    return { eventsDeleted: 0, ledgerDeleted: 0, eventsOldestReceivedAt: null, ledgerOldestReceivedAt: null };
  }

  async recordRetentionRun({ startedAt, trigger, skip }) {
    const id = this.nextId++;
    this.runs.set(id, {
      id,
      startedAt,
      finishedAt: skip ? startedAt : null,
      trigger,
      status: skip ? 'skipped' : 'running',
      eventsWindowDays: null,
      eventsCutoffMs: null,
      eventsDeleted: 0,
      ledgerWindowDays: null,
      ledgerCutoffMs: null,
      ledgerDeleted: 0,
      error: null,
    });
    return id;
  }

  async finishRetentionRun(id, patch) {
    const record = this.runs.get(id);
    Object.assign(record, patch);
  }
}

test('startRetention: with both windows unset, no timer is created and runOnce is never called on its own', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const store = new FakeStore();
  const job = startRetention({ store, config: { eventsDays: null, ledgerDays: null, intervalMinutes: 60 }, log: () => {} });
  t.mock.timers.tick(10 * 24 * 60 * 60 * 1000); // 10 days: comfortably past any startup delay or interval
  await flush();
  assert.equal(store.purgeCalls.length, 0);
  await job.stop();
});

test('startRetention: runs once about startupDelayMs after creation, trigger "startup"', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const store = new FakeStore();
  const log = [];
  const job = startRetention({
    store,
    config: { eventsDays: 30, ledgerDays: null, intervalMinutes: 60 },
    now: () => 1_000_000,
    log: (m) => log.push(m),
    startupDelayMs: 30_000,
  });

  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(store.purgeCalls.length, 0, 'not yet');

  t.mock.timers.tick(1);
  await flush();
  assert.equal(store.purgeCalls.length, 1);
  assert.equal(store.runs.get(1).trigger, 'startup');
  assert.equal(store.runs.get(1).status, 'ok');
  assert.ok(log.some((line) => line.includes('retention:')));
  await job.stop();
});

test('startRetention: runs again every intervalMinutes, trigger "schedule"', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const store = new FakeStore();
  const job = startRetention({
    store,
    config: { eventsDays: 30, ledgerDays: null, intervalMinutes: 5 },
    now: () => 1_000_000,
    log: () => {},
    startupDelayMs: 1_000,
  });

  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(store.purgeCalls.length, 1);
  assert.equal(store.runs.get(1).trigger, 'startup');

  t.mock.timers.tick(5 * 60_000);
  await flush();
  assert.equal(store.purgeCalls.length, 2);
  assert.equal(store.runs.get(2).trigger, 'schedule');

  t.mock.timers.tick(5 * 60_000);
  await flush();
  assert.equal(store.purgeCalls.length, 3);
  await job.stop();
});

test('startRetention: overlap guard skips a tick while a run is in progress, and records it', async () => {
  const store = new FakeStore();
  let resolvePurge;
  store.purgeScript.push(() => new Promise((resolve) => { resolvePurge = resolve; }));

  const job = startRetention({
    store,
    config: { eventsDays: 30, ledgerDays: null, intervalMinutes: 60 },
    log: () => {},
    startupDelayMs: 10_000_000, // never fires on its own in this test; both calls below are manual.
  });

  const first = job.runOnce('schedule');
  // The first run is now blocked inside `purge()`. A concurrent tick must be skipped, not queued or run in
  // parallel with a second `purge()` call.
  const second = await job.runOnce('schedule');
  assert.equal(second.status, 'skipped');
  assert.equal(store.purgeCalls.length, 1, 'the skipped run never calls purge a second time');

  resolvePurge({ eventsDeleted: 0, ledgerDeleted: 0, eventsOldestReceivedAt: null, ledgerOldestReceivedAt: null });
  const firstResult = await first;
  assert.equal(firstResult.status, 'ok');
  await job.stop();
});

test('startRetention: a purge failure is logged and recorded as "error", and the next tick tries again', async () => {
  const store = new FakeStore();
  store.purgeScript.push(() => {
    const error = new Error('disk full');
    error.code = 'SQLITE_FULL';
    throw error;
  });

  const logs = [];
  const job = startRetention({
    store,
    config: { eventsDays: 30, ledgerDays: 90, intervalMinutes: 60 },
    log: (m) => logs.push(m),
    startupDelayMs: 10_000_000,
  });

  const failed = await job.runOnce('schedule');
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /SQLITE_FULL: disk full/);
  assert.ok(logs.some((line) => line.includes('run failed')));

  const recovered = await job.runOnce('schedule');
  assert.equal(recovered.status, 'ok');
  assert.equal(store.purgeCalls.length, 2);
  await job.stop();
});

test('startRetention: stop() clears both timers and waits for a run already in progress', async () => {
  const store = new FakeStore();
  let resolvePurge;
  store.purgeScript.push(() => new Promise((resolve) => { resolvePurge = resolve; }));

  const job = startRetention({
    store,
    config: { eventsDays: 30, ledgerDays: null, intervalMinutes: 60 },
    log: () => {},
    startupDelayMs: 10_000_000,
  });

  const inFlight = job.runOnce('schedule');
  await flush(); // lets runOnce reach store.purge() and capture resolvePurge before we try to use it.
  let stopped = false;
  const stopPromise = job.stop().then(() => {
    stopped = true;
  });
  assert.equal(stopped, false, 'stop() must not resolve before the in-flight run finishes');
  resolvePurge({ eventsDeleted: 0, ledgerDeleted: 0, eventsOldestReceivedAt: null, ledgerOldestReceivedAt: null });
  await inFlight;
  await stopPromise;
  assert.equal(stopped, true);
});

test('startRetention: totals() tracks rows deleted since process start, per scope, null when a window is unconfigured', async () => {
  const store = new FakeStore();
  store.purgeScript.push({ eventsDeleted: 12, ledgerDeleted: 0, eventsOldestReceivedAt: null, ledgerOldestReceivedAt: null });
  store.purgeScript.push({ eventsDeleted: 3, ledgerDeleted: 0, eventsOldestReceivedAt: null, ledgerOldestReceivedAt: null });

  const job = startRetention({
    store,
    config: { eventsDays: 30, ledgerDays: null, intervalMinutes: 60 },
    log: () => {},
    startupDelayMs: 10_000_000,
  });

  assert.deepEqual(job.totals(), { events: 0, usageLedger: null });
  await job.runOnce('schedule');
  assert.deepEqual(job.totals(), { events: 12, usageLedger: null });
  await job.runOnce('schedule');
  assert.deepEqual(job.totals(), { events: 15, usageLedger: null });
  await job.stop();
});
