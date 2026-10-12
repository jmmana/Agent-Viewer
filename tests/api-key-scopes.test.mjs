import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  SCOPES,
  effectiveScopes,
  parseScopes,
  parseStoredScopes,
  ScopeValidationError,
  ENV_TOKEN_PRINCIPAL,
  OPEN_MODE_PRINCIPAL,
} from '../server/auth/scopes.ts';
import { scopeForRoute } from '../server/auth/routePolicy.ts';
import { createSqliteApiKeyStore, ApiKeyValidationError, ApiKeyRevokedError, LastAdminError } from '../server/apiKeys.ts';
import { apiKeys } from '../server/db/migrations/0019-api-keys.ts';
import { apiKeyScopes } from '../server/db/migrations/0020-api-key-scopes.ts';
import { SQLiteEventStore } from '../server/store.ts';

const sorted = (set) => SCOPES.filter((s) => set.has(s));

// -------------------------------------------------------------
// Scope model (issue #108)
// -------------------------------------------------------------

test('effectiveScopes: admin implies everything, audit implies read, ingest and read imply nothing else', () => {
  assert.deepEqual(sorted(effectiveScopes(['admin'])), ['ingest', 'read', 'audit', 'admin']);
  assert.deepEqual(sorted(effectiveScopes(['audit'])), ['read', 'audit']);
  assert.deepEqual(sorted(effectiveScopes(['ingest'])), ['ingest']);
  assert.deepEqual(sorted(effectiveScopes(['read'])), ['read']);
  assert.deepEqual(sorted(effectiveScopes(['ingest', 'read'])), ['ingest', 'read']);
  // audit never implies ingest: an auditor cannot write into the log they audit.
  assert.equal(effectiveScopes(['audit']).has('ingest'), false);
  assert.equal(effectiveScopes([]).size, 0);
});

test('parseScopes: non-empty, distinct, known values only; canonical order', () => {
  assert.deepEqual(parseScopes(['read', 'ingest']), ['ingest', 'read']);
  assert.throws(() => parseScopes([]), ScopeValidationError);
  assert.throws(() => parseScopes(['read', 'read']), ScopeValidationError);
  assert.throws(() => parseScopes(['superuser']), ScopeValidationError);
  assert.throws(() => parseScopes(['Admin']), ScopeValidationError);
  assert.throws(() => parseScopes('admin'), ScopeValidationError);
  assert.throws(() => parseScopes(null), ScopeValidationError);
  assert.throws(() => parseScopes([1]), ScopeValidationError);
});

test('parseStoredScopes: a corrupted column fails closed to no scopes, never to the default', () => {
  assert.deepEqual(parseStoredScopes('["ingest"]'), ['ingest']);
  assert.deepEqual(parseStoredScopes('not json'), []);
  assert.deepEqual(parseStoredScopes('{"admin":true}'), []);
  assert.deepEqual(parseStoredScopes('["root","read"]'), ['read']);
  assert.deepEqual(parseStoredScopes(null), []);
});

test('env token and open mode are implicit admin principals', () => {
  assert.equal(ENV_TOKEN_PRINCIPAL.keyId, 'env-token');
  assert.equal(ENV_TOKEN_PRINCIPAL.source, 'env');
  assert.deepEqual(ENV_TOKEN_PRINCIPAL.granted, ['admin']);
  assert.deepEqual(sorted(ENV_TOKEN_PRINCIPAL.effective), ['ingest', 'read', 'audit', 'admin']);
  assert.deepEqual(OPEN_MODE_PRINCIPAL.granted, ['admin']);
});

test('scopeForRoute: declared routes map to their scope; anything else is admin (default deny)', () => {
  assert.equal(scopeForRoute('POST', '/events'), 'ingest');
  assert.equal(scopeForRoute('POST', '/events/batch'), 'ingest');
  assert.equal(scopeForRoute('POST', '/webhooks/generic'), 'ingest');
  assert.equal(scopeForRoute('GET', '/events'), 'read');
  assert.equal(scopeForRoute('HEAD', '/snapshot'), 'read');
  assert.equal(scopeForRoute('GET', '/sessions/abc'), 'read');
  assert.equal(scopeForRoute('GET', '/usage/export'), 'audit');
  assert.equal(scopeForRoute('GET', '/audit/verify'), 'audit');
  assert.equal(scopeForRoute('GET', '/keys'), 'audit');
  assert.equal(scopeForRoute('GET', '/keys/key_abc'), 'audit');
  assert.equal(scopeForRoute('GET', '/auth/whoami'), 'authenticated');
  // Express routing is case-insensitive and tolerates one trailing slash; so is the policy.
  assert.equal(scopeForRoute('GET', '/EVENTS/'), 'read');
  // Not declared: admin.
  assert.equal(scopeForRoute('POST', '/keys'), 'admin');
  assert.equal(scopeForRoute('PATCH', '/keys/key_abc'), 'admin');
  assert.equal(scopeForRoute('POST', '/keys/key_abc/revoke'), 'admin');
  assert.equal(scopeForRoute('GET', '/admin/retention'), 'admin');
  assert.equal(scopeForRoute('PUT', '/budgets/b1'), 'admin');
  assert.equal(scopeForRoute('GET', '/pricing'), 'admin');
  assert.equal(scopeForRoute('DELETE', '/events'), 'admin');
  assert.equal(scopeForRoute('GET', '/sessions/'), 'read'); // trailing slash on the list route
  assert.equal(scopeForRoute('GET', '/sessions/a/b'), 'admin');
  assert.equal(scopeForRoute('GET', '//events'), 'admin');
  assert.equal(scopeForRoute('GET', '/does-not-exist'), 'admin');
});

// -------------------------------------------------------------
// Migration and store
// -------------------------------------------------------------

test('migration 20: an existing #107 key becomes ["ingest"] (least privilege)', () => {
  const db = new DatabaseSync(':memory:');
  apiKeys.up(db);
  db.prepare(
    `INSERT INTO api_keys (id, name, name_norm, prefix, secret_hash, created_at, created_by) VALUES ('key_000000000001', 'old', 'old', 'avk_000000000001', ?, 1, 'bootstrap')`
  ).run('0'.repeat(64));
  apiKeyScopes.up(db);
  apiKeyScopes.up(db); // idempotent
  assert.equal(db.prepare('SELECT scopes FROM api_keys').get().scopes, '["ingest"]');
  db.close();
});

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-scopes-'));
  const eventStore = new SQLiteEventStore(path.join(dir, 'scopes.db'));
  try {
    return fn(createSqliteApiKeyStore(eventStore.getDatabaseHandle()));
  } finally {
    eventStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('SqliteApiKeyStore: scopes default to ingest, are validated, and round-trip through findForAuth/list', () => {
  withStore((registry) => {
    const plain = registry.create({ name: 'plain', createdBy: 'bootstrap' });
    assert.deepEqual(plain.scopes, ['ingest']);
    const auditor = registry.create({ name: 'auditor', createdBy: 'bootstrap', scopes: ['audit'] });
    assert.deepEqual(registry.findForAuth(auditor.id).scopes, ['audit']);
    assert.deepEqual(registry.get(auditor.id).scopes, ['audit']);
    assert.throws(() => registry.create({ name: 'bad', createdBy: 'bootstrap', scopes: [] }), ApiKeyValidationError);
    assert.throws(() => registry.create({ name: 'bad2', createdBy: 'bootstrap', scopes: ['root'] }), ApiKeyValidationError);
    assert.throws(() => registry.setScopes(auditor.id, undefined, { envTokenConfigured: true }), ApiKeyValidationError);
    assert.equal(registry.setScopes('key_nope', ['read'], { envTokenConfigured: true }), null);
    registry.revoke(plain.id, 'bootstrap');
    assert.throws(() => registry.setScopes(plain.id, ['read'], { envTokenConfigured: true }), ApiKeyRevokedError);
  });
});

test('SqliteApiKeyStore: the last active admin key cannot be revoked or demoted without an env token', () => {
  withStore((registry) => {
    const noEnv = { envTokenConfigured: false };
    const a = registry.create({ name: 'admin-a', createdBy: 'bootstrap', scopes: ['admin'] });
    assert.throws(() => registry.revoke(a.id, 'anonymous', noEnv), LastAdminError);
    assert.throws(() => registry.setScopes(a.id, ['audit'], noEnv), LastAdminError);
    assert.equal(registry.get(a.id).status, 'active');
    assert.deepEqual(registry.get(a.id).scopes, ['admin']);
    // Keeping admin is never a demotion.
    assert.deepEqual(registry.setScopes(a.id, ['ingest', 'admin'], noEnv).record.scopes, ['ingest', 'admin']);
    // With an env token configured the rule does not apply.
    assert.deepEqual(registry.setScopes(a.id, ['audit'], { envTokenConfigured: true }).record.scopes, ['audit']);
    registry.setScopes(a.id, ['admin'], { envTokenConfigured: true });
    // A second active admin lifts the rule; an expired admin would not count.
    const b = registry.create({ name: 'admin-b', createdBy: 'bootstrap', scopes: ['admin'] });
    assert.equal(registry.revoke(a.id, 'anonymous', noEnv).record.status, 'revoked');
    assert.throws(() => registry.revoke(b.id, 'anonymous', noEnv), LastAdminError);
    // Non-admin keys are never subject to the rule.
    const reader = registry.create({ name: 'reader', createdBy: 'bootstrap', scopes: ['read'] });
    assert.equal(registry.revoke(reader.id, 'anonymous', noEnv).record.status, 'revoked');
  });
});

// -------------------------------------------------------------
// HTTP surface (storage is chosen at module import, so each scenario runs in its own process)
// -------------------------------------------------------------

function runServerScript(env, body) {
  const serverUrl = new URL('../server/index.ts', import.meta.url).href;
  const script = `
    const http = await import('node:http');
    const { app } = await import(${JSON.stringify(serverUrl)});
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const req = async (method, p, token, payload) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      const res = await fetch(baseUrl + p, { method, headers, body: payload === undefined ? undefined : (typeof payload === 'string' ? payload : JSON.stringify(payload)) });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, json, wwwAuthenticate: res.headers.get('www-authenticate') };
    };
    const out = {};
    ${body}
    server.close();
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-scopes-http-'));
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], {
    cwd: dir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AGENT_VIEWER_STORAGE: 'sqlite',
      AGENT_VIEWER_SQLITE_PATH: path.join(dir, 'scopes.db'),
      AGENT_VIEWER_API_KEY: '',
      AGENT_VIEWER_WEBHOOK_SECRET: '',
      ...env,
    },
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

const EVENT = { schemaVersion: '1.0', type: 'agent.message.sent', source: 'agent:a', agentId: 'a', summary: 'hi', payload: { text: 'hi' } };

test('REST API (issue #108): env token is admin, 401 vs 403, policy before body validation, PATCH rules, whoami', () => {
  const out = runServerScript(
    { AGENT_VIEWER_API_TOKEN: 'scopes-env-secret' },
    `
    const env = 'scopes-env-secret';
    out.envWhoami = (await req('GET', '/api/v1/auth/whoami', env)).json;
    const mk = async (name, scopes) => (await req('POST', '/api/v1/keys', env, { name, scopes })).json;
    const ingest = await mk('ingest-key', ['ingest']);
    const reader = await mk('reader-key', ['read']);
    const auditor = await mk('auditor-key', ['audit']);
    const admin = await mk('admin-key', ['admin']);
    out.defaultScopes = (await req('POST', '/api/v1/keys', env, { name: 'no-scopes' })).json.scopes;
    out.badScopes = await req('POST', '/api/v1/keys', env, { name: 'bad', scopes: ['root'] });
    out.created = { ingest: ingest.scopes, auditor: auditor.scopes };

    out.noToken = await req('GET', '/api/v1/events');
    out.wrongToken = await req('GET', '/api/v1/events', 'not-the-token');
    out.ingestPost = await req('POST', '/api/v1/events', ingest.token, { ...${JSON.stringify(EVENT)}, id: 'evt_scope_1', timestamp: Date.now() });
    out.ingestRead = await req('GET', '/api/v1/events', ingest.token);
    out.readerRead = await req('GET', '/api/v1/events', reader.token);
    out.readerPost = await req('POST', '/api/v1/events', reader.token, '{ not json');
    out.readerPostInvalid = await req('POST', '/api/v1/events', reader.token, { nope: true });
    out.readerExport = await req('GET', '/api/v1/usage/export', reader.token);
    out.auditorKeys = await req('GET', '/api/v1/keys', auditor.token);
    out.auditorVerify = await req('GET', '/api/v1/audit/verify', auditor.token);
    out.auditorRead = await req('GET', '/api/v1/events', auditor.token);
    out.auditorIngest = await req('POST', '/api/v1/events', auditor.token, { ...${JSON.stringify(EVENT)}, id: 'evt_scope_2', timestamp: Date.now() });
    out.auditorCreate = await req('POST', '/api/v1/keys', auditor.token, { name: 'x', scopes: ['admin'] });
    out.auditorUnknown = await req('GET', '/api/v1/admin/retention', auditor.token);
    out.ingestCreateBadBody = await req('POST', '/api/v1/keys', ingest.token, { scopes: 'garbage' });
    out.readerPatch = await req('PATCH', '/api/v1/keys/' + reader.id, reader.token, { scopes: ['admin'] });
    out.adminPatchSelf = await req('PATCH', '/api/v1/keys/' + admin.id, admin.token, { scopes: ['ingest'] });
    out.adminPatchOther = await req('PATCH', '/api/v1/keys/' + reader.id, admin.token, { scopes: ['read', 'ingest'] });
    out.patchEnvToken = await req('PATCH', '/api/v1/keys/env-token', env, { scopes: ['read'] });
    out.patchExtraField = await req('PATCH', '/api/v1/keys/' + reader.id, env, { scopes: ['read'], name: 'renamed' });
    out.patchEmpty = await req('PATCH', '/api/v1/keys/' + reader.id, env, { scopes: [] });
    out.adminCreate = await req('POST', '/api/v1/keys', admin.token, { name: 'made-by-admin-key', scopes: ['read'] });
    out.readerAfterPatch = await req('GET', '/api/v1/auth/whoami', reader.token);
    out.readerWhoamiLegacy = await req('GET', '/api/v1/whoami', reader.token);
    out.ingestWhoami = (await req('GET', '/api/v1/auth/whoami', ingest.token)).json;
    out.auditorWhoami = (await req('GET', '/api/v1/auth/whoami', auditor.token)).json;
    out.queryToken = await req('GET', '/api/v1/events?token=' + reader.token);
    out.lastAdminWithEnv = await req('POST', '/api/v1/keys/' + admin.id + '/revoke', env);
    // auditor.token (read+audit, never patched above) stays a clean negative case; reader.token was widened
    // to include 'ingest' by adminPatchOther above.
    out.ingestOtlp = await req('POST', '/v1/logs', auditor.token, { resourceLogs: [] });
    `
  );

  assert.deepEqual(out.envWhoami, { keyId: 'env-token', name: 'AGENT_VIEWER_API_TOKEN', source: 'env', scopes: ['admin'], effectiveScopes: ['ingest', 'read', 'audit', 'admin'] });
  assert.deepEqual(out.defaultScopes, ['ingest']);
  assert.equal(out.badScopes.status, 400);
  assert.equal(out.badScopes.json.issues[0].path, 'scopes');

  // 401: no or wrong credential. 403: authenticated, wrong scope.
  assert.equal(out.noToken.status, 401);
  assert.equal(out.wrongToken.status, 401);
  assert.equal(out.ingestPost.status, 202);
  assert.equal(out.ingestRead.status, 403);
  assert.deepEqual(out.ingestRead.json, {
    error: 'insufficient_scope',
    message: out.ingestRead.json.message,
    required: 'read',
    granted: ['ingest'],
  });
  assert.equal(out.ingestRead.wwwAuthenticate, 'Bearer error="insufficient_scope", scope="read"');
  assert.equal(out.readerRead.status, 200);
  // Scope (403) is decided before the body is even looked at (400), malformed or merely invalid.
  assert.equal(out.readerPost.status === 400 && out.readerPost.json?.error === 'bad_request', true, 'malformed JSON is rejected by the global parser before auth (pre-existing)');
  assert.equal(out.readerPostInvalid.status, 403);
  assert.equal(out.readerPostInvalid.json.required, 'ingest');
  assert.equal(out.ingestCreateBadBody.status, 403);
  assert.equal(out.ingestCreateBadBody.json.required, 'admin');
  assert.equal(out.readerExport.status, 403);
  assert.equal(out.readerExport.json.required, 'audit');

  // The read-only auditor role.
  assert.equal(out.auditorKeys.status, 200);
  assert.equal(out.auditorVerify.status === 403, false);
  assert.equal(out.auditorRead.status, 200);
  assert.equal(out.auditorIngest.status, 403);
  assert.equal(out.auditorCreate.status, 403);
  assert.equal(out.auditorUnknown.status, 403);
  assert.equal(out.auditorUnknown.json.required, 'admin');

  // Escalation rules.
  assert.equal(out.readerPatch.status, 403);
  assert.equal(out.readerPatch.json.error, 'insufficient_scope');
  assert.equal(out.adminPatchSelf.status, 403);
  assert.equal(out.adminPatchSelf.json.error, 'cannot_modify_own_scopes');
  assert.equal(out.adminPatchOther.status, 200);
  assert.deepEqual(out.adminPatchOther.json.scopes, ['ingest', 'read']);
  assert.equal(out.patchEnvToken.status, 400);
  assert.equal(out.patchEnvToken.json.error, 'env_token_scopes_immutable');
  assert.equal(out.patchExtraField.status, 400);
  assert.equal(out.patchEmpty.status, 400);
  assert.equal(out.adminCreate.status, 201);
  assert.equal(out.adminCreate.json.createdBy.startsWith('key_'), true);

  // whoami for named keys; the legacy #107 /whoami still answers.
  assert.equal(out.readerAfterPatch.status, 200);
  assert.equal(out.readerAfterPatch.json.source, 'named');
  assert.deepEqual(out.readerAfterPatch.json.scopes, ['ingest', 'read']);
  assert.equal(out.readerAfterPatch.json.open, undefined);
  assert.equal(out.readerWhoamiLegacy.status, 200);
  assert.deepEqual(out.ingestWhoami.effectiveScopes, ['ingest']);
  assert.deepEqual(out.auditorWhoami.scopes, ['audit']);
  assert.deepEqual(out.auditorWhoami.effectiveScopes, ['read', 'audit']);

  // Query-string credentials are never accepted on /api/v1 (issue #71), whatever the key's scopes.
  assert.equal(out.queryToken.status, 401);
  assert.equal(out.queryToken.json.error, 'query_token_not_supported');

  // With an env token configured, the last named admin can be revoked: the env token stays admin.
  assert.equal(out.lastAdminWithEnv.status, 200);

  // OTLP is ingestion.
  assert.equal(out.ingestOtlp.status, 403);
  assert.equal(out.ingestOtlp.json.required, 'ingest');
});

test('REST API (issue #108): open mode is an implicit admin; last named admin is protected with 409 last_admin', () => {
  const out = runServerScript(
    { AGENT_VIEWER_API_TOKEN: '' },
    `
    out.openWhoami = (await req('GET', '/api/v1/auth/whoami')).json;
    const a = (await req('POST', '/api/v1/keys', undefined, { name: 'admin-a', scopes: ['admin'] })).json;
    out.namedWhoami = (await req('GET', '/api/v1/auth/whoami', a.token)).json;
    out.revokeLast = await req('POST', '/api/v1/keys/' + a.id + '/revoke');
    out.demoteLast = await req('PATCH', '/api/v1/keys/' + a.id, undefined, { scopes: ['audit'] });
    const b = (await req('POST', '/api/v1/keys', a.token, { name: 'admin-b', scopes: ['admin'] })).json;
    out.demoteWithSecond = await req('PATCH', '/api/v1/keys/' + a.id, b.token, { scopes: ['audit'] });
    out.revokeNowLast = await req('POST', '/api/v1/keys/' + b.id + '/revoke', b.token);
    `
  );
  assert.deepEqual(out.openWhoami, {
    keyId: 'anonymous',
    name: 'anonymous',
    source: 'env',
    scopes: ['admin'],
    effectiveScopes: ['ingest', 'read', 'audit', 'admin'],
    open: true,
  });
  assert.equal(out.namedWhoami.source, 'named');
  assert.deepEqual(out.namedWhoami.scopes, ['admin']);
  assert.equal(out.namedWhoami.open, true);
  assert.equal(out.revokeLast.status, 409);
  assert.equal(out.revokeLast.json.error, 'last_admin');
  assert.equal(out.demoteLast.status, 409);
  assert.equal(out.demoteLast.json.error, 'last_admin');
  assert.equal(out.demoteWithSecond.status, 200);
  assert.deepEqual(out.demoteWithSecond.json.scopes, ['audit']);
  assert.equal(out.revokeNowLast.status, 409);
  assert.equal(out.revokeNowLast.json.error, 'last_admin');
});
