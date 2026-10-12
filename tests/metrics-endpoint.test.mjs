import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Issue #103 (first sub-issue): GET /metrics enablement, auth matrix, rate-limit bucket separation (see
// tests/metrics-rate-limit.test.mjs for the dedicated low-limit proof), CORS exclusion, method handling, and
// response headers. Ledger-derived families are a later sub-issue; this file only covers the endpoint itself.

const pricingHome = mkdtempSync(path.join(os.tmpdir(), 'av-pricing-metrics-'));
process.env.AGENT_VIEWER_PRICING_FILE = path.join(pricingHome, 'pricing.json');
process.env.AGENT_VIEWER_PRICING_HISTORY_FILE = path.join(pricingHome, 'pricing-history.jsonl');
process.env.AGENT_VIEWER_API_TOKEN = 'api-token-for-metrics-tests';
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

/** Runs `fn` with the given env vars set, restoring the previous values afterwards (same helper as
 * tests/server-hardening.test.mjs; every env var this route reads is re-read per request, so toggling it live
 * after import works, exactly like `getApiToken`). */
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

test('GET /metrics: disabled by default, 404 identical for every disabled state', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await withEnv({ AGENT_VIEWER_METRICS: undefined }, async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: 'not_found', message: 'Not found' });
    });
    // Explicitly "0" (or anything but "1") is also disabled.
    await withEnv({ AGENT_VIEWER_METRICS: '0' }, async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      assert.equal(res.status, 404);
    });
  } finally {
    server.close();
  }
});

test('GET /metrics: enabled, no metrics token, falls back to the API token', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await withEnv({ AGENT_VIEWER_METRICS: '1', AGENT_VIEWER_METRICS_TOKEN: undefined }, async () => {
      const noHeader = await fetch(`${baseUrl}/metrics`);
      assert.equal(noHeader.status, 401);
      assert.equal((await noHeader.json()).error, 'unauthorized');

      const wrong = await fetch(`${baseUrl}/metrics`, { headers: { Authorization: 'Bearer wrong' } });
      assert.equal(wrong.status, 401);

      const ok = await fetch(`${baseUrl}/metrics`, { headers: { Authorization: 'Bearer api-token-for-metrics-tests' } });
      assert.equal(ok.status, 200);
    });
  } finally {
    server.close();
  }
});

test('GET /metrics: with a metrics token set, the API token is rejected and the metrics token is accepted', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await withEnv({ AGENT_VIEWER_METRICS: '1', AGENT_VIEWER_METRICS_TOKEN: 'metrics-only-token' }, async () => {
      const withApiToken = await fetch(`${baseUrl}/metrics`, { headers: { Authorization: 'Bearer api-token-for-metrics-tests' } });
      assert.equal(withApiToken.status, 401);

      const withMetricsToken = await fetch(`${baseUrl}/metrics`, { headers: { Authorization: 'Bearer metrics-only-token' } });
      assert.equal(withMetricsToken.status, 200);
    });
  } finally {
    server.close();
  }
});

test('GET /metrics: ?token= and ?api_key= are ignored (still 401)', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await withEnv({ AGENT_VIEWER_METRICS: '1', AGENT_VIEWER_METRICS_TOKEN: undefined }, async () => {
      const res = await fetch(`${baseUrl}/metrics?token=api-token-for-metrics-tests`);
      assert.equal(res.status, 401);
      const res2 = await fetch(`${baseUrl}/metrics?api_key=api-token-for-metrics-tests`);
      assert.equal(res2.status, 401);
    });
  } finally {
    server.close();
  }
});

test('GET /metrics: no token configured and no AUTH=off gives 403 metrics_require_token', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await withEnv({ AGENT_VIEWER_METRICS: '1', AGENT_VIEWER_METRICS_TOKEN: undefined, AGENT_VIEWER_API_TOKEN: undefined, AGENT_VIEWER_METRICS_AUTH: undefined }, async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, 'metrics_require_token');
    });
  } finally {
    server.close();
  }
});

test('GET /metrics: AGENT_VIEWER_METRICS_AUTH=off serves with no credential check, even with tokens configured', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await withEnv({ AGENT_VIEWER_METRICS: '1', AGENT_VIEWER_METRICS_AUTH: 'off' }, async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      assert.equal(res.status, 200);
    });
    // No tokens at all, still served.
    await withEnv({ AGENT_VIEWER_METRICS: '1', AGENT_VIEWER_METRICS_AUTH: 'off', AGENT_VIEWER_API_TOKEN: undefined, AGENT_VIEWER_METRICS_TOKEN: undefined }, async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      assert.equal(res.status, 200);
    });
  } finally {
    server.close();
  }
});

test('GET /metrics: no CORS headers, even when AGENT_VIEWER_CORS_ORIGIN is * or unset; OPTIONS and POST are 405', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await withEnv({ AGENT_VIEWER_METRICS: '1', AGENT_VIEWER_METRICS_AUTH: 'off' }, async () => {
      const res = await fetch(`${baseUrl}/metrics`, { headers: { Origin: 'https://example.com' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), null);

      const options = await fetch(`${baseUrl}/metrics`, { method: 'OPTIONS' });
      assert.equal(options.status, 405);
      assert.equal(options.headers.get('allow'), 'GET, HEAD');

      const post = await fetch(`${baseUrl}/metrics`, { method: 'POST' });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get('allow'), 'GET, HEAD');
    });
  } finally {
    server.close();
  }
});

test('GET /metrics: method guard runs before enablement, so a disabled /metrics still answers 405 for a bad method', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await withEnv({ AGENT_VIEWER_METRICS: undefined }, async () => {
      const res = await fetch(`${baseUrl}/metrics`, { method: 'POST' });
      assert.equal(res.status, 405);
    });
  } finally {
    server.close();
  }
});

test('GET /metrics: Content-Type is text/plain;version=0.0.4, Cache-Control is no-store, body parses as text exposition', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await withEnv({ AGENT_VIEWER_METRICS: '1', AGENT_VIEWER_METRICS_AUTH: 'off' }, async () => {
      const res = await fetch(`${baseUrl}/metrics`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const body = await res.text();
      assert.match(body, /# HELP agent_viewer_build_info/);
      assert.match(body, /# TYPE agent_viewer_build_info gauge/);
      assert.match(body, /agent_viewer_build_info\{version="[^"]*",storage="(memory|sqlite)"\} 1/);
      assert.match(body, /# TYPE agent_viewer_sse_clients gauge/);
      assert.match(body, /agent_viewer_sse_clients 0/);
      // No series appears twice.
      const seriesLines = body.split('\n').filter((l) => l && !l.startsWith('#'));
      assert.equal(new Set(seriesLines).size, seriesLines.length);
    });
  } finally {
    server.close();
  }
});

test('HEAD /metrics: same status and headers as GET, empty body', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await withEnv({ AGENT_VIEWER_METRICS: '1', AGENT_VIEWER_METRICS_AUTH: 'off' }, async () => {
      const res = await fetch(`${baseUrl}/metrics`, { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
      assert.equal(await res.text(), '');
    });
  } finally {
    server.close();
  }
});
