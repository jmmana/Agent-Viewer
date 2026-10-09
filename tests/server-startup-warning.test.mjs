import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

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

async function startServer(env) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-startup-'));
  const child = spawn(process.execPath, ['--import', path.join(repoRoot, 'node_modules/tsx/dist/loader.mjs'), path.join(repoRoot, 'server/index.ts')], {
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
    const port = await freePort();
    const run = await startServer(serverEnv(port, token));
    try {
      const output = await run.ready;
      assert.match(output, new RegExp(`listening on every interface, port ${port}`));
      const warnings = output.match(/WARNING: AGENT_VIEWER_API_TOKEN is not set/g) ?? [];
      assert.equal(warnings.length, token ? 0 : 1);
      if (!token) {
        assert.match(output, new RegExp(`Listening on every interface, port ${port}`));
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
