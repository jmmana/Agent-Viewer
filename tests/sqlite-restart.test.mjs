// Issue #52: an end-to-end restart test at the HTTP level. A real server process is spawned (own process, like
// tests/server-startup-warning.test.mjs and tests/sqlite-http.test.mjs) against a SQLite file, a mixed fixture is
// ingested through the public API, the process is stopped and a second process is started on the same file. The
// derived-state bodies must be identical before and after: the whole point of the startup rebuild is that a
// restart is invisible to a client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

function baseEnv(port, dbFile) {
  const env = {
    ...process.env,
    PORT: String(port),
    AGENT_VIEWER_STORAGE: 'sqlite',
    AGENT_VIEWER_SQLITE_PATH: dbFile,
    AGENT_VIEWER_SQLITE_BACKUP: 'off',
  };
  delete env.NODE_ENV;
  delete env.npm_lifecycle_event;
  delete env.AGENT_VIEWER_API_TOKEN;
  delete env.AGENT_VIEWER_API_KEY;
  delete env.AGENT_VIEWER_WEBHOOK_SECRET;
  return env;
}

function spawnServer(cwd, env) {
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), serverEntry], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, output: () => `${stdout}${stderr}` };
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

async function waitForReady(baseUrl, deadlineMs = 20_000) {
  const deadline = Date.now() + deadlineMs;
  let body;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/ready`);
    body = await response.json();
    if (response.status === 200) return body;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server never became ready: ${JSON.stringify(body)}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.kill('SIGTERM');
  await closed;
}

async function postEvent(baseUrl, event) {
  const response = await fetch(`${baseUrl}/api/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  assert.equal(response.status, 202, `expected ${event.id} to be accepted: ${JSON.stringify(await response.json().catch(() => null))}`);
}

/** Ingests a fixture through the public HTTP API: an agent, a runtime, a session, a task, a meeting and usage. */
async function ingestFixture(baseUrl) {
  const agentRes = await fetch(`${baseUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'writer-1', name: 'Writer One', roleTitle: 'Senior Writer', role: 'writer', provider: 'Anthropic', model: 'claude-sonnet', status: 'CODING', statusText: 'Drafting' }),
  });
  assert.equal(agentRes.status, 201);

  const runtimeRes = await fetch(`${baseUrl}/api/v1/runtimes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'rt-1', name: 'Runtime One', framework: 'langgraph', version: '1.0.0' }),
  });
  assert.equal(runtimeRes.status, 201);

  let t = 1_700_000_000_000;
  const at = () => (t += 1);

  await postEvent(baseUrl, {
    schemaVersion: '1.0',
    id: 'evt_restart_msg_1',
    type: 'agent.message.sent',
    timestamp: at(),
    runtimeId: 'rt-1',
    sessionId: 'session-1',
    source: 'agent:writer-1',
    agentId: 'writer-1',
    severity: 'normal',
    summary: 'Hello',
    payload: { text: 'hi' },
  });

  await postEvent(baseUrl, {
    schemaVersion: '1.0',
    id: 'evt_restart_task_1',
    type: 'task.progress',
    timestamp: at(),
    taskId: 'task-1',
    agentId: 'writer-1',
    source: 'agent:writer-1',
    severity: 'normal',
    summary: 'Task started',
    payload: { taskId: 'task-1', title: 'Write the report', progress: 50 },
  });

  await postEvent(baseUrl, {
    schemaVersion: '1.0',
    id: 'evt_restart_meeting_1',
    type: 'meeting.started',
    timestamp: at(),
    source: 'agent:writer-1',
    severity: 'normal',
    summary: 'Standup started',
    payload: { meetingId: 'meeting-1', title: 'Standup', participantIds: ['writer-1'] },
  });

  await postEvent(baseUrl, {
    schemaVersion: '1.0',
    id: 'evt_restart_usage_1',
    type: 'llm.usage',
    timestamp: at(),
    agentId: 'writer-1',
    source: 'agent:writer-1',
    severity: 'normal',
    summary: 'Usage',
    payload: { provider: 'Anthropic', model: 'claude-sonnet', inputTokens: 100, outputTokens: 50, cost: 0.02, currency: 'USD', costSource: 'provider-reported' },
  });

  // A profile-only rename, through PATCH, with no status change: this only survives a restart if #52's
  // `agent.updated` emission covers it (previously only a status change left an event behind).
  const patchRes = await fetch(`${baseUrl}/api/v1/agents/writer-1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Writer One Renamed', statusText: 'Editing' }),
  });
  assert.equal(patchRes.status, 200);
}

/** Reads every derived-state body this test checks for parity, with volatile fields stripped. */
async function readDerivedState(baseUrl) {
  const snapshotRes = await fetch(`${baseUrl}/api/v1/snapshot`);
  assert.equal(snapshotRes.status, 200);
  const snapshot = await snapshotRes.json();
  delete snapshot.timestamp;

  const runtimesRes = await fetch(`${baseUrl}/api/v1/runtimes`);
  assert.equal(runtimesRes.status, 200);

  const sessionsRes = await fetch(`${baseUrl}/api/v1/sessions`);
  assert.equal(sessionsRes.status, 200);

  const sessionDetailRes = await fetch(`${baseUrl}/api/v1/sessions/session-1`);
  assert.equal(sessionDetailRes.status, 200);

  return {
    snapshot,
    runtimes: await runtimesRes.json(),
    sessions: await sessionsRes.json(),
    sessionDetail: await sessionDetailRes.json(),
  };
}

test('restart with a populated SQLite database: derived state survives a stop and restart unchanged', { timeout: 40_000 }, async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-restart-'));
  const dbFile = path.join(cwd, 'restart.db');

  try {
    // First process: ingest the fixture.
    const portBefore = await getFreePort();
    const before = spawnServer(cwd, baseEnv(portBefore, dbFile));
    const baseUrlBefore = `http://127.0.0.1:${portBefore}`;
    let beforeState;
    try {
      await waitForListening(before.child, before.output);
      const readyAtBoot = await waitForReady(baseUrlBefore);
      assert.equal(readyAtBoot.rebuild.totalEvents, 0, 'a brand-new database has nothing to replay');

      await ingestFixture(baseUrlBefore);
      beforeState = await readDerivedState(baseUrlBefore);

      // An agent known only from stored events answers 200, not 404, even before a restart.
      assert.equal(beforeState.snapshot.agents.find((a) => a.id === 'writer-1')?.name, 'Writer One Renamed');
    } finally {
      await stopChild(before.child);
    }

    // Second process, same database file: everything must come back from the startup rebuild alone.
    const portAfter = await getFreePort();
    const after = spawnServer(cwd, baseEnv(portAfter, dbFile));
    const baseUrlAfter = `http://127.0.0.1:${portAfter}`;
    try {
      await waitForListening(after.child, after.output);
      const readyAfterRestart = await waitForReady(baseUrlAfter);
      assert.equal(readyAfterRestart.ready, true);
      assert.equal(readyAfterRestart.rebuild.state, 'done');
      assert.ok(readyAfterRestart.rebuild.totalEvents > 0, 'the restarted process found the stored events');
      assert.equal(readyAfterRestart.rebuild.skippedEvents, 0);

      const afterState = await readDerivedState(baseUrlAfter);
      assert.deepEqual(afterState.snapshot, beforeState.snapshot, 'snapshot (ignoring timestamp) is identical after a restart');
      assert.deepEqual(afterState.runtimes, beforeState.runtimes, 'runtimes are identical after a restart');
      assert.deepEqual(afterState.sessions, beforeState.sessions, 'sessions are identical after a restart');
      assert.deepEqual(afterState.sessionDetail, beforeState.sessionDetail, 'a session detail is identical after a restart');

      // PATCH on an agent known only from the rebuilt state answers 200, not 404 (acceptance criterion of #52).
      const patchAfterRestart = await fetch(`${baseUrlAfter}/api/v1/agents/writer-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ statusText: 'Still editing' }),
      });
      assert.equal(patchAfterRestart.status, 200);
    } finally {
      await stopChild(after.child);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
