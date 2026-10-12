// Issue #86, sub-issue #321: signed outbound webhook delivery for `budget.alert` events, with bounded retries.
// Config parsing, signing and retry math are pure and tested directly with no server or network at all (Sections
// A-D). The worker is tested two ways: against a fake in-memory store with a fake transport/clock for the exact
// retry matrix and dead-letter behavior (Section E), and against the real `MemoryEventStore` and a real local HTTP
// receiver, with only the worker's clock faked (so no test actually waits out a real backoff), for the atomic
// alert+delivery write and the "a hanging receiver never delays ingestion" guarantee (Section F).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  parseAlertWebhookConfig,
  signAlertDeliveryBody,
  attemptAlertDelivery,
  computeBackoffMs,
  startAlertDeliveryWorker,
  LAST_ERROR_MAX_LENGTH,
} from '../server/budgetAlertDelivery.ts';
import { MemoryEventStore } from '../server/store.ts';

function uniqueId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/** Polls `check` until it returns a truthy value or `timeoutMs` elapses, instead of a fixed `setTimeout` guess. */
async function waitFor(check, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function baseConfig(overrides = {}) {
  return { url: 'https://example.test/hook', secret: null, allowHttp: false, maxAttempts: 6, timeoutMs: 5000, ...overrides };
}

/** A minimal, valid `BudgetAlertStoreInput` (issue #86's `server/budgetAlerts.ts` shapes), built by hand so this
 * file never has to import the budgets engine fixtures from `tests/budget-alerts.test.mjs`. */
function alertInputFixture(overrides = {}) {
  const alertId = uniqueId('evt_budget');
  const detectedAt = Date.now();
  const alert = {
    id: alertId,
    budgetId: uniqueId('bud'),
    budgetName: 'Fixture budget',
    scopeType: 'all',
    scopeValue: null,
    periodType: 'month',
    periodStart: detectedAt - 1000,
    periodEnd: detectedAt + 1_000_000,
    state: 'warning',
    threshold: 0.8,
    limit: 100,
    currency: 'USD',
    knownSpent: 80,
    spendIsLowerBound: false,
    backfill: false,
    detectedAt,
    ...overrides.alert,
  };
  const event = {
    schemaVersion: '1.0',
    id: alertId,
    type: 'budget.alert',
    timestamp: detectedAt,
    source: 'server:budgets',
    severity: alert.state === 'exceeded' ? 'critical' : 'high',
    summary: `Budget "${alert.budgetName}" reached 80% of 100.00 USD`,
    payload: { alertId, budgetId: alert.budgetId, state: alert.state },
    ...overrides.event,
  };
  return { alert, event };
}

// -------------------------------------------------------------
// Section A: config parsing and validation at startup
// -------------------------------------------------------------

test('parseAlertWebhookConfig: unset or blank URL disables the feature (returns null)', () => {
  assert.equal(parseAlertWebhookConfig({}), null);
  assert.equal(parseAlertWebhookConfig({ AGENT_VIEWER_ALERT_WEBHOOK_URL: '' }), null);
  assert.equal(parseAlertWebhookConfig({ AGENT_VIEWER_ALERT_WEBHOOK_URL: '   ' }), null);
});

test('parseAlertWebhookConfig: applies documented defaults when only the URL is set', () => {
  const config = parseAlertWebhookConfig({ AGENT_VIEWER_ALERT_WEBHOOK_URL: 'https://hooks.example.com/aqa' });
  assert.deepEqual(config, {
    url: 'https://hooks.example.com/aqa',
    secret: null,
    allowHttp: false,
    maxAttempts: 6,
    timeoutMs: 5000,
  });
});

test('parseAlertWebhookConfig: an invalid URL fails fast without echoing the URL', () => {
  assert.throws(
    () => parseAlertWebhookConfig({ AGENT_VIEWER_ALERT_WEBHOOK_URL: 'not a url at all' }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /not a url at all/);
      return true;
    }
  );
});

test('parseAlertWebhookConfig: a non-http(s) scheme is refused', () => {
  assert.throws(() => parseAlertWebhookConfig({ AGENT_VIEWER_ALERT_WEBHOOK_URL: 'ftp://example.com/hook' }));
});

test('parseAlertWebhookConfig: embedded user:pass@ credentials are refused, message never echoes the URL', () => {
  assert.throws(
    () => parseAlertWebhookConfig({ AGENT_VIEWER_ALERT_WEBHOOK_URL: 'https://alice:secret@example.com/hook' }),
    (error) => {
      assert.doesNotMatch(error.message, /alice/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    }
  );
});

test('parseAlertWebhookConfig: plain http on a non-loopback host is refused unless ALLOW_HTTP=1', () => {
  assert.throws(() => parseAlertWebhookConfig({ AGENT_VIEWER_ALERT_WEBHOOK_URL: 'http://hooks.example.com/aqa' }));
  const allowed = parseAlertWebhookConfig({
    AGENT_VIEWER_ALERT_WEBHOOK_URL: 'http://hooks.example.com/aqa',
    AGENT_VIEWER_ALERT_WEBHOOK_ALLOW_HTTP: '1',
  });
  assert.equal(allowed.url, 'http://hooks.example.com/aqa');
});

test('parseAlertWebhookConfig: plain http on loopback is always allowed, no flag needed', () => {
  for (const host of ['http://127.0.0.1:9999/hook', 'http://localhost:9999/hook', 'http://[::1]:9999/hook']) {
    const config = parseAlertWebhookConfig({ AGENT_VIEWER_ALERT_WEBHOOK_URL: host });
    assert.equal(config.url, host);
  }
});

test('parseAlertWebhookConfig: https is never subject to the http allow-list check', () => {
  const config = parseAlertWebhookConfig({ AGENT_VIEWER_ALERT_WEBHOOK_URL: 'https://hooks.example.com/aqa' });
  assert.equal(config.allowHttp, false);
});

test('parseAlertWebhookConfig: MAX_ATTEMPTS and TIMEOUT_MS out of range refuse to start', () => {
  const url = 'https://hooks.example.com/aqa';
  for (const value of ['0', '21', '-1', 'abc', '3.5']) {
    assert.throws(
      () => parseAlertWebhookConfig({ AGENT_VIEWER_ALERT_WEBHOOK_URL: url, AGENT_VIEWER_ALERT_WEBHOOK_MAX_ATTEMPTS: value }),
      undefined,
      `MAX_ATTEMPTS=${value} should refuse to start`
    );
  }
  for (const value of ['499', '60001', 'abc']) {
    assert.throws(
      () => parseAlertWebhookConfig({ AGENT_VIEWER_ALERT_WEBHOOK_URL: url, AGENT_VIEWER_ALERT_WEBHOOK_TIMEOUT_MS: value }),
      undefined,
      `TIMEOUT_MS=${value} should refuse to start`
    );
  }
  const config = parseAlertWebhookConfig({
    AGENT_VIEWER_ALERT_WEBHOOK_URL: url,
    AGENT_VIEWER_ALERT_WEBHOOK_MAX_ATTEMPTS: '1',
    AGENT_VIEWER_ALERT_WEBHOOK_TIMEOUT_MS: '500',
  });
  assert.equal(config.maxAttempts, 1);
  assert.equal(config.timeoutMs, 500);
});

test('parseAlertWebhookConfig: the inbound AGENT_VIEWER_WEBHOOK_SECRET is never read as a fallback outbound secret', () => {
  const config = parseAlertWebhookConfig({
    AGENT_VIEWER_ALERT_WEBHOOK_URL: 'https://hooks.example.com/aqa',
    AGENT_VIEWER_WEBHOOK_SECRET: 'inbound-only-secret',
    // AGENT_VIEWER_ALERT_WEBHOOK_SECRET intentionally left unset.
  });
  assert.equal(config.secret, null, 'the inbound secret must never leak into the outbound config');
});

// -------------------------------------------------------------
// Section B: signing
// -------------------------------------------------------------

test('signAlertDeliveryBody: matches an independently computed HMAC-SHA256 of timestamp.rawBody', () => {
  const secret = 'outbound-secret';
  const timestamp = '1790000000000';
  const rawBody = JSON.stringify({ a: 1 });
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  assert.equal(signAlertDeliveryBody(secret, timestamp, rawBody), expected);
});

test('signAlertDeliveryBody: a different secret (e.g. the inbound one) produces a different signature', () => {
  const timestamp = '1790000000000';
  const rawBody = '{"a":1}';
  const outbound = signAlertDeliveryBody('outbound-secret', timestamp, rawBody);
  const inbound = signAlertDeliveryBody('inbound-secret', timestamp, rawBody);
  assert.notEqual(outbound, inbound);
});

// -------------------------------------------------------------
// Section C: one-attempt classification (`attemptAlertDelivery`), fake and real transports
// -------------------------------------------------------------

test('attemptAlertDelivery: headers, delivery id and body bytes are stable; attempt and timestamp change per call', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init.body });
    return new Response(null, { status: 200 });
  };
  const config = baseConfig({ secret: 'outbound-secret' });
  const body = JSON.stringify({ id: 'evt_budget_abc', payload: { x: 1 } });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const outcome = await attemptAlertDelivery(config, { alertId: 'evt_budget_abc', body, attempt }, { fetchImpl, now: Date.now });
    assert.equal(outcome.kind, 'success');
  }

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, config.url);
    assert.equal(call.body, body, 'body bytes must be byte-identical on every attempt');
    assert.equal(call.init.headers['x-agent-viewer-event'], 'budget.alert');
    assert.equal(call.init.headers['x-agent-viewer-delivery'], 'evt_budget_abc', 'delivery id must be stable across attempts');
    assert.equal(call.init.redirect, 'manual');
  }
  assert.deepEqual(calls.map((c) => c.init.headers['x-agent-viewer-attempt']), ['1', '2', '3']);
  const timestamps = calls.map((c) => c.init.headers['x-agent-viewer-timestamp']);
  const signatures = calls.map((c) => c.init.headers['x-agent-viewer-signature']);
  assert.ok(signatures.every((s) => typeof s === 'string' && s.length === 64), 'hex sha256 signature on every attempt');
  // Each signature must match an independent HMAC of that exact attempt's own timestamp and the shared body.
  for (let i = 0; i < calls.length; i++) {
    const expected = crypto.createHmac('sha256', 'outbound-secret').update(`${timestamps[i]}.${body}`).digest('hex');
    assert.equal(signatures[i], expected);
  }
});

test('attemptAlertDelivery: the signature header is omitted entirely when no secret is configured', async () => {
  const fetchImpl = async (_url, init) => {
    assert.equal('x-agent-viewer-signature' in init.headers, false);
    return new Response(null, { status: 200 });
  };
  const outcome = await attemptAlertDelivery(baseConfig({ secret: null }), { alertId: 'a1', body: '{}', attempt: 1 }, { fetchImpl, now: Date.now });
  assert.equal(outcome.kind, 'success');
});

test('attemptAlertDelivery: retry matrix (200, 500, 408, 429 with Retry-After, 400, 302)', async () => {
  const cases = [
    { status: 200, expectKind: 'success' },
    { status: 500, expectKind: 'retry' },
    { status: 408, expectKind: 'retry' },
    { status: 400, expectKind: 'terminal' },
    { status: 401, expectKind: 'terminal' },
    { status: 404, expectKind: 'terminal' },
  ];
  for (const { status, expectKind } of cases) {
    const fetchImpl = async () => new Response(null, { status });
    const outcome = await attemptAlertDelivery(baseConfig(), { alertId: 'a1', body: '{}', attempt: 1 }, { fetchImpl, now: Date.now });
    assert.equal(outcome.kind, expectKind, `status ${status}`);
  }

  // 429 with Retry-After (seconds): retried, and the floor-raising delay is surfaced to the caller.
  const retryAfterFetch = async () => new Response(null, { status: 429, headers: { 'retry-after': '30' } });
  const retryAfterOutcome = await attemptAlertDelivery(baseConfig(), { alertId: 'a1', body: '{}', attempt: 1 }, { fetchImpl: retryAfterFetch, now: Date.now });
  assert.equal(retryAfterOutcome.kind, 'retry');
  assert.equal(retryAfterOutcome.retryAfterMs, 30_000);

  // Any redirect is a terminal failure: the server never follows one (`redirect: 'manual'`).
  const redirectFetch = async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } });
  const redirectOutcome = await attemptAlertDelivery(baseConfig(), { alertId: 'a1', body: '{}', attempt: 1 }, { fetchImpl: redirectFetch, now: Date.now });
  assert.equal(redirectOutcome.kind, 'terminal');
});

test('attemptAlertDelivery: a network error (connection refused) is a retry outcome with status null', async () => {
  const closed = http.createServer(() => {});
  const port = await listen(closed);
  await closeServer(closed); // Nothing listens on this port now: a real ECONNREFUSED.

  const outcome = await attemptAlertDelivery(
    baseConfig({ url: `http://127.0.0.1:${port}/hook`, allowHttp: true }),
    { alertId: 'a1', body: '{}', attempt: 1 },
    { fetchImpl: fetch, now: Date.now }
  );
  assert.equal(outcome.kind, 'retry');
  assert.equal(outcome.status, null);
});

test('attemptAlertDelivery: a timeout (receiver never responds) is a retry outcome, bounded by timeoutMs', async () => {
  const neverResolves = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  const started = Date.now();
  const outcome = await attemptAlertDelivery(baseConfig({ timeoutMs: 50 }), { alertId: 'a1', body: '{}', attempt: 1 }, { fetchImpl: neverResolves, now: Date.now });
  assert.equal(outcome.kind, 'retry');
  assert.ok(Date.now() - started < 1000, 'must not wait anywhere near a full attempt beyond timeoutMs');
});

test('attemptAlertDelivery: a response error body is truncated to the 2 KB cap before it is surfaced', async () => {
  const fetchImpl = async () => new Response('x'.repeat(10_000), { status: 500 });
  const outcome = await attemptAlertDelivery(baseConfig(), { alertId: 'a1', body: '{}', attempt: 1 }, { fetchImpl, now: Date.now });
  assert.equal(outcome.kind, 'retry');
  assert.equal(outcome.error.length, LAST_ERROR_MAX_LENGTH);
});

// -------------------------------------------------------------
// Section D: backoff math
// -------------------------------------------------------------

test('computeBackoffMs: base = min(5s * 2^(attempt-1), 1h), delay uniform in [base/2, base]', () => {
  const expectedBase = [5000, 10_000, 20_000, 40_000, 80_000, 160_000];
  for (let attempt = 1; attempt <= expectedBase.length; attempt++) {
    const base = expectedBase[attempt - 1];
    assert.equal(computeBackoffMs(attempt, null, () => 0), Math.round(base / 2));
    const atCeiling = computeBackoffMs(attempt, null, () => 0.999999);
    assert.ok(atCeiling <= base && atCeiling >= Math.round(base / 2));
  }
});

test('computeBackoffMs: the 1 hour ceiling caps even a very large attempt count', () => {
  const delay = computeBackoffMs(30, null, () => 0.999999);
  assert.ok(delay <= 60 * 60 * 1000);
});

test('computeBackoffMs: Retry-After raises the floor and, once above the base ceiling, pins the exact delay', () => {
  // attempt 1: base = 5000, so floor/ceiling are 2500/5000. A 10s Retry-After exceeds the ceiling entirely.
  assert.equal(computeBackoffMs(1, 10_000, () => 0), 10_000);
  assert.equal(computeBackoffMs(1, 10_000, () => 0.9), 10_000);
  // A Retry-After inside [floor, ceiling] only raises the floor, the range still has real jitter.
  const withinRange = computeBackoffMs(1, 3000, () => 0.5);
  assert.ok(withinRange >= 3000 && withinRange <= 5000);
});

test('computeBackoffMs: Retry-After is itself capped at one hour', () => {
  const delay = computeBackoffMs(1, 10_000_000, () => 0);
  assert.equal(delay, 60 * 60 * 1000);
});

// -------------------------------------------------------------
// Section E: the worker against a fake store and a fake transport/clock (no real waiting, no real network)
// -------------------------------------------------------------

function fakeStore(initialRows) {
  const rows = new Map(initialRows.map((row) => [row.alertId, { ...row }]));
  return {
    rows,
    async listDueAlertDeliveries(now, limit) {
      return Array.from(rows.values())
        .filter((row) => row.status === 'pending' && (row.nextAttemptAt ?? 0) <= now)
        .sort((a, b) => (a.nextAttemptAt ?? 0) - (b.nextAttemptAt ?? 0))
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },
    async recordAlertDeliveryAttempt(alertId, patch) {
      const existing = rows.get(alertId);
      rows.set(alertId, { ...existing, ...patch });
    },
  };
}

test('worker: a successful first attempt marks the row delivered with the response status', async () => {
  const store = fakeStore([{ alertId: 'evt_1', body: '{"a":1}', attempts: 0, status: 'pending', nextAttemptAt: 0 }]);
  const fetchImpl = async () => new Response(null, { status: 204 });
  const logs = [];
  const worker = startAlertDeliveryWorker({
    store,
    config: baseConfig({ maxAttempts: 3 }),
    fetchImpl,
    now: () => 1000,
    random: () => 0,
    log: (m) => logs.push(m),
    pollIntervalMs: 1_000_000, // never fires on its own; the test drives it with checkNow().
  });
  try {
    await worker.checkNow();
    const row = store.rows.get('evt_1');
    assert.equal(row.status, 'delivered');
    assert.equal(row.attempts, 1);
    assert.equal(row.lastStatus, 204);
    assert.equal(row.deliveredAt, 1000);
  } finally {
    await worker.stop();
  }
});

test('worker: dead letter after the configured max attempts, never retried again', async () => {
  const store = fakeStore([{ alertId: 'evt_2', body: '{}', attempts: 0, status: 'pending', nextAttemptAt: 0 }]);
  let now = 0;
  const fetchImpl = async () => new Response('server exploded', { status: 500 });
  const logs = [];
  const worker = startAlertDeliveryWorker({
    store,
    config: baseConfig({ maxAttempts: 3 }),
    fetchImpl,
    now: () => now,
    random: () => 0,
    log: (m) => logs.push(m),
    pollIntervalMs: 1_000_000,
  });
  try {
    for (let i = 0; i < 3; i++) {
      await worker.checkNow();
      now += 3_600_001; // Jump well past any possible backoff so the row is always due for the next tick.
    }
    const row = store.rows.get('evt_2');
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 3);
    assert.equal(row.lastStatus, 500);
    assert.equal(row.nextAttemptAt, null);

    // A 4th tick must not touch a `failed` row at all (it is no longer `pending`, so it is never selected).
    const attemptsBefore = row.attempts;
    await worker.checkNow();
    assert.equal(store.rows.get('evt_2').attempts, attemptsBefore);

    assert.ok(logs.some((m) => m.includes('evt_2') && m.includes('500')), 'the dead-letter warn line names the alert id and status');
  } finally {
    await worker.stop();
  }
});

test('worker: secret and URL never appear in a log line, even on permanent failure', async () => {
  const secret = 'super-secret-outbound-key';
  const url = 'https://hooks.example.test/do-not-leak-this-path';
  const store = fakeStore([{ alertId: 'evt_3', body: '{}', attempts: 0, status: 'pending', nextAttemptAt: 0 }]);
  const logs = [];
  const worker = startAlertDeliveryWorker({
    store,
    config: baseConfig({ url, secret, maxAttempts: 1 }),
    fetchImpl: async () => new Response(null, { status: 400 }),
    now: () => 0,
    random: () => 0,
    log: (m) => logs.push(m),
    pollIntervalMs: 1_000_000,
  });
  try {
    await worker.checkNow();
    assert.equal(store.rows.get('evt_3').status, 'failed');
    for (const line of logs) {
      assert.doesNotMatch(line, new RegExp(secret));
      assert.doesNotMatch(line, /do-not-leak-this-path/);
    }
  } finally {
    await worker.stop();
  }
});

test('worker: a backfill/skipped row is never selected and never attempted', async () => {
  const store = fakeStore([{ alertId: 'evt_4', body: '{}', attempts: 0, status: 'skipped', nextAttemptAt: null }]);
  let fetchCalled = false;
  const worker = startAlertDeliveryWorker({
    store,
    config: baseConfig(),
    fetchImpl: async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    },
    now: () => Date.now(),
    pollIntervalMs: 1_000_000,
  });
  try {
    await worker.checkNow();
    assert.equal(fetchCalled, false);
    assert.equal(store.rows.get('evt_4').status, 'skipped');
  } finally {
    await worker.stop();
  }
});

test('worker: respects the concurrency cap (never more than `concurrency` in flight at once)', async () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({ alertId: `evt_c${i}`, body: '{}', attempts: 0, status: 'pending', nextAttemptAt: 0 }));
  const store = fakeStore(rows);
  let inFlight = 0;
  let maxObserved = 0;
  const release = [];
  const fetchImpl = () =>
    new Promise((resolve) => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      release.push(() => {
        inFlight--;
        resolve(new Response(null, { status: 200 }));
      });
    });
  const worker = startAlertDeliveryWorker({ store, config: baseConfig(), fetchImpl, now: () => 0, pollIntervalMs: 1_000_000, concurrency: 4 });
  try {
    const tick = worker.checkNow();
    await waitFor(() => release.length >= 4, { timeoutMs: 2000 });
    assert.equal(release.length, 4, 'only 4 of the 8 due rows should have started at once');
    while (release.length > 0) release.shift()();
    await tick;
    assert.equal(maxObserved, 4);
  } finally {
    await worker.stop();
  }
});

// -------------------------------------------------------------
// Section F: integration against the real MemoryEventStore and a real local HTTP receiver
// -------------------------------------------------------------

test('recordBudgetAlert + worker: a configured, reachable webhook delivers with a verifiable signature', async () => {
  const secret = 'integration-secret';
  const received = [];
  const receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200).end();
    });
  });
  const port = await listen(receiver);

  const store = new MemoryEventStore();
  const { alert, event } = alertInputFixture();
  const result = await store.recordBudgetAlert({ alert, event }, { attemptDelivery: true });
  assert.equal(result.inserted, true);

  const worker = startAlertDeliveryWorker({
    store,
    config: baseConfig({ url: `http://127.0.0.1:${port}/hook`, allowHttp: true, secret }),
    now: Date.now,
    pollIntervalMs: 1_000_000,
  });
  try {
    await worker.checkNow();
    await waitFor(() => received.length > 0);
    const [request] = received;
    assert.equal(request.headers['x-agent-viewer-event'], 'budget.alert');
    assert.equal(request.headers['x-agent-viewer-delivery'], alert.id);
    assert.equal(request.headers['x-agent-viewer-attempt'], '1');
    assert.equal(request.body, JSON.stringify(event), 'the delivered bytes must equal the stored event, byte for byte');
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${request.headers['x-agent-viewer-timestamp']}.${request.body}`)
      .digest('hex');
    assert.equal(request.headers['x-agent-viewer-signature'], expectedSignature);

    const row = (await store.listDueAlertDeliveries(0, 10)).find((r) => r.alertId === alert.id);
    assert.equal(row, undefined, 'a delivered row is no longer pending/due');
  } finally {
    await worker.stop();
    await closeServer(receiver);
  }
});

test('recordBudgetAlert: a backfill alert is written skipped and is never delivered even with a reachable webhook', async () => {
  let fetchCalled = false;
  const receiver = http.createServer((_req, res) => {
    fetchCalled = true;
    res.writeHead(200).end();
  });
  const port = await listen(receiver);
  const store = new MemoryEventStore();
  const { alert, event } = alertInputFixture({ alert: { backfill: true } });

  // The caller (`server/index.ts`) computes `attemptDelivery = config !== null && !alert.backfill`; a backfill
  // alert must reach `recordBudgetAlert` with `attemptDelivery: false` regardless of whether a webhook is
  // configured, which is exactly what this asserts.
  await store.recordBudgetAlert({ alert, event }, { attemptDelivery: false });

  const worker = startAlertDeliveryWorker({ store, config: baseConfig({ url: `http://127.0.0.1:${port}/`, allowHttp: true }), now: Date.now, pollIntervalMs: 1_000_000 });
  try {
    await worker.checkNow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fetchCalled, false);
    const due = await store.listDueAlertDeliveries(Date.now() + 10, 10);
    assert.equal(due.find((r) => r.alertId === alert.id), undefined);
  } finally {
    await worker.stop();
    await closeServer(receiver);
  }
});

test('recordBudgetAlert: with no webhook configured, the delivery row is written skipped and never enqueued', async () => {
  const store = new MemoryEventStore();
  const { alert, event } = alertInputFixture();
  await store.recordBudgetAlert({ alert, event }, { attemptDelivery: false });
  const due = await store.listDueAlertDeliveries(Date.now() + 10, 10);
  assert.equal(due.find((r) => r.alertId === alert.id), undefined);
});

test('recordBudgetAlert: a hanging receiver never delays the call (delivery is off the ingest path)', async () => {
  const hanging = http.createServer(() => {
    // Deliberately never responds.
  });
  const port = await listen(hanging);
  try {
    const store = new MemoryEventStore();
    const { alert, event } = alertInputFixture();

    const startedAt = Date.now();
    const result = await store.recordBudgetAlert({ alert, event }, { attemptDelivery: true });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.inserted, true);
    assert.ok(elapsedMs < 200, `recordBudgetAlert took ${elapsedMs}ms; it must never perform the HTTP delivery itself`);

    // The row is genuinely queued for delivery (not silently dropped), confirming this is a real deferral and not
    // an accidental skip.
    const due = await store.listDueAlertDeliveries(Date.now() + 1, 10);
    assert.ok(due.some((r) => r.alertId === alert.id));
  } finally {
    await closeServer(hanging);
  }
});

test('recordBudgetAlert: dedup still rejects a repeated crossing when attemptDelivery differs between calls', async () => {
  const store = new MemoryEventStore();
  const { alert, event } = alertInputFixture();
  const first = await store.recordBudgetAlert({ alert, event }, { attemptDelivery: true });
  assert.equal(first.inserted, true);
  // Same (budgetId, periodStart, state): a second call, even asking for delivery differently, must be rejected
  // with no side effect, exactly like the no-webhook-configured case.
  const second = await store.recordBudgetAlert({ alert, event }, { attemptDelivery: false });
  assert.equal(second.inserted, false);
  const row = (await store.listDueAlertDeliveries(Date.now() + 10, 10)).find((r) => r.alertId === alert.id);
  assert.ok(row, 'the original pending delivery row must be untouched by the rejected second call');
});
