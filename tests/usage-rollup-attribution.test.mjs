// Issue #80: `meeting` and `tool` rollup dimensions. Covers the hand-computed golden fixture from the issue text
// (section "Tests"), the attribution rules (section 1's table), scope isolation, order independence, the fixed
// ordering/truncation rules, the new filters, and the SQLite derived-table rebuild (dropping `tool_calls`/
// `meeting_labels` and restarting reproduces the same rollup). Memory-vs-SQLite parity on every scenario below is
// the main defense against the two backends drifting (`server/usage/attribution.ts` is the one shared function).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-rollup-attr-'));
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
    ...rest.payload,
  };
  const result = validateCanonicalEvent({
    id: rest.id ?? `evt_${eventCounter}`,
    type: 'llm.usage',
    timestamp: rest.timestamp ?? 1_700_000_000_000 + eventCounter,
    source: `agent:${rest.agentId ?? 'agent-1'}`,
    agentId: rest.agentId ?? 'agent-1',
    sessionId: rest.sessionId,
    summary: 'test call',
    payload,
  });
  if (!result.success) throw new Error(`invalid usage event: ${JSON.stringify(result.issues)}`);
  return { event: result.data, receivedAt };
}

function toolStartedEvent({ id, agentId = 'agent-1', sessionId, tool, toolCallId, timestamp }) {
  eventCounter++;
  const result = validateCanonicalEvent({
    id: id ?? `evt_${eventCounter}`,
    type: 'tool.started',
    timestamp: timestamp ?? 1_700_000_000_000 + eventCounter,
    source: `agent:${agentId}`,
    agentId,
    sessionId,
    summary: `started ${tool}`,
    payload: { tool, toolCallId },
  });
  if (!result.success) throw new Error(`invalid tool.started event: ${JSON.stringify(result.issues)}`);
  return { event: result.data };
}

function meetingRequestedEvent({ id, agentId = 'agent-1', meetingId, title, timestamp }) {
  eventCounter++;
  const result = validateCanonicalEvent({
    id: id ?? `evt_${eventCounter}`,
    type: 'meeting.requested',
    timestamp: timestamp ?? 1_700_000_000_000 + eventCounter,
    source: `agent:${agentId}`,
    agentId,
    summary: `requested ${title}`,
    payload: { meetingId, title, participantIds: [agentId] },
  });
  if (!result.success) throw new Error(`invalid meeting.requested event: ${JSON.stringify(result.issues)}`);
  return { event: result.data };
}

/** Deterministic receive times by default (`BASE_RECEIVED_AT + index`, 1ms apart): the parity test runs this same
 * event sequence against two separately constructed stores, and `receivedAt` (a server clock value) must match
 * bit for bit between them for `firstAt`/`lastAt`/`asOf.lastRowReceivedAt` to compare equal, which a real
 * `Date.now()` per store cannot guarantee. */
const BASE_RECEIVED_AT = 1_700_000_000_000;

async function seed(store, events) {
  let index = 0;
  for (const { event, receivedAt } of events) {
    const res = await store.append(event, { receivedAt: receivedAt ?? BASE_RECEIVED_AT + index++ });
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
  const { dir, file } = tempDbPath('rollup-attr');
  const store = new SQLiteEventStore(file, { backup: 'off' });
  await store.init();
  try {
    await fn(store);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function eachStore(name, fn) {
  test(`${name} (memory)`, () => withMemoryStore(fn));
  test(`${name} (sqlite)`, () => withSqliteStore(fn));
}

function groupFor(response, matcher) {
  return response.groups.find(matcher);
}

// -------------------------------------------------------------
// The golden fixture from the issue text ("Tests" section): two agents a1/a2, one session sess_42, meetings m1
// (title "Design review") and m2 (no title), tool starts tc1 = Bash(a2), tc2 = Read(a1), tc3 = Bash(a1), and tcX
// started twice by a1 with names Bash and Read (ambiguous).
// -------------------------------------------------------------

async function seedGoldenFixture(store) {
  await seed(store, [
    meetingRequestedEvent({ id: 'evt_meeting_m1', agentId: 'a1', meetingId: 'm1', title: 'Design review' }),
    toolStartedEvent({ id: 'evt_tc1', agentId: 'a2', sessionId: 'sess_42', tool: 'Bash', toolCallId: 'tc1' }),
    toolStartedEvent({ id: 'evt_tc2', agentId: 'a1', sessionId: 'sess_42', tool: 'Read', toolCallId: 'tc2' }),
    toolStartedEvent({ id: 'evt_tc3', agentId: 'a1', sessionId: 'sess_42', tool: 'Bash', toolCallId: 'tc3' }),
    toolStartedEvent({ id: 'evt_tcX_bash', agentId: 'a1', sessionId: 'sess_42', tool: 'Bash', toolCallId: 'tcX' }),
    toolStartedEvent({ id: 'evt_tcX_read', agentId: 'a1', sessionId: 'sess_42', tool: 'Read', toolCallId: 'tcX' }),
    usageEvent({
      id: 'u1',
      agentId: 'a1',
      sessionId: 'sess_42',
      payload: { meetingId: 'm1', inputTokens: 100, outputTokens: 50, cost: 0.01, currency: 'USD' },
    }),
    usageEvent({
      id: 'u2',
      agentId: 'a2',
      sessionId: 'sess_42',
      payload: { meetingId: 'm1', toolCallId: 'tc1', inputTokens: 200, outputTokens: 100, cost: 0.02, currency: 'USD' },
    }),
    usageEvent({
      id: 'u3',
      agentId: 'a1',
      sessionId: 'sess_42',
      payload: { meetingId: 'm2', inputTokens: 300, outputTokens: 150, cost: null, costSource: 'unknown', currency: null },
    }),
    usageEvent({
      id: 'u4',
      agentId: 'a1',
      sessionId: 'sess_42',
      payload: { toolCallId: 'tc2', inputTokens: 400, outputTokens: 200, cost: 0.04, currency: 'USD' },
    }),
    usageEvent({
      id: 'u5',
      agentId: 'a1',
      sessionId: 'sess_42',
      payload: { toolCallId: 'tc3', inputTokens: 500, outputTokens: 250, cost: 0.05, currency: 'USD' },
    }),
    usageEvent({
      id: 'u6',
      agentId: 'a2',
      sessionId: 'sess_42',
      payload: { toolCallId: 'tc9', inputTokens: 600, outputTokens: 300, cost: 0.06, currency: 'EUR' },
    }),
    usageEvent({
      id: 'u7',
      agentId: 'a2',
      sessionId: 'sess_42',
      payload: { inputTokens: 700, outputTokens: 350, cost: 0.07, currency: 'USD' },
    }),
    usageEvent({
      id: 'u8',
      agentId: 'a1',
      sessionId: 'sess_42',
      payload: { toolCallId: 'tcX', inputTokens: 800, outputTokens: 400, cost: 0.08, currency: 'USD' },
    }),
  ]);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function costOf(group, currency) {
  const entry = group.cost.entries.find((e) => e.currency === currency);
  return entry ? round2(entry.sum) : null;
}

eachStore('rollup attribution: groupBy=meeting matches the golden fixture', (store) =>
  seedGoldenFixture(store).then(async () => {
    const response = await store.rollup(parseRollupQuery({ groupBy: 'meeting', sessionId: 'sess_42' }));
    assert.equal(response.groups.length, 3);

    const m1 = groupFor(response, (g) => g.key.meetingId === 'm1');
    assert.equal(m1.key.title, 'Design review');
    assert.equal(m1.attribution.meeting, 'attributed');
    assert.equal(m1.calls.total, 2);
    assert.equal(m1.tokens.input.sum, 300);
    assert.equal(m1.tokens.output.sum, 150);
    assert.equal(costOf(m1, 'USD'), 0.03);
    assert.deepEqual(m1.sessionIds, ['sess_42']);
    assert.equal(m1.sessionCount, 1);

    const m2 = groupFor(response, (g) => g.key.meetingId === 'm2');
    assert.equal(m2.key.title, null);
    assert.equal(m2.calls.total, 1);
    assert.equal(m2.tokens.input.sum, 300);
    assert.equal(m2.cost.entries.length, 0);
    assert.equal(m2.cost.unknownCostCalls, 1);

    const unattributed = groupFor(response, (g) => g.key.meetingId === null);
    assert.equal(unattributed.attribution.meeting, 'unattributed');
    assert.equal(unattributed.calls.total, 5);
    assert.equal(unattributed.tokens.input.sum, 3000);
    assert.equal(unattributed.tokens.output.sum, 1500);
    assert.equal(costOf(unattributed, 'USD'), 0.24);
    assert.equal(costOf(unattributed, 'EUR'), 0.06);

    // Fixed ordering: attributed groups (by meetingId ascending) before the unattributed group.
    assert.deepEqual(
      response.groups.map((g) => g.key.meetingId),
      ['m1', 'm2', null]
    );
  })
);

eachStore('rollup attribution: groupBy=tool matches the golden fixture', (store) =>
  seedGoldenFixture(store).then(async () => {
    const response = await store.rollup(parseRollupQuery({ groupBy: 'tool', sessionId: 'sess_42' }));
    assert.equal(response.groups.length, 5);

    const bash = groupFor(response, (g) => g.key.tool === 'Bash');
    assert.equal(bash.attribution.tool, 'attributed');
    assert.equal(bash.calls.total, 2);
    assert.equal(bash.tokens.input.sum, 700);
    assert.equal(bash.tokens.output.sum, 350);
    assert.equal(costOf(bash, 'USD'), 0.07);

    const read = groupFor(response, (g) => g.key.tool === 'Read');
    assert.equal(read.calls.total, 1);
    assert.equal(read.tokens.input.sum, 400);
    assert.equal(costOf(read, 'USD'), 0.04);

    const nullGroups = response.groups.filter((g) => g.key.tool === null);
    assert.equal(nullGroups.length, 3);
    const unresolved = nullGroups.find((g) => g.attribution.tool === 'unresolved');
    assert.equal(unresolved.calls.total, 1);
    assert.equal(unresolved.tokens.input.sum, 600);
    assert.equal(costOf(unresolved, 'EUR'), 0.06);
    const ambiguous = nullGroups.find((g) => g.attribution.tool === 'ambiguous');
    assert.equal(ambiguous.calls.total, 1);
    assert.equal(ambiguous.tokens.input.sum, 800);
    assert.equal(costOf(ambiguous, 'USD'), 0.08);
    const unattributed = nullGroups.find((g) => g.attribution.tool === 'unattributed');
    assert.equal(unattributed.calls.total, 3);
    assert.equal(unattributed.tokens.input.sum, 1100);
    assert.equal(unattributed.cost.unknownCostCalls, 1);
    assert.equal(costOf(unattributed, 'USD'), 0.08);

    // Fixed rank order: attributed (Bash, Read, key-ascending) before unresolved, ambiguous, unattributed.
    assert.deepEqual(
      response.groups.map((g) => [g.key.tool, g.attribution.tool]),
      [
        ['Bash', 'attributed'],
        ['Read', 'attributed'],
        [null, 'unresolved'],
        [null, 'ambiguous'],
        [null, 'unattributed'],
      ]
    );
  })
);

eachStore('rollup attribution: groupBy=meeting,tool produces 8 one-call groups and the sum invariant holds', (store) =>
  seedGoldenFixture(store).then(async () => {
    const response = await store.rollup(parseRollupQuery({ groupBy: 'meeting,tool', sessionId: 'sess_42' }));
    assert.equal(response.groups.length, 8);
    for (const group of response.groups) assert.equal(group.calls.total, 1);

    const totalInput = response.groups.reduce((sum, g) => sum + (g.tokens.input.sum ?? 0), 0);
    const totalOutput = response.groups.reduce((sum, g) => sum + (g.tokens.output.sum ?? 0), 0);
    assert.equal(totalInput, 3600);
    assert.equal(totalOutput, 1800);
    assert.equal(response.totals.tokens.input.sum, 3600);
    assert.equal(response.totals.tokens.output.sum, 1800);
    assert.equal(response.totals.calls.total, 8);
  })
);

eachStore('rollup attribution: filters toolAttribution, tool and meetingAttribution+groupBy=tool', (store) =>
  seedGoldenFixture(store).then(async () => {
    const unresolvedOnly = await store.rollup(
      parseRollupQuery({ groupBy: 'agent', sessionId: 'sess_42', toolAttribution: 'unresolved' })
    );
    assert.equal(unresolvedOnly.totals.calls.total, 1);

    const bashOnly = await store.rollup(parseRollupQuery({ groupBy: 'agent', sessionId: 'sess_42', tool: 'Bash' }));
    assert.equal(bashOnly.totals.calls.total, 2);

    const meetingAttributedByTool = await store.rollup(
      parseRollupQuery({ groupBy: 'tool', sessionId: 'sess_42', meetingAttribution: 'attributed' })
    );
    assert.equal(meetingAttributedByTool.totals.calls.total, 3);
    const bashGroup = groupFor(meetingAttributedByTool, (g) => g.key.tool === 'Bash');
    assert.equal(bashGroup.calls.total, 1);
    const unattributedToolGroup = groupFor(meetingAttributedByTool, (g) => g.key.tool === null);
    assert.equal(unattributedToolGroup.calls.total, 2);
  })
);

// -------------------------------------------------------------
// Attribution rules in isolation (section 1 of the issue)
// -------------------------------------------------------------

eachStore('rollup attribution: scope isolation - same toolCallId in a different session never collides', (store) =>
  (async () => {
    await seed(store, [
      toolStartedEvent({ id: 'evt_s1', agentId: 'a1', sessionId: 'session-1', tool: 'Bash', toolCallId: 'call-1' }),
      usageEvent({ id: 'u_s1', agentId: 'a1', sessionId: 'session-1', payload: { toolCallId: 'call-1' } }),
      // A different session reusing the same toolCallId, with no matching tool.started of its own: unresolved.
      usageEvent({ id: 'u_s2', agentId: 'a1', sessionId: 'session-2', payload: { toolCallId: 'call-1' } }),
    ]);
    const response = await store.rollup(parseRollupQuery({ groupBy: 'tool' }));
    const bash = groupFor(response, (g) => g.key.tool === 'Bash');
    assert.equal(bash.calls.total, 1);
    const unresolved = groupFor(response, (g) => g.attribution.tool === 'unresolved');
    assert.equal(unresolved.calls.total, 1);
  })()
);

eachStore('rollup attribution: a usage row with a session against a tool.started without one is unresolved', (store) =>
  (async () => {
    await seed(store, [
      toolStartedEvent({ id: 'evt_noses', agentId: 'a1', sessionId: undefined, tool: 'Bash', toolCallId: 'call-1' }),
      usageEvent({ id: 'u_hasses', agentId: 'a1', sessionId: 'session-1', payload: { toolCallId: 'call-1' } }),
    ]);
    const response = await store.rollup(parseRollupQuery({ groupBy: 'tool' }));
    const unresolved = groupFor(response, (g) => g.attribution.tool === 'unresolved');
    assert.ok(unresolved, 'expected an unresolved group');
    assert.equal(unresolved.calls.total, 1);
  })()
);

eachStore('rollup attribution: order independence - tool.started arriving after llm.usage still resolves', (store) =>
  (async () => {
    await seed(store, [
      usageEvent({ id: 'u_first', agentId: 'a1', sessionId: 'session-1', payload: { toolCallId: 'call-1' } }),
      toolStartedEvent({ id: 'evt_after', agentId: 'a1', sessionId: 'session-1', tool: 'Read', toolCallId: 'call-1' }),
    ]);
    const response = await store.rollup(parseRollupQuery({ groupBy: 'tool' }));
    const read = groupFor(response, (g) => g.key.tool === 'Read');
    assert.ok(read, 'expected the usage row to resolve once the tool.started event exists');
    assert.equal(read.calls.total, 1);
  })()
);

eachStore('rollup attribution: re-sending an identical tool.started does not change the result', (store) =>
  (async () => {
    await seed(store, [
      toolStartedEvent({ id: 'evt_once', agentId: 'a1', sessionId: 'session-1', tool: 'Bash', toolCallId: 'call-1' }),
      toolStartedEvent({ id: 'evt_twice', agentId: 'a1', sessionId: 'session-1', tool: 'Bash', toolCallId: 'call-1' }),
      usageEvent({ id: 'u_once', agentId: 'a1', sessionId: 'session-1', payload: { toolCallId: 'call-1' } }),
    ]);
    const response = await store.rollup(parseRollupQuery({ groupBy: 'tool' }));
    const bash = groupFor(response, (g) => g.key.tool === 'Bash');
    assert.equal(bash.calls.total, 1);
    assert.equal(response.groups.length, 1);
  })()
);

eachStore('rollup attribution: meeting title is the latest accepted non-empty title, not event timestamp order', (store) =>
  (async () => {
    await seed(store, [
      meetingRequestedEvent({ id: 'evt_m_first', agentId: 'a1', meetingId: 'm1', title: 'First title', timestamp: 2_000 }),
      meetingRequestedEvent({ id: 'evt_m_second', agentId: 'a1', meetingId: 'm1', title: 'Second title', timestamp: 1_000 }),
      usageEvent({ id: 'u_meeting', agentId: 'a1', payload: { meetingId: 'm1' } }),
    ]);
    const response = await store.rollup(parseRollupQuery({ groupBy: 'meeting' }));
    const m1 = groupFor(response, (g) => g.key.meetingId === 'm1');
    // Accepted (insertion) order, not event.timestamp order: the second one accepted wins even though its own
    // timestamp is earlier.
    assert.equal(m1.key.title, 'Second title');
  })()
);

// -------------------------------------------------------------
// Response shaping: ordering, limit, never-drop-unattributed, truncation+merge
// -------------------------------------------------------------

eachStore('rollup attribution: limit truncates attributed groups only, never drops non-attributed ones', (store) =>
  (async () => {
    await seed(store, [
      toolStartedEvent({ id: 'evt_bash', agentId: 'a1', sessionId: 's', tool: 'Bash', toolCallId: 'c1' }),
      toolStartedEvent({ id: 'evt_read', agentId: 'a1', sessionId: 's', tool: 'Read', toolCallId: 'c2' }),
      usageEvent({ id: 'u_bash', agentId: 'a1', sessionId: 's', payload: { toolCallId: 'c1' } }),
      usageEvent({ id: 'u_read', agentId: 'a1', sessionId: 's', payload: { toolCallId: 'c2' } }),
      usageEvent({ id: 'u_none', agentId: 'a1', sessionId: 's', payload: {} }),
    ]);
    const response = await store.rollup(parseRollupQuery({ groupBy: 'tool', limit: '1' }));
    assert.equal(response.truncated, true);
    assert.equal(response.groupCount, 3);
    // One attributed group kept (the limit), plus the unattributed group, which is never dropped.
    assert.equal(response.groups.length, 2);
    assert.ok(response.groups.some((g) => g.attribution.tool === 'unattributed'));
    const attributedKept = response.groups.filter((g) => g.attribution.tool === 'attributed');
    assert.equal(attributedKept.length, 1);
  })()
);

eachStore('rollup attribution: groups whose free-text key collapses after 200-char truncation are merged', (store) =>
  (async () => {
    const longPrefix = 'x'.repeat(200);
    const toolA = `${longPrefix}-A`;
    const toolB = `${longPrefix}-B`;
    await seed(store, [
      toolStartedEvent({ id: 'evt_a', agentId: 'a1', sessionId: 's', tool: toolA, toolCallId: 'c1' }),
      toolStartedEvent({ id: 'evt_b', agentId: 'a1', sessionId: 's', tool: toolB, toolCallId: 'c2' }),
      usageEvent({ id: 'u_a', agentId: 'a1', sessionId: 's', payload: { toolCallId: 'c1', inputTokens: 10, outputTokens: 5 } }),
      usageEvent({ id: 'u_b', agentId: 'a1', sessionId: 's', payload: { toolCallId: 'c2', inputTokens: 20, outputTokens: 10 } }),
    ]);
    const response = await store.rollup(parseRollupQuery({ groupBy: 'tool' }));
    const merged = response.groups.filter((g) => g.attribution.tool === 'attributed');
    assert.equal(merged.length, 1, 'both 200-char-identical names should merge into one group');
    assert.equal(merged[0].key.tool.length, 200);
    assert.equal(merged[0].calls.total, 2);
    assert.equal(merged[0].tokens.input.sum, 30);
    assert.equal(merged[0].tokens.output.sum, 15);
  })()
);

// -------------------------------------------------------------
// Validation (400s)
// -------------------------------------------------------------

test('parseRollupQuery: invalid meetingAttribution/toolAttribution values are rejected', () => {
  assert.throws(
    () => parseRollupQuery({ groupBy: 'meeting', meetingAttribution: 'bogus' }),
    (err) => err instanceof UsageFilterError && err.issues.some((i) => i.path === 'meetingAttribution')
  );
  assert.throws(
    () => parseRollupQuery({ groupBy: 'tool', toolAttribution: 'bogus' }),
    (err) => err instanceof UsageFilterError && err.issues.some((i) => i.path === 'toolAttribution')
  );
});

test('parseRollupQuery: an empty meetingId/toolCallId/tool filter value is rejected', () => {
  assert.throws(() => parseRollupQuery({ groupBy: 'meeting', meetingId: '' }), UsageFilterError);
  assert.throws(() => parseRollupQuery({ groupBy: 'tool', toolCallId: '' }), UsageFilterError);
  assert.throws(() => parseRollupQuery({ groupBy: 'tool', tool: '' }), UsageFilterError);
});

test('parseRollupQuery: groupBy accepts meeting and tool together', () => {
  const query = parseRollupQuery({ groupBy: 'meeting,tool' });
  assert.deepEqual(query.groupBy, ['meeting', 'tool']);
});

// -------------------------------------------------------------
// SQLite derived tables: migration backfill and rebuild after drop (issue #80's own acceptance criterion)
// -------------------------------------------------------------

test('SQLite: dropping tool_calls/meeting_labels and reopening the store reproduces the same rollup', async () => {
  const { dir, file } = tempDbPath('rebuild');
  try {
    let store = new SQLiteEventStore(file, { backup: 'off' });
    await store.init();
    await seedGoldenFixture(store);
    const before = await store.rollup(parseRollupQuery({ groupBy: 'meeting,tool', sessionId: 'sess_42' }));
    await store.close();

    const db = new DatabaseSync(file);
    db.exec('DROP VIEW tool_call_resolution; DROP TABLE tool_calls; DROP TABLE meeting_labels;');
    db.close();

    store = new SQLiteEventStore(file, { backup: 'off' });
    await store.init();
    const after = await store.rollup(parseRollupQuery({ groupBy: 'meeting,tool', sessionId: 'sess_42' }));
    await store.close();

    // `asOf.generatedAt` is wall-clock time at query time (not a receive time), so it legitimately differs
    // between the two calls; everything else, including every group and `totals`, must match exactly.
    delete before.asOf.generatedAt;
    delete after.asOf.generatedAt;
    assert.deepEqual(after, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite: a pre-existing database (no event_json) backfills tool_calls/meeting_labels from payload alone', async () => {
  const { dir, file } = tempDbPath('legacy-backfill');
  try {
    // Simulate a pre-0.2.0 row: write directly to `events` with a payload but no event_json, bypassing the
    // normal append path (which always writes both), the same way the usage ledger's own legacy-row test does.
    let store = new SQLiteEventStore(file, { backup: 'off' });
    await store.init();
    await seed(store, [
      toolStartedEvent({ id: 'evt_legacy_tool', agentId: 'a1', sessionId: 's', tool: 'Bash', toolCallId: 'call-1' }),
    ]);
    await store.close();

    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE events SET event_json = NULL WHERE id = 'evt_legacy_tool'").run();
    raw.exec('DROP VIEW tool_call_resolution; DROP TABLE tool_calls; DROP TABLE meeting_labels;');
    raw.close();

    store = new SQLiteEventStore(file, { backup: 'off' });
    await store.init();
    await seed(store, [usageEvent({ id: 'u_legacy', agentId: 'a1', sessionId: 's', payload: { toolCallId: 'call-1' } })]);
    const response = await store.rollup(parseRollupQuery({ groupBy: 'tool' }));
    await store.close();

    const bash = groupFor(response, (g) => g.key.tool === 'Bash');
    assert.ok(bash, 'expected the legacy row (no event_json) to still resolve from its payload column');
    assert.equal(bash.calls.total, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Memory vs SQLite parity on the golden fixture (both groupings together, one JSON diff)
// -------------------------------------------------------------

test('rollup attribution: memory and sqlite stores return identical JSON for the golden fixture', async () => {
  const memoryStore = new MemoryEventStore(100_000);
  await memoryStore.init();
  const { dir, file } = tempDbPath('parity');
  const sqliteStore = new SQLiteEventStore(file, { backup: 'off' });
  await sqliteStore.init();
  try {
    await seedGoldenFixture(memoryStore);
    await seedGoldenFixture(sqliteStore);
    for (const groupBy of ['meeting', 'tool', 'meeting,tool']) {
      const query = parseRollupQuery({ groupBy, sessionId: 'sess_42' });
      const fromMemory = await memoryStore.rollup(query);
      const fromSqlite = await sqliteStore.rollup(query);
      delete fromMemory.coverage;
      delete fromSqlite.coverage;
      delete fromMemory.asOf.generatedAt;
      delete fromSqlite.asOf.generatedAt;
      assert.deepEqual(fromMemory, fromSqlite, `groupBy=${groupBy}`);
    }
  } finally {
    await memoryStore.close();
    await sqliteStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
