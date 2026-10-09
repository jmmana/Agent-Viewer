// OTLP/HTTP logs receiver (issue #59): the shared rate limiter applies to /v1/logs too, and every 429 it
// sends carries Retry-After. A low AGENT_VIEWER_RATE_LIMIT, read once at module load, needs its own process,
// so this does not share a file with tests/otlp-logs.test.mjs or tests/otlp-logs-limits.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.AGENT_VIEWER_RATE_LIMIT = '3';
delete process.env.AGENT_VIEWER_API_TOKEN;
delete process.env.AGENT_VIEWER_API_KEY;

const { app } = await import('../server/index.ts');
const { OTLP_LOGS_PATH } = await import('../src/integrations/otelConstants.ts');

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

test('HTTP: the rate limiter applies to /v1/logs and every 429 carries Retry-After', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceLogs: [] }),
      });
      assert.equal(res.status, 200);
    }
    const limited = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceLogs: [] }),
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    // The rate limiter is shared with /api/v1 and keeps one response shape on both routes; only the
    // OTLP-specific checks further down the middleware chain (auth, content-type, body, shape) use the
    // OTLP-style `{code, message}` body.
    assert.equal((await limited.json()).error, 'rate_limit_exceeded');
  } finally {
    server.close();
  }
});
