// Issue #84: ingestion-time cost estimate, written alongside the usage ledger row (#65). Covers the migration
// (new columns on a pre-existing database), the live insert path on both stores, that the reported cost/
// currency/costSource are never touched by estimation, that a duplicate is never re-estimated, that an
// unpriceable call never rejects the event, and that a batch never queries the price table per row.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryEventStore, SQLiteEventStore } from '../server/store.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';
import { dbRowToLedgerRowInput } from '../server/usageLedger.ts';
import { usageLedgerEstimates } from '../server/db/migrations/0012-usage-ledger-estimates.ts';

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-ledger-estimates-'));
  return { dir, file: path.join(dir, `${name}.db`) };
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
      // A well-behaved SDK reports an explicit 0 for "no caching on this call", not an absent field (that
      // distinction is exactly what #46 added the ledger for); these tests rely on that explicit 0 throughout,
      // the same way a real non-legacy webhook/SDK payload would.
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.01,
      currency: 'USD',
      costSource: 'provider-reported',
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
// Migration: pre-existing rows keep the new columns NULL
// -------------------------------------------------------------

test('migration usage-ledger-estimates: ALTER TABLE adds the five columns to a database staged without them', () => {
  // A fresh database (migration 6, amended for #84) already creates these columns directly, so there is no way
  // to reach this ALTER TABLE path through the real migration runner's own migration 6. This exercises the
  // migration object's `up()` directly against a hand-built pre-#84 shape, the one a database that applied
  // migration 6 before #84 landed would still have.
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE usage_ledger (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, cost REAL, currency TEXT, cost_source TEXT
    );
  `);
  db.prepare("INSERT INTO usage_ledger (event_id, cost, currency, cost_source) VALUES ('evt_pre_012', 0.01, 'USD', 'provider-reported')").run();

  usageLedgerEstimates.up(db);

  const columns = db.prepare('PRAGMA table_info(usage_ledger)').all().map((c) => c.name);
  for (const column of ['estimated_cost_nano', 'estimated_currency', 'pricing_version', 'estimate_status', 'estimated_at']) {
    assert.ok(columns.includes(column), `missing column ${column}`);
  }
  const raw = db.prepare("SELECT * FROM usage_ledger WHERE event_id = 'evt_pre_012'").get();
  const row = dbRowToLedgerRowInput(raw);
  assert.equal(row.estimateStatus, null, 'a pre-existing row reads as the virtual not_estimated status');
  assert.equal(row.estimatedCostNano, null);
  assert.equal(row.estimatedCurrency, null);
  assert.equal(row.pricingVersion, null);
  assert.equal(row.estimatedAt, null);
  // The reported figures the row already had are completely untouched by the migration.
  assert.equal(row.cost, 0.01);
  assert.equal(row.currency, 'USD');
  assert.equal(row.costSource, 'provider-reported');

  // Idempotent: running it again (as a second server start against the same now-upgraded file would) must not throw.
  assert.doesNotThrow(() => usageLedgerEstimates.up(db));

  // Range checks from the CREATE TABLE version are still enforced after ALTER TABLE.
  assert.throws(
    () => db.prepare("INSERT INTO usage_ledger (event_id, estimated_cost_nano) VALUES ('evt_bad', -1)").run(),
    /CHECK constraint failed/
  );
});

// -------------------------------------------------------------
// Ingestion: a new row gets an estimate, reported fields are untouched
// -------------------------------------------------------------

for (const backend of ['sqlite', 'memory']) {
  test(`${backend}: a priced call gets an estimate in the same step as its ledger row; reported fields untouched`, async () => {
    const pricing = snapshot([priceEntry()], 5);
    const { dir, file } = backend === 'sqlite' ? tempDbPath('priced') : { dir: null, file: null };
    const store =
      backend === 'sqlite'
        ? new SQLiteEventStore(file, { backup: 'off', logger: noopLogger, getPricingSnapshot: () => pricing })
        : new MemoryEventStore({ getPricingSnapshot: () => pricing });
    try {
      const event = usageEvent('evt_priced_1');
      await store.append(event);
      const rows = backend === 'sqlite' ? store.db.prepare('SELECT * FROM usage_ledger').all().map(dbRowToLedgerRowInput) : store.ledger;
      assert.equal(rows.length, 1);
      const [row] = rows;

      // The reported cost this event carried stays byte-for-byte what it was.
      assert.equal(row.cost, 0.01);
      assert.equal(row.currency, 'USD');
      assert.equal(row.costSource, 'provider-reported');

      // The estimate is computed independently: 1200 input @ 2.5/M + 400 output @ 10/M = 0.007 -> 7,000,000 nano.
      assert.equal(row.estimateStatus, 'estimated');
      assert.equal(row.estimatedCostNano, 7_000_000);
      assert.equal(row.estimatedCurrency, 'USD');
      assert.equal(row.pricingVersion, 5);
      assert.equal(typeof row.estimatedAt, 'number');
    } finally {
      if (backend === 'sqlite') {
        await store.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}

test('sqlite: the price in force is resolved by occurredAt, not receivedAt', async () => {
  const entries = [
    priceEntry({ effectiveFrom: '2026-01-01T00:00:00Z', inputPerMillion: 1, outputPerMillion: 0 }),
    priceEntry({ effectiveFrom: '2026-06-01T00:00:00Z', inputPerMillion: 2, outputPerMillion: 0 }),
  ];
  const pricing = snapshot(entries, 9);
  const { dir, file } = tempDbPath('boundary');
  const store = new SQLiteEventStore(file, { backup: 'off', logger: noopLogger, getPricingSnapshot: () => pricing });
  try {
    const before = usageEvent('evt_before', { inputTokens: 1000, outputTokens: 0 }, { timestamp: Date.parse('2026-05-31T23:59:59Z') });
    const atSwitch = usageEvent('evt_at_switch', { inputTokens: 1000, outputTokens: 0 }, { timestamp: Date.parse('2026-06-01T00:00:00Z') });
    await store.append(before, { receivedAt: 5_000_000 });
    await store.append(atSwitch, { receivedAt: 5_000_000 }); // same receivedAt for both: only occurredAt differs

    const rows = store.db.prepare('SELECT * FROM usage_ledger ORDER BY event_id').all().map(dbRowToLedgerRowInput);
    const beforeRow = rows.find((r) => r.eventId === 'evt_before');
    const atSwitchRow = rows.find((r) => r.eventId === 'evt_at_switch');
    assert.equal(beforeRow.estimatedCostNano, 1_000_000); // 1000 tokens @ 1/M = 1000e-6 units = 1,000,000 nano
    assert.equal(atSwitchRow.estimatedCostNano, 2_000_000); // 1000 tokens @ 2/M (half-open: the boundary instant gets the new price)
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sqlite: a model with no price entry gets no_price_for_model, never the gpt-4o or any other fallback price', async () => {
  const pricing = snapshot([priceEntry({ model: 'gpt-4o' })], 1);
  const { dir, file } = tempDbPath('unknown-model');
  const store = new SQLiteEventStore(file, { backup: 'off', logger: noopLogger, getPricingSnapshot: () => pricing });
  try {
    await store.append(usageEvent('evt_unknown', { model: 'some-other-model' }));
    const row = dbRowToLedgerRowInput(store.db.prepare('SELECT * FROM usage_ledger WHERE event_id = ?').get('evt_unknown'));
    assert.equal(row.estimateStatus, 'no_price_for_model');
    assert.equal(row.estimatedCostNano, null);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Duplicate is never re-estimated; estimator failure never rejects the event
// -------------------------------------------------------------

test('sqlite: a request-id duplicate reaches no second ledger row, so it is never re-estimated', async () => {
  const pricing = snapshot([priceEntry()], 1);
  const { dir, file } = tempDbPath('dedup');
  const store = new SQLiteEventStore(file, { backup: 'off', logger: noopLogger, getPricingSnapshot: () => pricing });
  try {
    const original = usageEvent('evt_dup_1', { requestId: 'req-dedup-1' });
    await store.append(original);
    const duplicate = usageEvent('evt_dup_2', { requestId: 'req-dedup-1' }); // same provider+requestId+figures
    await store.append(duplicate);

    const rows = store.db.prepare('SELECT * FROM usage_ledger').all();
    assert.equal(rows.length, 1, 'the duplicate must never insert a second ledger row');
    const row = dbRowToLedgerRowInput(rows[0]);
    assert.equal(row.eventId, 'evt_dup_1');
    assert.equal(row.estimateStatus, 'estimated');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sqlite: an estimator exception stores estimate_status "failed" and the event is still accepted', async () => {
  // A malformed pricing snapshot (entries is not an array) makes resolvePrice throw inside estimateCall's own
  // lookup; estimateCall's try/catch turns that into "failed" rather than ever propagating out of ingestion.
  const malformedPricing = { pricingVersion: 1, entries: null };
  const { dir, file } = tempDbPath('estimator-failure');
  const store = new SQLiteEventStore(file, { backup: 'off', logger: noopLogger, getPricingSnapshot: () => malformedPricing });
  try {
    const result = await store.append(usageEvent('evt_estimator_failure'));
    assert.equal(result.outcome, 'accepted', 'ingestion must not fail because the estimator could not run');
    const row = dbRowToLedgerRowInput(store.db.prepare('SELECT * FROM usage_ledger WHERE event_id = ?').get('evt_estimator_failure'));
    assert.equal(row.estimateStatus, 'failed');
    assert.equal(row.estimatedCostNano, null);
    // The reported cost is completely unaffected by the estimator blowing up.
    assert.equal(row.cost, 0.01);
    assert.equal(row.costSource, 'provider-reported');
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// No per-row price-table query
// -------------------------------------------------------------

test('sqlite: ingesting a batch of 1000 events calls the pricing snapshot getter exactly once per event, never a DB query', async () => {
  const pricing = snapshot([priceEntry()], 1);
  let calls = 0;
  const getPricingSnapshot = () => {
    calls++;
    return pricing;
  };
  const { dir, file } = tempDbPath('batch-1000');
  const store = new SQLiteEventStore(file, { backup: 'off', logger: noopLogger, getPricingSnapshot });
  calls = 0; // the constructor's own startup catch-up pass reads the snapshot once too; only the batch matters here
  try {
    const events = Array.from({ length: 1000 }, (_, i) =>
      usageEvent(`evt_batch_${i}`, { requestId: `req-batch-${i}` })
    );
    await store.appendBatch(events);
    assert.equal(calls, 1000, 'one in-memory snapshot read per ingested row, never more');
    const count = store.db.prepare('SELECT COUNT(*) AS n FROM usage_ledger').get();
    assert.equal(count.n, 1000);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
