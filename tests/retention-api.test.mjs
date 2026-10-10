// Issue #70: GET /api/v1/admin/retention. The store is created when `server/index.ts` is imported (same as
// every other route), so this spawns the server as a child process with the env under test, the pattern of
// `tests/server-startup-warning.test.mjs`. The job's own startup delay is 30s by default, so these tests check
// the endpoint's shape and validation immediately after boot (a "never run yet" server) rather than waiting for
// a real purge; `tests/retention-job.test.mjs` covers what a completed run looks like, with mock timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverEntry = path.join(repoRoot, 'server', 'index.ts');

function waitForOutput(child, output, check) {
  if (check(output())) return Promise.resolve(output());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start:\n${output()}`)), 15_000);
    const onData = () => {
      if (!check(output())) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      resolve(output());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before startup (code ${code}, signal ${signal}):\n${output()}`));
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function startServerProcess(env) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-retention-api-'));
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
  const ready = waitForOutput(child, output, (all) => /listening on .+ port \d+/.test(all));
  return { cwd, child, output, ready };
}

async function stopServerProcess(run) {
  if (run.child.exitCode === null && run.child.signalCode === null) {
    const closed = new Promise((resolve) => run.child.once('close', resolve));
    run.child.kill('SIGTERM');
    await closed;
  }
  rmSync(run.cwd, { recursive: true, force: true });
}

function baseEnv(port, extra = {}) {
  const env = { ...process.env, PORT: String(port), AGENT_VIEWER_STORAGE: 'memory' };
  delete env.NODE_ENV;
  delete env.npm_lifecycle_event;
  delete env.AGENT_VIEWER_API_TOKEN;
  delete env.AGENT_VIEWER_API_KEY;
  delete env.AGENT_VIEWER_WEBHOOK_SECRET;
  delete env.AGENT_VIEWER_HOST;
  delete env.AGENT_VIEWER_ALLOW_OPEN;
  delete env.AGENT_VIEWER_RETENTION_DAYS;
  delete env.AGENT_VIEWER_USAGE_RETENTION_DAYS;
  delete env.AGENT_VIEWER_RETENTION_INTERVAL_MINUTES;
  return { ...env, ...extra };
}

function portFromUrl(output) {
  const match = output.match(/port (\d+)/);
  return Number(match[1]);
}

test('GET /api/v1/admin/retention: requires the API token when one is configured', { timeout: 30_000 }, async () => {
  const run = startServerProcess(baseEnv(0, { AGENT_VIEWER_API_TOKEN: 'secret-token' }));
  try {
    const output = await run.ready;
    const port = portFromUrl(output);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/v1/admin/retention`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/api/v1/admin/retention`, {
      headers: { Authorization: 'Bearer secret-token' },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await stopServerProcess(run);
  }
});

test('GET /api/v1/admin/retention: documented shape with both windows unset, memory storage, never run yet', { timeout: 30_000 }, async () => {
  const run = startServerProcess(baseEnv(0));
  try {
    const output = await run.ready;
    const port = portFromUrl(output);
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/admin/retention`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.schemaVersion, '1.0');
    assert.equal(body.storage, 'memory');
    assert.equal(typeof body.now, 'number');
    assert.equal(body.intervalMinutes, 60);

    for (const scope of [body.events, body.usageLedger]) {
      assert.equal(scope.windowDays, null);
      assert.equal(scope.policy, 'keep');
      assert.equal(scope.count, 0, 'a real zero, not null, for an empty table');
      assert.equal(scope.oldestReceivedAt, null);
      assert.equal(scope.purgedBefore, null);
      assert.equal(scope.lastCutoffMs, null);
      assert.equal(scope.lastDeleted, null);
      assert.equal(scope.deletedTotal, 0);
      assert.equal(scope.totalDeletedSinceStart, null, 'null because the window is not configured for this process');
    }
    assert.equal(body.lastRun, null);
    assert.deepEqual(body.runs, []);
  } finally {
    await stopServerProcess(run);
  }
});

test('GET /api/v1/admin/retention: an enabled window reports policy "purge" and a real (non-null) totalDeletedSinceStart', { timeout: 30_000 }, async () => {
  const run = startServerProcess(baseEnv(0, { AGENT_VIEWER_RETENTION_DAYS: '30', AGENT_VIEWER_RETENTION_INTERVAL_MINUTES: '5' }));
  try {
    const output = await run.ready;
    const port = portFromUrl(output);
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/admin/retention`);
    const body = await response.json();
    assert.equal(body.intervalMinutes, 5);
    assert.equal(body.events.windowDays, 30);
    assert.equal(body.events.policy, 'purge');
    assert.equal(body.events.totalDeletedSinceStart, 0, 'configured but no run has finished yet: a real zero');
    assert.equal(body.usageLedger.windowDays, null);
    assert.equal(body.usageLedger.policy, 'keep');
    assert.equal(body.usageLedger.totalDeletedSinceStart, null);
  } finally {
    await stopServerProcess(run);
  }
});

test('GET /api/v1/admin/retention: limit bounds and a 400 for an invalid value', { timeout: 30_000 }, async () => {
  const run = startServerProcess(baseEnv(0));
  try {
    const output = await run.ready;
    const port = portFromUrl(output);
    for (const bad of ['0', '-1', '201', 'abc', '1.5']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/admin/retention?limit=${bad}`);
      assert.equal(response.status, 400, bad);
      const body = await response.json();
      assert.equal(body.error, 'invalid_limit');
    }
    for (const good of ['1', '200', '20']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/admin/retention?limit=${good}`);
      assert.equal(response.status, 200, good);
    }
  } finally {
    await stopServerProcess(run);
  }
});

test('server startup: an invalid retention window aborts with a clear message naming the variable and range, exit 1', { timeout: 30_000 }, async () => {
  const run = startServerProcess(baseEnv(0, { AGENT_VIEWER_RETENTION_DAYS: '0' }));
  run.ready.catch(() => {});
  const code = await new Promise((resolve) => run.child.once('close', resolve));
  assert.equal(code, 1);
  assert.match(run.output(), /AGENT_VIEWER_RETENTION_DAYS must be an integer from 1 to 36500 \(got "0"\)/);
  rmSync(run.cwd, { recursive: true, force: true });
});

test('server startup: an invalid retention interval aborts with exit 1', { timeout: 30_000 }, async () => {
  const run = startServerProcess(baseEnv(0, { AGENT_VIEWER_RETENTION_INTERVAL_MINUTES: '1441' }));
  run.ready.catch(() => {});
  const code = await new Promise((resolve) => run.child.once('close', resolve));
  assert.equal(code, 1);
  assert.match(run.output(), /AGENT_VIEWER_RETENTION_INTERVAL_MINUTES must be an integer from 1 to 1440/);
  rmSync(run.cwd, { recursive: true, force: true });
});

test('server startup: an enabled usage ledger window logs the one-line startup warning', { timeout: 30_000 }, async () => {
  const run = startServerProcess(baseEnv(0, { AGENT_VIEWER_USAGE_RETENTION_DAYS: '90' }));
  try {
    await run.ready;
    assert.match(
      run.output(),
      /\[agent-viewer\] usage ledger retention is enabled \(90 days\): consumption rows older than that are deleted for good/
    );
  } finally {
    await stopServerProcess(run);
  }
});
