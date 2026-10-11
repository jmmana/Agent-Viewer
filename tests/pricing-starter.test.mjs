// Issue #83 (sub-issue: pricing contract, resolver, starter table). Validates the bundled starter table
// (server/pricing/starter.json) against the pricing schema and the starter-specific acceptance criteria:
// every entry is `source: 'starter'`, `estimated: true`, has an https sourceUrl and a sourceCheckedAt not
// later than the top-level `starter.asOf`; each of openai/anthropic/google has at least three models; no
// local or self-hosted model is present.
//
// Proving the starter is *inlined* into the built CLI bundle (`dist-cli/cli.js`), rather than read from
// `server/` at runtime, needs something in the CLI's reachable import graph to actually import it. That
// import is added when the file store wires it in for first-start seeding (issue #83, sub-issue: pricing
// file store, lifecycle and CLI wiring) -- this sub-issue only produces the file and proves it is valid and
// JSON-module-importable, which is the part that does not yet depend on the store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import starter from '../server/pricing/starter.json' with { type: 'json' };
import { PRICING_SCHEMA, parsePriceEntries } from '../src/integrations/pricingContract.ts';

const starterPath = fileURLToPath(new URL('../server/pricing/starter.json', import.meta.url));

test('starter.json declares the current pricing schema', () => {
  assert.equal(starter.schema, PRICING_SCHEMA);
});

test('starter.json carries a top-level starter.asOf calendar date', () => {
  assert.match(starter.starter.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Number.isNaN(Date.parse(`${starter.starter.asOf}T00:00:00Z`)));
});

test('every starter entry validates against the strict pricing schema (and the collection rules)', () => {
  const result = parsePriceEntries(starter.entries);
  assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.issues));
});

test('every starter entry is source=starter and estimated=true', () => {
  for (const entry of starter.entries) {
    assert.equal(entry.source, 'starter', `${entry.provider}/${entry.model} must have source: 'starter'`);
    assert.equal(entry.estimated, true, `${entry.provider}/${entry.model} must have estimated: true`);
  }
});

test('every starter entry has an https sourceUrl and a sourceCheckedAt not later than starter.asOf', () => {
  const asOfMs = Date.parse(`${starter.starter.asOf}T00:00:00Z`);
  for (const entry of starter.entries) {
    assert.ok(entry.sourceUrl && entry.sourceUrl.startsWith('https://'), `${entry.provider}/${entry.model} needs an https sourceUrl`);
    assert.ok(entry.sourceCheckedAt, `${entry.provider}/${entry.model} needs a sourceCheckedAt`);
    const checkedMs = Date.parse(`${entry.sourceCheckedAt}T00:00:00Z`);
    assert.ok(checkedMs <= asOfMs, `${entry.provider}/${entry.model} sourceCheckedAt must not be later than starter.asOf`);
  }
});

test('openai, anthropic and google each have at least three distinct models', () => {
  const byProvider = new Map();
  for (const entry of starter.entries) {
    const models = byProvider.get(entry.provider) ?? new Set();
    models.add(entry.model);
    byProvider.set(entry.provider, models);
  }
  for (const provider of ['openai', 'anthropic', 'google']) {
    const models = byProvider.get(provider);
    assert.ok(models, `missing provider ${provider}`);
    assert.ok(models.size >= 3, `${provider} must have at least 3 models, has ${models?.size ?? 0}`);
  }
});

test('the starter table contains no entry outside openai, anthropic and google (no local or self-hosted model)', () => {
  const providers = new Set(starter.entries.map((entry) => entry.provider));
  assert.deepEqual([...providers].sort(), ['anthropic', 'google', 'openai']);
});

test('no starter entry has every price at zero (a zero price is always an explicit operator override, never a starter default)', () => {
  for (const entry of starter.entries) {
    const prices = [entry.inputPerMillion, entry.outputPerMillion, entry.cacheReadPerMillion, entry.cacheWritePerMillion, entry.reasoningPerMillion];
    const allZero = prices.every((price) => price === 0);
    assert.equal(allZero, false, `${entry.provider}/${entry.model} must not be all-zero`);
  }
});

test('starter.json contains no em dash (U+2014)', () => {
  const content = readFileSync(starterPath, 'utf8');
  assert.ok(!content.includes(String.fromCharCode(0x2014)), 'starter.json must not contain an em dash');
});
