import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverEntry = path.join(repoRoot, 'server', 'index.ts');

async function waitForOutput(child, output, check) {
  if (check(output())) return output();
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
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-startup-'));
  // Resolve tsx from the repository (the child runs from an empty temp directory, with no node_modules of
  // its own, so dotenv also finds no developer .env file to load there).
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
  return { cwd, child, output, ready: waitForOutput(child, output, (all) => all.includes('Agent Viewer ingestion server listening')) };
}

function serverEnv(port, token, extra = {}) {
  const env = { ...process.env, PORT: String(port), AGENT_VIEWER_STORAGE: 'memory' };
  delete env.NODE_ENV;
  delete env.npm_lifecycle_event;
  delete env.AGENT_VIEWER_API_TOKEN;
  delete env.AGENT_VIEWER_API_KEY;
  delete env.AGENT_VIEWER_WEBHOOK_SECRET;
  delete env.AGENT_VIEWER_HOST;
  delete env.AGENT_VIEWER_ALLOW_OPEN;
  if (token !== undefined) env.AGENT_VIEWER_API_TOKEN = token;
  return { ...env, ...extra };
}

test('direct server startup warns once when API auth is open and stays quiet with a token', { timeout: 40_000 }, async () => {
  for (const token of [undefined, 'protected-token']) {
    const port = 0;
    const run = startServerProcess(serverEnv(port, token));
    try {
      const output = await run.ready;
      assert.match(output, /listening on 127\.0\.0\.1, port \d+ \(http:\/\/127\.0\.0\.1:\d+\)/);
      const warnings = output.match(/WARNING: AGENT_VIEWER_API_TOKEN is not set/g) ?? [];
      assert.equal(warnings.length, token ? 0 : 1);
      if (!token) {
        assert.match(output, /Listening on 127\.0\.0\.1 only, port \d+/);
        assert.match(output, /Webhooks are open too/);
        assert.doesNotMatch(output, /protected-token/);
      }
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) {
        const closed = new Promise((resolve) => run.child.once('close', resolve));
        run.child.kill('SIGTERM');
        await closed;
      }
      rmSync(run.cwd, { recursive: true, force: true });
    }
  }
});

// Issue #71: binding a non-loopback interface with no token is now a hard refusal, not just a warning.
test('direct server startup refuses a non-loopback bind without a token, and exits 1', { timeout: 40_000 }, async () => {
  const run = startServerProcess(serverEnv(0, undefined, { AGENT_VIEWER_HOST: '0.0.0.0' }));
  // The process exits before ever printing the "listening" marker `run.ready` waits for, so that promise
  // always rejects here; it is not awaited, but it must still be handled to avoid an unhandled rejection.
  run.ready.catch(() => {});
  const closed = new Promise((resolve) => run.child.once('close', (code) => resolve(code)));
  const code = await closed;
  assert.equal(code, 1);
  assert.match(
    run.output(),
    /Refusing to listen on 0\.0\.0\.0:\d+ without AGENT_VIEWER_API_TOKEN/
  );
  rmSync(run.cwd, { recursive: true, force: true });
});

test('direct server startup binds a non-loopback interface with a token, or with AGENT_VIEWER_ALLOW_OPEN=1', {
  timeout: 40_000,
}, async () => {
  for (const extra of [{ AGENT_VIEWER_HOST: '0.0.0.0' }, { AGENT_VIEWER_HOST: '0.0.0.0', AGENT_VIEWER_ALLOW_OPEN: '1' }]) {
    const token = extra.AGENT_VIEWER_ALLOW_OPEN ? undefined : 'network-token';
    const run = startServerProcess(serverEnv(0, token, extra));
    try {
      const output = await run.ready;
      assert.doesNotMatch(output, /Refusing to listen/);
      if (!token) {
        assert.match(output, /WARNING: AGENT_VIEWER_API_TOKEN is not set/);
      }
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) {
        const closedRun = new Promise((resolve) => run.child.once('close', resolve));
        run.child.kill('SIGTERM');
        await closedRun;
      }
      rmSync(run.cwd, { recursive: true, force: true });
    }
  }
});
