// Prometheus /metrics (issue #350) has its own rate limit, separate from /api/v1's: exhausting one never
// limits the other. Its own process so the low limits do not leak into other files.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.AGENT_VIEWER_METRICS = '1';
process.env.AGENT_VIEWER_METRICS_RATE_LIMIT = '3';
process.env.AGENT_VIEWER_RATE_LIMIT = '5';
process.env.AGENT_VIEWER_API_TOKEN = 'api-token';
delete process.env.AGENT_VIEWER_API_KEY;
delete process.env.AGENT_VIEWER_METRICS_TOKEN;
delete process.env.AGENT_VIEWER_METRICS_AUTH;

const { app } = await import('../server/index.ts');

const headers = { authorization: 'Bearer api-token' };

test('/metrics and /api/v1 have separate rate limits, and a /metrics 429 carries Retry-After', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`${baseUrl}/metrics`, { headers })).status, 200);
    const limited = await fetch(`${baseUrl}/metrics`, { headers });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal((await limited.json()).error, 'rate_limit_exceeded');

    // /api/v1 still has its whole budget, and using it up does not touch /metrics' count either way.
    for (let i = 0; i < 5; i++) assert.notEqual((await fetch(`${baseUrl}/api/v1/usage`, { headers })).status, 429);
    assert.equal((await fetch(`${baseUrl}/api/v1/usage`, { headers })).status, 429);
  } finally {
    server.close();
  }
});
