// Issue #305 (sub-issue of #85): live transitions. Pure unit coverage for the pieces `server/index.ts` composes
// into the `event: budget` SSE frame and the `onBudgetTransition` hook (tests/budgets-sse.test.mjs covers that
// end-to-end wiring against the real app): `buildBudgetTransition`'s direction/threshold rules,
// `budgetWindowRolledOver`'s pure decision, `evaluateBudgetLive`'s diff-and-persist behavior against a stub
// registry, the `onBudgetTransition`/`emitBudgetTransition` listener contract, and `startBudgetRolloverWatcher`'s
// sweep logic (always driven through its own `runOnce`, never by waiting on the real unref'd timer, same
// convention `tests/retention-job.test.mjs` already uses for `startRetention`).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBudgetTransition,
  budgetWindowRolledOver,
  evaluateBudgetLive,
  onBudgetTransition,
  emitBudgetTransition,
  startBudgetRolloverWatcher,
  computeBudgetWindow,
} from '../server/budgets.ts';

function budgetFixture(overrides = {}) {
  return {
    id: 'bud_live',
    name: 'Live budget',
    scope: { type: 'all', value: null },
    period: 'month',
    timezone: 'UTC',
    currency: 'USD',
    basis: 'reported',
    limit: 10,
    warningRatio: 0.5,
    enabled: true,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function statusFixture(overrides = {}) {
  return {
    state: 'ok',
    window: { start: 0, end: 1000 },
    spent: 0,
    spentComplete: true,
    knownSpent: 0,
    breakdown: { reported: 0, estimated: 0 },
    containsEstimates: false,
    limitRemaining: 10,
    ratio: 0,
    calls: { total: 0, withCost: 0, unknownCost: 0, otherCurrency: 0, missingCurrency: 0 },
    unknownReasons: [],
    pricingVersions: [],
    evaluatedAt: 0,
    ...overrides,
  };
}

// -------------------------------------------------------------
// buildBudgetTransition
// -------------------------------------------------------------

test('buildBudgetTransition: null when the state did not change', () => {
  const budget = budgetFixture();
  const status = statusFixture({ state: 'warning' });
  assert.equal(buildBudgetTransition(budget, status, status, 'ledger_event', 100), null);
});

test('buildBudgetTransition: ok -> warning is direction "up" with the budget\'s own warningRatio as threshold', () => {
  const budget = budgetFixture({ warningRatio: 0.5 });
  const previous = statusFixture({ state: 'ok' });
  const current = statusFixture({ state: 'warning' });
  const transition = buildBudgetTransition(budget, previous, current, 'ledger_event', 100);
  assert.equal(transition.from, 'ok');
  assert.equal(transition.to, 'warning');
  assert.equal(transition.direction, 'up');
  assert.equal(transition.threshold, 0.5);
  assert.equal(transition.trigger, 'ledger_event');
  assert.equal(transition.detectedAt, 100);
  assert.equal(transition.budgetId, budget.id);
  assert.equal(transition.budgetName, budget.name);
  assert.deepEqual(transition.scope, budget.scope);
  assert.equal(transition.period, budget.period);
  assert.equal(transition.timezone, budget.timezone);
  assert.equal(transition.currency, budget.currency);
  assert.equal(transition.limit, budget.limit);
  assert.equal(transition.status, current);
  assert.equal(transition.previousStatus, previous);
  assert.equal(transition.schemaVersion, '1.0');
});

test('buildBudgetTransition: warning -> exceeded is direction "up" with threshold 1', () => {
  const budget = budgetFixture();
  const transition = buildBudgetTransition(
    budget,
    statusFixture({ state: 'warning' }),
    statusFixture({ state: 'exceeded' }),
    'ledger_event',
    200
  );
  assert.equal(transition.direction, 'up');
  assert.equal(transition.threshold, 1);
});

test('buildBudgetTransition: exceeded -> ok (a window rollover resetting spend) is direction "down" with threshold null', () => {
  const budget = budgetFixture();
  const transition = buildBudgetTransition(
    budget,
    statusFixture({ state: 'exceeded' }),
    statusFixture({ state: 'ok' }),
    'window_rollover',
    300
  );
  assert.equal(transition.direction, 'down');
  assert.equal(transition.threshold, null);
  assert.equal(transition.trigger, 'window_rollover');
});

test('buildBudgetTransition: a transition into/out of "unknown" is still a deterministic transition', () => {
  const budget = budgetFixture();
  const intoUnknown = buildBudgetTransition(
    budget,
    statusFixture({ state: 'ok' }),
    statusFixture({ state: 'unknown' }),
    'ledger_event',
    400
  );
  assert.equal(intoUnknown.from, 'ok');
  assert.equal(intoUnknown.to, 'unknown');
  assert.equal(intoUnknown.threshold, null);

  const outOfUnknown = buildBudgetTransition(
    budget,
    statusFixture({ state: 'unknown' }),
    statusFixture({ state: 'ok' }),
    'ledger_event',
    400
  );
  assert.equal(outOfUnknown.from, 'unknown');
  assert.equal(outOfUnknown.to, 'ok');
});

// -------------------------------------------------------------
// budgetWindowRolledOver
// -------------------------------------------------------------

test('budgetWindowRolledOver: true with no last status (never live-checked before)', () => {
  assert.equal(budgetWindowRolledOver(null, { start: 100, end: 200 }), true);
});

test('budgetWindowRolledOver: false when the window start is unchanged', () => {
  const lastStatus = statusFixture({ window: { start: 100, end: 200 } });
  assert.equal(budgetWindowRolledOver(lastStatus, { start: 100, end: 500 }), false);
});

test('budgetWindowRolledOver: true when the window start moved on', () => {
  const lastStatus = statusFixture({ window: { start: 100, end: 200 } });
  assert.equal(budgetWindowRolledOver(lastStatus, { start: 200, end: 300 }), true);
});

// -------------------------------------------------------------
// evaluateBudgetLive (stub registry + deps, no real store)
// -------------------------------------------------------------

function makeStubDeps({ ledgerRows = [], now = () => 1000 } = {}) {
  const lastStatusByBudget = new Map();
  const registry = {
    create() { throw new Error('not used by this stub'); },
    update() { return null; },
    delete() { return false; },
    get() { return null; },
    list() { return []; },
    listRevisions() { return []; },
    getCachedStatus() { return null; },
    setCachedStatus(budgetId, _key, status) {
      lastStatusByBudget.set(budgetId, status);
    },
    getLastStatus(budgetId) {
      return lastStatusByBudget.get(budgetId) ?? null;
    },
  };
  const deps = {
    getRegistry: () => registry,
    currentAuthMode: () => 'open',
    rollup: async () => ({ asOf: { ledgerSeq: 1 }, coverage: { complete: true } }),
    iterateLedgerRows: async function* iterateLedgerRows() {
      for (const row of ledgerRows) yield row;
    },
    now,
  };
  return { deps, registry };
}

function usageRow(overrides = {}) {
  return {
    eventType: 'llm.usage',
    receivedAt: 1000,
    agentId: null,
    sessionId: null,
    model: null,
    userId: null,
    tags: [],
    cost: null,
    currency: null,
    costSource: 'unknown',
    estimatedCostNano: null,
    estimatedCurrency: null,
    pricingVersion: null,
    estimateStatus: null,
    ...overrides,
  };
}

test('evaluateBudgetLive: a disabled budget never produces a transition and is not persisted', async () => {
  const { deps, registry } = makeStubDeps();
  const budget = budgetFixture({ enabled: false });
  const { view, transition } = await evaluateBudgetLive(budget, deps, 'ledger_event');
  assert.equal(view.status, null);
  assert.equal(transition, null);
  assert.equal(registry.getLastStatus(budget.id), null);
});

test('evaluateBudgetLive: the first-ever check establishes a baseline, never a transition', async () => {
  const { deps, registry } = makeStubDeps({ ledgerRows: [] });
  const budget = budgetFixture();
  const { view, transition } = await evaluateBudgetLive(budget, deps, 'ledger_event');
  assert.equal(view.status.state, 'ok');
  assert.equal(transition, null, 'nothing to diff against on the first check');
  assert.deepEqual(registry.getLastStatus(budget.id), view.status, 'the fresh status is persisted as the baseline');
});

test('evaluateBudgetLive: a second check that crosses into warning reports the transition and re-persists', async () => {
  const budget = budgetFixture({ limit: 10, warningRatio: 0.5 });
  const { deps, registry } = makeStubDeps({ ledgerRows: [] });

  const first = await evaluateBudgetLive(budget, deps, 'ledger_event');
  assert.equal(first.transition, null);
  assert.equal(first.view.status.state, 'ok');

  // A second check, now with a real spend crossing the warning threshold (5 = limit * warningRatio).
  deps.iterateLedgerRows = async function* iterateLedgerRows() {
    yield usageRow({ cost: 6, currency: 'USD', costSource: 'provider-reported' });
  };
  const second = await evaluateBudgetLive(budget, deps, 'ledger_event');
  assert.equal(second.view.status.state, 'warning');
  assert.ok(second.transition, 'the state changed, so a transition must be reported');
  assert.equal(second.transition.from, 'ok');
  assert.equal(second.transition.to, 'warning');
  assert.equal(second.transition.direction, 'up');
  assert.equal(second.transition.threshold, 0.5);
  assert.equal(second.transition.trigger, 'ledger_event');
  assert.deepEqual(registry.getLastStatus(budget.id), second.view.status);
});

test('evaluateBudgetLive: two checks with no state change never report a transition', async () => {
  const budget = budgetFixture();
  const { deps } = makeStubDeps({ ledgerRows: [] });
  await evaluateBudgetLive(budget, deps, 'ledger_event');
  const second = await evaluateBudgetLive(budget, deps, 'ledger_event');
  assert.equal(second.transition, null);
});

// -------------------------------------------------------------
// onBudgetTransition / emitBudgetTransition
// -------------------------------------------------------------

test('onBudgetTransition: every registered listener is called, in order, with the transition', () => {
  const received = [];
  const unsubscribe1 = onBudgetTransition((t) => received.push(['first', t]));
  const unsubscribe2 = onBudgetTransition((t) => received.push(['second', t]));
  try {
    const transition = { budgetId: 'bud_x', from: 'ok', to: 'warning' };
    emitBudgetTransition(transition);
    assert.deepEqual(received, [
      ['first', transition],
      ['second', transition],
    ]);
  } finally {
    unsubscribe1();
    unsubscribe2();
  }
});

test('onBudgetTransition: unsubscribing stops further delivery', () => {
  const received = [];
  const unsubscribe = onBudgetTransition((t) => received.push(t));
  unsubscribe();
  emitBudgetTransition({ budgetId: 'bud_y' });
  assert.deepEqual(received, []);
});

test('onBudgetTransition: a throwing listener never stops another listener from being called', () => {
  const received = [];
  const unsubscribe1 = onBudgetTransition(() => {
    throw new Error('boom');
  });
  const unsubscribe2 = onBudgetTransition((t) => received.push(t));
  try {
    const transition = { budgetId: 'bud_z' };
    assert.doesNotThrow(() => emitBudgetTransition(transition));
    assert.deepEqual(received, [transition]);
  } finally {
    unsubscribe1();
    unsubscribe2();
  }
});

test('onBudgetTransition: a listener returning a rejected promise never surfaces as an unhandled rejection', async () => {
  const unsubscribe = onBudgetTransition(async () => {
    throw new Error('async boom');
  });
  try {
    emitBudgetTransition({ budgetId: 'bud_w' });
    // Give the rejected promise's `.catch(() => {})` a turn to run before the test (and the process) moves on.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    unsubscribe();
  }
});

// -------------------------------------------------------------
// startBudgetRolloverWatcher
// -------------------------------------------------------------

function makeRolloverRegistry(budgets, lastStatusByBudget) {
  return {
    create() { throw new Error('not used'); },
    update() { return null; },
    delete() { return false; },
    get() { return null; },
    list: () => budgets,
    listRevisions: () => [],
    getCachedStatus: () => null,
    setCachedStatus: () => {},
    getLastStatus: (id) => lastStatusByBudget.get(id) ?? null,
  };
}

test('startBudgetRolloverWatcher: runOnce checks only enabled budgets whose window rolled over', async () => {
  // Real 'day'/'UTC' windows (not hand-picked numbers): "today" and "yesterday", so `bud_rolled_over`'s stored
  // window genuinely belongs to the day before the one `now` falls in.
  const now = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15 noon UTC
  const todayWindow = computeBudgetWindow('day', 'UTC', now);
  const yesterdayWindow = computeBudgetWindow('day', 'UTC', now - 24 * 60 * 60 * 1000);

  const budgets = [
    budgetFixture({ id: 'bud_never_checked', enabled: true, period: 'day' }),
    budgetFixture({ id: 'bud_same_window', enabled: true, period: 'day' }),
    budgetFixture({ id: 'bud_rolled_over', enabled: true, period: 'day' }),
    budgetFixture({ id: 'bud_disabled', enabled: false, period: 'day' }),
  ];
  const lastStatusByBudget = new Map([
    ['bud_same_window', statusFixture({ window: todayWindow })],
    ['bud_rolled_over', statusFixture({ window: yesterdayWindow })],
  ]);
  const registry = makeRolloverRegistry(budgets, lastStatusByBudget);

  const checked = [];
  const watcher = startBudgetRolloverWatcher({
    getRegistry: () => registry,
    check: async (budget, trigger) => {
      checked.push({ id: budget.id, trigger });
    },
    now: () => now,
    intervalMs: 3_600_000, // long enough that the real timer never fires during this test
  });

  try {
    await watcher.runOnce();
    const checkedIds = checked.map((entry) => entry.id).sort();
    assert.deepEqual(checkedIds, ['bud_never_checked', 'bud_rolled_over']);
    assert.ok(checked.every((entry) => entry.trigger === 'window_rollover'));
  } finally {
    watcher.stop();
  }
});

test('startBudgetRolloverWatcher: one budget\'s check failing never stops the sweep for the rest', async () => {
  const budgets = [budgetFixture({ id: 'bud_fails' }), budgetFixture({ id: 'bud_ok' })];
  const registry = makeRolloverRegistry(budgets, new Map());
  const checked = [];
  const watcher = startBudgetRolloverWatcher({
    getRegistry: () => registry,
    check: async (budget) => {
      if (budget.id === 'bud_fails') throw new Error('boom');
      checked.push(budget.id);
    },
    now: () => 1000,
    intervalMs: 3_600_000,
  });

  try {
    await assert.doesNotReject(() => watcher.runOnce());
    assert.deepEqual(checked, ['bud_ok']);
  } finally {
    watcher.stop();
  }
});

test('startBudgetRolloverWatcher: stop() is safe to call more than once', () => {
  const registry = makeRolloverRegistry([], new Map());
  const watcher = startBudgetRolloverWatcher({
    getRegistry: () => registry,
    check: async () => {},
    intervalMs: 3_600_000,
  });
  watcher.stop();
  assert.doesNotThrow(() => watcher.stop());
});
