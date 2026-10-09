// Issue #52: HTTP-level readiness gating while a SQLite startup rebuild is running. A real server process is
// spawned (own process, like tests/server-startup-warning.test.mjs) against a pre-seeded SQLite file, with a
// small rebuild page size and an artificial per-page delay, so the rebuild is slow enough to observe in flight.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLiteEventStore } from '../server/store.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverEntry = path.join(repoRoot, 'server', 'index.ts');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Seeds a SQLite file with `count` real, accepted events through the store itself, so the schema and content are
 * exactly what the server would have written. */
async function seedDb(file, count) {
  const store = new SQLiteEventStore(file, { backup: 'off' });
  try {
    for (let i = 0; i < count; i++) {
      const result = await store.append({
        schemaVersion: '1.0',
        id: `evt_seed_${i}`,
        type: 'agent.registered',
        timestamp: i + 1,
        agentId: `seed-agent-${i}`,
        source: `agent:seed-agent-${i}`,
        severity: 'normal',
        summary: 'seed',
        payload: { id: `seed-agent-${i}`, name: `Seed Agent ${i}` },
      });
      assert.equal(result.outcome, 'accepted');
    }
  } finally {
    await store.close();
  }
}

async function waitForListening(child, output) {
  if (/ingestion server listening/.test(output())) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start:\n${output()}`)), 15_000);
    const onData = () => {
      if (!/ingestion server listening/.test(output())) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before startup (code ${code}, signal ${signal}):\n${output()}`));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGTERM');
  await closed;
}

test('GET /ready and the derived-state routes answer 503 store_rebuilding while a slow SQLite rebuild runs, then 200', { timeout: 30_000 }, async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-sqlite-http-'));
  const dbFile = path.join(cwd, 'seeded.db');
  await seedDb(dbFile, 20);

  const port = await getFreePort();
  const env = {
    ...process.env,
    PORT: String(port),
    AGENT_VIEWER_STORAGE: 'sqlite',
    AGENT_VIEWER_SQLITE_PATH: dbFile,
    AGENT_VIEWER_SQLITE_BACKUP: 'off',
    // One row per page, 50ms between pages: 20 events take about 1s to replay, long enough to observe in flight.
    AGENT_VIEWER_REBUILD_PAGE_SIZE: '1',
    AGENT_VIEWER_REBUILD_PAGE_DELAY_MS: '50',
  };
  delete env.NODE_ENV;
  delete env.npm_lifecycle_event;
  delete env.AGENT_VIEWER_API_TOKEN;
  delete env.AGENT_VIEWER_API_KEY;
  delete env.AGENT_VIEWER_WEBHOOK_SECRET;

  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), serverEntry], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const output = () => `${stdout}${stderr}`;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForListening(child, output);

    // /health is the liveness probe: it must answer 200 for the whole rebuild.
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);

    const readyDuring = await fetch(`${baseUrl}/ready`);
    assert.equal(readyDuring.status, 503);
    assert.equal(readyDuring.headers.get('retry-after'), '1');
    const readyDuringBody = await readyDuring.json();
    assert.equal(readyDuringBody.ok, false);
    assert.equal(readyDuringBody.ready, false);
    assert.equal(readyDuringBody.rebuild.state, 'running');
    assert.equal(readyDuringBody.rebuild.totalEvents, 20);

    const snapshotDuring = await fetch(`${baseUrl}/api/v1/snapshot`);
    assert.equal(snapshotDuring.status, 503);
    assert.equal(snapshotDuring.headers.get('retry-after'), '1');
    const snapshotDuringBody = await snapshotDuring.json();
    assert.equal(snapshotDuringBody.error, 'store_rebuilding');
    assert.ok(snapshotDuringBody.rebuild);

    const patchDuring = await fetch(`${baseUrl}/api/v1/agents/whoever`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'CODING' }),
    });
    assert.equal(patchDuring.status, 503);
    assert.equal((await patchDuring.json()).error, 'store_rebuilding');

    const postRuntimeDuring = await fetch(`${baseUrl}/api/v1/runtimes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'rt-during' }),
    });
    assert.equal(postRuntimeDuring.status, 503);
    assert.equal((await postRuntimeDuring.json()).error, 'store_rebuilding');

    // Writes stay open during the rebuild: accepted and persisted, applied once the rebuild (or a later restart)
    // reaches them.
    const postEventDuring = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'evt_during_rebuild',
        type: 'agent.message.sent',
        timestamp: Date.now(),
        source: 'agent:during',
        agentId: 'during',
        summary: 'sent while rebuilding',
        payload: { text: 'hi' },
      }),
    });
    assert.equal(postEventDuring.status, 202);

    // Poll until the rebuild finishes.
    const deadline = Date.now() + 20_000;
    let readyBody;
    while (Date.now() < deadline) {
      const response = await fetch(`${baseUrl}/ready`);
      readyBody = await response.json();
      if (response.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(readyBody.ok, true);
    assert.equal(readyBody.ready, true);
    assert.equal(readyBody.rebuild.state, 'done');
    assert.equal(readyBody.rebuild.skippedEvents, 0);
    assert.ok(readyBody.rebuild.processedEvents >= 21, 'the 20 seeded events plus the one posted mid-rebuild');
    assert.ok(typeof readyBody.rebuild.durationMs === 'number' && readyBody.rebuild.durationMs >= 0);

    const snapshotAfter = await fetch(`${baseUrl}/api/v1/snapshot`);
    assert.equal(snapshotAfter.status, 200);
    const snapshotAfterBody = await snapshotAfter.json();
    assert.equal(snapshotAfterBody.agents.length, 21);
    assert.ok(snapshotAfterBody.agents.some((a) => a.id === 'seed-agent-0'));
  } finally {
    await stopChild(child);
    rmSync(cwd, { recursive: true, force: true });
  }
});
