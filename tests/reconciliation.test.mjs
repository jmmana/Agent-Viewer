// Issue #62: the golden reconciliation suite. One hand-checked fixture (tests/fixtures/reconciliation/), run
// through the memory store, the SQLite store across a restart, the portal reducer and the embeddable library's
// summarizeUsage, asserting every path reaches the same figures. See tests/fixtures/reconciliation/README.md
// for the fixture's own per-line rationale, and this file's final comment for what issue #62 described that is
// deliberately NOT covered here (the HTTP routes, webhook retries over real HMAC signatures, the PATCH rejection
// route and memory eviction): each is called out at the point it would have applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryEventStore, SQLiteEventStore } from '../server/store.ts';
import { parseEventLog } from '../src/integrations/eventLogParser.ts';
import { createLiveSimulationState } from '../src/engine/officeState.ts';
import { applyExternalEvent } from '../src/integrations/eventIngestion.ts';
import { summarizeUsage } from '../src/lib/usage.ts';
import { loadGolden } from './reconciliation/golden.ts';
import {
  fromPortalTally,
  toReconciliationView,
  deriveOfficeUsage,
  normalizeOfficeUsage,
} from './reconciliation/adapters.ts';
import { diffReconciliationView } from './reconciliation/view.ts';
import { reference } from './reconciliation/reference.ts';

const LINE_KEYS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11'];

/** Maps one `AppendResult` to the vocabulary `golden.expected.json#ingestion` uses: a request-id duplicate is
 * told apart from a plain id resend, because both must be asserted separately (issue #48). */
function outcomeLabel(result) {
  if (result.outcome === 'duplicate' && result.duplicateReason === 'request_id') return 'request-duplicate';
  return result.outcome;
}

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-golden-'));
  return { dir, file: path.join(dir, `${name}.db`) };
}

/** Appends the 11 fixture lines plus one webhook delivery and its retry, in file order, to any `EventStore`.
 * Returns the outcome of every one, keyed the same way as `golden.expected.json#ingestion`. */
async function appendAll(store, { events, webhookCanonical }) {
  const outcomes = {};
  for (let i = 0; i < events.length; i++) {
    const result = await store.append(events[i]);
    outcomes[LINE_KEYS[i]] = outcomeLabel(result);
  }
  outcomes.W1 = outcomeLabel(await store.append(webhookCanonical));
  outcomes['W1-retry'] = outcomeLabel(await store.append(webhookCanonical));
  return outcomes;
}

function runPortal(events) {
  const state = createLiveSimulationState();
  for (const event of events) applyExternalEvent(state, event, { now: 0, trackUsage: true, narrate: false });
  return state;
}

function portalView(state) {
  const byAgent = {};
  for (const agent of state.agents) {
    if (agent.usage) byAgent[agent.id] = fromPortalTally(agent.usage);
  }
  return { total: fromPortalTally(state.usage), byAgent };
}

test('golden.events.jsonl parses as a complete, valid canonical V1 event log (0 issues, 11 events)', async () => {
  const { events } = loadGolden();
  const content = fs.readFileSync(
    path.join(import.meta.dirname, 'fixtures', 'reconciliation', 'golden.events.jsonl'),
    'utf8'
  );
  const result = await parseEventLog(content);
  assert.deepStrictEqual(result.issues, []);
  assert.strictEqual(result.events.length, 11);
  assert.strictEqual(events.length, 11, 'golden.ts must load the same 11 lines, in file order');
});

test('memory store: every fixture line resolves to the expected outcome, and the final usage summary matches the golden file', async () => {
  const { events, webhookCanonical, expected } = loadGolden();
  const store = new MemoryEventStore();
  const outcomes = await appendAll(store, { events, webhookCanonical });
  assert.deepStrictEqual(outcomes, expected.ingestion, 'memory: ingestion outcomes of lines 1-11, W1 and its retry');

  const snapshot = await store.snapshot();
  assert.deepStrictEqual(snapshot.usage, expected.server.final, 'memory: snapshot().usage must equal golden.expected.json#server.final');
});

test('sqlite-restart: checkpoint after lines 1-6 and the webhook event, full history after a restart, and an idle reopen never double counts', async () => {
  const { events, webhookCanonical, expected } = loadGolden();
  const { dir, file } = tempDbPath('golden-restart');
  const outcomes = {};

  try {
    // Phase A: lines 1-6 and the webhook event, then close and reopen before reading anything back, so this
    // asserts what issue #52's startup rebuild produces, not what the live in-process state happened to hold.
    let store = new SQLiteEventStore(file, { backup: 'off' });
    await store.init();
    for (let i = 0; i < 6; i++) outcomes[LINE_KEYS[i]] = outcomeLabel(await store.append(events[i]));
    outcomes.W1 = outcomeLabel(await store.append(webhookCanonical));
    await store.close();

    store = new SQLiteEventStore(file, { backup: 'off' });
    await store.init();
    let snapshot = await store.snapshot();
    assert.deepStrictEqual(
      snapshot.usage,
      expected.server.checkpointAfterLine6,
      'sqlite: usage after reopening with only lines 1-6 and the webhook event stored'
    );

    // Phase B: the duplicates, the conflict, the request-id duplicates, the failure and the webhook retry. Proves
    // dedup and request-id state survive a restart (issue #48, finalized by #53), not just plain totals.
    for (let i = 6; i < 11; i++) outcomes[LINE_KEYS[i]] = outcomeLabel(await store.append(events[i]));
    outcomes['W1-retry'] = outcomeLabel(await store.append(webhookCanonical));
    assert.deepStrictEqual(outcomes, expected.ingestion, 'sqlite: ingestion outcomes across the restart boundary');
    await store.close();

    store = new SQLiteEventStore(file, { backup: 'off' });
    await store.init();
    snapshot = await store.snapshot();
    assert.deepStrictEqual(snapshot.usage, expected.server.final, 'sqlite: usage after reopening with the full history stored');
    await store.close();

    // A third open with no writes: the rebuild must read the same stored rows again and reach the same figures,
    // never re-applying anything twice.
    store = new SQLiteEventStore(file, { backup: 'off' });
    await store.init();
    snapshot = await store.snapshot();
    assert.deepStrictEqual(snapshot.usage, expected.server.final, 'sqlite: usage unchanged after an idle reopen (no rebuild double count)');
    await store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory and sqlite reach byte-identical usage summaries from the same fixture, independently of the frozen golden file', async () => {
  const { events, webhookCanonical } = loadGolden();

  const memory = new MemoryEventStore();
  await appendAll(memory, { events, webhookCanonical });
  const memorySnapshot = await memory.snapshot();

  const { dir, file } = tempDbPath('golden-cross');
  try {
    const sqlite = new SQLiteEventStore(file, { backup: 'off' });
    await sqlite.init();
    await appendAll(sqlite, { events, webhookCanonical });
    const sqliteSnapshot = await sqlite.snapshot();
    await sqlite.close();

    assert.deepStrictEqual(sqliteSnapshot.usage, memorySnapshot.usage);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('portal reducer: applyExternalEvent over the accepted stream matches the golden figures, delivered once or twice (SSE reconnect replay)', () => {
  const { accepted, expected } = loadGolden();
  const expectedTotal = fromPortalTally(expected.portal.total);
  const expectedByAgent = Object.fromEntries(
    Object.entries(expected.portal.byAgent).map(([agentId, tally]) => [agentId, fromPortalTally(tally)])
  );

  for (const [label, events] of [
    ['delivered once', accepted],
    ['delivered twice (duplicate id, must not double count)', [...accepted, ...accepted]],
  ]) {
    const state = runPortal(events);
    const view = portalView(state);
    const problems = diffReconciliationView(view, { total: expectedTotal, byAgent: expectedByAgent }, `portal (${label})`);
    assert.deepStrictEqual(problems, []);
  }
});

test('library: summarizeUsage over the accepted stream matches the golden figures, delivered once or twice', () => {
  const { accepted, expected } = loadGolden();
  for (const [label, events] of [
    ['delivered once', accepted],
    ['delivered twice (dedup by id)', [...accepted, ...accepted]],
  ]) {
    const actual = normalizeOfficeUsage(summarizeUsage(events));
    const want = normalizeOfficeUsage(expected.library);
    assert.deepStrictEqual(actual, want, `library (${label})`);
  }
});

test('library figures are exactly what the documented display rule derives from the server totals (expected.library cannot drift from expected.server.final)', () => {
  const { expected } = loadGolden();
  const serverView = toReconciliationView(expected.server.final);
  const derived = normalizeOfficeUsage(deriveOfficeUsage(serverView));
  const want = normalizeOfficeUsage(expected.library);
  assert.deepStrictEqual(derived, want);
});

test('independent reference reducer agrees with the hand-worked golden figures (catches a fixture/expected-file mismatch)', () => {
  const { accepted, expected } = loadGolden();
  const ref = reference(accepted);
  const serverView = toReconciliationView(expected.server.final);
  const problems = diffReconciliationView(ref, serverView, 'reference oracle vs golden.expected.json#server.final');
  assert.deepStrictEqual(problems, []);
});

test('cross-path reconciliation: memory, sqlite and the portal agree on every figure they all track', async () => {
  const { events, webhookCanonical, accepted } = loadGolden();

  const memory = new MemoryEventStore();
  await appendAll(memory, { events, webhookCanonical });
  const memoryView = toReconciliationView((await memory.snapshot()).usage);

  const { dir, file } = tempDbPath('golden-cross-reconciliation');
  let sqliteView;
  try {
    const sqlite = new SQLiteEventStore(file, { backup: 'off' });
    await sqlite.init();
    await appendAll(sqlite, { events, webhookCanonical });
    sqliteView = toReconciliationView((await sqlite.snapshot()).usage);
    await sqlite.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const portal = portalView(runPortal(accepted));

  const problems = [
    ...diffReconciliationView(memoryView, sqliteView, 'memory vs sqlite'),
    // The portal never counts failed calls or a per-model breakdown (see view.ts's module comment); comparing
    // against it only checks the fields it actually declares (ScopeUsage.failed stays null there on purpose).
    ...diffReconciliationView(memoryView, portal, 'memory vs portal (fields the portal tracks)'),
  ];
  assert.deepStrictEqual(problems, []);
});

// Not covered by this suite, and why: issue #62 also asked for a `memory-evicting` run (MemoryEventStore with a
// small retained window), an `http` run through the real Express app plus webhook HMAC signing and a PATCH
// rejection, a separate `http-signed` process, and a Vitest `library-privacy` suite for <AgentOffice>. This PR
// ships the fixture plus the four reconciliation paths the issue names as the core guarantee (memory, SQLite
// across a restart, the portal reducer and the library), all green and enforced in CI. The rest is deferred to a
// follow-up: the dependencies this item needs (#47, #48, #49, #50, #52, #53, #55, #56) are all already on main,
// so nothing here is blocked on anything; it is a scope cut, not a missing dependency. See the PR description.
