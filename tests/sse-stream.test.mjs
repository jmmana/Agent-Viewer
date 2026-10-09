import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../server/index.ts';

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

test('SSE: client receives real-time events on SSE stream without token', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const response = await fetch(`${baseUrl}/api/v1/events/stream`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // Read initial connect message
    const initial = await reader.read();
    assert.ok(decoder.decode(initial.value).includes('connected'));

    // Emit an event
    const postRes = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: '1.0',
        id: 'evt_sse_test_1',
        type: 'agent.message.sent',
        timestamp: Date.now(),
        source: 'agent:tester',
        summary: 'SSE test message',
        payload: { text: 'Hello SSE World' },
      }),
    });
    assert.equal(postRes.status, 202);

    // Read streamed event
    const chunk = await reader.read();
    const text = decoder.decode(chunk.value);
    assert.ok(text.includes('id: evt_sse_test_1'));
    assert.ok(text.includes('Hello SSE World'));
    // Ensure onmessage compatible format (data field without blocking custom event)
    assert.ok(text.includes('data: {'));

    await reader.cancel();
  } finally {
    server.close();
  }
});

test('SSE: token authentication works via query parameter for EventSource compatibility', async () => {
  const secretToken = 'test-sse-secure-token-123';
  process.env.AGENT_VIEWER_API_TOKEN = secretToken;

  const { server, baseUrl } = await startTestServer();

  try {
    // 1. Connection without token fails with 401
    const unauthRes = await fetch(`${baseUrl}/api/v1/events/stream`);
    assert.equal(unauthRes.status, 401);
    const unauthJson = await unauthRes.json();
    assert.equal(unauthJson.error, 'unauthorized');

    // 2. Connection with token in query param succeeds
    const authRes = await fetch(`${baseUrl}/api/v1/events/stream?token=${secretToken}`);
    assert.equal(authRes.status, 200);

    const reader = authRes.body.getReader();
    const decoder = new TextDecoder();

    const initial = await reader.read();
    assert.ok(decoder.decode(initial.value).includes('connected'));

    // Emit event with token in header
    const postRes = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secretToken}`,
      },
      body: JSON.stringify({
        schemaVersion: '1.0',
        id: 'evt_sse_test_auth',
        type: 'agent.status.changed',
        timestamp: Date.now(),
        source: 'agent:auth-tester',
        summary: 'Status changed',
        payload: { status: 'WORKING' },
      }),
    });
    assert.equal(postRes.status, 202);

    const chunk = await reader.read();
    const text = decoder.decode(chunk.value);
    assert.ok(text.includes('id: evt_sse_test_auth'));
    assert.ok(text.includes('WORKING'));

    await reader.cancel();
  } finally {
    delete process.env.AGENT_VIEWER_API_TOKEN;
    server.close();
  }
});

test('SSE: no frame is emitted for a duplicate or a conflicting event', async () => {
  const { server, baseUrl } = await startTestServer();
  const post = (body) =>
    fetch(`${baseUrl}/api/v1/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const original = {
    schemaVersion: '1.0',
    id: 'evt_sse_integrity',
    type: 'agent.message.sent',
    timestamp: 1_700_000_000_000,
    source: 'agent:tester',
    summary: 'Original',
    payload: { text: 'original text' },
  };
  const marker = { ...original, id: 'evt_sse_integrity_marker', summary: 'Marker', payload: { text: 'marker' } };

  const response = await fetch(`${baseUrl}/api/v1/events/stream`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    text += decoder.decode((await reader.read()).value);
    assert.ok(text.includes('connected'));

    assert.equal((await post(original)).status, 202);
    assert.equal((await post(original)).status, 200);
    assert.equal((await post({ ...original, payload: { text: 'different text' } })).status, 409);
    const batch = await fetch(`${baseUrl}/api/v1/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([original, { ...original, summary: 'Changed' }]),
    });
    assert.equal(batch.status, 202);
    assert.deepEqual((await batch.json()).results.map(({ status }) => status), ['duplicate', 'conflict']);
    // The marker is sent last, so once it arrives every earlier frame has arrived too.
    assert.equal((await post(marker)).status, 202);

    while (!text.includes('id: evt_sse_integrity_marker')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    const frames = text.split('\n\n').filter((block) => block.startsWith('id: evt_sse_integrity'));
    assert.deepEqual(frames.map((block) => block.split('\n')[0]), ['id: evt_sse_integrity', 'id: evt_sse_integrity_marker']);
    assert.ok(!text.includes('different text') && !text.includes('Changed'), 'the rejected content never reaches the stream');
  } finally {
    await reader.cancel();
    server.close();
  }
});

test('SSE: a request_id duplicate is never broadcast and never replayed on Last-Event-ID (issue #48)', async () => {
  const { server, baseUrl } = await startTestServer();
  const post = (body) =>
    fetch(`${baseUrl}/api/v1/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const original = {
    schemaVersion: '1.0',
    id: 'evt_sse_reqdup_original',
    type: 'llm.usage',
    timestamp: 1_700_000_000_000,
    source: 'agent:tester',
    summary: 'Original call',
    payload: { provider: 'sse-provider', model: 'm', inputTokens: 1, outputTokens: 1, requestId: 'sse-req-1' },
  };
  const duplicate = {
    ...original,
    id: 'evt_sse_reqdup_duplicate',
    payload: { ...original.payload, inputTokens: 999 },
  };
  const marker = { ...original, id: 'evt_sse_reqdup_marker', payload: { ...original.payload, requestId: 'sse-req-marker' } };

  const response = await fetch(`${baseUrl}/api/v1/events/stream`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    text += decoder.decode((await reader.read()).value);
    assert.ok(text.includes('connected'));

    assert.equal((await post(original)).status, 202);
    const dupRes = await post(duplicate);
    assert.equal(dupRes.status, 200);
    assert.equal((await dupRes.json()).duplicateReason, 'request_id');
    // The marker is sent last, so once it arrives every earlier frame has arrived too.
    assert.equal((await post(marker)).status, 202);

    while (!text.includes('id: evt_sse_reqdup_marker')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    const frames = text.split('\n\n').filter((block) => block.startsWith('id: evt_sse_reqdup'));
    assert.deepEqual(frames.map((block) => block.split('\n')[0]), ['id: evt_sse_reqdup_original', 'id: evt_sse_reqdup_marker']);

    // A reconnect with Last-Event-ID does not replay the duplicate either.
    const replay = await fetch(`${baseUrl}/api/v1/events/stream`, { headers: { 'Last-Event-ID': 'evt_sse_reqdup_original' } });
    const replayReader = replay.body.getReader();
    let replayText = '';
    while (!replayText.includes('connected')) {
      const chunk = await replayReader.read();
      if (chunk.done) break;
      replayText += decoder.decode(chunk.value);
    }
    assert.ok(!replayText.includes('evt_sse_reqdup_duplicate'), 'the duplicate is never replayed on Last-Event-ID');
    await replayReader.cancel();
  } finally {
    await reader.cancel();
    server.close();
  }
});
