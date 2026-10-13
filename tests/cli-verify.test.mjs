// Issue #388 (second sub-issue of the chain-verification theme started by #106/#387): `agent-viewer verify`.
// Parsing is tested directly against `parseCliArgs`; the end-to-end behavior runs one real in-process server
// for the whole file (`cli/start.ts`'s `startViewer`, the same pattern `tests/cli-audit.test.mjs` uses), so
// `runVerify` exercises a genuine `GET /api/v1/audit/verify`/`entries/:seq`/`checkpoints` round trip, plus a
// genuine `--db` read directly against the live SQLite file (WAL mode allows a read-only connection alongside
// the writer, the same thing `server/audit/verify.ts` already relies on). One shared viewer, closed once at the
// very end: `server/index.ts`'s `store` is a module-level singleton, and `shutdown()` closes its database handle
// for the rest of the process, so a second `startViewer()` after an earlier `close()` would reuse an already-
// closed store instead of a fresh one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'av-cli-verify-'));
const dbPath = path.join(home, 'cli-verify.db');
process.env.AGENT_VIEWER_HOME = home;
process.env.AGENT_VIEWER_STORAGE = 'sqlite';
process.env.AGENT_VIEWER_SQLITE_PATH = dbPath;
delete process.env.AGENT_VIEWER_API_KEY;

const { startViewer } = await import('../cli/start.ts');
const { runVerify } = await import('../cli/verify.ts');
const { CliUsageError, parseCliArgs } = await import('../cli/args.ts');

let viewer;

test.before(async () => {
  viewer = await startViewer({ command: 'start', port: 0, host: '127.0.0.1', demo: false, open: false, metrics: false });
});

test.after(async () => {
  await viewer.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function captureConsole(fn) {
  const logs = [];
  const errors = [];
  const log = console.log;
  const error = console.error;
  console.log = (line) => logs.push(line);
  console.error = (line) => errors.push(line);
  return fn().finally(() => {
    console.log = log;
    console.error = error;
  }).then((code) => ({ code, logs, errors }));
}

async function postEvent(id) {
  const res = await fetch(`${viewer.url}/api/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewer.token}` },
    body: JSON.stringify({ schemaVersion: '1.0', id, type: 'agent.message.sent', timestamp: Date.now(), source: 'agent:w', agentId: 'w', summary: 'hi', payload: { text: 'hi' } }),
  });
  assert.equal(res.status, 202);
}

test('parseCliArgs: verify', () => {
  assert.deepEqual(
    parseCliArgs(['verify', '--url', 'http://127.0.0.1:8787', '--token', 't', '--scope', 'recent', '--public-key', 'key.pem', '--checkpoints', 'cp.jsonl', '--json'], '/work'),
    {
      command: 'verify',
      db: undefined,
      scope: 'recent',
      publicKey: 'key.pem',
      checkpoints: 'cp.jsonl',
      json: true,
      url: 'http://127.0.0.1:8787',
      token: 't',
    }
  );
  assert.deepEqual(parseCliArgs(['verify', '--db', 'chain.db'], '/work'), {
    command: 'verify',
    db: 'chain.db',
    scope: undefined,
    publicKey: undefined,
    checkpoints: undefined,
    json: false,
    url: undefined,
    token: undefined,
  });
  // Minimal: no flags at all is valid (online, full scope, human output).
  const minimal = parseCliArgs(['verify'], '/work');
  assert.equal(minimal.db, undefined);
  assert.equal(minimal.json, false);

  assert.throws(() => parseCliArgs(['verify', '--db', 'chain.db', '--url', 'http://x'], '/work'), CliUsageError, '--db with --url');
  assert.throws(() => parseCliArgs(['verify', '--db', 'chain.db', '--token', 't'], '/work'), CliUsageError, '--db with --token');
  assert.throws(() => parseCliArgs(['verify', '--scope', 'bogus'], '/work'), CliUsageError, 'invalid --scope');
  assert.throws(() => parseCliArgs(['verify', 'extra'], '/work'), CliUsageError, 'extra positional');
});

test('agent-viewer verify: online, a clean chain reports ok (human and --json)', async () => {
  await postEvent('evt_cli_verify_1');

  const human = await captureConsole(() => runVerify({ command: 'verify', json: false, url: viewer.url, token: viewer.token }));
  assert.equal(human.code, 0);
  assert.ok(human.logs.some((l) => l === 'verdict: ok'));

  const json = await captureConsole(() => runVerify({ command: 'verify', json: true, url: viewer.url, token: viewer.token }));
  assert.equal(json.code, 0);
  assert.equal(json.logs.length, 1);
  const report = JSON.parse(json.logs[0]);
  assert.equal(report.ok, true);
  assert.equal(report.firstBreak, null);
  assert.equal(report.keyTrust, 'server-reported');
});

test('agent-viewer verify --db: reads the live SQLite file directly, no server round trip', async () => {
  await postEvent('evt_cli_verify_db_1');

  const result = await captureConsole(() => runVerify({ command: 'verify', db: dbPath, json: true }));
  assert.equal(result.code, 0);
  const report = JSON.parse(result.logs[0]);
  assert.equal(report.ok, true);
  assert.equal(report.storage, 'sqlite');
});

test('agent-viewer verify runtime guard: --db combined with --url/--token is a usage error (exit 2)', async () => {
  const result = await captureConsole(() => runVerify({ command: 'verify', db: dbPath, url: 'http://127.0.0.1:1', json: false }));
  assert.equal(result.code, 2);
  assert.ok(result.errors[0].includes('--db cannot be combined'));
});

test('agent-viewer verify --public-key: pins trust and reports keyTrust "pinned"', async () => {
  await postEvent('evt_cli_verify_pin_1');
  const checkpointRes = await fetch(`${viewer.url}/api/v1/audit/checkpoints`, { method: 'POST', headers: { Authorization: `Bearer ${viewer.token}` } });
  assert.ok(checkpointRes.ok, await checkpointRes.text());

  const keysBody = await (await fetch(`${viewer.url}/api/v1/audit/keys`, { headers: { Authorization: `Bearer ${viewer.token}` } })).json();
  const active = keysBody.keys.find((k) => k.keyId === keysBody.activeKeyId);
  const keyFile = path.join(home, 'active-key.pem');
  fs.writeFileSync(keyFile, active.publicKeyPem);

  const pinned = await captureConsole(() => runVerify({ command: 'verify', json: true, url: viewer.url, token: viewer.token, publicKey: keyFile }));
  assert.equal(pinned.code, 0);
  const report = JSON.parse(pinned.logs[0]);
  assert.equal(report.keyTrust, 'pinned');
  assert.equal(report.checkpoints.firstFailure, null);
  assert.ok(report.checkpoints.checked >= 1);

  // A foreign key that never signed anything here: every checkpoint must report key_unknown.
  const { publicKey: foreignKey } = crypto.generateKeyPairSync('ed25519');
  const foreignFile = path.join(home, 'foreign-key.pem');
  fs.writeFileSync(foreignFile, foreignKey.export({ type: 'spki', format: 'pem' }));

  const wrong = await captureConsole(() => runVerify({ command: 'verify', json: true, url: viewer.url, token: viewer.token, publicKey: foreignFile }));
  assert.equal(wrong.code, 1);
  const wrongReport = JSON.parse(wrong.logs[0]);
  assert.equal(wrongReport.keyTrust, 'pinned');
  assert.equal(wrongReport.checkpoints.firstFailure.kind, 'key_unknown');
});

test('agent-viewer verify --checkpoints: cross-checks an exported checkpoints file against the live chain', async () => {
  await postEvent('evt_cli_verify_cp_1');
  await fetch(`${viewer.url}/api/v1/audit/checkpoints`, { method: 'POST', headers: { Authorization: `Bearer ${viewer.token}` } });

  const jsonl = await (await fetch(`${viewer.url}/api/v1/audit/checkpoints?format=jsonl`, { headers: { Authorization: `Bearer ${viewer.token}` } })).text();
  const checkpointsFile = path.join(home, 'exported-checkpoints.jsonl');
  fs.writeFileSync(checkpointsFile, jsonl);

  const clean = await captureConsole(() => runVerify({ command: 'verify', json: true, url: viewer.url, token: viewer.token, checkpoints: checkpointsFile }));
  assert.equal(clean.code, 0);
  const report = JSON.parse(clean.logs[0]);
  assert.ok(report.exported);
  assert.equal(report.exported.firstFailure, null);
  assert.ok(report.exported.checked >= 1);

  // A malformed export file is a usage error (the file could not be read), not an integrity failure.
  const badFile = path.join(home, 'bad-checkpoints.jsonl');
  fs.writeFileSync(badFile, 'not json\n');
  const bad = await captureConsole(() => runVerify({ command: 'verify', json: false, url: viewer.url, token: viewer.token, checkpoints: badFile }));
  assert.equal(bad.code, 2);
});

test('agent-viewer verify: a wrong token or an unreachable server could not verify (exit 3)', async () => {
  const wrongToken = await captureConsole(() => runVerify({ command: 'verify', json: false, url: viewer.url, token: 'definitely-wrong' }));
  assert.equal(wrongToken.code, 3);

  const unreachable = await captureConsole(() => runVerify({ command: 'verify', json: false, url: 'http://127.0.0.1:1' }));
  assert.equal(unreachable.code, 3);
});

test('agent-viewer verify: memory storage has nothing to verify (exit 3, no crash) in both output modes', () => {
  // A separate process: this file's own server module is already locked into SQLite storage by the env set above.
  const serverUrl = new URL('../server/index.ts', import.meta.url).href;
  const verifyUrl = new URL('../cli/verify.ts', import.meta.url).href;
  const script = `
    const { app, shutdown } = await import(${JSON.stringify(serverUrl)});
    const { runVerify } = await import(${JSON.stringify(verifyUrl)});
    const http = await import('node:http');
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const out = {};
    out.humanCode = await runVerify({ command: 'verify', json: false, url: baseUrl, token: 'mem-secret' });
    out.jsonCode = await runVerify({ command: 'verify', json: true, url: baseUrl, token: 'mem-secret' });
    server.close();
    await shutdown();
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const env = { ...process.env, NODE_ENV: 'test', AGENT_VIEWER_STORAGE: 'memory', AGENT_VIEWER_API_TOKEN: 'mem-secret' };
  delete env.AGENT_VIEWER_SQLITE_PATH;
  delete env.AGENT_VIEWER_API_KEY;
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(out.humanCode, 3);
  assert.equal(out.jsonCode, 3);
});
