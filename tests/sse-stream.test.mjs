import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, store } from '../server/index.ts';

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

function postEvent(baseUrl, body) {
  return fetch(`${baseUrl}/api/v1/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function messageEvent(id, timestamp = 1_700_000_000_000) {
  return {
    schemaVersion: '1.0',
    id,
    type: 'agent.message.sent',
    timestamp,
    source: 'agent:replay',
    agentId: 'replay',
    summary: `Message ${id}`,
    payload: { text: `Text ${id}` },
  };
}

/** Reads from `reader` until `predicate(text)` is true, or `reader` closes. Returns the accumulated text. */
async function readUntil(reader, predicate, decoder = new TextDecoder()) {
  let text = '';
  while (!predicate(text)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

/** Every `id: ...` line in a raw SSE text blob, in order. */
function frameIds(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('id: '))
    .map((line) => line.slice('id: '.length));
}

// -------------------------------------------------------------
// Reconnect replay and resync (issue #54): full replay in insertion order and exactly once, or an explicit
// resync frame. There is no third, silent outcome.
// -------------------------------------------------------------

test('SSE: a reconnect with Last-Event-ID replays every missed event, in order, exactly once, then a replayed frame', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const seed = await postEvent(baseUrl, messageEvent('evt_replay_seed'));
    assert.equal(seed.status, 202);

    const missedIds = Array.from({ length: 50 }, (_, i) => `evt_replay_missed_${String(i).padStart(3, '0')}`);
    for (const id of missedIds) {
      assert.equal((await postEvent(baseUrl, messageEvent(id))).status, 202);
    }

    const response = await fetch(`${baseUrl}/api/v1/events/stream`, { headers: { 'Last-Event-ID': 'evt_replay_seed' } });
    const reader = response.body.getReader();
    try {
      const text = await readUntil(reader, (t) => t.includes('event: replayed'));
      assert.deepEqual(frameIds(text), missedIds, 'every missed event, in insertion order, exactly once');
      const replayedLine = text.slice(text.indexOf('event: replayed'));
      const payload = JSON.parse(replayedLine.split('\n')[1].slice('data: '.length));
      assert.deepEqual(payload, { schemaVersion: '1.0', cursor: 'evt_replay_seed', replayed: 50, lastEventId: missedIds.at(-1) });
    } finally {
      await reader.cancel();
    }
  } finally {
    server.close();
  }
});

test('SSE: the same replay works from the lastEventId query parameter', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    assert.equal((await postEvent(baseUrl, messageEvent('evt_replay_q_seed'))).status, 202);
    assert.equal((await postEvent(baseUrl, messageEvent('evt_replay_q_missed'))).status, 202);

    const response = await fetch(`${baseUrl}/api/v1/events/stream?lastEventId=evt_replay_q_seed`);
    const reader = response.body.getReader();
    try {
      const text = await readUntil(reader, (t) => t.includes('event: replayed'));
      assert.deepEqual(frameIds(text), ['evt_replay_q_missed']);
    } finally {
      await reader.cancel();
    }
  } finally {
    server.close();
  }
});

test('SSE: a reconnect that missed nothing gets replayed with replayed: 0 and lastEventId: null', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    assert.equal((await postEvent(baseUrl, messageEvent('evt_replay_none'))).status, 202);
    const response = await fetch(`${baseUrl}/api/v1/events/stream`, { headers: { 'Last-Event-ID': 'evt_replay_none' } });
    const reader = response.body.getReader();
    try {
      const text = await readUntil(reader, (t) => t.includes('event: replayed'));
      assert.deepEqual(frameIds(text), []);
      const payload = JSON.parse(text.slice(text.indexOf('event: replayed')).split('\n')[1].slice('data: '.length));
      assert.deepEqual(payload, { schemaVersion: '1.0', cursor: 'evt_replay_none', replayed: 0, lastEventId: null });
    } finally {
      await reader.cancel();
    }
  } finally {
    server.close();
  }
});

test('SSE: an unknown cursor gets resync cursor_unknown, missed null, and no event frames replayed', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    assert.equal((await postEvent(baseUrl, messageEvent('evt_resync_marker'))).status, 202);
    const response = await fetch(`${baseUrl}/api/v1/events/stream`, { headers: { 'Last-Event-ID': 'evt_never_stored' } });
    const reader = response.body.getReader();
    try {
      const text = await readUntil(reader, (t) => t.includes('event: resync'));
      assert.deepEqual(frameIds(text), [], 'no event frames, not even unrelated ones');
      const payload = JSON.parse(text.slice(text.indexOf('event: resync')).split('\n')[1].slice('data: '.length));
      assert.equal(payload.reason, 'cursor_unknown');
      assert.equal(payload.missed, null);
      assert.equal(payload.snapshotPath, '/api/v1/snapshot');
    } finally {
      await reader.cancel();
    }
  } finally {
    server.close();
  }
});

test('SSE: a live event stored while a reconnect replay is in flight is delivered exactly once, after the replayed frame', async () => {
  const { server, baseUrl } = await startTestServer();
  const realListBetween = store.listBetween.bind(store);
  try {
    assert.equal((await postEvent(baseUrl, messageEvent('evt_inflight_seed'))).status, 202);
    assert.equal((await postEvent(baseUrl, messageEvent('evt_inflight_missed'))).status, 202);

    let releaseReplay;
    const gate = new Promise((resolve) => { releaseReplay = resolve; });
    let gated = false;
    store.listBetween = async (...args) => {
      if (!gated) {
        gated = true;
        await gate;
      }
      return realListBetween(...args);
    };

    const responsePromise = fetch(`${baseUrl}/api/v1/events/stream`, { headers: { 'Last-Event-ID': 'evt_inflight_seed' } });
    // Give the reconnect time to reach the gated listBetween call before the live event is stored.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await postEvent(baseUrl, messageEvent('evt_inflight_live'))).status, 202);
    releaseReplay();

    const response = await responsePromise;
    const reader = response.body.getReader();
    try {
      const text = await readUntil(reader, (t) => t.includes('evt_inflight_live'));
      const ids = frameIds(text);
      assert.deepEqual(ids, ['evt_inflight_missed', 'evt_inflight_live'], 'the live event arrives once, after the replayed one');
      const replayedIndex = text.indexOf('event: replayed');
      const liveIndex = text.indexOf('id: evt_inflight_live');
      assert.ok(replayedIndex >= 0 && replayedIndex < liveIndex, 'the live event arrives after the replayed frame');
    } finally {
      await reader.cancel();
    }
  } finally {
    store.listBetween = realListBetween;
    server.close();
  }
});

test('SSE: a client that disconnects during a replay is removed from clients (clientsConnected returns to its previous value)', async () => {
  const { server, baseUrl } = await startTestServer();
  const realListBetween = store.listBetween.bind(store);
  try {
    assert.equal((await postEvent(baseUrl, messageEvent('evt_cancel_seed'))).status, 202);
    assert.equal((await postEvent(baseUrl, messageEvent('evt_cancel_missed'))).status, 202);

    const before = await (await fetch(`${baseUrl}/health`)).json();

    let releaseReplay;
    const gate = new Promise((resolve) => { releaseReplay = resolve; });
    let gated = false;
    store.listBetween = async (...args) => {
      if (!gated) {
        gated = true;
        await gate;
      }
      return realListBetween(...args);
    };

    const controller = new AbortController();
    const responsePromise = fetch(`${baseUrl}/api/v1/events/stream`, {
      headers: { 'Last-Event-ID': 'evt_cancel_seed' },
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const mid = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(mid.clientsConnected, before.clientsConnected + 1, 'counted as connected while replaying');

    controller.abort();
    await responsePromise.catch(() => {});
    releaseReplay();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const after = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(after.clientsConnected, before.clientsConnected, 'removed once the client disconnects mid-replay');
  } finally {
    store.listBetween = realListBetween;
    server.close();
  }
});

test('SSE: /health exposes the sse counters, and they go up after a replay and after a resync', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const before = await (await fetch(`${baseUrl}/health`)).json();
    assert.ok(before.sse);
    assert.equal(typeof before.sse.replayMax, 'number');

    assert.equal((await postEvent(baseUrl, messageEvent('evt_health_seed'))).status, 202);
    assert.equal((await postEvent(baseUrl, messageEvent('evt_health_missed'))).status, 202);
    const replay = await fetch(`${baseUrl}/api/v1/events/stream`, { headers: { 'Last-Event-ID': 'evt_health_seed' } });
    const replayReader = replay.body.getReader();
    await readUntil(replayReader, (t) => t.includes('event: replayed'));
    await replayReader.cancel();

    const resync = await fetch(`${baseUrl}/api/v1/events/stream`, { headers: { 'Last-Event-ID': 'evt_never_stored_health' } });
    const resyncReader = resync.body.getReader();
    await readUntil(resyncReader, (t) => t.includes('event: resync'));
    await resyncReader.cancel();

    const after = await (await fetch(`${baseUrl}/health`)).json();
    assert.ok(after.sse.replaysSinceStart > before.sse.replaysSinceStart);
    assert.ok(after.sse.eventsReplayedSinceStart >= before.sse.eventsReplayedSinceStart + 1);
    assert.ok(after.sse.resyncsSinceStart > before.sse.resyncsSinceStart);
  } finally {
    server.close();
  }
});

// -------------------------------------------------------------
// AGENT_VIEWER_SSE_REPLAY_MAX is read once at startup: these scenarios need their own server process.
// -------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverEntry = path.join(repoRoot, 'server', 'index.ts');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

function waitForOutput(child, output, check, timeoutMs = 15_000) {
  if (check(output())) return Promise.resolve(output());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not reach the expected state:\n${output()}`)), timeoutMs);
    const onData = () => {
      if (!check(output())) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      resolve(output());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Server exited before the expected state (code ${code}, signal ${signal}):\n${output()}`));
    });
  });
}

async function startReplayMaxServer(replayMax) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-replay-max-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), AGENT_VIEWER_STORAGE: 'memory' };
  delete env.NODE_ENV;
  delete env.npm_lifecycle_event;
  delete env.AGENT_VIEWER_API_TOKEN;
  delete env.AGENT_VIEWER_API_KEY;
  delete env.AGENT_VIEWER_WEBHOOK_SECRET;
  if (replayMax !== undefined) env.AGENT_VIEWER_SSE_REPLAY_MAX = replayMax;
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), serverEntry], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const output = () => `${stdout}${stderr}`;
  return { cwd, child, output, baseUrl: `http://127.0.0.1:${port}`, port };
}

async function stopReplayMaxServer(run) {
  if (run.child.exitCode === null && run.child.signalCode === null) {
    const closed = new Promise((resolve) => run.child.once('close', resolve));
    run.child.kill('SIGTERM');
    await closed;
  }
  rmSync(run.cwd, { recursive: true, force: true });
}

test('SSE: AGENT_VIEWER_SSE_REPLAY_MAX bounds the replay; past it, the client gets resync gap_too_large and no event frames', { timeout: 30_000 }, async () => {
  const run = await startReplayMaxServer('5');
  try {
    await waitForOutput(run.child, run.output, (out) => out.includes('Agent Viewer ingestion server listening'));

    assert.equal((await postEvent(run.baseUrl, messageEvent('evt_max_seed'))).status, 202);
    for (let i = 0; i < 10; i++) {
      assert.equal((await postEvent(run.baseUrl, messageEvent(`evt_max_missed_${i}`))).status, 202);
    }

    const response = await fetch(`${run.baseUrl}/api/v1/events/stream`, { headers: { 'Last-Event-ID': 'evt_max_seed' } });
    const reader = response.body.getReader();
    const text = await readUntil(reader, (t) => t.includes('event: resync'));
    assert.deepEqual(frameIds(text), [], 'no event frames from the gap');
    const payload = JSON.parse(text.slice(text.indexOf('event: resync')).split('\n')[1].slice('data: '.length));
    assert.deepEqual(payload.reason, 'gap_too_large');
    assert.equal(payload.missed, 10);
    assert.equal(payload.replayMax, 5);

    // The server keeps the connection open and streaming live events after a resync.
    assert.equal((await postEvent(run.baseUrl, messageEvent('evt_max_live'))).status, 202);
    const liveText = await readUntil(reader, (t) => t.includes('evt_max_live'));
    assert.ok(liveText.includes('id: evt_max_live'));
    await reader.cancel();
  } finally {
    await stopReplayMaxServer(run);
  }
});

test('SSE: AGENT_VIEWER_SSE_REPLAY_MAX=0 resyncs on any missed event and replays 0 when nothing was missed', { timeout: 30_000 }, async () => {
  const run = await startReplayMaxServer('0');
  try {
    await waitForOutput(run.child, run.output, (out) => out.includes('Agent Viewer ingestion server listening'));

    assert.equal((await postEvent(run.baseUrl, messageEvent('evt_zero_seed'))).status, 202);

    const nothingMissed = await fetch(`${run.baseUrl}/api/v1/events/stream`, { headers: { 'Last-Event-ID': 'evt_zero_seed' } });
    const nothingReader = nothingMissed.body.getReader();
    const nothingText = await readUntil(nothingReader, (t) => t.includes('event: replayed'));
    const nothingPayload = JSON.parse(nothingText.slice(nothingText.indexOf('event: replayed')).split('\n')[1].slice('data: '.length));
    assert.deepEqual(nothingPayload, { schemaVersion: '1.0', cursor: 'evt_zero_seed', replayed: 0, lastEventId: null });
    await nothingReader.cancel();

    assert.equal((await postEvent(run.baseUrl, messageEvent('evt_zero_missed'))).status, 202);
    const someMissed = await fetch(`${run.baseUrl}/api/v1/events/stream`, { headers: { 'Last-Event-ID': 'evt_zero_seed' } });
    const someReader = someMissed.body.getReader();
    const someText = await readUntil(someReader, (t) => t.includes('event: resync'));
    assert.deepEqual(frameIds(someText), []);
    const somePayload = JSON.parse(someText.slice(someText.indexOf('event: resync')).split('\n')[1].slice('data: '.length));
    assert.equal(somePayload.reason, 'gap_too_large');
    assert.equal(somePayload.missed, 1);
    await someReader.cancel();
  } finally {
    await stopReplayMaxServer(run);
  }
});

test('AGENT_VIEWER_SSE_REPLAY_MAX with an invalid value stops startup with a message naming the variable', { timeout: 30_000 }, async () => {
  const run = await startReplayMaxServer('abc');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server did not exit:\n${run.output()}`)), 15_000);
      run.child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    assert.notEqual(run.child.exitCode, 0);
    assert.match(run.output(), /AGENT_VIEWER_SSE_REPLAY_MAX must be a non-negative integer, got "abc"/);
  } finally {
    await stopReplayMaxServer(run);
  }
});

test('SSE: the first chunk after connect carries ": connected" and a heartbeat whose data parses to { retention } (issue #53)', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const response = await fetch(`${baseUrl}/api/v1/events/stream`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const initial = await reader.read();
    const text = decoder.decode(initial.value);
    assert.ok(text.includes(': connected'));
    assert.ok(text.includes('event: heartbeat'));

    const match = text.match(/event: heartbeat\ndata: (\{.*\})\n\n/);
    assert.ok(match, `expected a heartbeat frame in: ${JSON.stringify(text)}`);
    const payload = JSON.parse(match[1]);
    assert.ok(payload.retention, 'the first heartbeat must carry retention, not an empty payload');
    assert.equal(payload.retention.storage, 'memory');
    assert.equal(payload.retention.maxEvents, 10000);
    assert.equal(typeof payload.retention.retainedEvents, 'number');
    assert.equal(typeof payload.retention.acceptedEvents, 'number');
    assert.equal(typeof payload.retention.droppedEvents, 'number');
    assert.equal(typeof payload.retention.totalsSince, 'number');

    await reader.cancel();
  } finally {
    server.close();
  }
});
