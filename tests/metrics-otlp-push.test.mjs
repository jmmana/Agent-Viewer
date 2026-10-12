// Issue #103 (sub-issue #349): the optional OTLP metrics push. Config parsing and the OTLP JSON encoder are pure
// and tested directly with no network (Sections A-B). The worker is tested against a real local HTTP collector
// (Section C, same style as tests/budget-alert-delivery.test.mjs's own Section F), using its `pushNow()` escape
// hatch so no test ever waits out a real interval or a real backoff delay; `computeOtlpPushBackoffMs` is tested as
// pure math instead (Section D). Section E proves the worker starts and reaches a real collector end to end from
// `server/index.ts` with `AGENT_VIEWER_METRICS` left unset, i.e. independent of the Prometheus endpoint itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseOtlpMetricsPushConfig,
  buildOtlpMetricsPayload,
  attemptOtlpMetricsPush,
  computeOtlpPushBackoffMs,
  buildOtlpPushFamilies,
  startOtlpMetricsPush,
  OTLP_PUSH_MAX_BACKOFF_MS,
} from '../server/otlpMetricsPush.ts';

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

async function waitFor(check, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error('waitFor: timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const sampleFamilies = [
  {
    name: 'agent_viewer_llm_calls_total',
    help: 'Model calls.',
    type: 'counter',
    samples: [{ labels: { provider: 'anthropic', model: 'claude' }, value: 42 }],
  },
  {
    name: 'agent_viewer_cost_reported_total',
    help: 'Reported cost.',
    type: 'counter',
    samples: [{ labels: { provider: 'anthropic', model: 'claude', currency: 'USD' }, value: 18.4021 }],
  },
  { name: 'agent_viewer_tokens_total', help: 'Tokens.', type: 'counter', samples: [] },
  { name: 'agent_viewer_sse_clients', help: 'Open SSE connections.', type: 'gauge', samples: [{ labels: {}, value: 3 }] },
];

// -------------------------------------------------------------
// A. Config parsing
// -------------------------------------------------------------

test('otlp push config: unset endpoint is off, no callback', () => {
  let called = false;
  const config = parseOtlpMetricsPushConfig({}, () => { called = true; });
  assert.equal(config, null);
  assert.equal(called, false);
});

test('otlp push config: blank endpoint is off', () => {
  const config = parseOtlpMetricsPushConfig({ AGENT_VIEWER_OTLP_METRICS_ENDPOINT: '   ' });
  assert.equal(config, null);
});

test('otlp push config: an unparsable URL disables the push without throwing, and calls onInvalidEndpoint', () => {
  const messages = [];
  const config = parseOtlpMetricsPushConfig(
    { AGENT_VIEWER_OTLP_METRICS_ENDPOINT: 'not a url at all' },
    (message) => messages.push(message)
  );
  assert.equal(config, null);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /AGENT_VIEWER_OTLP_METRICS_ENDPOINT/);
});

test('otlp push config: a non-http(s) scheme is rejected at startup without throwing', () => {
  const messages = [];
  const config = parseOtlpMetricsPushConfig(
    { AGENT_VIEWER_OTLP_METRICS_ENDPOINT: 'ftp://collector:21/metrics' },
    (message) => messages.push(message)
  );
  assert.equal(config, null);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /http or https/);
});

test('otlp push config: a valid endpoint parses with defaults', () => {
  const config = parseOtlpMetricsPushConfig({ AGENT_VIEWER_OTLP_METRICS_ENDPOINT: 'http://collector:4318/v1/metrics' });
  assert.deepEqual(config, {
    endpoint: 'http://collector:4318/v1/metrics',
    headers: {},
    intervalMs: 60000,
    timeoutMs: 10000,
  });
});

test('otlp push config: headers parse k=v,k2=v2, skipping a malformed pair and keeping "=" inside a value', () => {
  const config = parseOtlpMetricsPushConfig({
    AGENT_VIEWER_OTLP_METRICS_ENDPOINT: 'https://collector/v1/metrics',
    AGENT_VIEWER_OTLP_METRICS_HEADERS: 'authorization=Bearer abc, no-equals-sign , x-extra=a=b=c',
  });
  assert.deepEqual(config.headers, { authorization: 'Bearer abc', 'x-extra': 'a=b=c' });
});

test('otlp push config: interval below the 5000ms floor is raised, not rejected', () => {
  const config = parseOtlpMetricsPushConfig({
    AGENT_VIEWER_OTLP_METRICS_ENDPOINT: 'https://collector/v1/metrics',
    AGENT_VIEWER_OTLP_METRICS_INTERVAL_MS: '100',
  });
  assert.equal(config.intervalMs, 5000);
});

test('otlp push config: a non-numeric interval or timeout throws (fails startup like every other numeric env here)', () => {
  assert.throws(
    () =>
      parseOtlpMetricsPushConfig({
        AGENT_VIEWER_OTLP_METRICS_ENDPOINT: 'https://collector/v1/metrics',
        AGENT_VIEWER_OTLP_METRICS_INTERVAL_MS: 'soon',
      }),
    /AGENT_VIEWER_OTLP_METRICS_INTERVAL_MS/
  );
  assert.throws(
    () =>
      parseOtlpMetricsPushConfig({
        AGENT_VIEWER_OTLP_METRICS_ENDPOINT: 'https://collector/v1/metrics',
        AGENT_VIEWER_OTLP_METRICS_TIMEOUT_MS: '-5',
      }),
    /AGENT_VIEWER_OTLP_METRICS_TIMEOUT_MS/
  );
});

// -------------------------------------------------------------
// B. OTLP JSON payload encoding
// -------------------------------------------------------------

test('otlp payload: integer counters use asInt (decimal string), float counters use asDouble', () => {
  const payload = buildOtlpMetricsPayload(sampleFamilies, {
    serviceVersion: '1.2.3',
    nowUnixNano: '1760003600000000000',
    startTimeUnixNanoFor: () => '1760000000000000000',
  });
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
  const calls = metrics.find((m) => m.name === 'agent_viewer_llm_calls_total');
  assert.deepEqual(calls.sum.dataPoints[0].asInt, '42');
  assert.equal(calls.sum.dataPoints[0].asDouble, undefined);
  const cost = metrics.find((m) => m.name === 'agent_viewer_cost_reported_total');
  assert.equal(cost.sum.dataPoints[0].asDouble, 18.4021);
  assert.equal(cost.sum.dataPoints[0].asInt, undefined);
});

test('otlp payload: counters are cumulative monotonic sums with a start time; gauges have none', () => {
  const payload = buildOtlpMetricsPayload(sampleFamilies, {
    serviceVersion: '1.2.3',
    nowUnixNano: '1760003600000000000',
    startTimeUnixNanoFor: () => '1760000000000000000',
  });
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
  const calls = metrics.find((m) => m.name === 'agent_viewer_llm_calls_total');
  assert.equal(calls.sum.aggregationTemporality, 2);
  assert.equal(calls.sum.isMonotonic, true);
  assert.equal(calls.sum.dataPoints[0].startTimeUnixNano, '1760000000000000000');
  assert.equal(calls.sum.dataPoints[0].timeUnixNano, '1760003600000000000');

  const gauge = metrics.find((m) => m.name === 'agent_viewer_sse_clients');
  assert.ok(gauge.gauge);
  assert.equal(gauge.gauge.dataPoints[0].startTimeUnixNano, undefined);
  assert.equal(gauge.gauge.dataPoints[0].timeUnixNano, '1760003600000000000');
});

test('otlp payload: a family with zero samples is omitted entirely; attributes carry the labels', () => {
  const payload = buildOtlpMetricsPayload(sampleFamilies, {
    serviceVersion: '1.2.3',
    nowUnixNano: '1',
    startTimeUnixNanoFor: () => '0',
  });
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
  assert.equal(metrics.some((m) => m.name === 'agent_viewer_tokens_total'), false);
  const calls = metrics.find((m) => m.name === 'agent_viewer_llm_calls_total');
  assert.deepEqual(calls.sum.dataPoints[0].attributes, [
    { key: 'provider', value: { stringValue: 'anthropic' } },
    { key: 'model', value: { stringValue: 'claude' } },
  ]);
});

test('otlp payload: resource attributes and scope name', () => {
  const payload = buildOtlpMetricsPayload(sampleFamilies, {
    serviceVersion: '9.9.9',
    nowUnixNano: '1',
    startTimeUnixNanoFor: () => '0',
  });
  assert.deepEqual(payload.resourceMetrics[0].resource.attributes, [
    { key: 'service.name', value: { stringValue: 'agent-viewer' } },
    { key: 'service.version', value: { stringValue: '9.9.9' } },
  ]);
  assert.equal(payload.resourceMetrics[0].scopeMetrics[0].scope.name, 'agent-viewer');
});

test('otlp payload: every family empty returns null (nothing to send)', () => {
  const payload = buildOtlpMetricsPayload(
    [{ name: 'agent_viewer_tokens_total', help: 'h', type: 'counter', samples: [] }],
    { serviceVersion: '1', nowUnixNano: '1', startTimeUnixNanoFor: () => '0' }
  );
  assert.equal(payload, null);
});

// -------------------------------------------------------------
// C. One push attempt, against a real local HTTP collector
// -------------------------------------------------------------

test('otlp push attempt: 2xx is success', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200).end('ok');
  });
  const port = await listen(server);
  try {
    const outcome = await attemptOtlpMetricsPush(
      { endpoint: `http://127.0.0.1:${port}/v1/metrics`, headers: {}, intervalMs: 60000, timeoutMs: 2000 },
      { resourceMetrics: [] },
      { fetchImpl: fetch, now: Date.now }
    );
    assert.deepEqual(outcome, { kind: 'success', status: 200 });
  } finally {
    await closeServer(server);
  }
});

test('otlp push attempt: the collector receives valid OTLP/HTTP JSON with the configured headers', async () => {
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received = { headers: req.headers, json: JSON.parse(body) };
      res.writeHead(200).end();
    });
  });
  const port = await listen(server);
  try {
    const payload = buildOtlpMetricsPayload(sampleFamilies, {
      serviceVersion: '1.0.0',
      nowUnixNano: '1760003600000000000',
      startTimeUnixNanoFor: () => '1760000000000000000',
    });
    await attemptOtlpMetricsPush(
      { endpoint: `http://127.0.0.1:${port}/v1/metrics`, headers: { authorization: 'Bearer secret-token' }, intervalMs: 60000, timeoutMs: 2000 },
      payload,
      { fetchImpl: fetch, now: Date.now }
    );
    assert.equal(received.headers['content-type'], 'application/json');
    assert.equal(received.headers.authorization, 'Bearer secret-token');
    assert.ok(Array.isArray(received.json.resourceMetrics));
  } finally {
    await closeServer(server);
  }
});

test('otlp push attempt: collector down (connection refused) is a retry outcome, not a throw', async () => {
  const server = http.createServer(() => {});
  const port = await listen(server);
  await closeServer(server); // nothing listens on `port` anymore
  const outcome = await attemptOtlpMetricsPush(
    { endpoint: `http://127.0.0.1:${port}/v1/metrics`, headers: {}, intervalMs: 60000, timeoutMs: 2000 },
    { resourceMetrics: [] },
    { fetchImpl: fetch, now: Date.now }
  );
  assert.equal(outcome.kind, 'retry');
  assert.equal(outcome.status, null);
});

test('otlp push attempt: a slow collector times out as a retry outcome', async () => {
  const server = http.createServer((_req, res) => {
    setTimeout(() => res.writeHead(200).end(), 2000);
  });
  const port = await listen(server);
  try {
    const outcome = await attemptOtlpMetricsPush(
      { endpoint: `http://127.0.0.1:${port}/v1/metrics`, headers: {}, intervalMs: 60000, timeoutMs: 100 },
      { resourceMetrics: [] },
      { fetchImpl: fetch, now: Date.now }
    );
    assert.equal(outcome.kind, 'retry');
    assert.equal(outcome.status, null);
  } finally {
    await closeServer(server);
  }
});

test('otlp push attempt: 429 with Retry-After is a retry outcome carrying the delay', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(429, { 'Retry-After': '7' }).end();
  });
  const port = await listen(server);
  try {
    const outcome = await attemptOtlpMetricsPush(
      { endpoint: `http://127.0.0.1:${port}/v1/metrics`, headers: {}, intervalMs: 60000, timeoutMs: 2000 },
      { resourceMetrics: [] },
      { fetchImpl: fetch, now: Date.now }
    );
    assert.equal(outcome.kind, 'retry');
    assert.equal(outcome.status, 429);
    assert.equal(outcome.retryAfterMs, 7000);
  } finally {
    await closeServer(server);
  }
});

test('otlp push attempt: 5xx is a retry outcome, other 4xx is terminal (not retried until the next interval)', async () => {
  for (const [status, expectedKind] of [[503, 'retry'], [400, 'terminal'], [401, 'terminal'], [404, 'terminal']]) {
    const server = http.createServer((_req, res) => res.writeHead(status).end());
    const port = await listen(server);
    try {
      const outcome = await attemptOtlpMetricsPush(
        { endpoint: `http://127.0.0.1:${port}/v1/metrics`, headers: {}, intervalMs: 60000, timeoutMs: 2000 },
        { resourceMetrics: [] },
        { fetchImpl: fetch, now: Date.now }
      );
      assert.equal(outcome.kind, expectedKind, `status ${status}`);
      assert.equal(outcome.status, status);
    } finally {
      await closeServer(server);
    }
  }
});

// -------------------------------------------------------------
// D. Backoff math
// -------------------------------------------------------------

test('otlp push backoff: doubles per attempt and is capped at 5 minutes', () => {
  const noJitter = () => 1; // pins the delay to the ceiling for a readable assertion
  assert.equal(computeOtlpPushBackoffMs(1, null, noJitter), 5000);
  assert.equal(computeOtlpPushBackoffMs(2, null, noJitter), 10000);
  assert.equal(computeOtlpPushBackoffMs(3, null, noJitter), 20000);
  // 2^8 * 5000 = 1,280,000ms, far past the 5-minute cap.
  assert.equal(computeOtlpPushBackoffMs(9, null, noJitter), OTLP_PUSH_MAX_BACKOFF_MS);
});

test('otlp push backoff: a Retry-After value raises the floor but never exceeds the 5-minute cap', () => {
  const noJitter = () => 0; // pins the delay to the floor
  assert.equal(computeOtlpPushBackoffMs(1, 60_000, noJitter), 60_000);
  assert.equal(computeOtlpPushBackoffMs(1, 10 * 60 * 1000, noJitter), OTLP_PUSH_MAX_BACKOFF_MS);
});

// -------------------------------------------------------------
// E. The worker: stats families, pushNow() against a real collector, headers never logged
// -------------------------------------------------------------

test('otlp push worker: buildOtlpPushFamilies omits the last-success gauge sample until the first success', () => {
  const before = buildOtlpPushFamilies({ total: { ok: 0, error: 0 }, lastSuccessUnixSeconds: null });
  const lastSuccess = before.find((f) => f.name === 'agent_viewer_otlp_push_last_success_timestamp_seconds');
  assert.deepEqual(lastSuccess.samples, []);

  const after = buildOtlpPushFamilies({ total: { ok: 1, error: 0 }, lastSuccessUnixSeconds: 1700000000 });
  const lastSuccessAfter = after.find((f) => f.name === 'agent_viewer_otlp_push_last_success_timestamp_seconds');
  assert.deepEqual(lastSuccessAfter.samples, [{ labels: {}, value: 1700000000 }]);
  const total = after.find((f) => f.name === 'agent_viewer_otlp_push_total');
  assert.deepEqual(total.samples, [
    { labels: { outcome: 'ok' }, value: 1 },
    { labels: { outcome: 'error' }, value: 0 },
  ]);
});

test('otlp push worker: pushNow() against a live collector records a success and the timestamp', async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(200).end());
  });
  const port = await listen(server);
  const worker = startOtlpMetricsPush({
    config: { endpoint: `http://127.0.0.1:${port}/v1/metrics`, headers: {}, intervalMs: 60000, timeoutMs: 2000 },
    collectFamilies: () => sampleFamilies,
    serviceVersion: '1.0.0',
    now: () => 1_700_000_000_000,
    log: () => {},
  });
  try {
    await worker.pushNow();
    assert.deepEqual(worker.getStats(), { total: { ok: 1, error: 0 }, lastSuccessUnixSeconds: 1_700_000_000 });
  } finally {
    await worker.stop();
    await closeServer(server);
  }
});

test('otlp push worker: a down collector is counted as an error outcome, and the worker logs no header value or endpoint', async () => {
  const server = http.createServer(() => {});
  const port = await listen(server);
  await closeServer(server);
  const logs = [];
  const worker = startOtlpMetricsPush({
    config: {
      endpoint: `http://127.0.0.1:${port}/v1/metrics`,
      headers: { authorization: 'Bearer super-secret-token' },
      intervalMs: 60000,
      timeoutMs: 500,
    },
    collectFamilies: () => sampleFamilies,
    serviceVersion: '1.0.0',
    log: (message) => logs.push(message),
  });
  try {
    await worker.pushNow();
    const stats = worker.getStats();
    assert.equal(stats.total.error, 1);
    assert.equal(stats.lastSuccessUnixSeconds, null);
    for (const message of logs) {
      assert.doesNotMatch(message, /super-secret-token/);
      assert.doesNotMatch(message, new RegExp(String(port)));
    }
  } finally {
    await worker.stop();
  }
});

test('otlp push worker: nothing to send (every family empty) is neither a success nor an error', async () => {
  const worker = startOtlpMetricsPush({
    config: { endpoint: 'http://127.0.0.1:1/v1/metrics', headers: {}, intervalMs: 60000, timeoutMs: 500 },
    collectFamilies: () => [{ name: 'agent_viewer_tokens_total', help: 'h', type: 'counter', samples: [] }],
    serviceVersion: '1.0.0',
    log: () => {},
  });
  try {
    await worker.pushNow();
    assert.deepEqual(worker.getStats(), { total: { ok: 0, error: 0 }, lastSuccessUnixSeconds: null });
  } finally {
    await worker.stop();
  }
});

// -------------------------------------------------------------
// F. End-to-end: the real server starts the push independently of AGENT_VIEWER_METRICS
// -------------------------------------------------------------

test('otlp push end-to-end: server/index.ts pushes to a real collector with /metrics left disabled', async () => {
  let received = null;
  const collector = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200).end();
    });
  });
  const collectorPort = await listen(collector);

  const pricingHome = mkdtempSync(path.join(os.tmpdir(), 'av-pricing-otlp-push-'));
  process.env.AGENT_VIEWER_PRICING_FILE = path.join(pricingHome, 'pricing.json');
  process.env.AGENT_VIEWER_PRICING_HISTORY_FILE = path.join(pricingHome, 'pricing-history.jsonl');
  process.env.AGENT_VIEWER_OTLP_METRICS_ENDPOINT = `http://127.0.0.1:${collectorPort}/v1/metrics`;
  process.env.AGENT_VIEWER_OTLP_METRICS_INTERVAL_MS = '5000'; // the documented floor; the test waits this out once
  delete process.env.AGENT_VIEWER_METRICS; // left disabled on purpose: the push must not depend on it
  process.env.AGENT_VIEWER_API_TOKEN = 'api-token-for-otlp-push-e2e';
  delete process.env.AGENT_VIEWER_API_KEY;
  delete process.env.AGENT_VIEWER_WEBHOOK_SECRET;

  const { app } = await import('../server/index.ts');
  const server = http.createServer(app);
  const appPort = await listen(server);
  try {
    const metricsResponse = await fetch(`http://127.0.0.1:${appPort}/metrics`);
    assert.equal(metricsResponse.status, 404, '/metrics stays disabled: the push does not turn it on');

    await waitFor(() => received !== null, { timeoutMs: 8000, intervalMs: 50 });
    assert.ok(Array.isArray(received.resourceMetrics));
    const serviceName = received.resourceMetrics[0].resource.attributes.find((a) => a.key === 'service.name');
    assert.equal(serviceName.value.stringValue, 'agent-viewer');
  } finally {
    await closeServer(server);
    await closeServer(collector);
  }
});
