// Issue #305 (sub-issue of #85): the `event: budget` SSE frame, end to end against the real `app` (pattern from
// tests/sse-stream.test.mjs and tests/budgets-api.test.mjs). Covers exactly what the issue asks to be proven:
// the frame carries no `id:` line, it reports the right budget/direction/threshold for a real ingested spend
// crossing a state boundary, and none of it disturbs `CANONICAL_EVENT_TYPES` or the reconnect replay path (a
// `budget` frame is never stored, so it can never be replayed and never counts toward a `Last-Event-ID` gap).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { app } from '../server/index.ts';
import { CANONICAL_EVENT_TYPES } from '../src/integrations/canonicalTypes.ts';

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function uniqueId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function createBudget(baseUrl, overrides = {}) {
  const res = await fetch(`${baseUrl}/api/v1/budgets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'SSE live budget',
      scope: { type: 'agent', value: uniqueId('agent') },
      period: 'month',
      currency: 'USD',
      basis: 'reported',
      limit: 10,
      warningRatio: 0.5,
      ...overrides,
    }),
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function postUsageEvent(baseUrl, agentId, cost) {
  const res = await fetch(`${baseUrl}/api/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: uniqueId('evt'),
      type: 'llm.usage',
      timestamp: Date.now(),
      source: `agent:${agentId}`,
      agentId,
      summary: 'budget SSE test usage',
      payload: { provider: 'OpenAI', model: 'gpt-4.1', inputTokens: 10, outputTokens: 5, cost, currency: 'USD', costSource: 'provider-reported' },
    }),
  });
  assert.equal(res.status, 202);
  return res;
}

/** Reads from `reader` (accumulating into `buffer`) until `predicate(buffer)` is true or `timeoutMs` elapses. The
 * budget live-check runs fire-and-forget after the triggering `llm.usage` event's own SSE frame is already
 * written (`server/index.ts`'s `onEventAccepted` listener never awaits it), so the `budget` frame can land a tick
 * or more after the response to `postUsageEvent` resolves; polling the stream like this is the only reliable way
 * to observe it without a fixed, flaky sleep. */
async function readUntil(reader, decoder, predicate, timeoutMs = 2000) {
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (!predicate(buffer)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for stream content. Buffer so far:\n${buffer}`);
    }
    const { value, done } = await reader.read();
    if (done) throw new Error(`Stream closed before the expected content arrived. Buffer so far:\n${buffer}`);
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer;
}

test('CANONICAL_EVENT_TYPES never includes "budget": the live SSE frame is not a canonical event type', () => {
  assert.ok(!CANONICAL_EVENT_TYPES.includes('budget'));
});

test('SSE: a real spend crossing warning emits "event: budget" with no "id:" line and the right direction/threshold', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const budget = await createBudget(baseUrl);
    const agentId = budget.scope.value;

    const response = await fetch(`${baseUrl}/api/v1/events/stream`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    await readUntil(reader, decoder, (buf) => buf.includes('connected'));

    // First call (cost 2, well under the warning threshold of 5): this is the budget's very first live check, so
    // it only establishes the "ok" baseline and must not itself produce a "budget" frame.
    await postUsageEvent(baseUrl, agentId, 2);
    const afterFirst = await readUntil(reader, decoder, (buf) => buf.includes('"llm.usage"'));
    assert.ok(!afterFirst.includes('event: budget'), 'the first-ever live check must not emit a transition');

    // Second call (cost 4 more, total 6): crosses the warning threshold (limit 10 * warningRatio 0.5 = 5).
    await postUsageEvent(baseUrl, agentId, 4);
    const afterSecond = await readUntil(reader, decoder, (buf) => buf.includes('event: budget'));

    const budgetFrameMatch = afterSecond.match(/event: budget\ndata: ([^\n]+)\n\n/);
    assert.ok(budgetFrameMatch, `expected an "event: budget" frame in:\n${afterSecond}`);
    const transition = JSON.parse(budgetFrameMatch[1]);
    assert.equal(transition.budgetId, budget.id);
    assert.equal(transition.from, 'ok');
    assert.equal(transition.to, 'warning');
    assert.equal(transition.direction, 'up');
    assert.equal(transition.threshold, 0.5);
    assert.equal(transition.trigger, 'ledger_event');
    assert.equal(transition.scope.value, agentId);

    // No "id:" line directly preceding the frame (every canonical-event frame `broadcastEvent` writes always has
    // one): the frame is exactly "event: budget\ndata: ...\n\n" with nothing else in front of it on its own line.
    const frameStart = afterSecond.indexOf('event: budget');
    const precedingNewline = afterSecond.lastIndexOf('\n\n', frameStart);
    const immediatelyBefore = afterSecond.slice(precedingNewline + 2, frameStart);
    assert.equal(immediatelyBefore, '', 'nothing (in particular no "id: " line) sits between the frame boundary and "event: budget"');

    await reader.cancel();
  } finally {
    server.close();
    server.closeAllConnections();
  }
});


test('SSE: the "budget" frame is never replayed on reconnect and never affects the canonical replay/resync count', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const budget = await createBudget(baseUrl);
    const agentId = budget.scope.value;

    const first = await fetch(`${baseUrl}/api/v1/events/stream`);
    const firstReader = first.body.getReader();
    const decoder = new TextDecoder();
    await readUntil(firstReader, decoder, (buf) => buf.includes('connected'));

    await postUsageEvent(baseUrl, agentId, 2); // baseline, no transition
    const afterFirst = await readUntil(firstReader, decoder, (buf) => buf.includes('"llm.usage"'));
    const firstEventIdMatch = afterFirst.match(/id: (evt_\S+)/);
    assert.ok(firstEventIdMatch, 'expected the first llm.usage event id to stream');
    const lastEventId = firstEventIdMatch[1];

    const secondRes = await postUsageEvent(baseUrl, agentId, 4); // crosses into warning: a "budget" frame is broadcast live
    const secondAfter = await readUntil(firstReader, decoder, (buf) => buf.includes('event: budget'));
    const secondEventIdMatch = secondAfter.match(/id: (evt_\S+)/);
    assert.ok(secondEventIdMatch, 'expected the second llm.usage event id to stream alongside the budget frame');
    const secondEventId = secondEventIdMatch[1];
    void secondRes;
    await firstReader.cancel();

    // A third, real canonical event after the transition (still "warning", no new crossing): two canonical events
    // (this one and the one above) are now missed since `lastEventId`, and the reconnect below must replay both.
    const thirdRes = await postUsageEvent(baseUrl, agentId, 0.1);
    void thirdRes;

    const reconnect = await fetch(`${baseUrl}/api/v1/events/stream?lastEventId=${lastEventId}`);
    assert.equal(reconnect.status, 200);
    const reconnectReader = reconnect.body.getReader();
    const replay = await readUntil(reconnectReader, decoder, (buf) => buf.includes('connected'));

    // The replay must contain only the two real canonical events missed since `lastEventId` (no resync, since the
    // gap is small): never a "budget" frame, which was broadcast live and is not stored at all, so it was never a
    // candidate for replay and never counted toward the gap the reconnect logic computed.
    assert.ok(!replay.includes('event: budget'), `reconnect replay must never include a "budget" frame:\n${replay}`);
    assert.ok(!replay.includes('event: resync'), `a two-event gap must replay in full, not resync:\n${replay}`);
    const replayedIds = [...replay.matchAll(/id: (evt_\S+)/g)].map((m) => m[1]);
    assert.equal(replayedIds.length, 2, `expected exactly two replayed canonical event ids:\n${replay}`);
    assert.equal(replayedIds[0], secondEventId, 'the cost=4 event (the one that triggered the budget transition) replays first');

    await reconnectReader.cancel();
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
