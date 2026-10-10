// Issue #66's scale budget: 100,000 seeded `usage_ledger` rows, real migrations, real indexes. Checks that every
// filtered query plan uses a named index (never a bare table scan), that a single-dimension rollup over the full
// range finishes well inside the assertion budget, and that the totals match an independently computed reference
// sum. Seeds directly through SQL (bypassing `toLedgerRow`/the live append path, which issue #65's own
// `usage_ledger` table has no foreign key to `events` for, by design: "the ledger is evidence and must be able to
// outlive a pruned event"), so 100,000 rows insert in one transaction instead of 100,000 validated event appends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteEventStore } from '../server/store.ts';
import { parseRollupQuery, buildWhere, buildGroupsSql, buildTotalsSql } from '../server/usage/rollup.ts';

const ROW_COUNT = 100_000;
const AGENT_COUNT = 50;
const USER_COUNT = 20;
const TASK_COUNT = 200;
const TAG_COUNT = 12;
const MODEL_COUNT = 8;
const PROVIDER_COUNT = 4;
const CURRENCIES = ['USD', 'EUR', 'GBP', null];
const COST_SOURCES = ['provider-reported', 'estimated', 'unknown'];
const DAY_MS = 86_400_000;
const WINDOW_START = Date.parse('2026-01-01T00:00:00.000Z');
const WINDOW_DAYS = 90;

function mulberry32(seed) {
  return function random() {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-rollup-scale-'));
  return { dir, file: path.join(dir, `${name}.db`) };
}

const noopLogger = { info() {}, warn() {}, error() {} };

/** Generates one deterministic row plus its reference figures; callers accumulate the reference independently of
 * anything the rollup code computes. */
function buildRow(i, rand) {
  const agentId = `agent-${i % AGENT_COUNT}`;
  const userId = `user-${i % USER_COUNT}`;
  const taskId = `task-${i % TASK_COUNT}`;
  const model = `model-${i % MODEL_COUNT}`;
  const provider = `provider-${i % PROVIDER_COUNT}`;
  const dayOffset = i % WINDOW_DAYS;
  const receivedAt = WINDOW_START + dayOffset * DAY_MS + (i % 86_400) * 1000;
  const isFailed = i % 20 === 0; // 5%
  const unreportedCache = i % 5 === 0; // 20%
  const tagCount = i % 4 === 0 ? 0 : (i % 3) + 1; // 0 to 3
  const tags = [];
  for (let t = 0; t < tagCount; t++) tags.push(`tag-${(i + t) % TAG_COUNT}`);

  const hasCost = i % 9 !== 0; // most rows have a cost
  const currency = hasCost ? CURRENCIES[i % CURRENCIES.length] : null;
  const costSource = hasCost ? COST_SOURCES[i % COST_SOURCES.length] : 'unknown';
  const cost = hasCost ? Math.round(rand() * 10000) / 100 : null;

  return {
    eventId: `evt_scale_${i}`,
    eventType: isFailed ? 'llm.failed' : 'llm.usage',
    status: isFailed ? 'timeout' : 'ok',
    receivedAt,
    occurredAt: receivedAt - 500,
    agentId,
    userId,
    taskId,
    model,
    provider,
    inputTokens: 100 + (i % 50),
    outputTokens: 20 + (i % 10),
    cacheReadTokens: unreportedCache ? null : i % 30,
    cacheWriteTokens: unreportedCache ? null : i % 10,
    reasoningTokens: i % 7 === 0 ? i % 5 : null,
    cost,
    currency,
    costSource,
    tags,
  };
}

function seedDatabase(db, rowCount) {
  const rand = mulberry32(1234);
  db.exec('BEGIN IMMEDIATE');
  const insertLedger = db.prepare(`
    INSERT INTO usage_ledger (
      event_id, event_type, request_id, received_at, occurred_at, origin, legacy_contract, ingest_channel,
      runtime_id, session_id, agent_id, task_id, provider, model, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, cost, currency, cost_source, latency_ms,
      status, error_kind, trace_id, parent_id, tool_call_id, meeting_id, user_id, tags
    ) VALUES (?, ?, NULL, ?, ?, 'live', 0, 'events', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)
  `);
  const insertTag = db.prepare('INSERT INTO usage_ledger_tags (ledger_seq, tag) VALUES (?, ?)');

  const reference = {
    rows: [],
  };
  for (let i = 0; i < rowCount; i++) {
    const row = buildRow(i, rand);
    const result = insertLedger.run(
      row.eventId,
      row.eventType,
      row.receivedAt,
      row.occurredAt,
      row.agentId,
      row.taskId,
      row.provider,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      row.reasoningTokens,
      row.cost,
      row.currency,
      row.costSource,
      row.status,
      row.userId,
      JSON.stringify(row.tags)
    );
    const seq = Number(result.lastInsertRowid);
    for (const tag of row.tags) insertTag.run(seq, tag);
    reference.rows.push(row);
  }
  db.exec('COMMIT');
  return reference;
}

function computeReferenceTotals(rows) {
  let total = 0;
  let succeeded = 0;
  let failed = 0;
  const tokenSums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const tokenReported = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const costEntries = new Map();
  let unknownCostCalls = 0;

  for (const row of rows) {
    total++;
    if (row.eventType === 'llm.usage') succeeded++;
    else failed++;

    const kinds = [
      ['input', row.inputTokens],
      ['output', row.outputTokens],
      ['cacheRead', row.cacheReadTokens],
      ['cacheWrite', row.cacheWriteTokens],
      ['reasoning', row.reasoningTokens],
    ];
    for (const [kind, value] of kinds) {
      if (value !== null) {
        tokenSums[kind] += value;
        tokenReported[kind]++;
      }
    }

    if (row.cost === null) {
      unknownCostCalls++;
    } else {
      const key = `${row.currency ?? '\u0000'}|${row.costSource}`;
      const entry = costEntries.get(key) ?? { currency: row.currency, costSource: row.costSource, sum: 0, calls: 0 };
      entry.sum += row.cost;
      entry.calls++;
      costEntries.set(key, entry);
    }
  }

  return { total, succeeded, failed, tokenSums, tokenReported, costEntries, unknownCostCalls };
}

function explainPlan(db, sql, params) {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params);
  return rows.map((r) => String(r.detail));
}

function assertIndexedSearch(planLines, label) {
  const text = planLines.join('\n');
  assert.ok(!/SCAN usage_ledger\b(?! USING)/.test(text), `${label}: expected no bare SCAN usage_ledger, got:\n${text}`);
  assert.ok(/SEARCH usage_ledger(_tags)? USING (INDEX|COVERING INDEX) ix_/.test(text), `${label}: expected an indexed SEARCH, got:\n${text}`);
}

test(
  'usage/rollup scale: 100,000 rows - indexed query plans, timing budget, reference reconciliation',
  { timeout: 120_000 },
  async () => {
    const { dir, file } = tempDbPath('scale');
    const store = new SQLiteEventStore(file, { backup: 'off', logger: noopLogger });
    await store.init();

    try {
      const seedStart = Date.now();
      const reference = seedDatabase(getRawDb(store), ROW_COUNT);
      console.log(`[scale test] seeded ${ROW_COUNT} rows in ${Date.now() - seedStart}ms`);

      const refTotals = computeReferenceTotals(reference.rows);

      // -----------------------------------------------------------
      // EXPLAIN QUERY PLAN: every listed filter uses a named index, never a bare scan.
      // -----------------------------------------------------------
      const db = getRawDb(store);
      const filterCases = [
        { agentId: ['agent-7'] },
        { model: ['model-3'] },
        { provider: ['provider-1'] },
        { sessionId: ['does-not-matter'] },
        { taskId: ['task-42'] },
        { userId: ['user-5'] },
        { tag: ['tag-2'] },
      ];
      for (const filterCase of filterCases) {
        const query = parseRollupQuery({ groupBy: 'agent', ...flattenFilter(filterCase) });
        const { sql: whereSql, params } = buildWhere(query.filters, 'received_at', 1_000_000_000);
        const groupsSql = buildGroupsSql(query.groupBy, 'received_at', whereSql, query.groupBy.includes('tag'));
        const plan = explainPlan(db, groupsSql, params);
        assertIndexedSearch(plan, JSON.stringify(filterCase));
      }

      for (const timeBasis of ['received', 'occurred']) {
        const query = parseRollupQuery({
          groupBy: 'agent',
          timeBasis,
          from: String(WINDOW_START + 10 * DAY_MS),
          to: String(WINDOW_START + 20 * DAY_MS),
        });
        const tsCol = timeBasis === 'occurred' ? 'occurred_at' : 'received_at';
        const { sql: whereSql, params } = buildWhere(query.filters, tsCol, 1_000_000_000);
        const groupsSql = buildGroupsSql(query.groupBy, tsCol, whereSql, false);
        const plan = explainPlan(db, groupsSql, params);
        assertIndexedSearch(plan, `time range (${timeBasis})`);
      }

      // -----------------------------------------------------------
      // Timing budget: every single-dimension rollup over the full range, under 2000ms (target <1000ms).
      // -----------------------------------------------------------
      const dimensions = ['agent', 'model', 'provider', 'session', 'task', 'day', 'user', 'tag'];
      for (const dim of dimensions) {
        const query = parseRollupQuery({ groupBy: dim, limit: '10000' });
        const start = Date.now();
        const result = await store.rollup(query);
        const elapsed = Date.now() - start;
        console.log(`[scale test] groupBy=${dim}: ${elapsed}ms, groups=${result.groupCount}`);
        assert.ok(elapsed < 2000, `groupBy=${dim} took ${elapsed}ms, budget is 2000ms`);
      }

      // A filtered rollup (agentId + time range) stays within the same budget.
      {
        const query = parseRollupQuery({
          groupBy: 'model',
          agentId: 'agent-7',
          from: String(WINDOW_START),
          to: String(WINDOW_START + 30 * DAY_MS),
        });
        const start = Date.now();
        await store.rollup(query);
        const elapsed = Date.now() - start;
        console.log(`[scale test] filtered agentId+range: ${elapsed}ms`);
        assert.ok(elapsed < 2000, `filtered rollup took ${elapsed}ms, budget is 2000ms`);
      }

      // -----------------------------------------------------------
      // Correctness: totals reconcile with the independently computed reference.
      // -----------------------------------------------------------
      const fullResult = await store.rollup(parseRollupQuery({ groupBy: 'agent', limit: '10000' }));
      assert.equal(fullResult.totals.calls.total, refTotals.total);
      assert.equal(fullResult.totals.calls.succeeded, refTotals.succeeded);
      assert.equal(fullResult.totals.calls.failed, refTotals.failed);
      assert.equal(fullResult.totals.cost.unknownCostCalls, refTotals.unknownCostCalls);

      for (const kind of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
        assert.equal(fullResult.totals.tokens[kind].reportedCalls, refTotals.tokenReported[kind], `${kind} reportedCalls`);
        if (refTotals.tokenReported[kind] > 0) {
          assert.equal(fullResult.totals.tokens[kind].sum, refTotals.tokenSums[kind], `${kind} sum`);
        } else {
          assert.equal(fullResult.totals.tokens[kind].sum, null);
        }
      }

      const actualEntryByKey = new Map();
      for (const entry of fullResult.totals.cost.entries) {
        actualEntryByKey.set(`${entry.currency ?? '\u0000'}|${entry.costSource}`, entry);
      }
      assert.equal(actualEntryByKey.size, refTotals.costEntries.size);
      for (const [key, refEntry] of refTotals.costEntries) {
        const actual = actualEntryByKey.get(key);
        assert.ok(actual, `missing cost entry ${key}`);
        assert.equal(actual.calls, refEntry.calls, `calls mismatch for ${key}`);
        // The reference sum here is accumulated in row-generation order, while SQLite's own `SUM` runs in
        // whatever order its query plan visits rows; both are IEEE 754 doubles of the same per-row values (rule
        // 10), so they can differ by a few ULPs once thousands of terms are added. `1e-9` absolute is the budget
        // for comparing a rollup against *another rollup* over the same rows (memory vs SQLite, or against the
        // calls API), which both run through the one rounding step; an independently-ordered reference sum over
        // ~25,000 terms needs a slightly looser bound to stay meaningful rather than flaky.
        assert.ok(Math.abs(actual.sum - refEntry.sum) < 1e-6, `sum mismatch for ${key}: ${actual.sum} vs ${refEntry.sum}`);
      }
    } finally {
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

/** `SQLiteEventStore` keeps its connection as a private field; reached here the same way other white-box tests in
 * this suite reach it (there is no public accessor, and adding one only for a test fixture is not worth a new
 * surface on the store). */
function getRawDb(store) {
  return store.db;
}

function flattenFilter(filterCase) {
  const out = {};
  for (const [key, values] of Object.entries(filterCase)) out[key] = values;
  return out;
}
