// Issue #409 (sub-issue of #111, docs only): `docs/migrating-to-0.8.md` claims that (a) the bootstrap token
// (`AGENT_VIEWER_API_TOKEN`) keeps authenticating exactly as before after an upgrade, and (b) rows stored
// before the hash chain existed (migration 17, `event-hash-chain`) are reported by `GET /api/v1/audit/verify`
// as counted in `chain.unchained` with a `legacy_rows` warning, never as individually verified and never as
// tampered. This test builds a database staged at schema version 16 (as if written by a pre-0.8.0, "0.7.0
// shape" server, the exact pattern `tests/audit-verify.test.mjs`'s "legacy rows" case and
// `tests/usage-rollup-migration.test.mjs` already use), appends a couple of pre-chain events, then starts the
// real 0.8.0 server on that same file (running migrations 17-22) and asserts both documented claims over real
// HTTP, not just against the pure `verifyChain` helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'av-audit-migration-'));
const dbPath = path.join(home, 'pre-0.8.0.db');
const bootstrapToken = 'legacy-bootstrap-token-for-migration-test';

process.env.AGENT_VIEWER_HOME = home;
process.env.AGENT_VIEWER_STORAGE = 'sqlite';
process.env.AGENT_VIEWER_SQLITE_PATH = dbPath;
delete process.env.AGENT_VIEWER_API_KEY;

// Stage a "0.7.0 shape" database: every migration up to, but not including, the first 0.8.0 migration
// (17, event-hash-chain). Two events are appended here, before the chain exists, exactly like a pre-0.8.0
// server would have written them.
const { SQLiteEventStore } = await import('../server/store.ts');
const { MIGRATIONS } = await import('../server/db/migrations.ts');

function legacyEvent(id, timestamp) {
  return {
    schemaVersion: '1.0',
    id,
    type: 'agent.message.sent',
    timestamp,
    source: 'agent:writer',
    agentId: 'writer',
    severity: 'normal',
    summary: `Message ${id}`,
    payload: { text: `Text ${id}` },
  };
}

const stagedMigrations = MIGRATIONS.slice(0, 16);
assert.ok(stagedMigrations.length < MIGRATIONS.length, 'the full migration list must be longer than the staged one');
const legacyStore = new SQLiteEventStore(dbPath, { migrations: stagedMigrations });
await legacyStore.init();
await legacyStore.append(legacyEvent('evt_pre_chain_1', 1_700_000_000_000));
await legacyStore.append(legacyEvent('evt_pre_chain_2', 1_700_000_001_000));
await legacyStore.close();

// Now start the real 0.8.0 server against that same file: this is what "upgrade" means in practice, and it
// runs migrations 17 through 22 (hash chain, audit-meta, named keys, key scopes, tombstones/legal hold, signed
// checkpoints) the first time the file is opened by current code.
const { startViewer } = await import('../cli/start.ts');

let viewer;

test.before(async () => {
  viewer = await startViewer({
    command: 'start',
    token: bootstrapToken,
    port: 0,
    host: '127.0.0.1',
    demo: false,
    open: false,
    metrics: false,
  });
});

test.after(async () => {
  await viewer.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('migration notes: the bootstrap token keeps authenticating as the implicit admin "bootstrap" identity after upgrading a pre-0.8.0 database', async () => {
  const res = await fetch(`${viewer.url}/api/v1/whoami`, {
    headers: { Authorization: `Bearer ${bootstrapToken}` },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { kind: 'bootstrap', id: 'bootstrap' });
});

test('migration notes: pre-chain events upgraded from a 0.7.0-shape database are reported as unchained with a legacy_rows warning, never as tampered', async () => {
  const res = await fetch(`${viewer.url}/api/v1/audit/verify`, {
    headers: { Authorization: `Bearer ${bootstrapToken}` },
  });
  assert.equal(res.status, 200);
  const report = await res.json();

  // The documented claim: a clean report with pre-chain rows present still reads ok: true, firstBreak: null.
  assert.equal(report.ok, true);
  assert.equal(report.firstBreak, null);

  // The two rows staged before migration 17 ran are counted as unchained, not individually walked.
  assert.equal(report.chain.unchained, 2);

  // The documented warning code and message shape; there is no separate "pre-chain" status anywhere in the
  // response, exactly as the migration guide states.
  const legacyWarning = report.warnings.find((w) => w.code === 'legacy_rows');
  assert.ok(legacyWarning, 'expected a legacy_rows warning for the pre-chain rows');
  assert.match(legacyWarning.message, /2 unchained row\(s\)/);
});
