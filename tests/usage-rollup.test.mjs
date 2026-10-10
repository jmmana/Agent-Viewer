// Issue #66: GET /api/v1/usage/rollup. Covers the request parser (`parseRollupQuery`), the normative aggregation
// rules of section 2 against both stores, a memory-vs-SQLite parity check, and a small property-style test over a
// seeded random ledger. HTTP-level behavior (auth, Cache-Control, 400 shape) lives in tests/integration-api.test.mjs;
// the 100,000-row index/timing budget lives in tests/usage-rollup-scale.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryEventStore, SQLiteEventStore } from '../server/store.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';
import { parseRollupQuery, UsageFilterError } from '../server/usage/rollup.ts';

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-rollup-'));
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
    // A `source` starting with "agent:" makes the validator derive agentId from it when none is given, so a
    // genuinely agent-less row (`agentId: null`) also needs a non-agent source.
    source: rest.agentId === null ? 'system:test' : 'agent:test',
    // `undefined` means "default to agent-1" (most tests don't care about the agent dimension); pass `null`
    // explicitly to omit agentId altogether (a real "no agent" row, mapped to the null group).
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
  const { dir, file } = tempDbPath('rollup');
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

// -------------------------------------------------------------
// parseRollupQuery: validation (section 1, acceptance criteria's 400 list)
// -------------------------------------------------------------

function expectInvalid(query, pathPrefix) {
  assert.throws(
    () => parseRollupQuery(query),
    (err) => {
      assert.ok(err instanceof UsageFilterError);
      assert.ok(err.issues.length > 0);
      if (pathPrefix) assert.ok(err.issues.some((i) => i.path === pathPrefix), JSON.stringify(err.issues));
      return true;
    }
  );
}

test('parseRollupQuery: groupBy is required', () => {
  expectInvalid({}, 'groupBy');
});

test('parseRollupQuery: unknown dimension is rejected', () => {
  expectInvalid({ groupBy: 'agent,bogus' }, 'groupBy');
});

test('parseRollupQuery: more than 3 dimensions is rejected', () => {
  expectInvalid({ groupBy: 'agent,model,provider,session' }, 'groupBy');
});

test('parseRollupQuery: duplicate dimension is rejected', () => {
  expectInvalid({ groupBy: 'agent,agent' }, 'groupBy');
});

test('parseRollupQuery: repeated groupBy params are flattened with comma-separated values', () => {
  const query = parseRollupQuery({ groupBy: ['agent,model', 'provider'] });
  assert.deepEqual(query.groupBy, ['agent', 'model', 'provider']);
});

test('parseRollupQuery: unknown query parameter is rejected', () => {
  expectInvalid({ groupBy: 'agent', agentid: 'x' }, 'agentid');
});

test('parseRollupQuery: token and api_key are tolerated and ignored', () => {
  const query = parseRollupQuery({ groupBy: 'agent', token: 'abc', api_key: 'def' });
  assert.deepEqual(query.groupBy, ['agent']);
});

test('parseRollupQuery: from >= to is rejected', () => {
  expectInvalid({ groupBy: 'agent', from: '1000', to: '1000' }, 'to');
  expectInvalid({ groupBy: 'agent', from: '2000', to: '1000' }, 'to');
});

test('parseRollupQuery: a date-time with no offset is rejected as ambiguous', () => {
  expectInvalid({ groupBy: 'agent', from: '2026-10-08T03:00:00' }, 'from');
});

test('parseRollupQuery: accepts epoch ms, date-only and offset date-time', () => {
  const a = parseRollupQuery({ groupBy: 'agent', from: '1700000000000' });
  assert.equal(a.filters.from, 1700000000000);
  const b = parseRollupQuery({ groupBy: 'agent', from: '2026-01-01' });
  assert.equal(b.filters.from, Date.parse('2026-01-01T00:00:00.000Z'));
  const c = parseRollupQuery({ groupBy: 'agent', from: '2026-01-01T00:00:00-05:00' });
  assert.equal(c.filters.from, Date.parse('2026-01-01T00:00:00-05:00'));
});

test('parseRollupQuery: utcOffsetMinutes out of range is rejected', () => {
  expectInvalid({ groupBy: 'agent', utcOffsetMinutes: '900' }, 'utcOffsetMinutes');
  expectInvalid({ groupBy: 'agent', utcOffsetMinutes: '-900' }, 'utcOffsetMinutes');
  expectInvalid({ groupBy: 'agent', utcOffsetMinutes: 'abc' }, 'utcOffsetMinutes');
});

test('parseRollupQuery: limit out of range is rejected', () => {
  expectInvalid({ groupBy: 'agent', limit: '0' }, 'limit');
  expectInvalid({ groupBy: 'agent', limit: '10001' }, 'limit');
});

test('parseRollupQuery: asOfSeq must be an integer >= 1', () => {
  expectInvalid({ groupBy: 'agent', asOfSeq: '0' }, 'asOfSeq');
  expectInvalid({ groupBy: 'agent', asOfSeq: 'abc' }, 'asOfSeq');
});

test('parseRollupQuery: more than 100 values in a filter is rejected', () => {
  const many = Array.from({ length: 101 }, (_, i) => `a${i}`);
  expectInvalid({ groupBy: 'agent', agentId: many }, 'agentId');
});

test('parseRollupQuery: unknown status/costSource/currency are rejected', () => {
  expectInvalid({ groupBy: 'agent', status: 'nope' }, 'status');
  expectInvalid({ groupBy: 'agent', costSource: 'nope' }, 'costSource');
  expectInvalid({ groupBy: 'agent', currency: 'nope' }, 'currency');
});

test('parseRollupQuery: defaults match the documented defaults', () => {
  const query = parseRollupQuery({ groupBy: 'agent' });
  assert.equal(query.filters.timeBasis, 'received');
  assert.equal(query.filters.utcOffsetMinutes, 0);
  assert.equal(query.sort, 'key');
  assert.equal(query.limit, 1000);
  assert.equal(query.filters.asOfSeq, null);
});

// -------------------------------------------------------------
// Aggregation rules (section 2), against both stores
// -------------------------------------------------------------

eachStore('rollup: mixed currencies produce two cost entries and no combined figure', async (store) => {
  await seed(store, [
    usageEvent({ payload: { cost: 10, currency: 'USD' } }),
    usageEvent({ payload: { cost: 5, currency: 'EUR' } }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  const entries = result.totals.cost.entries;
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => [e.currency, e.sum]),
    [
      ['EUR', 5],
      ['USD', 10],
    ]
  );
});

eachStore('rollup: provider-reported and estimated in the same currency are separate entries', async (store) => {
  await seed(store, [
    usageEvent({ payload: { cost: 10, currency: 'USD', costSource: 'provider-reported' } }),
    usageEvent({ payload: { cost: 2, currency: 'USD', costSource: 'estimated' } }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  const entries = result.totals.cost.entries;
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => [e.costSource, e.sum]),
    [
      ['provider-reported', 10],
      ['estimated', 2],
    ]
  );
});

eachStore('rollup: a cost with no currency gets its own null-currency entry', async (store) => {
  await seed(store, [
    usageEvent({ payload: { cost: 7, currency: null, costSource: 'provider-reported' } }),
    usageEvent({ payload: { cost: 3, currency: 'USD', costSource: 'provider-reported' } }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  const entries = result.totals.cost.entries;
  assert.equal(entries.length, 2);
  const nullEntry = entries.find((e) => e.currency === null);
  assert.ok(nullEntry);
  assert.equal(nullEntry.sum, 7);
  const usdEntry = entries.find((e) => e.currency === 'USD');
  assert.equal(usdEntry.sum, 3);
});

eachStore('rollup: a reported cost of 0 is a real entry', async (store) => {
  await seed(store, [usageEvent({ payload: { cost: 0, currency: 'USD', costSource: 'provider-reported' } })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  assert.deepEqual(result.totals.cost.entries, [{ currency: 'USD', costSource: 'provider-reported', sum: 0, calls: 1 }]);
  assert.equal(result.totals.cost.unknownCostCalls, 0);
});

eachStore('rollup: a null cost increments unknownCostCalls and creates no entry', async (store) => {
  await seed(store, [
    usageEvent({ payload: { cost: null, currency: null, costSource: 'unknown' } }),
    usageEvent({ payload: { cost: 5, currency: 'USD', costSource: 'provider-reported' } }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  assert.equal(result.totals.cost.unknownCostCalls, 1);
  const totalEntryCalls = result.totals.cost.entries.reduce((sum, e) => sum + e.calls, 0);
  assert.equal(totalEntryCalls + result.totals.cost.unknownCostCalls, result.totals.calls.total);
});

eachStore('rollup: a numeric cost with costSource unknown gets its own entry, never relabeled', async (store) => {
  await seed(store, [usageEvent({ payload: { cost: 4, currency: 'USD', costSource: 'unknown' } })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  assert.deepEqual(result.totals.cost.entries, [{ currency: 'USD', costSource: 'unknown', sum: 4, calls: 1 }]);
});

eachStore('rollup: cost entries are ordered by currency ascending (null last), then cost source order', async (store) => {
  await seed(store, [
    usageEvent({ payload: { cost: 1, currency: 'USD', costSource: 'estimated' } }),
    usageEvent({ payload: { cost: 1, currency: 'USD', costSource: 'provider-reported' } }),
    usageEvent({ payload: { cost: 1, currency: 'EUR', costSource: 'provider-reported' } }),
    usageEvent({ payload: { cost: 1, currency: null, costSource: 'provider-reported' } }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  assert.deepEqual(
    result.totals.cost.entries.map((e) => [e.currency, e.costSource]),
    [
      ['EUR', 'provider-reported'],
      ['USD', 'provider-reported'],
      ['USD', 'estimated'],
      [null, 'provider-reported'],
    ]
  );
});

eachStore('rollup: a token kind nobody reported returns sum null, reportedCalls + unreportedCalls === calls.total', async (store) => {
  await seed(store, [
    usageEvent({ payload: { inputTokens: 10, outputTokens: 5 } }),
    usageEvent({ payload: { inputTokens: 20, outputTokens: 8 } }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  const totals = result.totals.tokens;
  assert.equal(totals.cacheRead.sum, null);
  assert.equal(totals.cacheRead.reportedCalls, 0);
  assert.equal(totals.cacheRead.unreportedCalls, 2);
  assert.equal(totals.input.sum, 30);
  for (const kind of Object.values(totals)) {
    assert.equal(kind.reportedCalls + kind.unreportedCalls, result.totals.calls.total);
  }
});

eachStore('rollup: a reported 0 token count is reported, not unreported', async (store) => {
  await seed(store, [usageEvent({ payload: { cacheReadTokens: 0 } })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  assert.equal(result.totals.tokens.cacheRead.sum, 0);
  assert.equal(result.totals.tokens.cacheRead.reportedCalls, 1);
  assert.equal(result.totals.tokens.cacheRead.unreportedCalls, 0);
});

eachStore('rollup: llm.failed rows count in calls.failed and a status filter selects only those', async (store) => {
  await seed(store, [
    usageEvent({}),
    usageEvent({ type: 'llm.failed', errorKind: 'rate_limited', payload: { cost: null, currency: null } }),
    usageEvent({ type: 'llm.failed', errorKind: 'timeout', payload: { cost: null, currency: null } }),
  ]);
  const all = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  assert.equal(all.totals.calls.total, 3);
  assert.equal(all.totals.calls.succeeded, 1);
  assert.equal(all.totals.calls.failed, 2);

  const filtered = await store.rollup(parseRollupQuery({ groupBy: 'agent', status: 'rate_limited' }));
  assert.equal(filtered.totals.calls.total, 1);
  assert.equal(filtered.totals.calls.failed, 1);
});

eachStore('rollup: timeBasis received vs occurred can land a row in different day buckets', async (store) => {
  const occurredAt = Date.parse('2026-10-01T23:00:00.000Z');
  const receivedAt = Date.parse('2026-10-03T01:00:00.000Z');
  await seed(store, [usageEvent({ timestamp: occurredAt, receivedAt })]);

  const byReceived = await store.rollup(parseRollupQuery({ groupBy: 'day' }));
  const byOccurred = await store.rollup(parseRollupQuery({ groupBy: 'day', timeBasis: 'occurred' }));
  assert.equal(byReceived.groups[0].key.day, '2026-10-03');
  assert.equal(byOccurred.groups[0].key.day, '2026-10-01');
});

eachStore('rollup: utcOffsetMinutes=-300 shifts a row into the previous local day with the documented bucket', async (store) => {
  const receivedAt = Date.parse('2026-10-08T03:00:00.000Z');
  await seed(store, [usageEvent({ receivedAt })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'day', utcOffsetMinutes: '-300' }));
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].key.day, '2026-10-07');
  assert.equal(result.groups[0].bucketStart, Date.parse('2026-10-07T05:00:00.000Z'));
  assert.equal(result.groups[0].bucketEnd, Date.parse('2026-10-07T05:00:00.000Z') + 86_400_000);
});

eachStore('rollup: from is inclusive, to is exclusive', async (store) => {
  await seed(store, [
    usageEvent({ id: 'evt_boundary_at_from', receivedAt: 1000 }),
    usageEvent({ id: 'evt_boundary_at_to', receivedAt: 2000 }),
    usageEvent({ id: 'evt_boundary_inside', receivedAt: 1500 }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', from: '1000', to: '2000' }));
  assert.equal(result.totals.calls.total, 2);
});

eachStore('rollup: null groups are returned, never dropped, and group sums reconcile with totals', async (store) => {
  await seed(store, [usageEvent({ taskId: 'task-1' }), usageEvent({ taskId: undefined }), usageEvent({ taskId: undefined })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'task' }));
  assert.equal(result.groupsAreAdditive, true);
  assert.equal(result.truncated, false);
  const nullGroup = result.groups.find((g) => g.key.task === null);
  assert.ok(nullGroup);
  assert.equal(nullGroup.calls.total, 2);
  const sum = result.groups.reduce((acc, g) => acc + g.calls.total, 0);
  assert.equal(sum, result.totals.calls.total);
});

eachStore('rollup: tag grouping is non-additive; a 2-tag row appears in 2 groups; totals count it once', async (store) => {
  await seed(store, [usageEvent({ payload: { tags: ['a', 'b'] } }), usageEvent({ payload: { tags: [] } })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'tag' }));
  assert.equal(result.groupsAreAdditive, false);
  const tagA = result.groups.find((g) => g.key.tag === 'a');
  const tagB = result.groups.find((g) => g.key.tag === 'b');
  const tagNull = result.groups.find((g) => g.key.tag === null);
  assert.equal(tagA.calls.total, 1);
  assert.equal(tagB.calls.total, 1);
  assert.equal(tagNull.calls.total, 1);
  assert.equal(result.totals.calls.total, 2);
});

eachStore('rollup: a tag filter with two values a row has counts the row once in totals', async (store) => {
  await seed(store, [usageEvent({ payload: { tags: ['a', 'b'] } }), usageEvent({ payload: { tags: ['c'] } })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', tag: ['a', 'b'] }));
  assert.equal(result.totals.calls.total, 1);
});

eachStore('rollup: limit smaller than the group count truncates and totals still cover every row', async (store) => {
  await seed(store, [
    usageEvent({ agentId: 'agent-a' }),
    usageEvent({ agentId: 'agent-b' }),
    usageEvent({ agentId: 'agent-c' }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', limit: '2' }));
  assert.equal(result.truncated, true);
  assert.equal(result.groupCount, 3);
  assert.equal(result.groups.length, 2);
  assert.equal(result.totals.calls.total, 3);
});

eachStore('rollup: sort=calls orders by calls.total descending, key ascending as tie-break', async (store) => {
  await seed(store, [
    usageEvent({ agentId: 'z-agent' }),
    usageEvent({ agentId: 'z-agent' }),
    usageEvent({ agentId: 'a-agent' }),
    usageEvent({ agentId: 'a-agent' }),
    usageEvent({ agentId: 'm-agent' }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', sort: 'calls' }));
  assert.deepEqual(
    result.groups.map((g) => [g.key.agent, g.calls.total]),
    [
      ['a-agent', 2],
      ['z-agent', 2],
      ['m-agent', 1],
    ]
  );
});

eachStore('rollup: sort=key orders ascending by UTF-8 bytes, null last', async (store) => {
  await seed(store, [usageEvent({ agentId: 'b' }), usageEvent({ agentId: 'a' }), usageEvent({ agentId: null })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  assert.deepEqual(
    result.groups.map((g) => g.key.agent),
    ['a', 'b', null]
  );
});

eachStore('rollup: asOfSeq pins the response to rows with seq <= asOfSeq and echoes asOf.ledgerSeq', async (store) => {
  await seed(store, [usageEvent({}), usageEvent({})]);
  const full = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  const firstSeq = full.asOf.ledgerSeq - 1;
  await seed(store, [usageEvent({})]);
  const pinned = await store.rollup(parseRollupQuery({ groupBy: 'agent', asOfSeq: String(firstSeq) }));
  assert.equal(pinned.asOf.ledgerSeq, firstSeq);
  assert.equal(pinned.totals.calls.total, 1);
});

eachStore('rollup: an empty ledger returns the documented empty shape, never zeros dressed as figures', async (store) => {
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  assert.deepEqual(result.groups, []);
  assert.equal(result.groupCount, 0);
  assert.equal(result.totals.calls.total, 0);
  for (const kind of Object.values(result.totals.tokens)) {
    assert.equal(kind.sum, null);
    assert.equal(kind.reportedCalls, 0);
    assert.equal(kind.unreportedCalls, 0);
  }
  assert.deepEqual(result.totals.cost.entries, []);
  assert.equal(result.totals.cost.unknownCostCalls, 0);
  assert.equal(result.totals.firstAt, null);
  assert.equal(result.totals.lastAt, null);
  assert.equal(result.asOf.ledgerSeq, null);
  assert.equal(result.asOf.lastRowReceivedAt, null);
});

eachStore('rollup: exact-match filters never split on commas', async (store) => {
  await seed(store, [usageEvent({ agentId: 'a,b' }), usageEvent({ agentId: 'a' }), usageEvent({ agentId: 'b' })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', agentId: 'a,b' }));
  assert.equal(result.totals.calls.total, 1);
});

eachStore('rollup: provider filter normalizes the same way the ledger write path does', async (store) => {
  await seed(store, [usageEvent({ payload: { provider: '  Anthropic ' } }), usageEvent({ payload: { provider: 'openai' } })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', provider: 'anthropic' }));
  assert.equal(result.totals.calls.total, 1);
});

eachStore('rollup: currency filter "none" matches rows with no currency', async (store) => {
  await seed(store, [
    usageEvent({ payload: { cost: 1, currency: null } }),
    usageEvent({ payload: { cost: 1, currency: 'USD' } }),
  ]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', currency: 'none' }));
  assert.equal(result.totals.calls.total, 1);
});

eachStore('rollup: a query with SQL-special characters in a filter value is treated as data, not SQL', async (store) => {
  const trickyId = "agent'; DROP TABLE usage_ledger; --";
  await seed(store, [usageEvent({ agentId: trickyId }), usageEvent({ agentId: 'safe' })]);
  const result = await store.rollup(parseRollupQuery({ groupBy: 'agent', agentId: trickyId }));
  assert.equal(result.totals.calls.total, 1);
  assert.equal(result.groups[0].key.agent, trickyId);
  // The table must still exist and be queryable (proves the value was bound, never concatenated into SQL).
  const everything = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
  assert.equal(everything.totals.calls.total, 2);
});

// -------------------------------------------------------------
// Memory-mode coverage (issue #53 applied to the ledger)
// -------------------------------------------------------------

test('rollup: memory-mode cap sets coverage.complete false and droppedRows > 0 once reached', async () => {
  const store = new MemoryEventStore({ maxEvents: 1000, usageLedgerMaxRows: 2 });
  await store.init();
  try {
    await seed(store, [usageEvent({}), usageEvent({}), usageEvent({})]);
    const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
    assert.equal(result.coverage.complete, false);
    assert.ok(result.coverage.droppedRows > 0);
  } finally {
    await store.close();
  }
});

test('rollup: a fresh memory store under its cap reports coverage.complete true', async () => {
  const store = new MemoryEventStore({ maxEvents: 1000, usageLedgerMaxRows: 1000 });
  await store.init();
  try {
    await seed(store, [usageEvent({})]);
    const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.droppedRows, 0);
  } finally {
    await store.close();
  }
});

// -------------------------------------------------------------
// Retention coverage (issue #70): a range reaching a purged cutoff must report coverage.complete false, in both
// storage modes, independently of the memory-mode cap above.
// -------------------------------------------------------------

test('rollup: a query range reaching a retention purge reports coverage.complete false (memory)', async () => {
  const store = new MemoryEventStore({ maxEvents: 1000, usageLedgerMaxRows: 1000 });
  await store.init();
  try {
    await seed(store, [usageEvent({ receivedAt: 1_000 }), usageEvent({ receivedAt: 5_000 })]);
    await store.purge({ ledgerCutoffMs: 2_000 });

    const unbounded = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
    assert.equal(unbounded.coverage.complete, false);
    assert.equal(unbounded.coverage.purgedThrough, 2_000);

    const reachesCutoff = await store.rollup(parseRollupQuery({ groupBy: 'agent', from: '1970-01-01T00:00:01.000Z' }));
    assert.equal(reachesCutoff.coverage.complete, false);

    const afterCutoff = await store.rollup(parseRollupQuery({ groupBy: 'agent', from: '1970-01-01T00:00:03.000Z' }));
    assert.equal(afterCutoff.coverage.complete, true);
    assert.equal(afterCutoff.coverage.purgedThrough, 2_000);
  } finally {
    await store.close();
  }
});

test('rollup: a query range reaching a retention purge reports coverage.complete false (sqlite)', async () => {
  const { dir, file } = tempDbPath('rollup-purge');
  const store = new SQLiteEventStore(file, { backup: 'off' });
  await store.init();
  try {
    await seed(store, [usageEvent({ receivedAt: 1_000 }), usageEvent({ receivedAt: 5_000 })]);
    await store.purge({ ledgerCutoffMs: 2_000 });

    const unbounded = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
    assert.equal(unbounded.coverage.complete, false);
    assert.equal(unbounded.coverage.purgedThrough, 2_000);

    const reachesCutoff = await store.rollup(parseRollupQuery({ groupBy: 'agent', from: '1970-01-01T00:00:01.000Z' }));
    assert.equal(reachesCutoff.coverage.complete, false);

    const afterCutoff = await store.rollup(parseRollupQuery({ groupBy: 'agent', from: '1970-01-01T00:00:03.000Z' }));
    assert.equal(afterCutoff.coverage.complete, true);
    assert.equal(afterCutoff.coverage.purgedThrough, 2_000);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rollup: no retention run yet reports coverage.purgedThrough null in both stores', async () => {
  const memory = new MemoryEventStore({ maxEvents: 1000, usageLedgerMaxRows: 1000 });
  await memory.init();
  const { dir, file } = tempDbPath('rollup-no-purge');
  const sqlite = new SQLiteEventStore(file, { backup: 'off' });
  await sqlite.init();
  try {
    for (const store of [memory, sqlite]) {
      await seed(store, [usageEvent({})]);
      const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
      assert.equal(result.coverage.purgedThrough, null);
      assert.equal(result.coverage.complete, true);
    }
  } finally {
    await memory.close();
    await sqlite.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Provenance (coverage.backfilledRows / legacyContractRows), SQLite only: these origins never occur on the live
// memory-store append path, so they are only reachable by writing the ledger row directly, the same way
// tests/usage-ledger-backfill.test.mjs exercises the backfill.
// -------------------------------------------------------------

test('rollup: coverage counts backfilled and legacy-contract rows (sqlite)', async () => {
  const { dir, file } = tempDbPath('rollup-provenance');
  const store = new SQLiteEventStore(file, { backup: 'off' });
  await store.init();
  try {
    await seed(store, [usageEvent({}), usageEvent({})]);

    // The live append path can only ever write origin='live', legacy_contract=0 rows. A backfilled, legacy row is
    // only reachable the way the real migration backfill produces one (tests/usage-ledger-backfill.test.mjs does
    // the same): write it directly, through a second connection to the same file, then close it before the store
    // reads again (SQLite's WAL mode makes the commit visible to the store's own connection right away).
    const direct = new DatabaseSync(file);
    direct.exec('PRAGMA busy_timeout = 5000');
    direct
      .prepare(
        `INSERT INTO usage_ledger (
          event_id, event_type, request_id, received_at, occurred_at, origin, legacy_contract, ingest_channel,
          cost, cost_source, status
        ) VALUES ('evt_direct_backfill', 'llm.usage', NULL, 1700000000000, 1700000000000, 'backfill', 1, 'unknown', NULL, 'unknown', 'ok')`
      )
      .run();
    direct.close();

    const result = await store.rollup(parseRollupQuery({ groupBy: 'agent' }));
    assert.equal(result.totals.calls.total, 3);
    assert.equal(result.coverage.backfilledRows, 1);
    assert.equal(result.coverage.legacyContractRows, 1);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Memory vs SQLite parity
// -------------------------------------------------------------

test('rollup: memory and sqlite stores return identical JSON for the same fixture', async () => {
  const events = [];
  for (let i = 0; i < 40; i++) {
    events.push(
      usageEvent({
        agentId: `agent-${i % 5}`,
        payload: {
          model: `model-${i % 3}`,
          provider: i % 2 === 0 ? 'anthropic' : 'openai',
          cost: (i % 7) + (i % 3) * 0.123456,
          currency: i % 4 === 0 ? null : i % 2 === 0 ? 'USD' : 'EUR',
          costSource: i % 3 === 0 ? 'estimated' : 'provider-reported',
          tags: i % 5 === 0 ? ['alpha', 'beta'] : i % 5 === 1 ? ['beta'] : [],
          cacheReadTokens: i % 6 === 0 ? null : i,
        },
        receivedAt: 1_700_000_000_000 + i * 60_000,
        type: i % 11 === 0 ? 'llm.failed' : 'llm.usage',
        errorKind: i % 11 === 0 ? 'timeout' : undefined,
      })
    );
  }

  const memory = new MemoryEventStore(100_000);
  await memory.init();
  const { dir, file } = tempDbPath('rollup-parity');
  const sqlite = new SQLiteEventStore(file, { backup: 'off' });
  await sqlite.init();

  try {
    await seed(memory, events);
    await seed(sqlite, events);

    for (const groupBy of ['agent', 'model,provider', 'day,tag', 'agent,model,provider']) {
      const query = parseRollupQuery({ groupBy, sort: 'calls' });
      const memResult = await memory.rollup(query);
      const sqlResult = await sqlite.rollup(query);
      const normalize = (r) => {
        const clone = JSON.parse(JSON.stringify(r));
        clone.coverage.storage = 'x';
        clone.asOf.generatedAt = 0;
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

// -------------------------------------------------------------
// Property-style test: a seeded random ledger reconciles group sums with totals for any non-tag groupBy.
// -------------------------------------------------------------

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('rollup: property - group sums reconcile with totals for any non-tag groupBy (seeded random ledger)', async () => {
  const rand = mulberry32(42);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const agents = ['a1', 'a2', 'a3', null];
  const models = ['m1', 'm2'];
  const providers = ['anthropic', 'openai'];
  const currencies = ['USD', 'EUR', null];
  const costSources = ['provider-reported', 'estimated', 'unknown'];

  const events = [];
  for (let i = 0; i < 300; i++) {
    const cost = rand() < 0.15 ? null : Math.round(rand() * 1000) / 100;
    const currency = cost === null ? null : pick(currencies);
    const costSource = cost === null ? 'unknown' : pick(costSources);
    const agentPick = pick(agents);
    events.push(
      usageEvent({
        agentId: agentPick === null ? null : agentPick,
        payload: {
          model: pick(models),
          provider: pick(providers),
          cost,
          currency,
          costSource,
          // inputTokens/outputTokens are required by the live contract (never "unreported" on a real row); only
          // the #46 fields (cache read/write, reasoning) can be genuinely unreported, so that is what gets
          // randomized away here. Capped below the fixture's fixed inputTokens=100 (cache tokens cannot exceed it).
          cacheReadTokens: rand() < 0.3 ? undefined : Math.floor(rand() * 80),
        },
        receivedAt: 1_700_000_000_000 + i * 1000,
      })
    );
  }

  const store = new MemoryEventStore(100_000);
  await store.init();
  try {
    await seed(store, events);
    for (const groupBy of ['agent', 'model', 'provider', 'agent,model', 'model,provider']) {
      const result = await store.rollup(parseRollupQuery({ groupBy, limit: '10000' }));
      assert.equal(result.truncated, false);
      assert.equal(result.groupsAreAdditive, true);

      const callsSum = result.groups.reduce((acc, g) => acc + g.calls.total, 0);
      assert.equal(callsSum, result.totals.calls.total);

      const byEntryKey = new Map();
      for (const group of result.groups) {
        for (const entry of group.cost.entries) {
          const key = `${entry.currency}|${entry.costSource}`;
          byEntryKey.set(key, (byEntryKey.get(key) ?? 0) + entry.sum);
        }
      }
      for (const entry of result.totals.cost.entries) {
        const key = `${entry.currency}|${entry.costSource}`;
        const groupSum = Math.round((byEntryKey.get(key) ?? 0) * 1e9) / 1e9;
        assert.equal(groupSum, entry.sum, `cost entry ${key} mismatch for groupBy=${groupBy}`);
      }

      for (const kind of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
        let reported = 0;
        for (const group of result.groups) reported += group.tokens[kind].reportedCalls;
        assert.equal(reported, result.totals.tokens[kind].reportedCalls, `${kind} reportedCalls mismatch for groupBy=${groupBy}`);
        assert.equal(
          result.totals.tokens[kind].reportedCalls + result.totals.tokens[kind].unreportedCalls,
          result.totals.calls.total
        );
      }
    }
  } finally {
    await store.close();
  }
});
