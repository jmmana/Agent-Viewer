// Issue #83 (sub-issue: pricing contract, resolver, starter table). Schema-level validation for PriceEntry
// and PricingVersion: null vs 0, omitted price defaults, price caps, currency regex, zone-less dates, strict
// unknown-key rejection, reasoning-billing consistency, alias and duplicate-key collisions, the all-null
// rejection, and content-hash stability under reordering.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PriceEntrySchema,
  PriceEntryInputSchema,
  PricingVersionSchema,
  computeContentHash,
  parsePriceEntries,
  validatePriceEntryCollection,
} from '../src/integrations/pricingContract.ts';

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

test('a fully-populated entry parses and normalizes provider/model to lower-case', () => {
  const result = PriceEntrySchema.safeParse(entry({ provider: '  Anthropic  ', model: 'Example-Model' }));
  assert.equal(result.success, true);
  assert.equal(result.data.provider, 'anthropic');
  assert.equal(result.data.model, 'example-model');
});

test('an explicit 0 price is accepted and preserved (not confused with null)', () => {
  const result = PriceEntrySchema.safeParse(entry({ inputPerMillion: 0 }));
  assert.equal(result.success, true);
  assert.equal(result.data.inputPerMillion, 0);
});

test('a null price is preserved as unknown, never coerced to 0', () => {
  const result = PriceEntrySchema.safeParse(entry({ inputPerMillion: null }));
  assert.equal(result.success, true);
  assert.equal(result.data.inputPerMillion, null);
});

test('an entry with all five prices null is rejected', () => {
  const result = PriceEntrySchema.safeParse(
    entry({
      inputPerMillion: null,
      outputPerMillion: null,
      cacheReadPerMillion: null,
      cacheWritePerMillion: null,
      reasoningPerMillion: null,
      reasoningBilling: null,
    }),
  );
  assert.equal(result.success, false);
});

test('on PriceEntryInputSchema, an omitted price defaults to null, never 0', () => {
  const { inputPerMillion, ...withoutInput } = entry({ source: undefined });
  delete withoutInput.source;
  const result = PriceEntryInputSchema.safeParse(withoutInput);
  assert.equal(result.success, true);
  assert.equal(result.data.inputPerMillion, null);
});

test('PriceEntryInputSchema defaults aliases, sourceUrl, sourceCheckedAt, note, estimated and reasoningBilling', () => {
  const minimal = {
    provider: 'openai',
    model: 'minimal-model',
    kind: 'list',
    currency: 'USD',
    effectiveFrom: '2026-01-01T00:00:00Z',
    inputPerMillion: 1,
  };
  const result = PriceEntryInputSchema.safeParse(minimal);
  assert.equal(result.success, true);
  assert.deepEqual(result.data.aliases, []);
  assert.equal(result.data.sourceUrl, null);
  assert.equal(result.data.sourceCheckedAt, null);
  assert.equal(result.data.note, null);
  assert.equal(result.data.estimated, true);
  assert.equal(result.data.reasoningBilling, null);
});

test('PriceEntryInputSchema has no source field: it is never trusted from input', () => {
  const result = PriceEntryInputSchema.safeParse(entry({ source: 'api' }));
  assert.equal(result.success, false);
  assert.ok(
    result.error.issues.some(
      (issue) => issue.code === 'unrecognized_keys' && issue.keys?.includes('source'),
    ),
  );
});

test('a negative price is rejected', () => {
  const result = PriceEntrySchema.safeParse(entry({ inputPerMillion: -1 }));
  assert.equal(result.success, false);
});

test('NaN is rejected (zod rejects it at the type level before the finite check)', () => {
  const result = PriceEntrySchema.safeParse(entry({ inputPerMillion: Number.NaN }));
  assert.equal(result.success, false);
});

test('Infinity is rejected', () => {
  const result = PriceEntrySchema.safeParse(entry({ inputPerMillion: Number.POSITIVE_INFINITY }));
  assert.equal(result.success, false);
});

test('a price above the 1,000,000 cap is rejected', () => {
  const result = PriceEntrySchema.safeParse(entry({ inputPerMillion: 1_000_001 }));
  assert.equal(result.success, false);
});

test('a price exactly at the 1,000,000 cap is accepted', () => {
  const result = PriceEntrySchema.safeParse(entry({ inputPerMillion: 1_000_000 }));
  assert.equal(result.success, true);
});

test('a string price is rejected', () => {
  const result = PriceEntrySchema.safeParse(entry({ inputPerMillion: '1.0' }));
  assert.equal(result.success, false);
});

test('an unknown key (typo) is rejected by the strict schema', () => {
  const result = PriceEntrySchema.safeParse(entry({ inputPerMilion: 1 }));
  assert.equal(result.success, false);
});

test('a malformed currency code is rejected', () => {
  const result = PriceEntrySchema.safeParse(entry({ currency: 'usd' }));
  assert.equal(result.success, false);
});

test('effectiveFrom without a zone is rejected', () => {
  const result = PriceEntrySchema.safeParse(entry({ effectiveFrom: '2026-01-01T00:00:00' }));
  assert.equal(result.success, false);
});

test('effectiveFrom with a non-UTC offset normalizes to UTC milliseconds', () => {
  const result = PriceEntrySchema.safeParse(entry({ effectiveFrom: '2026-01-01T02:00:00+02:00' }));
  assert.equal(result.success, true);
  assert.equal(result.data.effectiveFrom, '2026-01-01T00:00:00.000Z');
});

test("reasoningBilling 'separate' requires reasoningPerMillion to be non-null", () => {
  const result = PriceEntrySchema.safeParse(entry({ reasoningBilling: 'separate', reasoningPerMillion: null }));
  assert.equal(result.success, false);
});

test("reasoningBilling 'separate' with a reasoningPerMillion price is accepted", () => {
  const result = PriceEntrySchema.safeParse(entry({ reasoningBilling: 'separate', reasoningPerMillion: 3 }));
  assert.equal(result.success, true);
});

test("reasoningBilling 'included_in_output' requires reasoningPerMillion to be null", () => {
  const result = PriceEntrySchema.safeParse(entry({ reasoningBilling: 'included_in_output', reasoningPerMillion: 3 }));
  assert.equal(result.success, false);
});

test('a reasoningPerMillion price with no reasoningBilling stated is rejected', () => {
  const result = PriceEntrySchema.safeParse(entry({ reasoningBilling: null, reasoningPerMillion: 3 }));
  assert.equal(result.success, false);
});

test('sourceUrl must be https', () => {
  const result = PriceEntrySchema.safeParse(entry({ sourceUrl: 'http://example.com/pricing' }));
  assert.equal(result.success, false);
});

test('sourceCheckedAt must be a calendar date, not an instant', () => {
  const result = PriceEntrySchema.safeParse(entry({ sourceCheckedAt: '2026-10-01T00:00:00Z' }));
  assert.equal(result.success, false);
});

test('aliases over the 20-item cap are rejected', () => {
  const aliases = Array.from({ length: 21 }, (_, i) => `alias-${i}`);
  const result = PriceEntrySchema.safeParse(entry({ aliases }));
  assert.equal(result.success, false);
});

// -------------------------------------------------------------
// Collection-level rules
// -------------------------------------------------------------

test('a duplicate natural key (provider, model, kind, effectiveFrom) is rejected', () => {
  const result = parsePriceEntries([entry(), entry()]);
  assert.equal(result.success, false);
});

test('two entries differing only by effectiveFrom are accepted (not a duplicate)', () => {
  const result = parsePriceEntries([entry(), entry({ effectiveFrom: '2026-06-01T00:00:00Z' })]);
  assert.equal(result.success, true);
});

test('an alias equal to another model id of the same provider is rejected', () => {
  const issues = validatePriceEntryCollection([
    entry({ model: 'model-a', aliases: [] }),
    entry({ model: 'model-b', aliases: ['model-a'], effectiveFrom: '2026-02-01T00:00:00Z' }),
  ]);
  assert.ok(issues.length > 0);
});

test('an alias claimed by two different models of the same provider is rejected', () => {
  const issues = validatePriceEntryCollection([
    entry({ model: 'model-a', aliases: ['shared-alias'] }),
    entry({ model: 'model-b', aliases: ['shared-alias'], effectiveFrom: '2026-02-01T00:00:00Z' }),
  ]);
  assert.ok(issues.length > 0);
});

test('the same alias repeated on two entries of the same model is accepted', () => {
  const issues = validatePriceEntryCollection([
    entry({ model: 'model-a', aliases: ['dated-snapshot'] }),
    entry({ model: 'model-a', aliases: ['dated-snapshot'], effectiveFrom: '2026-06-01T00:00:00Z' }),
  ]);
  assert.deepEqual(issues, []);
});

test('an alias is scoped per provider: the same alias on two different providers does not collide', () => {
  const issues = validatePriceEntryCollection([
    entry({ provider: 'openai', model: 'model-a', aliases: ['shared-alias'] }),
    entry({ provider: 'anthropic', model: 'model-b', aliases: ['shared-alias'] }),
  ]);
  assert.deepEqual(issues, []);
});

// -------------------------------------------------------------
// Content hash
// -------------------------------------------------------------

test('contentHash is identical when entries are reordered', () => {
  const a = entry({ model: 'model-a' });
  const b = entry({ model: 'model-b' });
  assert.equal(computeContentHash([a, b]), computeContentHash([b, a]));
});

test('contentHash is identical regardless of key order within an entry object', () => {
  const a = entry();
  const keys = Object.keys(a).sort().reverse();
  const reordered = {};
  for (const key of keys) reordered[key] = a[key];
  assert.equal(computeContentHash([a]), computeContentHash([reordered]));
});

test('contentHash treats 1.0 and 1 as the same price', () => {
  assert.equal(
    computeContentHash([entry({ inputPerMillion: 1.0 })]),
    computeContentHash([entry({ inputPerMillion: 1 })]),
  );
});

test('contentHash changes when a field changes', () => {
  assert.notEqual(
    computeContentHash([entry({ inputPerMillion: 1 })]),
    computeContentHash([entry({ inputPerMillion: 2 })]),
  );
});

test('contentHash has the "sha256:" + 64 hex chars shape', () => {
  const hash = computeContentHash([entry()]);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
});

// -------------------------------------------------------------
// PricingVersion
// -------------------------------------------------------------

test('a well-formed PricingVersion parses', () => {
  const version = {
    pricingVersion: 1,
    parentVersion: null,
    createdAt: '2026-10-08T14:02:11.000Z',
    origin: 'starter',
    reason: 'Bundled starter table',
    actor: null,
    starterAsOf: '2026-10-08',
    contentHash: computeContentHash([entry()]),
    entries: [entry()],
  };
  const result = PricingVersionSchema.safeParse(version);
  assert.equal(result.success, true);
});

test('parentVersion must be null only for version 1 is a lifecycle rule, not a schema rule: schema allows null at any version number', () => {
  const version = {
    pricingVersion: 2,
    parentVersion: null,
    createdAt: '2026-10-08T14:02:11.000Z',
    origin: 'file',
    reason: 'Manual edit',
    actor: 'juan',
    starterAsOf: null,
    contentHash: computeContentHash([entry()]),
    entries: [entry()],
  };
  const result = PricingVersionSchema.safeParse(version);
  assert.equal(result.success, true);
});

test('an unknown top-level key on PricingVersion is rejected', () => {
  const version = {
    pricingVersion: 1,
    parentVersion: null,
    createdAt: '2026-10-08T14:02:11.000Z',
    origin: 'starter',
    reason: 'Bundled starter table',
    actor: null,
    starterAsOf: '2026-10-08',
    contentHash: computeContentHash([entry()]),
    entries: [entry()],
    extra: true,
  };
  const result = PricingVersionSchema.safeParse(version);
  assert.equal(result.success, false);
});
