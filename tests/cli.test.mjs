import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliUsageError, parseCliArgs } from '../cli/args.ts';
import { buildSendEvents } from '../cli/send.ts';
import { normalizeStatus } from '../cli/statuses.ts';
import { resolveConnection, writeSessionFile } from '../cli/connection.ts';
import { createLaunchCodes, curlExample, displayHost, exposureWarning, launchUrl, officeUrl, resolveStartToken } from '../cli/start.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliEntry = path.join(repoRoot, 'cli', 'index.ts');

test('CLI args: start defaults are local, tokened and open the browser', () => {
  const start = parseCliArgs([], '/work', {});
  assert.deepEqual(start, { command: 'start', port: 8787, host: '127.0.0.1', token: undefined, demo: false, open: true, record: undefined });
  assert.deepEqual(parseCliArgs(['start', '--no-open'], '/work', {}).open, false);
});

test('CLI args: PORT and AGENT_VIEWER_HOST are the defaults of --port and --host, and flags win', () => {
  const env = { PORT: '9123', AGENT_VIEWER_HOST: '0.0.0.0' };
  assert.equal(parseCliArgs([], '/work', env).port, 9123);
  assert.equal(parseCliArgs([], '/work', env).host, '0.0.0.0');
  assert.equal(parseCliArgs(['--port', '4000', '--host', '127.0.0.1'], '/work', env).port, 4000);
  assert.equal(parseCliArgs(['--port', '4000', '--host', '127.0.0.1'], '/work', env).host, '127.0.0.1');
  // The defaults the Docker image passes first are overridden by a later flag.
  assert.equal(parseCliArgs(['--port', '8787', '--no-open', '--port', '9000'], '/work', {}).port, 9000);
  assert.equal(parseCliArgs([], '/work', { PORT: '', AGENT_VIEWER_HOST: '  ' }).port, 8787);
  assert.equal(parseCliArgs([], '/work', { PORT: '', AGENT_VIEWER_HOST: '  ' }).host, '127.0.0.1');
  // HOST is not read: tcsh exports it with the machine name, which would expose the server.
  assert.equal(parseCliArgs([], '/work', { HOST: 'my-laptop' }).host, '127.0.0.1');
  assert.throws(() => parseCliArgs([], '/work', { PORT: 'http' }), /PORT must be a number/);
});

test('CLI start token: empty or blank variables never turn authentication off', () => {
  for (const value of ['', ' ', '\n']) {
    const { token, source } = resolveStartToken(undefined, { AGENT_VIEWER_API_TOKEN: value });
    assert.equal(source, 'generated');
    assert.match(token, /^av_[\w-]{32}$/);
  }
  assert.deepEqual(resolveStartToken(undefined, { AGENT_VIEWER_API_TOKEN: ' abc \n' }), { token: 'abc', source: 'env' });
  assert.deepEqual(resolveStartToken(undefined, { AGENT_VIEWER_API_TOKEN: '', AGENT_VIEWER_API_KEY: 'old' }), { token: 'old', source: 'legacy-env' });
  assert.deepEqual(resolveStartToken('flag', { AGENT_VIEWER_API_TOKEN: 'env' }), { token: 'flag', source: 'flag' });
  assert.throws(() => writeSessionFile({ url: 'http://x', token: '', pid: 1, startedAt: 0 }, { AGENT_VIEWER_HOME: os.tmpdir() }), /empty token/);
});

test('CLI start: launch codes work once and expire, and the browser URL carries no token', () => {
  let now = 1_000;
  const codes = createLaunchCodes('secret', () => now);
  const code = codes.issue();
  assert.equal(codes.redeem('nope'), undefined);
  assert.equal(codes.redeem(code), 'secret');
  assert.equal(codes.redeem(code), undefined, 'single use');
  const late = codes.issue();
  now += 120_001;
  assert.equal(codes.redeem(late), undefined, 'expired');
  assert.equal(codes.redeem(undefined), undefined);
  const url = launchUrl('http://127.0.0.1:8787', code, false);
  assert.equal(url, `http://127.0.0.1:8787/?mode=live#launch=${code}`);
  assert.doesNotMatch(url, /secret|token/);
});

test('CLI start: the exposure warning says what stays public', () => {
  assert.match(exposureWarning('0.0.0.0', false), /\/api\/v1 needs the token.*office page and \/health are public/);
  assert.match(exposureWarning('0.0.0.0', true), /AGENT_VIEWER_WEBHOOK_SECRET signature instead of the token/);
});

test('CLI args: start options', () => {
  const parsed = parseCliArgs(['--port', '4871', '--host', '0.0.0.0', '--token', 'abc', '--demo', '--no-open', '--record', 'runs/a.jsonl'], '/work');
  assert.deepEqual(parsed, {
    command: 'start', port: 4871, host: '0.0.0.0', token: 'abc', demo: true, open: false, record: path.resolve('/work', 'runs/a.jsonl'),
  });
  assert.equal(parseCliArgs(['--port=0'], '/work').port, 0);
});

test('CLI args: invalid input is a usage error', () => {
  const bad = [
    ['--port', 'abc'], ['--port', '70000'], ['--token', ''], ['--nope'], ['serve'],
    ['send', '--agent', 'a'], ['send', '--status', 'working'], ['send', '--agent', 'a', '--status', 'dancing'],
    ['send', '--agent', 'a', '--status', 'done', '--url', 'ftp://x'], ['install'], ['install', 'cursor'],
    ['uninstall', 'claude-code', '--include-summaries'],
  ];
  for (const argv of bad) {
    assert.throws(() => parseCliArgs(argv, '/work'), CliUsageError, argv.join(' '));
  }
});

test('CLI args: send, claude-hook, install, uninstall, help and version', () => {
  assert.deepEqual(parseCliArgs(['send', '--agent', 'demo', '--status', 'working', '--message', 'hi', '--url', 'http://127.0.0.1:4871/', '--token', 't'], '/work'), {
    command: 'send', agent: 'demo', status: 'THINKING', message: 'hi', url: 'http://127.0.0.1:4871', token: 't',
  });
  assert.deepEqual(parseCliArgs(['claude-hook', '--include-summaries'], '/work'), {
    command: 'claude-hook', url: undefined, token: undefined, includeSummaries: true,
  });
  assert.deepEqual(parseCliArgs(['install', 'claude-code', '--project', 'app', '--yes'], '/work'), {
    command: 'install', target: 'claude-code', project: path.resolve('/work', 'app'), yes: true, includeSummaries: false, url: undefined, token: undefined,
  });
  assert.equal(parseCliArgs(['uninstall', 'claude-code', '-y'], '/work').yes, true);
  assert.equal(parseCliArgs(['--help']).command, 'help');
  assert.equal(parseCliArgs(['-v']).command, 'version');
});

test('CLI statuses: office statuses and everyday words', () => {
  assert.equal(normalizeStatus('coding'), 'CODING');
  assert.equal(normalizeStatus('waiting-approval'), 'WAITING_APPROVAL');
  assert.equal(normalizeStatus('Working'), 'THINKING');
  assert.equal(normalizeStatus('finished'), 'DONE');
  assert.equal(normalizeStatus('dancing'), undefined);
});

test('CLI send: builds valid canonical V1 events', () => {
  let n = 0;
  const events = buildSendEvents({ agent: 'demo', status: 'THINKING', message: 'Hello' }, 1_767_225_600_000, () => `id${++n}`);
  assert.deepEqual(events.map((event) => event.type), ['agent.status.changed', 'agent.message.sent']);
  for (const event of events) {
    const result = validateCanonicalEvent(event);
    assert.equal(result.success, true, JSON.stringify(result.issues));
    assert.equal(result.data.agentId, 'demo');
  }
  assert.equal(events[0].payload.status, 'THINKING');
  assert.equal(events[1].payload.text, 'Hello');
  assert.equal(buildSendEvents({ agent: 'demo', status: 'DONE' }).length, 1);
});

test('CLI connection: flags, then environment, then the running viewer, then the default', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'av-conn-'));
  try {
    const env = { AGENT_VIEWER_HOME: home };
    assert.deepEqual(resolveConnection({}, env), { url: 'http://127.0.0.1:8787', token: undefined });
    writeSessionFile({ url: 'http://127.0.0.1:4999', token: 'session-token', pid: 1, startedAt: 0 }, env);
    assert.deepEqual(resolveConnection({}, env), { url: 'http://127.0.0.1:4999', token: 'session-token' });
    assert.deepEqual(resolveConnection({}, { ...env, AGENT_VIEWER_URL: 'http://h:1', AGENT_VIEWER_API_TOKEN: 'e' }), { url: 'http://h:1', token: 'e' });
    assert.deepEqual(resolveConnection({ url: 'http://f:2', token: 'f' }, env), { url: 'http://f:2', token: 'f' });
    if (process.platform !== 'win32') {
      const mode = (statSync(path.join(home, 'session.json')).mode & 0o777).toString(8);
      assert.equal(mode, '600');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI start banner: URL with the token in the fragment and a ready curl command', () => {
  assert.equal(displayHost('0.0.0.0'), '127.0.0.1');
  assert.equal(displayHost('::1'), '[::1]');
  assert.equal(officeUrl('http://127.0.0.1:8787', 'a b', false), 'http://127.0.0.1:8787/?mode=live#token=a%20b');
  assert.equal(officeUrl('http://127.0.0.1:8787', 't', true), 'http://127.0.0.1:8787/#token=t');
  const curl = curlExample('http://127.0.0.1:8787', 'tok');
  assert.match(curl, /Authorization: Bearer tok/);
  assert.match(curl, /\/api\/v1\/webhooks\/generic/);
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

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliEntry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI end to end: start, send an event, read it back from the API and the live stream', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'av-e2e-'));
  const record = path.join(home, 'run.jsonl');
  const port = await freePort();
  // An empty AGENT_VIEWER_API_TOKEN, as `export AGENT_VIEWER_API_TOKEN=` leaves it, must not open the API.
  const env = { ...process.env, AGENT_VIEWER_HOME: home, AGENT_VIEWER_API_TOKEN: '' };
  delete env.AGENT_VIEWER_URL;
  delete env.AGENT_VIEWER_API_KEY;
  delete env.PORT;
  delete env.AGENT_VIEWER_HOST;
  // The server sources need tsx; the published CLI runs from the bundle in dist-cli/.
  const server = spawn(process.execPath, ['--import', 'tsx', cliEntry, '--no-open', '--port', String(port), '--record', record], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => server.on('close', resolve));

  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (!/Press Ctrl\+C/.test(output)) {
      if (Date.now() > deadline) throw new Error(`CLI did not start:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const token = /Token\s+(\S+)/.exec(output)?.[1];
    assert.ok(token, 'prints the session token');
    assert.match(output, new RegExp(`Office\\s+${base.replace(/[.]/g, '\\.')}/\\?mode=live#token=`));
    assert.match(output, /curl -X POST/);

    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal((await fetch(`${base}/api/v1/events`)).status, 401, 'the API needs the token');
    assert.equal((await fetch(`${base}/api/v1/snapshot`)).status, 401, 'the API needs the token');
    const session = JSON.parse(readFileSync(path.join(home, 'session.json'), 'utf8'));
    assert.equal(session.token, token, 'the session file holds the generated token, never an empty one');

    // A launch code is not the token, and an unknown one is refused.
    const refused = await fetch(`${base}/api/cli/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"code":"nope"}' });
    assert.equal(refused.status, 404);

    // What the office receives: the live stream.
    const stream = await fetch(`${base}/api/v1/events/stream?token=${encodeURIComponent(token)}`);
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();

    // send finds the running viewer through the session file: no --url or --token needed.
    const sent = await run(['send', '--agent', 'e2e-agent', '--status', 'working', '--message', 'Hello from the test'], env);
    assert.equal(sent.code, 0, sent.stderr);
    assert.match(sent.stdout, /Sent agent\.status\.changed \+ agent\.message\.sent/);

    let streamed = '';
    const decoder = new TextDecoder();
    while (!streamed.includes('Hello from the test')) {
      const { value, done } = await reader.read();
      if (done) break;
      streamed += decoder.decode(value);
    }
    await reader.cancel();
    assert.match(streamed, /"agentId":"e2e-agent"/);

    const listed = await (await fetch(`${base}/api/v1/events?agentId=e2e-agent`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const types = listed.events.map((event) => event.type).sort();
    assert.deepEqual(types, ['agent.message.sent', 'agent.status.changed']);
    assert.equal(listed.events.find((event) => event.type === 'agent.status.changed').payload.status, 'THINKING');

    // A repeated event is acknowledged but never recorded twice.
    const repeated = listed.events.find((event) => event.type === 'agent.status.changed');
    const duplicate = await fetch(`${base}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(repeated),
    });
    assert.equal(duplicate.status, 200);

    // The recorder writes through a stream, so wait until both lines are complete on disk before reading them.
    const recordDeadline = Date.now() + 10_000;
    let recorded = '';
    while (true) {
      recorded = existsSync(record) ? readFileSync(record, 'utf8') : '';
      if (recorded.endsWith('\n') && recorded.trim().split('\n').length >= 2) break;
      if (Date.now() > recordDeadline) throw new Error(`--record did not write both events:\n${recorded}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const lines = recorded.trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((event) => event.type), ['agent.status.changed', 'agent.message.sent']);
    for (const event of lines) assert.equal(validateCanonicalEvent(event).success, true);
    if (process.platform !== 'win32') assert.equal(statSync(record).mode & 0o777, 0o600, 'only the owner can read the recording');

    // Express 5: an empty launch body is a refused code, not a server error.
    const empty = await fetch(`${base}/api/cli/launch`, { method: 'POST' });
    assert.equal(empty.status, 404);
    assert.equal((await empty.json()).error, 'launch_code_invalid');
    // The single page fallback never hides the API's own answers.
    const page = await fetch(`${base}/some/route`);
    assert.ok([200, 503].includes(page.status), `office page status ${page.status}`);
    assert.doesNotMatch(page.headers.get('content-type') ?? '', /json/);
    const unknownApi = await fetch(`${base}/api/v1/unknown`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(unknownApi.status, 404, 'the API answers, not the office page');
    assert.doesNotMatch(await unknownApi.text(), /office is not built|id="root"/);
    assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);
  } finally {
    server.kill('SIGINT');
    await exited;
  }
  assert.equal(existsSync(path.join(home, 'session.json')), false, 'removes its session file on exit');
  rmSync(home, { recursive: true, force: true });
});

test('CLI end to end: a busy port is reported clearly', { timeout: 60_000 }, async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const home = mkdtempSync(path.join(os.tmpdir(), 'av-busy-'));
  try {
    const { port } = blocker.address();
    const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, '--no-open', '--port', String(port)], {
      cwd: repoRoot,
      env: { ...process.env, AGENT_VIEWER_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 1);
    assert.match(stderr, new RegExp(`Port ${port} is already in use`));
  } finally {
    blocker.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI end to end: a --record path that cannot be written stops the CLI before it listens', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'av-record-'));
  try {
    const blocker = path.join(home, 'not-a-folder');
    writeFileSync(blocker, '');
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, '--no-open', '--port', String(port), '--record', path.join(blocker, 'run.jsonl')], {
      cwd: repoRoot,
      env: { ...process.env, AGENT_VIEWER_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 1);
    assert.match(stderr, /Cannot write the --record file/);
    assert.doesNotMatch(stdout, /Press Ctrl\+C/, 'it never started');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('CLI end to end: a write error while recording warns once and the server keeps accepting events', {
  timeout: 60_000,
  skip: existsSync('/dev/full') ? false : 'needs /dev/full (Linux)',
}, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'av-full-'));
  const port = await freePort();
  const token = 'record-full-token';
  const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, '--no-open', '--port', String(port), '--token', token, '--record', '/dev/full'], {
    cwd: repoRoot,
    env: { ...process.env, AGENT_VIEWER_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.on('close', resolve));
  try {
    const deadline = Date.now() + 30_000;
    while (!/Press Ctrl\+C/.test(output)) {
      if (Date.now() > deadline) throw new Error(`CLI did not start:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const base = `http://127.0.0.1:${port}`;
    const send = (id) => fetch(`${base}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ schemaVersion: '1.0', id, type: 'agent.status.changed', timestamp: Date.now(), source: 'agent:full', agentId: 'full', summary: 'x', payload: { status: 'THINKING' } }),
    });
    assert.equal((await send('evt_full_1')).status, 202);
    const warned = Date.now() + 10_000;
    while (!/--record stopped/.test(output)) {
      if (Date.now() > warned) throw new Error(`no warning:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal((await send('evt_full_2')).status, 202, 'the server keeps accepting events');
    assert.equal((await send('evt_full_3')).status, 202);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(output.match(/--record stopped/g).length, 1, 'one warning only');
  } finally {
    child.kill('SIGINT');
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
});
