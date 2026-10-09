// Shared by tests/server-concurrency-memory.test.mjs and tests/server-concurrency-sqlite.test.mjs. Each of those
// files sets the storage mode before importing the server, because the store is created at import time. This
// file does not match the tests/*.test.mjs glob, so it never runs on its own.
import assert from 'node:assert/strict';
import http from 'node:http';

const FROZEN_NOW = 1_700_000_000_000;
const BURST = 200;
const SERVER_ID = /^evt_[a-z_]+_[0-9a-f-]{36}$/;

function startTestServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/** Subscribes to the SSE stream and collects every event frame until `close()` is called. */
async function subscribe(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/events/stream`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = '';
  let connected;
  const isConnected = new Promise((resolve) => (connected = resolve));
  let waiter = null;

  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (block.includes(': connected')) connected();
          const data = block.split('\n').find((line) => line.startsWith('data: {'));
          if (data && /^id: /m.test(block)) frames.push(JSON.parse(data.slice('data: '.length)));
        }
        if (waiter && waiter.predicate(frames)) waiter.resolve();
      }
    } catch {
      // The reader was cancelled.
    }
  })();

  await isConnected;
  return {
    frames,
    waitFor(predicate, timeoutMs = 15_000) {
      if (predicate(frames)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`SSE frames did not arrive in time (${frames.length} so far)`)), timeoutMs);
        waiter = { predicate, resolve: () => { clearTimeout(timer); waiter = null; resolve(); } };
      });
    },
    async close() {
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

async function listEvents(baseUrl, query) {
  const response = await fetch(`${baseUrl}/api/v1/events?${query}&limit=10000`);
  assert.equal(response.status, 200);
  return (await response.json()).events;
}

function json(method, body) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function assertDistinctServerIds(events, label) {
  assert.equal(events.length, BURST, `${label}: ${events.length} stored events`);
  const ids = new Set(events.map(({ id }) => id));
  assert.equal(ids.size, BURST, `${label}: every stored id is distinct`);
  for (const id of ids) assert.match(id, SERVER_ID, `${label}: ${id}`);
}

/**
 * With `Date.now` frozen, fires 200 parallel `POST /api/v1/agents`, 200 parallel `PATCH /api/v1/agents/:id` and
 * 200 parallel `POST /api/v1/runtimes`. Every request must store its own event and broadcast exactly one frame.
 */
export async function runServerIdConcurrencyScenario(t, { app, mode }) {
  const { server, baseUrl } = await startTestServer(app);
  const stream = await subscribe(baseUrl);
  try {
    const agentId = `burst-agent-${mode}`;
    const patchedId = `burst-patched-${mode}`;
    const runtimeId = `burst-runtime-${mode}`;
    assert.equal((await fetch(`${baseUrl}/api/v1/agents`, json('POST', { id: patchedId, name: 'Patched' }))).status, 201);

    t.mock.method(Date, 'now', () => FROZEN_NOW);

    const registrations = await Promise.all(
      Array.from({ length: BURST }, () => fetch(`${baseUrl}/api/v1/agents`, json('POST', { id: agentId, name: 'Burst' })))
    );
    const patches = await Promise.all(
      Array.from({ length: BURST }, (_, index) =>
        fetch(`${baseUrl}/api/v1/agents/${patchedId}`, json('PATCH', { status: index % 2 === 0 ? 'CODING' : 'TESTING' }))
      )
    );
    const runtimes = await Promise.all(
      Array.from({ length: BURST }, () => fetch(`${baseUrl}/api/v1/runtimes`, json('POST', { id: runtimeId, name: 'Burst runtime' })))
    );
    assert.deepEqual([...new Set(registrations.map(({ status }) => status))], [201]);
    assert.deepEqual([...new Set(patches.map(({ status }) => status))], [200]);
    assert.deepEqual([...new Set(runtimes.map(({ status }) => status))], [201]);
    await Promise.all([...registrations, ...patches, ...runtimes].map((response) => response.arrayBuffer()));

    const registered = await listEvents(baseUrl, `type=agent.registered&agentId=${agentId}`);
    const statusChanges = await listEvents(baseUrl, `type=agent.status.changed&agentId=${patchedId}`);
    const connected = await listEvents(baseUrl, `type=runtime.connected&runtimeId=${runtimeId}`);
    assertDistinctServerIds(registered, 'POST /api/v1/agents');
    assertDistinctServerIds(statusChanges, 'PATCH /api/v1/agents/:id');
    assertDistinctServerIds(connected, 'POST /api/v1/runtimes');
    assert.ok(registered.every(({ timestamp }) => timestamp === FROZEN_NOW), 'Date.now stays the timestamp');

    const count = (frames, type, key, value) => frames.filter((frame) => frame.type === type && frame[key] === value).length;
    const complete = (frames) =>
      count(frames, 'agent.registered', 'agentId', agentId) >= BURST &&
      count(frames, 'agent.status.changed', 'agentId', patchedId) >= BURST &&
      count(frames, 'runtime.connected', 'runtimeId', runtimeId) >= BURST;
    await stream.waitFor(complete);
    // Let any extra frame arrive before counting exactly.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(count(stream.frames, 'agent.registered', 'agentId', agentId), BURST);
    assert.equal(count(stream.frames, 'agent.status.changed', 'agentId', patchedId), BURST);
    assert.equal(count(stream.frames, 'runtime.connected', 'runtimeId', runtimeId), BURST);
    const streamedIds = new Set(stream.frames.map(({ id }) => id));
    for (const event of [...registered, ...statusChanges, ...connected]) {
      assert.ok(streamedIds.has(event.id), `stored event ${event.id} was streamed`);
    }
  } finally {
    await stream.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Identical re-send is a 200 duplicate with the same fingerprint as the 202; a different event under the same id is
 * a 409 that changes neither the stored event, nor the totals, nor the stream.
 */
export async function runDuplicateConflictScenario({ app, mode }) {
  const { server, baseUrl } = await startTestServer(app);
  const stream = await subscribe(baseUrl);
  try {
    const id = `evt_integrity_${mode}`;
    const event = {
      id,
      type: 'llm.usage',
      timestamp: FROZEN_NOW,
      source: `agent:integrity-${mode}`,
      agentId: `integrity-${mode}`,
      summary: 'Audited call',
      payload: { provider: 'p', model: 'm', inputTokens: 100, outputTokens: 10, cost: 0.01, costSource: 'provider-reported', currency: 'USD' },
    };
    const post = (body) => fetch(`${baseUrl}/api/v1/events`, json('POST', body));

    const first = await post(event);
    assert.equal(first.status, 202);
    const firstJson = await first.json();
    assert.match(firstJson.fingerprint, /^sha256:[0-9a-f]{64}$/);

    const retry = await post(event);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { accepted: true, duplicate: true, id, fingerprint: firstJson.fingerprint });

    const readyBefore = await (await fetch(`${baseUrl}/ready`)).json();
    const usageBefore = (await (await fetch(`${baseUrl}/api/v1/snapshot`)).json()).usage;
    const conflict = await post({ ...event, payload: { ...event.payload, inputTokens: 101 } });
    assert.equal(conflict.status, 409);
    const conflictJson = await conflict.json();
    assert.equal(conflictJson.error, 'conflicting_duplicate');
    assert.equal(conflictJson.storedFingerprint, firstJson.fingerprint);
    assert.notEqual(conflictJson.fingerprint, firstJson.fingerprint);

    const stored = (await listEvents(baseUrl, `agentId=integrity-${mode}`)).filter((item) => item.id === id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].payload.inputTokens, 100);
    assert.deepEqual((await (await fetch(`${baseUrl}/api/v1/snapshot`)).json()).usage, usageBefore);
    const readyAfter = await (await fetch(`${baseUrl}/ready`)).json();
    assert.equal(readyAfter.ingestion.conflicts, readyBefore.ingestion.conflicts + 1);

    await post({ id: `${id}_marker`, type: 'agent.message.sent', timestamp: FROZEN_NOW, source: 'agent:marker', summary: 'marker', payload: { text: 'marker' } });
    await stream.waitFor((frames) => frames.some((frame) => frame.id === `${id}_marker`));
    assert.equal(stream.frames.filter((frame) => frame.id === id).length, 1, 'only the accepted copy was streamed');
  } finally {
    await stream.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
