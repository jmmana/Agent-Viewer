// Prometheus /metrics endpoint (issue #350): opt-in, auth, methods, headers and the in-process metrics.
// Every setting is read per request, so each test flips process.env directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

delete process.env.AGENT_VIEWER_METRICS;
delete process.env.AGENT_VIEWER_METRICS_TOKEN;
delete process.env.AGENT_VIEWER_METRICS_AUTH;
delete process.env.AGENT_VIEWER_API_KEY;
process.env.AGENT_VIEWER_API_TOKEN = 'api-token';
process.env.AGENT_VIEWER_METRICS_RATE_LIMIT = '100000';

const { app } = await import('../server/index.ts');

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

const { server, baseUrl } = await startTestServer();
test.after(() => server.close());

function withEnv(values, fn) {
  return async () => {
    const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });

/** Every non-empty line is a HELP/TYPE comment or a `name{labels} value` sample. */
function assertValidExposition(body) {
  assert.ok(body.endsWith('\n'));
  for (const line of body.split('\n').filter(Boolean)) {
    assert.match(
      line,
      /^(# (HELP|TYPE) [a-zA-Z_:][a-zA-Z0-9_:]* .*|[a-zA-Z_:][a-zA-Z0-9_:]*(\{([a-zA-Z_][a-zA-Z0-9_]*="([^"\\\n]|\\.)*",?)*\})? (NaN|[+-]Inf|-?[0-9.e+-]+))$/,
      line,
    );
  }
}

test('off by default: /metrics is the same 404 as an unknown path', async () => {
  const metrics = await fetch(`${baseUrl}/metrics`, { headers: bearer('api-token') });
  const unknown = await fetch(`${baseUrl}/no-such-path`, { headers: bearer('api-token') });
  assert.equal(metrics.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(metrics.headers.get('content-type'), unknown.headers.get('content-type'));
  assert.equal((await metrics.text()).replace('/metrics', '/X'), (await unknown.text()).replace('/no-such-path', '/X'));
  assert.equal((await fetch(`${baseUrl}/metrics`, { method: 'POST' })).status, 404);
});

test('enabled: GET with the API token returns Prometheus text with build info and SSE clients', withEnv({ AGENT_VIEWER_METRICS: '1' }, async () => {
  const res = await fetch(`${baseUrl}/metrics`, { headers: bearer('api-token') });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'mounted before CORS');
  const body = await res.text();
  assertValidExposition(body);
  assert.match(body, /^# TYPE agent_viewer_build_info gauge$/m);
  assert.match(body, /^agent_viewer_build_info\{version="[^"]+",storage="(memory|sqlite)"\} 1$/m);
  assert.match(body, /^# TYPE agent_viewer_sse_clients gauge$/m);
  assert.match(body, /^agent_viewer_sse_clients 0$/m);
}));

test('enabled: HEAD returns the headers and no body', withEnv({ AGENT_VIEWER_METRICS: '1' }, async () => {
  const res = await fetch(`${baseUrl}/metrics`, { method: 'HEAD', headers: bearer('api-token') });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/plain; version=0.0.4; charset=utf-8');
  assert.equal(await res.text(), '');
}));

test('enabled: other methods are 405 with Allow: GET, HEAD', withEnv({ AGENT_VIEWER_METRICS: '1' }, async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const res = await fetch(`${baseUrl}/metrics`, { method, headers: { ...bearer('api-token'), 'content-type': 'application/json' }, body: method === 'POST' || method === 'PUT' ? '{}' : undefined });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
  }
}));

test('auth: missing or wrong token is 401, and ?token=/?api_key= never authenticate', withEnv({ AGENT_VIEWER_METRICS: '1' }, async () => {
  assert.equal((await fetch(`${baseUrl}/metrics`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/metrics`, { headers: bearer('nope') })).status, 401);
  assert.equal((await fetch(`${baseUrl}/metrics?token=api-token`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/metrics?api_key=api-token`)).status, 401);
}));

test('auth: AGENT_VIEWER_METRICS_TOKEN replaces the API token', withEnv({ AGENT_VIEWER_METRICS: '1', AGENT_VIEWER_METRICS_TOKEN: 'scrape' }, async () => {
  assert.equal((await fetch(`${baseUrl}/metrics`, { headers: bearer('scrape') })).status, 200);
  assert.equal((await fetch(`${baseUrl}/metrics`, { headers: bearer('api-token') })).status, 401);
}));

test('auth: no token at all is 403 metrics_require_token unless AGENT_VIEWER_METRICS_AUTH=off', withEnv({ AGENT_VIEWER_METRICS: '1', AGENT_VIEWER_API_TOKEN: undefined }, async () => {
  const res = await fetch(`${baseUrl}/metrics`);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'metrics_require_token');
  process.env.AGENT_VIEWER_METRICS_AUTH = 'off';
  try {
    assert.equal((await fetch(`${baseUrl}/metrics`)).status, 200);
  } finally {
    delete process.env.AGENT_VIEWER_METRICS_AUTH;
  }
}));

test('the SSE clients gauge follows open streams', withEnv({ AGENT_VIEWER_METRICS: '1' }, async () => {
  const controller = new AbortController();
  const stream = await fetch(`${baseUrl}/api/v1/events/stream`, { headers: bearer('api-token'), signal: controller.signal });
  assert.equal(stream.status, 200);
  try {
    // The stream flushes its headers before it registers the client, so poll briefly.
    const deadline = Date.now() + 5000;
    let body = '';
    while (Date.now() < deadline) {
      body = await (await fetch(`${baseUrl}/metrics`, { headers: bearer('api-token') })).text();
      if (/^agent_viewer_sse_clients 1$/m.test(body)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(body, /^agent_viewer_sse_clients 1$/m);
  } finally {
    controller.abort();
  }
}));
