// Issue #86, sub-issue #322: `GET /api/v1/budget-alerts[?budgetId=&since=&limit=]` and
// `GET /api/v1/budget-alerts/:alertId`, the read-only API over the `budget_alerts` table #319 already fills
// (`server/budgetAlerts.ts`/`server/store.ts`).
//
// This was written before it was certain whether #321 (the signed outbound webhook and its own
// `budget_alert_deliveries` migration, #86's other sub-issue this one can land before or after) would merge
// first: `EventStore.getBudgetAlertDeliveries` is still defensive (a `sqlite_master` table-existence check,
// never a hardcoded flag), falling back to `PENDING_BUDGET_ALERT_DELIVERY` for any id it cannot resolve. In
// practice #321 merged first, so every alert the shared `app` records now carries a real delivery row end to
// end; the tests below exercise that real path. The defensive fallback itself (missing table, or a store with
// genuinely no delivery row for an id) is still covered directly: once against a throwaway SQLite file built
// with only migrations 1-15 (no `budget_alert_deliveries` table at all), and once through a stubbed
// `registerBudgetAlertsRoutes` app that controls `deps` directly, independent of either storage mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { app } from '../server/index.ts';
import { buildBudgetAlert, parseBudgetAlertsQuery, registerBudgetAlertsRoutes, PENDING_BUDGET_ALERT_DELIVERY } from '../server/budgetAlerts.ts';
import { SQLiteEventStore } from '../server/store.ts';
import { MIGRATIONS } from '../server/db/migrations.ts';

const TOKEN = 'test-budget-alerts-admin-token';

function uniqueId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function startHttpServer(expressApp) {
  return new Promise((resolve) => {
    const server = http.createServer(expressApp);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function auth(token = TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

async function withAlertsServer(fn) {
  return withEnv({ AGENT_VIEWER_API_TOKEN: TOKEN, AGENT_VIEWER_API_KEY: undefined }, async () => {
    const { server, baseUrl } = await startHttpServer(app);
    try {
      return await fn(baseUrl);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
}

async function postUsageEvent(baseUrl, agentId, cost) {
  const res = await fetch(`${baseUrl}/api/v1/events`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: uniqueId('evt'),
      type: 'llm.usage',
      timestamp: Date.now(),
      source: `agent:${agentId}`,
      agentId,
      summary: 'budget alerts api test',
      payload: { provider: 'OpenAI', model: 'gpt-4.1', inputTokens: 1, outputTokens: 1, cost, currency: 'USD', costSource: 'provider-reported' },
    }),
  });
  assert.equal(res.status, 202);
}

/** Creates a budget (limit 10, warningRatio 0.5) and drives real `llm.usage` spend through it so the real engine
 * (not a hand-built fixture) produces exactly one `warning` and one `exceeded` `budget_alerts` row, end to end,
 * the same path `tests/budget-alerts.test.mjs`'s own end-to-end case uses. Polls the new read API itself to wait
 * for the fire-and-forget `onBudgetTransition` listener, instead of a fixed `setTimeout`. No webhook URL is
 * configured anywhere in this process, so every real delivery row #321 writes for these alerts is `skipped`
 * (never attempted), not `pending`: that is the honest, real status here, not this file's own placeholder. */
async function createCrossingAlerts(baseUrl) {
  const agentId = uniqueId('agent');
  const budgetRes = await fetch(`${baseUrl}/api/v1/budgets`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Alerts API test budget',
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

  await postUsageEvent(baseUrl, agentId, 2); // baseline, no transition
  await postUsageEvent(baseUrl, agentId, 4); // total 6, crosses warning (limit 10 * 0.5 = 5)
  await postUsageEvent(baseUrl, agentId, 5); // total 11, crosses exceeded

  const deadline = Date.now() + 2000;
  for (;;) {
    const res = await fetch(`${baseUrl}/api/v1/budget-alerts?budgetId=${budget.id}`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    if (body.alerts.length >= 2) return { budget, agentId, body };
    if (Date.now() > deadline) throw new Error(`Timed out waiting for both alerts; got ${JSON.stringify(body)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// -------------------------------------------------------------
// Auth
// -------------------------------------------------------------

test('GET /api/v1/budget-alerts honors the shared /api/v1 Bearer token check', async () => {
  await withAlertsServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/budget-alerts`);
    assert.equal(res.status, 401);
  });
});

test('GET /api/v1/budget-alerts/:alertId honors the shared /api/v1 Bearer token check', async () => {
  await withAlertsServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/budget-alerts/${uniqueId('evt_budget')}`);
    assert.equal(res.status, 401);
  });
});

// -------------------------------------------------------------
// Query validation
// -------------------------------------------------------------

test('GET /api/v1/budget-alerts: non-numeric since/limit are 400 validation_failed', async () => {
  await withAlertsServer(async (baseUrl) => {
    const badSince = await fetch(`${baseUrl}/api/v1/budget-alerts?since=not-a-number`, { headers: auth() });
    assert.equal(badSince.status, 400);
    assert.equal((await badSince.json()).error, 'validation_failed');

    const badLimit = await fetch(`${baseUrl}/api/v1/budget-alerts?limit=lots`, { headers: auth() });
    assert.equal(badLimit.status, 400);
    assert.equal((await badLimit.json()).error, 'validation_failed');

    const negativeLimit = await fetch(`${baseUrl}/api/v1/budget-alerts?limit=-1`, { headers: auth() });
    assert.equal(negativeLimit.status, 400);
  });
});

test('GET /api/v1/budget-alerts: a valid since/limit/budgetId is accepted (200), even with no matching alerts', async () => {
  await withAlertsServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/budget-alerts?since=0&limit=10&budgetId=${uniqueId('bud')}`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.alerts, []);
    assert.equal(body.count, 0);
  });
});

test('parseBudgetAlertsQuery: defaults limit to 100, caps at 500, rejects non-numeric values', () => {
  const defaulted = parseBudgetAlertsQuery({});
  assert.equal(defaulted.ok, true);
  assert.equal(defaulted.value.limit, 100);
  assert.equal(defaulted.value.budgetId, undefined);
  assert.equal(defaulted.value.since, undefined);

  const capped = parseBudgetAlertsQuery({ limit: '10000' });
  assert.equal(capped.ok, true);
  assert.equal(capped.value.limit, 500);

  const withBudgetAndSince = parseBudgetAlertsQuery({ budgetId: 'bud_1', since: '12345' });
  assert.equal(withBudgetAndSince.ok, true);
  assert.equal(withBudgetAndSince.value.budgetId, 'bud_1');
  assert.equal(withBudgetAndSince.value.since, 12345);

  assert.equal(parseBudgetAlertsQuery({ since: 'abc' }).ok, false);
  assert.equal(parseBudgetAlertsQuery({ limit: 'abc' }).ok, false);
  assert.equal(parseBudgetAlertsQuery({ limit: '0' }).ok, false);
});

// -------------------------------------------------------------
// Listing, single-alert read, 404, and the real delivery/webhook shape
// -------------------------------------------------------------

test('GET /api/v1/budget-alerts: newest first by detectedAt, real delivery embedded, webhook summary shape', async () => {
  await withAlertsServer(async (baseUrl) => {
    const { budget, body } = await createCrossingAlerts(baseUrl);
    const scoped = body.alerts.filter((a) => a.budgetId === budget.id);
    assert.equal(scoped.length, 2);
    // Newest first: exceeded was detected after warning.
    assert.ok(scoped[0].detectedAt >= scoped[1].detectedAt);
    const states = scoped.map((a) => a.state).sort();
    assert.deepEqual(states, ['exceeded', 'warning']);

    // No AGENT_VIEWER_ALERT_WEBHOOK_URL configured anywhere in this process, so #321's own `recordBudgetAlert`
    // wrote every delivery row `skipped` (never attempted), and the webhook summary is honestly unconfigured.
    for (const alert of scoped) {
      assert.deepEqual(alert.delivery, { status: 'skipped', attempts: 0, lastStatus: null, deliveredAt: null });
    }
    assert.deepEqual(body.webhook, { configured: false, signed: false });
  });
});

test('GET /api/v1/budget-alerts/:alertId: returns one alert with the same shape, or 404 not_found for an unknown id', async () => {
  await withAlertsServer(async (baseUrl) => {
    const { body } = await createCrossingAlerts(baseUrl);
    const alert = body.alerts[0];

    const res = await fetch(`${baseUrl}/api/v1/budget-alerts/${alert.id}`, { headers: auth() });
    assert.equal(res.status, 200);
    const single = await res.json();
    assert.equal(single.id, alert.id);
    assert.deepEqual(single.delivery, alert.delivery);

    const missing = await fetch(`${baseUrl}/api/v1/budget-alerts/${uniqueId('evt_budget')}`, { headers: auth() });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'not_found' });
  });
});

test('GET /api/v1/budget-alerts: since filters by detectedAt, limit truncates the page', async () => {
  await withAlertsServer(async (baseUrl) => {
    const { budget, body } = await createCrossingAlerts(baseUrl);
    const scoped = body.alerts.filter((a) => a.budgetId === budget.id).sort((a, b) => a.detectedAt - b.detectedAt);
    const [earlier, later] = scoped;

    const sinceRes = await fetch(`${baseUrl}/api/v1/budget-alerts?budgetId=${budget.id}&since=${later.detectedAt}`, { headers: auth() });
    const sinceBody = await sinceRes.json();
    assert.ok(sinceBody.alerts.every((a) => a.detectedAt >= later.detectedAt));
    assert.ok(sinceBody.alerts.some((a) => a.id === later.id));
    assert.ok(!sinceBody.alerts.some((a) => a.id === earlier.id));

    const limitedRes = await fetch(`${baseUrl}/api/v1/budget-alerts?budgetId=${budget.id}&limit=1`, { headers: auth() });
    const limitedBody = await limitedRes.json();
    assert.equal(limitedBody.alerts.length, 1);
  });
});

// -------------------------------------------------------------
// The defensive fallback itself, isolated from whichever storage mode the shared `app` above happens to run
// under: a stubbed `registerBudgetAlertsRoutes` app where `deps` is fully controlled, so the "no known delivery
// state" branch and the webhook summary wiring are each exercised directly and deterministically.
// -------------------------------------------------------------

function fixtureAlertRow(overrides = {}) {
  return {
    id: uniqueId('evt_budget'),
    budgetId: uniqueId('bud'),
    budgetName: 'Stub budget',
    scopeType: 'all',
    scopeValue: null,
    periodType: 'month',
    periodStart: 1000,
    periodEnd: 2000,
    state: 'warning',
    threshold: 0.5,
    limit: 100,
    currency: 'USD',
    knownSpent: 60,
    spendIsLowerBound: false,
    backfill: false,
    detectedAt: 1500,
    ...overrides,
  };
}

async function startStubAlertsServer(deps) {
  const stubApp = express();
  stubApp.use(express.json());
  registerBudgetAlertsRoutes(stubApp, deps);
  return startHttpServer(stubApp);
}

test('registerBudgetAlertsRoutes: falls back to PENDING_BUDGET_ALERT_DELIVERY when getBudgetAlertDeliveries has nothing for an id', async () => {
  const alert = fixtureAlertRow();
  const deps = {
    listBudgetAlerts: async () => [alert],
    getBudgetAlert: async (id) => (id === alert.id ? alert : null),
    getBudgetAlertDeliveries: async () => new Map(), // nothing known here: the defensive fallback branch
    webhookSummary: () => ({ configured: false, signed: false }),
  };
  const { server, baseUrl } = await startStubAlertsServer(deps);
  try {
    const listRes = await fetch(`${baseUrl}/api/v1/budget-alerts`);
    const listBody = await listRes.json();
    assert.deepEqual(listBody.alerts[0].delivery, PENDING_BUDGET_ALERT_DELIVERY);

    const singleRes = await fetch(`${baseUrl}/api/v1/budget-alerts/${alert.id}`);
    assert.deepEqual((await singleRes.json()).delivery, PENDING_BUDGET_ALERT_DELIVERY);
  } finally {
    server.close();
  }
});

test('registerBudgetAlertsRoutes: webhook summary is exactly deps.webhookSummary(), never the URL or secret', async () => {
  const alert = fixtureAlertRow();
  const deps = {
    listBudgetAlerts: async () => [alert],
    getBudgetAlert: async () => alert,
    getBudgetAlertDeliveries: async () => new Map(),
    webhookSummary: () => ({ configured: true, signed: true }),
  };
  const { server, baseUrl } = await startStubAlertsServer(deps);
  try {
    const res = await fetch(`${baseUrl}/api/v1/budget-alerts`);
    const rawText = await res.text();
    const body = JSON.parse(rawText);
    assert.deepEqual(body.webhook, { configured: true, signed: true });
    // Only `configured`/`signed`, nothing else: a URL or secret could only leak by this shape growing a new key.
    assert.deepEqual(Object.keys(body.webhook).sort(), ['configured', 'signed']);
  } finally {
    server.close();
  }
});

// -------------------------------------------------------------
// Store-level: real join against the real `budget_alert_deliveries` schema (migration 16), plus the defensive
// "table does not exist at all" branch against a throwaway store built with only migrations 1-15. Never the
// shared `store`, so these do not depend on which storage mode `npm test` happens to run the shared `app` in.
// -------------------------------------------------------------

function alertFixture({ budgetId, state = 'warning', window, detectedAt }) {
  return buildBudgetAlert({
    schemaVersion: '1.0',
    budgetId,
    budgetName: 'Store-level test budget',
    scope: { type: 'all', value: null },
    period: 'month',
    timezone: 'UTC',
    currency: 'USD',
    limit: 100,
    warningRatio: 0.5,
    from: 'ok',
    to: state,
    direction: 'up',
    threshold: state === 'exceeded' ? 1 : 0.5,
    window,
    status: {
      state,
      window,
      spent: 60,
      spentComplete: true,
      knownSpent: 60,
      breakdown: { reported: 60, estimated: 0 },
      containsEstimates: false,
      limitRemaining: 40,
      ratio: 0.6,
      calls: { total: 1, withCost: 1, unknownCost: 0, otherCurrency: 0, missingCurrency: 0 },
      unknownReasons: [],
      pricingVersions: [],
      evaluatedAt: detectedAt,
    },
    previousStatus: null,
    trigger: 'ledger_event',
    detectedAt,
  });
}

test('SQLiteEventStore.getBudgetAlertDeliveries: real join against migration 16, honest "absent" for an unrecorded id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-budget-alerts-api-'));
  const sqliteStore = new SQLiteEventStore(path.join(dir, 'test.db'));
  try {
    await sqliteStore.init();
    const budgetId = uniqueId('bud');
    const window = { start: 1_000_000, end: 2_000_000 };
    const pendingAlert = alertFixture({ budgetId, state: 'warning', window, detectedAt: 1_500_000 });
    const skippedAlert = alertFixture({ budgetId, state: 'exceeded', window, detectedAt: 1_600_000 });

    const recordedPending = await sqliteStore.recordBudgetAlert(pendingAlert, { attemptDelivery: true });
    assert.equal(recordedPending.inserted, true);
    const recordedSkipped = await sqliteStore.recordBudgetAlert(skippedAlert, { attemptDelivery: false });
    assert.equal(recordedSkipped.inserted, true);

    const deliveries = await sqliteStore.getBudgetAlertDeliveries([pendingAlert.alert.id, skippedAlert.alert.id]);
    assert.equal(deliveries.size, 2);
    assert.deepEqual(deliveries.get(pendingAlert.alert.id), { status: 'pending', attempts: 0, lastStatus: null, deliveredAt: null });
    assert.deepEqual(deliveries.get(skippedAlert.alert.id), { status: 'skipped', attempts: 0, lastStatus: null, deliveredAt: null });

    // An id that was never recorded at all has no delivery row (not even `skipped`): simply absent from the map,
    // never a fabricated "pending" row from the store itself; the honest placeholder is the HTTP layer's job.
    const neverRecordedId = uniqueId('evt_budget');
    const noRow = await sqliteStore.getBudgetAlertDeliveries([neverRecordedId]);
    assert.equal(noRow.size, 0);

    const single = await sqliteStore.getBudgetAlert(pendingAlert.alert.id);
    assert.ok(single);
    assert.equal(single.state, 'warning');
    assert.equal(await sqliteStore.getBudgetAlert(neverRecordedId), null);
  } finally {
    await sqliteStore.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLiteEventStore.getBudgetAlertDeliveries: empty map, never a thrown error, when budget_alert_deliveries does not exist at all', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-budget-alerts-api-no-table-'));
  // Only migrations 1-15 (no #321 migration 16 at all): simulates this sub-issue's own original "which merges
  // first" uncertainty directly, regardless of what actually landed in this repo's real migration history. #321's
  // own `recordBudgetAlert` now writes a `budget_alert_deliveries` row unconditionally, so a store missing that
  // table cannot record an alert at all any more (an accurate reflection of the merged reality, not a gap in this
  // test): this exercises `getBudgetAlertDeliveries` directly, on its own, the way a row-level lookup for an id
  // from a different process or an older snapshot could still reach it.
  const sqliteStore = new SQLiteEventStore(path.join(dir, 'test.db'), { migrations: MIGRATIONS.slice(0, 15) });
  try {
    await sqliteStore.init();
    const deliveries = await sqliteStore.getBudgetAlertDeliveries([uniqueId('evt_budget')]);
    assert.equal(deliveries.size, 0);
  } finally {
    await sqliteStore.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLiteEventStore.listBudgetAlerts: newest first, budgetId and since filters, limit applied', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-budget-alerts-api-list-'));
  const sqliteStore = new SQLiteEventStore(path.join(dir, 'test.db'));
  try {
    await sqliteStore.init();
    const budgetId = uniqueId('bud');
    const otherBudgetId = uniqueId('bud');
    const window = { start: 10_000_000, end: 20_000_000 };

    const first = alertFixture({ budgetId, state: 'warning', window, detectedAt: 10_500_000 });
    const second = alertFixture({ budgetId, state: 'exceeded', window, detectedAt: 10_600_000 });
    const third = alertFixture({ budgetId: otherBudgetId, state: 'warning', window, detectedAt: 10_700_000 });

    for (const built of [first, second, third]) {
      const result = await sqliteStore.recordBudgetAlert(built, { attemptDelivery: false });
      assert.equal(result.inserted, true);
    }

    const all = await sqliteStore.listBudgetAlerts({ limit: 10 });
    assert.equal(all.length, 3);
    assert.deepEqual(all.map((a) => a.id), [third.alert.id, second.alert.id, first.alert.id]);

    const scoped = await sqliteStore.listBudgetAlerts({ budgetId, limit: 10 });
    assert.equal(scoped.length, 2);
    assert.ok(scoped.every((a) => a.budgetId === budgetId));

    const since = await sqliteStore.listBudgetAlerts({ since: 10_600_000, limit: 10 });
    assert.deepEqual(since.map((a) => a.id), [third.alert.id, second.alert.id]);

    const limited = await sqliteStore.listBudgetAlerts({ limit: 1 });
    assert.deepEqual(limited.map((a) => a.id), [third.alert.id]);
  } finally {
    await sqliteStore.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
