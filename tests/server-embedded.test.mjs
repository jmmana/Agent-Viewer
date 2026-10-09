import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The hooks the CLI uses: the module reads AGENT_VIEWER_EMBEDDED on import, so set it before importing.
process.env.AGENT_VIEWER_EMBEDDED = '1';
process.env.AGENT_VIEWER_API_TOKEN = 'embedded-token';
delete process.env.AGENT_VIEWER_API_KEY;
delete process.env.AGENT_VIEWER_WEBHOOK_SECRET;
const { onEventAccepted, startServer } = await import('../server/index.ts');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverEntry = path.join(repoRoot, 'server', 'index.ts');
const AUTH = { 'Content-Type': 'application/json', Authorization: 'Bearer embedded-token' };

function listen(host) {
  const server = startServer(0, host);
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function event(id, agentId = 'embedded-agent') {
  return {
    schemaVersion: '1.0',
    id,
    type: 'agent.status.changed',
    timestamp: Date.now(),
    source: `agent:${agentId}`,
    agentId,
    summary: 'status',
    payload: { status: 'THINKING' },
  };
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Imports the server in a child process run from `cwd` and prints the token it ended up with. */
function tokenSeenOnImport(cwd, embedded) {
  const env = { ...process.env, NODE_ENV: 'test' };
  delete env.AGENT_VIEWER_API_TOKEN;
  if (embedded) env.AGENT_VIEWER_EMBEDDED = '1';
  else delete env.AGENT_VIEWER_EMBEDDED;
  const script = `await import(${JSON.stringify(new URL('../server/index.ts', import.meta.url).href)}); console.log(process.env.AGENT_VIEWER_API_TOKEN ?? '<none>');`;
  // Resolve tsx from the repository: the child runs from a temporary directory.
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').pop();
}

test('embedded mode ignores a .env file in the working directory; direct mode loads it', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'av-embedded-'));
  try {
    writeFileSync(path.join(dir, '.env'), 'AGENT_VIEWER_API_TOKEN=from-dotenv\n');
    assert.equal(tokenSeenOnImport(dir, true), '<none>');
    assert.equal(tokenSeenOnImport(dir, false), 'from-dotenv');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('embedded mode never listens on its own, even when run as the server entry', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
    cwd: repoRoot,
    env: { ...process.env, AGENT_VIEWER_EMBEDDED: '1', PORT: String(port), NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) => child.on('close', resolve));
  try {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const connected = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    assert.equal(connected, false, `nothing listens on ${port}`);
  } finally {
    child.kill();
    await exited;
  }
});

test('startServer binds the given host, and every interface without one', async () => {
  const local = await listen('127.0.0.1');
  try {
    assert.equal(local.address().address, '127.0.0.1');
  } finally {
    await new Promise((resolve) => local.close(resolve));
  }
  const any = await listen(undefined);
  try {
    assert.ok(['::', '0.0.0.0'].includes(any.address().address), any.address().address);
  } finally {
    await new Promise((resolve) => any.close(resolve));
  }
});

test('onEventAccepted sees every accepted event of the six ingestion paths, never a duplicate', async () => {
  const server = await listen('127.0.0.1');
  const base = `http://127.0.0.1:${server.address().port}`;
  const seen = [];
  const stop = onEventAccepted((accepted) => { seen.push(accepted); });
  // A listener that throws and one that rejects must leave ingestion working.
  const stopThrowing = onEventAccepted(() => { throw new Error('listener failure'); });
  const stopRejecting = onEventAccepted(async () => { throw new Error('async listener failure'); });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const post = (route, body, method = 'POST') => fetch(`${base}${route}`, { method, headers: AUTH, body: JSON.stringify(body) });

    assert.equal((await post('/api/v1/events', event('evt_embedded_single'))).status, 202);
    assert.equal((await post('/api/v1/events', event('evt_embedded_single'))).status, 200, 'a duplicate is acknowledged');
    const batch = await post('/api/v1/events/batch', { events: [event('evt_embedded_b1'), event('evt_embedded_b2')] });
    assert.ok([200, 201, 202, 207].includes(batch.status), `batch status ${batch.status}`);
    assert.equal((await post('/api/v1/agents', { id: 'embedded-reg', name: 'Registered' })).status, 201);
    assert.equal((await post('/api/v1/agents/embedded-reg', { status: 'CODING' }, 'PATCH')).status, 200);
    assert.equal((await post('/api/v1/runtimes', { id: 'embedded-runtime', name: 'Runtime' })).status, 201);
    assert.equal((await post('/api/v1/webhooks/generic', { agent: 'embedded-hook', status: 'thinking' })).status, 202);
    await new Promise((resolve) => setImmediate(resolve));

    const ids = seen.map((accepted) => accepted.id);
    assert.equal(ids.filter((id) => id === 'evt_embedded_single').length, 1, 'the duplicate is not reported');
    assert.ok(ids.includes('evt_embedded_b1') && ids.includes('evt_embedded_b2'));
    const types = new Set(seen.map((accepted) => accepted.type));
    for (const type of ['agent.registered', 'agent.status.changed', 'runtime.connected']) assert.ok(types.has(type), type);
    assert.ok(seen.some((accepted) => accepted.agentId === 'embedded-hook'), 'the generic webhook event is reported');
    assert.ok(seen.some((accepted) => accepted.agentId === 'embedded-reg' && accepted.type === 'agent.status.changed'), 'the status patch is reported');
    assert.deepEqual(unhandled, []);

    stop();
    const before = seen.length;
    assert.equal((await post('/api/v1/events', event('evt_embedded_after'))).status, 202);
    assert.equal(seen.length, before, 'the returned function unsubscribes');
  } finally {
    stop();
    stopThrowing();
    stopRejecting();
    process.off('unhandledRejection', onUnhandled);
    await new Promise((resolve) => server.close(resolve));
  }
});
