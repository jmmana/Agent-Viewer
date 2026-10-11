// Issue #67: `GET /api/v1/usage/calls` over HTTP. The store singleton imported from `server/index.ts` is
// shared across every test in this file (each test file runs in its own process, per `node:test`'s default
// isolation), so every test seeds its rows under its own unique `agentId` and filters by it, rather than
// assuming an empty store.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { app, store } from '../server/index.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** Runs `fn` with the given env vars set, restoring the previous values afterwards. */
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

const NO_AUTH_ENV = { AGENT_VIEWER_API_TOKEN: undefined, AGENT_VIEWER_API_KEY: undefined };

function uniqueAgentId(label) {
  return `agent_${label}_${crypto.randomBytes(6).toString('hex')}`;
}

async function appendUsage(agentId, overrides = {}) {
  const result = validateCanonicalEvent({
    id: `evt_${agentId}_${crypto.randomBytes(4).toString('hex')}`,
    type: 'llm.usage',
    timestamp: 1_700_000_000_000,
    source: `agent:${agentId}`,
    agentId,
    summary: 'Audited call',
    payload: { provider: 'anthropic', model: 'claude', inputTokens: 10, outputTokens: 5, cost: 0.01, currency: 'USD', costSource: 'provider-reported', ...overrides },
  });
  assert.equal(result.success, true, JSON.stringify(result.issues));
  const appended = await store.append(result.data);
  assert.equal(appended.outcome, 'accepted');
  return appended;
}

async function appendFailed(agentId, overrides = {}) {
  const result = validateCanonicalEvent({
    id: `evt_${agentId}_${crypto.randomBytes(4).toString('hex')}`,
    type: 'llm.failed',
    timestamp: 1_700_000_000_000,
    source: `agent:${agentId}`,
    agentId,
    summary: 'Failed call',
    payload: { provider: 'anthropic', model: 'claude', errorKind: 'rate_limited', ...overrides },
  });
  assert.equal(result.success, true, JSON.stringify(result.issues));
  const appended = await store.append(result.data);
  assert.equal(appended.outcome, 'accepted');
  return appended;
}

test('GET /api/v1/usage/calls: response shape, Cache-Control and the exact CallRecord key set', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const agentId = uniqueAgentId('shape');
    await appendUsage(agentId);

    const response = await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const body = await response.json();
    assert.equal(body.schemaVersion, '1.0');
    assert.equal(typeof body.asOf, 'number');
    assert.equal(body.storage, 'memory');
    assert.equal(body.data.length, 1);
    assert.deepEqual(body.page, { limit: 100, order: 'desc', hasMore: false, nextCursor: null });
    // Issue #295: echoed on every response, independent of each row's own fields below.
    assert.deepEqual(body.estimateBasis, { mode: 'latest', revision: null, revisionsUsed: [0] });

    const record = body.data[0];
    assert.deepEqual(
      Object.keys(record).sort(),
      [
        'agentId', 'backfilled', 'cost', 'costSource', 'currency', 'errorCode', 'eventId', 'latencyMs', 'model',
        'occurredAt', 'provider', 'receivedAt', 'requestId', 'runtimeId', 'seq', 'sessionId', 'status', 'taskId',
        'tags', 'tokens', 'trace', 'type', 'userId',
        // Issue #295, appended after every pre-existing field.
        'estimatedCost', 'estimatedCostNano', 'estimatedCurrency', 'estimatedCostSource', 'pricingVersion',
        'estimateStatus', 'estimateRevision', 'estimatedAt',
      ].sort()
    );
    assert.deepEqual(Object.keys(record.tokens).sort(), ['cacheRead', 'cacheWrite', 'input', 'output', 'reasoning'].sort());
    assert.deepEqual(Object.keys(record.trace).sort(), ['meetingId', 'parentId', 'toolCallId', 'traceId'].sort());
  } finally {
    server.close();
  }
});

test('GET /api/v1/usage/calls: estimate fields for a priced model (estimated), an unpriced one (no_price_for_model) and estimateRevision is always 0', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const agentId = uniqueAgentId('estimate');
    // `claude-sonnet-5-5`/`anthropic` is in the bundled starter pricing table (server/pricing/starter.json), in
    // force from 2026-10-10; `Date.now()` (unlike this file's other fixtures, fixed at 1_700_000_000_000, well
    // before that date) lands after it. The default `claude` fixture model used elsewhere in this file is not in
    // the table at all, at any date.
    const now = Date.now();
    const pricedEvent = validateCanonicalEvent({
      id: `evt_${agentId}_priced`,
      type: 'llm.usage',
      timestamp: now,
      source: `agent:${agentId}`,
      agentId,
      summary: 'priced call',
      payload: {
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
    assert.equal(pricedEvent.success, true, JSON.stringify(pricedEvent.issues));
    assert.equal((await store.append(pricedEvent.data)).outcome, 'accepted');

    const unpricedEvent = validateCanonicalEvent({
      id: `evt_${agentId}_unpriced`,
      type: 'llm.usage',
      timestamp: now + 1,
      source: `agent:${agentId}`,
      agentId,
      summary: 'unpriced call',
      payload: { provider: 'anthropic', model: 'a-model-no-pricing-table-will-ever-have', inputTokens: 10, outputTokens: 5 },
    });
    assert.equal(unpricedEvent.success, true, JSON.stringify(unpricedEvent.issues));
    assert.equal((await store.append(unpricedEvent.data)).outcome, 'accepted');

    const body = await (await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&order=asc`)).json();
    assert.equal(body.data.length, 2);

    const estimated = body.data[0];
    assert.equal(estimated.estimateStatus, 'estimated');
    assert.equal(estimated.estimateRevision, 0);
    assert.equal(estimated.estimatedCostSource, 'estimated');
    assert.notEqual(estimated.estimatedCost, null);
    assert.notEqual(estimated.estimatedCostNano, null);
    assert.ok(Number.isInteger(estimated.estimatedCostNano) && estimated.estimatedCostNano > 0);
    assert.equal(estimated.estimatedCost, estimated.estimatedCostNano / 1e9);
    assert.equal(typeof estimated.estimatedCurrency, 'string');
    assert.equal(typeof estimated.pricingVersion, 'number');
    assert.equal(typeof estimated.estimatedAt, 'number');

    const unpriced = body.data[1];
    assert.equal(unpriced.estimateStatus, 'no_price_for_model');
    assert.equal(unpriced.estimateRevision, 0);
    assert.equal(unpriced.estimatedCost, null);
    assert.equal(unpriced.estimatedCostNano, null);
    assert.equal(unpriced.estimatedCurrency, null);
    assert.equal(unpriced.estimatedCostSource, null);
    assert.equal(typeof unpriced.estimatedAt, 'number'); // the estimator ran, it just found no price
  } finally {
    server.close();
  }
});

test('GET /api/v1/usage/calls: estimates and estimateRevision together are a 400, each one alone is accepted', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const agentId = uniqueAgentId('basis');
    await appendUsage(agentId);

    const both = await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&estimates=original&estimateRevision=3`);
    assert.equal(both.status, 400);
    const bothBody = await both.json();
    assert.equal(bothBody.error, 'invalid_filter');

    const original = await (await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&estimates=original`)).json();
    assert.deepEqual(original.estimateBasis, { mode: 'original', revision: null, revisionsUsed: [0] });

    const asOf = await (await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&estimateRevision=7`)).json();
    assert.deepEqual(asOf.estimateBasis, { mode: 'asOfRevision', revision: 7, revisionsUsed: [0] });
    // Every row's own estimateRevision is still 0: no recompute endpoint exists yet to produce another revision.
    assert.equal(asOf.data[0].estimateRevision, 0);

    const bad = await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&estimates=bogus`);
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

test('GET /api/v1/usage/calls: unreported fields come back null, never 0; backfilled is false for a live row', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const agentId = uniqueAgentId('nulls');
    await appendUsage(agentId, { cacheReadTokens: undefined, cost: undefined, currency: undefined });

    const body = await (await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}`)).json();
    const record = body.data[0];
    assert.equal(record.tokens.cacheRead, null);
    assert.equal(record.tokens.cacheWrite, null);
    assert.equal(record.tokens.reasoning, null);
    assert.equal(record.cost, null);
    assert.equal(record.currency, null);
    assert.equal(record.costSource, 'unknown');
    assert.equal(record.backfilled, false);
    assert.equal(record.errorCode, null);
  } finally {
    server.close();
  }
});

test('GET /api/v1/usage/calls: a failed call carries its status and a safe errorCode', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const agentId = uniqueAgentId('failed');
    await appendFailed(agentId, { errorKind: 'rate_limited' });

    const body = await (await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}`)).json();
    const record = body.data[0];
    assert.equal(record.type, 'llm.failed');
    assert.equal(record.status, 'rate_limited');
    assert.equal(record.errorCode, 'rate_limited');
  } finally {
    server.close();
  }
});

test('GET /api/v1/usage/calls: canary privacy, no free text anywhere in the response', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const agentId = uniqueAgentId('canary');
    const canary = 'CANARY-7f3a';
    // summary and an unknown payload key carry the canary; neither is stored on the ledger at all, so neither
    // can leak through this endpoint regardless.
    await appendUsage(agentId, {});
    const eventWithCanarySummary = validateCanonicalEvent({
      id: `evt_${agentId}_summary`,
      type: 'llm.usage',
      timestamp: 1_700_000_000_000,
      source: `agent:${agentId}`,
      agentId,
      summary: `Call with ${canary} inside`,
      payload: { provider: 'anthropic', model: 'claude', inputTokens: 1, outputTokens: 1, unknownField: canary },
    });
    assert.equal(eventWithCanarySummary.success, true, JSON.stringify(eventWithCanarySummary.issues));
    await store.append(eventWithCanarySummary.data);
    await appendFailed(agentId, { providerErrorCode: `${canary} with spaces and punctuation!` });

    const response = await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&limit=1`);
    const text = await response.text();
    assert.ok(!text.includes(canary), `response must never contain the canary string: ${text}`);

    // A stored errorKind is always a short machine code in this codebase, but the serializer's regex guard is
    // exercised directly in tests/usage-calls-store parity: here we confirm the field exists and is safe.
    const body = JSON.parse(text);
    for (const record of body.data) {
      if (record.errorCode !== null) assert.match(record.errorCode, /^[A-Za-z0-9_.:-]{1,64}$/);
    }

    // Walk every page too: the canary must never surface on any page.
    let cursor;
    let guard = 0;
    while (true) {
      guard++;
      assert.ok(guard < 100);
      const pageUrl = new URL(`${baseUrl}/api/v1/usage/calls`);
      pageUrl.searchParams.set('agentId', agentId);
      pageUrl.searchParams.set('limit', '1');
      if (cursor) pageUrl.searchParams.set('cursor', cursor);
      const pageResponse = await fetch(pageUrl);
      const pageText = await pageResponse.text();
      assert.ok(!pageText.includes(canary));
      const pageBody = JSON.parse(pageText);
      if (!pageBody.page.hasMore) break;
      cursor = pageBody.page.nextCursor;
    }
  } finally {
    server.close();
  }
});

test('GET /api/v1/usage/calls: no totals, sums or counts in the response', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const agentId = uniqueAgentId('nototals');
    await appendUsage(agentId);
    const body = await (await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}`)).json();
    assert.equal('count' in body, false);
    assert.equal('total' in body, false);
    assert.equal('sum' in body, false);
  } finally {
    server.close();
  }
});

test('GET /api/v1/usage/calls: Link header on a page with more results, never carrying a token', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const agentId = uniqueAgentId('link');
    await appendUsage(agentId);
    await appendUsage(agentId);
    await appendUsage(agentId);

    const response = await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&limit=1&token=leaked-token`);
    // The query-token rejection middleware answers 401 before this route ever runs (issue #71 removed query-token
    // auth entirely); this also proves a leaked ?token= can never reach the handler, let alone the Link header.
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.error, 'query_token_not_supported');

    const clean = await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&limit=1`);
    assert.equal(clean.status, 200);
    const link = clean.headers.get('link');
    assert.ok(link, 'expected a Link header when hasMore is true');
    assert.ok(!link.includes('token'), `Link header must never carry a token: ${link}`);
    assert.match(link, /^<\/api\/v1\/usage\/calls\?/);
    assert.match(link, /rel="next"/);
  } finally {
    server.close();
  }
});

test('GET /api/v1/usage/calls: full walk with limit=1 covers every row exactly once, in seq order', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const agentId = uniqueAgentId('fullwalk');
    const seqs = [];
    for (let i = 0; i < 5; i++) seqs.push((await appendUsage(agentId)).seq);

    for (const order of ['desc', 'asc']) {
      const seen = [];
      let cursor;
      let guard = 0;
      while (true) {
        guard++;
        assert.ok(guard < 100);
        const url = new URL(`${baseUrl}/api/v1/usage/calls`);
        url.searchParams.set('agentId', agentId);
        url.searchParams.set('order', order);
        url.searchParams.set('limit', '1');
        if (cursor) url.searchParams.set('cursor', cursor);
        const body = await (await fetch(url)).json();
        seen.push(...body.data.map((r) => r.seq));
        if (!body.page.hasMore) break;
        cursor = body.page.nextCursor;
      }
      const expected = order === 'desc' ? [...seqs].reverse() : seqs;
      assert.deepEqual(seen, expected, `order=${order}`);
    }
  } finally {
    server.close();
  }
});

test('GET /api/v1/usage/calls: 400 invalid_filter for every malformed query in the issue\'s table', async () => {
  const { server, baseUrl } = await startTestServer();
  const cases = [
    'notAFilter=x',
    'agentid=',
    'agentId=',
    'agentId[x]=1',
    'limit=1&limit=2',
    'from=not-a-date',
    'from=2026-10-01T00:00:00',
    'from=1700000000000&to=1700000000000',
    'status=not_a_status',
    `agentId=${Array.from({ length: 101 }, (_, i) => `a${i}`).join('&agentId=')}`,
    'limit=0',
    'limit=1001',
    'limit=abc',
  ];
  try {
    for (const query of cases) {
      const response = await fetch(`${baseUrl}/api/v1/usage/calls?${query}`);
      assert.equal(response.status, 400, `query "${query}" must be rejected`);
      const body = await response.json();
      assert.equal(body.error, 'invalid_filter');
      assert.ok(Array.isArray(body.issues) && body.issues.length > 0, `query "${query}" must carry issues`);
    }
  } finally {
    server.close();
  }
});

test('GET /api/v1/usage/calls: invalid_cursor, cursor_mismatch and changing only limit between pages', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const agentId = uniqueAgentId('cursor');
    await appendUsage(agentId);
    await appendUsage(agentId);

    const badCursor = await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&cursor=not-base64!!!`);
    assert.equal(badCursor.status, 400);
    assert.equal((await badCursor.json()).error, 'invalid_cursor');

    const tooLong = await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&cursor=${'a'.repeat(600)}`);
    assert.equal(tooLong.status, 400);
    assert.equal((await tooLong.json()).error, 'invalid_cursor');

    const firstPage = await (await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&limit=1`)).json();
    const cursor = firstPage.page.nextCursor;
    assert.ok(cursor);

    // Reusing the cursor with a different filter set must be rejected.
    const differentFilters = await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&provider=openai&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(differentFilters.status, 400);
    assert.equal((await differentFilters.json()).error, 'cursor_mismatch');

    // Reusing the cursor with a different order must be rejected.
    const differentOrder = await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&order=asc&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(differentOrder.status, 400);
    assert.equal((await differentOrder.json()).error, 'cursor_mismatch');

    // Changing only limit between pages is allowed.
    const biggerLimit = await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&limit=50&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(biggerLimit.status, 200);
    const biggerLimitBody = await biggerLimit.json();
    assert.equal(biggerLimitBody.data.length, 1);
  } finally {
    server.close();
  }
});

test('GET /api/v1/usage/calls: cursor_expired when the store epoch does not match (memory mode restart)', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const agentId = uniqueAgentId('expired');
    await appendUsage(agentId);

    // Forge a cursor with a store epoch that can never equal this process's own (memory mode mints one
    // per instance), with a filter hash computed the same way the route computes it, so the mismatch check
    // passes and the epoch check is the one that fails.
    const realEpoch = store.usageLedgerEpoch();
    const { filterHash } = await import('../server/usage/calls.ts');
    const { parseUsageFilters } = await import('../server/usage/filters.ts');
    const parsed = parseUsageFilters({ agentId }, { allowCallsOnly: true });
    assert.equal(parsed.ok, true);
    const hash = filterHash(parsed.value.filters);
    const forged = Buffer.from(
      JSON.stringify({ v: 1, e: `${realEpoch}-not-the-same`, s: 1, o: 'desc', f: hash }),
      'utf8'
    ).toString('base64url');

    const response = await fetch(`${baseUrl}/api/v1/usage/calls?agentId=${agentId}&cursor=${forged}`);
    assert.equal(response.status, 410);
    assert.equal((await response.json()).error, 'cursor_expired');
  } finally {
    server.close();
  }
});

test('GET /api/v1/usage/calls: requires auth when AGENT_VIEWER_API_TOKEN is set (header and rejects ?token=)', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'calls-token' }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const noAuth = await fetch(`${baseUrl}/api/v1/usage/calls`);
      assert.equal(noAuth.status, 401);
      assert.equal((await noAuth.json()).error, 'unauthorized');

      const queryToken = await fetch(`${baseUrl}/api/v1/usage/calls?token=calls-token`);
      assert.equal(queryToken.status, 401);
      assert.equal((await queryToken.json()).error, 'query_token_not_supported');

      const withHeader = await fetch(`${baseUrl}/api/v1/usage/calls`, { headers: { authorization: 'Bearer calls-token' } });
      assert.equal(withHeader.status, 200);
    } finally {
      server.close();
    }
  });
});
