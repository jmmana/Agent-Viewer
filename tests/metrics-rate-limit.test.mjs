import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Issue #103: /metrics gets its own rate-limit bucket, same AGENT_VIEWER_RATE_LIMIT but a separate counter map
// from /api/v1 (server/index.ts's metricsRateLimits), so a flood of failed scrape-token guesses against one IP
// never spends that IP's /api/v1 ingestion budget, and vice versa. Its own process, low limit, like
// tests/server-rate-limit.test.mjs (the limit is read once at module load).
//
// One test, in a fixed order: both counters are module-level singletons shared across every request this
// process sends from 127.0.0.1, within the 60s window, so a second independent test in this same file would
// inherit whatever count the first left behind instead of starting fresh.
process.env.AGENT_VIEWER_RATE_LIMIT = '3';
process.env.AGENT_VIEWER_API_TOKEN = 'rl-token';
process.env.AGENT_VIEWER_METRICS = '1';
delete process.env.AGENT_VIEWER_METRICS_TOKEN;
delete process.env.AGENT_VIEWER_API_KEY;
delete process.env.AGENT_VIEWER_WEBHOOK_SECRET;
const { app } = await import('../server/index.ts');

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

test('Rate limit: /metrics and /api/v1 trip independently, from the same IP', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    // Trip /api/v1 (limit 3/min) with failed guesses; the limiter runs before auth, so every attempt counts.
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${baseUrl}/api/v1/snapshot`, { headers: { Authorization: `Bearer guess-${attempt}` } });
      assert.equal(res.status, 401);
    }
    const trippedApi = await fetch(`${baseUrl}/api/v1/snapshot`, { headers: { Authorization: 'Bearer rl-token' } });
    assert.equal(trippedApi.status, 429);
    assert.equal((await trippedApi.json()).error, 'rate_limit_exceeded');
    assert.ok(Number(trippedApi.headers.get('retry-after')) >= 1);

    // /metrics, same IP, is unaffected: its own budget is still fresh (first request on its own counter).
    const metricsOk = await fetch(`${baseUrl}/metrics`, { headers: { Authorization: 'Bearer rl-token' } });
    assert.equal(metricsOk.status, 200);

    // Now trip /metrics too (2 more guesses reach its own limit of 3; the request above already spent 1).
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`${baseUrl}/metrics`, { headers: { Authorization: `Bearer guess-${attempt}` } });
      assert.equal(res.status, 401);
    }
    const trippedMetrics = await fetch(`${baseUrl}/metrics`, { headers: { Authorization: 'Bearer rl-token' } });
    assert.equal(trippedMetrics.status, 429);
    assert.equal((await trippedMetrics.json()).error, 'rate_limit_exceeded');

    // Health checks stay outside both buckets.
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
  } finally {
    server.close();
  }
});
