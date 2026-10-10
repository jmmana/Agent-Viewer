import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// The limit is read when the server module loads, so it is set before the dynamic import.
// node --test runs each file in its own process, so this does not leak into other files.
process.env.AGENT_VIEWER_RATE_LIMIT = '3';
process.env.AGENT_VIEWER_API_TOKEN = 'rate-limit-token';
delete process.env.AGENT_VIEWER_API_KEY;
delete process.env.AGENT_VIEWER_WEBHOOK_SECRET;
const { app } = await import('../server/index.ts');

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
