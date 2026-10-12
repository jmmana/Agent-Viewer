// Ledger-derived /metrics families (issue #348): EventStore.usageMetrics() on both backends, the cardinality
// cap, the scrape cache with concurrent-scrape deduplication, and the 503 when the ledger query fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { MemoryEventStore, SQLiteEventStore } from '../server/store.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';
import {
  buildLedgerSamples,
  createLedgerMetrics,
  createMetricsHandler,
  createMetricsRegistry,
  LLM_LATENCY_BUCKETS_SECONDS,
  OVERFLOW_LABEL,
} from '../server/metrics.ts';

let eventCounter = 0;
function usageEvent({ type = 'llm.usage', errorKind, receivedAt, payload = {} } = {}) {
  eventCounter++;
  const result = validateCanonicalEvent({
    id: `evt_metrics_${eventCounter}`,
    type,
    timestamp: 1_700_000_000_000 + eventCounter,
    source: 'agent:test',
    agentId: 'agent-1',
    summary: 'test call',
    payload: {
      provider: 'anthropic',
      model: 'claude-sonnet',
      inputTokens: 100,
      outputTokens: 50,
      cost: 1,
      currency: 'USD',
      costSource: 'provider-reported',
      requestId: `req_metrics_${eventCounter}`,
      tags: [],
      errorKind,
      ...payload,
    },
  });
  if (!result.success) throw new Error(`invalid test event: ${JSON.stringify(result.issues)}`);
  return { event: result.data, receivedAt };
}

async function seed(store, events) {
  for (const { event, receivedAt } of events) {
    const res = await store.append(event, receivedAt !== undefined ? { receivedAt } : undefined);
    assert.equal(res.outcome, 'accepted');
  }
}

function eachStore(name, fn) {
  test(`${name} (memory)`, async () => {
    const store = new MemoryEventStore(100_000);
    await store.init();
    try {
      await fn(store);
    } finally {
      await store.close();
    }
  });
  test(`${name} (sqlite)`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-metrics-'));
    const store = new SQLiteEventStore(path.join(dir, 'metrics.db'), { backup: 'off' });
    await store.init();
    try {
      await fn(store);
    } finally {
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

const sample = (samples, labels) =>
  samples.find((s) => Object.entries(labels).every(([key, value]) => String(s.labels?.[key]) === String(value)))?.value;

const fixture = () => [
  usageEvent({ receivedAt: 1_000_000, payload: { latencyMs: 80, cacheReadTokens: 10 } }),
  usageEvent({ receivedAt: 2_000_000, payload: { latencyMs: 700, cost: 0.5, costSource: 'estimated' } }),
  // gpt-4o reports input/output tokens but never its reasoning-token breakdown: that kind stays unreported,
  // never counted as 0 (inputTokens/outputTokens are required by LlmUsagePayloadSchema and so can't be
  // "unreported" on a successful call; the breakdown fields cacheReadTokens/cacheWriteTokens/reasoningTokens
  // can).
  usageEvent({ receivedAt: 3_000_000, payload: { model: 'gpt-4o', provider: 'openai', cost: null, currency: null, costSource: 'unknown' } }),
  usageEvent({ type: 'llm.failed', errorKind: 'timeout', receivedAt: 4_000_000, payload: { cost: null, currency: null, latencyMs: 5000 } }),
];

eachStore('usageMetrics() groups the ledger without counting unreported values as zero', async (store) => {
  await seed(store, fixture());
  const snapshot = await store.usageMetrics();
  assert.equal(snapshot.oldestReceivedAt, 1_000_000);
  assert.equal(snapshot.newestReceivedAt, 4_000_000);

  const s = buildLedgerSamples(snapshot, 100);
  const sonnet = { provider: 'anthropic', model: 'claude-sonnet' };
  const gpt = { provider: 'openai', model: 'gpt-4o' };
  assert.equal(sample(s.agent_viewer_tokens_total, { ...sonnet, kind: 'input' }), 300);
  assert.equal(sample(s.agent_viewer_tokens_total, { ...sonnet, kind: 'cache_read' }), 10);
  assert.equal(sample(s.agent_viewer_token_kind_unreported_calls_total, { ...sonnet, kind: 'cache_read' }), 2);
  assert.equal(sample(s.agent_viewer_tokens_total, { ...gpt, kind: 'reasoning' }), 0);
  assert.equal(sample(s.agent_viewer_token_kind_unreported_calls_total, { ...gpt, kind: 'reasoning' }), 1);

  assert.equal(sample(s.agent_viewer_cost_reported_total, { ...sonnet, currency: 'USD' }), 1);
  assert.equal(sample(s.agent_viewer_cost_estimated_total, { ...sonnet, currency: 'USD' }), 0.5);
  assert.equal(sample(s.agent_viewer_cost_unknown_calls_total, sonnet), 1);
  assert.equal(sample(s.agent_viewer_cost_unknown_calls_total, gpt), 1);

  assert.equal(sample(s.agent_viewer_llm_calls_total, { ...sonnet, status: 'ok' }), 2);
  assert.equal(sample(s.agent_viewer_llm_calls_total, { ...sonnet, status: 'timeout' }), 1);
  assert.equal(sample(s.agent_viewer_llm_failures_total, { ...sonnet, error_kind: 'timeout' }), 1);

  // Only llm.usage latencies: the 5 s failure is not observed.
  const latency = s.agent_viewer_llm_latency_seconds;
  const bucket = (le) => latency.find((x) => x.suffix === '_bucket' && x.labels.model === 'claude-sonnet' && x.labels.le === le)?.value;
  assert.equal(bucket('0.1'), 1);
  assert.equal(bucket('0.5'), 1);
  assert.equal(bucket('1'), 2);
  assert.equal(bucket('+Inf'), 2);
  assert.equal(latency.find((x) => x.suffix === '_count' && x.labels.model === 'claude-sonnet').value, 2);
  assert.ok(Math.abs(latency.find((x) => x.suffix === '_sum' && x.labels.model === 'claude-sonnet').value - 0.78) < 1e-9);
  assert.equal(latency.filter((x) => x.suffix === '_bucket').length, (LLM_LATENCY_BUCKETS_SECONDS.length + 1) * 1);

  assert.deepEqual(s.agent_viewer_ledger_retained_since_seconds, [{ value: 1000 }]);
  assert.deepEqual(s.agent_viewer_ledger_last_usage_timestamp_seconds, [{ value: 4000 }]);
});

eachStore('usageMetrics() on an empty ledger has no samples and no timestamps', async (store) => {
  const s = buildLedgerSamples(await store.usageMetrics(), 100);
  for (const samples of Object.values(s)) assert.deepEqual(samples, []);
});

test('memory and sqlite stores return the same samples', async () => {
  const events = fixture();
  const memory = new MemoryEventStore(100_000);
  await memory.init();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-metrics-'));
  const sqlite = new SQLiteEventStore(path.join(dir, 'parity.db'), { backup: 'off' });
  await sqlite.init();
  try {
    await seed(memory, events);
    await seed(sqlite, events);
    // Group order is backend-specific; the samples themselves must not be.
    const sorted = (families) =>
      Object.fromEntries(Object.entries(families).map(([name, samples]) => [name, samples.map((s) => JSON.stringify(s)).sort()]));
    assert.deepEqual(sorted(buildLedgerSamples(await sqlite.usageMetrics(), 100)), sorted(buildLedgerSamples(await memory.usageMetrics(), 100)));
  } finally {
    await memory.close();
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

eachStore('the cardinality cap keeps models in order of first appearance and folds the rest', async (store) => {
  await seed(store, [
    usageEvent({ payload: { model: 'model-a' } }),
    usageEvent({ payload: { model: 'model-b' } }),
    usageEvent({ payload: { model: 'model-c' } }),
    usageEvent({ payload: { model: 'model-a' } }),
  ]);
  const s = buildLedgerSamples(await store.usageMetrics(), 1);
  const calls = s.agent_viewer_llm_calls_total;
  assert.deepEqual(new Set(calls.map((x) => x.labels.model)), new Set(['model-a', OVERFLOW_LABEL]));
  assert.equal(sample(calls, { model: 'model-a' }), 2);
  assert.equal(sample(calls, { provider: OVERFLOW_LABEL, model: OVERFLOW_LABEL }), 2);
});

const snapshot = { groups: [], oldestReceivedAt: 1000, newestReceivedAt: 2000 };

test('the scrape cache reuses one query within AGENT_VIEWER_METRICS_CACHE_MS and dedupes concurrent loads', async () => {
  let calls = 0;
  let release;
  let at = 0;
  const ledger = createLedgerMetrics({
    usageMetrics: () => {
      calls++;
      return new Promise((resolve) => (release = () => resolve(snapshot)));
    },
    env: { AGENT_VIEWER_METRICS_CACHE_MS: '5000' },
    now: () => at,
  });
  const loads = [ledger.load(), ledger.load(), ledger.load()];
  assert.equal(calls, 1);
  release();
  await Promise.all(loads);
  at = 4999;
  await ledger.load();
  assert.equal(calls, 1);
  at = 5000;
  const next = ledger.load();
  release();
  await next;
  assert.equal(calls, 2);
});

test('a failed ledger query is not cached', async () => {
  let fail = true;
  let calls = 0;
  const ledger = createLedgerMetrics({
    usageMetrics: async () => {
      calls++;
      if (fail) throw new Error('disk I/O error');
      return snapshot;
    },
    env: {},
    now: () => 0,
  });
  await assert.rejects(ledger.load());
  fail = false;
  await ledger.load();
  assert.equal(calls, 2);
});

test('/metrics answers 503 metrics_unavailable, never a partial body, when the ledger query fails', async () => {
  let fail = true;
  const registry = createMetricsRegistry();
  registry.register({ name: 'agent_viewer_build_info', help: 'x', type: 'gauge', collect: () => 1 });
  const ledger = createLedgerMetrics({
    usageMetrics: async () => {
      if (fail) throw new Error('database is locked');
      return snapshot;
    },
    env: {},
  });
  ledger.register(registry);
  const env = { AGENT_VIEWER_METRICS: '1', AGENT_VIEWER_METRICS_AUTH: 'off' };
  const app = express();
  app.all('/metrics', createMetricsHandler({ registry, getApiToken: () => undefined, safeEqual: (a, b) => a === b, prepare: ledger.load, env }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/metrics`;
  try {
    const failed = await fetch(url);
    assert.equal(failed.status, 503);
    const body = await failed.json();
    assert.equal(body.error, 'metrics_unavailable');

    fail = false;
    const ok = await fetch(url);
    assert.equal(ok.status, 200);
    const text = await ok.text();
    assert.match(text, /^agent_viewer_build_info 1$/m);
    assert.match(text, /^agent_viewer_ledger_retained_since_seconds 1$/m);
    assert.match(text, /^# TYPE agent_viewer_llm_latency_seconds histogram$/m);
  } finally {
    server.close();
  }
});
