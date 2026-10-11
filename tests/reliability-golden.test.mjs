// Issue #89's own "Golden reconciliation (#62 suite)" line: "add a fixture whose expected p50, p95 and failure
// rate are computed by hand and committed as JSON". This follows the exact pattern already established by the
// #62 golden reconciliation suite (tests/reconciliation.test.mjs, tests/fixtures/reconciliation/): one hand-worked
// event log, one committed `golden.expected.json` with hand arithmetic written down, and a test that feeds the raw
// events through the real event stores (never re-deriving the numbers from the implementation under test) and
// asserts a byte-for-byte match. Scoped to the reliability rollup (`include=latency,failures`) rather than tokens
// and cost, which the #62 fixture already covers on its own.
//
// See tests/fixtures/reliability-golden/README.md for the fixture's own per-line rationale and hand arithmetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryEventStore, SQLiteEventStore } from '../server/store.ts';
import { parseEventLog } from '../src/integrations/eventLogParser.ts';
import { parseRollupQuery } from '../server/usage/rollup.ts';

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures', 'reliability-golden');
const LINE_KEYS = Array.from({ length: 18 }, (_, i) => `L${i + 1}`);

function loadGolden() {
  const eventsRaw = fs.readFileSync(path.join(FIXTURE_DIR, 'golden.events.jsonl'), 'utf8');
  const events = eventsRaw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'golden.expected.json'), 'utf8'));
  return { events, eventsRaw, expected };
}

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-reliability-golden-'));
  return { dir, file: path.join(dir, `${name}.db`) };
}

/** Maps one `AppendResult` to the vocabulary `golden.expected.json#ingestion` uses: a request-id duplicate
 * (issue #48) is told apart from a plain id resend, same as `tests/reconciliation.test.mjs`'s own `outcomeLabel`. */
function outcomeLabel(result) {
  if (result.outcome === 'duplicate' && result.duplicateReason === 'request_id') return 'request-duplicate';
  return result.outcome;
}

async function appendAll(store, events) {
  const outcomes = {};
  for (let i = 0; i < events.length; i++) {
    const result = await store.append(events[i]);
    outcomes[LINE_KEYS[i]] = outcomeLabel(result);
  }
  return outcomes;
}

/** Only the fields this fixture actually hand-verifies (issue #89's figures): calls, failedCalls, attempts,
 * failureRate, failures and latency. Token/cost accounting is already covered, independently, by the #62 golden
 * fixture; re-asserting it here would duplicate that suite rather than this issue's own scope. */
function pickReliability(totalsOrGroup) {
  return {
    calls: totalsOrGroup.calls,
    failedCalls: totalsOrGroup.failedCalls,
    attempts: totalsOrGroup.attempts,
    failureRate: totalsOrGroup.failureRate,
    failures: totalsOrGroup.failures,
    latency: totalsOrGroup.latency,
  };
}

function rollupView(response) {
  return {
    groups: [...response.groups]
      .sort((a, b) => (a.key.model ?? '￿').localeCompare(b.key.model ?? '￿'))
      .map((g) => ({ model: g.key.model, ...pickReliability(g) })),
    totals: pickReliability(response.totals),
  };
}

/** Independent reimplementation of nearest-rank (issue #89, rule 4), never importing `server/usage/reliability.ts`:
 * if this ever disagreed with the golden file's own hand arithmetic, that would mean the fixture's expected values
 * are wrong, not that the implementation is. Mirrors `reference.ts`'s role in the #62 suite. */
function referenceNearestRank(samples, p) {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

test('golden.events.jsonl parses as a complete, valid canonical V1 event log (0 issues, 18 events)', async () => {
  const { eventsRaw, events } = loadGolden();
  const result = await parseEventLog(eventsRaw);
  assert.deepStrictEqual(result.issues, []);
  assert.strictEqual(result.events.length, 18);
  assert.strictEqual(events.length, 18, 'golden.events.jsonl must have 18 lines, in file order');
});

test('independent reference: nearest-rank over the hand-written sample sets matches golden.expected.json', () => {
  const { expected } = loadGolden();
  // Hand-written raw sample sets (README.md's "Hand arithmetic" section), kept here only as plain numbers so this
  // check never imports the module under test.
  const modelFastSamples = [100, 120, 110, 130, 90, 1000];
  const modelSteadySamples = [200, 200, 200, 200, 200];
  const pooledSamples = [...modelFastSamples, ...modelSteadySamples];

  const fastGroup = expected.rollup.groups.find((g) => g.model === 'model-fast');
  assert.equal(referenceNearestRank(modelFastSamples, 0.5), fastGroup.latency.p50Ms);
  assert.equal(referenceNearestRank(modelFastSamples, 0.95), fastGroup.latency.p95Ms);

  const steadyGroup = expected.rollup.groups.find((g) => g.model === 'model-steady');
  assert.equal(referenceNearestRank(modelSteadySamples, 0.5), steadyGroup.latency.p50Ms);
  assert.equal(referenceNearestRank(modelSteadySamples, 0.95), steadyGroup.latency.p95Ms);

  assert.equal(referenceNearestRank(pooledSamples, 0.5), expected.rollup.totals.latency.p50Ms);
  assert.equal(referenceNearestRank(pooledSamples, 0.95), expected.rollup.totals.latency.p95Ms);
});

test('memory store: every fixture line resolves to the expected outcome, and include=latency,failures matches the golden figures', async () => {
  const { events, expected } = loadGolden();
  const store = new MemoryEventStore();
  await store.init();
  try {
    const outcomes = await appendAll(store, events);
    assert.deepStrictEqual(outcomes, expected.ingestion, 'memory: ingestion outcomes of lines L1-L18');

    const result = await store.rollup(parseRollupQuery({ groupBy: 'model', sort: 'calls', include: 'latency,failures' }));
    assert.deepStrictEqual(rollupView(result), expected.rollup, 'memory: reliability rollup must equal golden.expected.json#rollup');
  } finally {
    await store.close();
  }
});

test('sqlite store, across a restart: ingestion outcomes and the reliability rollup match the golden figures', async () => {
  const { events, expected } = loadGolden();
  const { dir, file } = tempDbPath('reliability-golden');
  try {
    let store = new SQLiteEventStore(file, { backup: 'off' });
    await store.init();
    const outcomes = await appendAll(store, events);
    assert.deepStrictEqual(outcomes, expected.ingestion, 'sqlite: ingestion outcomes of lines L1-L18');
    await store.close();

    // Reopen before reading anything back: asserts what the startup rebuild produces, not in-process live state.
    store = new SQLiteEventStore(file, { backup: 'off' });
    await store.init();
    const result = await store.rollup(parseRollupQuery({ groupBy: 'model', sort: 'calls', include: 'latency,failures' }));
    assert.deepStrictEqual(rollupView(result), expected.rollup, 'sqlite (after restart): reliability rollup must equal golden.expected.json#rollup');
    await store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory and sqlite reach byte-identical reliability figures from the same fixture, independently of the frozen golden file', async () => {
  const { events } = loadGolden();

  const memory = new MemoryEventStore();
  await memory.init();
  await appendAll(memory, events);
  const memoryResult = await memory.rollup(parseRollupQuery({ groupBy: 'model', sort: 'calls', include: 'latency,failures' }));
  await memory.close();

  const { dir, file } = tempDbPath('reliability-golden-cross');
  try {
    const sqlite = new SQLiteEventStore(file, { backup: 'off' });
    await sqlite.init();
    await appendAll(sqlite, events);
    const sqliteResult = await sqlite.rollup(parseRollupQuery({ groupBy: 'model', sort: 'calls', include: 'latency,failures' }));
    await sqlite.close();

    assert.deepStrictEqual(rollupView(memoryResult), rollupView(sqliteResult));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
