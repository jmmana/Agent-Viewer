// Issue #402 (third sub-issue of #110, "offline-verifiable audit bundle"): `agent-viewer audit export`/`verify`.
// Parsing is tested directly against `parseCliArgs`; the end-to-end behavior runs a real in-process server
// (`cli/start.ts`'s `startViewer`, the same pattern `tests/cli-launch.test.mjs` uses) with SQLite storage, so
// `runAudit` exercises a genuine `GET /api/v1/audit/bundle` round trip and a genuine child-process run of
// `scripts/verify-audit-bundle.mjs`, not a mock of either.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'av-cli-audit-'));
process.env.AGENT_VIEWER_HOME = home;
process.env.AGENT_VIEWER_STORAGE = 'sqlite';
process.env.AGENT_VIEWER_SQLITE_PATH = path.join(home, 'cli-audit.db');
delete process.env.AGENT_VIEWER_API_KEY;

const { startViewer } = await import('../cli/start.ts');
const { runAudit } = await import('../cli/audit.ts');
const { CliUsageError, parseCliArgs } = await import('../cli/args.ts');

test('parseCliArgs: audit export', () => {
  assert.deepEqual(
    parseCliArgs(['audit', 'export', '--out', 'bundle.jsonl', '--from-seq', '2', '--to-seq', '9', '--gzip', '--url', 'http://127.0.0.1:8787', '--token', 't'], '/work'),
    {
      command: 'audit',
      action: 'export',
      out: 'bundle.jsonl',
      fromSeq: 2,
      toSeq: 9,
      gzip: true,
      json: false,
      requireComplete: false,
      url: 'http://127.0.0.1:8787',
      token: 't',
    }
  );
  // Minimal: only --out is required.
  const minimal = parseCliArgs(['audit', 'export', '--out', 'b.jsonl'], '/work');
  assert.equal(minimal.out, 'b.jsonl');
  assert.equal(minimal.fromSeq, undefined);
  assert.equal(minimal.gzip, false);

  assert.throws(() => parseCliArgs(['audit', 'export'], '/work'), CliUsageError, 'missing --out');
  assert.throws(() => parseCliArgs(['audit', 'export', '--out', 'b.jsonl', '--from-seq', 'nope'], '/work'), CliUsageError, 'non-integer --from-seq');
  assert.throws(() => parseCliArgs(['audit', 'export', '--out', 'b.jsonl', '--from-seq', '0'], '/work'), CliUsageError, '--from-seq must be positive');
});

test('parseCliArgs: audit verify', () => {
  assert.deepEqual(
    parseCliArgs(['audit', 'verify', 'bundle.jsonl', '--trusted-key', 'ed25519:' + 'a'.repeat(64), '--expect-checkpoint', '5:' + 'b'.repeat(64), '--require-complete', '--json'], '/work'),
    {
      command: 'audit',
      action: 'verify',
      file: 'bundle.jsonl',
      trustedKey: 'ed25519:' + 'a'.repeat(64),
      expectCheckpoint: '5:' + 'b'.repeat(64),
      requireComplete: true,
      json: true,
      gzip: false,
    }
  );
  const minimal = parseCliArgs(['audit', 'verify', 'bundle.jsonl'], '/work');
  assert.equal(minimal.file, 'bundle.jsonl');
  assert.equal(minimal.trustedKey, undefined);
  assert.equal(minimal.requireComplete, false);

  assert.throws(() => parseCliArgs(['audit', 'verify'], '/work'), CliUsageError, 'missing file');
  assert.throws(() => parseCliArgs(['audit'], '/work'), CliUsageError, 'missing action');
  assert.throws(() => parseCliArgs(['audit', 'bogus'], '/work'), CliUsageError, 'unknown action');
  assert.throws(() => parseCliArgs(['audit', 'verify', 'a.jsonl', 'b.jsonl'], '/work'), CliUsageError, 'extra positional');
});

test('agent-viewer audit export + verify work end to end against a locally started SQLite server', async () => {
  const viewer = await startViewer({ command: 'start', port: 0, host: '127.0.0.1', demo: false, open: false, metrics: false });
  try {
    const postEvent = await fetch(`${viewer.url}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewer.token}` },
      body: JSON.stringify({
        schemaVersion: '1.0',
        id: 'evt_cli_audit_1',
        type: 'agent.message.sent',
        timestamp: Date.now(),
        source: 'agent:w',
        agentId: 'w',
        summary: 'hi',
        payload: { text: 'hi' },
      }),
    });
    assert.equal(postEvent.status, 202);

    const outFile = path.join(home, 'exported.avbundle.jsonl');
    const exportCode = await runAudit({
      command: 'audit',
      action: 'export',
      out: outFile,
      gzip: false,
      json: false,
      requireComplete: false,
      url: viewer.url,
      token: viewer.token,
    });
    assert.equal(exportCode, 0);
    assert.ok(fs.existsSync(outFile));
    assert.ok(!fs.existsSync(`${outFile}.tmp-${process.pid}`), 'the temp file is renamed away, not left behind');
    const lines = fs.readFileSync(outFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].kind, 'header');
    assert.equal(lines[lines.length - 1].kind, 'footer');

    // verify runs the real scripts/verify-audit-bundle.mjs as a child process and returns its exit code unchanged.
    const verifyCode = await runAudit({
      command: 'audit',
      action: 'verify',
      file: outFile,
      requireComplete: false,
      json: true,
      gzip: false,
    });
    assert.equal(verifyCode, 3); // unpinned (no --trusted-key), otherwise clean

    // A nonexistent file: the script itself reports exit 2, unchanged by this CLI layer.
    const missingCode = await runAudit({
      command: 'audit',
      action: 'verify',
      file: path.join(home, 'does-not-exist.jsonl'),
      requireComplete: false,
      json: false,
      gzip: false,
    });
    assert.equal(missingCode, 2);
  } finally {
    await viewer.close();
  }
});

test('agent-viewer audit export against a wrong token fails cleanly and leaves no file at --out', async () => {
  const viewer = await startViewer({ command: 'start', port: 0, host: '127.0.0.1', demo: false, open: false, metrics: false });
  try {
    const outFile = path.join(home, 'should-not-exist.avbundle.jsonl');
    const code = await runAudit({
      command: 'audit',
      action: 'export',
      out: outFile,
      gzip: false,
      json: false,
      requireComplete: false,
      url: viewer.url,
      token: 'definitely-wrong',
    });
    assert.equal(code, 1);
    assert.ok(!fs.existsSync(outFile));
  } finally {
    await viewer.close();
  }
});

test.after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
