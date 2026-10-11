import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// The limit is read when the server module loads, so it is set before the dynamic import.
// node --test runs each file in its own process, so this does not leak into other files.
process.env.AGENT_VIEWER_RATE_LIMIT = '3';
process.env.AGENT_VIEWER_API_TOKEN = 'rate-limit-token';
delete process.env.AGENT_VIEWER_API_KEY;
delete process.env.AGENT_VIEWER_WEBHOOK_SECRET;
const { app, store } = await import('../server/index.ts');
const { validateCanonicalEvent } = await import('../src/integrations/canonicalContract.ts');
const { parseRollupQuery } = await import('../server/usage/rollup.ts');

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('Rate limit: failed authentication attempts count toward the limit (limiter runs before auth)', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${baseUrl}/api/v1/snapshot`, { headers: { Authorization: `Bearer guess-${attempt}` } });
      assert.equal(res.status, 401);
    }

    // The budget is spent by the failed guesses, so even the right token is throttled now.
    const res = await fetch(`${baseUrl}/api/v1/snapshot`, { headers: { Authorization: 'Bearer rate-limit-token' } });
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error, 'rate_limit_exceeded');
    // Issue #59: every 429 this limiter sends carries Retry-After, so OTLP exporters (and any other
    // well-behaved client) back off instead of retrying immediately.
    assert.ok(Number(res.headers.get('retry-after')) >= 1);

    // Health checks stay outside /api/v1 and are not throttled.
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
  } finally {
    server.close();
  }
});

// Issue #89, rule 8: Agent Viewer's own ingest-limiter 429 (`rate_limit_exceeded`, tripped above) must never be
// confused with a provider's own `llm.failed` / `errorKind: "rate_limited"` row. A 429 from this limiter is
// rejected before the route handler ever runs (`server/index.ts`'s limiter sits ahead of every /api/v1 route),
// so no event is ever appended and the usage ledger never sees it; `rateLimitCount` only ever reads
// `usage_ledger.error_kind`, which this 429 never touches. Because the limiter also guards the rollup endpoint
// itself (so querying it over HTTP right after tripping the limit would just get its own 429), this reads the
// rollup directly from the exported `store`, same as the issue's own instruction.
test('Rate limit: the ingest limiter\'s own 429 never increments rateLimitCount (store read directly, limiter also guards the rollup route)', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    // One genuine provider rate-limit failure: this is the only thing that should ever count.
    const genuineFailure = validateCanonicalEvent({
      id: 'evt_rate_limit_pin_genuine',
      type: 'llm.failed',
      timestamp: Date.now(),
      source: 'agent:rate-limit-pin',
      agentId: 'rate-limit-pin',
      summary: 'genuine provider rate limit',
      payload: { provider: 'rate-limit-pin-provider', model: 'm', errorKind: 'rate_limited', cost: null, currency: null },
    });
    assert.ok(genuineFailure.success, JSON.stringify(genuineFailure.issues));
    const appended = await store.append(genuineFailure.data);
    assert.equal(appended.outcome, 'accepted');

    // Trip the ingest limiter with more requests than its budget, exactly like the test above; none of these
    // ever reaches a route handler, so none of them can ever append an event.
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(`${baseUrl}/api/v1/snapshot`, { headers: { Authorization: `Bearer guess-${attempt}` } });
      assert.ok(res.status === 401 || res.status === 429, `unexpected status ${res.status}`);
    }
    const tripped = await fetch(`${baseUrl}/api/v1/snapshot`, { headers: { Authorization: 'Bearer rate-limit-token' } });
    assert.equal(tripped.status, 429);
    assert.equal((await tripped.json()).error, 'rate_limit_exceeded');

    const result = await store.rollup(
      parseRollupQuery({ groupBy: 'provider', provider: 'rate-limit-pin-provider', include: 'failures' })
    );
    assert.equal(result.totals.failures.rateLimitCount, 1);
    assert.equal(result.totals.failedCalls, 1);
  } finally {
    server.close();
  }
});
