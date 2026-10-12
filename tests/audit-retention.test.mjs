// Issue #109: chain-compatible retention. Tombstones never touch the chain or header columns, the
// `events_immutable` trigger allows exactly the tombstone transition, a legal hold (checked inside each batch's
// own write transaction) freezes every destruction path, clients can never submit `audit.*` types or the
// server-assigned fields, and `GET /api/v1/audit/retention` answers in both storage modes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteEventStore, MemoryEventStore, parseRetentionBatchSize } from '../server/store.ts';
import { eventHash } from '../server/chain.ts';
import { normalizeCanonicalEvent } from '../src/integrations/canonicalTypes.ts';
import { app } from '../server/index.ts';

const ACTOR = { kind: 'api', name: 'api-token' };
const HEADER_COLUMNS = [
  'id', 'seq', 'hash', 'prev_hash', 'submitter_id', 'content_hash', 'created_at', 'type', 'timestamp',
  'runtime_id', 'session_id', 'agent_id', 'task_id', 'severity', 'request_provider', 'request_id',
  'duplicate_of', 'matches_original',
];

function storeEvent(id, timestamp) {
  return {
    schemaVersion: '1.0',
    id,
    type: 'agent.message.sent',
    timestamp,
    source: 'agent:writer',
    agentId: 'writer',
    severity: 'normal',
    summary: `Secret summary ${id}`,
    payload: { text: `Secret text ${id}` },
  };
}

async function withTempStore(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-viewer-audit-retention-${name}-`));
  const file = path.join(dir, `${name}.db`);
  const store = new SQLiteEventStore(file);
  try {
    await fn(store, file);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function info(extra = {}) {
  return { reason: 'retention', rulesVersion: null, actor: ACTOR, submitterId: 'bootstrap', ...extra };
}

function readRows(file) {
  const raw = new DatabaseSync(file);
  try {
    return raw.prepare('SELECT * FROM events ORDER BY seq').all();
  } finally {
    raw.close();
  }
}

/**
 * The tombstone-aware walk a verifier needs (issue #109): every link still matches; an untombstoned row's hash
 * recomputes from its `event_json`; a tombstoned row's stored hash is exactly the one its (chained, recomputable)
 * audit event committed to. Returns the first problem, or null.
 */
function tombstoneAwareWalk(rows) {
  const bySeq = new Map(rows.map((row) => [Number(row.seq), row]));
  let prev = null;
  for (const row of rows.filter((r) => r.hash !== null)) {
    if (prev && row.prev_hash !== prev.hash) return `broken link at seq ${row.seq}`;
    if (row.tombstoned_at === null) {
      const recomputed = eventHash({
        seq: Number(row.seq),
        prevHash: row.prev_hash,
        receivedAt: Number(row.created_at),
        submitterId: row.submitter_id,
        event: JSON.parse(row.event_json),
      });
      if (recomputed !== row.hash) return `hash mismatch at seq ${row.seq}`;
    } else {
      const audit = bySeq.get(Number(row.tombstone_audit_seq));
      if (!audit || audit.tombstoned_at !== null) return `missing audit event for seq ${row.seq}`;
      const committed = JSON.parse(audit.payload).events.find((e) => e.id === row.id);
      if (!committed || committed.hash !== row.hash || committed.contentHash !== row.content_hash) {
        return `tombstone at seq ${row.seq} not committed by its audit event`;
      }
    }
    prev = row;
  }
  return null;
}

test('parseRetentionBatchSize: default 5000, accepts 1..100000, rejects anything else', () => {
  assert.equal(parseRetentionBatchSize(undefined), 5000);
  assert.equal(parseRetentionBatchSize('  '), 5000);
  assert.equal(parseRetentionBatchSize('250'), 250);
  for (const bad of ['0', '-1', '1.5', 'abc', '100001', '05']) {
    assert.throws(() => parseRetentionBatchSize(bad), /AGENT_VIEWER_RETENTION_BATCH_SIZE/);
  }
});

test('tombstone (SQLite): content replaced as a whole, salt destroyed; seq, chain, content_hash and headers untouched; chain still accountable', async () => {
  await withTempStore('preserve', async (store, file) => {
    for (let i = 1; i <= 5; i++) await store.append(storeEvent(`evt_${i}`, 1000 + i), { submitterId: 'bootstrap' });
    const before = readRows(file);

    const result = await store.tombstone(['evt_2', 'evt_4', 'evt_missing'], info());
    assert.equal(result.tombstoned, 2);
    assert.equal(result.skipped, 1);
    assert.equal(result.batches, 1);
    assert.equal(result.stoppedByHold, false);
    assert.equal(result.auditEventIds.length, 1);

    const after = readRows(file);
    assert.equal(after.length, 6, 'nothing deleted; one audit event added');
    for (const original of before) {
      const row = after.find((r) => r.id === original.id);
      for (const column of HEADER_COLUMNS) assert.deepEqual(row[column], original[column], `${column} of ${row.id}`);
    }

    for (const id of ['evt_2', 'evt_4']) {
      const row = after.find((r) => r.id === id);
      assert.equal(row.summary, '[removed]');
      assert.equal(row.payload, '{}');
      assert.equal(row.content_salt, null);
      assert.equal(row.tombstone_reason, 'retention');
      assert.equal(row.tombstone_rules_version, null);
      assert.equal(typeof row.tombstoned_at, 'number');
      const parsed = JSON.parse(row.event_json);
      assert.equal(parsed.summary, '[removed]');
      assert.deepEqual(parsed.payload, {});
      assert.equal(parsed.tombstone.auditEventId, result.auditEventIds[0]);
      assert.equal(parsed.tombstone.contentHash, row.content_hash);
      assert.ok(!row.event_json.includes('Secret'), 'no original content survives in event_json');
    }
    const untouched = after.find((r) => r.id === 'evt_3');
    assert.equal(untouched.summary, 'Secret summary evt_3');
    assert.equal(untouched.tombstoned_at, null);

    const audit = after.find((r) => r.id === result.auditEventIds[0]);
    assert.equal(audit.type, 'audit.retention.purged');
    assert.ok(audit.hash, 'the audit event is itself chained');
    assert.equal(after.find((r) => r.id === 'evt_2').tombstone_audit_seq, audit.seq);
    const auditPayload = JSON.parse(audit.payload);
    assert.deepEqual(auditPayload.actor, ACTOR);
    assert.deepEqual(auditPayload.events.map((e) => e.id), ['evt_2', 'evt_4']);
    assert.ok(!audit.payload.includes('Secret'), 'audit payload is content-free');

    assert.equal(tombstoneAwareWalk(after), null);

    // Idempotent: a second run over the same ids finds nothing eligible and writes no audit event.
    const again = await store.tombstone(['evt_2', 'evt_4'], info());
    assert.deepEqual(again, { tombstoned: 0, skipped: 2, batches: 0, auditEventIds: [], stoppedByHold: false });
    assert.equal(readRows(file).length, 6);

    // Audit events themselves can never be tombstoned.
    const auditAttempt = await store.tombstone([result.auditEventIds[0]], info());
    assert.equal(auditAttempt.tombstoned, 0);

    // Reads see the tombstone; the chain keeps growing from the right head.
    const listed = await store.list({ limit: 10 });
    assert.equal(listed.find((e) => e.id === 'evt_2').summary, '[removed]');
    await store.append(storeEvent('evt_6', 1006), { submitterId: 'bootstrap' });
    assert.equal(tombstoneAwareWalk(readRows(file)), null);
  });
});

test('events_immutable: only the exact tombstone transition is allowed on a chained row', async () => {
  await withTempStore('trigger', async (store, file) => {
    await store.append(storeEvent('evt_a', 1000), { submitterId: 'bootstrap' });
    await store.append(storeEvent('evt_b', 2000), { submitterId: 'bootstrap' });
    const { auditEventIds } = await store.tombstone(['evt_b'], info());
    await store.close();

    const raw = new DatabaseSync(file);
    try {
      const immutable = /chained events are immutable/;
      assert.throws(() => raw.prepare("UPDATE events SET summary = 'edited' WHERE id = 'evt_a'").run(), immutable);
      assert.throws(() => raw.prepare("UPDATE events SET created_at = 1 WHERE id = 'evt_a'").run(), immutable);
      // A tombstone that also edits a header/chain column is refused.
      assert.throws(
        () => raw.prepare(
          "UPDATE events SET summary = '[removed]', payload = '{}', content_salt = NULL, tombstoned_at = 1, tombstone_reason = 'retention', tombstone_audit_seq = 1, content_hash = 'x' WHERE id = 'evt_a'"
        ).run(),
        immutable
      );
      // A tombstone that keeps any content is refused.
      assert.throws(
        () => raw.prepare(
          "UPDATE events SET summary = 'kept', payload = '{}', tombstoned_at = 1, tombstone_reason = 'retention', tombstone_audit_seq = 1 WHERE id = 'evt_a'"
        ).run(),
        immutable
      );
      // An already-tombstoned row and an audit row are frozen for good.
      assert.throws(() => raw.prepare("UPDATE events SET tombstone_reason = 'redaction' WHERE id = 'evt_b'").run(), immutable);
      assert.throws(() => raw.prepare(`UPDATE events SET severity = 'high' WHERE id = '${auditEventIds[0]}'`).run(), immutable);
    } finally {
      raw.close();
    }
  });
});

test('legal hold: blocks tombstoning and the #70 purge; a hold placed mid-run stops it cleanly between batches; release re-enables', async () => {
  await withTempStore('hold', async (store, file) => {
    for (let i = 1; i <= 6; i++) await store.append(storeEvent(`evt_${i}`, 1000 + i), { submitterId: 'bootstrap' });
    const ids = ['evt_1', 'evt_2', 'evt_3', 'evt_4', 'evt_5', 'evt_6'];

    // The first batch commits synchronously inside `tombstone()` (no await before it); the hold placed right
    // after is seen by the next batch's own transaction, not by any check made before the run started.
    const running = store.tombstone(ids, info({ batchSize: 2 }));
    const placed = await store.setLegalHold({ active: true, reason: 'litigation 42', actor: ACTOR, submitterId: 'bootstrap' });
    assert.equal(placed.changed, true);
    const midRun = await running;
    assert.equal(midRun.stoppedByHold, true);
    assert.equal(midRun.tombstoned, 2);
    assert.equal(midRun.batches, 1);

    let rows = readRows(file);
    assert.equal(rows.filter((r) => r.tombstoned_at !== null).length, 2, 'the committed batch stays');

    const blocked = await store.tombstone(['evt_5'], info());
    assert.deepEqual(blocked, { tombstoned: 0, skipped: 0, batches: 0, auditEventIds: [], stoppedByHold: true });

    const purged = await store.purge({ eventsCutoffMs: Date.now() + 60_000 });
    assert.equal(purged.eventsDeleted, 0, 'the scheduled delete path honors the hold too');

    const twice = await store.setLegalHold({ active: true, reason: 'again', actor: ACTOR, submitterId: 'bootstrap' });
    assert.equal(twice.changed, false);
    assert.equal(twice.reason, 'already_active');

    const released = await store.setLegalHold({ active: false, reason: 'case closed', actor: ACTOR, submitterId: 'bootstrap' });
    assert.equal(released.changed, true);
    assert.equal(released.hold.releasedReason, 'case closed');
    assert.equal(await store.activeLegalHold(), null);

    const resumed = await store.tombstone(ids, info({ batchSize: 2 }));
    assert.equal(resumed.tombstoned, 4);
    assert.equal(resumed.stoppedByHold, false);

    rows = readRows(file);
    const holdEvents = rows.filter((r) => r.type === 'audit.legal_hold.changed');
    assert.equal(holdEvents.length, 2, 'placing and releasing are both chained audit events');
    assert.ok(holdEvents.every((r) => r.hash));
    assert.equal(tombstoneAwareWalk(rows), null);

    const status = await store.auditRetentionStatus();
    assert.equal(status.legalHold.active, false);
    assert.equal(status.legalHold.history, 1);
    assert.equal(status.tombstones.total, 6);
    assert.equal(status.tombstones.byReason.retention, 6);
    assert.equal(status.lastRun.type, 'audit.retention.purged');
  });
});

test('tombstone (memory): RAM-only rewrite, audit types skipped, no hold support needed', async () => {
  const store = new MemoryEventStore();
  await store.append(storeEvent('evt_m1', 1000));
  await store.append(storeEvent('evt_m2', 2000));
  const result = await store.tombstone(['evt_m1'], info({ reason: 'redaction', rulesVersion: 'r1' }));
  assert.equal(result.tombstoned, 1);
  assert.equal(result.stoppedByHold, false);
  const listed = await store.list({ limit: 10 });
  const tombstoned = listed.find((e) => e.id === 'evt_m1');
  assert.equal(tombstoned.summary, '[removed]');
  assert.deepEqual(tombstoned.payload, {});
  assert.equal(tombstoned.tombstone.reason, 'redaction');
  assert.equal(tombstoned.tombstone.rulesVersion, 'r1');
  assert.equal(listed.find((e) => e.id === 'evt_m2').summary, 'Secret summary evt_m2');
  assert.equal((await store.tombstone(result.auditEventIds, info())).tombstoned, 0);
});

test('normalizeCanonicalEvent copies the server-assigned fields when present', () => {
  const tombstone = { at: 1, reason: 'retention', auditEventId: 'evt_audit_x', rulesVersion: null, contentHash: null };
  const normalized = normalizeCanonicalEvent({ ...storeEvent('evt_n', 1000), tombstone, redactionRulesVersion: 'r2' });
  assert.deepEqual(normalized.tombstone, tombstone);
  assert.equal(normalized.redactionRulesVersion, 'r2');
  assert.equal('tombstone' in normalizeCanonicalEvent(storeEvent('evt_n2', 1000)), false);
});

// -------------------------------------------------------------
// HTTP, memory mode (in-process app, no token configured)
// -------------------------------------------------------------

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function post(baseUrl, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('ingest rejects audit.* types and server-assigned fields from clients, on both endpoints', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    for (const type of ['audit.retention.purged', 'audit.redaction.applied', 'audit.legal_hold.changed', 'audit.key.created', 'audit.anything']) {
      const single = await post(baseUrl, '/api/v1/events', { ...storeEvent(`evt_forge_${type}`, Date.now()), type });
      assert.equal(single.status, 400, type);
      assert.equal(single.body.error, 'reserved_type');
    }
    const field = await post(baseUrl, '/api/v1/events', {
      ...storeEvent('evt_forge_field', Date.now()),
      tombstone: { at: 1, reason: 'retention', auditEventId: 'x', rulesVersion: null, contentHash: null },
    });
    assert.equal(field.status, 400);
    assert.equal(field.body.error, 'reserved_field');
    const version = await post(baseUrl, '/api/v1/events', { ...storeEvent('evt_forge_version', Date.now()), redactionRulesVersion: 'r1' });
    assert.equal(version.body.error, 'reserved_field');

    const batch = await post(baseUrl, '/api/v1/events/batch', [
      storeEvent('evt_batch_ok', Date.now()),
      { ...storeEvent('evt_batch_forge', Date.now()), type: 'audit.retention.purged' },
    ]);
    assert.equal(batch.status, 400);
    assert.equal(batch.body.error, 'reserved_type');
    assert.equal(batch.body.index, 1);
    const listed = await (await fetch(`${baseUrl}/api/v1/events?limit=500`)).json();
    const events = Array.isArray(listed) ? listed : listed.events;
    assert.ok(!events.some((e) => e.id === 'evt_batch_ok'), 'the whole batch is refused');
  } finally {
    server.close();
  }
});

test('GET /api/v1/audit/retention (memory) is 409; mutating routes fail closed with 403 when no token is configured', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/api/v1/audit/retention`);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'audit_requires_sqlite');
    for (const route of ['/api/v1/audit/legal-hold', '/api/v1/audit/retention/purge', '/api/v1/audit/redact']) {
      const out = await post(baseUrl, route, {});
      assert.equal(out.status, 403, route);
      assert.equal(out.body.error, 'admin_token_required');
    }
  } finally {
    server.close();
  }
});

// -------------------------------------------------------------
// HTTP, SQLite mode with a token (subprocess, fresh module state)
// -------------------------------------------------------------

test('audit routes (SQLite): 401, 400, 423 under hold, purge and redact tombstone, GET /audit/retention reports it all', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-api-audit-retention-'));
  try {
    const serverUrl = new URL('../server/index.ts', import.meta.url).href;
    const script = `
      const http = await import('node:http');
      const { app } = await import(${JSON.stringify(serverUrl)});
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = 'http://127.0.0.1:' + server.address().port;
      const headers = { Authorization: 'Bearer retention-secret', 'Content-Type': 'application/json' };
      const call = async (method, route, body) => {
        const res = await fetch(baseUrl + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
      };
      const out = {};
      out.unauth = (await fetch(baseUrl + '/api/v1/audit/retention')).status;
      out.unauthPost = (await fetch(baseUrl + '/api/v1/audit/legal-hold', { method: 'POST' })).status;
      for (let i = 1; i <= 4; i++) {
        await call('POST', '/api/v1/events', {
          schemaVersion: '1.0', id: 'evt_api_' + i, type: 'agent.message.sent', timestamp: Date.now(),
          source: 'agent:writer', agentId: 'writer', summary: 'secret ' + i, payload: { text: 'secret ' + i },
        });
      }
      out.badHold = await call('POST', '/api/v1/audit/legal-hold', { action: 'freeze' });
      out.badPurge = await call('POST', '/api/v1/audit/retention/purge', { before: 'yesterday' });
      out.place = await call('POST', '/api/v1/audit/legal-hold', { action: 'place', reason: 'audit 2026' });
      out.placeAgain = await call('POST', '/api/v1/audit/legal-hold', { action: 'place', reason: 'again' });
      out.statusHeld = await call('GET', '/api/v1/audit/retention');
      out.purgeHeld = await call('POST', '/api/v1/audit/retention/purge', { before: Date.now() });
      out.badRedactHeld = await call('POST', '/api/v1/audit/redact', { eventIds: [] });
      out.redactHeld = await call('POST', '/api/v1/audit/redact', { eventIds: ['evt_api_1'] });
      out.release = await call('POST', '/api/v1/audit/legal-hold', { action: 'release', reason: 'done' });
      out.redact = await call('POST', '/api/v1/audit/redact', { eventIds: ['evt_api_1'], rulesVersion: 'r1' });
      out.purge = await call('POST', '/api/v1/audit/retention/purge', { before: Date.now() + 0 });
      out.status = await call('GET', '/api/v1/audit/retention');
      out.events = await call('GET', '/api/v1/events?limit=50');
      out.audit = await call('GET', '/api/v1/events?limit=50&includeAudit=true');
      server.close();
      console.log(JSON.stringify(out));
      process.exit(0);
    `;
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      AGENT_VIEWER_STORAGE: 'sqlite',
      AGENT_VIEWER_SQLITE_PATH: path.join(dir, 'retention-api.db'),
      AGENT_VIEWER_API_TOKEN: 'retention-secret',
      AGENT_VIEWER_RETENTION_BATCH_SIZE: '2',
    };
    delete env.AGENT_VIEWER_API_KEY;
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], {
      cwd: dir,
      env,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').pop());

    assert.equal(out.unauth, 401);
    assert.equal(out.unauthPost, 401);
    assert.equal(out.badHold.status, 400);
    assert.equal(out.badPurge.status, 400);
    assert.equal(out.place.status, 200);
    assert.equal(out.place.body.legalHold.placedReason, 'audit 2026');
    assert.equal(out.placeAgain.status, 409);
    assert.equal(out.placeAgain.body.error, 'legal_hold_already_active');

    assert.equal(out.statusHeld.status, 200);
    assert.equal(out.statusHeld.body.storage, 'sqlite');
    assert.equal(out.statusHeld.body.legalHold.active, true);
    assert.equal(out.statusHeld.body.policy.batchSize, 2);
    assert.equal(out.statusHeld.body.redactionRulesVersion, null);
    assert.equal(out.statusHeld.body.tombstones.total, 0);

    assert.equal(out.purgeHeld.status, 423);
    assert.equal(out.purgeHeld.body.error, 'legal_hold_active');
    assert.equal(out.badRedactHeld.status, 400, 'a bad body is a 400 even under a hold');
    assert.equal(out.redactHeld.status, 423);
    assert.equal(out.release.status, 200);

    assert.equal(out.redact.status, 200);
    assert.equal(out.redact.body.tombstoned, 1);
    assert.equal(out.purge.status, 200);
    assert.equal(out.purge.body.tombstoned, 3, 'the remaining three, in batches of two');
    assert.equal(out.purge.body.batches, 2);
    assert.equal(out.purge.body.stoppedByHold, false);

    const status = out.status.body;
    assert.equal(status.legalHold.active, false);
    assert.equal(status.legalHold.history, 1);
    assert.deepEqual(status.tombstones.byReason, { retention: 3, redaction: 1 });
    assert.equal(status.tombstones.total, 4);
    assert.equal(status.lastRun.type, 'audit.retention.purged');
    assert.equal(status.lastRun.count, 1);
    assert.equal(typeof status.rowsByRedactionRulesVersion.unknown, 'number');

    const events = Array.isArray(out.events.body) ? out.events.body : out.events.body.events;
    const mine = events.filter((e) => e.id.startsWith('evt_api_'));
    assert.equal(mine.length, 4);
    assert.ok(mine.every((e) => e.summary === '[removed]' && e.tombstone));
    assert.ok(!events.some((e) => e.type.startsWith('audit.')), 'audit events hidden by default');
    const auditList = Array.isArray(out.audit.body) ? out.audit.body : out.audit.body.events;
    const auditTypes = auditList.filter((e) => e.type.startsWith('audit.')).map((e) => e.type);
    assert.equal(auditTypes.filter((t) => t === 'audit.legal_hold.changed').length, 2);
    assert.equal(auditTypes.filter((t) => t === 'audit.retention.purged').length, 2);
    assert.equal(auditTypes.filter((t) => t === 'audit.redaction.applied').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
