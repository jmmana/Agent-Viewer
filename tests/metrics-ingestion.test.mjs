import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Issue #365: in-process ingestion counters on GET /metrics. agent_viewer_events_accepted_total,
// agent_viewer_events_duplicate_total, agent_viewer_events_rejected_total (one res.on('finish') middleware mounted
// first, every rejection site records its reason) and the agent_viewer_http_request_duration_seconds histogram by
// route template. Every assertion is a delta against a scrape taken just before, since the counters are
// process-lifetime. The rate-limit tests run last: they exhaust their buckets on purpose.

const pricingHome = mkdtempSync(path.join(os.tmpdir(), 'av-pricing-ingestion-'));
process.env.AGENT_VIEWER_PRICING_FILE = path.join(pricingHome, 'pricing.json');
process.env.AGENT_VIEWER_PRICING_HISTORY_FILE = path.join(pricingHome, 'pricing-history.jsonl');
const API_TOKEN = 'api-token-for-ingestion-metrics-tests';
process.env.AGENT_VIEWER_API_TOKEN = API_TOKEN;
delete process.env.AGENT_VIEWER_API_KEY;
delete process.env.AGENT_VIEWER_WEBHOOK_SECRET;
delete process.env.AGENT_VIEWER_METRICS_TOKEN;
delete process.env.AGENT_VIEWER_METRICS_AUTH;
process.env.AGENT_VIEWER_METRICS = '1';
process.env.AGENT_VIEWER_MAX_BATCH_SIZE = '5';
process.env.AGENT_VIEWER_RATE_LIMIT = '400';

const { app, ingestionMetrics } = await import('../server/index.ts');

const AUTH = { authorization: `Bearer ${API_TOKEN}` };
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' };

let server;
let baseUrl;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.closeAllConnections?.();
  server.close();
});

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

async function scrape() {
  const res = await fetch(`${baseUrl}/metrics`, { headers: AUTH });
  assert.equal(res.status, 200);
  return res.text();
}

/** Value of the series `name{labels}` in an exposition body, `0` when the series is absent. Label order is the
 * order the server writes them in. */
function sample(body, name, labels = {}) {
  const entries = Object.entries(labels);
  const series = entries.length === 0 ? name : `${name}{${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
  const line = body.split('\n').find((l) => l.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : 0;
}

/** Runs `fn`, then returns `after - before` for each requested series. */
async function delta(series, fn) {
  const before = await scrape();
  await fn();
  const after = await scrape();
  return series.map(([name, labels]) => sample(after, name, labels) - sample(before, name, labels));
}

const rejected = (endpoint, reason) => ['agent_viewer_events_rejected_total', { endpoint, reason }];

let counter = 0;
function makeEvent(overrides = {}) {
  counter += 1;
  return {
    schemaVersion: '1.0',
    id: `evt_ingest_${process.pid}_${Date.now()}_${counter}`,
    type: 'agent.status.changed',
    timestamp: Date.now(),
    runtimeId: 'rt_ingest',
    sessionId: 'ses_ingest',
    source: 'agent:alice',
    agentId: 'alice',
    summary: 'Alice status changed',
    payload: { status: 'THINKING' },
    ...overrides,
  };
}

function post(urlPath, body, headers = JSON_AUTH) {
  return fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('/metrics exposes the four ingestion families next to build_info and sse_clients', async () => {
  const body = await scrape();
  assert.match(body, /# TYPE agent_viewer_build_info gauge/);
  assert.match(body, /# TYPE agent_viewer_sse_clients gauge/);
  assert.match(body, /# TYPE agent_viewer_events_accepted_total counter/);
  assert.match(body, /# TYPE agent_viewer_events_duplicate_total counter/);
  assert.match(body, /# TYPE agent_viewer_events_rejected_total counter/);
  assert.match(body, /# TYPE agent_viewer_http_request_duration_seconds histogram/);
  const seriesLines = body.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(new Set(seriesLines).size, seriesLines.length);
});

test('accepted, identical and conflicting duplicates on POST /api/v1/events', async () => {
  const event = makeEvent();
  const [accepted, identical, conflicting] = await delta(
    [
      ['agent_viewer_events_accepted_total', { type: 'agent.status.changed' }],
      ['agent_viewer_events_duplicate_total', { kind: 'identical' }],
      ['agent_viewer_events_duplicate_total', { kind: 'conflicting' }],
    ],
    async () => {
      assert.equal((await post('/api/v1/events', event)).status, 202);
      assert.equal((await post('/api/v1/events', event)).status, 200);
      const conflict = await post('/api/v1/events', { ...event, summary: 'different content' });
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).error, 'conflicting_duplicate');
    }
  );
  assert.equal(accepted, 1);
  assert.equal(identical, 1);
  assert.equal(conflicting, 1);
});

test('batch: accepted per event, duplicates and conflicts per item', async () => {
  const stored = makeEvent();
  assert.equal((await post('/api/v1/events', stored)).status, 202);
  const [accepted, identical, conflicting] = await delta(
    [
      ['agent_viewer_events_accepted_total', { type: 'agent.status.changed' }],
      ['agent_viewer_events_duplicate_total', { kind: 'identical' }],
      ['agent_viewer_events_duplicate_total', { kind: 'conflicting' }],
    ],
    async () => {
      const res = await post('/api/v1/events/batch', [makeEvent(), makeEvent(), stored, { ...stored, summary: 'changed' }]);
      assert.equal(res.status, 202);
    }
  );
  assert.equal(accepted, 2);
  assert.equal(identical, 1);
  assert.equal(conflicting, 1);
});

test('rejections on the event endpoints: validation, empty_batch, batch_too_large, malformed_json, payload_too_large, unauthorized', async () => {
  const counts = await delta(
    [
      rejected('events', 'validation'),
      rejected('events_batch', 'empty_batch'),
      rejected('events_batch', 'batch_too_large'),
      rejected('events_batch', 'validation'),
      rejected('events', 'malformed_json'),
      rejected('events', 'payload_too_large'),
      rejected('events', 'unauthorized'),
    ],
    async () => {
      assert.equal((await post('/api/v1/events', { type: 'not-a-type' })).status, 400);
      assert.equal((await post('/api/v1/events/batch', [])).status, 400);
      assert.equal((await post('/api/v1/events/batch', Array.from({ length: 6 }, () => makeEvent()))).status, 413);
      assert.equal((await post('/api/v1/events/batch', [{ nope: true }])).status, 400);
      const malformed = await post('/api/v1/events', '{"broken": ');
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).message, 'Malformed JSON payload');
      const huge = await post('/api/v1/events', JSON.stringify({ blob: 'x'.repeat(1_100_000) }));
      assert.equal(huge.status, 413);
      assert.equal((await post('/api/v1/events', makeEvent(), { 'content-type': 'application/json' })).status, 401);
    }
  );
  assert.deepEqual(counts, [1, 1, 1, 1, 1, 1, 1]);
});

test('webhook rejections: signature, replay, unrecognized_payload; a 409 counts as a conflicting duplicate', async () => {
  const secret = 'webhook-secret-for-ingestion-tests';
  const counts = await delta(
    [
      rejected('webhook_generic', 'signature'),
      rejected('webhook_generic', 'replay'),
      rejected('webhook_generic', 'unrecognized_payload'),
    ],
    async () => {
      await withEnv({ AGENT_VIEWER_WEBHOOK_SECRET: secret }, async () => {
        const body = JSON.stringify({ message: 'hi' });
        // Missing headers, then a wrong signature: both `signature`.
        assert.equal((await post('/api/v1/webhooks/generic', body, { 'content-type': 'application/json' })).status, 401);
        const ts = String(Date.now());
        const wrong = await post('/api/v1/webhooks/generic', body, {
          'content-type': 'application/json',
          'x-agent-viewer-signature': 'bad',
          'x-agent-viewer-timestamp': ts,
        });
        assert.equal(wrong.status, 401);
        // Expired timestamp: `replay`.
        const old = String(Date.now() - 60 * 60 * 1000);
        const expired = await post('/api/v1/webhooks/generic', body, {
          'content-type': 'application/json',
          'x-agent-viewer-signature': crypto.createHmac('sha256', secret).update(`${old}.${body}`).digest('hex'),
          'x-agent-viewer-timestamp': old,
        });
        assert.equal(expired.status, 401);
        assert.equal((await expired.json()).error, 'replay_detected_or_clock_skew');
      });
      const empty = await post('/api/v1/webhooks/generic', {});
      assert.equal(empty.status, 400);
      assert.equal((await empty.json()).error, 'unrecognized_webhook_payload');
    }
  );
  assert.deepEqual(counts, [2, 1, 1]);

  const key = `wh_${process.pid}_${Date.now()}`;
  const [conflicting] = await delta([['agent_viewer_events_duplicate_total', { kind: 'conflicting' }]], async () => {
    assert.equal((await post('/api/v1/webhooks/generic', { idempotencyKey: key, message: 'first' })).status, 202);
    assert.equal((await post('/api/v1/webhooks/generic', { idempotencyKey: key, message: 'second' })).status, 409);
  });
  assert.ok(conflicting >= 1);
});

test('OTLP rejections are labeled by receiver', async () => {
  const counts = await delta(
    [
      rejected('otlp_logs', 'unrecognized_payload'),
      rejected('otlp_logs', 'unauthorized'),
      rejected('otlp_traces', 'malformed_json'),
      rejected('otlp_metrics', 'unrecognized_payload'),
    ],
    async () => {
      assert.equal((await post('/v1/logs', { notOtlp: true })).status, 400);
      assert.equal((await post('/v1/logs', { resourceLogs: [] }, { 'content-type': 'application/json' })).status, 401);
      assert.equal((await post('/v1/traces', '{oops')).status, 400);
      assert.equal((await post('/v1/metrics', 'plain text', { ...AUTH, 'content-type': 'text/plain' })).status, 415);
    }
  );
  assert.deepEqual(counts, [1, 1, 1, 1]);
});

test('/metrics rejections (401, 403) count with endpoint=metrics', async () => {
  const [unauthorized] = await delta([rejected('metrics', 'unauthorized')], async () => {
    assert.equal((await fetch(`${baseUrl}/metrics`)).status, 401);
    await withEnv({ AGENT_VIEWER_API_TOKEN: undefined }, async () => {
      assert.equal((await fetch(`${baseUrl}/metrics`)).status, 403);
    });
  });
  assert.equal(unauthorized, 2);
});

test('request duration histogram: route template, __unmatched__, status class, exclusions', async () => {
  assert.equal((await post('/api/v1/events', makeEvent())).status, 202);
  assert.equal((await fetch(`${baseUrl}/api/v1/sessions/ses_does_not_exist_${Date.now()}`, { headers: AUTH })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/v1/definitely-not-a-route`, { headers: AUTH })).status, 404);

  // Hold an SSE stream open across a scrape (the gauge sees it), then close it.
  const controller = new AbortController();
  const stream = await fetch(`${baseUrl}/api/v1/events/stream`, { headers: AUTH, signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  await reader.read();
  const during = await scrape();
  assert.ok(sample(during, 'agent_viewer_sse_clients') >= 1);
  controller.abort();
  await reader.read().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));

  const body = await scrape();
  const metric = 'agent_viewer_http_request_duration_seconds';
  const postLabels = { method: 'POST', route: '/api/v1/events', status_class: '2xx' };
  const count = sample(body, `${metric}_count`, postLabels);
  assert.ok(count >= 1);
  assert.equal(sample(body, `${metric}_bucket`, { ...postLabels, le: '+Inf' }), count);
  assert.ok(sample(body, `${metric}_bucket`, { ...postLabels, le: '10' }) <= count);
  assert.ok(sample(body, `${metric}_sum`, postLabels) > 0);
  assert.ok(sample(body, `${metric}_count`, { method: 'GET', route: '/api/v1/sessions/:sessionId', status_class: '4xx' }) >= 1);
  assert.ok(sample(body, `${metric}_count`, { method: 'GET', route: '__unmatched__', status_class: '4xx' }) >= 1);
  assert.doesNotMatch(body, /route="\/metrics"/);
  assert.doesNotMatch(body, /route="\/api\/v1\/events\/stream"/);
  assert.doesNotMatch(body, /route="\/api\/v1\/sessions\/ses_/);
  for (const le of ['0.005', '0.01', '0.025', '0.05', '0.1', '0.25', '0.5', '1', '2.5', '5', '10', '+Inf']) {
    assert.match(body, new RegExp(`${metric}_bucket\\{method="POST",route="/api/v1/events",status_class="2xx",le="${le.replace('+', '\\+')}"\\}`));
  }
});

test('an instrumentation failure never breaks a request', async () => {
  // Own-property overrides shadow the prototype methods; deleting them afterwards restores the real ones.
  const names = ['recordAccepted', 'recordDuplicate', 'recordRejected', 'observeRequest'];
  for (const name of names) {
    ingestionMetrics[name] = () => {
      throw new Error(`instrumentation ${name} exploded`);
    };
  }
  try {
    const event = makeEvent();
    assert.equal((await post('/api/v1/events', event)).status, 202);
    assert.equal((await post('/api/v1/events', event)).status, 200);
    assert.equal((await post('/api/v1/events', '{bad')).status, 400);
    assert.equal((await post('/api/v1/events', makeEvent(), { 'content-type': 'application/json' })).status, 401);
    assert.equal((await post('/api/v1/events/batch', [makeEvent()])).status, 202);
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    for (const name of names) delete ingestionMetrics[name];
  }
  assert.equal((await post('/api/v1/events', makeEvent())).status, 202);
});

test('rate_limited: a 429 from the /api/v1 limiter and from the /metrics limiter', async () => {
  const before = await scrape();
  let status = 0;
  for (let i = 0; i < 500 && status !== 429; i += 1) {
    status = (await post('/api/v1/events/batch', [])).status;
  }
  assert.equal(status, 429);
  const afterApi = await scrape();
  assert.equal(
    sample(afterApi, ...rejected('events_batch', 'rate_limited')) - sample(before, ...rejected('events_batch', 'rate_limited')),
    1
  );

  // Exhausting the /metrics bucket means the last scrape is the 429 itself, so read the in-process registry.
  const { renderExposition } = await import('../server/metrics.ts');
  const metricsBefore = sample(renderExposition(ingestionMetrics.families()), ...rejected('metrics', 'rate_limited'));
  status = 0;
  for (let i = 0; i < 500 && status !== 429; i += 1) {
    status = (await fetch(`${baseUrl}/metrics`, { headers: AUTH })).status;
  }
  assert.equal(status, 429);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const metricsAfter = sample(renderExposition(ingestionMetrics.families()), ...rejected('metrics', 'rate_limited'));
  assert.equal(metricsAfter - metricsBefore, 1);
});
