// Issue #83 (sub-issue: pricing contract, resolver, starter table). `resolvePrice` is pure and takes one
// version's entries directly (picking "current" vs a pinned version is a later sub-issue's job). Covers the
// resolution order (override over list, latest effectiveFrom, alias at model level) and the no-fallback
// cases: an unknown provider, an unknown model, a prefix near-miss, a date before every effectiveFrom, and a
// missing price component staying null rather than being filled from elsewhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePrice } from '../src/integrations/pricingContract.ts';

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
    sourceUrl: 'https://example.com/pricing',
    sourceCheckedAt: '2026-10-01',
    note: null,
    ...overrides,
  };
}

test('resolves a matching list entry', () => {
  const result = resolvePrice([entry()], { provider: 'anthropic', model: 'example-model', at: '2026-06-01T00:00:00Z' });
  assert.ok(result);
  assert.equal(result.inputPerMillion, 1.0);
});

test('provider and model match case-insensitively on exact text', () => {
  const result = resolvePrice([entry()], { provider: 'Anthropic', model: 'Example-Model', at: '2026-06-01T00:00:00Z' });
  assert.ok(result);
});

test('an unknown provider resolves to null', () => {
  const result = resolvePrice([entry()], { provider: 'unknown-provider', model: 'example-model', at: '2026-06-01T00:00:00Z' });
  assert.equal(result, null);
});

test('an unknown model resolves to null, never another model price', () => {
  const result = resolvePrice([entry()], { provider: 'anthropic', model: 'other-model', at: '2026-06-01T00:00:00Z' });
  assert.equal(result, null);
});

test('a prefix or substring near-miss never matches (exact text only)', () => {
  const result = resolvePrice([entry()], { provider: 'anthropic', model: 'example-model-v2', at: '2026-06-01T00:00:00Z' });
  assert.equal(result, null);
  const result2 = resolvePrice([entry()], { provider: 'anthropic', model: 'example', at: '2026-06-01T00:00:00Z' });
  assert.equal(result2, null);
});

test('a date before every effectiveFrom resolves to null, never falls back to the earliest entry', () => {
  const result = resolvePrice([entry({ effectiveFrom: '2026-01-01T00:00:00Z' })], {
    provider: 'anthropic',
    model: 'example-model',
    at: '2025-12-31T23:59:59Z',
  });
  assert.equal(result, null);
});

test('with two list entries, resolution picks the one effective at the queried instant (not after)', () => {
  const early = entry({ effectiveFrom: '2026-01-01T00:00:00Z', inputPerMillion: 1 });
  const later = entry({ effectiveFrom: '2026-06-01T00:00:00Z', inputPerMillion: 2 });
  const entries = [early, later];

  const beforeSwitch = resolvePrice(entries, { provider: 'anthropic', model: 'example-model', at: '2026-05-31T23:59:59Z' });
  assert.equal(beforeSwitch.inputPerMillion, 1);

  const atSwitch = resolvePrice(entries, { provider: 'anthropic', model: 'example-model', at: '2026-06-01T00:00:00Z' });
  assert.equal(atSwitch.inputPerMillion, 2);
});

test('an override beats a list entry for the same model and time, even when the list entry is newer', () => {
  const list = entry({ kind: 'list', effectiveFrom: '2026-06-01T00:00:00Z', inputPerMillion: 2 });
  const override = entry({ kind: 'override', effectiveFrom: '2026-01-01T00:00:00Z', inputPerMillion: 9 });
  const result = resolvePrice([list, override], { provider: 'anthropic', model: 'example-model', at: '2026-07-01T00:00:00Z' });
  assert.equal(result.inputPerMillion, 9);
  assert.equal(result.kind, 'override');
});

test('a null component in the override is not filled from the list entry (no field-by-field merge)', () => {
  const list = entry({
    kind: 'list',
    effectiveFrom: '2026-01-01T00:00:00Z',
    inputPerMillion: 1,
    outputPerMillion: 5,
  });
  const override = entry({
    kind: 'override',
    effectiveFrom: '2026-02-01T00:00:00Z',
    inputPerMillion: 2,
    outputPerMillion: null,
  });
  const result = resolvePrice([list, override], { provider: 'anthropic', model: 'example-model', at: '2026-07-01T00:00:00Z' });
  assert.equal(result.inputPerMillion, 2);
  assert.equal(result.outputPerMillion, null);
});

test('with two overrides, the one with the greatest effectiveFrom at or before "at" wins', () => {
  const overrideA = entry({ kind: 'override', effectiveFrom: '2026-01-01T00:00:00Z', inputPerMillion: 1 });
  const overrideB = entry({ kind: 'override', effectiveFrom: '2026-03-01T00:00:00Z', inputPerMillion: 2 });
  const result = resolvePrice([overrideA, overrideB], { provider: 'anthropic', model: 'example-model', at: '2026-07-01T00:00:00Z' });
  assert.equal(result.inputPerMillion, 2);
});

test('an alias resolves to its model', () => {
  const entries = [entry({ model: 'canonical-model', aliases: ['dated-snapshot-2026'] })];
  const result = resolvePrice(entries, { provider: 'anthropic', model: 'dated-snapshot-2026', at: '2026-06-01T00:00:00Z' });
  assert.ok(result);
  assert.equal(result.model, 'canonical-model');
});

test('a newer entry without the alias still wins for the alias id, because alias membership is model-level', () => {
  const withAlias = entry({
    model: 'canonical-model',
    aliases: ['dated-snapshot-2026'],
    effectiveFrom: '2026-01-01T00:00:00Z',
    inputPerMillion: 1,
  });
  const withoutAlias = entry({
    model: 'canonical-model',
    aliases: [],
    effectiveFrom: '2026-06-01T00:00:00Z',
    inputPerMillion: 2,
  });
  const result = resolvePrice([withAlias, withoutAlias], {
    provider: 'anthropic',
    model: 'dated-snapshot-2026',
    at: '2026-07-01T00:00:00Z',
  });
  assert.ok(result);
  assert.equal(result.inputPerMillion, 2);
});

test('an alias never crosses providers', () => {
  const entries = [entry({ provider: 'openai', model: 'canonical-model', aliases: ['shared-alias'] })];
  const result = resolvePrice(entries, { provider: 'anthropic', model: 'shared-alias', at: '2026-06-01T00:00:00Z' });
  assert.equal(result, null);
});

test('resolvePrice never returns 0 for "not found": no match is null, not a zero-priced entry', () => {
  const result = resolvePrice([], { provider: 'anthropic', model: 'example-model', at: '2026-06-01T00:00:00Z' });
  assert.equal(result, null);
});

test('an explicit 0 price entry is returned as-is when it matches (0 is a declared price, not "not found")', () => {
  const entries = [entry({ inputPerMillion: 0, outputPerMillion: 0 })];
  const result = resolvePrice(entries, { provider: 'anthropic', model: 'example-model', at: '2026-06-01T00:00:00Z' });
  assert.ok(result);
  assert.equal(result.inputPerMillion, 0);
});

test('accepts "at" as epoch milliseconds, not only an ISO string', () => {
  const entries = [entry({ effectiveFrom: '2026-01-01T00:00:00Z' })];
  const atMs = Date.parse('2026-06-01T00:00:00Z');
  const result = resolvePrice(entries, { provider: 'anthropic', model: 'example-model', at: atMs });
  assert.ok(result);
});
