import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createUsageReducer, formatNanoUnits, toNanoUnits } from '../server/usageAggregates.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';

const TOKEN_KINDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

function loadUsageFixture(name) {
  const text = fs.readFileSync(new URL(`./fixtures/usage/${name}.jsonl`, import.meta.url), 'utf8');
  return text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

let sequence = 0;

/** Builds one usage event. `payload` replaces the default payload fields it names. */
function call(type, { agentId, source, timestamp = 1000, payload = {} } = {}) {
  sequence += 1;
  return {
    schemaVersion: '1.0',
    id: `evt_red_${sequence}`,
    type,
    timestamp,
    source: source ?? (agentId === undefined ? 'external' : `agent:${agentId}`),
    ...(agentId === undefined ? {} : { agentId }),
    severity: 'normal',
    summary: 'usage',
    payload: {
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 100,
      outputTokens: 10,
      ...payload,
    },
  };
}

const usage = (options) => call('llm.usage', options);
const failed = (options) => call('llm.failed', options);

function reduce(events) {
  const reducer = createUsageReducer();
  for (const event of events) reducer.apply(event);
  return reducer;
}

function findAgent(summary, agentId) {
  return summary.byAgent.find((entry) => entry.agentId === agentId);
}

function findModel(list, provider, model) {
  return list.find((entry) => entry.provider === provider && entry.model === model);
}

/** Every bucket of a summary: total, byModel, byAgent and byAgent[].byModel, with their failed sub-buckets. */
function allBuckets(summary) {
  const aggregates = [
    summary.total,
    ...summary.byModel,
    ...summary.byAgent,
    ...summary.byAgent.flatMap((agent) => agent.byModel),
  ];
  return aggregates.flatMap((aggregate) => [aggregate, aggregate.failed]);
}

function assertInvariants(summary) {
  for (const bucket of allBuckets(summary)) {
    const pairCalls = bucket.byCurrency.reduce((total, pair) => total + pair.calls, 0);
    assert.equal(pairCalls + bucket.costUnknownCount, bucket.calls, 'each call lands in exactly one cost slot');
    assert.equal(bucket.costUnknownCount, bucket.costMissingCount + bucket.currencyMissingCount);
    for (const kind of TOKEN_KINDS) {
      const figure = bucket.tokens[kind];
      assert.ok(figure.unreportedCount <= bucket.calls, `${kind}.unreportedCount <= calls`);
      assert.equal(figure.sum === null, figure.unreportedCount === bucket.calls, `${kind}.sum is null exactly when no call reported it`);
    }
  }
}

function emptyBucket() {
  const tokens = {};
  for (const kind of TOKEN_KINDS) tokens[kind] = { sum: null, unreportedCount: 0 };
  return {
    calls: 0,
    tokens,
    byCurrency: [],
    costUnknownCount: 0,
    costMissingCount: 0,
    currencyMissingCount: 0,
    firstTimestamp: null,
    lastTimestamp: null,
  };
}

/** Collects every number and string anywhere in a value. */
function collectLeaves(value, out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value === 'number' || typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectLeaves(item, out));
  else if (typeof value === 'object') Object.values(value).forEach((item) => collectLeaves(item, out));
  return out;
}

/** Deterministic PRNG (mulberry32) so the shuffles are the same on every run. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, random) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// -------------------------------------------------------------
// Module boundaries
// -------------------------------------------------------------

test('usageAggregates: imports nothing from the store, node built-ins or Express', () => {
  const source = fs.readFileSync(new URL('../server/usageAggregates.ts', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const dynamic = [...source.matchAll(/(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(specifiers, ['../src/integrations/canonicalContract']);
  assert.deepEqual(dynamic, []);
  for (const specifier of [...specifiers, ...dynamic]) {
    assert.ok(!specifier.includes('store'), `unexpected import ${specifier}`);
    assert.ok(!specifier.startsWith('node:'), `unexpected import ${specifier}`);
    assert.notEqual(specifier, 'express');
  }
});

test('usageAggregates: the store never reads usage payload fields, so the reducer is the only interpreter', () => {
  const source = fs.readFileSync(new URL('../server/store.ts', import.meta.url), 'utf8');
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cachedTokens', 'reasoningTokens'];
  for (const field of fields) {
    const dotted = new RegExp(`payload\\s*\\??\\.\\s*${field}\\b`);
    const indexed = new RegExp(`payload\\s*\\??\\.?\\s*\\[\\s*['"\`]${field}['"\`]\\s*\\]`);
    assert.equal(dotted.test(source), false, `server/store.ts reads payload.${field}`);
    assert.equal(indexed.test(source), false, `server/store.ts reads payload['${field}']`);
  }
  assert.equal(/private\s+totalTokens/.test(source), false, 'the totalTokens counter is gone');
  assert.equal(/private\s+totalCost/.test(source), false, 'the totalCost counter is gone');
});

// -------------------------------------------------------------
// Empty state and ignored events
// -------------------------------------------------------------

test('usageAggregates: an empty reducer returns the empty shape, with null sums and no buckets', () => {
  const reducer = createUsageReducer();
  assert.deepEqual(reducer.summary(), {
    schemaVersion: '1.0',
    eventsReduced: 0,
    total: { ...emptyBucket(), failed: emptyBucket() },
    byModel: [],
    byAgent: [],
  });
  assert.deepEqual(reducer.legacyTotals(), { tokens: { input: 0, output: 0, cached: 0, reasoning: 0 }, cost: null });
  assert.deepEqual(reducer.legacyAgent('nobody'), { tokens: { input: 0, output: 0, cached: 0, reasoning: 0 }, cost: null });
});

test('usageAggregates: event types other than llm.usage and llm.failed are ignored', () => {
  const reducer = reduce([
    { ...usage({ agentId: 'a' }), type: 'agent.status.changed', payload: { status: 'THINKING', inputTokens: 5, cost: 1 } },
    { ...usage({ agentId: 'a' }), type: 'tool.failed' },
  ]);
  assert.equal(reducer.summary().eventsReduced, 0);
  assert.deepEqual(reducer.summary().byAgent, []);
});

// -------------------------------------------------------------
// Attribution by model and by agent
// -------------------------------------------------------------

test('usageAggregates: each call is charged to its own model, never to the agent latest model', () => {
  const summary = reduce([
    usage({ agentId: 'planner', payload: { model: 'a', inputTokens: 100, outputTokens: 10 } }),
    usage({ agentId: 'planner', payload: { model: 'b', inputTokens: 300, outputTokens: 30 } }),
  ]).summary();

  assert.equal(summary.byModel.length, 2);
  const planner = findAgent(summary, 'planner');
  assert.equal(planner.byModel.length, 2);
  for (const list of [summary.byModel, planner.byModel]) {
    const a = findModel(list, 'openai', 'a');
    const b = findModel(list, 'openai', 'b');
    assert.equal(a.calls, 1);
    assert.equal(b.calls, 1);
    assert.deepEqual([a.tokens.input.sum, a.tokens.output.sum], [100, 10]);
    assert.deepEqual([b.tokens.input.sum, b.tokens.output.sum], [300, 30]);
  }
  assert.equal(planner.calls, 2);
  assert.equal(planner.tokens.input.sum, 400);
  assertInvariants(summary);
});

test('usageAggregates: provider and missing model form distinct buckets, and null never collides with "null"', () => {
  const summary = reduce([
    usage({ agentId: 'a', payload: { provider: 'openai', model: 'x' } }),
    usage({ agentId: 'a', payload: { provider: 'azure', model: 'x' } }),
    usage({ agentId: 'a', payload: { provider: 'openai', model: undefined } }),
    usage({ agentId: 'a', payload: { provider: undefined, model: undefined } }),
    usage({ agentId: 'a', payload: { provider: 'openai', model: 'null' } }),
    usage({ agentId: 'a', payload: { provider: 42, model: ['x'] } }),
  ]).summary();

  const keys = summary.byModel.map((entry) => [entry.provider, entry.model]);
  assert.deepEqual(keys, [
    ['azure', 'x'],
    ['openai', 'null'],
    ['openai', 'x'],
    ['openai', null],
    [null, null],
  ]);
  assert.equal(findModel(summary.byModel, null, null).calls, 2, 'non-string provider and model count as missing');
  for (const entry of summary.byModel.filter((item) => item.model !== null || item.provider !== null)) {
    assert.equal(entry.calls, 1);
  }
  assert.deepEqual(findAgent(summary, 'a').byModel.map((entry) => [entry.provider, entry.model]), keys);
  assertInvariants(summary);
});

test('usageAggregates: calls without an agent are part of total under agentId null, apart from an agent named "null"', () => {
  const summary = reduce([
    usage({ source: 'runtime:rt1', payload: { inputTokens: 1 } }),
    usage({ source: 'system', payload: { inputTokens: 2 } }),
    usage({ source: 'agent:external-runtime', payload: { inputTokens: 4 } }),
    usage({ agentId: 'runtime:rt2', payload: { inputTokens: 8 } }),
    usage({ source: 'external', payload: { inputTokens: 16 } }),
    usage({ agentId: 'null', payload: { inputTokens: 32 } }),
    usage({ source: 'agent:worker', payload: { inputTokens: 64 } }),
  ]).summary();

  assert.equal(summary.total.calls, 7);
  assert.equal(summary.total.tokens.input.sum, 127);
  assert.deepEqual(summary.byAgent.map((entry) => entry.agentId), ['null', 'worker', null]);
  const nobody = findAgent(summary, null);
  assert.equal(nobody.calls, 5);
  assert.equal(nobody.tokens.input.sum, 31);
  assert.equal(nobody.byModel.length, 1);
  assert.equal(findAgent(summary, 'null').tokens.input.sum, 32);
  assert.equal(findAgent(summary, 'worker').tokens.input.sum, 64, 'source agent:<id> is used when agentId is absent');
  assertInvariants(summary);
});

// -------------------------------------------------------------
// Tokens
// -------------------------------------------------------------

test('usageAggregates: an omitted token kind is unreported and keeps a null sum; an explicit 0 is a reported zero', () => {
  const omitted = reduce([usage({ agentId: 'a' }), usage({ agentId: 'a', payload: { reasoningTokens: null } })]).summary();
  assert.deepEqual(omitted.total.tokens.reasoning, { sum: null, unreportedCount: 2 });

  const reducer = createUsageReducer();
  reducer.apply(usage({ agentId: 'a' }));
  const before = reducer.summary().total.tokens.reasoning;
  reducer.apply(usage({ agentId: 'a', payload: { reasoningTokens: 0 } }));
  const after = reducer.summary().total.tokens.reasoning;
  assert.deepEqual(before, { sum: null, unreportedCount: 1 });
  assert.deepEqual(after, { sum: 0, unreportedCount: 1 }, 'explicit 0 leaves unreportedCount unchanged and makes sum 0');
  assertInvariants(reducer.summary());
});

test('usageAggregates: cache reads and cache writes are aggregated separately with the #46 field names', () => {
  const summary = reduce([
    usage({ agentId: 'a', payload: { inputTokens: 5000, cacheReadTokens: 3000, cacheWriteTokens: 500 } }),
    usage({ agentId: 'a', payload: { inputTokens: 1000, cacheReadTokens: 200 } }),
    usage({ agentId: 'a', payload: { inputTokens: 900, cacheWriteTokens: 100 } }),
  ]).summary();
  assert.deepEqual(summary.total.tokens.cacheRead, { sum: 3200, unreportedCount: 1 });
  assert.deepEqual(summary.total.tokens.cacheWrite, { sum: 600, unreportedCount: 1 });
  assert.deepEqual(summary.total.tokens.input, { sum: 6900, unreportedCount: 0 });
});

test('usageAggregates: the reducer reads the cacheReadTokens that #46 normalization writes for a legacy cachedTokens', () => {
  const validated = validateCanonicalEvent({
    id: 'evt_red_legacy_cached',
    type: 'llm.usage',
    timestamp: 1000,
    source: 'agent:legacy',
    agentId: 'legacy',
    summary: 'legacy cached tokens',
    payload: { provider: 'openai', model: 'gpt-5', inputTokens: 500, outputTokens: 20, cachedTokens: 300 },
  });
  assert.equal(validated.success, true);
  const raw = usage({ agentId: 'raw', payload: { cachedTokens: 300 } });
  const summary = reduce([validated.data, raw]).summary();
  assert.deepEqual(findAgent(summary, 'legacy').tokens.cacheRead, { sum: 300, unreportedCount: 0 });
  assert.deepEqual(findAgent(summary, 'raw').tokens.cacheRead, { sum: null, unreportedCount: 1 }, 'no aliasing of its own');
});

test('usageAggregates: invalid token values that skipped validation count as unreported', () => {
  const summary = reduce([
    usage({ agentId: 'a', payload: { inputTokens: 1.5, outputTokens: -3, cacheReadTokens: '10', cacheWriteTokens: Number.NaN, reasoningTokens: Infinity } }),
    usage({ agentId: 'a', payload: { inputTokens: 2 ** 60, outputTokens: 4 } }),
  ]).summary();
  assert.deepEqual(summary.total.tokens.input, { sum: null, unreportedCount: 2 });
  assert.deepEqual(summary.total.tokens.output, { sum: 4, unreportedCount: 1 });
  for (const kind of ['cacheRead', 'cacheWrite', 'reasoning']) {
    assert.deepEqual(summary.total.tokens[kind], { sum: null, unreportedCount: 2 });
  }
  assertInvariants(summary);
});

// -------------------------------------------------------------
// Cost
// -------------------------------------------------------------

test('usageAggregates: cost null is counted as missing and leaves every amount unchanged; legacy cost is null', () => {
  const reducer = createUsageReducer();
  reducer.apply(usage({ agentId: 'a', payload: { cost: 0.25, costSource: 'provider-reported', currency: 'USD' } }));
  const before = reducer.summary().total.byCurrency;
  reducer.apply(usage({ agentId: 'a', payload: { cost: null, costSource: 'unknown' } }));
  const summary = reducer.summary();
  assert.deepEqual(summary.total.byCurrency, before);
  assert.equal(summary.total.costMissingCount, 1);
  assert.equal(summary.total.costUnknownCount, 1);
  assert.equal(reducer.legacyAgent('a').cost, null);
  assert.equal(reducer.legacyTotals().cost, null);
  assertInvariants(summary);
});

test('usageAggregates: a cost without a valid currency is counted as currency-missing and adds nothing', () => {
  const summary = reduce([
    usage({ agentId: 'a', payload: { cost: 0.01 } }),
    usage({ agentId: 'a', payload: { cost: 0.01, currency: 'usd' } }),
    usage({ agentId: 'a', payload: { cost: 0.01, currency: 'US' } }),
    usage({ agentId: 'a', payload: { cost: 0.01, currency: null } }),
  ]).summary();
  assert.equal(summary.total.currencyMissingCount, 4);
  assert.equal(summary.total.costMissingCount, 0);
  assert.deepEqual(summary.total.byCurrency, []);
  assertInvariants(summary);
});

test('usageAggregates: a negative or non-finite cost is counted as missing', () => {
  const summary = reduce([
    usage({ agentId: 'a', payload: { cost: -0.5, currency: 'USD' } }),
    usage({ agentId: 'a', payload: { cost: Infinity, currency: 'USD' } }),
    usage({ agentId: 'a', payload: { cost: Number.NaN, currency: 'USD' } }),
    usage({ agentId: 'a', payload: { cost: '0.1', currency: 'USD' } }),
    usage({ agentId: 'a', payload: { currency: 'USD' } }),
  ]).summary();
  assert.equal(summary.total.costMissingCount, 5);
  assert.equal(summary.total.currencyMissingCount, 0);
  assert.deepEqual(summary.total.byCurrency, []);
  assertInvariants(summary);
});

test('usageAggregates: cost 0 in USD is a known zero', () => {
  const reducer = reduce([usage({ agentId: 'a', payload: { cost: 0, costSource: 'provider-reported', currency: 'USD' } })]);
  const { total } = reducer.summary();
  assert.equal(total.byCurrency.length, 1);
  assert.deepEqual(total.byCurrency[0], { currency: 'USD', costSource: 'provider-reported', amount: 0, amountExact: '0', calls: 1 });
  assert.equal(total.costUnknownCount, 0);
  assert.equal(reducer.legacyTotals().cost, 0);
  assert.equal(reducer.legacyAgent('a').cost, 0);
});

test('usageAggregates: USD and EUR are two entries and are never added together', () => {
  const reducer = reduce([
    usage({ agentId: 'a', payload: { cost: 0.25, costSource: 'provider-reported', currency: 'USD' } }),
    usage({ agentId: 'a', payload: { cost: 0.5, costSource: 'provider-reported', currency: 'EUR' } }),
  ]);
  const summary = reducer.summary();
  assert.deepEqual(summary.total.byCurrency.map((pair) => [pair.currency, pair.amountExact]), [['EUR', '0.5'], ['USD', '0.25']]);
  const leaves = collectLeaves(summary);
  assert.equal(leaves.includes(0.75), false, 'no number equals the sum of both currencies');
  assert.equal(leaves.includes('0.75'), false, 'no string equals the sum of both currencies');
  assert.equal(reducer.legacyTotals().cost, null);
  assert.equal(reducer.legacyAgent('a').cost, null);
  assertInvariants(summary);
});

test('usageAggregates: billed and estimated cost stay apart, and a missing costSource forms its own unknown pair', () => {
  const mixed = reduce([
    usage({ agentId: 'a', payload: { cost: 0.1, costSource: 'provider-reported', currency: 'USD' } }),
    usage({ agentId: 'a', payload: { cost: 0.2, costSource: 'estimated', currency: 'USD' } }),
  ]);
  assert.deepEqual(mixed.summary().total.byCurrency.map((pair) => pair.costSource), ['estimated', 'provider-reported']);
  assert.equal(mixed.legacyTotals().cost, null);

  const withUnknown = reduce([
    usage({ agentId: 'a', payload: { cost: 0.1, costSource: 'provider-reported', currency: 'USD' } }),
    usage({ agentId: 'a', payload: { cost: 0.2, currency: 'USD' } }),
    usage({ agentId: 'a', payload: { cost: 0.3, costSource: 'made-up', currency: 'USD' } }),
    usage({ agentId: 'a', payload: { cost: 0.4, costSource: null, currency: 'USD' } }),
  ]);
  assert.deepEqual(
    withUnknown.summary().total.byCurrency.map((pair) => [pair.costSource, pair.amountExact, pair.calls]),
    [['provider-reported', '0.1', 1], ['unknown', '0.9', 3]],
  );
  assert.equal(withUnknown.legacyTotals().cost, null);

  const onlyUnknown = reduce([usage({ agentId: 'a', payload: { cost: 0.2, currency: 'USD' } })]);
  assert.equal(onlyUnknown.legacyTotals().cost, 0.2, 'a single unknown pair still counts as one source');
});

test('usageAggregates: with every call in USD provider-reported, legacy totalCost equals byCurrency[0].amount', () => {
  const reducer = reduce([
    usage({ agentId: 'a', payload: { cost: 0.1, costSource: 'provider-reported', currency: 'USD' } }),
    usage({ agentId: 'b', payload: { cost: 0.2, costSource: 'provider-reported', currency: 'USD' } }),
    usage({ source: 'runtime:rt', payload: { cost: 0.05, costSource: 'provider-reported', currency: 'USD' } }),
  ]);
  const { total } = reducer.summary();
  assert.equal(total.byCurrency.length, 1);
  assert.equal(total.byCurrency[0].amountExact, '0.35');
  assert.equal(reducer.legacyTotals().cost, total.byCurrency[0].amount);
  assert.equal(reducer.legacyTotals().cost, 0.35);
});

test('usageAggregates: byCurrency is sorted by currency, then costSource, in code-unit order', () => {
  const summary = reduce([
    usage({ agentId: 'a', payload: { cost: 1, costSource: 'unknown', currency: 'USD' } }),
    usage({ agentId: 'a', payload: { cost: 1, costSource: 'estimated', currency: 'USD' } }),
    usage({ agentId: 'a', payload: { cost: 1, costSource: 'provider-reported', currency: 'COP' } }),
    usage({ agentId: 'a', payload: { cost: 1, costSource: 'provider-reported', currency: 'EUR' } }),
  ]).summary();
  assert.deepEqual(
    summary.total.byCurrency.map((pair) => `${pair.currency}/${pair.costSource}`),
    ['COP/provider-reported', 'EUR/provider-reported', 'USD/estimated', 'USD/unknown'],
  );
});

// -------------------------------------------------------------
// Failed calls
// -------------------------------------------------------------

test('usageAggregates: llm.failed fills only the failed sub-buckets of total, byModel and byAgent', () => {
  const reducer = createUsageReducer();
  reducer.apply(usage({ agentId: 'a', timestamp: 100, payload: { cost: 0.1, costSource: 'provider-reported', currency: 'USD' } }));
  const before = reducer.summary();
  reducer.apply(failed({ agentId: 'a', timestamp: 200, payload: { inputTokens: 900, outputTokens: 30, cost: 0.5, costSource: 'provider-reported', currency: 'USD', errorKind: 'timeout' } }));
  const after = reducer.summary();

  const strip = ({ failed: _failed, ...rest }) => rest;
  assert.deepEqual(strip(after.total), strip(before.total));
  assert.deepEqual(strip(findAgent(after, 'a')).tokens, strip(findAgent(before, 'a')).tokens);
  assert.equal(findAgent(after, 'a').calls, 1);
  assert.equal(findModel(after.byModel, 'openai', 'gpt-5').calls, 1);

  for (const bucket of [after.total, after.byModel[0], findAgent(after, 'a'), findAgent(after, 'a').byModel[0]]) {
    assert.equal(bucket.failed.calls, 1);
    assert.equal(bucket.failed.tokens.input.sum, 900);
    assert.deepEqual(bucket.failed.byCurrency.map((pair) => pair.amountExact), ['0.5']);
    assert.equal(bucket.failed.firstTimestamp, 200);
  }
  assert.equal(after.eventsReduced, 2);
  assert.equal(reducer.legacyTotals().cost, 0.1, 'failed calls never feed the legacy cost');
  assert.equal(reducer.legacyTotals().tokens.input, 100, 'failed calls never feed the legacy tokens');
  assertInvariants(after);
});

test('usageAggregates: a bucket that only saw failed calls exists with top-level calls 0', () => {
  const reducer = reduce([failed({ agentId: 'flaky', payload: { provider: 'google', model: 'gemini', inputTokens: undefined, outputTokens: undefined } })]);
  const summary = reducer.summary();
  for (const bucket of [summary.total, findAgent(summary, 'flaky'), findModel(summary.byModel, 'google', 'gemini')]) {
    assert.equal(bucket.calls, 0);
    assert.equal(bucket.failed.calls, 1);
    assert.deepEqual(bucket.failed.tokens.input, { sum: null, unreportedCount: 1 });
    assert.equal(bucket.failed.costMissingCount, 1);
  }
  assert.deepEqual(reducer.legacyAgent('flaky'), { tokens: { input: 0, output: 0, cached: 0, reasoning: 0 }, cost: null });
  assertInvariants(summary);
});

// -------------------------------------------------------------
// Arithmetic, determinism and isolation
// -------------------------------------------------------------

test('usageAggregates: fixed point gives exact decimals and rounds half-even at 9 decimals', () => {
  const sum = reduce([
    usage({ agentId: 'a', payload: { cost: 0.1, currency: 'USD' } }),
    usage({ agentId: 'a', payload: { cost: 0.2, currency: 'USD' } }),
  ]).summary();
  assert.equal(0.1 + 0.2 === 0.3, false, 'binary floating point would not give 0.3');
  assert.equal(sum.total.byCurrency[0].amountExact, '0.3');
  assert.equal(sum.total.byCurrency[0].amount, 0.3);

  assert.equal(formatNanoUnits(toNanoUnits(0.1234567895)), '0.12345679', 'tie rounds to the even neighbour (up)');
  assert.equal(formatNanoUnits(toNanoUnits(0.1234567885)), '0.123456788', 'tie rounds to the even neighbour (down)');
  assert.equal(formatNanoUnits(toNanoUnits(0.12345678951)), '0.12345679', 'above the tie rounds up');
  assert.equal(formatNanoUnits(toNanoUnits(0.12345678949)), '0.123456789', 'below the tie rounds down');
  assert.equal(formatNanoUnits(toNanoUnits(2.5e-9)), '0.000000002', 'exponent form is expanded before rounding');
  assert.equal(formatNanoUnits(toNanoUnits(1e-7)), '0.0000001');
  assert.equal(formatNanoUnits(toNanoUnits(1e-10)), '0', 'digits past the ninth decimal are lost');
  assert.equal(formatNanoUnits(toNanoUnits(1e21)), '1000000000000000000000');
  assert.equal(formatNanoUnits(toNanoUnits(3)), '3');
  assert.equal(formatNanoUnits(toNanoUnits(0.042)), '0.042');

  const tenDecimals = reduce([usage({ agentId: 'a', payload: { cost: 0.0000000025, currency: 'USD' } })]).summary();
  assert.equal(tenDecimals.total.byCurrency[0].amountExact, '0.000000002');
});

test('usageAggregates: reducing the same events in any order yields a deep-equal summary (50 seeded shuffles)', () => {
  const events = loadUsageFixture('mixed');
  const reference = reduce(events);
  const expected = reference.summary();
  const random = seededRandom(51);
  for (let round = 0; round < 50; round++) {
    const shuffled = reduce(shuffle(events, random));
    assert.deepStrictEqual(shuffled.summary(), expected, `shuffle ${round} changed the summary`);
    assert.deepStrictEqual(shuffled.legacyTotals(), reference.legacyTotals());
  }
});

test('usageAggregates: invariants hold for every bucket of every fixture', () => {
  for (const name of ['mixed', 'docs-example']) {
    const summary = reduce(loadUsageFixture(name)).summary();
    assertInvariants(summary);
  }
});

test('usageAggregates: the mixed fixture gives the expected figures', () => {
  const reducer = reduce(loadUsageFixture('mixed'));
  const summary = reducer.summary();
  assert.equal(summary.eventsReduced, 17, 'the status event is not reduced');
  assert.equal(summary.total.calls, 14);
  assert.equal(summary.total.failed.calls, 3);
  assert.deepEqual(summary.total.byCurrency.map((pair) => [pair.currency, pair.costSource, pair.amountExact, pair.calls]), [
    ['EUR', 'provider-reported', '0.03', 2],
    ['USD', 'estimated', '0.012345678', 1],
    ['USD', 'provider-reported', '0.801000002', 7],
    ['USD', 'unknown', '0.05', 1],
  ]);
  assert.equal(summary.total.costMissingCount, 2);
  assert.equal(summary.total.currencyMissingCount, 1);
  assert.deepEqual(summary.byAgent.map((entry) => entry.agentId), ['builder', 'flaky', 'null', 'planner', null]);
  assert.deepEqual(
    summary.byModel.map((entry) => [entry.provider, entry.model]),
    [
      ['anthropic', 'claude-sonnet'],
      ['anthropic', null],
      ['azure', 'x'],
      ['google', 'gemini-2.5-pro'],
      ['openai', 'gpt-5'],
      ['openai', 'gpt-5-mini'],
      ['openai', 'x'],
    ],
  );
  assert.equal(summary.total.firstTimestamp, 1000);
  assert.equal(summary.total.lastTimestamp, 2700);
  assert.equal(summary.total.failed.firstTimestamp, 1900);
  assert.equal(summary.total.failed.lastTimestamp, 2100);
  assert.equal(reducer.legacyTotals().cost, null);
  assert.equal(reducer.legacyAgent('planner').cost, null, 'planner has a call without cost');
});

test('usageAggregates: the documented GET /api/v1/usage example matches the reducer', () => {
  const reducer = reduce(loadUsageFixture('docs-example'));
  const summary = reducer.summary();
  assert.equal(summary.eventsReduced, 4);
  assert.deepEqual(summary.total, {
    calls: 3,
    tokens: {
      input: { sum: 4200, unreportedCount: 0 },
      output: { sum: 950, unreportedCount: 0 },
      cacheRead: { sum: 1200, unreportedCount: 2 },
      cacheWrite: { sum: null, unreportedCount: 3 },
      reasoning: { sum: null, unreportedCount: 3 },
    },
    byCurrency: [{ currency: 'USD', costSource: 'provider-reported', amount: 0.042, amountExact: '0.042', calls: 2 }],
    costUnknownCount: 1,
    costMissingCount: 1,
    currencyMissingCount: 0,
    firstTimestamp: 1791459000000,
    lastTimestamp: 1791459900000,
    failed: {
      calls: 1,
      tokens: {
        input: { sum: null, unreportedCount: 1 },
        output: { sum: null, unreportedCount: 1 },
        cacheRead: { sum: null, unreportedCount: 1 },
        cacheWrite: { sum: null, unreportedCount: 1 },
        reasoning: { sum: null, unreportedCount: 1 },
      },
      byCurrency: [],
      costUnknownCount: 1,
      costMissingCount: 1,
      currencyMissingCount: 0,
      firstTimestamp: 1791459950000,
      lastTimestamp: 1791459950000,
    },
  });
  assert.deepEqual(summary.byModel.map((entry) => [entry.provider, entry.model, entry.calls]), [
    ['openai', 'gpt-5', 2],
    ['openai', 'gpt-5-mini', 1],
  ]);
  assert.deepEqual(summary.byAgent.map((entry) => [entry.agentId, entry.calls]), [['planner', 2], [null, 1]]);
  assert.deepEqual(findAgent(summary, 'planner').byModel.map((entry) => [entry.model, entry.calls]), [['gpt-5', 1], ['gpt-5-mini', 1]]);
  assert.deepEqual(reducer.legacyTotals(), { tokens: { input: 4200, output: 950, cached: 1200, reasoning: 0 }, cost: null });
  assert.deepEqual(reducer.legacyAgent('planner'), { tokens: { input: 3000, output: 700, cached: 1200, reasoning: 0 }, cost: null });
});

test('usageAggregates: summary() returns a fresh object that callers cannot use to change the reducer', () => {
  const reducer = reduce(loadUsageFixture('mixed'));
  const first = reducer.summary();
  const pristine = structuredClone(first);

  first.eventsReduced = 999;
  first.total.calls = 999;
  first.total.tokens.input.sum = -1;
  first.total.byCurrency[0].calls = 999;
  first.total.byCurrency.push({ currency: 'XXX', costSource: 'unknown', amount: 1, amountExact: '1', calls: 1 });
  first.total.failed.calls = 999;
  first.byModel[0].tokens.output.unreportedCount = 999;
  first.byAgent[0].byModel.length = 0;
  first.byAgent.length = 0;

  assert.deepStrictEqual(reducer.summary(), pristine);
  assert.notEqual(reducer.summary(), reducer.summary());
  assert.notEqual(reducer.summary().total.tokens, reducer.summary().total.tokens);
});
