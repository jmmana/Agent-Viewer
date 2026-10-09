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

function serverEnv(port, token) {
  const env = { ...process.env, PORT: String(port), AGENT_VIEWER_STORAGE: 'memory' };
  delete env.NODE_ENV;
  delete env.npm_lifecycle_event;
  delete env.AGENT_VIEWER_API_TOKEN;
  delete env.AGENT_VIEWER_API_KEY;
  delete env.AGENT_VIEWER_WEBHOOK_SECRET;
  if (token !== undefined) env.AGENT_VIEWER_API_TOKEN = token;
  return env;
}

test('direct server startup warns once when API auth is open and stays quiet with a token', { timeout: 40_000 }, async () => {
  for (const token of [undefined, 'protected-token']) {
    const port = 0;
    const run = startServerProcess(serverEnv(port, token));
    try {
      const output = await run.ready;
      assert.match(output, /listening on every interface, port \d+/);
      const warnings = output.match(/WARNING: AGENT_VIEWER_API_TOKEN is not set/g) ?? [];
      assert.equal(warnings.length, token ? 0 : 1);
      if (!token) {
        assert.match(output, /Listening on every interface, port \d+/);
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
