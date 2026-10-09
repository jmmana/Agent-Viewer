import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { originOf, resolveTelemetryHeaders, runOtelHeaders } from '../cli/otelHeaders.ts';
import { writeSessionFile } from '../cli/connection.ts';

/**
 * `agent-viewer otel-headers`, Claude Code's `otelHeadersHelper` for the telemetry installer (issue #60). It
 * must never touch the network (the helper is trusted to run arbitrary commands, so its own behaviour has to be
 * boring and predictable), always print exactly one JSON line, and always exit 0, even with no running office
 * or a corrupt session file: a non-zero exit or a missing header would otherwise show up as broken telemetry,
 * not as a CLI bug.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliEntry = path.join(repoRoot, 'cli', 'index.ts');

function tempHome() {
  return mkdtempSync(path.join(os.tmpdir(), 'av-otel-home-'));
}

test('otel-headers: origins', () => {
  assert.equal(originOf('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(originOf('http://127.0.0.1:8787/some/path?x=1'), 'http://127.0.0.1:8787');
  assert.equal(originOf('https://host'), 'https://host:443');
  assert.equal(originOf('http://host'), 'http://host:80');
  // localhost and 127.0.0.1 are different origins on purpose.
  assert.notEqual(originOf('http://localhost:8787'), originOf('http://127.0.0.1:8787'));
  assert.equal(originOf('not a url'), undefined);
});

test('otel-headers: prints the bearer token only when the running office has that exact origin', () => {
  const home = tempHome();
  try {
    writeSessionFile({ url: 'http://127.0.0.1:8787', token: 'office-token', pid: process.pid, startedAt: Date.now() }, { AGENT_VIEWER_HOME: home });
    const env = { AGENT_VIEWER_HOME: home };
    assert.deepEqual(resolveTelemetryHeaders('http://127.0.0.1:8787', env), { Authorization: 'Bearer office-token' });
    // Trailing path and query are ignored.
    assert.deepEqual(resolveTelemetryHeaders('http://127.0.0.1:8787/v1/logs', env), { Authorization: 'Bearer office-token' });
    // A different port, scheme, or host: no token.
    assert.deepEqual(resolveTelemetryHeaders('http://127.0.0.1:9999', env), {});
    assert.deepEqual(resolveTelemetryHeaders('https://127.0.0.1:8787', env), {});
    assert.deepEqual(resolveTelemetryHeaders('http://localhost:8787', env), {}, 'localhost is not 127.0.0.1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('otel-headers: no session, a corrupt session file, and no token in the session all print {}', () => {
  const home = tempHome();
  try {
    assert.deepEqual(resolveTelemetryHeaders('http://127.0.0.1:8787', { AGENT_VIEWER_HOME: home }), {}, 'no office running');

    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, 'session.json'), '{ not json');
    assert.deepEqual(resolveTelemetryHeaders('http://127.0.0.1:8787', { AGENT_VIEWER_HOME: home }), {}, 'corrupt session file');

    writeSessionFile({ url: 'http://127.0.0.1:8787', pid: process.pid, startedAt: Date.now() }, { AGENT_VIEWER_HOME: home });
    assert.deepEqual(resolveTelemetryHeaders('http://127.0.0.1:8787', { AGENT_VIEWER_HOME: home }), {}, 'no token in the session');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('otel-headers: AGENT_VIEWER_API_TOKEN overrides the session token, but the origin still has to match', () => {
  const home = tempHome();
  try {
    writeSessionFile({ url: 'http://127.0.0.1:8787', token: 'session-token', pid: process.pid, startedAt: Date.now() }, { AGENT_VIEWER_HOME: home });
    const env = { AGENT_VIEWER_HOME: home, AGENT_VIEWER_API_TOKEN: 'env-token' };
    assert.deepEqual(resolveTelemetryHeaders('http://127.0.0.1:8787', env), { Authorization: 'Bearer env-token' });
    assert.deepEqual(resolveTelemetryHeaders('http://127.0.0.1:9999', env), {}, 'the env token still needs a matching running office');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('otel-headers: runOtelHeaders prints exactly one JSON line and always returns exit code 0', () => {
  const home = tempHome();
  const logs = [];
  const log = console.log;
  console.log = (line) => logs.push(line);
  try {
    writeSessionFile({ url: 'http://127.0.0.1:8787', token: 't', pid: process.pid, startedAt: Date.now() }, { AGENT_VIEWER_HOME: home });
    const code = runOtelHeaders({ command: 'otel-headers', url: 'http://127.0.0.1:8787' }, { AGENT_VIEWER_HOME: home });
    assert.equal(code, 0);
    assert.equal(logs.length, 1);
    assert.deepEqual(JSON.parse(logs[0]), { Authorization: 'Bearer t' });
  } finally {
    console.log = log;
    rmSync(home, { recursive: true, force: true });
  }
});

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliEntry, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('otel-headers CLI: needs --url, writes one JSON line, exits 0, and never touches the network', { timeout: 15_000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'av-otel-cli-'));
  let contacted = false;
  const server = http.createServer((req, res) => { contacted = true; res.writeHead(200); res.end('{}'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    writeSessionFile({ url: `http://127.0.0.1:${port}`, token: 'cli-token', pid: process.pid, startedAt: Date.now() }, { AGENT_VIEWER_HOME: home });

    const missingUrl = await run(['otel-headers'], { AGENT_VIEWER_HOME: home });
    assert.equal(missingUrl.code, 2);
    assert.match(missingUrl.stderr, /--url/);

    const matching = await run(['otel-headers', '--url', `http://127.0.0.1:${port}`], { AGENT_VIEWER_HOME: home });
    assert.equal(matching.code, 0);
    assert.deepEqual(JSON.parse(matching.stdout.trim()), { Authorization: 'Bearer cli-token' });
    assert.equal(matching.stdout.trim().split('\n').length, 1);

    const other = await run(['otel-headers', '--url', 'http://127.0.0.1:1'], { AGENT_VIEWER_HOME: home });
    assert.equal(other.code, 0);
    assert.deepEqual(JSON.parse(other.stdout.trim()), {});

    assert.equal(contacted, false, 'otel-headers never contacts a server, including the one it would send telemetry to');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});
