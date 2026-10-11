// Issue #89 (split from #285): `include=latency,failures` on the usage rollup endpoint (issue #66). Covers the
// pure percentile/failure functions (`server/usage/reliability.ts`), the normative rules from the issue (sample
// definition, missing accounting, failure-latency exclusion, nearest-rank method, failureRate, dedup, totals from
// raw samples, rate-limit counting, null-model/no-errorKind grouping), memory-vs-SQLite parity, and `include`
// parameter validation. HTTP-level behavior (400 shape, `include` combinations over the wire) lives in
// tests/integration-api.test.mjs; the ingest-limiter/provider-rate-limit distinction lives in
// tests/server-rate-limit.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryEventStore, SQLiteEventStore } from '../server/store.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';
import { parseRollupQuery, UsageFilterError } from '../server/usage/rollup.ts';
import {
  computeFailureRate,
  failureErrorKindKey,
  nearestRankPercentile,
  RATE_LIMIT_ERROR_KIND,
  summarizeFailures,
  summarizeLatency,
} from '../server/usage/reliability.ts';

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-reliability-'));
  return { dir, file: path.join(dir, `${name}.db`) };
}

let eventCounter = 0;
function usageEvent(overrides = {}) {
  eventCounter++;
  const { receivedAt, ...rest } = overrides;
  const payload = {
    provider: 'anthropic',
    model: 'claude-sonnet',
    inputTokens: 100,
    outputTokens: 50,
    cost: 1,
    currency: 'USD',
    costSource: 'provider-reported',
    requestId: `req_${eventCounter}`,
    tags: [],
    ...rest.payload,
  };
  const result = validateCanonicalEvent({
    id: rest.id ?? `evt_${eventCounter}`,
    type: rest.type ?? 'llm.usage',
    timestamp: rest.timestamp ?? 1_700_000_000_000 + eventCounter,
    source: rest.agentId === null ? 'system:test' : 'agent:test',
    agentId: rest.agentId === undefined ? 'agent-1' : rest.agentId === null ? undefined : rest.agentId,
    sessionId: rest.sessionId,
    taskId: rest.taskId,
    userId: rest.userId,
    summary: 'test call',
    payload: { ...payload, errorKind: rest.errorKind },
  });
  if (!result.success) throw new Error(`invalid test event: ${JSON.stringify(result.issues)}`);
  return { event: result.data, receivedAt };
}

async function seed(store, events) {
  for (const { event, receivedAt } of events) {
    const res = await store.append(event, receivedAt !== undefined ? { receivedAt } : undefined);
    assert.equal(res.outcome, 'accepted', `expected ${event.id} to be accepted, got ${res.outcome}`);
  }
}

async function withMemoryStore(fn) {
  const store = new MemoryEventStore(100_000);
  await store.init();
  try {
    await fn(store);
  } finally {
    await store.close();
  }
}

async function withSqliteStore(fn) {
  const { dir, file } = tempDbPath('reliability');
  const store = new SQLiteEventStore(file, { backup: 'off' });
  await store.init();
  try {
    await fn(store);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs the same test body against both backends, under one `test()` each so a failure names the backend. */
function eachStore(name, fn) {
  test(`${name} (memory)`, () => withMemoryStore(fn));
  test(`${name} (sqlite)`, () => withSqliteStore(fn));
}

function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -------------------------------------------------------------
// Pure functions: nearestRankPercentile, summarizeLatency, failureErrorKindKey, summarizeFailures,
// computeFailureRate (issue #89, rule 4/5/9).
// -------------------------------------------------------------

test('nearestRankPercentile: n = 1 gives p50 = p95 = the single value', () => {
  assert.equal(nearestRankPercentile([42], 0.5), 42);
  assert.equal(nearestRankPercentile([42], 0.95), 42);
});

test('nearestRankPercentile: n = 2 gives p50 = sorted[0] and p95 = sorted[1]', () => {
  const samples = [20, 10];
  assert.equal(nearestRankPercentile(samples, 0.5), 10);
  assert.equal(nearestRankPercentile(samples, 0.95), 20);
});

test('nearestRankPercentile: n = 20 gives p50 = sorted[9] and p95 = sorted[18]', () => {
  const samples = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
  assert.equal(nearestRankPercentile(samples, 0.5), 10); // sorted[9] (0-indexed) = 10
  assert.equal(nearestRankPercentile(samples, 0.95), 19); // sorted[18] = 19
});

test('nearestRankPercentile: n = 100 gives p50 = sorted[49] and p95 = sorted[94]', () => {
  const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(nearestRankPercentile(samples, 0.5), 50);
  assert.equal(nearestRankPercentile(samples, 0.95), 95);
});

test('nearestRankPercentile: ties return the tied value', () => {
  assert.equal(nearestRankPercentile([5, 5, 5, 5], 0.5), 5);
  assert.equal(nearestRankPercentile([5, 5, 5, 5], 0.95), 5);
});

test('nearestRankPercentile: unsorted input is sorted internally', () => {
  const samples = [30, 10, 20];
  assert.equal(nearestRankPercentile(samples, 0.5), 20);
  assert.equal(nearestRankPercentile(samples, 0.95), 30);
  // Input array is not mutated.
  assert.deepEqual(samples, [30, 10, 20]);
});

test('nearestRankPercentile: a single reported 0 is a real value, not excluded', () => {
  assert.equal(nearestRankPercentile([0], 0.5), 0);
  assert.equal(nearestRankPercentile([0], 0.95), 0);
});

test('nearestRankPercentile: empty input throws (callers must check length first)', () => {
  assert.throws(() => nearestRankPercentile([], 0.5));
});

test('nearestRankPercentile: property - result is always an element of the input, p50 <= p95 (seeded random)', () => {
  const rand = mulberry32(7);
  for (let trial = 0; trial < 200; trial++) {
    const n = 1 + Math.floor(rand() * 50);
    const samples = Array.from({ length: n }, () => Math.floor(rand() * 10_000));
    const p50 = nearestRankPercentile(samples, 0.5);
    const p95 = nearestRankPercentile(samples, 0.95);
    assert.ok(samples.includes(p50), `p50 ${p50} not in ${JSON.stringify(samples)}`);
    assert.ok(samples.includes(p95), `p95 ${p95} not in ${JSON.stringify(samples)}`);
    assert.ok(p50 <= p95, `p50 ${p50} > p95 ${p95} for ${JSON.stringify(samples)}`);
  }
});

test('summarizeLatency: no samples returns null percentiles, never 0, and keeps missing', () => {
  assert.deepEqual(summarizeLatency([], 5), { p50Ms: null, p95Ms: null, samples: 0, missing: 5, method: 'nearest-rank' });
});

test('summarizeLatency: a reported 0 counts as a sample', () => {
  assert.deepEqual(summarizeLatency([0], 0), { p50Ms: 0, p95Ms: 0, samples: 1, missing: 0, method: 'nearest-rank' });
});

test('failureErrorKindKey: null and "unknown" both map to "unspecified"; everything else passes through', () => {
  assert.equal(failureErrorKindKey(null), 'unspecified');
  assert.equal(failureErrorKindKey('unknown'), 'unspecified');
  assert.equal(failureErrorKindKey('rate_limited'), 'rate_limited');
  assert.equal(failureErrorKindKey('timeout'), 'timeout');
});

test('summarizeFailures: rateLimitCount reads the "rate_limited" bucket, 0 when absent', () => {
  assert.deepEqual(summarizeFailures({ rate_limited: 3, timeout: 2 }), {
    byErrorKind: { rate_limited: 3, timeout: 2 },
    rateLimitCount: 3,
  });
  assert.deepEqual(summarizeFailures({}), { byErrorKind: {}, rateLimitCount: 0 });
});

test('computeFailureRate: null when attempts is 0, 0 (not null) when there were attempts and no failures', () => {
  assert.equal(computeFailureRate(0, 0), null);
  assert.equal(computeFailureRate(0, 5), 0);
  assert.equal(computeFailureRate(2, 10), 0.2);
});

test('RATE_LIMIT_ERROR_KIND is the real shipped enum value, not the issue text\'s own example', () => {
  // src/integrations/canonicalTypes.ts's LLM_ERROR_KINDS has "rate_limited", never "rate_limit".
  assert.equal(RATE_LIMIT_ERROR_KIND, 'rate_limited');
});

// -------------------------------------------------------------
// parseRollupQuery: `include` parsing/validation
// -------------------------------------------------------------

test('parseRollupQuery: include is empty by default', () => {
  const query = parseRollupQuery({ groupBy: 'agent' });
  assert.deepEqual(query.include, []);
});

test('parseRollupQuery: include accepts latency, failures, or both, comma-separated', () => {
  assert.deepEqual(parseRollupQuery({ groupBy: 'agent', include: 'latency' }).include, ['latency']);
  assert.deepEqual(parseRollupQuery({ groupBy: 'agent', include: 'failures' }).include, ['failures']);
  assert.deepEqual(parseRollupQuery({ groupBy: 'agent', include: 'latency,failures' }).include, ['latency', 'failures']);
});

test('parseRollupQuery: an unknown include value is rejected', () => {
  assert.throws(
    () => parseRollupQuery({ groupBy: 'agent', include: 'latency,bogus' }),
    (err) => {
      assert.ok(err instanceof UsageFilterError);
      assert.ok(err.issues.some((i) => i.path === 'include'));
      return true;
    }
  );
});

test('parseRollupQuery: a duplicate include value is tolerated, not an error', () => {
  assert.deepEqual(parseRollupQuery({ groupBy: 'agent', include: 'latency,latency' }).include, ['latency']);
});

// -------------------------------------------------------------
// Store tests (rules 1-3, 9): latency samples, missing accounting, failure latency exclusion.
// -------------------------------------------------------------

eachStore('latency: a succeeded call with latencyMs is a sample; one without is counted in missing', async (store) => {
  await seed(store, [usageEvent({ payload: { latencyMs: 820 } }), usageEvent({ payload: {} })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', include: 'latency' }));
  assert.deepEqual(result.totals.latency, { p50Ms: 820, p95Ms: 820, samples: 1, missing: 1, method: 'nearest-rank' });
  assert.equal(result.totals.latency.samples + result.totals.latency.missing, result.totals.calls.succeeded);
});

eachStore('latency: a reported 0 is a real sample, never coerced or treated as unknown', async (store) => {
  await seed(store, [usageEvent({ payload: { latencyMs: 0 } })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', include: 'latency' }));
  assert.deepEqual(result.totals.latency, { p50Ms: 0, p95Ms: 0, samples: 1, missing: 0, method: 'nearest-rank' });
});

eachStore('latency: no succeeded calls at all reports null percentiles, not 0', async (store) => {
  await seed(store, [usageEvent({ type: 'llm.failed', errorKind: 'timeout', payload: { cost: null, currency: null } })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', include: 'latency' }));
  assert.deepEqual(result.totals.latency, { p50Ms: null, p95Ms: null, samples: 0, missing: 0, method: 'nearest-rank' });
});

eachStore('latency: a failed row\'s latencyMs never enters the success percentiles', async (store) => {
  await seed(store, [
    usageEvent({ payload: { latencyMs: 100 } }),
    usageEvent({ type: 'llm.failed', errorKind: 'timeout', payload: { latencyMs: 5000, cost: null, currency: null } }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', include: 'latency' }));
  assert.equal(result.totals.latency.samples, 1);
  assert.equal(result.totals.latency.p50Ms, 100);
  assert.equal(result.totals.latency.p95Ms, 100);
});

eachStore('latency: include=failures alone never returns latency fields and vice versa', async (store) => {
  await seed(store, [usageEvent({ payload: { latencyMs: 100 } })]);
  const latencyOnly = await store.rollup(parseRollupQuery({ groupBy: 'agent', include: 'latency' }));
  assert.ok(latencyOnly.totals.latency);
  assert.equal(latencyOnly.totals.failures, undefined);
  assert.equal(latencyOnly.totals.failedCalls, undefined);
  assert.equal(latencyOnly.totals.attempts, undefined);
  assert.equal(latencyOnly.totals.failureRate, undefined);

  const failuresOnly = await store.rollup(parseRollupQuery({ groupBy: 'agent', include: 'failures' }));
  assert.equal(failuresOnly.totals.latency, undefined);
  assert.ok(failuresOnly.totals.failures);

  const neither = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  assert.equal(neither.totals.latency, undefined);
  assert.equal(neither.totals.failures, undefined);
});

// -------------------------------------------------------------
// Failures: byErrorKind, unspecified bucket, rateLimitCount, failedCalls/attempts/failureRate (rules 5, 8, 9).
// -------------------------------------------------------------

eachStore('failures: byErrorKind groups failed calls by errorKind; a missing one is "unspecified"', async (store) => {
  await seed(store, [
    usageEvent({ type: 'llm.failed', errorKind: 'rate_limited', payload: { cost: null, currency: null } }),
    usageEvent({ type: 'llm.failed', errorKind: 'rate_limited', payload: { cost: null, currency: null } }),
    usageEvent({ type: 'llm.failed', errorKind: 'timeout', payload: { cost: null, currency: null } }),
    usageEvent({ type: 'llm.failed', errorKind: undefined, payload: { cost: null, currency: null } }),
    usageEvent({ payload: {} }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', include: 'failures' }));
  assert.deepEqual(result.totals.failures.byErrorKind, { rate_limited: 2, timeout: 1, unspecified: 1 });
  assert.equal(result.totals.failures.rateLimitCount, 2);
  assert.equal(result.totals.failedCalls, 4);
  assert.equal(result.totals.attempts, 5);
  assert.equal(result.totals.failureRate, 4 / 5);
});

eachStore('failures: rateLimitCount only counts errorKind "rate_limited", never a different kind', async (store) => {
  await seed(store, [
    usageEvent({ type: 'llm.failed', errorKind: 'overloaded', payload: { cost: null, currency: null } }),
    usageEvent({ type: 'llm.failed', errorKind: 'network', payload: { cost: null, currency: null } }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', include: 'failures' }));
  assert.equal(result.totals.failures.rateLimitCount, 0);
});

eachStore('failures: no attempts at all reports failureRate null, never 0', async (store) => {
  // An agent with zero ledger rows at all never appears as a group, but totals over an empty-matching filter
  // must still answer honestly.
  await seed(store, [usageEvent({ agentId: 'agent-present' })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', agentId: 'agent-absent', include: 'failures' }));
  assert.equal(result.totals.attempts, 0);
  assert.equal(result.totals.failureRate, null);
});

eachStore('failures: having attempts and zero failures reports failureRate 0, not null', async (store) => {
  await seed(store, [usageEvent({}), usageEvent({})]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', include: 'failures' }));
  assert.equal(result.totals.failureRate, 0);
});

eachStore('rows with no model get their own null group, never dropped', async (store) => {
  // `model` is omitted (not `null`: the strict validator rejects an explicit `null`), which is exactly how the
  // OTLP receiver sends a `llm.failed` row for a connection failure before any model was chosen (issue #59);
  // `provider` is mandatory on both `llm.usage` and `llm.failed` (`LlmUsagePayloadSchema`/`LlmFailedPayloadSchema`
  // in `src/integrations/canonicalContract.ts` both require a non-empty string), so a live-ingested row can never
  // have a null provider; `toLedgerRow`'s own `normalizedOrNull` still handles that case defensively for a
  // legacy/backfilled row that predates the mandatory field, but that path has no validated-event test fixture.
  await seed(store, [
    usageEvent({ type: 'llm.failed', errorKind: 'timeout', payload: { model: undefined, cost: null, currency: null } }),
    usageEvent({ payload: { model: 'claude-sonnet' } }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'model', include: 'failures' }));
  const nullGroup = result.groups.find((g) => g.key.model === null);
  assert.ok(nullGroup, `expected a model:null group, got ${JSON.stringify(result.groups)}`);
  assert.equal(nullGroup.calls.failed, 1);
  assert.equal(nullGroup.failures.byErrorKind.timeout, 1);
});

// -------------------------------------------------------------
// Dedup (#48) does not inflate attempts/samples (rule 6).
// -------------------------------------------------------------

eachStore('dedup: an exact resubmission under the same (provider, requestId) is not double-counted', async (store) => {
  const { event: first } = usageEvent({ id: 'evt_dedup_1', payload: { requestId: 'req-dedup-1', latencyMs: 100 } });
  const { event: second } = usageEvent({ id: 'evt_dedup_2', payload: { requestId: 'req-dedup-1', latencyMs: 100 } });
  const firstRes = await store.append(first);
  assert.equal(firstRes.outcome, 'accepted');
  // Same provider+requestId, identical content: the ledger (#48) keeps only the first (`duplicate` outcome, not
  // a second ledger row), so this is intentionally not routed through the shared `seed()` helper.
  const secondRes = await store.append(second);
  assert.equal(secondRes.outcome, 'duplicate');

  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', include: 'latency,failures' }));
  assert.equal(result.totals.calls.total, 1);
  assert.equal(result.totals.attempts, 1);
  assert.equal(result.totals.latency.samples, 1);
});

eachStore('dedup: a failed attempt and a successful retry under different requestIds are both counted', async (store) => {
  // A real provider retry gets its own request id (the provider assigns one per call); #48's own dedup key is
  // (provider, requestId), so two distinct requestIds are never merged, independent of event type.
  await seed(store, [
    usageEvent({ type: 'llm.failed', errorKind: 'timeout', payload: { requestId: 'req-attempt-1', cost: null, currency: null } }),
    usageEvent({ payload: { requestId: 'req-attempt-2', latencyMs: 250 } }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', include: 'latency,failures' }));
  assert.equal(result.totals.attempts, 2);
  assert.equal(result.totals.failedCalls, 1);
  assert.equal(result.totals.calls.succeeded, 1);
  assert.equal(result.totals.latency.samples, 1);
});

// -------------------------------------------------------------
// Rule 7: totals percentiles come from the raw matching row set, never from combining group percentiles.
// Hand-verified fixture (see the module's own derivation in the PR description): group "model-a" (n=3,
// [10, 20, 30]) has its own p95 = 30; group "model-b" (n=17, all 15) has its own p95 = 15; the pooled 20-value
// set's p95 is 20, which equals neither group's own p95 nor their average (22.5).
// -------------------------------------------------------------

eachStore('rule 7: totals p95 differs from either group\'s own p95 and from their average', async (store) => {
  const events = [];
  for (const latencyMs of [10, 20, 30]) {
    events.push(usageEvent({ payload: { model: 'model-a', latencyMs } }));
  }
  for (let i = 0; i < 17; i++) {
    events.push(usageEvent({ payload: { model: 'model-b', latencyMs: 15 } }));
  }
  await seed(store, events);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'model', include: 'latency' }));

  const groupA = result.groups.find((g) => g.key.model === 'model-a');
  const groupB = result.groups.find((g) => g.key.model === 'model-b');
  assert.equal(groupA.latency.p95Ms, 30);
  assert.equal(groupB.latency.p95Ms, 15);

  assert.equal(result.totals.latency.samples, 20);
  assert.equal(result.totals.latency.p95Ms, 20);
  assert.notEqual(result.totals.latency.p95Ms, groupA.latency.p95Ms);
  assert.notEqual(result.totals.latency.p95Ms, groupB.latency.p95Ms);
  assert.notEqual(result.totals.latency.p95Ms, (groupA.latency.p95Ms + groupB.latency.p95Ms) / 2);
});

// -------------------------------------------------------------
// Memory vs SQLite parity, mixed fixture (same style as tests/usage-rollup.test.mjs's own parity test).
// -------------------------------------------------------------

test('reliability: memory and sqlite stores return identical JSON for include=latency,failures over a mixed fixture', async () => {
  const events = [];
  for (let i = 0; i < 40; i++) {
    const isFailed = i % 7 === 0;
    events.push(
      usageEvent({
        agentId: `agent-${i % 3}`,
        payload: {
          // `model` is only nullable on `llm.failed` (`LlmFailedPayloadSchema`); `llm.usage` requires one.
          model: isFailed && i % 5 === 0 ? undefined : `model-${i % 4}`,
          provider: i % 2 === 0 ? 'anthropic' : 'openai',
          latencyMs: isFailed ? undefined : i % 6 === 0 ? undefined : i * 10,
          requestId: `req-${i}`,
        },
        receivedAt: 1_700_000_000_000 + i * 60_000,
        type: isFailed ? 'llm.failed' : 'llm.usage',
        errorKind: isFailed ? ['rate_limited', 'timeout', 'server_error', undefined][i % 4] : undefined,
      })
    );
  }

  const memory = new MemoryEventStore(100_000);
  await memory.init();
  const { dir, file } = tempDbPath('reliability-parity');
  const sqlite = new SQLiteEventStore(file, { backup: 'off' });
  await sqlite.init();

  try {
    await seed(memory, events);
    await seed(sqlite, events);

    for (const groupBy of ['agent', 'model,provider', 'model']) {
      const query = parseRollupQuery({ groupBy, sort: 'calls', include: 'latency,failures' });
      const memResult = await memory.rollup(query);
      const sqlResult = await sqlite.rollup(query);
      const normalize = (r) => {
        const clone = JSON.parse(JSON.stringify(r));
        clone.coverage.storage = 'x';
        clone.asOf.generatedAt = 0;
        // latency.p50Ms/p95Ms are computed over arrays collected in a different order per backend (SQL row
        // order is unspecified without ORDER BY); nearestRankPercentile sorts internally so the *values* must
        // still match exactly. Groups themselves may come back in a different array order pre-sort, but
        // shapeRollupResponse already sorts groups deterministically, so no extra normalization is needed there.
        return clone;
      };
      assert.deepEqual(normalize(memResult), normalize(sqlResult), `mismatch for groupBy=${groupBy}`);
    }
  } finally {
    await memory.close();
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
