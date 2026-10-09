import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isLoopbackAddress, isLoopbackHost, OpenApiRefusedError, assertSafeBind } from '../server/network.ts';
import { app, startServer } from '../server/index.ts';

/** Runs `fn` with the given env vars set, restoring the previous values afterwards. */
async function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const NO_AUTH_ENV = {
  AGENT_VIEWER_API_TOKEN: undefined,
  AGENT_VIEWER_API_KEY: undefined,
  AGENT_VIEWER_ALLOW_OPEN: undefined,
};

test('isLoopbackHost: localhost, ::1, [::1] and any 127.0.0.0/8 literal are loopback; everything else is not', () => {
  const loopback = ['127.0.0.1', '127.1.2.3', '127.255.255.255', 'localhost', '::1', '[::1]'];
  const notLoopback = ['0.0.0.0', '::', '192.168.1.10', 'example.com', ''];
  for (const host of loopback) assert.equal(isLoopbackHost(host), true, host);
  for (const host of notLoopback) assert.equal(isLoopbackHost(host), false, host);
});

test('isLoopbackAddress: IPv4-mapped loopback forms count too; undefined never does', () => {
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.9.9.9'), true);
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:10.0.0.1'), false);
  assert.equal(isLoopbackAddress('10.0.0.1'), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('assertSafeBind throws OpenApiRefusedError for a non-loopback host with no token and no allow flag', () => {
  assert.throws(() => assertSafeBind('0.0.0.0', 8787, { hasToken: false }), OpenApiRefusedError);
  assert.throws(() => assertSafeBind('::', 8787, { hasToken: false }), OpenApiRefusedError);
  assert.throws(() => assertSafeBind('192.168.1.5', 8787, { hasToken: false }), OpenApiRefusedError);
});

test('assertSafeBind does not throw for a loopback host, a token, or AGENT_VIEWER_ALLOW_OPEN=1', () => {
  assert.doesNotThrow(() => assertSafeBind('127.0.0.1', 8787, { hasToken: false }));
  assert.doesNotThrow(() => assertSafeBind('localhost', 8787, { hasToken: false }));
  assert.doesNotThrow(() => assertSafeBind('0.0.0.0', 8787, { hasToken: true }));
  assert.doesNotThrow(() =>
    assertSafeBind('0.0.0.0', 8787, { hasToken: false, env: { AGENT_VIEWER_ALLOW_OPEN: '1' } })
  );
});

test('assertSafeBind ignores a blank or non-"1" AGENT_VIEWER_ALLOW_OPEN value', () => {
  for (const value of ['', '0', 'true', 'yes']) {
    assert.throws(
      () => assertSafeBind('0.0.0.0', 8787, { hasToken: false, env: { AGENT_VIEWER_ALLOW_OPEN: value } }),
      OpenApiRefusedError,
      value
    );
  }
});

test('startServer(0, host) throws for 0.0.0.0 and :: without a token, and not for 127.0.0.1 or localhost', async () => {
  await withEnv({ ...NO_AUTH_ENV }, async () => {
    assert.throws(() => startServer(0, '0.0.0.0'), OpenApiRefusedError);
    assert.throws(() => startServer(0, '::'), OpenApiRefusedError);

    const local = startServer(0, '127.0.0.1');
    await new Promise((resolve) => local.once('listening', resolve));
    local.close();

    const named = startServer(0, 'localhost');
    await new Promise((resolve) => named.once('listening', resolve));
    named.close();
  });
});

test('open-mode guard: a non-loopback remote address gets 403 open_api_loopback_only', async () => {
  await withEnv({ ...NO_AUTH_ENV }, async () => {
    const server = http.createServer((req, res) => {
      // Simulate a remote peer the real socket never reports, to exercise the guard without real networking.
      Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.5', configurable: true });
      app(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/snapshot`);
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, 'open_api_loopback_only');
    } finally {
      server.close();
    }
  });
});

/** `fetch` always sets its own `Host` header from the URL; raw `http.request` is the only way to override it. */
function rawGet(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('open-mode guard: a non-loopback Host header gets 403 open_api_host_not_allowed', async () => {
  await withEnv({ ...NO_AUTH_ENV }, async () => {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const res = await rawGet(port, '/api/v1/snapshot', { Host: 'example.com' });
      assert.equal(res.status, 403);
      assert.equal(JSON.parse(res.body).error, 'open_api_host_not_allowed');
    } finally {
      server.close();
    }
  });
});

test('open-mode guard: a cross-origin Origin header gets 403 open_api_origin_not_allowed', async () => {
  await withEnv({ ...NO_AUTH_ENV }, async () => {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/snapshot`, {
        headers: { Origin: 'https://example.com' },
      });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, 'open_api_origin_not_allowed');

      // No Origin header at all (curl, SDKs, the CLI) is unaffected by the origin check.
      const noOrigin = await fetch(`http://127.0.0.1:${port}/api/v1/snapshot`);
      assert.equal(noOrigin.status, 200);
    } finally {
      server.close();
    }
  });
});

test('open-mode guard: an explicit AGENT_VIEWER_CORS_ORIGIN allows that origin, but not others, and "*" does not count as a list', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_CORS_ORIGIN: 'https://trusted.example' }, async () => {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const trusted = await fetch(`http://127.0.0.1:${port}/api/v1/snapshot`, {
        headers: { Origin: 'https://trusted.example' },
      });
      assert.equal(trusted.status, 200);

      const other = await fetch(`http://127.0.0.1:${port}/api/v1/snapshot`, {
        headers: { Origin: 'https://other.example' },
      });
      assert.equal(other.status, 403);
    } finally {
      server.close();
    }
  });
});

test('open-mode guard does not block requests once a token is set, or with AGENT_VIEWER_ALLOW_OPEN=1', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'guard-bypass-token' }, async () => {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/snapshot`, {
        headers: { Host: 'example.com', Origin: 'https://example.com', Authorization: 'Bearer guard-bypass-token' },
      });
      assert.equal(res.status, 200);
    } finally {
      server.close();
    }
  });

  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_ALLOW_OPEN: '1' }, async () => {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/snapshot`, {
        headers: { Host: 'example.com', Origin: 'https://example.com' },
      });
      assert.equal(res.status, 200);
    } finally {
      server.close();
    }
  });
});

test('open-mode guard: an HMAC-signed webhook from a non-loopback address still passes the guard', async () => {
  const crypto = await import('node:crypto');
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_WEBHOOK_SECRET: 'guard-webhook-secret' }, async () => {
    const server = http.createServer((req, res) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: '203.0.113.9', configurable: true });
      app(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = server.address().port;
      const rawBody = JSON.stringify({ agent: 'remote-bot', status: 'thinking' });
      const timestamp = Date.now().toString();
      const signature = crypto
        .createHmac('sha256', 'guard-webhook-secret')
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/webhooks/generic`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Viewer-Signature': signature,
          'X-Agent-Viewer-Timestamp': timestamp,
          Origin: 'https://example.com',
          Host: 'example.com',
        },
        body: rawBody,
      });
      assert.equal(res.status, 202);
    } finally {
      server.close();
    }
  });
});

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const serverEntry = path.join(repoRoot, 'server', 'index.ts');

function spawnDirectRun(env) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-bind-'));
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), serverEntry], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { cwd, child, out: () => output };
}

test('a spawned direct run refuses a non-loopback bind without a token: exits 1 with the refusal message on stderr', { timeout: 20_000 }, async () => {
  const env = { ...process.env, PORT: '0', AGENT_VIEWER_STORAGE: 'memory', AGENT_VIEWER_HOST: '0.0.0.0' };
  delete env.NODE_ENV;
  delete env.npm_lifecycle_event;
  delete env.AGENT_VIEWER_API_TOKEN;
  delete env.AGENT_VIEWER_API_KEY;
  delete env.AGENT_VIEWER_ALLOW_OPEN;

  const run = spawnDirectRun(env);
  const code = await new Promise((resolve) => run.child.once('close', (exitCode) => resolve(exitCode)));
  assert.equal(code, 1);
  assert.match(run.out(), /Refusing to listen on 0\.0\.0\.0:\d+ without AGENT_VIEWER_API_TOKEN/);
  rmSync(run.cwd, { recursive: true, force: true });
});
