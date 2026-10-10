import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApiToken, startBanner } from '../docker/api-entrypoint.mjs';
import { healthUrl } from '../docker/healthcheck.mjs';
import { parseCliArgs } from '../cli/args.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tempDir = () => mkdtempSync(path.join(os.tmpdir(), 'av-docker-'));

test('API image: blank variables never start the API without a token; a generated one is saved and reused', () => {
  const dir = tempDir();
  try {
    const tokenFile = path.join(dir, 'data', 'api-token');
    const env = { AGENT_VIEWER_API_TOKEN: '  ', AGENT_VIEWER_API_KEY: '', AGENT_VIEWER_TOKEN_FILE: tokenFile };
    const first = resolveApiToken(env);
    assert.equal(first.source, 'generated');
    assert.equal(first.saved, true);
    assert.match(first.token, /^av_[\w-]{32}$/);
    assert.equal(readFileSync(tokenFile, 'utf8').trim(), first.token);
    if (process.platform !== 'win32') assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
    assert.match(startBanner(first).join('\n'), new RegExp(`API token: ${first.token}`));

    const again = resolveApiToken(env);
    assert.deepEqual({ token: again.token, source: again.source }, { token: first.token, source: 'file' }, 'a restart keeps the token');

    assert.deepEqual(resolveApiToken({ ...env, AGENT_VIEWER_API_TOKEN: ' chosen ' }).token, 'chosen');
    assert.deepEqual(startBanner(resolveApiToken({ ...env, AGENT_VIEWER_API_TOKEN: 'chosen' })), [], 'a chosen token is not printed');
    assert.equal(resolveApiToken({ AGENT_VIEWER_API_KEY: 'old', AGENT_VIEWER_TOKEN_FILE: tokenFile }).source, 'legacy-env');

    // An unwritable location still gets a token, and the banner says it changes on restart.
    writeFileSync(path.join(dir, 'blocker'), '');
    const unsaved = resolveApiToken({ AGENT_VIEWER_TOKEN_FILE: path.join(dir, 'blocker', 'api-token') });
    assert.equal(unsaved.saved, false);
    assert.match(unsaved.token, /^av_/);
    assert.match(startBanner(unsaved).join('\n'), /changes on every restart/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Issue #71: the server now refuses a non-loopback bind with no token, so the API image must set
// AGENT_VIEWER_HOST=0.0.0.0 explicitly, or its published port would stop being reachable from outside the
// container (the entrypoint always resolves a real token, so the refusal itself never fires there).
test('API image: the api stage ENV includes AGENT_VIEWER_HOST=0.0.0.0', () => {
  const dockerfile = readFileSync(path.join(repoRoot, 'docker', 'Dockerfile'), 'utf8');
  const stages = dockerfile.split(/^FROM /m);
  const apiStage = stages.find((stage) => / AS api\b/.test(stage.split('\n')[0]));
  assert.ok(apiStage, 'the Dockerfile has an "api" stage');
  // The stage ends at the next FROM (already split away) or EOF, so this slice is the whole api stage body.
  assert.match(apiStage, /AGENT_VIEWER_HOST=0\.0\.0\.0/);
});

/** Runs docker/app-entrypoint.sh with a stand-in CLI that prints the arguments it receives. */
function entrypointArgs(args) {
  const dir = tempDir();
  try {
    const fake = path.join(dir, 'cli.js');
    writeFileSync(fake, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    const result = spawnSync('sh', [path.join(repoRoot, 'docker', 'app-entrypoint.sh'), ...args], {
      env: { ...process.env, AGENT_VIEWER_CLI: fake },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('App image: flags passed to docker run are added to the defaults, which come from PORT and AGENT_VIEWER_HOST', { skip: process.platform === 'win32' }, () => {
  const imageEnv = { PORT: '8787', AGENT_VIEWER_HOST: '0.0.0.0' };
  const plain = entrypointArgs([]);
  assert.deepEqual(plain, ['start', '--no-open']);
  assert.deepEqual(parseCliArgs(plain, '/app', imageEnv), {
    command: 'start', port: 8787, host: '0.0.0.0', token: undefined, demo: false, open: false, record: undefined,
  });

  // The case that used to bind 127.0.0.1 inside the container.
  const withToken = parseCliArgs(entrypointArgs(['--token', 'abc']), '/app', imageEnv);
  assert.equal(withToken.host, '0.0.0.0');
  assert.equal(withToken.token, 'abc');
  assert.equal(withToken.open, false);

  assert.equal(parseCliArgs(entrypointArgs(['--demo']), '/app', { ...imageEnv, PORT: '9000' }).port, 9000);
  assert.equal(parseCliArgs(entrypointArgs(['start', '--port', '9100']), '/app', imageEnv).port, 9100);
  assert.deepEqual(entrypointArgs(['send', '--agent', 'a', '--status', 'done']), ['send', '--agent', 'a', '--status', 'done']);
  assert.deepEqual(entrypointArgs(['--version']), ['--version']);
});

test('App image: the health check follows the port the server really listens on', () => {
  const home = tempDir();
  try {
    assert.equal(healthUrl({ AGENT_VIEWER_HOME: home, PORT: '8787' }), 'http://127.0.0.1:8787/health');
    writeFileSync(path.join(home, 'session.json'), JSON.stringify({ url: 'http://0.0.0.0:9100', token: 't', pid: 1, startedAt: 0 }));
    assert.equal(healthUrl({ AGENT_VIEWER_HOME: home, PORT: '8787' }), 'http://127.0.0.1:9100/health');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('API image: the entry point starts the server with a printed token, and /api/v1 refuses requests without it', { timeout: 60_000 }, async () => {
  const dir = tempDir();
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    NODE_ENV: 'production',
    AGENT_VIEWER_API_TOKEN: '',
    AGENT_VIEWER_STORAGE: 'memory',
    AGENT_VIEWER_TOKEN_FILE: path.join(dir, 'api-token'),
  };
  delete env.AGENT_VIEWER_API_KEY;
  const child = spawn(process.execPath, [path.join(repoRoot, 'docker', 'api-entrypoint.mjs')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const base = `http://127.0.0.1:${port}`;
    let healthy = false;
    for (let attempt = 0; attempt < 200 && !healthy; attempt += 1) {
      try {
        healthy = (await fetch(`${base}/health`)).ok;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(healthy, true, stdout);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.auth, 'token');
    const token = /API token: (\S+)/.exec(stdout)?.[1];
    assert.ok(token, stdout);
    assert.equal(readFileSync(path.join(dir, 'api-token'), 'utf8').trim(), token);
    assert.doesNotMatch(stderr, /WARNING: AGENT_VIEWER_API_TOKEN is not set/);
    assert.equal((await fetch(`${base}/api/v1/snapshot`)).status, 401);
    assert.equal((await fetch(`${base}/api/v1/snapshot`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  } finally {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});
