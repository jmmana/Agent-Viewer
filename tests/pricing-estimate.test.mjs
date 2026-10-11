// Issue #84 (ingestion-time cost estimate). `estimateCall` is pure and takes one pricing snapshot directly
// (the entries of whichever version is active); picking which version is the caller's job
// (`server/pricing/estimate.ts`, `server/usageLedger.ts`). Covers every `EstimateStatus`, the BigInt rounding
// rule (sum first, round once, half-even), and that no path ever returns a `0` for "unknown" (README.md:719).
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCall, estimateLedgerRow } from '../server/pricing/estimate.ts';

function entry(overrides = {}) {
  return {
    provider: 'anthropic',
    model: 'example-model',
    aliases: [],
    kind: 'list',
    currency: 'USD',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    inputPerMillion: 1.0,
    outputPerMillion: 5.0,
    cacheReadPerMillion: 0.1,
    cacheWritePerMillion: 1.25,
    reasoningPerMillion: null,
    reasoningBilling: 'included_in_output',
    source: 'file',
    estimated: false,
    sourceUrl: null,
    sourceCheckedAt: null,
    note: null,
    ...overrides,
  };
}

function snapshot(entries, pricingVersion = 1) {
  return { pricingVersion, entries };
}

function row(overrides = {}) {
  return {
    provider: 'anthropic',
    model: 'example-model',
    occurredAt: Date.parse('2026-06-01T00:00:00Z'),
    inputTokens: 1200,
    outputTokens: 400,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: null,
    ...overrides,
  };
}

test('plain input and output: 1200 input at 2.5/M + 400 output at 10/M = 0.007', () => {
  const e = entry({ inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: null, cacheWritePerMillion: null });
  const result = estimateCall(row(), snapshot([e]));
  assert.equal(result.status, 'estimated');
  assert.equal(result.currency, 'USD');
  assert.equal(result.costNano, 7_000_000);
});

test('cache read and write are priced separately from uncached input', () => {
  const e = entry({ inputPerMillion: 1, outputPerMillion: 1, cacheReadPerMillion: 0.5, cacheWritePerMillion: 2 });
  // inputTokens already includes both cache directions (global convention): uncached input = 1000 - 100 - 50 = 850.
  const result = estimateCall(row({ inputTokens: 1000, outputTokens: 0, cacheReadTokens: 100, cacheWriteTokens: 50 }), snapshot([e]));
  assert.equal(result.status, 'estimated');
  // 850 * 1 + 100 * 0.5 + 50 * 2 = 850 + 50 + 100 = 1000 (currency units per million tokens priced) -> /1e6 -> nano:
  // costNano = round((850*1e9 + 100*0.5e9 + 50*2e9) / 1e6) = round(1000e9 / 1e6) = 1_000_000.
  assert.equal(result.costNano, 1_000_000);
});

test('reasoning billed separately is priced on its own rate; reasoning billed inside output is not priced again', () => {
  const separate = entry({ inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: null, cacheWritePerMillion: null, reasoningBilling: 'separate', reasoningPerMillion: 4 });
  const resultSeparate = estimateCall(row({ inputTokens: 0, outputTokens: 0, reasoningTokens: 10 }), snapshot([separate]));
  assert.equal(resultSeparate.status, 'estimated');
  assert.equal(resultSeparate.costNano, 40_000); // 10 tokens * 4/M -> nano = 10 * 4e9 / 1e6

  const included = entry({ inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: null, cacheWritePerMillion: null, reasoningBilling: 'included_in_output', reasoningPerMillion: null });
  // reasoningTokens is null here (not needed: it is already inside outputTokens) and must still estimate.
  const resultIncluded = estimateCall(row({ inputTokens: 0, outputTokens: 0, reasoningTokens: null }), snapshot([included]));
  assert.equal(resultIncluded.status, 'estimated');
  assert.equal(resultIncluded.costNano, 0);
});

test('a zero-price local model gives an exact 0, never null', () => {
  const e = entry({ inputPerMillion: 0, outputPerMillion: 0, cacheReadPerMillion: 0, cacheWritePerMillion: 0 });
  const result = estimateCall(row(), snapshot([e]));
  assert.equal(result.status, 'estimated');
  assert.equal(result.costNano, 0);
});

test('an unknown model gives null, never falls back to another model price', () => {
  const e = entry({ model: 'gpt-4o' });
  const result = estimateCall(row({ model: 'totally-unknown-model' }), snapshot([e]));
  assert.equal(result.status, 'no_price_for_model');
  assert.equal(result.costNano, null);
  assert.equal(result.currency, null);
});

test('no provider/model on the row at all gives no_price_for_model, never a crash', () => {
  const result = estimateCall(row({ provider: null, model: null }), snapshot([entry()]));
  assert.equal(result.status, 'no_price_for_model');
  assert.equal(result.costNano, null);
});

test('no pricing version ever committed gives no_price_in_force', () => {
  const result = estimateCall(row(), { pricingVersion: null, entries: [] });
  assert.equal(result.status, 'no_price_in_force');
  assert.equal(result.costNano, null);
});

test('a version exists but every entry for the model starts after occurredAt gives no_price_in_force (not no_price_for_model)', () => {
  const e = entry({ effectiveFrom: '2027-01-01T00:00:00Z' });
  const result = estimateCall(row({ occurredAt: Date.parse('2026-06-01T00:00:00Z') }), snapshot([e]));
  assert.equal(result.status, 'no_price_in_force');
});

test('a null token count the price needs gives missing_usage, never 0', () => {
  const e = entry();
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const result = estimateCall(row({ [field]: null }), snapshot([e]));
    assert.equal(result.status, 'missing_usage', `field ${field}`);
    assert.equal(result.costNano, null);
  }
});

test('reasoningTokens null is missing_usage only when reasoningBilling is separate', () => {
  const separate = entry({ reasoningBilling: 'separate', reasoningPerMillion: 4 });
  const result = estimateCall(row({ reasoningTokens: null }), snapshot([separate]));
  assert.equal(result.status, 'missing_usage');
});

test('a null rate with a positive needed count gives no_price_for_component', () => {
  const e = entry({ cacheReadPerMillion: null });
  const result = estimateCall(row({ cacheReadTokens: 10, inputTokens: 1210 }), snapshot([e]));
  assert.equal(result.status, 'no_price_for_component');
  assert.equal(result.costNano, null);
});

test('a null rate with a count of exactly 0 never blocks the estimate', () => {
  const e = entry({ cacheWritePerMillion: null });
  const result = estimateCall(row({ cacheWriteTokens: 0 }), snapshot([e]));
  assert.equal(result.status, 'estimated');
});

test('cacheRead + cacheWrite exceeding inputTokens is inconsistent_usage, never a negative cost', () => {
  const e = entry();
  const result = estimateCall(row({ inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 60 }), snapshot([e]));
  assert.equal(result.status, 'inconsistent_usage');
  assert.equal(result.costNano, null);
});

test('a failed call (llm.failed) with explicit tokens is estimated like any other row', () => {
  const e = entry();
  const result = estimateCall(row({ inputTokens: 100, outputTokens: 0 }), snapshot([e]));
  assert.equal(result.status, 'estimated');
});

test('a failed call with no tokens reported is missing_usage, never assumed free or billed', () => {
  const e = entry();
  const result = estimateCall(row({ inputTokens: null, outputTokens: null }), snapshot([e]));
  assert.equal(result.status, 'missing_usage');
});

test('rounding is half-even at an exact .5 nano boundary', () => {
  // A rate chosen so the division by 1,000,000 lands on an exact half: 1 token * 0.0005 per-million rate
  // scaled to nano gives 500_000 scaled units -> /1e6 -> 0.5 nano exactly, which must round to the nearest even
  // integer (0), not always up.
  const e = entry({ inputPerMillion: 0.0005, outputPerMillion: 0, cacheReadPerMillion: null, cacheWritePerMillion: null });
  const result = estimateCall(row({ inputTokens: 1, outputTokens: 0 }), snapshot([e]));
  assert.equal(result.status, 'estimated');
  assert.equal(result.costNano, 0); // rounds to the nearest even integer, not away from zero
});

test('rounding half-even also rounds up to the nearest even integer when that is the closer even number', () => {
  const e = entry({ inputPerMillion: 0.0015, outputPerMillion: 0, cacheReadPerMillion: null, cacheWritePerMillion: null });
  const result = estimateCall(row({ inputTokens: 1, outputTokens: 0 }), snapshot([e]));
  // 1 * 0.0015e9 = 1_500_000 scaled units -> /1e6 = 1.5 -> rounds to 2 (the nearest even).
  assert.equal(result.costNano, 2);
});

test('very large token counts produce no floating-point drift', () => {
  const e = entry({ inputPerMillion: 3, outputPerMillion: 7, cacheReadPerMillion: null, cacheWritePerMillion: null });
  const bigTokens = 10_000_000_000; // 10 billion tokens
  const result = estimateCall(row({ inputTokens: bigTokens, outputTokens: bigTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }), snapshot([e]));
  assert.equal(result.status, 'estimated');
  // Exact integer math: (10e9 * 3e9 + 10e9 * 7e9) / 1e6 = (30e18 + 70e18) / 1e6 = 100e18 / 1e6 = 1e14.
  assert.equal(result.costNano, 100_000_000_000_000);
});

test('a per-row estimate above Number.MAX_SAFE_INTEGER nano is reported failed, never truncated', () => {
  const e = entry({ inputPerMillion: 1_000_000, outputPerMillion: 0, cacheReadPerMillion: null, cacheWritePerMillion: null });
  const result = estimateCall(row({ inputTokens: 100_000_000_000, outputTokens: 0 }), snapshot([e]));
  assert.equal(result.status, 'failed');
  assert.equal(result.costNano, null);
});

test('an override entry wins over a list entry at the same instant (matches resolvePrice itself)', () => {
  const list = entry({ kind: 'list', inputPerMillion: 1, outputPerMillion: 0, cacheReadPerMillion: null, cacheWritePerMillion: null });
  const override = entry({ kind: 'override', inputPerMillion: 2, outputPerMillion: 0, cacheReadPerMillion: null, cacheWritePerMillion: null });
  const result = estimateCall(row({ inputTokens: 1, outputTokens: 0 }), snapshot([list, override]));
  assert.equal(result.costNano, 2000); // 1 token at 2/M priced at 2/M (not list's 1/M) = 2e-6 currency units = 2000 nano
});

// -------------------------------------------------------------
// estimateLedgerRow: the ledger-column wrapper
// -------------------------------------------------------------

test('estimateLedgerRow carries the resolved pricing version through on every status, not only "estimated"', () => {
  const e = entry({ model: 'gpt-4o' });
  const fields = estimateLedgerRow(row({ model: 'unknown-model' }), snapshot([e], 7), () => 123);
  assert.equal(fields.estimateStatus, 'no_price_for_model');
  assert.equal(fields.pricingVersion, 7);
  assert.equal(fields.estimatedCostNano, null);
  assert.equal(fields.estimatedCurrency, null);
  assert.equal(fields.estimatedAt, 123);
});

test('estimateLedgerRow on a successful estimate fills every column', () => {
  const e = entry();
  const fields = estimateLedgerRow(row(), snapshot([e], 3), () => 999);
  assert.equal(fields.estimateStatus, 'estimated');
  assert.equal(fields.pricingVersion, 3);
  assert.equal(typeof fields.estimatedCostNano, 'number');
  assert.equal(fields.estimatedCurrency, 'USD');
  assert.equal(fields.estimatedAt, 999);
});

// -------------------------------------------------------------
// Property tests (seeded pseudo-random loop, no new dependency): monotonic in tokens, never negative, never
// NaN, and deterministic (same inputs always give the same output).
// -------------------------------------------------------------

function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: estimate is deterministic, never negative, never NaN, over 500 random cases', () => {
  const random = mulberry32(0xC0FFEE);
  const e = entry({ inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 0.1, cacheWritePerMillion: 1.25 });
  const snap = snapshot([e]);
  for (let i = 0; i < 500; i++) {
    const inputTokens = Math.floor(random() * 1_000_000);
    const cacheReadTokens = Math.floor(random() * inputTokens * 0.3);
    const cacheWriteTokens = Math.floor(random() * (inputTokens - cacheReadTokens) * 0.3);
    const outputTokens = Math.floor(random() * 1_000_000);
    const call = row({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

    const first = estimateCall(call, snap);
    const second = estimateCall(call, snap);
    assert.deepEqual(first, second, 'same inputs must always give the same output');
    assert.equal(first.status, 'estimated');
    assert.ok(Number.isFinite(first.costNano) && !Number.isNaN(first.costNano));
    assert.ok(first.costNano >= 0, 'cost is never negative');
  }
});

test('property: estimate is monotonic in output tokens (more tokens never costs less)', () => {
  const random = mulberry32(0xBADA55);
  const e = entry({ inputPerMillion: 1, outputPerMillion: 2, cacheReadPerMillion: null, cacheWritePerMillion: null });
  const snap = snapshot([e]);
  for (let i = 0; i < 200; i++) {
    const inputTokens = Math.floor(random() * 1000);
    const lower = Math.floor(random() * 1000);
    const higher = lower + Math.floor(random() * 1000) + 1;
    const lowerResult = estimateCall(row({ inputTokens, outputTokens: lower, cacheReadTokens: 0, cacheWriteTokens: 0 }), snap);
    const higherResult = estimateCall(row({ inputTokens, outputTokens: higher, cacheReadTokens: 0, cacheWriteTokens: 0 }), snap);
    assert.ok(higherResult.costNano >= lowerResult.costNano);
  }
});
