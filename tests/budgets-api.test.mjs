// Issue #85, sub-issue #304: the 6 `/api/v1/budgets*` HTTP routes (`server/budgets.ts`'s `registerBudgetsRoutes`,
// wired in `server/index.ts`) plus the `budgets` field on `GET /api/v1/snapshot`. Exercises the real `app` end to
// end (pattern from `tests/pricing-api.test.mjs`): CRUD, every documented error code (400/404/409), the no-op
// `PUT`, revisions with `actor`/`auth`, token enforcement, and one end-to-end evaluation against real `llm.usage`
// ledger rows ingested through `POST /api/v1/events`. The pure engine (window math, `aggregateBudgetCalls`,
// `evaluateBudget`) already has its own exhaustive table-driven suite in `tests/budgets.test.mjs`; this file
// never re-tests that, only that the HTTP layer wires it correctly.
//
// All tests in this file share one `app` (and so one in-memory `budgetRegistry`) for the whole process, like
// every other `*-api.test.mjs` file here: each test uses a unique scope value (a random agent/session id) so
// budgets created by one test can never be counted by another's list/filter assertions. The `POST /api/v1/budgets`
// 500-budget cap is checked separately, directly against `registerBudgetsRoutes` on a throwaway `express()` app
// with a stub registry, so it never has to create (or leave behind) 500 real budgets on the shared app.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { app } from '../server/index.ts';
import { registerBudgetsRoutes, BudgetValidationError } from '../server/budgets.ts';

const TOKEN = 'test-budgets-admin-token';

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
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

async function withBudgetsServer(fn) {
  return withEnv({ AGENT_VIEWER_API_TOKEN: TOKEN, AGENT_VIEWER_API_KEY: undefined }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      return await fn(baseUrl);
    } finally {
      server.close();
    }
  });
}

function uniqueId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function createBudget(baseUrl, overrides = {}) {
  const scopeValue = overrides.scope?.value ?? uniqueId('agent');
  const body = {
    name: 'Test budget',
    scope: { type: 'agent', value: scopeValue },
    period: 'day',
    currency: 'USD',
    basis: 'reported',
    limit: 10,
    ...overrides,
  };
  const res = await fetch(`${baseUrl}/api/v1/budgets`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, json: res.status < 500 ? await res.json() : null, scopeValue };
}

async function postUsageEvent(baseUrl, agentId, payload) {
  const res = await fetch(`${baseUrl}/api/v1/events`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: uniqueId('evt'),
      type: 'llm.usage',
      timestamp: Date.now(),
      source: `agent:${agentId}`,
      agentId,
      summary: 'budget test usage',
      payload,
    }),
  });
  assert.equal(res.status, 202);
  return res;
}

// ---------------------------------------------------------------
// POST /api/v1/budgets
// ---------------------------------------------------------------

test('POST /api/v1/budgets creates a budget with defaults and an evaluated zero-spend status', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const { res, json } = await createBudget(baseUrl, { name: 'Builder daily' });
    assert.equal(res.status, 201);
    assert.match(json.id, /^bud_/);
    assert.equal(json.name, 'Builder daily');
    assert.equal(json.timezone, 'UTC');
    assert.equal(json.warningRatio, 0.8);
    assert.equal(json.enabled, true);
    assert.equal(json.revision, 1);
    assert.ok(json.status, 'an enabled budget always has a status');
    assert.equal(json.status.state, 'ok');
    assert.equal(json.status.spent, 0);
    assert.equal(json.status.spentComplete, true);
    assert.equal(json.status.calls.total, 0);
    assert.deepEqual(json.status.unknownReasons, []);
  });
});

test('POST /api/v1/budgets: disabled budget has status null, never evaluated', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const { res, json } = await createBudget(baseUrl, { enabled: false });
    assert.equal(res.status, 201);
    assert.equal(json.enabled, false);
    assert.equal(json.status, null);
  });
});

test('POST /api/v1/budgets: 400 validation_failed for a missing required field', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/budgets`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: { type: 'all', value: null }, period: 'day', currency: 'USD', basis: 'reported', limit: 10 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'validation_failed');
    assert.ok(body.issues.some((issue) => issue.path === 'name'));
  });
});

test('POST /api/v1/budgets: 400 validation_failed for an unknown field (rejected, not stored)', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/budgets`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'x',
        scope: { type: 'all', value: null },
        period: 'day',
        currency: 'USD',
        basis: 'reported',
        limit: 10,
        unexpectedField: true,
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'validation_failed');
  });
});

test('POST /api/v1/budgets: 400 validation_failed for a bad currency, bad limit and scope.value on "all"', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const badCurrency = await createBudget(baseUrl, { currency: 'usd' });
    assert.equal(badCurrency.res.status, 400);
    assert.ok(badCurrency.json.issues.some((issue) => issue.path === 'currency'));

    const badLimit = await createBudget(baseUrl, { limit: 0 });
    assert.equal(badLimit.res.status, 400);
    assert.ok(badLimit.json.issues.some((issue) => issue.path === 'limit'));

    const badAllScope = await createBudget(baseUrl, { scope: { type: 'all', value: 'should-be-null' } });
    assert.equal(badAllScope.res.status, 400);
    assert.ok(badAllScope.json.issues.some((issue) => issue.path === 'scope.value'));
  });
});

test('POST /api/v1/budgets: 409 budget_exists on a repeated id, including the id of a deleted budget', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const id = uniqueId('bud');
    const first = await createBudget(baseUrl, { id });
    assert.equal(first.res.status, 201);

    const second = await createBudget(baseUrl, { id });
    assert.equal(second.res.status, 409);
    assert.equal(second.json.error, 'budget_exists');

    const del = await fetch(`${baseUrl}/api/v1/budgets/${id}`, { method: 'DELETE', headers: auth() });
    assert.equal(del.status, 204);

    const third = await createBudget(baseUrl, { id });
    assert.equal(third.res.status, 409);
    assert.equal(third.json.error, 'budget_exists');
  });
});

// ---------------------------------------------------------------
// GET /api/v1/budgets/:id
// ---------------------------------------------------------------

test('GET /api/v1/budgets/:id returns the budget, 404 budget_not_found for an unknown id', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const { json: created } = await createBudget(baseUrl);
    const res = await fetch(`${baseUrl}/api/v1/budgets/${created.id}`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, created.id);

    const missing = await fetch(`${baseUrl}/api/v1/budgets/${uniqueId('bud')}`, { headers: auth() });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'budget_not_found' });
  });
});

// ---------------------------------------------------------------
// GET /api/v1/budgets (list + filters)
// ---------------------------------------------------------------

test('GET /api/v1/budgets filters by scopeType/scopeValue and rejects a bad state filter', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const scopeValue = uniqueId('agent');
    const { json: created } = await createBudget(baseUrl, { scope: { type: 'agent', value: scopeValue } });

    const filtered = await fetch(`${baseUrl}/api/v1/budgets?scopeType=agent&scopeValue=${scopeValue}`, { headers: auth() });
    assert.equal(filtered.status, 200);
    const body = await filtered.json();
    assert.equal(body.count, 1);
    assert.equal(body.budgets[0].id, created.id);
    assert.equal(body.schemaVersion, '1.0');

    const otherScope = await fetch(`${baseUrl}/api/v1/budgets?scopeType=model&scopeValue=${scopeValue}`, { headers: auth() });
    assert.equal((await otherScope.json()).count, 0);

    const badState = await fetch(`${baseUrl}/api/v1/budgets?state=not-a-state`, { headers: auth() });
    assert.equal(badState.status, 400);
    assert.equal((await badState.json()).error, 'validation_failed');

    const badScopeType = await fetch(`${baseUrl}/api/v1/budgets?scopeType=bogus`, { headers: auth() });
    assert.equal(badScopeType.status, 400);
  });
});

test('GET /api/v1/budgets?state=ok excludes a disabled budget (status null)', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const scopeValue = uniqueId('agent');
    const { json: disabled } = await createBudget(baseUrl, { scope: { type: 'agent', value: scopeValue }, enabled: false });
    assert.equal(disabled.status, null);

    const res = await fetch(`${baseUrl}/api/v1/budgets?state=ok&scopeType=agent&scopeValue=${scopeValue}`, { headers: auth() });
    const body = await res.json();
    assert.equal(body.count, 0);
  });
});

// ---------------------------------------------------------------
// PUT /api/v1/budgets/:id
// ---------------------------------------------------------------

test('PUT /api/v1/budgets/:id replaces the configuration, bumps revision, and a no-op PUT writes none', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const { json: created } = await createBudget(baseUrl, { name: 'Before' });
    assert.equal(created.revision, 1);

    const replaceBody = {
      name: 'After',
      scope: created.scope,
      period: created.period,
      currency: created.currency,
      basis: created.basis,
      limit: 25,
    };
    const putRes = await fetch(`${baseUrl}/api/v1/budgets/${created.id}`, {
      method: 'PUT',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(replaceBody),
    });
    assert.equal(putRes.status, 200);
    const updated = await putRes.json();
    assert.equal(updated.name, 'After');
    assert.equal(updated.limit, 25);
    assert.equal(updated.revision, 2);
    assert.equal(updated.timezone, 'UTC');
    assert.equal(updated.warningRatio, 0.8);
    assert.equal(updated.enabled, true);

    // Identical configuration again: no-op, 200, revision unchanged.
    const noOpRes = await fetch(`${baseUrl}/api/v1/budgets/${created.id}`, {
      method: 'PUT',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(replaceBody),
    });
    assert.equal(noOpRes.status, 200);
    const afterNoOp = await noOpRes.json();
    assert.equal(afterNoOp.revision, 2);

    const revisionsRes = await fetch(`${baseUrl}/api/v1/budgets/${created.id}/revisions`, { headers: auth() });
    const revisions = await revisionsRes.json();
    assert.equal(revisions.length, 2, 'create + one real update, the no-op PUT wrote nothing');
  });
});

test('PUT /api/v1/budgets/:id: 400 when body id does not match the URL id, 404 for a missing budget', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const { json: created } = await createBudget(baseUrl);
    const mismatchRes = await fetch(`${baseUrl}/api/v1/budgets/${created.id}`, {
      method: 'PUT',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: uniqueId('bud'), name: 'x', scope: created.scope, period: 'day', currency: 'USD', basis: 'reported', limit: 5 }),
    });
    assert.equal(mismatchRes.status, 400);
    assert.equal((await mismatchRes.json()).error, 'validation_failed');

    const missingRes = await fetch(`${baseUrl}/api/v1/budgets/${uniqueId('bud')}`, {
      method: 'PUT',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', scope: created.scope, period: 'day', currency: 'USD', basis: 'reported', limit: 5 }),
    });
    assert.equal(missingRes.status, 404);
    assert.deepEqual(await missingRes.json(), { error: 'budget_not_found' });
  });
});

// ---------------------------------------------------------------
// DELETE /api/v1/budgets/:id
// ---------------------------------------------------------------

test('DELETE /api/v1/budgets/:id soft deletes, 404 on a repeat delete and on GET afterwards', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const { json: created } = await createBudget(baseUrl);

    const del = await fetch(`${baseUrl}/api/v1/budgets/${created.id}`, { method: 'DELETE', headers: auth() });
    assert.equal(del.status, 204);

    const repeat = await fetch(`${baseUrl}/api/v1/budgets/${created.id}`, { method: 'DELETE', headers: auth() });
    assert.equal(repeat.status, 404);
    assert.deepEqual(await repeat.json(), { error: 'budget_not_found' });

    const getAfter = await fetch(`${baseUrl}/api/v1/budgets/${created.id}`, { headers: auth() });
    assert.equal(getAfter.status, 404);
  });
});

// ---------------------------------------------------------------
// GET /api/v1/budgets/:id/revisions
// ---------------------------------------------------------------

test('GET /api/v1/budgets/:id/revisions records actor and auth, works for a deleted budget, 404 only for a never-existing id', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const createRes = await fetch(`${baseUrl}/api/v1/budgets`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json', 'X-Agent-Viewer-Actor': 'alice' },
      body: JSON.stringify({ name: 'Actor test', scope: { type: 'all', value: null }, period: 'day', currency: 'USD', basis: 'reported', limit: 5 }),
    });
    const created = await createRes.json();

    await fetch(`${baseUrl}/api/v1/budgets/${created.id}`, { method: 'DELETE', headers: { ...auth(), 'X-Agent-Viewer-Actor': 'bob' } });

    const revisionsRes = await fetch(`${baseUrl}/api/v1/budgets/${created.id}/revisions`, { headers: auth() });
    assert.equal(revisionsRes.status, 200);
    const revisions = await revisionsRes.json();
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0].action, 'create');
    assert.equal(revisions[0].actor, 'alice');
    assert.equal(revisions[0].auth, 'token');
    assert.equal(revisions[1].action, 'delete');
    assert.equal(revisions[1].actor, 'bob');

    const neverExisted = await fetch(`${baseUrl}/api/v1/budgets/${uniqueId('bud')}/revisions`, { headers: auth() });
    assert.equal(neverExisted.status, 404);
    assert.deepEqual(await neverExisted.json(), { error: 'budget_not_found' });
  });
});

// ---------------------------------------------------------------
// Auth
// ---------------------------------------------------------------

test('budgets routes honor the shared /api/v1 Bearer token check', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/budgets`);
    assert.equal(res.status, 401);
  });
});

// ---------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------

test('GET /api/v1/snapshot includes the enabled budget with its evaluated status', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const { json: created } = await createBudget(baseUrl, { name: 'Snapshot budget' });
    const res = await fetch(`${baseUrl}/api/v1/snapshot`, { headers: auth() });
    assert.equal(res.status, 200);
    const snapshot = await res.json();
    assert.equal(snapshot.schemaVersion, '1.0');
    assert.ok(Array.isArray(snapshot.budgets));
    const found = snapshot.budgets.find((b) => b.id === created.id);
    assert.ok(found, 'created budget is present in the snapshot');
    assert.equal(found.status.state, 'ok');
  });
});

// ---------------------------------------------------------------
// End-to-end evaluation against real ledger rows
// ---------------------------------------------------------------

test('a budget reflects real ingested llm.usage spend: reported cost counted, unknown cost makes it unknown', async () => {
  await withBudgetsServer(async (baseUrl) => {
    const agentId = uniqueId('agent');
    const { json: budget } = await createBudget(baseUrl, {
      name: 'Agent spend',
      scope: { type: 'agent', value: agentId },
      basis: 'reported',
      limit: 10,
      warningRatio: 0.5,
    });

    await postUsageEvent(baseUrl, agentId, {
      provider: 'OpenAI',
      model: 'gpt-4.1',
      inputTokens: 100,
      outputTokens: 50,
      cost: 6,
      currency: 'USD',
      costSource: 'provider-reported',
    });

    const afterReported = await (await fetch(`${baseUrl}/api/v1/budgets/${budget.id}`, { headers: auth() })).json();
    assert.equal(afterReported.status.state, 'warning');
    assert.equal(afterReported.status.spent, 6);
    assert.equal(afterReported.status.knownSpent, 6);
    assert.equal(afterReported.status.calls.total, 1);
    assert.equal(afterReported.status.calls.withCost, 1);

    // A second call with no cost at all: the budget can never again report a complete, known figure.
    await postUsageEvent(baseUrl, agentId, {
      provider: 'OpenAI',
      model: 'gpt-4.1',
      inputTokens: 10,
      outputTokens: 5,
    });

    const afterUnknown = await (await fetch(`${baseUrl}/api/v1/budgets/${budget.id}`, { headers: auth() })).json();
    assert.equal(afterUnknown.status.state, 'unknown');
    assert.equal(afterUnknown.status.spent, null);
    assert.equal(afterUnknown.status.knownSpent, 6);
    assert.ok(afterUnknown.status.unknownReasons.includes('unknown_cost'));
    assert.equal(afterUnknown.status.calls.total, 2);
    assert.equal(afterUnknown.status.calls.unknownCost, 1);
  });
});

// ---------------------------------------------------------------
// Cap: at most 500 budgets (isolated from the shared app/registry above)
// ---------------------------------------------------------------

test('POST /api/v1/budgets: 400 validation_failed beyond 500 active budgets', async () => {
  const stubRegistry = {
    create: () => {
      throw new BudgetValidationError([{ path: 'should-not-be-called', message: 'cap must be enforced before create()' }]);
    },
    update: () => null,
    delete: () => false,
    get: () => null,
    list: () => Array.from({ length: 500 }, (_, i) => ({
      id: `bud_${i}`,
      name: 'x',
      scope: { type: 'all', value: null },
      period: 'day',
      timezone: 'UTC',
      currency: 'USD',
      basis: 'reported',
      limit: 1,
      warningRatio: 0.8,
      enabled: false,
      revision: 1,
      createdAt: 0,
      updatedAt: 0,
    })),
    listRevisions: () => [],
    getCachedStatus: () => null,
    setCachedStatus: () => {},
  };

  const testApp = express();
  testApp.use(express.json());
  registerBudgetsRoutes(testApp, {
    getRegistry: () => stubRegistry,
    currentAuthMode: () => 'open',
    rollup: async () => {
      throw new Error('rollup should not be called for a disabled-only registry list');
    },
    iterateLedgerRows: async function* () {},
  });

  const server = http.createServer(testApp);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${baseUrl}/api/v1/budgets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'one too many', scope: { type: 'all', value: null }, period: 'day', currency: 'USD', basis: 'reported', limit: 1 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'validation_failed');
    assert.ok(body.issues.some((issue) => issue.path === 'budgets'));
  } finally {
    server.close();
  }
});
