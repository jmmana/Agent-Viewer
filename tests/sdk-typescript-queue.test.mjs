// Tests for the TypeScript SDK's durable local queue / spool (issue #102).
//
// Shared cross-language vectors (transient classification, spool file naming, drain response handling) live
// in `tests/fixtures/sdk-queue-scenarios.json` and are documented in `docs/sdk-queue.md`; the Python SDK
// (#101, `tests/test_python_sdk_spool.py`) loads and passes the same vectors so the two implementations
// cannot silently drift apart. `Spool`'s fields and private `AgentViewer` methods used below for white-box
// assertions are TypeScript `private` (compile-time only, not `#private`), so plain property access from this
// plain-JS test file reaches them exactly as the Python suite reaches `viewer._spool`.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { app } from '../server/index.ts';
import {
  AgentViewer,
  AgentViewerError,
  computeSpoolFileName,
  isTransientHttpStatus,
  TransientNetworkError,
} from '../sdk/typescript/index.ts';

const vectorsPath = fileURLToPath(new URL('./fixtures/sdk-queue-scenarios.json', import.meta.url));
const SCENARIOS = JSON.parse(readFileSync(vectorsPath, 'utf8'));

const DISABLED_SPOOL_STATS = {
  state: 'disabled',
  pendingEvents: 0,
  pendingBytes: 0,
  oldestPendingAgeS: null,
  enqueuedTotal: 0,
  replayedTotal: 0,
  duplicatesAckedTotal: 0,
  droppedOverflowTotal: 0,
  droppedOverflowUsageTotal: 0,
  droppedSpoolErrorTotal: 0,
  droppedSpoolErrorUsageTotal: 0,
  rejectedTotal: 0,
  rejectedUsageTotal: 0,
  rejectedEvictedTotal: 0,
  corruptSpoolTotal: 0,
  lastError: null,
  lastSuccessAt: null,
};

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

function startRealServerOnPort(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function stopServer(server) {
  // `server.close()` alone waits out Node's default 5s keep-alive timeout for any still-open socket
  // (undici's fetch keeps the connection alive by default); force them closed so tests do not pay that cost.
  const result = new Promise((resolve) => server.close(() => resolve()));
  server.closeAllConnections?.();
  return result;
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-spool-test-'));
}

function readSpoolRows(spoolPath) {
  const db = new DatabaseSync(spoolPath, { readOnly: true });
  try {
    return db.prepare('SELECT seq, event_id, event_type, event_json FROM spool ORDER BY seq ASC').all();
  } finally {
    db.close();
  }
}

/** Mirrors Python's `_ScriptedBatchHandler`: answers every POST with the next scripted
 * `{status, body, headers}`, cycling to the last one once exhausted. `abruptClose: true` destroys the
 * socket with no response instead, simulating a connection reset mid-request. */
function startScriptedServer(responses, { abruptClose = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(Buffer.concat(chunks));
      if (abruptClose) {
        req.socket.destroy();
        return;
      }
      const index = Math.min(requests.length - 1, responses.length - 1);
      const { status, body, headers } = responses[index];
      const responseBody = Buffer.from(JSON.stringify(body ?? {}));
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': String(responseBody.length),
        ...(headers || {}),
      });
      res.end(responseBody);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}`, requests });
    });
  });
}

function minimalEvent(id, type) {
  return { id, type, agentId: 'a', payload: {} };
}

// -------------------------------------------------------------------------------------------------------
// Shared vectors
// -------------------------------------------------------------------------------------------------------

test('TypeScript SDK queue: isTransientHttpStatus matches every status-kind case of the shared transientClassification vectors', () => {
  for (const c of SCENARIOS.transientClassification.cases) {
    if (c.kind !== 'status') continue;
    assert.equal(isTransientHttpStatus(c.status), c.transient, c.name);
  }
});

test('TypeScript SDK queue: computeSpoolFileName matches the shared spoolFileNaming vectors', () => {
  for (const c of SCENARIOS.spoolFileNaming.cases) {
    const name = computeSpoolFileName(c.url, c.runtimeId || undefined);
    assert.equal(name, `spool-${c.expectedHashPrefix}.sqlite3`, `${c.url}|${c.runtimeId}`);
  }
});

// -------------------------------------------------------------------------------------------------------
// Disabled spool is a legacy no-op
// -------------------------------------------------------------------------------------------------------

test('TypeScript SDK queue: with no spoolDir, every stat is zeroed/disabled and flush/close are no-ops', async () => {
  const viewer = new AgentViewer({ url: 'http://localhost:8787' });
  assert.deepEqual(viewer.spoolStats(), DISABLED_SPOOL_STATS);
  assert.deepEqual(await viewer.flush(), { delivered: 0, remaining: 0, rejected: 0, timedOut: false, state: 'disabled' });
  assert.deepEqual(viewer.spoolRejected(), []);
  await viewer.close(); // must not throw
});

test('TypeScript SDK queue: default behavior is unchanged, emit() still throws AgentViewerError when the server is down', async () => {
  const port = await getFreePort();
  const viewer = new AgentViewer({ url: `http://127.0.0.1:${port}`, maxRetries: 0, timeoutMs: 500 });
  await assert.rejects(
    () => viewer.emit({ type: 'agent.status.changed', agentId: 's', payload: { status: 'IDLE' } }),
    AgentViewerError
  );
});

test('TypeScript SDK queue: invalid constructor options throw synchronously at construction time', () => {
  assert.throws(() => new AgentViewer({ spoolMaxEvents: 0 }));
  assert.throws(() => new AgentViewer({ spoolMaxBytes: 0 }));
  assert.throws(() => new AgentViewer({ spoolOverflow: 'drop_random' }));
  assert.throws(() => new AgentViewer({ spoolBatchSize: 0 }));
  assert.throws(() => new AgentViewer({ spoolBatchSize: 101 }));
});

// -------------------------------------------------------------------------------------------------------
// Enqueue when the server is down
// -------------------------------------------------------------------------------------------------------

test('TypeScript SDK queue: emit() does not throw and queues on disk when the server is down', async () => {
  const port = await getFreePort();
  const dir = mkTmpDir();
  const viewer = new AgentViewer({ url: `http://127.0.0.1:${port}`, maxRetries: 1, timeoutMs: 500, spoolDir: dir, spoolBackground: false });
  const result = await viewer.emit(minimalEvent('evt_down_1', 'agent.status.changed'));
  assert.deepEqual(result, { accepted: false, queued: true, duplicate: false, id: 'evt_down_1' });
  assert.deepEqual(readSpoolRows(viewer.spool.path).map((r) => r.event_id), ['evt_down_1']);
  await viewer.close(50);
});

test('TypeScript SDK queue: emitBatch() queues each normalized event individually, in list order', async () => {
  const port = await getFreePort();
  const dir = mkTmpDir();
  const viewer = new AgentViewer({ url: `http://127.0.0.1:${port}`, maxRetries: 1, timeoutMs: 500, spoolDir: dir, spoolBackground: false });
  const result = await viewer.emitBatch([
    minimalEvent('evt_b1', 'tool.started'),
    minimalEvent('evt_b2', 'tool.started'),
  ]);
  assert.deepEqual(result, { accepted: false, queued: true, total: 2, ids: ['evt_b1', 'evt_b2'] });
  assert.equal(viewer.spoolStats().pendingEvents, 2);
  await viewer.close(50);
});

test('TypeScript SDK queue: once backlogged, emit() appends behind the backlog without attempting a live send', async () => {
  const port = await getFreePort();
  const dir = mkTmpDir();
  const viewer = new AgentViewer({ url: `http://127.0.0.1:${port}`, maxRetries: 2, timeoutMs: 500, spoolDir: dir, spoolBackground: false });
  // First call pays the normal retry budget before it discovers the server is down.
  await viewer.emit(minimalEvent('evt_t1', 'agent.status.changed'));

  let liveCallAttempted = false;
  viewer.postWithRetry = async () => {
    liveCallAttempted = true;
    throw new Error('a backlogged emit() must never attempt a live send');
  };
  const start = Date.now();
  await viewer.emit(minimalEvent('evt_t2', 'agent.status.changed'));
  const elapsed = Date.now() - start;

  assert.equal(liveCallAttempted, false);
  assert.ok(elapsed < 200, `a backlogged emit() must return immediately, took ${elapsed}ms`);
  assert.deepEqual(readSpoolRows(viewer.spool.path).map((r) => r.event_id), ['evt_t1', 'evt_t2']);
  await viewer.close(50);
});

test('TypeScript SDK queue: re-emitting a queued id is a no-op, not a new row or an overflow drop', async () => {
  const port = await getFreePort();
  const dir = mkTmpDir();
  const viewer = new AgentViewer({ url: `http://127.0.0.1:${port}`, maxRetries: 1, timeoutMs: 500, spoolDir: dir, spoolBackground: false });
  await viewer.emit(minimalEvent('evt_dup', 'agent.status.changed'));
  const result2 = await viewer.emit(minimalEvent('evt_dup', 'agent.status.changed'));
  assert.equal(result2.queued, true);
  assert.equal(viewer.spoolStats().pendingEvents, 1);
  assert.equal(viewer.spoolStats().droppedOverflowTotal, 0);
  await viewer.close(50);
});

// -------------------------------------------------------------------------------------------------------
// Overflow policy
// -------------------------------------------------------------------------------------------------------

test('TypeScript SDK queue: drop_oldest evicts non-usage rows before ever touching a usage row', async () => {
  const port = await getFreePort();
  const dir = mkTmpDir();
  const viewer = new AgentViewer({
    url: `http://127.0.0.1:${port}`,
    maxRetries: 0,
    timeoutMs: 500,
    spoolDir: dir,
    spoolBackground: false,
    spoolMaxEvents: 3,
    spoolOverflow: 'drop_oldest',
  });

  await viewer.emit(minimalEvent('evt_usage_1', 'llm.usage'));
  await viewer.emit(minimalEvent('evt_tool_1', 'tool.started'));
  await viewer.emit(minimalEvent('evt_tool_2', 'tool.started'));
  // Cap is 3, all 3 slots full: a 4th event must evict a non-usage row first, never the usage row.
  await viewer.emit(minimalEvent('evt_tool_3', 'tool.started'));

  let ids = readSpoolRows(viewer.spool.path).map((r) => r.event_id);
  assert.ok(ids.includes('evt_usage_1'), 'usage must survive while any non-usage row remains');
  assert.ok(!ids.includes('evt_tool_1'), 'the oldest non-usage row is evicted first');
  let stats = viewer.spoolStats();
  assert.equal(stats.droppedOverflowTotal, 1);
  assert.equal(stats.droppedOverflowUsageTotal, 0);

  // Evict every remaining non-usage row with more usage inserts, then force a usage eviction once the
  // backlog is usage-only.
  await viewer.emit(minimalEvent('evt_usage_2', 'llm.usage'));
  await viewer.emit(minimalEvent('evt_usage_3', 'llm.usage'));
  ids = readSpoolRows(viewer.spool.path).map((r) => r.event_id);
  assert.deepEqual(ids, ['evt_usage_1', 'evt_usage_2', 'evt_usage_3'], 'every non-usage row is gone but evt_usage_1 survived as long as one was left');

  await viewer.emit(minimalEvent('evt_usage_4', 'llm.usage'));
  ids = readSpoolRows(viewer.spool.path).map((r) => r.event_id);
  assert.ok(!ids.includes('evt_usage_1'), 'with no non-usage rows left, the oldest usage row is evicted');
  assert.ok(ids.includes('evt_usage_4'));
  assert.equal(viewer.spoolStats().droppedOverflowUsageTotal, 1);
  await viewer.close(50);
});

test('TypeScript SDK queue: drop_newest refuses the incoming event and evicts nothing', async () => {
  const port = await getFreePort();
  const dir = mkTmpDir();
  const viewer = new AgentViewer({
    url: `http://127.0.0.1:${port}`,
    maxRetries: 0,
    timeoutMs: 500,
    spoolDir: dir,
    spoolBackground: false,
    spoolMaxEvents: 2,
    spoolOverflow: 'drop_newest',
  });
  await viewer.emit(minimalEvent('evt_a', 'tool.started'));
  await viewer.emit(minimalEvent('evt_b', 'tool.started'));
  const result = await viewer.emit(minimalEvent('evt_c', 'tool.started'));
  assert.deepEqual(result, { accepted: false, queued: false, dropped: true, id: 'evt_c' });
  assert.deepEqual(readSpoolRows(viewer.spool.path).map((r) => r.event_id), ['evt_a', 'evt_b']);
  assert.equal(viewer.spoolStats().droppedOverflowTotal, 1);
  await viewer.close(50);
});

test('TypeScript SDK queue: a single event larger than spoolMaxBytes is refused under either policy, never queued', async () => {
  const port = await getFreePort();
  const dir = mkTmpDir();
  const viewer = new AgentViewer({
    url: `http://127.0.0.1:${port}`,
    maxRetries: 0,
    timeoutMs: 500,
    spoolDir: dir,
    spoolBackground: false,
    spoolMaxBytes: 100,
  });
  const result = await viewer.emit({ id: 'evt_huge', type: 'agent.message.sent', agentId: 'a', payload: { text: 'x'.repeat(1000) } });
  assert.deepEqual(result, { accepted: false, queued: false, dropped: true, id: 'evt_huge' });
  assert.equal(viewer.spoolStats().pendingEvents, 0);
  assert.equal(viewer.spoolStats().droppedOverflowTotal, 1);
  await viewer.close(50);
});

test('TypeScript SDK queue: overflow counters persist in the spool file across a restart', async () => {
  const port = await getFreePort();
  const dir = mkTmpDir();
  const opts = {
    url: `http://127.0.0.1:${port}`,
    maxRetries: 0,
    timeoutMs: 500,
    spoolDir: dir,
    spoolBackground: false,
    spoolMaxEvents: 1,
    spoolOverflow: 'drop_newest',
  };
  const viewer1 = new AgentViewer(opts);
  await viewer1.emit(minimalEvent('evt_r1', 'tool.started'));
  await viewer1.emit(minimalEvent('evt_r2', 'tool.started')); // refused, counted
  assert.equal(viewer1.spoolStats().droppedOverflowTotal, 1);
  await viewer1.close(50);

  const viewer2 = new AgentViewer(opts);
  assert.equal(viewer2.spoolStats().droppedOverflowTotal, 1, 'counters survive a restart');
  assert.equal(viewer2.spoolStats().pendingEvents, 1);
  await viewer2.close(50);
});

// -------------------------------------------------------------------------------------------------------
// Drain response handling: drives sendAndResolve() directly against every case of the shared fixture, so
// the TypeScript drain algorithm and the documented cross-language contract cannot silently drift apart.
// -------------------------------------------------------------------------------------------------------

test('TypeScript SDK queue: sendAndResolve() matches every case of the shared drainResponseHandling fixture', async () => {
  for (const c of SCENARIOS.drainResponseHandling.cases) {
    const dir = mkTmpDir();
    const n = c.chunkSeqs.length;
    const viewer = new AgentViewer({
      url: 'http://127.0.0.1:1',
      maxRetries: 0,
      timeoutMs: 500,
      spoolDir: dir,
      spoolBackground: false,
      spoolMaxEvents: 1000,
      spoolMaxBytes: 10_000_000,
    });
    for (let i = 1; i <= n; i++) {
      const event = { id: `evt_${i}`, type: 'tool.started', payload: {} };
      viewer.spool.enqueue(event, JSON.stringify(event));
    }

    const response = c.response;
    if ('networkError' in response) {
      viewer.rawBatchRequest = async () => {
        throw new TransientNetworkError(response.networkError);
      };
    } else {
      viewer.rawBatchRequest = async () => ({
        status: response.status,
        body: response.body ?? {},
        headers: new Headers(response.headers || {}),
      });
    }

    const batch = viewer.spool.peekBatch(n);
    const outcome = await viewer.sendAndResolve(batch);

    const remainingIds = new Set(readSpoolRows(viewer.spool.path).map((r) => r.event_id));
    const allIds = new Set(Array.from({ length: n }, (_, i) => `evt_${i + 1}`));
    const deletedIds = new Set(c.expectedDeletedSeqs.map((seq) => `evt_${seq}`));
    const expectedRemaining = new Set([...allIds].filter((id) => !deletedIds.has(id)));
    assert.deepEqual(remainingIds, expectedRemaining, c.name);

    const rejectedIds = new Set(viewer.spool.rejected(1000).map((r) => r.eventId));
    const expectedRejected = new Set(c.expectedRejectedSeqs.map((seq) => `evt_${seq}`));
    assert.deepEqual(rejectedIds, expectedRejected, c.name);

    if (c.expectedAction === 'retry_with_backoff') {
      assert.equal(outcome.stop, 'backoff', c.name);
    } else if (c.expectedAction === 'stop_auth_failed') {
      assert.equal(outcome.stop, 'auth_failed', c.name);
    } else {
      assert.equal(outcome.stop, null, c.name);
    }

    if ('retryAfterSeconds' in c) {
      assert.equal(outcome.backoffSeconds ?? null, c.retryAfterSeconds, c.name);
    }
    if ('nextChunkSize' in c) {
      assert.equal(viewer.spoolChunkSize, c.nextChunkSize, c.name);
    }

    const deltas = c.counterDeltas || {};
    if ('replayed_total' in deltas) assert.equal(outcome.delivered, deltas.replayed_total, c.name);
    if ('duplicates_acked_total' in deltas) assert.equal(outcome.duplicates, deltas.duplicates_acked_total, c.name);
    if ('rejected_total' in deltas) assert.equal(outcome.rejected, deltas.rejected_total, c.name);

    // Short timeout: `sendAndResolve` was called directly above, bypassing the drainer, so there is nothing
    // left to flush; a short bound just avoids leaving a background retry loop running into later tests.
    await viewer.close(50);
  }
});

// -------------------------------------------------------------------------------------------------------
// Poison events, 413, rate limiting and auth: end to end against a real HTTP server (scripted responses)
// -------------------------------------------------------------------------------------------------------

test('TypeScript SDK queue: a poison event in a batch is dead-lettered by index, the rest are delivered', async () => {
  const { server, url } = await startScriptedServer([
    { status: 400, body: { error: 'validation_failed', errors: [{ index: 1, issues: [{ path: 'payload.x', message: 'bad' }] }] } },
    { status: 202, body: { results: [{ id: 'evt_1', status: 'accepted', duplicate: false }, { id: 'evt_3', status: 'accepted', duplicate: false }] } },
  ]);
  try {
    const dir = mkTmpDir();
    const viewer = new AgentViewer({ url, maxRetries: 0, timeoutMs: 2000, spoolDir: dir, spoolBackground: false, spoolBatchSize: 10 });
    for (let i = 1; i <= 3; i++) {
      const event = { id: `evt_${i}`, type: 'tool.started', payload: {} };
      viewer.spool.enqueue(event, JSON.stringify(event));
    }
    const result = await viewer.flush(5000);
    assert.equal(result.delivered, 2);
    assert.equal(result.rejected, 1);
    assert.equal(result.remaining, 0);
    const rejected = viewer.spoolRejected();
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].eventId, 'evt_2');
    assert.ok(rejected[0].reason.includes('bad'));
    await viewer.close();
  } finally {
    await stopServer(server);
  }
});

test('TypeScript SDK queue: 413 halves the batch and eventually delivers everything', async () => {
  const { server, url } = await startScriptedServer([
    { status: 413, body: { error: 'batch_too_large' } },
    { status: 202, body: { results: [{ id: 'evt_1', status: 'accepted', duplicate: false }] } },
    { status: 202, body: { results: [{ id: 'evt_2', status: 'accepted', duplicate: false }] } },
  ]);
  try {
    const dir = mkTmpDir();
    const viewer = new AgentViewer({ url, maxRetries: 0, timeoutMs: 2000, spoolDir: dir, spoolBackground: false, spoolBatchSize: 10 });
    for (let i = 1; i <= 2; i++) {
      const event = { id: `evt_${i}`, type: 'tool.started', payload: {} };
      viewer.spool.enqueue(event, JSON.stringify(event));
    }
    const result = await viewer.flush(5000);
    assert.equal(result.delivered, 2);
    assert.equal(result.remaining, 0);
    assert.equal(viewer.spoolChunkSize, 1);
    await viewer.close();
  } finally {
    await stopServer(server);
  }
});

test('TypeScript SDK queue: a 413 at chunk size 1 dead-letters that one event with reason containing "413"', async () => {
  const { server, url } = await startScriptedServer([{ status: 413, body: { error: 'batch_too_large' } }]);
  try {
    const dir = mkTmpDir();
    const viewer = new AgentViewer({ url, maxRetries: 0, timeoutMs: 2000, spoolDir: dir, spoolBackground: false, spoolBatchSize: 1 });
    const event = { id: 'evt_solo', type: 'tool.started', payload: {} };
    viewer.spool.enqueue(event, JSON.stringify(event));
    const result = await viewer.flush(5000);
    assert.equal(result.rejected, 1);
    assert.equal(result.remaining, 0);
    const rejected = viewer.spoolRejected();
    assert.equal(rejected[0].eventId, 'evt_solo');
    assert.ok(rejected[0].reason.includes('413'));
    await viewer.close();
  } finally {
    await stopServer(server);
  }
});

test('TypeScript SDK queue: 429 with Retry-After backs off and still delivers, nothing lost', async () => {
  const { server, url } = await startScriptedServer([
    { status: 429, body: { error: 'rate_limit_exceeded' }, headers: { 'Retry-After': '1' } },
    { status: 202, body: { results: [{ id: 'evt_1', status: 'accepted', duplicate: false }] } },
  ]);
  try {
    const dir = mkTmpDir();
    const viewer = new AgentViewer({
      url,
      maxRetries: 0,
      timeoutMs: 2000,
      spoolDir: dir,
      spoolBackground: false,
      spoolProbeInterval: 0.1,
      spoolMaxProbeInterval: 2,
    });
    const event = { id: 'evt_1', type: 'tool.started', payload: {} };
    viewer.spool.enqueue(event, JSON.stringify(event));
    const result = await viewer.flush(5000);
    assert.equal(result.delivered, 1);
    assert.equal(result.remaining, 0);
    await viewer.close();
  } finally {
    await stopServer(server);
  }
});

test('TypeScript SDK queue: 401 keeps every event and stops draining; a corrected token delivers them', async () => {
  let authorizedToken = 'right-token';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      Buffer.concat(chunks);
      if (req.headers.authorization !== `Bearer ${authorizedToken}`) {
        const body = Buffer.from(JSON.stringify({ error: 'unauthorized' }));
        res.writeHead(401, { 'content-type': 'application/json', 'content-length': String(body.length) });
        res.end(body);
        return;
      }
      const body = Buffer.from(JSON.stringify({ results: [{ id: 'evt_1', status: 'accepted', duplicate: false }] }));
      res.writeHead(202, { 'content-type': 'application/json', 'content-length': String(body.length) });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const dir = mkTmpDir();
    const viewer1 = new AgentViewer({
      url,
      token: 'wrong-token',
      maxRetries: 0,
      timeoutMs: 2000,
      spoolDir: dir,
      spoolBackground: false,
      spoolMaxProbeInterval: 60,
    });
    const event = { id: 'evt_1', type: 'tool.started', payload: {} };
    viewer1.spool.enqueue(event, JSON.stringify(event));
    const result1 = await viewer1.flush(2000);
    assert.equal(result1.state, 'auth_failed');
    assert.equal(result1.remaining, 1);
    assert.equal(viewer1.spoolStats().pendingEvents, 1, 'every event is kept on a 401');
    await viewer1.close();

    // A fresh instance with the corrected token, pointed at the same spool dir/url, picks up the backlog.
    const viewer2 = new AgentViewer({
      url,
      token: 'right-token',
      maxRetries: 0,
      timeoutMs: 2000,
      spoolDir: dir,
      spoolBackground: false,
      spoolMaxProbeInterval: 60,
    });
    assert.equal(viewer2.spoolStats().pendingEvents, 1);
    const result2 = await viewer2.flush(5000);
    assert.equal(result2.delivered, 1);
    assert.equal(result2.remaining, 0);
    assert.equal(result2.state, 'idle');
    await viewer2.close();
  } finally {
    await stopServer(server);
  }
});

// -------------------------------------------------------------------------------------------------------
// flush()/close(): idempotency, and a real round trip against the actual server (byte-identical replay,
// registration-before-usage ordering, original id/timestamp preserved)
// -------------------------------------------------------------------------------------------------------

test('TypeScript SDK queue: close() is idempotent and performs a final bounded flush', async () => {
  const { server, url } = await startScriptedServer([
    { status: 202, body: { results: [{ id: 'evt_1', status: 'accepted', duplicate: false }] } },
  ]);
  try {
    const dir = mkTmpDir();
    const viewer = new AgentViewer({ url, maxRetries: 0, timeoutMs: 2000, spoolDir: dir, spoolBackground: false });
    const event = { id: 'evt_1', type: 'tool.started', payload: {} };
    viewer.spool.enqueue(event, JSON.stringify(event));
    const spoolPath = viewer.spool.path;
    await viewer.close();
    await viewer.close(); // must not throw the second time
    const remaining = readSpoolRows(spoolPath).length;
    assert.equal(remaining, 0, 'close() flushed the pending event before releasing the spool');
  } finally {
    await stopServer(server);
  }
});

test('TypeScript SDK queue: events queued while the server is down are delivered once it is up, in order, with original id/timestamp, agent.registered first', async () => {
  const port = await getFreePort();
  const dir = mkTmpDir();
  const viewer = new AgentViewer({
    url: `http://127.0.0.1:${port}`,
    maxRetries: 0,
    timeoutMs: 500,
    spoolDir: dir,
    spoolBackground: false,
    runtimeId: 'queue-order-test',
  });
  const agent = viewer.agent('coder');
  // No cost, cachedTokens, reasoningTokens or currency given: must stay absent in the stored JSON, never 0.
  await agent.usage({ provider: 'OpenAI', model: 'gpt-4o', inputTokens: 10, outputTokens: 5 });

  const rowsBefore = readSpoolRows(viewer.spool.path);
  assert.equal(rowsBefore.length, 2, 'agent.registered then llm.usage, both queued');
  assert.equal(rowsBefore[0].event_type, 'agent.registered');
  assert.equal(rowsBefore[1].event_type, 'llm.usage');
  const storedUsage = JSON.parse(rowsBefore[1].event_json);
  // `cost` is a required-but-nullable field in the canonical contract (`costSchema`), so the SDK always
  // sends it explicitly as `null` rather than omitting it; `cachedTokens`/`reasoningTokens`/`currency` are
  // genuinely optional and must stay absent (never defaulted to 0) when not given.
  assert.equal(storedUsage.payload.cost, null);
  assert.ok(!('cachedTokens' in storedUsage.payload));
  assert.ok(!('reasoningTokens' in storedUsage.payload));
  assert.ok(!('currency' in storedUsage.payload));
  assert.equal(storedUsage.payload.inputTokens, 10);
  const originalUsageId = storedUsage.id;
  const originalUsageTimestamp = storedUsage.timestamp;

  const server = await startRealServerOnPort(port);
  try {
    const result = await viewer.flush(5000);
    assert.equal(result.delivered, 2);
    assert.equal(result.remaining, 0);

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/events?agentId=coder&limit=10`);
    const body = await response.json();
    const types = body.events.map((e) => e.type);
    assert.deepEqual(types.sort(), ['agent.registered', 'llm.usage'].sort());
    const usageEvent = body.events.find((e) => e.type === 'llm.usage');
    assert.equal(usageEvent.id, originalUsageId, 'the original id survives the outage');
    assert.equal(usageEvent.timestamp, originalUsageTimestamp, 'the original timestamp survives the outage');
    assert.equal(usageEvent.payload.inputTokens, 10);
    assert.equal(usageEvent.payload.cost, null);
  } finally {
    await viewer.close();
    await stopServer(server);
  }
});

// -------------------------------------------------------------------------------------------------------
// Process restart with pending events (file spool only)
// -------------------------------------------------------------------------------------------------------

test('TypeScript SDK queue: the spool survives a SIGKILL between enqueue and delivery; a fresh process delivers it', async () => {
  const port = await getFreePort();
  const dir = mkTmpDir();
  const childScript = `
    import { AgentViewer } from ${JSON.stringify(path.resolve('sdk/typescript/index.ts'))};
    const viewer = new AgentViewer({
      url: 'http://127.0.0.1:${port}',
      maxRetries: 0,
      timeoutMs: 500,
      spoolDir: ${JSON.stringify(dir)},
      spoolBackground: false,
    });
    await viewer.emit({ id: 'evt_persist_1', type: 'agent.status.changed', agentId: 's', payload: { status: 'IDLE' } });
    console.log('ENQUEUED');
    // No close(): the process is about to be killed, simulating a crash with no graceful shutdown.
    await new Promise(() => {});
  `;
  const scriptPath = path.join(dir, '_child.mjs');
  fs.writeFileSync(scriptPath, childScript);

  const child = spawn('npx', ['tsx', scriptPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('child did not report ENQUEUED in time')), 10_000);
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      if (buf.includes('ENQUEUED')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));

  const viewer2 = new AgentViewer({
    url: `http://127.0.0.1:${port}`,
    maxRetries: 0,
    timeoutMs: 2000,
    spoolDir: dir,
    spoolBackground: false,
  });
  assert.equal(viewer2.spoolStats().pendingEvents, 1, 'the event from the killed process is still on disk');

  const server = await startRealServerOnPort(port);
  try {
    const result = await viewer2.flush(5000);
    assert.equal(result.delivered, 1);
    assert.equal(result.remaining, 0);
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/events?agentId=s&limit=10`);
    const body = await response.json();
    assert.deepEqual(body.events.map((e) => e.id), ['evt_persist_1']);
  } finally {
    await viewer2.close();
    await stopServer(server);
  }
});

// -------------------------------------------------------------------------------------------------------
// Transient vs conclusive classification against the real retry loop
// -------------------------------------------------------------------------------------------------------

test('TypeScript SDK queue: a transient failure (connection refused) still throws when the spool is disabled, and the error is marked transient', async () => {
  const port = await getFreePort();
  const viewer = new AgentViewer({ url: `http://127.0.0.1:${port}`, maxRetries: 0, timeoutMs: 500 });
  await assert.rejects(
    () => viewer.emit(minimalEvent('evt_x', 'agent.status.changed')),
    (err) => err instanceof AgentViewerError && err.transient === true
  );
});

test('TypeScript SDK queue: a conclusive 400 is never queued, even with the spool enabled', async () => {
  const { server, url } = await startScriptedServer([{ status: 400, body: { error: 'validation_failed' } }]);
  try {
    const dir = mkTmpDir();
    const viewer = new AgentViewer({ url, maxRetries: 2, timeoutMs: 2000, spoolDir: dir, spoolBackground: false });
    await assert.rejects(
      () => viewer.emit(minimalEvent('evt_bad', 'agent.status.changed')),
      (err) => err instanceof AgentViewerError && err.transient === false
    );
    assert.equal(viewer.spoolStats().pendingEvents, 0, 'a conclusive 4xx is never written to the spool');
    await viewer.close();
  } finally {
    await stopServer(server);
  }
});
