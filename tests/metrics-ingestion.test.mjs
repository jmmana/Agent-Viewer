// Ingestion counters and HTTP duration on /metrics (issue #348): accepted/duplicate/rejected events counted
// once each response has finished, request durations labelled by route template, and the ledger families
// reflecting what was ingested.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

delete process.env.AGENT_VIEWER_STORAGE;
delete process.env.AGENT_VIEWER_METRICS_TOKEN;
delete process.env.AGENT_VIEWER_API_KEY;
delete process.env.AGENT_VIEWER_WEBHOOK_SECRET;
process.env.AGENT_VIEWER_METRICS = '1';
process.env.AGENT_VIEWER_METRICS_AUTH = 'off';
process.env.AGENT_VIEWER_METRICS_CACHE_MS = '0';
process.env.AGENT_VIEWER_METRICS_RATE_LIMIT = '100000';
process.env.AGENT_VIEWER_API_TOKEN = 'ingest-token';

const { app } = await import('../server/index.ts');

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const auth = { authorization: 'Bearer ingest-token', 'content-type': 'application/json' };

let counter = 0;
function usageEvent(payload = {}) {
  counter++;
  return {
    id: `evt_ingest_${counter}`,
    type: 'llm.usage',
    timestamp: Date.now(),
    source: 'agent:test',
    agentId: 'agent-1',
    summary: 'test call',
    payload: {
      provider: 'anthropic',
      model: 'claude-sonnet',
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.25,
      currency: 'USD',
      costSource: 'provider-reported',
      latencyMs: 300,
      requestId: `req_ingest_${counter}`,
      tags: [],
      ...payload,
    },
  };
}

const post = (path, body, headers = auth) => fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

async function scrape() {
  const res = await fetch(`${baseUrl}/metrics`);
  assert.equal(res.status, 200);
  return res.text();
}

function value(body, series) {
  const line = body.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

test('accepted, duplicate and rejected events are counted per channel', async () => {
  const event = usageEvent();
  assert.equal((await post('/api/v1/events', event)).status, 202);
  assert.equal((await post('/api/v1/events', event)).status, 200);
  assert.equal((await post('/api/v1/events', { ...event, summary: 'changed' })).status, 409);
  assert.equal((await post('/api/v1/events', { type: 'nope' })).status, 400);
  assert.equal((await post('/api/v1/events', usageEvent(), { 'content-type': 'application/json' })).status, 401);

  const batch = [usageEvent(), usageEvent(), event];
  const batchRes = await post('/api/v1/events/batch', batch);
  assert.equal(batchRes.status, 202);
  assert.equal((await post('/api/v1/events/batch', [usageEvent(), { type: 'nope' }])).status, 400);

  // `finish` fires after the client has the response; give the event loop a turn.
  await new Promise((resolve) => setImmediate(resolve));
  const body = await scrape();
  assert.match(body, /^# TYPE agent_viewer_events_accepted_total counter$/m);
  assert.equal(value(body, 'agent_viewer_events_accepted_total{channel="events"}'), 1);
  assert.equal(value(body, 'agent_viewer_events_duplicate_total{channel="events"}'), 1);
  assert.equal(value(body, 'agent_viewer_events_rejected_total{channel="events",reason="conflict"}'), 1);
  assert.equal(value(body, 'agent_viewer_events_rejected_total{channel="events",reason="invalid"}'), 1);
  assert.equal(value(body, 'agent_viewer_events_rejected_total{channel="events",reason="unauthorized"}'), 1);
  assert.equal(value(body, 'agent_viewer_events_accepted_total{channel="events-batch"}'), 2);
  assert.equal(value(body, 'agent_viewer_events_duplicate_total{channel="events-batch"}'), 1);
  assert.equal(value(body, 'agent_viewer_events_rejected_total{channel="events-batch",reason="invalid"}'), 2);
});

test('request durations are a histogram labelled by route template, never by raw path', async () => {
  await fetch(`${baseUrl}/api/v1/agents/some-agent-id-123`, { headers: auth });
  await new Promise((resolve) => setImmediate(resolve));
  const body = await scrape();
  assert.match(body, /^# TYPE agent_viewer_http_request_duration_seconds histogram$/m);
  assert.match(body, /^agent_viewer_http_request_duration_seconds_bucket\{method="POST",route="\/api\/v1\/events",code="202",le="\+Inf"\} \d+$/m);
  assert.match(body, /^agent_viewer_http_request_duration_seconds_count\{method="POST",route="\/api\/v1\/events",code="202"\} \d+$/m);
  assert.ok(!body.includes('some-agent-id-123'));
});

test('ledger families reflect ingested usage', async () => {
  const body = await scrape();
  const model = 'provider="anthropic",model="claude-sonnet"';
  assert.equal(value(body, `agent_viewer_llm_calls_total{${model},status="ok"}`), 3);
  assert.equal(value(body, `agent_viewer_tokens_total{${model},kind="input"}`), 30);
  assert.equal(value(body, `agent_viewer_token_kind_unreported_calls_total{${model},kind="reasoning"}`), 3);
  assert.equal(value(body, `agent_viewer_cost_reported_total{${model},currency="USD"}`), 0.75);
  assert.equal(value(body, `agent_viewer_llm_latency_seconds_bucket{${model},le="0.25"}`), 0);
  assert.equal(value(body, `agent_viewer_llm_latency_seconds_bucket{${model},le="0.5"}`), 3);
  assert.equal(value(body, `agent_viewer_llm_latency_seconds_count{${model}}`), 3);
  assert.ok(value(body, 'agent_viewer_ledger_last_usage_timestamp_seconds') > 0);
  assert.ok(value(body, 'agent_viewer_ledger_retained_since_seconds') > 0);
});
