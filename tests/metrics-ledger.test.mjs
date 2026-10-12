// Issue #348 (second sub-issue of #103): ledger-derived Prometheus families (`server/metrics/ledgerFamilies.ts`)
// and their scrape-time cache (`server/metrics/ledgerFamiliesCache.ts`). Endpoint auth/enablement is covered by
// tests/metrics-endpoint.test.mjs; the text-exposition writer (including histogram suffix rendering) by
// tests/metrics-format.test.mjs. This file covers: tokens by kind, unreported counting, mixed/missing currency,
// reported vs. estimated cost, unknown-cost counting, calls/failures by error_kind, the latency histogram,
// cardinality cap with first-appearance ordering, label sanitize-then-merge, the two ledger gauges, memory vs.
// SQLite parity (including reopen), the scrape cache's TTL/concurrency/failure rules, and the HTTP route's 503.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryEventStore, SQLiteEventStore } from '../server/store.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';
import { computeLedgerFamilies, buildLedgerGaugeFamilies, DEFAULT_METRICS_MAX_MODELS } from '../server/metrics/ledgerFamilies.ts';
import { LedgerFamiliesCache } from '../server/metrics/ledgerFamiliesCache.ts';

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-viewer-metrics-ledger-${name}-`));
  return { dir, file: path.join(dir, `${name}.db`) };
}

let eventCounter = 0;

function buildEvent(overrides = {}) {
  eventCounter++;
  const type = overrides.type ?? 'llm.usage';
  const basePayload =
    type === 'llm.usage'
      ? { provider: 'anthropic', model: 'claude-sonnet', inputTokens: 100, outputTokens: 50, cost: 1, currency: 'USD', costSource: 'provider-reported' }
      : { provider: 'anthropic', model: 'claude-sonnet', errorKind: 'unknown' };
  const result = validateCanonicalEvent({
    id: overrides.id ?? `evt_${eventCounter}`,
    type,
    timestamp: overrides.timestamp ?? 1_700_000_000_000 + eventCounter,
    source: 'agent:test',
    agentId: 'agent-1',
    summary: 'test call',
    payload: { ...basePayload, requestId: `req_${eventCounter}`, ...overrides.payload },
  });
  assert.equal(result.success, true, JSON.stringify(result.issues));
  return { event: result.data, receivedAt: overrides.receivedAt };
}

async function seed(store, specs) {
  for (const spec of specs) {
    const { event, receivedAt } = buildEvent(spec);
    const res = await store.append(event, receivedAt !== undefined ? { receivedAt } : undefined);
    assert.equal(res.outcome, 'accepted', `expected ${event.id} to be accepted, got ${res.outcome}`);
  }
}

async function withMemoryStore(fn, opts = {}) {
  const store = new MemoryEventStore({ maxEvents: 100_000, ...opts });
  await store.init();
  try {
    await fn(store);
  } finally {
    await store.close();
  }
}

function familyByName(result, name) {
  const family = result.families.find((f) => f.name === name);
  assert.ok(family, `expected family ${name} to exist`);
  return family;
}

function sampleValue(family, labels) {
  const sample = family.samples.find((s) => Object.keys(labels).every((k) => s.labels[k] === labels[k]) && Object.keys(s.labels).length === Object.keys(labels).length);
  return sample?.value;
}

// -------------------------------------------------------------
// Tokens: sums, unreported counting, partially billed failed calls
// -------------------------------------------------------------

test('tokens: reported kinds are summed, unreported kinds are counted instead of a 0', async () => {
  await withMemoryStore(async (store) => {
    await seed(store, [{ payload: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 } }]);
    const result = await computeLedgerFamilies(store);
    const tokens = familyByName(result, 'agent_viewer_tokens_total');
    assert.equal(sampleValue(tokens, { provider: 'anthropic', model: 'claude-sonnet', kind: 'input' }), 100);
    assert.equal(sampleValue(tokens, { provider: 'anthropic', model: 'claude-sonnet', kind: 'cache_read' }), 20);
    assert.equal(sampleValue(tokens, { provider: 'anthropic', model: 'claude-sonnet', kind: 'cache_write' }), undefined);
    assert.equal(sampleValue(tokens, { provider: 'anthropic', model: 'claude-sonnet', kind: 'reasoning' }), undefined);

    const unreported = familyByName(result, 'agent_viewer_token_kind_unreported_calls_total');
    assert.equal(sampleValue(unreported, { provider: 'anthropic', model: 'claude-sonnet', kind: 'cache_write' }), 1);
    assert.equal(sampleValue(unreported, { provider: 'anthropic', model: 'claude-sonnet', kind: 'reasoning' }), 1);
    assert.equal(sampleValue(unreported, { provider: 'anthropic', model: 'claude-sonnet', kind: 'input' }), undefined);
  });
});

test('tokens: a partially billed failed call still contributes the kinds it reported', async () => {
  await withMemoryStore(async (store) => {
    await seed(store, [{ type: 'llm.failed', payload: { errorKind: 'timeout', inputTokens: 30 } }]);
    const result = await computeLedgerFamilies(store);
    const tokens = familyByName(result, 'agent_viewer_tokens_total');
    assert.equal(sampleValue(tokens, { provider: 'anthropic', model: 'claude-sonnet', kind: 'input' }), 30);
    const unreported = familyByName(result, 'agent_viewer_token_kind_unreported_calls_total');
    assert.equal(sampleValue(unreported, { provider: 'anthropic', model: 'claude-sonnet', kind: 'output' }), 1);
  });
});

// -------------------------------------------------------------
// Cost: mixed currencies, missing currency, costSource=unknown with a cost, unknown-cost counting
// -------------------------------------------------------------

test('cost: currencies are never merged, a missing currency lands in "unknown"', async () => {
  await withMemoryStore(async (store) => {
    await seed(store, [
      { payload: { cost: 10, currency: 'USD', costSource: 'provider-reported' } },
      { payload: { cost: 5, currency: 'EUR', costSource: 'provider-reported' } },
    ]);
    const reported = familyByName((await computeLedgerFamilies(store)), 'agent_viewer_cost_reported_total');
    assert.equal(sampleValue(reported, { provider: 'anthropic', model: 'claude-sonnet', currency: 'USD' }), 10);
    assert.equal(sampleValue(reported, { provider: 'anthropic', model: 'claude-sonnet', currency: 'EUR' }), 5);
  });
});

test('cost: a cost with costSource=unknown is never summed into cost_reported, and counts as an unknown reported cost', async () => {
  await withMemoryStore(async (store) => {
    await seed(store, [{ payload: { cost: 7, currency: 'USD', costSource: 'unknown' } }]);
    const result = await computeLedgerFamilies(store);
    const reported = familyByName(result, 'agent_viewer_cost_reported_total');
    assert.equal(reported.samples.length, 0);
    const unknown = familyByName(result, 'agent_viewer_cost_unknown_calls_total');
    assert.equal(sampleValue(unknown, { provider: 'anthropic', model: 'claude-sonnet', cost_kind: 'reported' }), 1);
  });
});

test('cost: a successful call with no cost increments cost_unknown_calls_total and contributes nothing to any sum', async () => {
  await withMemoryStore(async (store) => {
    await seed(store, [{ payload: { cost: undefined, currency: undefined, costSource: undefined } }]);
    const result = await computeLedgerFamilies(store);
    assert.equal(familyByName(result, 'agent_viewer_cost_reported_total').samples.length, 0);
    assert.equal(familyByName(result, 'agent_viewer_cost_estimated_total').samples.length, 0);
    const unknown = familyByName(result, 'agent_viewer_cost_unknown_calls_total');
    assert.equal(sampleValue(unknown, { provider: 'anthropic', model: 'claude-sonnet', cost_kind: 'reported' }), 1);
    assert.equal(sampleValue(unknown, { provider: 'anthropic', model: 'claude-sonnet', cost_kind: 'estimated' }), 1);
  });
});

test('cost: a priced model contributes to cost_estimated_total, separate from cost_reported_total', async () => {
  const pricing = {
    pricingVersion: 1,
    entries: [
      {
        provider: 'anthropic',
        model: 'claude-sonnet',
        aliases: [],
        kind: 'list',
        currency: 'USD',
        effectiveFrom: '2000-01-01T00:00:00.000Z',
        inputPerMillion: 1_000_000, // $1 per token, to make the expected total trivial to check
        outputPerMillion: 0,
        cacheReadPerMillion: null,
        cacheWritePerMillion: null,
        reasoningPerMillion: null,
        reasoningBilling: 'included_in_output',
        source: 'file',
        estimated: false,
        sourceUrl: null,
        sourceCheckedAt: null,
        note: null,
      },
    ],
  };
  await withMemoryStore(
    async (store) => {
      await seed(store, [{ payload: { inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: undefined, currency: undefined, costSource: undefined } }]);
      const result = await computeLedgerFamilies(store);
      const estimated = familyByName(result, 'agent_viewer_cost_estimated_total');
      assert.equal(sampleValue(estimated, { provider: 'anthropic', model: 'claude-sonnet', currency: 'USD' }), 2);
      assert.equal(familyByName(result, 'agent_viewer_cost_reported_total').samples.length, 0);
      const unknown = familyByName(result, 'agent_viewer_cost_unknown_calls_total');
      assert.equal(sampleValue(unknown, { provider: 'anthropic', model: 'claude-sonnet', cost_kind: 'estimated' }), undefined);
    },
    { getPricingSnapshot: () => pricing }
  );
});

// -------------------------------------------------------------
// Calls and failures
// -------------------------------------------------------------

test('calls and failures: status counts and failures-by-error_kind sum to calls_total{status="failed"}', async () => {
  await withMemoryStore(async (store) => {
    await seed(store, [
      {},
      {},
      { type: 'llm.failed', payload: { errorKind: 'rate_limited' } },
      { type: 'llm.failed', payload: { errorKind: 'timeout' } },
    ]);
    const result = await computeLedgerFamilies(store);
    const calls = familyByName(result, 'agent_viewer_llm_calls_total');
    assert.equal(sampleValue(calls, { provider: 'anthropic', model: 'claude-sonnet', status: 'ok' }), 2);
    assert.equal(sampleValue(calls, { provider: 'anthropic', model: 'claude-sonnet', status: 'failed' }), 2);
    const failures = familyByName(result, 'agent_viewer_llm_failures_total');
    assert.equal(sampleValue(failures, { provider: 'anthropic', model: 'claude-sonnet', error_kind: 'rate_limited' }), 1);
    assert.equal(sampleValue(failures, { provider: 'anthropic', model: 'claude-sonnet', error_kind: 'timeout' }), 1);
    const failureSum = failures.samples.reduce((acc, s) => acc + s.value, 0);
    assert.equal(failureSum, sampleValue(calls, { provider: 'anthropic', model: 'claude-sonnet', status: 'failed' }));
  });
});

// -------------------------------------------------------------
// Latency histogram
// -------------------------------------------------------------

test('latency: cumulative buckets, +Inf equals _count, only reported latencyMs is observed', async () => {
  await withMemoryStore(async (store) => {
    await seed(store, [
      { payload: { latencyMs: 50 } }, // 0.05s -> le=0.1
      { payload: { latencyMs: 300 } }, // 0.3s -> le=0.5
      { payload: { latencyMs: 1500 } }, // 1.5s -> le=2.5
      { type: 'llm.failed', payload: { errorKind: 'timeout', latencyMs: 50_000 } }, // 50s -> le=60
      { payload: { latencyMs: undefined } }, // not observed
    ]);
    const result = await computeLedgerFamilies(store);
    const latency = familyByName(result, 'agent_viewer_llm_latency_seconds');
    const bucket = (le) => sampleValue(latency, { provider: 'anthropic', model: 'claude-sonnet', le });
    assert.equal(bucket('0.1'), 1);
    assert.equal(bucket('0.25'), 1);
    assert.equal(bucket('0.5'), 2);
    assert.equal(bucket('2.5'), 3);
    assert.equal(bucket('60'), 4);
    assert.equal(bucket('+Inf'), 4);
    const count = latency.samples.find((s) => s.suffix === '_count' && s.labels.provider === 'anthropic');
    assert.equal(count.value, 4);
    const sum = latency.samples.find((s) => s.suffix === '_sum' && s.labels.provider === 'anthropic');
    assert.ok(Math.abs(sum.value - (0.05 + 0.3 + 1.5 + 50)) < 1e-9);
  });
});

test('latency: a group with no reported latencyMs at all emits no histogram series for it', async () => {
  await withMemoryStore(async (store) => {
    await seed(store, [{ payload: { latencyMs: undefined } }]);
    const result = await computeLedgerFamilies(store);
    assert.equal(familyByName(result, 'agent_viewer_llm_latency_seconds').samples.length, 0);
  });
});

// -------------------------------------------------------------
// Cardinality cap and label sanitize-then-merge
// -------------------------------------------------------------

test('cardinality cap: pairs beyond maxModels fold into provider="__other__",model="__other__", earliest pairs keep their name', async () => {
  await withMemoryStore(async (store) => {
    await seed(store, [
      { payload: { provider: 'p1', model: 'm1' } },
      { payload: { provider: 'p2', model: 'm2' } },
      { payload: { provider: 'p3', model: 'm3' } },
    ]);
    const result = await computeLedgerFamilies(store, 2);
    const calls = familyByName(result, 'agent_viewer_llm_calls_total');
    assert.equal(sampleValue(calls, { provider: 'p1', model: 'm1', status: 'ok' }), 1);
    assert.equal(sampleValue(calls, { provider: 'p2', model: 'm2', status: 'ok' }), 1);
    assert.equal(sampleValue(calls, { provider: 'p3', model: 'm3', status: 'ok' }), undefined);
    assert.equal(sampleValue(calls, { provider: '__other__', model: '__other__', status: 'ok' }), 1);
  });
});

test('label hygiene: two providers that sanitize to the same value merge into one series', async () => {
  await withMemoryStore(async (store) => {
    await seed(store, [{ payload: { provider: 'openai\x00evil' } }, { payload: { provider: 'openaievil' } }]);
    const result = await computeLedgerFamilies(store);
    const calls = familyByName(result, 'agent_viewer_llm_calls_total');
    const openaiSamples = calls.samples.filter((s) => s.labels.provider === 'openaievil');
    assert.equal(openaiSamples.length, 1);
    assert.equal(openaiSamples[0].value, 2);
  });
});

test('null model is labeled "unknown" (provider is required by the canonical contract, so only model can be absent)', async () => {
  await withMemoryStore(async (store) => {
    // `model` is nullish only on llm.failed (issue #59: an OTLP connection failure before a model was chosen).
    await seed(store, [{ type: 'llm.failed', payload: { errorKind: 'timeout', model: undefined } }]);
    const result = await computeLedgerFamilies(store);
    const calls = familyByName(result, 'agent_viewer_llm_calls_total');
    assert.equal(sampleValue(calls, { provider: 'anthropic', model: 'unknown', status: 'failed' }), 1);
  });
});

// -------------------------------------------------------------
// Ledger gauges
// -------------------------------------------------------------

test('ledger gauges: omitted on an empty ledger, never a false 0', async () => {
  await withMemoryStore(async (store) => {
    const result = await computeLedgerFamilies(store);
    const families = buildLedgerGaugeFamilies(result.gauges);
    assert.equal(families.find((f) => f.name === 'agent_viewer_ledger_retained_since_seconds').samples.length, 0);
    assert.equal(families.find((f) => f.name === 'agent_viewer_ledger_last_usage_timestamp_seconds').samples.length, 0);
  });
});

test('ledger gauges: equal the oldest and newest received_at, in seconds', async () => {
  await withMemoryStore(async (store) => {
    await seed(store, [{ receivedAt: 1_700_000_000_000 }, { receivedAt: 1_700_000_100_000 }]);
    const result = await computeLedgerFamilies(store);
    const families = buildLedgerGaugeFamilies(result.gauges);
    const retained = families.find((f) => f.name === 'agent_viewer_ledger_retained_since_seconds');
    const lastUsage = families.find((f) => f.name === 'agent_viewer_ledger_last_usage_timestamp_seconds');
    assert.equal(retained.samples[0].value, 1_700_000_000);
    assert.equal(lastUsage.samples[0].value, 1_700_000_100);
  });
});

// -------------------------------------------------------------
// Memory ring buffer independence, and SQLite reopen
// -------------------------------------------------------------

test('memory mode: ledger-derived counts are never lowered by the events ring buffer evicting events', async () => {
  await withMemoryStore(
    async (store) => {
      for (let i = 0; i < 5; i++) await seed(store, [{}]);
      const result = await computeLedgerFamilies(store);
      const calls = familyByName(result, 'agent_viewer_llm_calls_total');
      assert.equal(sampleValue(calls, { provider: 'anthropic', model: 'claude-sonnet', status: 'ok' }), 5);
    },
    { maxEvents: 2, usageLedgerMaxRows: 1000 }
  );
});

test('sqlite mode: ledger-derived counts survive a close and reopen of the same database', async () => {
  const { dir, file } = tempDbPath('reopen');
  try {
    let store = new SQLiteEventStore(file, { backup: 'off' });
    await store.init();
    await seed(store, [{}, { type: 'llm.failed', payload: { errorKind: 'timeout' } }]);
    await store.close();

    store = new SQLiteEventStore(file, { backup: 'off' });
    await store.init();
    const result = await computeLedgerFamilies(store);
    const calls = familyByName(result, 'agent_viewer_llm_calls_total');
    assert.equal(sampleValue(calls, { provider: 'anthropic', model: 'claude-sonnet', status: 'ok' }), 1);
    assert.equal(sampleValue(calls, { provider: 'anthropic', model: 'claude-sonnet', status: 'failed' }), 1);
    await store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Scrape cache: TTL, concurrency de-duplication, failure is never cached
// -------------------------------------------------------------

function fakeStore({ rows = [], ledgerSeq, firstAt = null, lastAt = null, rollupDelayMs = 0, rollupShouldFail = false } = {}) {
  let rollupCalls = 0;
  const resolvedLedgerSeq = ledgerSeq ?? (rows.length > 0 ? rows.length : null);
  return {
    get rollupCallCount() {
      return rollupCalls;
    },
    async rollup() {
      rollupCalls++;
      if (rollupDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, rollupDelayMs));
      if (rollupShouldFail) throw new Error('ledger query failed');
      return { asOf: { ledgerSeq: resolvedLedgerSeq }, totals: { firstAt, lastAt } };
    },
    async *iterateExportRows() {
      for (const row of rows) yield row;
    },
  };
}

test('cache: two gets within the TTL run the ledger query once', async () => {
  const store = fakeStore({});
  const cache = new LedgerFamiliesCache({ getStore: () => store, getTtlMs: () => 5000, getMaxModels: () => DEFAULT_METRICS_MAX_MODELS });
  await cache.get();
  await cache.get();
  assert.equal(store.rollupCallCount, 1);
});

test('cache: ttl=0 disables caching, every get recomputes', async () => {
  const store = fakeStore({});
  const cache = new LedgerFamiliesCache({ getStore: () => store, getTtlMs: () => 0, getMaxModels: () => DEFAULT_METRICS_MAX_MODELS });
  await cache.get();
  await cache.get();
  assert.equal(store.rollupCallCount, 2);
});

test('cache: concurrent gets share one in-flight computation', async () => {
  const store = fakeStore({ rollupDelayMs: 20 });
  const cache = new LedgerFamiliesCache({ getStore: () => store, getTtlMs: () => 5000, getMaxModels: () => DEFAULT_METRICS_MAX_MODELS });
  await Promise.all([cache.get(), cache.get(), cache.get()]);
  assert.equal(store.rollupCallCount, 1);
});

test('cache: a failing ledger query is not cached, the next get retries', async () => {
  const store = fakeStore({ rollupShouldFail: true });
  const cache = new LedgerFamiliesCache({ getStore: () => store, getTtlMs: () => 5000, getMaxModels: () => DEFAULT_METRICS_MAX_MODELS });
  await assert.rejects(() => cache.get());
  await assert.rejects(() => cache.get());
  assert.equal(store.rollupCallCount, 2);
});

// -------------------------------------------------------------
// HTTP route: ledger families on a real scrape, and the 503 on a failing ledger query
// -------------------------------------------------------------

test('GET /metrics: ledger-derived families appear end to end, and a failing ledger query gives 503 metrics_unavailable', async () => {
  const pricingHome = fs.mkdtempSync(path.join(os.tmpdir(), 'av-pricing-metrics-ledger-'));
  process.env.AGENT_VIEWER_PRICING_FILE = path.join(pricingHome, 'pricing.json');
  process.env.AGENT_VIEWER_PRICING_HISTORY_FILE = path.join(pricingHome, 'pricing-history.jsonl');
  process.env.AGENT_VIEWER_METRICS = '1';
  process.env.AGENT_VIEWER_METRICS_AUTH = 'off';
  process.env.AGENT_VIEWER_METRICS_CACHE_MS = '0';
  delete process.env.AGENT_VIEWER_API_TOKEN;
  delete process.env.AGENT_VIEWER_API_KEY;
  delete process.env.AGENT_VIEWER_WEBHOOK_SECRET;

  const http = await import('node:http');
  const { app, store } = await import('../server/index.ts');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const postRes = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: '1.0',
        id: 'evt_metrics_ledger_http_1',
        type: 'llm.usage',
        timestamp: Date.now(),
        source: 'agent:alice',
        agentId: 'alice',
        summary: 'http ledger metrics test',
        payload: { provider: 'anthropic', model: 'claude-sonnet', inputTokens: 10, outputTokens: 5, cost: 1, currency: 'USD', costSource: 'provider-reported', requestId: 'req_http_1' },
      }),
    });
    assert.equal(postRes.status, 202);

    const scrapeRes = await fetch(`${baseUrl}/metrics`);
    assert.equal(scrapeRes.status, 200);
    const body = await scrapeRes.text();
    assert.match(body, /agent_viewer_tokens_total\{provider="anthropic",model="claude-sonnet",kind="input"\} 10/);
    assert.match(body, /agent_viewer_llm_calls_total\{provider="anthropic",model="claude-sonnet",status="ok"\} 1/);
    assert.match(body, /agent_viewer_ledger_last_usage_timestamp_seconds \d/);

    const original = store.rollup;
    store.rollup = async () => {
      throw new Error('boom');
    };
    try {
      const failRes = await fetch(`${baseUrl}/metrics`);
      assert.equal(failRes.status, 503);
      assert.deepEqual(await failRes.json(), { error: 'metrics_unavailable' });
    } finally {
      store.rollup = original;
    }
  } finally {
    server.close();
  }
});
