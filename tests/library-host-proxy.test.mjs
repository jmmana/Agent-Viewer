// Issue #260: the library-host example's proxy (`examples/library-host/proxy.ts`) is the only place in the
// example allowed to hold the server's API token. These tests prove it forwards only allowlisted GET requests
// with its own Authorization header, never the client's, never echoes the token back, and refuses to start
// without one; plus a static check that no other file in the example folder mentions the token variable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createProxy } from '../examples/library-host/proxy.ts';

const EXAMPLE_DIR = fileURLToPath(new URL('../examples/library-host/', import.meta.url));

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** A fake upstream that records every request it receives and echoes a fixed JSON body. */
function startFakeUpstream() {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'session=upstream-secret' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  return { server, received };
}

test('createProxy refuses to start with an empty token', () => {
  assert.throws(() => createProxy({ upstream: 'http://127.0.0.1:1', token: '' }), /empty/i);
});

test('forwards an allowlisted GET with the proxy token, never the client token, and strips Set-Cookie', async () => {
  const { server: upstream, received } = startFakeUpstream();
  const upstreamPort = await listen(upstream);
  const proxy = createProxy({ upstream: `http://127.0.0.1:${upstreamPort}`, token: 'server-secret-token' });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/v1/usage/rollup?groupBy=agent`, {
      headers: { Authorization: 'Bearer client-supplied-token' },
    });
    const body = await res.text();

    assert.equal(res.status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].headers.authorization, 'Bearer server-secret-token');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.ok(!body.includes('server-secret-token'));
    assert.ok(!body.includes('client-supplied-token'));
    // The response headers (as a whole) never carry the real token either.
    assert.ok(![...res.headers.values()].some((value) => value.includes('server-secret-token')));
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('rejects a non-GET method with 405 and never reaches the upstream', async () => {
  const { server: upstream, received } = startFakeUpstream();
  const upstreamPort = await listen(upstream);
  const proxy = createProxy({ upstream: `http://127.0.0.1:${upstreamPort}`, token: 'server-secret-token' });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/v1/usage/rollup`, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(received.length, 0);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('rejects a path outside the allowlist with 404 and never reaches the upstream', async () => {
  const { server: upstream, received } = startFakeUpstream();
  const upstreamPort = await listen(upstream);
  const proxy = createProxy({ upstream: `http://127.0.0.1:${upstreamPort}`, token: 'server-secret-token' });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/api/v1/events`);
    assert.equal(res.status, 404);
    assert.equal(received.length, 0);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('only proxy.ts and README.md mention AGENT_VIEWER_API_TOKEN in the example folder', () => {
  const offenders = [];
  for (const name of fs.readdirSync(EXAMPLE_DIR)) {
    if (name === 'proxy.ts' || name === 'README.md') continue;
    const fullPath = path.join(EXAMPLE_DIR, name);
    if (!fs.statSync(fullPath).isFile()) continue;
    const text = fs.readFileSync(fullPath, 'utf8');
    if (text.includes('AGENT_VIEWER_API_TOKEN')) offenders.push(name);
  }
  assert.deepEqual(offenders, []);
});
