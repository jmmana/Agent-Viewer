// Issue #86, sub-issue #319: the `budget.alert` canonical event, crossing detection, deduplication and storage.
// #86's original draft assumed a `BudgetEvaluation`/`onBudgetsEvaluated` hook with an arbitrary `thresholds:
// number[]` array; the engine that actually shipped (#85, sub-issue #305) instead reports one concrete state
// change at a time through `onBudgetTransition(BudgetTransition)`. These tests exercise the real shape: a handful
// of pure `buildBudgetAlert` cases against hand-built `BudgetTransition` fixtures (including the exact
// two-concurrent-live-checks race `onBudgetTransition`'s own doc comment in `server/budgets.ts` calls out), plus a
// couple of end-to-end cases against the real `app` and a real ledger crossing (pattern from
// `tests/budgets-sse.test.mjs`).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { app } from '../server/index.ts';
import { emitBudgetTransition } from '../server/budgets.ts';
import { buildBudgetAlert, budgetAlertEventId } from '../server/budgetAlerts.ts';

function uniqueId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** A fixture `BudgetStatus`, shaped exactly like `server/budgets.ts`'s own interface, with every field honest: an
 * unknown or other-currency call is never folded into `knownSpent`. */
function statusFixture(state, { window, knownSpent = 0, limit, calls = {}, pricingVersions = [], evaluatedAt = Date.now() }) {
  const fullCalls = {
    total: 0,
    withCost: 0,
    unknownCost: 0,
    otherCurrency: 0,
    missingCurrency: 0,
    ...calls,
  };
  const spent = state === 'unknown' ? null : knownSpent;
  return {
    state,
    window,
    spent,
    spentComplete: state !== 'unknown',
    knownSpent,
    breakdown: { reported: knownSpent, estimated: 0 },
    containsEstimates: false,
    limitRemaining: spent === null ? null : limit - spent,
    ratio: spent === null ? null : spent / limit,
    calls: fullCalls,
    unknownReasons: state === 'unknown' ? ['unknown_cost_rows'] : [],
    pricingVersions,
    evaluatedAt,
  };
}

/** A fixture `BudgetTransition`, built from two `statusFixture` states. Every field name matches
 * `server/budgets.ts`'s real `BudgetTransition` interface. */
function transitionFixture({
  budgetId = uniqueId('bud'),
  budgetName = 'Fixture budget',
  scope = { type: 'all', value: null },
  period = 'month',
  timezone = 'UTC',
  currency = 'USD',
  limit = 100,
  warningRatio = 0.8,
  from = 'ok',
  to = 'warning',
  threshold = null,
  window,
  previousStatus,
  status,
  trigger = 'ledger_event',
  detectedAt = Date.now(),
} = {}) {
  const resolvedThreshold = threshold ?? (to === 'exceeded' ? 1 : to === 'warning' ? warningRatio : null);
  const resolvedWindow = window ?? { start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 1, 1) };
  const resolvedPrevious = previousStatus ?? statusFixture(from, { window: resolvedWindow, knownSpent: 0, limit });
  const resolvedStatus =
    status ?? statusFixture(to, { window: resolvedWindow, knownSpent: Math.round(limit * (resolvedThreshold ?? 0.9)), limit });
  return {
    schemaVersion: '1.0',
    budgetId,
    budgetName,
    scope,
    period,
    timezone,
    currency,
    limit,
    warningRatio,
    from,
    to,
    direction: 'up',
    threshold: resolvedThreshold,
    window: resolvedWindow,
    status: resolvedStatus,
    previousStatus: resolvedPrevious,
    trigger,
    detectedAt,
  };
}

async function getBudgetAlerts(baseUrl, budgetId) {
  const res = await fetch(`${baseUrl}/api/v1/events?type=budget.alert&limit=500`);
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.events.filter((e) => e.payload.budgetId === budgetId);
}

// -------------------------------------------------------------
// Pure `buildBudgetAlert` behavior (no server, no storage)
// -------------------------------------------------------------

test('buildBudgetAlert: ignores a transition landing on "ok" or "unknown" (never an alert)', () => {
  assert.equal(buildBudgetAlert(transitionFixture({ from: 'warning', to: 'ok' })), null);
  assert.equal(buildBudgetAlert(transitionFixture({ from: 'ok', to: 'unknown' })), null);
});

test('buildBudgetAlert: "warning" and "exceeded" each produce a deterministic evt_budget_ id and the right severity', () => {
  const budgetId = uniqueId('bud');
  const window = { start: 1000, end: 2000 };

  const warning = buildBudgetAlert(transitionFixture({ budgetId, to: 'warning', warningRatio: 0.5, window }));
  assert.ok(warning);
  assert.match(warning.event.id, /^evt_budget_[0-9a-f]{32}$/);
  assert.equal(warning.event.id, budgetAlertEventId(budgetId, 'warning', window.start));
  assert.equal(warning.event.type, 'budget.alert');
  assert.equal(warning.event.severity, 'high');
  assert.equal(warning.alert.threshold, 0.5);
  assert.equal(warning.event.payload.state, 'warning');

  const exceeded = buildBudgetAlert(transitionFixture({ budgetId, to: 'exceeded', window }));
  assert.ok(exceeded);
  assert.equal(exceeded.event.severity, 'critical');
  assert.equal(exceeded.alert.threshold, 1);
  // Same budgetId and window.start but a different state: a different id (the dedup key includes `state`).
  assert.notEqual(exceeded.event.id, warning.event.id);
});

test('buildBudgetAlert: honest about an unknown-cost/other-currency call, never zero-fills knownSpent', () => {
  const window = { start: 5000, end: 6000 };
  const status = statusFixture('exceeded', {
    window,
    knownSpent: 120,
    limit: 100,
    calls: { total: 5, withCost: 3, unknownCost: 1, otherCurrency: 1, missingCurrency: 0 },
  });
  const built = buildBudgetAlert(
    transitionFixture({ to: 'exceeded', window, status, limit: 100 })
  );
  assert.ok(built);
  assert.equal(built.alert.knownSpent, 120);
  assert.equal(built.event.payload.knownSpent, 120);
  assert.equal(built.event.payload.spendIsLowerBound, true);
  assert.deepEqual(built.event.payload.calls, { total: 5, withCost: 3, unknownCost: 1, otherCurrency: 1, missingCurrency: 0 });
});

test('buildBudgetAlert: "warning" with no unknown/other-currency calls is never a lower bound', () => {
  const window = { start: 7000, end: 8000 };
  const status = statusFixture('warning', {
    window,
    knownSpent: 60,
    limit: 100,
    calls: { total: 2, withCost: 2, unknownCost: 0, otherCurrency: 0, missingCurrency: 0 },
  });
  const built = buildBudgetAlert(transitionFixture({ to: 'warning', window, status, limit: 100, warningRatio: 0.5 }));
  assert.equal(built.event.payload.spendIsLowerBound, false);
});

test('buildBudgetAlert: backfill true exactly when the period already closed by detectedAt', () => {
  const closedWindow = { start: 1000, end: 2000 };
  const closed = buildBudgetAlert(transitionFixture({ to: 'warning', window: closedWindow, detectedAt: 2000 }));
  assert.equal(closed.alert.backfill, true);
  assert.equal(closed.event.payload.backfill, true);

  const openWindow = { start: 1000, end: 9_999_999_999_999 };
  const open = buildBudgetAlert(transitionFixture({ to: 'warning', window: openWindow, detectedAt: 2000 }));
  assert.equal(open.alert.backfill, false);
  assert.equal(open.event.payload.backfill, false);
});

// -------------------------------------------------------------
// Storage and dedup, end to end against the real app (in-memory store)
// -------------------------------------------------------------

test('recordBudgetAlert: 50 concurrent identical transitions produce exactly one stored+broadcast alert', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const budgetId = uniqueId('bud');
    const window = { start: 10_000, end: 20_000 };
    const transition = transitionFixture({ budgetId, to: 'warning', window, warningRatio: 0.5 });

    // Mirrors the exact race `onBudgetTransition`'s own doc comment names: two (here, many) concurrent live checks
    // for the same budget can each see the same `previousStatus` and both call `emitBudgetTransition` with what is
    // semantically the same crossing. `recordBudgetAlert`'s dedup, not the engine, must collapse this to one.
    await Promise.all(Array.from({ length: 50 }, () => emitBudgetTransition(transition)));
    // `emitBudgetTransition` calls listeners fire-and-forget (never awaited); give the async `onBudgetTransition`
    // listener in `server/index.ts` a chance to finish its `store.recordBudgetAlert` + `broadcastEvent` work.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const alerts = await getBudgetAlerts(baseUrl, budgetId);
    assert.equal(alerts.length, 1, `expected exactly one alert, got ${alerts.length}`);
    assert.equal(alerts[0].id, budgetAlertEventId(budgetId, 'warning', window.start));
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('recordBudgetAlert: a new period re-arms the same state; raising/lowering the limit mid-period does not refire it', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const budgetId = uniqueId('bud');
    const windowA = { start: 30_000, end: 40_000 };
    const windowB = { start: 40_000, end: 50_000 };

    await emitBudgetTransition(transitionFixture({ budgetId, to: 'warning', window: windowA, warningRatio: 0.5 }));
    // Same period, same state, but a different threshold (as if the limit changed and was changed back): must
    // not produce a second alert, since the dedup key is (budgetId, state, window.start), never the threshold.
    await emitBudgetTransition(transitionFixture({ budgetId, to: 'warning', window: windowA, warningRatio: 0.3 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterSamePeriod = await getBudgetAlerts(baseUrl, budgetId);
    assert.equal(afterSamePeriod.length, 1, 'the same period must never alert twice for the same state');

    // A new period (different window.start): re-arms "warning".
    await emitBudgetTransition(transitionFixture({ budgetId, to: 'warning', window: windowB, warningRatio: 0.5 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterNewPeriod = await getBudgetAlerts(baseUrl, budgetId);
    assert.equal(afterNewPeriod.length, 2, 'a new period must be able to alert again');
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('end to end: a real spend crossing warning then exceeded stores and broadcasts two budget.alert events', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const agentId = uniqueId('agent');
    const budgetRes = await fetch(`${baseUrl}/api/v1/budgets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alert test budget',
        scope: { type: 'agent', value: agentId },
        period: 'month',
        currency: 'USD',
        basis: 'reported',
        limit: 10,
        warningRatio: 0.5,
      }),
    });
    assert.equal(budgetRes.status, 201);
    const budget = await budgetRes.json();

    const stream = await fetch(`${baseUrl}/api/v1/events/stream`);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function readUntil(predicate, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(buffer)) {
        if (Date.now() > deadline) throw new Error(`Timed out. Buffer so far:\n${buffer}`);
        const { value, done } = await reader.read();
        if (done) throw new Error('Stream closed early');
        buffer += decoder.decode(value, { stream: true });
      }
    }
    await readUntil((buf) => buf.includes('connected'));

    async function postUsage(cost) {
      const res = await fetch(`${baseUrl}/api/v1/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: uniqueId('evt'),
          type: 'llm.usage',
          timestamp: Date.now(),
          source: `agent:${agentId}`,
          agentId,
          summary: 'budget alert e2e test',
          payload: { provider: 'OpenAI', model: 'gpt-4.1', inputTokens: 1, outputTokens: 1, cost, currency: 'USD', costSource: 'provider-reported' },
        }),
      });
      assert.equal(res.status, 202);
    }

    // First call is this budget's very first live check: it only establishes the "ok" baseline (no
    // `previousStatus` to diff against yet, see `evaluateBudgetLive`), so it must not itself produce an alert.
    await postUsage(2);
    await readUntil((buf) => buf.includes('"llm.usage"'));
    await postUsage(4); // total 6, crosses warning (limit 10 * 0.5 = 5)
    await readUntil((buf) => buf.includes('"budget.alert"') && buf.includes('"state":"warning"'));
    await postUsage(5); // total 11, crosses exceeded
    await readUntil((buf) => buf.includes('"budget.alert"') && buf.includes('"state":"exceeded"'));
    await reader.cancel();

    // Both alerts carry their own "id: evt_budget_..." line (stored canonical events, unlike the live "event:
    // budget" transition frame, which deliberately has none).
    const alertIdMatches = [...buffer.matchAll(/id: (evt_budget_[0-9a-f]{32})\n/g)].map((m) => m[1]);
    assert.equal(alertIdMatches.length, 2, `expected two stored budget.alert ids in the stream:\n${buffer}`);

    const alerts = await getBudgetAlerts(baseUrl, budget.id);
    assert.equal(alerts.length, 2);
    const warning = alerts.find((e) => e.payload.state === 'warning');
    const exceeded = alerts.find((e) => e.payload.state === 'exceeded');
    assert.ok(warning && exceeded);
    assert.equal(warning.payload.threshold, 0.5);
    assert.equal(warning.severity, 'high');
    assert.equal(exceeded.payload.threshold, 1);
    assert.equal(exceeded.severity, 'critical');
    assert.equal(exceeded.payload.knownSpent, 11);
    assert.equal(exceeded.payload.currency, 'USD');
    assert.equal(exceeded.payload.spendIsLowerBound, false);
    assert.equal(exceeded.source, 'server:budgets');
    assert.equal(exceeded.agentId, agentId);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('end to end: the stored budget.alert replays on reconnect via Last-Event-ID', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const agentId = uniqueId('agent');
    const budgetRes = await fetch(`${baseUrl}/api/v1/budgets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Replay test budget',
        scope: { type: 'agent', value: agentId },
        period: 'month',
        currency: 'USD',
        basis: 'reported',
        limit: 10,
        warningRatio: 0.5,
      }),
    });
    assert.equal(budgetRes.status, 201);

    const first = await fetch(`${baseUrl}/api/v1/events/stream`);
    const firstReader = first.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    async function readUntil(reader, predicate, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(buffer)) {
        if (Date.now() > deadline) throw new Error(`Timed out. Buffer so far:\n${buffer}`);
        const { value, done } = await reader.read();
        if (done) throw new Error('Stream closed early');
        buffer += decoder.decode(value, { stream: true });
      }
    }
    await readUntil(firstReader, (buf) => buf.includes('connected'));

    const baselineRes = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: uniqueId('evt'),
        type: 'llm.usage',
        timestamp: Date.now(),
        source: `agent:${agentId}`,
        agentId,
        summary: 'baseline',
        payload: { provider: 'OpenAI', model: 'gpt-4.1', inputTokens: 1, outputTokens: 1, cost: 2, currency: 'USD', costSource: 'provider-reported' },
      }),
    });
    assert.equal(baselineRes.status, 202);
    await readUntil(firstReader, (buf) => buf.includes('"llm.usage"'));
    const lastEventIdMatch = buffer.match(/id: (evt_\S+)\n/);
    assert.ok(lastEventIdMatch);
    const lastEventId = lastEventIdMatch[1];

    const crossingRes = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: uniqueId('evt'),
        type: 'llm.usage',
        timestamp: Date.now(),
        source: `agent:${agentId}`,
        agentId,
        summary: 'crossing',
        payload: { provider: 'OpenAI', model: 'gpt-4.1', inputTokens: 1, outputTokens: 1, cost: 4, currency: 'USD', costSource: 'provider-reported' },
      }),
    });
    assert.equal(crossingRes.status, 202);
    await readUntil(firstReader, (buf) => buf.includes('"budget.alert"'));
    await firstReader.cancel();

    const reconnect = await fetch(`${baseUrl}/api/v1/events/stream?lastEventId=${lastEventId}`);
    assert.equal(reconnect.status, 200);
    const reconnectReader = reconnect.body.getReader();
    let replay = '';
    const deadline = Date.now() + 2000;
    while (!replay.includes('connected')) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for replay:\n${replay}`);
      const { value, done } = await reconnectReader.read();
      if (done) throw new Error('Reconnect stream closed early');
      replay += decoder.decode(value, { stream: true });
    }
    assert.ok(replay.includes('"budget.alert"'), `expected the replayed gap to include the stored budget.alert:\n${replay}`);
    await reconnectReader.cancel();
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

// -------------------------------------------------------------
// Reserved type/id guard on the two client-facing ingest endpoints
// -------------------------------------------------------------

test('POST /api/v1/events rejects a client-submitted type: "budget.alert"', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: uniqueId('evt'),
        type: 'budget.alert',
        timestamp: Date.now(),
        source: 'forger',
        summary: 'forged alert',
        payload: {},
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'reserved_event_type');
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('POST /api/v1/events rejects a client-submitted id starting evt_budget_, including via Idempotency-Key', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const forgedId = 'evt_budget_' + 'a'.repeat(32);
    const res = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': forgedId },
      body: JSON.stringify({
        type: 'agent.status.changed',
        timestamp: Date.now(),
        source: 'forger',
        summary: 'id squat attempt',
        payload: {},
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'reserved_event_type');
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('POST /api/v1/events/batch rejects a reserved item with all-or-nothing semantics', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const goodId = uniqueId('evt');
    const res = await fetch(`${baseUrl}/api/v1/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        // `runtime.heartbeat`'s payload schema has no required field, so an empty payload validates cleanly: the
        // point of this item is only to prove it is never stored once the batch is rejected.
        { id: goodId, type: 'runtime.heartbeat', timestamp: Date.now(), source: 'test', summary: 'ok', payload: {} },
        { id: uniqueId('evt'), type: 'budget.alert', timestamp: Date.now(), source: 'forger', summary: 'forged', payload: {} },
      ]),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'validation_failed');
    assert.equal(body.errors.length, 1);
    assert.equal(body.errors[0].index, 1);
    assert.equal(body.errors[0].issues[0].path, 'type');

    // All-or-nothing: the good item must not have been stored either.
    const lookup = await fetch(`${baseUrl}/api/v1/events?type=runtime.heartbeat&limit=500`);
    const lookupBody = await lookup.json();
    assert.ok(!lookupBody.events.some((e) => e.id === goodId), 'the batch must append nothing when any item is reserved');
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
