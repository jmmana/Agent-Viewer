import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  API_KEY_TOKEN_PATTERN,
  verifyKeySecret,
  createSqliteApiKeyStore,
  createUnsupportedApiKeyStore,
  ApiKeyValidationError,
  ApiKeyNameTakenError,
  KeysUnsupportedError,
} from '../server/apiKeys.ts';
import { SQLiteEventStore } from '../server/store.ts';

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-keys-'));
  return { dir, file: path.join(dir, `${name}.db`) };
}

// -------------------------------------------------------------
// Pure helpers (issue #107)
// -------------------------------------------------------------

test('API_KEY_TOKEN_PATTERN: matches the documented shape only', () => {
  assert.ok(API_KEY_TOKEN_PATTERN.test('avk_3f9a1c7e02ab.' + 'A'.repeat(43)));
  assert.equal(API_KEY_TOKEN_PATTERN.test('avk_3f9a1c7e02ab.' + 'A'.repeat(42)), false);
  assert.equal(API_KEY_TOKEN_PATTERN.test('avk_3f9a1c7e02a.' + 'A'.repeat(43)), false); // 11 hex chars
  assert.equal(API_KEY_TOKEN_PATTERN.test('av_3f9a1c7e02ab.' + 'A'.repeat(43)), false); // wrong prefix
  assert.equal(API_KEY_TOKEN_PATTERN.test('avk_3F9A1C7E02AB.' + 'A'.repeat(43)), false); // uppercase hex
});

test('verifyKeySecret: only the exact secret matches; a single-character change is rejected; an unknown id (null stored hash) still runs a comparison and fails', () => {
  const secret = 'correct-secret-value';
  const hash = crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
  assert.equal(verifyKeySecret(secret, hash), true);
  assert.equal(verifyKeySecret(secret + 'x', hash), false);
  assert.equal(verifyKeySecret(secret.slice(0, -1), hash), false);
  assert.equal(verifyKeySecret(secret, null), false);
});

test('createUnsupportedApiKeyStore: every method throws KeysUnsupportedError except touchLastUsed, which is a silent no-op', () => {
  const store = createUnsupportedApiKeyStore();
  assert.throws(() => store.create({ name: 'x', createdBy: 'bootstrap' }), KeysUnsupportedError);
  assert.throws(() => store.findForAuth('key_x'), KeysUnsupportedError);
  assert.throws(() => store.get('key_x'), KeysUnsupportedError);
  assert.throws(() => store.list(), KeysUnsupportedError);
  assert.throws(() => store.revoke('key_x', 'bootstrap'), KeysUnsupportedError);
  assert.doesNotThrow(() => store.touchLastUsed('key_x'));
});

// -------------------------------------------------------------
// SqliteApiKeyStore (issue #107)
// -------------------------------------------------------------

test('SqliteApiKeyStore: create returns the token once, stores only a hash, name uniqueness is case-insensitive, expiry validated', () => {
  const { dir, file } = tempDbPath('registry');
  try {
    const eventStore = new SQLiteEventStore(file);
    const db = eventStore.getDatabaseHandle();
    const registry = createSqliteApiKeyStore(db);

    const created = registry.create({ name: '  CI Pipeline  ', expiresAt: null, createdBy: 'bootstrap' });
    assert.ok(API_KEY_TOKEN_PATTERN.test(created.token));
    assert.equal(created.name, 'CI Pipeline'); // trimmed
    assert.equal(created.id.startsWith('key_'), true);

    const row = db.prepare('SELECT secret_hash FROM api_keys WHERE id = ?').get(created.id);
    assert.equal(created.token.includes(row.secret_hash), false);
    assert.equal(row.secret_hash.length, 64);

    assert.throws(() => registry.create({ name: 'ci pipeline', createdBy: 'bootstrap' }), ApiKeyNameTakenError);
    assert.throws(() => registry.create({ name: '', createdBy: 'bootstrap' }), ApiKeyValidationError);
    assert.throws(() => registry.create({ name: 'valid', expiresAt: Date.now() - 1000, createdBy: 'bootstrap' }), ApiKeyValidationError);

    eventStore.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SqliteApiKeyStore: findForAuth reports active/expired/revoked status; revoke is idempotent and never deletes the row', () => {
  const { dir, file } = tempDbPath('registry-status');
  try {
    const eventStore = new SQLiteEventStore(file);
    const db = eventStore.getDatabaseHandle();
    const registry = createSqliteApiKeyStore(db);

    const created = registry.create({ name: 'expiring', expiresAt: Date.now() + 1000, createdBy: 'bootstrap' });
    assert.equal(registry.findForAuth(created.id).status, 'active');

    db.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run(Date.now() - 1, created.id);
    assert.equal(registry.findForAuth(created.id).status, 'expired');

    const second = registry.create({ name: 'revoke-me', createdBy: 'bootstrap' });
    const first = registry.revoke(second.id, 'bootstrap');
    assert.equal(first.alreadyRevoked, false);
    assert.equal(first.record.status, 'revoked');
    assert.equal(first.record.revokedBy, 'bootstrap');

    const retry = registry.revoke(second.id, 'someone-else');
    assert.equal(retry.alreadyRevoked, true);
    assert.equal(retry.record.revokedAt, first.record.revokedAt);
    assert.equal(retry.record.revokedBy, 'bootstrap'); // unchanged by the second call

    const stillPresent = db.prepare('SELECT 1 AS p FROM api_keys WHERE id = ?').get(second.id);
    assert.ok(stillPresent);
    assert.equal(registry.revoke('key_does_not_exist', 'bootstrap'), null);

    eventStore.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SqliteApiKeyStore: list reports eventCount/firstEventAt/lastEventAt from events.submitter_id, zero/null for an unused key', async () => {
  const { dir, file } = tempDbPath('registry-counts');
  try {
    const eventStore = new SQLiteEventStore(file);
    const db = eventStore.getDatabaseHandle();
    const registry = createSqliteApiKeyStore(db);
    const created = registry.create({ name: 'counted', createdBy: 'bootstrap' });

    const unused = registry.list().find((k) => k.id === created.id);
    assert.equal(unused.eventCount, 0);
    assert.equal(unused.firstEventAt, null);
    assert.equal(unused.lastEventAt, null);

    await eventStore.append(
      { schemaVersion: '1.0', id: 'evt_k1', type: 'agent.message.sent', timestamp: 1000, source: 'agent:a', agentId: 'a', severity: 'normal', summary: 's', payload: { text: 't' } },
      { submitterId: created.id }
    );
    await eventStore.append(
      { schemaVersion: '1.0', id: 'evt_k2', type: 'agent.message.sent', timestamp: 2000, source: 'agent:a', agentId: 'a', severity: 'normal', summary: 's', payload: { text: 't' } },
      { submitterId: created.id }
    );

    const used = registry.get(created.id);
    assert.equal(used.eventCount, 2);
    assert.equal(used.firstEventAt, 1000);
    assert.equal(used.lastEventAt, 2000);

    await eventStore.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// HTTP surface (SQLite mode; storage is chosen at module import, so this runs in its own process)
// -------------------------------------------------------------

function runServerScript(env, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-keys-http-'));
  const dbPath = path.join(dir, 'keys.db');
  const result = spawnSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
    {
      cwd: dir,
      env: { ...process.env, NODE_ENV: 'test', AGENT_VIEWER_STORAGE: 'sqlite', AGENT_VIEWER_SQLITE_PATH: dbPath, ...env },
      encoding: 'utf8',
    }
  );
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

test('REST API (issue #107): key lifecycle end to end over HTTP, SQLite mode', () => {
  const serverUrl = new URL('../server/index.ts', import.meta.url).href;
  const script = `
    const http = await import('node:http');
    const { app } = await import(${JSON.stringify(serverUrl)});
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const bootstrap = { Authorization: 'Bearer keys-bootstrap-secret', 'Content-Type': 'application/json' };

    const whoamiBootstrap = await (await fetch(baseUrl + '/api/v1/whoami', { headers: bootstrap })).json();

    const createRes = await fetch(baseUrl + '/api/v1/keys', { method: 'POST', headers: bootstrap, body: JSON.stringify({ name: 'ci-pipeline' }) });
    const created = await createRes.json();

    const unauthedCreate = await fetch(baseUrl + '/api/v1/keys', {
      method: 'POST', headers: { Authorization: 'Bearer ' + created.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'should-fail' }),
    });

    const whoamiKey = await (await fetch(baseUrl + '/api/v1/whoami', { headers: { Authorization: 'Bearer ' + created.token } })).json();

    const ingestWithKey = await fetch(baseUrl + '/api/v1/events', {
      method: 'POST', headers: { Authorization: 'Bearer ' + created.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: '1.0', id: 'evt_by_key', type: 'agent.message.sent', timestamp: Date.now(), source: 'agent:a', agentId: 'a', summary: 'hi', payload: { text: 'hi' } }),
    });
    const ingestWithKeyBody = await ingestWithKey.json();

    const listRes = await fetch(baseUrl + '/api/v1/keys', { headers: bootstrap });
    const list = await listRes.json();

    const revokeRes = await fetch(baseUrl + '/api/v1/keys/' + created.id + '/revoke', { method: 'POST', headers: bootstrap });
    const revoked = await revokeRes.json();
    const revokeAgainRes = await fetch(baseUrl + '/api/v1/keys/' + created.id + '/revoke', { method: 'POST', headers: bootstrap });
    const revokedAgain = await revokeAgainRes.json();

    const afterRevoke = await fetch(baseUrl + '/api/v1/events', {
      method: 'POST', headers: { Authorization: 'Bearer ' + created.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: '1.0', id: 'evt_after_revoke', type: 'agent.message.sent', timestamp: Date.now(), source: 'agent:a', agentId: 'a', summary: 'hi', payload: { text: 'hi' } }),
    });
    const afterRevokeBody = await afterRevoke.json();

    const eventsIncludeAudit = await (await fetch(baseUrl + '/api/v1/events?includeAudit=true', { headers: bootstrap })).json();
    const eventsDefault = await (await fetch(baseUrl + '/api/v1/events', { headers: bootstrap })).json();
    const notFound = await fetch(baseUrl + '/api/v1/keys/key_does_not_exist', { headers: bootstrap });

    server.close();
    console.log(JSON.stringify({
      whoamiBootstrap, createStatus: createRes.status, created,
      unauthedCreateStatus: unauthedCreate.status,
      whoamiKey, ingestWithKeyStatus: ingestWithKey.status, ingestWithKeyBody,
      list, revokeStatus: revokeRes.status, revoked, revokedAgain,
      afterRevokeStatus: afterRevoke.status, afterRevokeBody,
      auditTypesPresent: eventsIncludeAudit.events.some((e) => e.type === 'audit.key.created' || e.type === 'audit.key.revoked'),
      auditTypesAbsentByDefault: !eventsDefault.events.some((e) => e.type.startsWith('audit.')),
      notFoundStatus: notFound.status,
    }));
    process.exit(0);
  `;
  const result = runServerScript({ AGENT_VIEWER_API_TOKEN: 'keys-bootstrap-secret' }, script);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim().split('\n').pop());

  assert.deepEqual(out.whoamiBootstrap, { kind: 'bootstrap', id: 'bootstrap' });

  assert.equal(out.createStatus, 201);
  assert.ok(out.created.token.startsWith('avk_'));
  assert.equal(out.created.name, 'ci-pipeline');

  assert.equal(out.unauthedCreateStatus, 403);

  assert.deepEqual(out.whoamiKey, { kind: 'key', id: out.created.id, name: 'ci-pipeline' });

  assert.equal(out.ingestWithKeyStatus, 202);
  assert.equal(out.ingestWithKeyBody.accepted, true);

  assert.equal(out.list.keys.length, 1);
  assert.equal(out.list.keys[0].id, out.created.id);
  assert.equal(out.list.keys[0].eventCount, 1);

  assert.equal(out.revokeStatus, 200);
  assert.equal(out.revoked.status, 'revoked');
  assert.deepEqual(out.revokedAgain, out.revoked);

  assert.equal(out.afterRevokeStatus, 401);
  assert.equal(out.afterRevokeBody.error, 'key_revoked');

  assert.equal(out.auditTypesPresent, true);
  assert.equal(out.auditTypesAbsentByDefault, true);

  assert.equal(out.notFoundStatus, 404);
});

test('REST API (issue #107): key endpoints answer 501 keys_require_sqlite in memory mode; the bootstrap token still works', () => {
  const serverUrl = new URL('../server/index.ts', import.meta.url).href;
  const script = `
    const http = await import('node:http');
    const { app } = await import(${JSON.stringify(serverUrl)});
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const headers = { Authorization: 'Bearer memory-bootstrap-secret', 'Content-Type': 'application/json' };

    const createRes = await fetch(baseUrl + '/api/v1/keys', { method: 'POST', headers, body: JSON.stringify({ name: 'x' }) });
    const listRes = await fetch(baseUrl + '/api/v1/keys', { headers });
    const whoami = await (await fetch(baseUrl + '/api/v1/whoami', { headers })).json();

    server.close();
    console.log(JSON.stringify({ createStatus: createRes.status, listStatus: listRes.status, whoami }));
    process.exit(0);
  `;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-keys-mem-'));
  const result = spawnSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
    { cwd: dir, env: { ...process.env, NODE_ENV: 'test', AGENT_VIEWER_API_TOKEN: 'memory-bootstrap-secret' }, encoding: 'utf8' }
  );
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(out.createStatus, 501);
  assert.equal(out.listStatus, 501);
  assert.deepEqual(out.whoami, { kind: 'bootstrap', id: 'bootstrap' });
});
