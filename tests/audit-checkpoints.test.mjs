// Issue #387: Ed25519 signing key management, the signed checkpoint format, the checkpoint scheduler (event
// count, interval, shutdown, on demand), key changes, checkpoint verification in `verifyChain`, and the four
// `/api/v1/audit/checkpoints*` / `/api/v1/audit/keys` routes. Tampering goes through a raw `DatabaseSync` handle
// with the immutability triggers dropped first, the same threat model `tests/audit-verify.test.mjs` uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteEventStore } from '../server/store.ts';
import { canonicalize, eventHash } from '../server/chain.ts';
import { verifyChain } from '../server/audit/verify.ts';
import { loadSigningKey, SigningKeyError, DEFAULT_KEY_FILENAME } from '../server/audit/signingKey.ts';
import {
  CHECKPOINT_SIGNED_DOMAIN_LINE,
  checkpointSignedBytes,
  checkpointDigest,
  keyIdFor,
  parseCheckpointBody,
  signCheckpoint,
  verifyCheckpointSignature,
} from '../server/audit/checkpointFormat.ts';
import {
  AuditCheckpointService,
  auditCheckpointsSupported,
  parseCheckpointScheduleConfig,
  DEFAULT_CHECKPOINT_EVERY_EVENTS,
  DEFAULT_CHECKPOINT_INTERVAL_MS,
} from '../server/audit/checkpoints.ts';
import { app } from '../server/index.ts';

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-viewer-checkpoints-${name}-`));
}

function storeEvent(id, timestamp) {
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

function ed25519Pem() {
  return crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

const quietLog = () => {};

async function withService(name, options, fn) {
  const dir = tempDir(name);
  const file = path.join(dir, `${name}.db`);
  const store = new SQLiteEventStore(file, { backup: 'off' });
  const db = store.getDatabaseHandle();
  const key = options.key ?? loadSigningKey({ env: {}, dbPath: file });
  const service = new AuditCheckpointService({
    db,
    key,
    schedule: { everyEvents: options.everyEvents ?? 1000, intervalMs: options.intervalMs ?? 3_600_000 },
    now: options.now,
    log: options.log ?? quietLog,
  });
  service.start();
  let seq = 0;
  const append = async (count = 1) => {
    for (let i = 0; i < count; i++) {
      seq++;
      await store.append(storeEvent(`evt_${name}_${seq}`, 1000 + seq), { submitterId: 'shared-token' });
      service.noteChainedEvents();
    }
  };
  try {
    await fn({ dir, file, store, db, service, key, append });
  } finally {
    service.shutdown();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------
// Signing key management
// -------------------------------------------------------------

test('loadSigningKey: the default key file is generated next to the database with mode 0600 and reused on the next start', () => {
  const dir = tempDir('default-key');
  try {
    const dbPath = path.join(dir, 'nested', 'agent-viewer.db');
    const first = loadSigningKey({ env: {}, dbPath });
    const expectedFile = path.join(dir, 'nested', DEFAULT_KEY_FILENAME);
    assert.equal(first.source, 'generated');
    assert.equal(first.filePath, expectedFile);
    assert.equal(first.privateKey.asymmetricKeyType, 'ed25519');
    assert.match(first.keyId, /^ed25519:[0-9a-f]{64}$/);
    assert.equal(first.keyId, keyIdFor(first.publicKey));
    if (process.platform !== 'win32') assert.equal(fs.statSync(expectedFile).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(expectedFile, 'utf8'), /BEGIN PRIVATE KEY/);

    const second = loadSigningKey({ env: {}, dbPath });
    assert.equal(second.source, 'file');
    assert.equal(second.keyId, first.keyId);
    assert.deepEqual(second.warnings, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSigningKey: a group/other-readable key file loads with a warning', { skip: process.platform === 'win32' }, () => {
  const dir = tempDir('loose-perms');
  try {
    const keyFile = path.join(dir, 'k.pem');
    fs.writeFileSync(keyFile, ed25519Pem(), { mode: 0o644 });
    fs.chmodSync(keyFile, 0o644);
    const loaded = loadSigningKey({ env: { AGENT_VIEWER_AUDIT_KEY_FILE: keyFile }, dbPath: path.join(dir, 'x.db') });
    assert.equal(loaded.source, 'file');
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0], /chmod 600/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSigningKey: AGENT_VIEWER_AUDIT_SIGNING_KEY (multi-line or \\n-escaped), AGENT_VIEWER_AUDIT_KEY_FILE generation, and :memory: ephemeral key', () => {
  const dir = tempDir('env-key');
  try {
    const pem = ed25519Pem();
    const fromEnv = loadSigningKey({ env: { AGENT_VIEWER_AUDIT_SIGNING_KEY: pem }, dbPath: path.join(dir, 'a.db') });
    assert.equal(fromEnv.source, 'env');
    assert.equal(fromEnv.filePath, null);
    const escaped = loadSigningKey({ env: { AGENT_VIEWER_AUDIT_SIGNING_KEY: pem.trim().replace(/\n/g, '\\n') }, dbPath: path.join(dir, 'a.db') });
    assert.equal(escaped.keyId, fromEnv.keyId);
    assert.equal(fs.existsSync(path.join(dir, DEFAULT_KEY_FILENAME)), false, 'an env key never writes a default file');

    const explicit = path.join(dir, 'keys', 'audit.pem');
    const generated = loadSigningKey({ env: { AGENT_VIEWER_AUDIT_KEY_FILE: explicit }, dbPath: path.join(dir, 'a.db') });
    assert.equal(generated.source, 'generated');
    assert.equal(generated.filePath, explicit);
    assert.equal(loadSigningKey({ env: { AGENT_VIEWER_AUDIT_KEY_FILE: explicit }, dbPath: 'ignored.db' }).keyId, generated.keyId);

    const ephemeral = loadSigningKey({ env: {}, dbPath: ':memory:' });
    assert.equal(ephemeral.source, 'ephemeral');
    assert.equal(ephemeral.filePath, null);
    assert.equal(ephemeral.warnings.length, 1);
    assert.match(ephemeral.warnings[0], /ephemeral/);
    assert.notEqual(loadSigningKey({ env: {}, dbPath: ':memory:' }).keyId, ephemeral.keyId);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadSigningKey: both variables set, a non-Ed25519 key or garbage is a startup error that never echoes key material', () => {
  const pem = ed25519Pem();
  assert.throws(
    () => loadSigningKey({ env: { AGENT_VIEWER_AUDIT_SIGNING_KEY: pem, AGENT_VIEWER_AUDIT_KEY_FILE: '/tmp/x.pem' }, dbPath: 'a.db' }),
    SigningKeyError
  );
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.throws(() => loadSigningKey({ env: { AGENT_VIEWER_AUDIT_SIGNING_KEY: rsa }, dbPath: 'a.db' }), (error) => {
    assert.ok(error instanceof SigningKeyError);
    assert.match(error.message, /Ed25519/);
    assert.equal(error.message.includes('PRIVATE KEY'), false);
    return true;
  });
  const garbage = '-----BEGIN PRIVATE KEY-----\nc2VjcmV0LXN0dWZm\n-----END PRIVATE KEY-----';
  assert.throws(() => loadSigningKey({ env: { AGENT_VIEWER_AUDIT_SIGNING_KEY: garbage }, dbPath: 'a.db' }), (error) => {
    assert.ok(error instanceof SigningKeyError);
    assert.equal(error.message.includes('c2VjcmV0'), false);
    return true;
  });
});

test('parseCheckpointScheduleConfig: defaults, valid overrides, and strict rejection of typos', () => {
  assert.deepEqual(parseCheckpointScheduleConfig({}), { everyEvents: DEFAULT_CHECKPOINT_EVERY_EVENTS, intervalMs: DEFAULT_CHECKPOINT_INTERVAL_MS });
  assert.equal(DEFAULT_CHECKPOINT_EVERY_EVENTS, 1000);
  assert.equal(DEFAULT_CHECKPOINT_INTERVAL_MS, 3_600_000);
  assert.deepEqual(
    parseCheckpointScheduleConfig({ AGENT_VIEWER_CHECKPOINT_EVERY_EVENTS: '50', AGENT_VIEWER_CHECKPOINT_INTERVAL_MS: ' 60000 ' }),
    { everyEvents: 50, intervalMs: 60000 }
  );
  for (const bad of ['0', '-1', '1.5', 'abc', '1e3']) {
    assert.throws(() => parseCheckpointScheduleConfig({ AGENT_VIEWER_CHECKPOINT_EVERY_EVENTS: bad }));
    assert.throws(() => parseCheckpointScheduleConfig({ AGENT_VIEWER_CHECKPOINT_INTERVAL_MS: bad }));
  }
  assert.throws(() => parseCheckpointScheduleConfig({ AGENT_VIEWER_CHECKPOINT_INTERVAL_MS: '2147483648' }));
});

// -------------------------------------------------------------
// Checkpoint format
// -------------------------------------------------------------

function sampleBody(keyId, overrides = {}) {
  return {
    version: 1,
    instanceId: 'b7f0c6a2-4d1e-4a56-9a1c-0d6d2f3b8e11',
    checkpointSeq: 2,
    headSeq: 5321,
    headHash: 'c'.repeat(64),
    chainedCount: 5321,
    createdAt: 1791547200123,
    reason: 'events',
    keyId,
    prevCheckpointDigest: 'a'.repeat(64),
    ...overrides,
  };
}

test('checkpoint format: domain line + RFC 8785 canonical JSON, SHA-256 digest, Ed25519 signature over the same bytes', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const body = sampleBody(keyIdFor(publicKey));

  const bytes = checkpointSignedBytes(body);
  assert.equal(CHECKPOINT_SIGNED_DOMAIN_LINE, 'agent-viewer/checkpoint/v1\n');
  assert.equal(bytes.toString('utf8'), `agent-viewer/checkpoint/v1\n${canonicalize(body)}`);
  // Keys sorted, no whitespace: pinned, since this is a permanent wire format.
  assert.ok(bytes.toString('utf8').startsWith('agent-viewer/checkpoint/v1\n{"chainedCount":5321,"checkpointSeq":2,"createdAt":1791547200123,"headHash":"'));
  // Key order of the input never changes the bytes.
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  assert.deepEqual(checkpointSignedBytes(reordered), bytes);

  const signed = signCheckpoint(body, privateKey);
  assert.equal(signed.digest, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(signed.digest, checkpointDigest(body));
  assert.match(signed.signature, /^[A-Za-z0-9+/]{86}==$/);
  assert.equal(crypto.verify(null, bytes, publicKey, Buffer.from(signed.signature, 'base64')), true);
  assert.equal(verifyCheckpointSignature(body, signed.signature, publicPem), true);

  assert.equal(verifyCheckpointSignature({ ...body, chainedCount: 5320 }, signed.signature, publicPem), false);
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.equal(verifyCheckpointSignature(body, signed.signature, other), false);
  assert.equal(verifyCheckpointSignature(body, 'not base64!', publicPem), false);
  assert.equal(verifyCheckpointSignature(body, signed.signature, 'garbage'), false);
});

test('checkpoint format: parseCheckpointBody is strict and agrees with the committed JSON Schema', () => {
  const keyId = `ed25519:${'0'.repeat(64)}`;
  const body = sampleBody(keyId);
  assert.deepEqual(parseCheckpointBody(body), body);
  assert.equal(parseCheckpointBody({ ...body, extra: 1 }), null);
  assert.equal(parseCheckpointBody({ ...body, version: 2 }), null);
  assert.equal(parseCheckpointBody({ ...body, reason: 'other' }), null);
  assert.equal(parseCheckpointBody({ ...body, headHash: 'C'.repeat(64) }), null);
  assert.equal(parseCheckpointBody({ ...body, checkpointSeq: 1 }), null, 'seq 1 must have a null prev digest');
  assert.deepEqual(parseCheckpointBody({ ...body, checkpointSeq: 1, prevCheckpointDigest: null }), { ...body, checkpointSeq: 1, prevCheckpointDigest: null });
  assert.equal(parseCheckpointBody({ ...body, prevCheckpointDigest: null }), null, 'only seq 1 may have a null prev digest');
  const { keyId: _omitted, ...missing } = body;
  assert.equal(parseCheckpointBody(missing), null);

  const schema = JSON.parse(fs.readFileSync(new URL('../server/audit/checkpoint.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), ['body', 'digest', 'signature']);
  assert.deepEqual([...schema.$defs.body.required].sort(), Object.keys(body).sort());
  assert.deepEqual(Object.keys(schema.$defs.body.properties).sort(), Object.keys(body).sort());
  assert.equal(schema.$defs.body.additionalProperties, false);
  assert.deepEqual(schema.$defs.body.properties.reason.enum, ['events', 'interval', 'shutdown', 'manual', 'key_change']);
});

// -------------------------------------------------------------
// Scheduler and storage
// -------------------------------------------------------------

test('scheduler: an `events` checkpoint every AGENT_VIEWER_CHECKPOINT_EVERY_EVENTS chained events, linked by prevCheckpointDigest', async () => {
  await withService('every-events', { everyEvents: 3 }, async ({ db, service, key, append }) => {
    assert.equal(auditCheckpointsSupported(db), true);
    await append(2);
    assert.equal(service.latest(), null);
    await append(1);
    const first = service.latest();
    assert.ok(first);
    assert.equal(first.body.reason, 'events');
    assert.equal(first.body.checkpointSeq, 1);
    assert.equal(first.body.prevCheckpointDigest, null);
    assert.equal(first.body.headSeq, 3);
    assert.equal(first.body.chainedCount, 3);
    assert.equal(first.body.keyId, key.keyId);
    assert.equal(first.body.instanceId, db.prepare("SELECT value FROM audit_meta WHERE key = 'instance_id'").get().value);
    assert.equal(first.body.headHash, db.prepare('SELECT hash FROM events WHERE seq = 3').get().hash);
    assert.equal(verifyCheckpointSignature(first.body, first.signature, key.publicKeyPem), true);

    await append(3);
    const list = service.list(0, 100);
    assert.equal(list.length, 2);
    assert.equal(list[1].body.prevCheckpointDigest, list[0].digest);
    assert.equal(list[1].body.chainedCount, 6);
    assert.deepEqual(service.list(1, 100).map((c) => c.body.checkpointSeq), [2]);

    // Stored body is the canonical JSON; the table is append-only.
    assert.equal(db.prepare('SELECT body_json FROM audit_checkpoints WHERE seq = 1').get().body_json, canonicalize(first.body));
    assert.throws(() => db.prepare("UPDATE audit_checkpoints SET reason = 'manual' WHERE seq = 1").run(), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM audit_checkpoints WHERE seq = 1').run(), /immutable/);
  });
});

test('scheduler: the interval timer signs an `interval` checkpoint only when the head advanced, and is unref()d', async () => {
  await withService('interval', { intervalMs: 25 }, async ({ service, append }) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(service.latest(), null, 'an empty chain is never checkpointed');
    await append(2);
    const deadline = Date.now() + 2000;
    while (!service.latest() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const latest = service.latest();
    assert.ok(latest, 'the interval timer fired');
    assert.equal(latest.body.reason, 'interval');
    assert.equal(latest.body.headSeq, 2);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(service.list(0, 100).length, 1, 'no new checkpoint while the head is unchanged');
    assert.equal(service['timer'].hasRef(), false);
  });
});

test('scheduler: on-demand and shutdown checkpoints; no checkpoint when the head did not advance, including across a restart', async () => {
  const dir = tempDir('shutdown');
  const file = path.join(dir, 'shutdown.db');
  try {
    const key = loadSigningKey({ env: {}, dbPath: file });
    let store = new SQLiteEventStore(file, { backup: 'off' });
    let service = new AuditCheckpointService({ db: store.getDatabaseHandle(), key, schedule: { everyEvents: 4, intervalMs: 3_600_000 }, log: quietLog });
    service.start();
    assert.deepEqual(service.createCheckpoint('manual'), { created: false, checkpoint: null, skipped: 'chain_empty' });
    for (let i = 1; i <= 2; i++) {
      await store.append(storeEvent(`evt_sd_${i}`, i), { submitterId: 'shared-token' });
      service.noteChainedEvents();
    }
    const manual = service.createCheckpoint('manual');
    assert.equal(manual.created, true);
    assert.equal(manual.checkpoint.body.reason, 'manual');
    const again = service.createCheckpoint('manual');
    assert.equal(again.created, false);
    assert.equal(again.skipped, 'head_unchanged');
    assert.equal(again.checkpoint.digest, manual.checkpoint.digest);

    await store.append(storeEvent('evt_sd_3', 3), { submitterId: 'shared-token' });
    service.noteChainedEvents();
    service.shutdown();
    service.shutdown(); // idempotent
    assert.equal(service.latest().body.reason, 'shutdown');
    assert.equal(service.latest().body.headSeq, 3);
    await store.close();

    // Restart with the same key: no key change and no new checkpoint.
    store = new SQLiteEventStore(file, { backup: 'off' });
    service = new AuditCheckpointService({ db: store.getDatabaseHandle(), key, schedule: { everyEvents: 4, intervalMs: 3_600_000 }, log: quietLog });
    const started = service.start();
    assert.equal(started.keyChanged, false);
    assert.equal(service.list(0, 100).length, 2);
    service.shutdown();
    assert.equal(service.list(0, 100).length, 2, 'shutdown with an unchanged head writes nothing');
    await store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('key change: the new key is inserted, the old one gets retired_at, and a key_change checkpoint is signed only if the head advanced', async () => {
  const dir = tempDir('key-change');
  const file = path.join(dir, 'kc.db');
  try {
    const keyA = loadSigningKey({ env: { AGENT_VIEWER_AUDIT_SIGNING_KEY: ed25519Pem() }, dbPath: file });
    const keyB = loadSigningKey({ env: { AGENT_VIEWER_AUDIT_SIGNING_KEY: ed25519Pem() }, dbPath: file });
    const keyC = loadSigningKey({ env: { AGENT_VIEWER_AUDIT_SIGNING_KEY: ed25519Pem() }, dbPath: file });
    const store = new SQLiteEventStore(file, { backup: 'off' });
    const db = store.getDatabaseHandle();
    const make = (key) => new AuditCheckpointService({ db, key, schedule: { everyEvents: 1000, intervalMs: 3_600_000 }, now: () => 5000, log: quietLog });

    const a = make(keyA);
    assert.equal(a.start().keyChanged, false, 'the first key ever is not a key change');
    await store.append(storeEvent('evt_kc_1', 1), { submitterId: 'shared-token' });
    assert.equal(a.createCheckpoint('manual').created, true);
    await store.append(storeEvent('evt_kc_2', 2), { submitterId: 'shared-token' });
    a.shutdown();
    // A shutdown checkpoint covered evt_kc_2; add one more so B's start sees an advanced head.
    await store.append(storeEvent('evt_kc_3', 3), { submitterId: 'shared-token' });

    const b = make(keyB);
    const startedB = b.start();
    assert.equal(startedB.keyChanged, true);
    assert.equal(startedB.retiredKeyId, keyA.keyId);
    assert.equal(startedB.checkpoint.created, true);
    assert.equal(startedB.checkpoint.checkpoint.body.reason, 'key_change');
    assert.equal(startedB.checkpoint.checkpoint.body.keyId, keyB.keyId);
    assert.equal(startedB.checkpoint.checkpoint.body.headSeq, 3);
    // The old key can no longer sign.
    await store.append(storeEvent('evt_kc_4', 4), { submitterId: 'shared-token' });
    assert.equal(a.createCheckpoint('manual').skipped, 'key_not_active');
    b.shutdown();

    const keys = make(keyB).keys();
    assert.deepEqual(keys.map((k) => [k.keyId, k.active, k.retiredAt]), [[keyA.keyId, false, 5000], [keyB.keyId, true, null]]);
    assert.equal(keys[0].publicKeyPem, keyA.publicKeyPem);
    assert.equal(JSON.stringify(keys).includes('PRIVATE'), false);
    assert.throws(() => db.prepare('UPDATE audit_keys SET retired_at = 1 WHERE key_id = ?').run(keyA.keyId), /retired once/);
    assert.throws(() => db.prepare("UPDATE audit_keys SET public_key_pem = 'x' WHERE retired_at IS NULL").run(), /retired once/);
    assert.throws(() => db.prepare('DELETE FROM audit_keys').run(), /append-only/);

    // Key change with an unchanged head (B's shutdown already covered evt_kc_4): no key_change checkpoint.
    const c = make(keyC);
    const startedC = c.start();
    assert.equal(startedC.keyChanged, true);
    assert.equal(startedC.checkpoint.created, false);
    assert.equal(startedC.checkpoint.skipped, 'head_unchanged');
    c.shutdown();

    await store.close();
    const report = await verifyChain({ dbPath: file });
    assert.equal(report.ok, true, JSON.stringify(report.checkpoints));
    assert.equal(report.checkpoints.checked, 4);
    assert.equal(report.checkpoints.valid, 4);
    assert.equal(report.warnings.some((w) => w.code === 'no_checkpoints'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------
// Verification (`verifyChain` extended by issue #387)
// -------------------------------------------------------------

/** A database with 6 chained events and 2 signed checkpoints (heads 3 and 6), closed and ready to tamper with. */
async function buildCheckpointedDb(name) {
  const dir = tempDir(name);
  const file = path.join(dir, `${name}.db`);
  const key = loadSigningKey({ env: {}, dbPath: file });
  const store = new SQLiteEventStore(file, { backup: 'off' });
  const service = new AuditCheckpointService({ db: store.getDatabaseHandle(), key, schedule: { everyEvents: 3, intervalMs: 3_600_000 }, log: quietLog });
  service.start();
  for (let i = 1; i <= 6; i++) {
    await store.append(storeEvent(`evt_${name}_${i}`, 1000 + i), { submitterId: 'shared-token' });
    service.noteChainedEvents();
  }
  service.shutdown();
  await store.close();
  const raw = new DatabaseSync(file);
  raw.exec('DROP TRIGGER IF EXISTS events_immutable; DROP TRIGGER IF EXISTS audit_checkpoints_no_update; DROP TRIGGER IF EXISTS audit_checkpoints_no_delete; DROP TRIGGER IF EXISTS audit_keys_retire_only; DROP TRIGGER IF EXISTS audit_keys_no_delete;');
  return { dir, file, key, raw, cleanup: () => { try { raw.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('verifyChain: a clean checkpointed database verifies every signed checkpoint and drops the no_checkpoints warning', async () => {
  const ctx = await buildCheckpointedDb('clean');
  try {
    const report = await verifyChain({ dbPath: ctx.file });
    assert.equal(report.ok, true);
    assert.deepEqual(report.checkpoints, { checked: 2, valid: 2, firstFailure: null });
    assert.equal(report.warnings.some((w) => w.code === 'no_checkpoints'), false);
  } finally {
    ctx.cleanup();
  }
});

test('verifyChain: a consistent rewrite (every later hash recomputed) passes the chain walk but fails as head_mismatch', async () => {
  const ctx = await buildCheckpointedDb('rewrite');
  try {
    const rows = ctx.raw.prepare('SELECT seq, event_json, created_at, submitter_id, prev_hash FROM events WHERE hash IS NOT NULL ORDER BY seq').all();
    let prevHash = rows[0].prev_hash;
    for (const row of rows) {
      const event = JSON.parse(row.event_json);
      if (row.seq === 2) event.payload.text = 'rewritten';
      const hash = eventHash({ seq: row.seq, prevHash, receivedAt: row.created_at, submitterId: row.submitter_id, event });
      ctx.raw.prepare('UPDATE events SET event_json = ?, prev_hash = ?, hash = ? WHERE seq = ?').run(JSON.stringify(event), prevHash, hash, row.seq);
      prevHash = hash;
    }
    const report = await verifyChain({ dbPath: ctx.file });
    assert.equal(report.firstBreak, null, 'the rewrite is internally consistent');
    assert.equal(report.ok, false);
    assert.equal(report.checkpoints.firstFailure.kind, 'head_mismatch');
    assert.equal(report.checkpoints.firstFailure.checkpoint, 1);
    assert.equal(report.checkpoints.firstFailure.seq, 3);
    assert.equal(report.checkpoints.valid, 0);
  } finally {
    ctx.cleanup();
  }
});

test('verifyChain: tail truncation is seq_beyond_head; an emptied table still fails', async () => {
  const ctx = await buildCheckpointedDb('truncate');
  try {
    ctx.raw.prepare('DELETE FROM events WHERE seq > 4').run();
    let report = await verifyChain({ dbPath: ctx.file });
    assert.equal(report.ok, false);
    assert.equal(report.firstBreak, null);
    assert.deepEqual([report.checkpoints.firstFailure.kind, report.checkpoints.firstFailure.checkpoint], ['seq_beyond_head', 2]);
    assert.equal(report.checkpoints.valid, 1);

    ctx.raw.prepare('DELETE FROM events').run();
    report = await verifyChain({ dbPath: ctx.file });
    assert.equal(report.ok, false);
    assert.equal(report.checkpoints.firstFailure.kind, 'seq_beyond_head');
  } finally {
    ctx.cleanup();
  }
});

test('verifyChain: signature_invalid, key_unknown, checkpoint_missing, checkpoint_link_broken, instance_mismatch, count_mismatch', async () => {
  const cases = [
    ['signature_invalid', (raw) => {
      const sig = raw.prepare('SELECT signature FROM audit_checkpoints WHERE seq = 1').get().signature;
      const bytes = Buffer.from(sig, 'base64');
      bytes[0] ^= 1;
      raw.prepare('UPDATE audit_checkpoints SET signature = ? WHERE seq = 1').run(bytes.toString('base64'));
    }, 1],
    ['signature_invalid', (raw) => {
      const body = JSON.parse(raw.prepare('SELECT body_json FROM audit_checkpoints WHERE seq = 2').get().body_json);
      body.chainedCount = 5;
      raw.prepare('UPDATE audit_checkpoints SET body_json = ? WHERE seq = 2').run(canonicalize(body));
    }, 2],
    ['key_unknown', (raw) => raw.prepare('DELETE FROM audit_keys').run(), 1],
    ['key_unknown', (raw) => {
      const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
      raw.prepare('UPDATE audit_keys SET public_key_pem = ?').run(other);
    }, 1],
    ['checkpoint_missing', (raw) => raw.prepare('DELETE FROM audit_checkpoints WHERE seq = 1').run(), 1],
    ['instance_mismatch', (raw) => raw.prepare("UPDATE audit_meta SET value = 'another-instance' WHERE key = 'instance_id'").run(), 1],
  ];
  for (const [kind, tamper, checkpoint] of cases) {
    const ctx = await buildCheckpointedDb(`case-${kind}`);
    try {
      tamper(ctx.raw);
      const report = await verifyChain({ dbPath: ctx.file });
      assert.equal(report.ok, false, kind);
      assert.equal(report.checkpoints.firstFailure?.kind, kind, `${kind}: ${JSON.stringify(report.checkpoints)}`);
      assert.equal(report.checkpoints.firstFailure.checkpoint, checkpoint, kind);
    } finally {
      ctx.cleanup();
    }
  }

  // checkpoint_link_broken and count_mismatch need a *validly signed* forged checkpoint (an attacker holding the
  // key), so they are built by re-signing with the database's own key.
  for (const [kind, mutate] of [
    ['checkpoint_link_broken', (body) => ({ ...body, prevCheckpointDigest: 'f'.repeat(64) })],
    ['count_mismatch', (body) => ({ ...body, chainedCount: body.chainedCount + 1 })],
  ]) {
    const ctx = await buildCheckpointedDb(`forged-${kind}`);
    try {
      const body = mutate(JSON.parse(ctx.raw.prepare('SELECT body_json FROM audit_checkpoints WHERE seq = 2').get().body_json));
      const signed = signCheckpoint(body, ctx.key.privateKey);
      ctx.raw.prepare('UPDATE audit_checkpoints SET body_json = ?, digest = ?, signature = ? WHERE seq = 2').run(canonicalize(body), signed.digest, signed.signature);
      const report = await verifyChain({ dbPath: ctx.file });
      assert.equal(report.checkpoints.firstFailure?.kind, kind, `${kind}: ${JSON.stringify(report.checkpoints)}`);
      assert.equal(report.checkpoints.firstFailure.checkpoint, 2);
      assert.equal(report.checkpoints.valid, 1);
    } finally {
      ctx.cleanup();
    }
  }
});

// -------------------------------------------------------------
// HTTP routes
// -------------------------------------------------------------

test('checkpoint routes (memory storage): all four answer 409 audit_unavailable', async () => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [method, route] of [
      ['GET', '/api/v1/audit/checkpoints'],
      ['GET', '/api/v1/audit/checkpoints/latest'],
      ['POST', '/api/v1/audit/checkpoints'],
      ['GET', '/api/v1/audit/keys'],
    ]) {
      const res = await fetch(baseUrl + route, { method });
      assert.equal(res.status, 409, `${method} ${route}`);
      const body = await res.json();
      assert.equal(body.error, 'audit_unavailable');
      assert.equal(body.reason, 'memory_storage');
    }
  } finally {
    server.close();
  }
});

test('checkpoint routes (SQLite mode): auth, event-count trigger, list json/jsonl, latest, on-demand POST, keys', () => {
  const dir = tempDir('http');
  try {
    const serverUrl = new URL('../server/index.ts', import.meta.url).href;
    const script = `
      const http = await import('node:http');
      const { app, shutdown } = await import(${JSON.stringify(serverUrl)});
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = 'http://127.0.0.1:' + server.address().port;
      const auth = { Authorization: 'Bearer checkpoint-secret', 'Content-Type': 'application/json' };
      const out = {};

      out.unauth = (await fetch(baseUrl + '/api/v1/audit/checkpoints')).status;
      out.emptyLatest = (await fetch(baseUrl + '/api/v1/audit/checkpoints/latest', { headers: auth })).status;
      const emptyPost = await fetch(baseUrl + '/api/v1/audit/checkpoints', { method: 'POST', headers: auth });
      out.emptyPost = { status: emptyPost.status, body: await emptyPost.json() };

      for (let i = 1; i <= 3; i++) {
        await fetch(baseUrl + '/api/v1/events', {
          method: 'POST', headers: auth,
          body: JSON.stringify({ schemaVersion: '1.0', id: 'evt_cp_http_' + i, type: 'agent.message.sent', timestamp: Date.now(), source: 'agent:w', agentId: 'w', summary: 'hi', payload: { text: 'hi' } }),
        });
      }
      const list = await fetch(baseUrl + '/api/v1/audit/checkpoints', { headers: auth });
      out.list = { status: list.status, cache: list.headers.get('cache-control'), body: await list.json() };
      const jsonl = await fetch(baseUrl + '/api/v1/audit/checkpoints?format=jsonl&limit=1', { headers: auth });
      out.jsonl = { status: jsonl.status, type: jsonl.headers.get('content-type'), next: jsonl.headers.get('x-next-after-seq'), text: await jsonl.text() };
      out.badLimit = (await fetch(baseUrl + '/api/v1/audit/checkpoints?limit=0', { headers: auth })).status;
      out.badFormat = (await fetch(baseUrl + '/api/v1/audit/checkpoints?format=csv', { headers: auth })).status;

      const post = await fetch(baseUrl + '/api/v1/audit/checkpoints', { method: 'POST', headers: auth });
      out.post = { status: post.status, body: await post.json() };
      const postAgain = await fetch(baseUrl + '/api/v1/audit/checkpoints', { method: 'POST', headers: auth });
      out.postAgain = { status: postAgain.status, body: await postAgain.json() };
      const latest = await fetch(baseUrl + '/api/v1/audit/checkpoints/latest', { headers: auth });
      out.latest = { status: latest.status, body: await latest.json() };
      const keys = await fetch(baseUrl + '/api/v1/audit/keys', { headers: auth });
      out.keys = { status: keys.status, text: await keys.text() };
      const verify = await fetch(baseUrl + '/api/v1/audit/verify', { headers: auth });
      out.verify = await verify.json();

      server.close();
      await shutdown();
      console.log(JSON.stringify(out));
      process.exit(0);
    `;
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      AGENT_VIEWER_STORAGE: 'sqlite',
      AGENT_VIEWER_SQLITE_PATH: path.join(dir, 'http.db'),
      AGENT_VIEWER_API_TOKEN: 'checkpoint-secret',
      AGENT_VIEWER_CHECKPOINT_EVERY_EVENTS: '2',
    };
    delete env.AGENT_VIEWER_API_KEY;
    delete env.AGENT_VIEWER_AUDIT_SIGNING_KEY;
    delete env.AGENT_VIEWER_AUDIT_KEY_FILE;
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').pop());

    assert.equal(out.unauth, 401);
    assert.equal(out.emptyLatest, 404);
    assert.equal(out.emptyPost.status, 200);
    assert.deepEqual(out.emptyPost.body, { created: false, reason: 'chain_empty', checkpoint: null });

    // 3 events with EVERY_EVENTS=2: exactly one `events` checkpoint, over head seq 2.
    assert.equal(out.list.status, 200);
    assert.equal(out.list.cache, 'no-store');
    assert.equal(out.list.body.checkpoints.length, 1);
    assert.equal(out.list.body.nextAfterSeq, null);
    const first = out.list.body.checkpoints[0];
    assert.deepEqual(Object.keys(first).sort(), ['body', 'digest', 'signature']);
    assert.equal(first.body.reason, 'events');
    assert.equal(first.body.chainedCount, 2);
    assert.equal(parseCheckpointBody(first.body) !== null, true);

    assert.equal(out.jsonl.status, 200);
    assert.match(out.jsonl.type, /application\/x-ndjson/);
    assert.equal(out.jsonl.next, '1');
    assert.deepEqual(out.jsonl.text.trim().split('\n').map((line) => JSON.parse(line)), [first]);
    assert.equal(out.badLimit, 400);
    assert.equal(out.badFormat, 400);

    assert.equal(out.post.status, 201);
    assert.equal(out.post.body.created, true);
    assert.equal(out.post.body.checkpoint.body.reason, 'manual');
    assert.equal(out.post.body.checkpoint.body.prevCheckpointDigest, first.digest);
    assert.equal(out.postAgain.status, 200);
    assert.equal(out.postAgain.body.created, false);
    assert.equal(out.postAgain.body.reason, 'head_unchanged');
    assert.equal(out.latest.status, 200);
    assert.deepEqual(out.latest.body.checkpoint, out.post.body.checkpoint);

    assert.equal(out.keys.status, 200);
    const keys = JSON.parse(out.keys.text);
    assert.equal(keys.keys.length, 1);
    assert.equal(keys.keys[0].active, true);
    assert.equal(keys.keys[0].keyId, keys.activeKeyId);
    assert.equal(keys.keys[0].source, 'generated');
    assert.equal(out.keys.text.includes('PRIVATE KEY'), false);
    assert.equal(verifyCheckpointSignature(out.post.body.checkpoint.body, out.post.body.checkpoint.signature, keys.keys[0].publicKeyPem), true);

    assert.equal(out.verify.ok, true);
    assert.deepEqual(out.verify.checkpoints, { checked: 2, valid: 2, firstFailure: null });

    // The default key file was generated next to the database, mode 0600.
    const keyFile = path.join(dir, DEFAULT_KEY_FILENAME);
    assert.equal(fs.existsSync(keyFile), true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
