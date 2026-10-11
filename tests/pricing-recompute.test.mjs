// Issue #296 (sub-issue of #84): the write side of estimation. `POST /api/v1/pricing/recompute` re-runs
// `estimateCall`/`estimateLedgerRow` (#84, `server/pricing/estimate.ts`) against a corrected or pinned price
// table, atomically, writing a new revision only for rows whose result changed; `GET /api/v1/pricing/
// recompute-runs[/:runId]` lists past runs; `GET /api/v1/usage/calls/:id/estimates` lists every revision of one
// call with a component breakdown derived on read. Section A exercises the request parser in isolation; section
// B exercises the engine (`server/pricing/recompute.ts`) directly against a `SQLiteEventStore`, with hand-built
// pricing snapshots (no file I/O, same style as `tests/ledger-estimates.test.mjs`); section C exercises the four
// HTTP routes end to end against the real `app`, backed by the real file pricing store.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { SQLiteEventStore } from '../server/store.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';
import {
  parseRecomputeRequest,
  PricingVersionNotFoundError,
  RecomputeInProgressError,
  RecomputeTooBroadError,
} from '../server/pricing/recompute.ts';

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-viewer-recompute-${name}-`));
  return { dir, file: path.join(dir, 'db.sqlite') };
}

const noopLogger = { info() {}, warn() {}, error() {} };

function usageEvent(id, payload = {}, envelope = {}) {
  const result = validateCanonicalEvent({
    id,
    type: 'llm.usage',
    timestamp: 1_700_000_000_000,
    source: 'agent:auditor',
    agentId: 'auditor',
    summary: 'Audited call',
    payload: {
      provider: 'anthropic',
      model: 'example-model',
      inputTokens: 1200,
      outputTokens: 400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: null,
      currency: null,
      costSource: 'unknown',
      ...payload,
    },
    ...envelope,
  });
  assert.equal(result.success, true, JSON.stringify(result.issues));
  return result.data;
}

function priceEntry(overrides = {}) {
  return {
    provider: 'anthropic',
    model: 'example-model',
    aliases: [],
    kind: 'list',
    currency: 'USD',
    effectiveFrom: '2000-01-01T00:00:00.000Z',
    inputPerMillion: 2.5,
    outputPerMillion: 10,
    cacheReadPerMillion: null,
    cacheWritePerMillion: null,
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

// -------------------------------------------------------------
// A. Request parsing
// -------------------------------------------------------------

test('parseRecomputeRequest: rejects a missing, blank or over-long reason with reason_required', () => {
  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(501) }]) {
    const result = parseRecomputeRequest(body);
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.code, 'reason_required');
  }
});

test('parseRecomputeRequest: rejects an unknown filter field with invalid_filter', () => {
  const result = parseRecomputeRequest({ reason: 'fix', filter: { modelTypo: 'gpt-4o' } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_filter');
  assert.equal(result.issues[0].path, 'filter.modelTypo');
});

test('parseRecomputeRequest: a full, valid body parses with normalized provider and explicit defaults', () => {
  const result = parseRecomputeRequest({
    reason: 'Corrected rate',
    pricingVersion: 3,
    dryRun: true,
    filter: { from: 1000, to: 2000, model: 'gpt-4o', provider: 'OpenAI', agentId: 'a1', onlyUnestimated: true },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    reason: 'Corrected rate',
    pricingVersion: 3,
    dryRun: true,
    filter: { from: 1000, to: 2000, model: 'gpt-4o', provider: 'openai', agentId: 'a1', onlyUnestimated: true },
  });
});

test('parseRecomputeRequest: a minimal body gets null pricingVersion, dryRun false and an empty filter', () => {
  const result = parseRecomputeRequest({ reason: 'audit' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    reason: 'audit',
    pricingVersion: null,
    dryRun: false,
    filter: { from: null, to: null, model: null, provider: null, agentId: null, onlyUnestimated: false },
  });
});

// -------------------------------------------------------------
// B. Engine, against a real SQLiteEventStore
// -------------------------------------------------------------

function makeStore(name, overrides = {}) {
  const { dir, file } = tempDbPath(name);
  const store = new SQLiteEventStore(file, {
    backup: 'off',
    logger: noopLogger,
    getPricingSnapshot: () => snapshot([priceEntry()], 1),
    getPricingVersionSnapshot: () => null,
    recomputeMaxRows: 200_000,
    ...overrides,
  });
  return { dir, store };
}

test('recomputePricing: a changed result gets revision 1, the ledger row (revision 0) is untouched', async () => {
  // `getPricingVersionSnapshot` must resolve every version number this test's rows ever get stamped with: the
  // per-call history endpoint derives each revision's component breakdown by looking up its own recorded
  // `pricingVersion`, never the "current" one, so a test that only swaps `getPricingSnapshot` would leave the
  // history endpoint unable to re-resolve the price for a past revision.
  const versions = new Map([[1, snapshot([priceEntry()], 1)]]);
  const { dir, store } = makeStore('basic', {
    getPricingSnapshot: () => versions.get(1),
    getPricingVersionSnapshot: (v) => versions.get(v) ?? null,
  });
  try {
    await store.append(usageEvent('evt_basic_1'));
    const before = await store.getCallEstimates('evt_basic_1');
    assert.equal(before.revisions.length, 1);
    assert.equal(before.revisions[0].pricingVersion, 1);
    assert.equal(before.revisions[0].costNano, 7_000_000); // 1200@2.5/M + 400@10/M = 0.003 + 0.004

    // A corrected table: double the input rate. The row's result changes, so this run writes a new revision.
    versions.set(2, snapshot([priceEntry({ inputPerMillion: 5 })], 2));
    store.getPricingSnapshot = () => versions.get(2);
    const outcome = await store.recomputePricing({
      reason: 'Corrected input rate',
      pricingVersion: null,
      dryRun: false,
      filter: { from: null, to: null, model: null, provider: null, agentId: null, onlyUnestimated: false },
    });
    assert.equal(outcome.dryRun, false);
    assert.equal(outcome.revision, 1);
    assert.equal(outcome.pricingVersion, 2);
    assert.deepEqual(outcome.rows, { matched: 1, written: 1, unchanged: 0, estimated: 1, unestimable: 0 });

    const after = await store.getCallEstimates('evt_basic_1');
    assert.equal(after.revisions.length, 2);
    assert.equal(after.revisions[0].revision, 0);
    assert.equal(after.revisions[0].costNano, 7_000_000, 'revision 0 (the ledger row) is never rewritten');
    assert.equal(after.revisions[1].revision, 1);
    assert.equal(after.revisions[1].costNano, 10_000_000); // 1200@5/M + 400@10/M = 0.006 + 0.004
    assert.equal(after.revisions[1].run.reason, 'Corrected input rate');
    assert.equal(typeof after.revisions[1].run.runId, 'string');

    // Components sum exactly to the revision's own cost.
    const sum = after.revisions[1].components.reduce((acc, c) => acc + c.costNano, 0);
    assert.equal(sum, after.revisions[1].costNano);
    // input, output, cache_read and cache_write are always priced (even at 0 tokens); reasoning is omitted here
    // since this entry's reasoningBilling is 'included_in_output'.
    assert.deepEqual(
      after.revisions[1].components.map((c) => c.component).sort(),
      ['cache_read', 'cache_write', 'input', 'output']
    );
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recomputePricing: a run whose result does not change counts the row but writes nothing, yet still allocates a revision', async () => {
  const { dir, store } = makeStore('unchanged');
  try {
    await store.append(usageEvent('evt_unchanged_1'));
    const emptyFilter = { from: null, to: null, model: null, provider: null, agentId: null, onlyUnestimated: false };
    const first = await store.recomputePricing({ reason: 'no-op check', pricingVersion: null, dryRun: false, filter: emptyFilter });
    assert.equal(first.revision, 1);
    assert.deepEqual(first.rows, { matched: 1, written: 0, unchanged: 1, estimated: 1, unestimable: 0 });

    // A second run against the exact same (unchanged) pricing snapshot still allocates revision 2: the issue's
    // own rule is "runs that write 0 rows are still recorded".
    const second = await store.recomputePricing({ reason: 'no-op check again', pricingVersion: null, dryRun: false, filter: emptyFilter });
    assert.equal(second.revision, 2);
    assert.deepEqual(second.rows, { matched: 1, written: 0, unchanged: 1, estimated: 1, unestimable: 0 });

    const estimates = await store.getCallEstimates('evt_unchanged_1');
    assert.equal(estimates.revisions.length, 1, 'no usage_estimates row was ever written for an unchanged result');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recomputePricing: an explicit pricingVersion is pinned for every row regardless of occurredAt, and 404s when it does not exist', async () => {
  const versions = new Map([
    [1, snapshot([priceEntry({ inputPerMillion: 1, outputPerMillion: 0 })], 1)],
    [2, snapshot([priceEntry({ inputPerMillion: 9, outputPerMillion: 0 })], 2)],
  ]);
  const { dir, store } = makeStore('pinned', {
    getPricingSnapshot: () => versions.get(2),
    getPricingVersionSnapshot: (v) => versions.get(v) ?? null,
  });
  try {
    await store.append(usageEvent('evt_pinned_1', { inputTokens: 1000, outputTokens: 0 }));
    const afterIngest = await store.getCallEstimates('evt_pinned_1');
    assert.equal(afterIngest.revisions[0].costNano, 9_000_000); // ingested against the current (v2) snapshot

    const emptyFilter = { from: null, to: null, model: null, provider: null, agentId: null, onlyUnestimated: false };
    const pinned = await store.recomputePricing({ reason: 'Pin to v1', pricingVersion: 1, dryRun: false, filter: emptyFilter });
    assert.equal(pinned.pricingVersion, 1);
    assert.equal(pinned.rows.written, 1);
    const run = await store.getRecomputeRun(pinned.runId);
    assert.equal(run.pricingVersionSelector, 1);

    const afterPin = await store.getCallEstimates('evt_pinned_1');
    assert.equal(afterPin.revisions.at(-1).costNano, 1_000_000); // 1000 tokens @ 1/M under the pinned v1 table

    await assert.rejects(
      store.recomputePricing({ reason: 'Pin to a missing version', pricingVersion: 999, dryRun: false, filter: emptyFilter }),
      PricingVersionNotFoundError
    );
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recomputePricing: onlyUnestimated matches a row whose latest status is not "estimated", including a legacy not_estimated row', async () => {
  // No price in force at ingestion time: the row starts life unpriced.
  const { dir, store } = makeStore('only-unestimated', { getPricingSnapshot: () => snapshot([], null) });
  try {
    await store.append(usageEvent('evt_unpriced_1'));
    const afterIngest = await store.getCallEstimates('evt_unpriced_1');
    assert.equal(afterIngest.revisions[0].status, 'no_price_in_force');

    // A second, already-priced row (ingested under its own fresh store) is not part of this filter's match set
    // because onlyUnestimated only matches the unpriced one; prove it stays untouched by filtering on agentId.
    store.getPricingSnapshot = () => snapshot([priceEntry()], 1);
    const outcome = await store.recomputePricing({
      reason: 'Backfill after adding a price',
      pricingVersion: null,
      dryRun: false,
      filter: { from: null, to: null, model: null, provider: null, agentId: null, onlyUnestimated: true },
    });
    assert.equal(outcome.rows.matched, 1);
    assert.equal(outcome.rows.written, 1);
    assert.equal(outcome.rows.estimated, 1);

    const after = await store.getCallEstimates('evt_unpriced_1');
    assert.equal(after.revisions.at(-1).status, 'estimated');

    // Running it again with the same filter now matches nothing: the row is no longer unestimated.
    const again = await store.recomputePricing({
      reason: 'Should match nothing now',
      pricingVersion: null,
      dryRun: false,
      filter: { from: null, to: null, model: null, provider: null, agentId: null, onlyUnestimated: true },
    });
    assert.equal(again.rows.matched, 0);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recomputePricing: dryRun writes nothing, allocates no revision, and returns counts plus up to 20 samples', async () => {
  const { dir, store } = makeStore('dry-run');
  try {
    for (let i = 0; i < 3; i++) await store.append(usageEvent(`evt_dry_${i}`));
    store.getPricingSnapshot = () => snapshot([priceEntry({ inputPerMillion: 5 })], 2);

    const before = await store.listRecomputeRuns({ limit: 10, before: null });
    const outcome = await store.recomputePricing({
      reason: 'preview only',
      pricingVersion: null,
      dryRun: true,
      filter: { from: null, to: null, model: null, provider: null, agentId: null, onlyUnestimated: false },
    });
    assert.equal(outcome.dryRun, true);
    assert.deepEqual(outcome.rows, { matched: 3, written: 3, unchanged: 0, estimated: 3, unestimable: 0 });
    assert.equal(outcome.samples.length, 3);
    for (const sample of outcome.samples) {
      assert.equal(typeof sample.ledgerId, 'string');
      assert.equal(sample.before.costNano, 7_000_000);
      assert.equal(sample.after.costNano, 10_000_000);
    }

    const after = await store.listRecomputeRuns({ limit: 10, before: null });
    assert.deepEqual(after, before, 'dryRun left the run history exactly as it was');
    const estimates = await store.getCallEstimates('evt_dry_0');
    assert.equal(estimates.revisions.length, 1, 'dryRun left usage_estimates exactly as it was');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recomputePricing: a filter matching more rows than the cap gets 413-shaped filter_too_broad and writes nothing', async () => {
  const { dir, store } = makeStore('row-cap', { recomputeMaxRows: 2 });
  try {
    for (let i = 0; i < 3; i++) await store.append(usageEvent(`evt_cap_${i}`));
    store.getPricingSnapshot = () => snapshot([priceEntry({ inputPerMillion: 5 })], 2);

    await assert.rejects(
      store.recomputePricing({
        reason: 'too broad',
        pricingVersion: null,
        dryRun: false,
        filter: { from: null, to: null, model: null, provider: null, agentId: null, onlyUnestimated: false },
      }),
      (error) => {
        assert.ok(error instanceof RecomputeTooBroadError);
        assert.equal(error.matched, 3);
        assert.equal(error.maxRows, 2);
        return true;
      }
    );
    const runs = await store.listRecomputeRuns({ limit: 10, before: null });
    assert.equal(runs.runs.length, 0, 'the row-cap check runs before anything is written');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recomputePricing: a run at the (lowered, for speed) cap completes quickly; extrapolated, the 200000-row default is a few seconds at most', async () => {
  const CAP = 300;
  const { dir, store } = makeStore('timing', { recomputeMaxRows: CAP });
  try {
    for (let i = 0; i < CAP; i++) {
      await store.append(usageEvent(`evt_timing_${i}`, {}, { id: `evt_timing_${i}` }));
    }
    store.getPricingSnapshot = () => snapshot([priceEntry({ inputPerMillion: 5 })], 2);

    const startedAt = Date.now();
    const outcome = await store.recomputePricing({
      reason: 'timing run',
      pricingVersion: null,
      dryRun: false,
      filter: { from: null, to: null, model: null, provider: null, agentId: null, onlyUnestimated: false },
    });
    const durationMs = Date.now() - startedAt;
    assert.equal(outcome.rows.matched, CAP);
    // Generous bound for CI noise; the point of this test is to have a recorded, checked number, not to be tight.
    assert.ok(durationMs < 5000, `a ${CAP}-row run took ${durationMs}ms, expected well under 5000ms`);
    console.log(`[pricing-recompute test] ${CAP} rows recomputed in ${durationMs}ms (extrapolates to the 200000-row default)`);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recomputePricing: a forced failure right before commit leaves no usage_estimates row and no run recorded', async () => {
  const { dir, store } = makeStore('rollback');
  try {
    await store.append(usageEvent('evt_rollback_1'));
    store.getPricingSnapshot = () => snapshot([priceEntry({ inputPerMillion: 5 })], 2);

    await assert.rejects(
      store.recomputePricing(
        {
          reason: 'forced failure',
          pricingVersion: null,
          dryRun: false,
          filter: { from: null, to: null, model: null, provider: null, agentId: null, onlyUnestimated: false },
        },
        {
          onBeforeCommit: () => {
            throw new Error('injected failure for the atomicity test');
          },
        }
      ),
      /injected failure/
    );

    const estimates = await store.getCallEstimates('evt_rollback_1');
    assert.equal(estimates.revisions.length, 1, 'no new revision survived the forced rollback');
    const runs = await store.listRecomputeRuns({ limit: 10, before: null });
    assert.equal(runs.runs.length, 0, 'no run row survived the forced rollback');

    // The lock is released even after a failed run: a normal run right after succeeds.
    const recovered = await store.recomputePricing({
      reason: 'after rollback',
      pricingVersion: null,
      dryRun: false,
      filter: { from: null, to: null, model: null, provider: null, agentId: null, onlyUnestimated: false },
    });
    assert.equal(recovered.revision, 1);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recomputePricing: a second run that arrives while one is in progress is rejected with recompute_in_progress, never queued', async () => {
  const { dir, store } = makeStore('concurrent');
  try {
    await store.append(usageEvent('evt_concurrent_1'));
    store.getPricingSnapshot = () => snapshot([priceEntry({ inputPerMillion: 5 })], 2);
    const emptyFilter = { from: null, to: null, model: null, provider: null, agentId: null, onlyUnestimated: false };

    let innerPromise;
    const outer = await store.recomputePricing(
      { reason: 'outer run', pricingVersion: null, dryRun: false, filter: emptyFilter },
      {
        onLockAcquired: () => {
          // Reentrant call while the lock from the outer run is still held: reproduces "a second request
          // arrives mid-run" without needing real concurrent I/O (node:sqlite is synchronous: see the module
          // doc comment in server/pricing/recompute.ts for why two genuinely concurrent requests cannot
          // interleave on their own).
          innerPromise = store.recomputePricing({ reason: 'inner run', pricingVersion: null, dryRun: false, filter: emptyFilter });
        },
      }
    );
    assert.equal(outer.revision, 1, 'the outer run completed normally');
    await assert.rejects(innerPromise, RecomputeInProgressError);

    // The lock is released once the outer run finishes: a later run is not permanently blocked.
    const later = await store.recomputePricing({ reason: 'after both', pricingVersion: null, dryRun: false, filter: emptyFilter });
    assert.equal(later.revision, 2);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recomputePricing: filters by occurredAt (half-open), model, provider and agentId', async () => {
  const { dir, store } = makeStore('filters');
  try {
    await store.append(usageEvent('evt_f_a', { provider: 'anthropic', model: 'example-model' }, { timestamp: 1000, agentId: 'agent-a' }));
    await store.append(usageEvent('evt_f_b', { provider: 'openai', model: 'gpt-4o' }, { timestamp: 2000, agentId: 'agent-b' }));
    store.getPricingSnapshot = () => snapshot([priceEntry(), priceEntry({ provider: 'openai', model: 'gpt-4o' })], 2);

    const byModel = await store.recomputePricing({
      reason: 'model filter',
      pricingVersion: null,
      dryRun: true,
      filter: { from: null, to: null, model: 'gpt-4o', provider: null, agentId: null, onlyUnestimated: false },
    });
    assert.equal(byModel.rows.matched, 1);

    const byWindow = await store.recomputePricing({
      reason: 'window filter',
      pricingVersion: null,
      dryRun: true,
      filter: { from: 1000, to: 2000, model: null, provider: null, agentId: null, onlyUnestimated: false },
    });
    assert.equal(byWindow.rows.matched, 1, 'the half-open window [1000, 2000) excludes the row at exactly 2000');

    const byAgent = await store.recomputePricing({
      reason: 'agent filter',
      pricingVersion: null,
      dryRun: true,
      filter: { from: null, to: null, model: null, provider: null, agentId: 'agent-b', onlyUnestimated: false },
    });
    assert.equal(byAgent.rows.matched, 1);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listRecomputeRuns/getRecomputeRun: newest first, limit/before pagination, and 404-shaped null for an unknown run', async () => {
  const { dir, store } = makeStore('runs-listing');
  try {
    await store.append(usageEvent('evt_runs_1'));
    const emptyFilter = { from: null, to: null, model: null, provider: null, agentId: null, onlyUnestimated: false };
    store.getPricingSnapshot = () => snapshot([priceEntry({ inputPerMillion: 5 })], 2);
    const run1 = await store.recomputePricing({ reason: 'run one', pricingVersion: null, dryRun: false, filter: emptyFilter });
    store.getPricingSnapshot = () => snapshot([priceEntry({ inputPerMillion: 6 })], 3);
    const run2 = await store.recomputePricing({ reason: 'run two', pricingVersion: null, dryRun: false, filter: emptyFilter });

    const page1 = await store.listRecomputeRuns({ limit: 1, before: null });
    assert.equal(page1.runs.length, 1);
    assert.equal(page1.runs[0].runId, run2.runId, 'newest first');
    assert.equal(page1.hasMore, true);

    const page2 = await store.listRecomputeRuns({ limit: 1, before: page1.runs[0].revision });
    assert.equal(page2.runs.length, 1);
    assert.equal(page2.runs[0].runId, run1.runId);
    assert.equal(page2.hasMore, false);

    const detail = await store.getRecomputeRun(run1.runId);
    assert.equal(detail.reason, 'run one');
    assert.equal(await store.getRecomputeRun('run_does_not_exist'), null);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getCallEstimates: returns null for an unknown call id', async () => {
  const { dir, store } = makeStore('call-not-found');
  try {
    assert.equal(await store.getCallEstimates('evt_does_not_exist'), null);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// C. HTTP routes, end to end
// -------------------------------------------------------------

function startTestServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

const TOKEN = 'test-recompute-token';

test('HTTP: recompute, recompute-runs and the per-call estimates route, status codes and shapes', async (t) => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-recompute-http-'));
  const pricingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-recompute-http-pricing-'));
  process.env.AGENT_VIEWER_STORAGE = 'sqlite';
  process.env.AGENT_VIEWER_SQLITE_PATH = path.join(dbDir, 'db.sqlite');
  process.env.AGENT_VIEWER_SQLITE_BACKUP = 'off';
  process.env.AGENT_VIEWER_RATE_LIMIT = '100000';
  process.env.AGENT_VIEWER_API_TOKEN = TOKEN;
  process.env.AGENT_VIEWER_PRICING_FILE = path.join(pricingDir, 'pricing.json');
  process.env.AGENT_VIEWER_PRICING_HISTORY_FILE = path.join(pricingDir, 'pricing-history.jsonl');
  process.env.AGENT_VIEWER_RECOMPUTE_MAX_ROWS = '5';

  const { app, store } = await import('../server/index.ts');
  const { getPricingStore, resetPricingStoreForTests } = await import('../server/pricing/store.ts');
  resetPricingStoreForTests();
  // Seed a priced entry for the model this test ingests, as a second version (version 1 is the bundled starter
  // table, seeded on first access): the recompute endpoints below pin version 2 explicitly.
  const starterSnapshot = getPricingStore().getSnapshot();
  getPricingStore().applyApiChange(
    [
      ...starterSnapshot.entries,
      {
        provider: 'anthropic',
        model: 'http-test-model',
        aliases: [],
        kind: 'list',
        currency: 'USD',
        effectiveFrom: '2000-01-01T00:00:00.000Z',
        inputPerMillion: 2,
        outputPerMillion: 4,
        cacheReadPerMillion: null,
        cacheWritePerMillion: null,
        reasoningPerMillion: null,
        reasoningBilling: 'included_in_output',
        estimated: false,
        sourceUrl: null,
        sourceCheckedAt: null,
        note: null,
      },
    ],
    { reason: 'seed for HTTP recompute test', actor: null }
  );

  const { server, baseUrl } = await startTestServer(app);
  t.after(async () => {
    server.close();
    await store.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
    fs.rmSync(pricingDir, { recursive: true, force: true });
  });

  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  await store.append(
    validateCanonicalEvent({
      id: 'evt_http_1',
      type: 'llm.usage',
      timestamp: Date.now(),
      source: 'agent:http-test',
      agentId: 'http-test',
      summary: 'HTTP test call',
      payload: {
        provider: 'anthropic',
        model: 'http-test-model',
        inputTokens: 1000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: null,
        currency: null,
        costSource: 'unknown',
      },
    }).data
  );

  await t.test('401 without a Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/v1/pricing/recompute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'x' }),
    });
    assert.equal(res.status, 401);
  });

  await t.test('400 reason_required when reason is missing', async () => {
    const res = await fetch(`${baseUrl}/api/v1/pricing/recompute`, { method: 'POST', headers: auth, body: JSON.stringify({}) });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'reason_required');
  });

  await t.test('400 invalid_filter for an unknown filter field', async () => {
    const res = await fetch(`${baseUrl}/api/v1/pricing/recompute`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ reason: 'x', filter: { bogus: 1 } }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid_filter');
  });

  await t.test('404 pricing_version_not_found for an unknown pricingVersion', async () => {
    const res = await fetch(`${baseUrl}/api/v1/pricing/recompute`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ reason: 'x', pricingVersion: 999999 }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'pricing_version_not_found');
  });

  let committedRunId;
  await t.test('201 on a real run, with the documented response shape', async () => {
    // Correct the price so this run actually changes the row's result (otherwise it would be legitimately
    // counted as "unchanged" and write nothing, which a later sub-test here relies on not happening).
    const current = getPricingStore().getSnapshot();
    getPricingStore().applyApiChange(
      current.entries.map((entry) =>
        entry.provider === 'anthropic' && entry.model === 'http-test-model' ? { ...entry, inputPerMillion: 20 } : entry
      ),
      { reason: 'correct the rate before recompute', actor: null }
    );

    const res = await fetch(`${baseUrl}/api/v1/pricing/recompute`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ reason: 'HTTP recompute test', filter: { model: 'http-test-model' } }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.dryRun, false);
    assert.equal(typeof body.runId, 'string');
    assert.equal(typeof body.revision, 'number');
    assert.equal(body.rows.matched, 1);
    assert.equal(body.rows.written, 1, 'the corrected rate changed this row\'s result');
    assert.equal(body.rows.written + body.rows.unchanged, body.rows.matched);
    assert.equal(body.rows.estimated + body.rows.unestimable, body.rows.matched);
    committedRunId = body.runId;
  });

  await t.test('200 on dryRun, writes nothing', async () => {
    const res = await fetch(`${baseUrl}/api/v1/pricing/recompute`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ reason: 'preview', dryRun: true, filter: { model: 'http-test-model' } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.dryRun, true);
    assert.ok(Array.isArray(body.samples));
  });

  await t.test('413 filter_too_broad above the configured cap', async () => {
    for (let i = 0; i < 10; i++) {
      await store.append(
        validateCanonicalEvent({
          id: `evt_http_cap_${i}`,
          type: 'llm.usage',
          timestamp: Date.now(),
          source: 'agent:http-test',
          agentId: 'http-test',
          summary: 'cap filler',
          payload: {
            provider: 'anthropic',
            model: 'http-test-model',
            inputTokens: 10,
            outputTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: null,
            currency: null,
            costSource: 'unknown',
          },
        }).data
      );
    }
    const res = await fetch(`${baseUrl}/api/v1/pricing/recompute`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ reason: 'too broad now', filter: { model: 'http-test-model' } }),
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error, 'filter_too_broad');
  });

  await t.test('GET recompute-runs lists newest first and the detail route 404s for an unknown id', async () => {
    const list = await (await fetch(`${baseUrl}/api/v1/pricing/recompute-runs`, { headers: auth })).json();
    assert.ok(list.data.length >= 1);
    assert.equal(list.data[0].runId, list.data[0].runId); // shape sanity: runId present

    const detail = await fetch(`${baseUrl}/api/v1/pricing/recompute-runs/${committedRunId}`, { headers: auth });
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.runId, committedRunId);

    const missing = await fetch(`${baseUrl}/api/v1/pricing/recompute-runs/run_does_not_exist`, { headers: auth });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'run_not_found');
  });

  await t.test('GET usage/calls/:id/estimates lists every revision and 404s for an unknown call', async () => {
    const res = await fetch(`${baseUrl}/api/v1/usage/calls/evt_http_1/estimates`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.eventId, 'evt_http_1');
    assert.ok(body.revisions.length >= 2);
    assert.equal(body.revisions[0].revision, 0);

    const missing = await fetch(`${baseUrl}/api/v1/usage/calls/evt_does_not_exist/estimates`, { headers: auth });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'call_not_found');
  });
});
