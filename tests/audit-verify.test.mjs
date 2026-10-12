// Issue #106 (first sub-issue, "formal audit" theme): the chain-walk verifier (`server/audit/verify.ts`) and
// `GET /api/v1/audit/verify`. Builds a temp SQLite database through `SQLiteEventStore` (same pattern as
// `tests/event-store.test.mjs`), then tampers with it through a raw `DatabaseSync` handle, dropping the
// `events_immutable` trigger first exactly like `tests/event-store.test.mjs`'s own chain-tamper tests do (issue
// #105's own stated threat model: an operator with file access).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteEventStore } from '../server/store.ts';
import { verifyChain } from '../server/audit/verify.ts';
import { app } from '../server/index.ts';

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-viewer-audit-verify-${name}-`));
  return { dir, file: path.join(dir, `${name}.db`) };
}

function storeEvent(id, timestamp, extra = {}) {
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
    ...extra,
  };
}

async function withTempStore(name, fn) {
  const { dir, file } = tempDbPath(name);
  try {
    const store = new SQLiteEventStore(file);
    try {
      await fn(store, file);
    } finally {
      await store.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('verifyChain: a clean database with no checkpoints reports ok, firstBreak null, chain.checked equals the chained row count', async () => {
  await withTempStore('clean', async (store, file) => {
    for (let i = 1; i <= 25; i++) {
      await store.append(storeEvent(`evt_clean_${i}`, 1000 + i), { submitterId: 'shared-token' });
    }
    await store.close();

    const report = await verifyChain({ dbPath: file });
    assert.equal(report.ok, true);
    assert.equal(report.firstBreak, null);
    assert.equal(report.storage, 'sqlite');
    assert.equal(report.chain.checked, 25);
    assert.equal(report.chain.unchained, 0);
    assert.equal(report.chain.chainStartSeq, 1);
    assert.equal(report.chain.headSeq, 25);
    assert.equal(report.coverage.scope, 'full');
    assert.ok(report.warnings.some((w) => w.code === 'no_checkpoints'));
    assert.ok(!report.warnings.some((w) => w.code === 'legacy_rows'));
    assert.match(report.instanceId, /^[0-9a-f-]{36}$/);
  });
});

test('verifyChain: an empty database (no events at all) reports ok with an empty_chain warning, never a false break', async () => {
  await withTempStore('empty', async (_store, file) => {
    const report = await verifyChain({ dbPath: file });
    assert.equal(report.ok, true);
    assert.equal(report.firstBreak, null);
    assert.deepEqual(report.chain, { checked: 0, headSeq: null, headHash: null, chainStartSeq: null, unchained: 0 });
    assert.ok(report.warnings.some((w) => w.code === 'empty_chain'));
  });
});

test('verifyChain: editing event_json content is caught as hash_mismatch at that seq and event id', async () => {
  await withTempStore('edit-content', async (store, file) => {
    await store.append(storeEvent('evt_a', 1000), { submitterId: 'shared-token' });
    await store.append(storeEvent('evt_tamper', 2000), { submitterId: 'shared-token' });
    await store.append(storeEvent('evt_c', 3000), { submitterId: 'shared-token' });
    await store.close();

    const raw = new DatabaseSync(file);
    raw.exec('DROP TRIGGER events_immutable');
    const before = raw.prepare('SELECT event_json FROM events WHERE id = ?').get('evt_tamper');
    const edited = JSON.stringify({ ...JSON.parse(before.event_json), summary: 'tampered' });
    raw.prepare('UPDATE events SET event_json = ? WHERE id = ?').run(edited, 'evt_tamper');
    raw.close();

    const report = await verifyChain({ dbPath: file });
    assert.equal(report.ok, false);
    assert.equal(report.firstBreak.kind, 'hash_mismatch');
    assert.equal(report.firstBreak.seq, 2);
    assert.equal(report.firstBreak.eventId, 'evt_tamper');
    assert.equal(report.checkpoints.firstFailure, null, 'this slice never fails on checkpoints');
  });
});

test('verifyChain: editing only an indexed column (not event_json) is caught as column_mismatch naming the column', async () => {
  await withTempStore('edit-column', async (store, file) => {
    await store.append(storeEvent('evt_col_1', 1000), { submitterId: 'shared-token' });
    await store.close();

    const raw = new DatabaseSync(file);
    raw.exec('DROP TRIGGER events_immutable');
    raw.prepare("UPDATE events SET agent_id = 'someone-else' WHERE id = ?").run('evt_col_1');
    raw.close();

    const report = await verifyChain({ dbPath: file });
    assert.equal(report.ok, false);
    assert.equal(report.firstBreak.kind, 'column_mismatch');
    assert.equal(report.firstBreak.column, 'agent_id');
    assert.equal(report.firstBreak.seq, 1);
    assert.equal(report.firstBreak.message.includes('someone-else'), false, 'the message names the column, never its value');
  });
});

test('verifyChain: deleting a middle row is caught as link_mismatch on the next remaining row', async () => {
  await withTempStore('delete-middle', async (store, file) => {
    await store.append(storeEvent('evt_del_1', 1000), { submitterId: 'shared-token' });
    await store.append(storeEvent('evt_del_2', 2000), { submitterId: 'shared-token' });
    await store.append(storeEvent('evt_del_3', 3000), { submitterId: 'shared-token' });
    await store.close();

    const raw = new DatabaseSync(file);
    raw.exec('DROP TRIGGER events_immutable');
    raw.prepare('DELETE FROM events WHERE id = ?').run('evt_del_2');
    raw.close();

    const report = await verifyChain({ dbPath: file });
    assert.equal(report.ok, false);
    assert.equal(report.firstBreak.kind, 'link_mismatch');
    assert.equal(report.firstBreak.seq, 3);
    assert.equal(report.firstBreak.eventId, 'evt_del_3');
  });
});

test('verifyChain: swapping two rows\' seq values is caught (hash input includes seq)', async () => {
  await withTempStore('swap', async (store, file) => {
    await store.append(storeEvent('evt_swap_1', 1000), { submitterId: 'shared-token' });
    await store.append(storeEvent('evt_swap_2', 2000), { submitterId: 'shared-token' });
    await store.close();

    const raw = new DatabaseSync(file);
    raw.exec('DROP TRIGGER events_immutable');
    raw.prepare('UPDATE events SET seq = 3 WHERE id = ?').run('evt_swap_1');
    raw.prepare('UPDATE events SET seq = 1 WHERE id = ?').run('evt_swap_2');
    raw.prepare('UPDATE events SET seq = 2 WHERE id = ?').run('evt_swap_1');
    raw.close();

    const report = await verifyChain({ dbPath: file });
    assert.equal(report.ok, false);
    assert.ok(['hash_mismatch', 'link_mismatch'].includes(report.firstBreak.kind));
  });
});

test('verifyChain: inserting a forged row is caught (its prev_hash cannot match the real head)', async () => {
  await withTempStore('forge', async (store, file) => {
    await store.append(storeEvent('evt_real_1', 1000), { submitterId: 'shared-token' });
    await store.close();

    const raw = new DatabaseSync(file);
    raw.exec('DROP TRIGGER events_immutable');
    const forged = storeEvent('evt_forged', 9999);
    raw
      .prepare(
        `INSERT INTO events (id, type, timestamp, agent_id, severity, summary, payload, event_json, created_at, content_hash, matches_original, seq, prev_hash, hash, submitter_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        forged.id,
        forged.type,
        forged.timestamp,
        forged.agentId,
        forged.severity,
        forged.summary,
        JSON.stringify(forged.payload),
        JSON.stringify(forged),
        9999,
        'forged-content-hash',
        0,
        2,
        'f'.repeat(64),
        'a'.repeat(64),
        'attacker'
      );
    raw.close();

    const report = await verifyChain({ dbPath: file });
    assert.equal(report.ok, false);
    assert.equal(report.firstBreak.kind, 'link_mismatch');
    assert.equal(report.firstBreak.seq, 2);
    assert.equal(report.firstBreak.eventId, 'evt_forged');
  });
});

test('verifyChain: tampering with the first chained row\'s prev_hash (pointing away from the genesis checkpoint) is caught', async () => {
  await withTempStore('first-row-link', async (store, file) => {
    await store.append(storeEvent('evt_first', 1000), { submitterId: 'shared-token' });
    await store.close();

    const raw = new DatabaseSync(file);
    raw.exec('DROP TRIGGER events_immutable');
    // Recompute hash to stay internally self-consistent: only the link to genesis should break.
    const row = raw.prepare('SELECT * FROM events WHERE id = ?').get('evt_first');
    const fakePrevHash = 'c'.repeat(64);
    const { eventHash } = await import('../server/chain.ts');
    const newHash = eventHash({
      seq: Number(row.seq),
      prevHash: fakePrevHash,
      receivedAt: Number(row.created_at),
      submitterId: row.submitter_id,
      event: JSON.parse(row.event_json),
    });
    raw.prepare('UPDATE events SET prev_hash = ?, hash = ? WHERE id = ?').run(fakePrevHash, newHash, 'evt_first');
    raw.close();

    const report = await verifyChain({ dbPath: file });
    assert.equal(report.ok, false);
    assert.equal(report.firstBreak.kind, 'link_mismatch');
    assert.equal(report.firstBreak.seq, 1);
  });
});

test('verifyChain: an unparseable event_json is caught as unparseable_event', async () => {
  await withTempStore('unparseable', async (store, file) => {
    await store.append(storeEvent('evt_bad_json', 1000), { submitterId: 'shared-token' });
    await store.close();

    const raw = new DatabaseSync(file);
    raw.exec('DROP TRIGGER events_immutable');
    raw.prepare('UPDATE events SET event_json = ? WHERE id = ?').run('{not valid json', 'evt_bad_json');
    raw.close();

    const report = await verifyChain({ dbPath: file });
    assert.equal(report.ok, false);
    assert.equal(report.firstBreak.kind, 'unparseable_event');
    assert.equal(report.firstBreak.seq, 1);
  });
});

test('verifyChain: a row past every checkpoint\'s coverage with no hash is caught as missing_hash', async () => {
  await withTempStore('missing-hash', async (store, file) => {
    await store.append(storeEvent('evt_mh_1', 1000), { submitterId: 'shared-token' });
    await store.append(storeEvent('evt_mh_2', 2000), { submitterId: 'shared-token' });
    await store.close();

    const raw = new DatabaseSync(file);
    raw.exec('DROP TRIGGER events_immutable');
    const orphan = storeEvent('evt_orphan', 5000);
    raw
      .prepare(
        `INSERT INTO events (id, type, timestamp, agent_id, severity, summary, payload, event_json, created_at, content_hash, matches_original, seq, prev_hash, hash, submitter_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
      )
      .run(
        orphan.id,
        orphan.type,
        orphan.timestamp,
        orphan.agentId,
        orphan.severity,
        orphan.summary,
        JSON.stringify(orphan.payload),
        JSON.stringify(orphan),
        5000,
        'orphan-content-hash',
        0,
        3
      );
    raw.close();

    const report = await verifyChain({ dbPath: file });
    assert.equal(report.ok, false);
    assert.equal(report.firstBreak.kind, 'missing_hash');
    assert.equal(report.firstBreak.seq, 3);
    assert.equal(report.firstBreak.eventId, 'evt_orphan');
  });
});

test('verifyChain: legacy rows from before the chain started are counted in chain.unchained with a legacy_rows warning, and are not individually verified', async () => {
  const { dir, file } = tempDbPath('legacy-upgrade');
  try {
    const { MIGRATIONS } = await import('../server/db/migrations.ts');
    const legacyStore = new SQLiteEventStore(file, { migrations: MIGRATIONS.slice(0, 16) });
    await legacyStore.append(storeEvent('evt_legacy_1', 1000));
    await legacyStore.append(storeEvent('evt_legacy_2', 2000));
    await legacyStore.close();

    const upgradedStore = new SQLiteEventStore(file);
    await upgradedStore.append(storeEvent('evt_new_1', 3000), { submitterId: 'shared-token' });
    await upgradedStore.append(storeEvent('evt_new_2', 4000), { submitterId: 'shared-token' });
    await upgradedStore.close();

    const report = await verifyChain({ dbPath: file });
    assert.equal(report.ok, true);
    assert.equal(report.firstBreak, null);
    assert.equal(report.chain.unchained, 2);
    assert.equal(report.chain.checked, 2);
    assert.ok(report.warnings.some((w) => w.code === 'legacy_rows'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyChain: a store opened against a migrations list that stops before the chain migration reports everything as unchained', async () => {
  const { dir, file } = tempDbPath('chain-disabled');
  try {
    const { MIGRATIONS } = await import('../server/db/migrations.ts');
    const store = new SQLiteEventStore(file, { migrations: MIGRATIONS.slice(0, 16) });
    await store.append(storeEvent('evt_no_chain', 1000));
    await store.close();

    const report = await verifyChain({ dbPath: file });
    assert.equal(report.ok, true);
    assert.equal(report.chain.chainStartSeq, null);
    assert.equal(report.chain.checked, 0);
    assert.equal(report.chain.unchained, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyChain: a page size of 1 produces the same verdict as the default (paging does not change results)', async () => {
  await withTempStore('paging', async (store, file) => {
    for (let i = 1; i <= 12; i++) {
      await store.append(storeEvent(`evt_page_${i}`, 1000 + i), { submitterId: 'shared-token' });
    }
    await store.close();

    const raw = new DatabaseSync(file);
    raw.exec('DROP TRIGGER events_immutable');
    const before = raw.prepare('SELECT event_json FROM events WHERE id = ?').get('evt_page_7');
    const edited = JSON.stringify({ ...JSON.parse(before.event_json), summary: 'tampered' });
    raw.prepare('UPDATE events SET event_json = ? WHERE id = ?').run(edited, 'evt_page_7');
    raw.close();

    const fullPage = await verifyChain({ dbPath: file, pageSize: 5000 });
    const onePage = await verifyChain({ dbPath: file, pageSize: 1 });
    assert.deepEqual(onePage.firstBreak, fullPage.firstBreak);
    assert.equal(onePage.chain.checked, fullPage.chain.checked);
  });
});

test('verifyChain: scope=recent falls back to full when there are no checkpoints to anchor it to', async () => {
  await withTempStore('recent-fallback', async (store, file) => {
    await store.append(storeEvent('evt_recent_1', 1000), { submitterId: 'shared-token' });
    await store.close();

    const report = await verifyChain({ dbPath: file, scope: 'recent' });
    assert.equal(report.coverage.scope, 'full');
    assert.ok(!report.warnings.some((w) => w.code === 'partial_scope'));
  });
});

// -------------------------------------------------------------
// HTTP route: GET /api/v1/audit/verify
// -------------------------------------------------------------

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

test('GET /api/v1/audit/verify: memory storage reports the same disabled shape as GET /api/v1/audit/chain, not a 409', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/v1/audit/verify`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { enabled: false, reason: 'memory_storage', tamperEvident: false });
  } finally {
    server.close();
  }
});

test('GET /api/v1/audit/verify: an invalid scope is a 400 validation_failed', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/v1/audit/verify?scope=sometimes`);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'validation_failed');
  } finally {
    server.close();
  }
});

test('GET /api/v1/audit/verify (SQLite mode): wired end to end, requires the same Bearer token as /api/v1, and two concurrent requests share one walk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-api-audit-verify-'));
  try {
    const serverUrl = new URL('../server/index.ts', import.meta.url).href;
    const script = `
      const http = await import('node:http');
      const { app } = await import(${JSON.stringify(serverUrl)});
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = 'http://127.0.0.1:' + server.address().port;
      const authHeaders = { Authorization: 'Bearer verify-secret', 'Content-Type': 'application/json' };

      const unauth = await fetch(baseUrl + '/api/v1/audit/verify');

      for (let i = 1; i <= 5; i++) {
        await fetch(baseUrl + '/api/v1/events', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            schemaVersion: '1.0', id: 'evt_verify_api_' + i, type: 'agent.message.sent', timestamp: Date.now(),
            source: 'agent:writer', agentId: 'writer', summary: 'hi', payload: { text: 'hi' },
          }),
        });
      }

      const [a, b] = await Promise.all([
        fetch(baseUrl + '/api/v1/audit/verify', { headers: authHeaders }),
        fetch(baseUrl + '/api/v1/audit/verify', { headers: authHeaders }),
      ]);
      const aBody = await a.json();
      const bBody = await b.json();

      server.close();
      console.log(JSON.stringify({ unauthStatus: unauth.status, aStatus: a.status, aBody, bBody }));
      process.exit(0);
    `;
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      AGENT_VIEWER_STORAGE: 'sqlite',
      AGENT_VIEWER_SQLITE_PATH: path.join(dir, 'verify-api.db'),
      AGENT_VIEWER_API_TOKEN: 'verify-secret',
    };
    delete env.AGENT_VIEWER_API_KEY;
    const result = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
      { cwd: dir, env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').pop());

    assert.equal(out.unauthStatus, 401);
    assert.equal(out.aStatus, 200);
    assert.equal(out.aBody.ok, true);
    assert.equal(out.aBody.chain.checked, 5);
    // Two real HTTP round trips to the same process are not guaranteed to land in the same event-loop tick (a
    // walk this fast, over localhost, routinely finishes between the two arriving), so this only asserts that
    // both answer the same verdict over the same data, not that they literally shared one in-flight promise
    // (covered more directly by the in-flight map itself being keyed before any await, see server/index.ts).
    const strip = ({ verifiedAt, durationMs, ...rest }) => rest;
    assert.deepEqual(strip(out.aBody), strip(out.bBody));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
