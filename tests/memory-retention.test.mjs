import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// AGENT_VIEWER_MAX_EVENTS is read once, when server/index.ts builds its store at module load. `tsx --test` runs
// each file in its own process, so setting it here before the dynamic import does not leak into other test files
// (same pattern as tests/server-rate-limit.test.mjs).
process.env.AGENT_VIEWER_MAX_EVENTS = '5';
delete process.env.AGENT_VIEWER_API_TOKEN;
delete process.env.AGENT_VIEWER_API_KEY;
delete process.env.AGENT_VIEWER_WEBHOOK_SECRET;
const { app } = await import('../server/index.ts');

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function usageEvent(id, inputTokens) {
  return {
    id,
    type: 'llm.usage',
    timestamp: 1_700_000_000_000,
    source: 'agent:retention-env',
    agentId: 'retention-env',
    summary: `Call ${id}`,
    payload: { provider: 'p', model: 'm', inputTokens, outputTokens: 1, cost: 0.01, currency: 'USD', costSource: 'provider-reported' },
  };
}

test('AGENT_VIEWER_MAX_EVENTS=5: retrying an event evicted from the retained window is a 200 duplicate, totals and retention stay honest, and no frame is broadcast', async () => {
  const { server, baseUrl } = await startTestServer();
  const post = (event) =>
    fetch(`${baseUrl}/api/v1/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) });

  try {
    const stream = await fetch(`${baseUrl}/api/v1/events/stream`);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let streamed = '';
    streamed += decoder.decode((await reader.read()).value);
    assert.ok(streamed.includes(': connected'));

    const first = usageEvent('evt_env_cap_1', 1000);
    const events = [first, usageEvent('evt_env_cap_2', 1), usageEvent('evt_env_cap_3', 1), usageEvent('evt_env_cap_4', 1), usageEvent('evt_env_cap_5', 1), usageEvent('evt_env_cap_6', 1), usageEvent('evt_env_cap_7', 1), usageEvent('evt_env_cap_8', 1)];
    for (const event of events) {
      const res = await post(event);
      assert.equal(res.status, 202, `expected ${event.id} to be accepted`);
    }

    // The window holds only 5, so evt_env_cap_1 (the first of 8) is no longer listed...
    const listed = await (await fetch(`${baseUrl}/api/v1/events`)).json();
    assert.equal(listed.retention.storage, 'memory');
    assert.equal(listed.retention.maxEvents, 5);
    assert.equal(listed.retention.retainedEvents, 5);
    assert.equal(listed.retention.acceptedEvents, 8);
    assert.equal(listed.retention.droppedEvents, 3);
    assert.ok(listed.events.every((e) => e.id !== 'evt_env_cap_1'), 'the evicted event is no longer listed');

    const before = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();

    // ...but retrying it must still be recognized: 200 duplicate, not a new 202, and no double counting.
    const retry = await post(first);
    assert.equal(retry.status, 200);
    const retryBody = await retry.json();
    assert.equal(retryBody.accepted, true);
    assert.equal(retryBody.duplicate, true);

    const after = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
    assert.deepStrictEqual(after.usage, before.usage, 'a retry of an evicted id must not be counted again');
    assert.deepStrictEqual(after.totalTokens, before.totalTokens);
    assert.deepStrictEqual(after.retention, before.retention, 'retention counters do not move for a duplicate');

    // Confirm the retry produced no second SSE frame for its id (it was already broadcast once, when it was
    // first accepted). The marker is sent last, so once it arrives every earlier frame has arrived too.
    const marker = usageEvent('evt_env_cap_marker', 1);
    assert.equal((await post(marker)).status, 202);
    while (!streamed.includes('evt_env_cap_marker')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamed += decoder.decode(chunk.value);
    }
    const framesForFirst = streamed.split('\n\n').filter((block) => block.startsWith('id: evt_env_cap_1\n'));
    assert.equal(framesForFirst.length, 1, 'evt_env_cap_1 must be broadcast exactly once, never again on retry');

    await reader.cancel();
  } finally {
    server.close();
  }
});
