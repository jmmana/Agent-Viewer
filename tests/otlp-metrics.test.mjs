// OTLP/HTTP metrics receiver (issue #73): pure mapper, series-key privacy, and the POST /v1/metrics route
// itself. Capacity truncation and the delta/cumulative/windowed math live in tests/event-store.test.mjs and
// tests/telemetry.test.mjs instead, since they need a store instance this file's shared `app`/`store` singleton
// cannot give them (see the comment above `test('capacity ...')` equivalents there for why).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import {
  mapOtlpMetricsRequest,
  looksLikeOtlpMetricsRequest,
  countMetricDataPoints,
} from '../server/otlp/metrics.ts';
import { reconciliationFieldForType } from '../server/otlp/metricsMap.ts';
import { sessionIdentity } from '../src/integrations/claudeCodeIdentity.ts';
import { OTLP_METRICS_PATH } from '../src/integrations/otelConstants.ts';
import { app, store } from '../server/index.ts';

const fixturesDir = path.join(import.meta.dirname, 'fixtures/otlp');
const SECRET = Buffer.alloc(32, 9);

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

// -------------------------------------------------------------
// Synthetic body builders
// -------------------------------------------------------------
function attr(key, stringValue) {
  return { key, value: { stringValue } };
}

function tokenUsageMetric(dataPoints) {
  return { name: 'claude_code.token.usage', unit: 'tokens', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints } };
}

function costUsageMetric(dataPoints, unit = 'USD') {
  return { name: 'claude_code.cost.usage', unit, sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints } };
}

function dataPoint({ sessionId, model, type, asInt, asDouble, start = '1000000000', time = '2000000000', flags, extraAttrs = [] }) {
  const attributes = [];
  if (sessionId !== undefined) attributes.push(attr('session.id', sessionId));
  if (model !== undefined) attributes.push(attr('model', model));
  if (type !== undefined) attributes.push(attr('type', type));
  attributes.push(...extraAttrs);
  return {
    startTimeUnixNano: start,
    timeUnixNano: time,
    ...(asInt !== undefined ? { asInt } : {}),
    ...(asDouble !== undefined ? { asDouble } : {}),
    ...(flags !== undefined ? { flags } : {}),
    attributes,
  };
}

function metricsBody(metrics, resourceAttrs = [attr('service.name', 'claude-code')]) {
  return { resourceMetrics: [{ resource: { attributes: resourceAttrs }, scopeMetrics: [{ metrics }] }] };
}

// -------------------------------------------------------------
// Pure mapper
// -------------------------------------------------------------

test('looksLikeOtlpMetricsRequest / countMetricDataPoints', () => {
  assert.ok(looksLikeOtlpMetricsRequest({ resourceMetrics: [] }));
  assert.ok(!looksLikeOtlpMetricsRequest({}));
  assert.ok(!looksLikeOtlpMetricsRequest(null));
  const body = metricsBody([
    tokenUsageMetric([dataPoint({ sessionId: 's1', model: 'm', type: 'input', asInt: '10' })]),
    costUsageMetric([dataPoint({ sessionId: 's1', asDouble: 0.5 })]),
  ]);
  assert.equal(countMetricDataPoints(body), 2);
});

test('mapper: the four token types map to the documented reconciliation fields', () => {
  const body = metricsBody([
    tokenUsageMetric([
      dataPoint({ sessionId: 's1', model: 'm', type: 'input', asInt: '100' }),
      dataPoint({ sessionId: 's1', model: 'm', type: 'output', asInt: '50' }),
      dataPoint({ sessionId: 's1', model: 'm', type: 'cache_read', asInt: '10' }),
      dataPoint({ sessionId: 's1', model: 'm', type: 'cache_creation', asInt: '5' }),
    ]),
  ]);
  const result = mapOtlpMetricsRequest(body, { wireFormat: 'json', hmacSecret: SECRET });
  assert.equal(result.points.length, 4);
  assert.deepEqual(
    result.points.map((p) => reconciliationFieldForType(p.tokenType)),
    ['input', 'output', 'cacheRead', 'cacheCreation']
  );
  assert.equal(result.unmappedTypes.size, 0);
});

test('mapper: an unknown type is stored as given and listed in unmappedTypes, never mapped to a field', () => {
  const body = metricsBody([tokenUsageMetric([dataPoint({ sessionId: 's1', model: 'm', type: 'weird_future_type', asInt: '1' })])]);
  const result = mapOtlpMetricsRequest(body, { wireFormat: 'json', hmacSecret: SECRET });
  assert.equal(result.points.length, 1);
  assert.equal(result.points[0].tokenType, 'weird_future_type');
  assert.equal(reconciliationFieldForType(result.points[0].tokenType), null);
  assert.ok(result.unmappedTypes.has('weird_future_type'));
});

test('mapper: cost in USD stores currency USD; any other unit stores currency null', () => {
  const body = metricsBody([
    costUsageMetric([dataPoint({ sessionId: 's1', asDouble: 1.5 })], 'USD'),
    costUsageMetric([dataPoint({ sessionId: 's2', asDouble: 1.5 })], 'EUR'),
  ]);
  const result = mapOtlpMetricsRequest(body, { wireFormat: 'json', hmacSecret: SECRET });
  assert.equal(result.points.find((p) => p.sessionId === sessionIdentity('s1').sessionId).currency, 'USD');
  assert.equal(result.points.find((p) => p.sessionId === sessionIdentity('s2').sessionId).currency, null);
});

test('mapper: a metric name other than the two tracked ones is ignored, never counted as rejected', () => {
  const body = metricsBody([
    { name: 'claude_code.session.count', unit: '1', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [dataPoint({ asInt: '1' })] } },
  ]);
  const result = mapOtlpMetricsRequest(body, { wireFormat: 'json', hmacSecret: SECRET });
  assert.equal(result.points.length, 0);
  assert.equal(result.stats.dataPointsInvalid, 0);
  assert.equal(result.stats.metricsIgnored, 1);
});

test('mapper: rejects unspecified temporality, non-monotonic Sum, negative, above 2^53, NaN, fractional tokens, missing timestamp', () => {
  const unspecifiedTemporality = {
    name: 'claude_code.token.usage',
    unit: 'tokens',
    sum: { aggregationTemporality: 0, isMonotonic: true, dataPoints: [dataPoint({ sessionId: 's', asInt: '1' })] },
  };
  const nonMonotonic = {
    name: 'claude_code.token.usage',
    unit: 'tokens',
    sum: { aggregationTemporality: 1, isMonotonic: false, dataPoints: [dataPoint({ sessionId: 's', asInt: '1' })] },
  };
  const negative = tokenUsageMetric([dataPoint({ sessionId: 's', asInt: '-1' })]);
  const tooLarge = tokenUsageMetric([dataPoint({ sessionId: 's', asInt: String(2n ** 53n + 1n) })]);
  const nanValue = tokenUsageMetric([dataPoint({ sessionId: 's', asDouble: NaN })]);
  const fractional = tokenUsageMetric([dataPoint({ sessionId: 's', asDouble: 1.5 })]);
  const missingTimestamp = tokenUsageMetric([{ attributes: [attr('session.id', 's')], asInt: '1' }]);

  for (const metric of [unspecifiedTemporality, nonMonotonic, negative, tooLarge, nanValue, fractional, missingTimestamp]) {
    const result = mapOtlpMetricsRequest(metricsBody([metric]), { wireFormat: 'json', hmacSecret: SECRET });
    assert.equal(result.points.length, 0, JSON.stringify(metric));
    assert.ok(result.stats.dataPointsInvalid >= 1, JSON.stringify(metric));
  }
});

test('mapper: a valid point survives alongside an invalid one in the same request', () => {
  const body = metricsBody([
    tokenUsageMetric([dataPoint({ sessionId: 's', model: 'm', type: 'input', asInt: '10' }), dataPoint({ sessionId: 's', asInt: '-5' })]),
  ]);
  const result = mapOtlpMetricsRequest(body, { wireFormat: 'json', hmacSecret: SECRET });
  assert.equal(result.points.length, 1);
  assert.equal(result.stats.dataPointsInvalid, 1);
});

test('mapper: the no-recorded-value flag ignores a point without rejecting it', () => {
  const body = metricsBody([tokenUsageMetric([dataPoint({ sessionId: 's', asInt: '1', flags: 1 })])]);
  const result = mapOtlpMetricsRequest(body, { wireFormat: 'json', hmacSecret: SECRET });
  assert.equal(result.points.length, 0);
  assert.equal(result.stats.dataPointsInvalid, 0);
  assert.equal(result.stats.dataPointsIgnoredFlag, 1);
});

test('mapper: a point without session.id is stored with a null sessionId and counted, never attributed', () => {
  const body = metricsBody([tokenUsageMetric([dataPoint({ model: 'm', type: 'input', asInt: '1' })])]);
  const result = mapOtlpMetricsRequest(body, { wireFormat: 'json', hmacSecret: SECRET });
  assert.equal(result.points.length, 1);
  assert.equal(result.points[0].sessionId, null);
  assert.equal(result.stats.dataPointsWithoutSession, 1);
});

test('mapper: session.id maps through the same identity the hook adapter and the logs mapper use', () => {
  const raw = '14ad3dd2-89b4-49a5-9334-e937d9eb1ecc';
  const body = metricsBody([tokenUsageMetric([dataPoint({ sessionId: raw, model: 'm', type: 'input', asInt: '1' })])]);
  const result = mapOtlpMetricsRequest(body, { wireFormat: 'json', hmacSecret: SECRET });
  assert.equal(result.points[0].sessionId, sessionIdentity(raw).sessionId);
  assert.equal(result.points[0].runtimeId, 'claude-code');
});

test('mapper: series_key is keyed (HMAC) and changes with the secret, not just with attributes', () => {
  const body = metricsBody([tokenUsageMetric([dataPoint({ sessionId: 's', model: 'm', type: 'input', asInt: '1' })])]);
  const a = mapOtlpMetricsRequest(body, { wireFormat: 'json', hmacSecret: Buffer.alloc(32, 1) }).points[0].seriesKey;
  const b = mapOtlpMetricsRequest(body, { wireFormat: 'json', hmacSecret: Buffer.alloc(32, 2) }).points[0].seriesKey;
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('mapper: two series differing only in a non-stored attribute get different series keys', () => {
  const bodyA = metricsBody([
    tokenUsageMetric([dataPoint({ sessionId: 's', model: 'm', type: 'input', asInt: '1', extraAttrs: [attr('account.id', 'acct-1')] })]),
  ]);
  const bodyB = metricsBody([
    tokenUsageMetric([dataPoint({ sessionId: 's', model: 'm', type: 'input', asInt: '1', extraAttrs: [attr('account.id', 'acct-2')] })]),
  ]);
  const a = mapOtlpMetricsRequest(bodyA, { wireFormat: 'json', hmacSecret: SECRET }).points[0].seriesKey;
  const b = mapOtlpMetricsRequest(bodyB, { wireFormat: 'json', hmacSecret: SECRET }).points[0].seriesKey;
  assert.notEqual(a, b, 'account.id is never stored, but it must still distinguish the series');
});

test('privacy: user.email, user.account_uuid and organization.id never survive the mapper', () => {
  const body = metricsBody([
    tokenUsageMetric([
      dataPoint({
        sessionId: 's',
        model: 'm',
        type: 'input',
        asInt: '1',
        extraAttrs: [attr('user.email', 'person@example.com'), attr('user.account_uuid', 'uuid-1'), attr('organization.id', 'org-1')],
      }),
    ]),
  ]);
  const result = mapOtlpMetricsRequest(body, { wireFormat: 'json', hmacSecret: SECRET });
  const serialized = JSON.stringify(result.points);
  assert.ok(!serialized.includes('person@example.com'));
  assert.ok(!serialized.includes('uuid-1'));
  assert.ok(!serialized.includes('org-1'));
});

// -------------------------------------------------------------
// HTTP: POST /v1/metrics
// -------------------------------------------------------------

test('HTTP: a JSON export of the two tracked metrics is accepted with 200 {} and leaves the ledger untouched', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const eventsBefore = (await store.list({ limit: 1000 })).length;
      const usageBefore = await store.usageSummary();

      const sessionId = `http-json-${Date.now()}`;
      const body = metricsBody([
        tokenUsageMetric([dataPoint({ sessionId, model: 'claude-sonnet-4-5', type: 'input', asInt: '1200' })]),
        costUsageMetric([dataPoint({ sessionId, asDouble: 0.02 })]),
      ]);
      const res = await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {});

      const eventsAfter = (await store.list({ limit: 1000 })).length;
      const usageAfter = await store.usageSummary();
      assert.equal(eventsAfter, eventsBefore, 'a metric point is never turned into a canonical event');
      assert.deepEqual(usageAfter, usageBefore, 'posting metrics never changes usage totals');

      const stored = await store.listTelemetryPoints({ sessionId: sessionIdentity(sessionId).sessionId });
      assert.equal(stored.length, 2);
    } finally {
      server.close();
    }
  });
});

test('HTTP: the protobuf fixture and plain+gzip transport all store identical points', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const pb = fs.readFileSync(path.join(fixturesDir, 'metrics-request.pb'));

      const plain = await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf' },
        body: pb,
      });
      assert.equal(plain.status, 200);
      assert.equal(plain.headers.get('content-type')?.split(';')[0], 'application/x-protobuf');

      const gzipped = await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip' },
        body: zlib.gzipSync(pb),
      });
      assert.equal(gzipped.status, 200);

      // Both posts of the same fixture are duplicates of each other (same series, same timestamps, same
      // values): the session must show exactly the two points from the fixture, not four.
      const fixtureSessionId = sessionIdentity('8f1c2b3a-0000-4000-8000-000000000001').sessionId;
      const stored = await store.listTelemetryPoints({ sessionId: fixtureSessionId });
      assert.equal(stored.length, 2);
    } finally {
      server.close();
    }
  });
});

test('HTTP: a repeated point is a duplicate (200 {}); a repeated key with a different value is a conflict reported in partialSuccess', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const sessionId = `http-conflict-${Date.now()}`;
      const body = metricsBody([tokenUsageMetric([dataPoint({ sessionId, model: 'm', type: 'input', asInt: '10', start: '5000', time: '6000' })])]);

      const first = await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.deepEqual(await first.json(), {});

      const retry = await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.deepEqual(await retry.json(), {});

      const conflictingBody = metricsBody([tokenUsageMetric([dataPoint({ sessionId, model: 'm', type: 'input', asInt: '999', start: '5000', time: '6000' })])]);
      const conflict = await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(conflictingBody) });
      assert.equal(conflict.status, 200);
      const conflictJson = await conflict.json();
      assert.equal(conflictJson.partialSuccess.rejectedDataPoints, '1');
      assert.match(conflictJson.partialSuccess.errorMessage, /conflicting duplicate/);

      const stored = await store.listTelemetryPoints({ sessionId: sessionIdentity(sessionId).sessionId });
      assert.equal(stored.length, 1);
      assert.equal(stored[0].value, 10, 'the first value is kept, the conflicting one is rejected');
    } finally {
      server.close();
    }
  });
});

test('HTTP: invalid points are reported through partialSuccess.rejectedDataPoints', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const body = metricsBody([tokenUsageMetric([dataPoint({ sessionId: 's', asInt: '-1' })])]);
      const res = await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.partialSuccess.rejectedDataPoints, '1');
    } finally {
      server.close();
    }
  });
});

test('HTTP: malformed JSON and a body without resourceMetrics both get an OTLP-style 400', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const malformed = await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).code, 3);

      const wrongShape = await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(wrongShape.status, 400);
    } finally {
      server.close();
    }
  });
});

test('HTTP: malformed protobuf gets a 400 with a protobuf Status body', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf' },
        body: Buffer.from([0xff, 0xff, 0xff]),
      });
      assert.equal(res.status, 400);
      assert.equal(res.headers.get('content-type')?.split(';')[0], 'application/x-protobuf');
    } finally {
      server.close();
    }
  });
});

test('HTTP: an unsupported Content-Type gets 415 naming both accepted protocols', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: '<x/>' });
      assert.equal(res.status, 415);
      assert.match((await res.json()).message, /http\/json or http\/protobuf/);
    } finally {
      server.close();
    }
  });
});

test('HTTP: with AGENT_VIEWER_API_TOKEN set, a missing or wrong token gets 401, the right one gets 200', async () => {
  await withEnv({ AGENT_VIEWER_API_TOKEN: 'metrics-secret-token', AGENT_VIEWER_API_KEY: undefined }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const body = JSON.stringify(metricsBody([tokenUsageMetric([dataPoint({ sessionId: 's', asInt: '1' })])]));

      const noToken = await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(noToken.status, 401);
      assert.equal((await noToken.json()).code, 16);

      const wrongToken = await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
        body,
      });
      assert.equal(wrongToken.status, 401);

      const rightToken = await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer metrics-secret-token' },
        body,
      });
      assert.equal(rightToken.status, 200);
    } finally {
      server.close();
    }
  });
});

test('HTTP: posting metrics never emits an SSE frame', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const sseRes = await fetch(`${baseUrl}/api/v1/events/stream`);
      const reader = sseRes.body.getReader();
      // Drain the initial ": connected" comment and heartbeat before posting, so only frames caused by the
      // metrics POST below would show up next.
      await reader.read();

      const body = JSON.stringify(metricsBody([tokenUsageMetric([dataPoint({ sessionId: `sse-${Date.now()}`, asInt: '1' })])]));
      await fetch(`${baseUrl}${OTLP_METRICS_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

      const race = await Promise.race([
        reader.read().then((r) => ({ timedOut: false, value: r })),
        new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 200)),
      ]);
      assert.equal(race.timedOut, true, 'no SSE frame should arrive after a metrics-only POST');
      await reader.cancel();
    } finally {
      server.close();
    }
  });
});
