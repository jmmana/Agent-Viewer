import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  MIGRATIONS,
  MigrationFailedError,
  SchemaBackupError,
  SchemaHistoryMismatchError,
  SchemaShapeError,
  SchemaTooNewError,
  runMigrations,
} from '../server/db/migrations.ts';
import { createEventStore, SQLiteEventStore } from '../server/store.ts';
import { readPackageVersion } from '../server/version.ts';

const fixtures = path.join(import.meta.dirname, 'fixtures/sqlite');
const appVersion = readPackageVersion();
/** Every known migration as [version, name], the history a fully migrated file records. */
const ALL_MIGRATIONS = MIGRATIONS.map(({ version, name }) => [version, name]);
const LATEST_VERSION = MIGRATIONS.at(-1).version;
const fixtureNames = [
  'agent-viewer-0.1.x-2b00789.db',
  'agent-viewer-0.2.0.db',
  'agent-viewer-0.2.1.db',
];

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-migration-'));
  return { dir, file: path.join(dir, `${name}.db`) };
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixtureEvents() {
  return JSON.parse(fs.readFileSync(path.join(fixtures, 'events.json'), 'utf8')).map((event) => ({
    ...event,
    payload: {
      ...event.payload,
      ...(event.payload.text === '__FIXTURE_LARGE_PAYLOAD__'
        ? { text: '0123456789abcdef'.repeat(512) }
        : {}),
    },
  }));
}

function eventFromLegacyRow(row) {
  return {
    schemaVersion: '1.0',
    id: row.id,
    type: row.type,
    timestamp: Number(row.timestamp),
    runtimeId: row.runtime_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    source: row.agent_id ? `agent:${row.agent_id}` : row.runtime_id ? `runtime:${row.runtime_id}` : 'external',
    agentId: row.agent_id ?? undefined,
    taskId: row.task_id ?? undefined,
    severity: row.severity,
    summary: row.summary,
    payload: JSON.parse(row.payload || '{}'),
  };
}

function schema(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(({ name }) => name);
  return Object.fromEntries(
    tables.map((table) => [
      table,
      {
        columns: db.prepare(`PRAGMA table_info("${table}")`).all().map(({ name, type, notnull, dflt_value, pk }) => ({
          name,
          type,
          notnull,
          dflt_value,
          pk,
        })),
        indexes: db
          .prepare(`PRAGMA index_list("${table}")`)
          .all()
          .map(({ name }) => name)
          .sort(),
      },
    ])
  );
}

test('fresh and migrated databases have the same tables, columns, and indexes', async () => {
  const { dir, file } = tempDbPath('fresh');
  const fixture = path.join(fixtures, 'agent-viewer-0.2.1.db');
  const migrated = path.join(dir, 'migrated.db');
  fs.copyFileSync(fixture, migrated);
  const freshStore = new SQLiteEventStore(file, { backup: 'off' });
  const migratedStore = new SQLiteEventStore(migrated, { backup: 'off' });
  try {
    const freshDb = new DatabaseSync(file);
    const migratedDb = new DatabaseSync(migrated);
    assert.deepEqual(schema(freshDb), schema(migratedDb));
    freshDb.close();
    migratedDb.close();
  } finally {
    await freshStore.close();
    await migratedStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const fixtureName of fixtureNames) {
  test(`migrates ${fixtureName} without changing event data or row order`, async () => {
    const { dir, file } = tempDbPath('fixture');
    fs.copyFileSync(path.join(fixtures, fixtureName), file);
    const originalDb = new DatabaseSync(file);
    const hasEventJson = originalDb.prepare('PRAGMA table_info(events)').all().some(({ name }) => name === 'event_json');
    const originalRows = originalDb
      .prepare(`SELECT rowid, id, created_at, ${hasEventJson ? 'event_json,' : ''} type, timestamp, runtime_id, session_id, agent_id, task_id, severity, summary, payload FROM events ORDER BY rowid`)
      .all();
    const originalIds = originalRows.map(({ id }) => id);
    const expectedAfterIds = originalIds.map((cursorId) => {
      const cursor = originalRows.find(({ id }) => id === cursorId);
      return originalRows
        .filter(({ rowid }) => rowid > cursor.rowid)
        .sort((a, b) => b.timestamp - a.timestamp || b.created_at - a.created_at || b.rowid - a.rowid)
        .map(({ id }) => id);
    });
    originalDb.close();

    const store = new SQLiteEventStore(file);
    try {
      const db = new DatabaseSync(file);
      const migratedRows = db
        .prepare('SELECT rowid, id, created_at, event_json FROM events ORDER BY rowid')
        .all();
      assert.equal(migratedRows.length, originalRows.length);
      assert.deepEqual(migratedRows.map(({ id }) => id), originalIds);
      assert.deepEqual(migratedRows.map(({ rowid }) => rowid), originalRows.map(({ rowid }) => rowid));
      assert.deepEqual(migratedRows.map(({ created_at }) => created_at), originalRows.map(({ created_at }) => created_at));

      const isLegacy = !hasEventJson;
      if (isLegacy) {
        assert.ok(migratedRows.every(({ event_json }) => event_json === null));
      } else {
        assert.deepEqual(
          migratedRows.map(({ event_json }) => event_json),
          originalRows.map(({ event_json }) => event_json)
        );
      }

      const expectedEvents = isLegacy
        ? originalRows.map(eventFromLegacyRow)
        : originalRows.map(({ event_json }) => JSON.parse(event_json));
      const createdAtById = new Map(originalRows.map(({ id, created_at }) => [id, created_at]));
      // list() now carries receivedAt too (issue #65), equal to the row's own created_at.
      const listed = await store.list({ limit: 100 });
      assert.deepEqual(
        listed.map(({ receivedAt, ...rest }) => rest),
        expectedEvents.slice().reverse()
      );
      assert.deepEqual(
        listed.map((event) => event.receivedAt),
        listed.map((event) => createdAtById.get(event.id))
      );
      for (const [index, cursorId] of originalIds.entries()) {
        assert.deepEqual(
          (await store.list({ afterId: cursorId, limit: 100 })).map(({ id }) => id),
          expectedAfterIds[index],
          `afterId parity for cursor ${cursorId}`
        );
      }
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(
        db.prepare('SELECT version, name FROM schema_migrations').all().map(({ version, name }) => [version, name]),
        ALL_MIGRATIONS
      );
      db.close();
      assert.equal(store.migration.applied[0].version, 1);
      await store.close();

      const reopened = new SQLiteEventStore(file);
      assert.deepEqual(reopened.migration.applied, []);
      assert.equal(reopened.migration.backupPath, null);
      await reopened.close();
    } finally {
      await store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('unknown schema versions and inconsistent or foreign schemas are rejected without file changes', () => {
  const tooNew = tempDbPath('too-new');
  const tooNewDb = new DatabaseSync(tooNew.file);
  tooNewDb.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, app_version TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (${LATEST_VERSION + 1}, 'future', 1, '9.0.0');
  `);
  tooNewDb.close();
  const tooNewHash = hashFile(tooNew.file);
  assert.throws(
    () => new SQLiteEventStore(tooNew.file, { backup: 'off', appVersion: '0.3.0' }),
    (error) => error instanceof SchemaTooNewError && error.code === 'schema_too_new'
  );
  assert.equal(hashFile(tooNew.file), tooNewHash);

  for (const name of ['gap', 'renamed']) {
    const { file } = tempDbPath(name);
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, app_version TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES (${name === 'gap' ? 2 : 1}, '${name === 'gap' ? 'content-hash' : 'renamed'}', 1, '0.3.0');
    `);
    db.close();
    const before = hashFile(file);
    const migrations = MIGRATIONS;
    assert.throws(
      () => new SQLiteEventStore(file, { backup: 'off', migrations }),
      (error) => error instanceof SchemaHistoryMismatchError && error.code === 'schema_history_mismatch'
    );
    assert.equal(hashFile(file), before);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }

  const foreign = tempDbPath('foreign');
  const foreignDb = new DatabaseSync(foreign.file);
  foreignDb.exec('CREATE TABLE events (id TEXT PRIMARY KEY, strange TEXT)');
  foreignDb.close();
  const foreignHash = hashFile(foreign.file);
  assert.throws(
    () => new SQLiteEventStore(foreign.file, { backup: 'off' }),
    (error) => error instanceof SchemaShapeError && error.code === 'schema_shape'
  );
  assert.equal(hashFile(foreign.file), foreignHash);
  fs.rmSync(tooNew.dir, { recursive: true, force: true });
  fs.rmSync(foreign.dir, { recursive: true, force: true });
});

test('a failed migration rolls back its DDL and closes the database', () => {
  const { dir, file } = tempDbPath('rollback');
  const migrations = [
    ...MIGRATIONS,
    {
      version: LATEST_VERSION + 1,
      name: 'failing-test',
      up(db) {
        db.exec('CREATE TABLE partial_change (id INTEGER)');
        throw new Error('expected failure');
      },
    },
  ];
  const originalClose = DatabaseSync.prototype.close;
  let storeHandleCloseCount = 0;
  DatabaseSync.prototype.close = function (...args) {
    storeHandleCloseCount++;
    return originalClose.apply(this, args);
  };
  try {
    assert.throws(
      () => new SQLiteEventStore(file, { backup: 'off', migrations }),
      (error) =>
        error instanceof MigrationFailedError &&
        error.code === 'migration_failed' &&
        error.version === LATEST_VERSION + 1 &&
        error.cause.message === 'expected failure'
    );
    assert.equal(storeHandleCloseCount, 1);
  } finally {
    DatabaseSync.prototype.close = originalClose;
  }
  const db = new DatabaseSync(file);
  assert.deepEqual(
    db.prepare('SELECT version FROM schema_migrations').all().map(({ version }) => version),
    MIGRATIONS.map(({ version }) => version)
  );
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'partial_change'").get(), undefined);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backups are made only for existing legacy databases when enabled', async () => {
  const fixture = path.join(fixtures, 'agent-viewer-0.2.1.db');
  const automatic = tempDbPath('backup');
  fs.copyFileSync(fixture, automatic.file);
  const store = new SQLiteEventStore(automatic.file);
  const backupPath = store.migration.backupPath;
  assert.ok(backupPath && fs.existsSync(backupPath));
  const backup = new DatabaseSync(backupPath);
  assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const migrated = new DatabaseSync(automatic.file);
  assert.deepEqual(backup.prepare('SELECT id FROM events ORDER BY rowid').all(), migrated.prepare('SELECT id FROM events ORDER BY rowid').all());
  migrated.close();
  backup.close();
  await store.close();
  fs.rmSync(automatic.dir, { recursive: true, force: true });

  const disabled = tempDbPath('backup-off');
  fs.copyFileSync(fixture, disabled.file);
  const noBackup = new SQLiteEventStore(disabled.file, { backup: 'off' });
  assert.equal(noBackup.migration.backupPath, null);
  await noBackup.close();
  fs.rmSync(disabled.dir, { recursive: true, force: true });

  const fresh = tempDbPath('backup-fresh');
  const freshStore = new SQLiteEventStore(fresh.file);
  assert.equal(freshStore.migration.backupPath, null);
  await freshStore.close();
  fs.rmSync(fresh.dir, { recursive: true, force: true });
});

test('a failed VACUUM INTO removes partial backup files and throws SchemaBackupError', () => {
  const { dir, file } = tempDbPath('partial-backup');
  fs.copyFileSync(path.join(fixtures, 'agent-viewer-0.2.1.db'), file);
  const db = new DatabaseSync(file);
  const originalExec = db.exec.bind(db);
  const stamp = 1791500000000;
  const backupPath = `${file}.pre-v0-to-v${LATEST_VERSION}.${stamp}.bak`;
  db.exec = (sql) => {
    if (sql.startsWith('VACUUM INTO ')) {
      fs.writeFileSync(backupPath, 'partial backup');
      fs.writeFileSync(`${backupPath}-journal`, 'partial journal');
      throw new Error('disk full');
    }
    return originalExec(sql);
  };
  const originalNow = Date.now;
  Date.now = () => stamp;
  try {
    assert.throws(
      () => runMigrations(db, { appVersion, filePath: file, backup: 'auto' }),
      (error) => error instanceof SchemaBackupError && error.backupPath === backupPath && error.cause.message === 'disk full'
    );
    assert.equal(fs.existsSync(backupPath), false);
    assert.equal(fs.existsSync(`${backupPath}-journal`), false);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get(), undefined);
  } finally {
    Date.now = originalNow;
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('four concurrent processes can migrate a fresh file', async () => {
  const { dir, file } = tempDbPath('concurrent');
  const start = Date.now() + 1500;
  const code = `
    const { SQLiteEventStore } = await import('./server/store.ts');
    const start = Number(process.env.START);
    while (Date.now() < start) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25, start - Date.now()));
    }
    const store = new SQLiteEventStore(process.env.AGENT_VIEWER_SQLITE_PATH);
    await store.close();
  `;
  const children = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_VIEWER_SQLITE_PATH: file, AGENT_VIEWER_SQLITE_BACKUP: 'auto', START: String(start) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    return new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
    });
  });
  await Promise.all(children);
  const db = new DatabaseSync(file);
  assert.deepEqual(
    db.prepare('SELECT version, name FROM schema_migrations').all().map(({ version, name }) => [version, name]),
    ALL_MIGRATIONS
  );
  db.close();
  assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.bak')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('invalid backup modes are rejected with a clear configuration error', () => {
  const { dir, file } = tempDbPath('invalid-backup-mode');
  const previous = process.env.AGENT_VIEWER_SQLITE_BACKUP;
  const previousStorage = process.env.AGENT_VIEWER_STORAGE;
  const previousPath = process.env.AGENT_VIEWER_SQLITE_PATH;
  try {
    assert.throws(() => new SQLiteEventStore(file, { backup: 'sometimes' }), /AGENT_VIEWER_SQLITE_BACKUP.*auto.*off/);
    assert.equal(fs.existsSync(file), false);
    process.env.AGENT_VIEWER_SQLITE_BACKUP = '';
    assert.throws(() => new SQLiteEventStore(file), /AGENT_VIEWER_SQLITE_BACKUP.*auto.*off/);
    assert.equal(fs.existsSync(file), false);
    process.env.AGENT_VIEWER_STORAGE = 'sqlite';
    process.env.AGENT_VIEWER_SQLITE_PATH = file;
    assert.throws(() => createEventStore(), /AGENT_VIEWER_SQLITE_BACKUP.*auto.*off/);
    assert.equal(fs.existsSync(file), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_VIEWER_SQLITE_BACKUP;
    else process.env.AGENT_VIEWER_SQLITE_BACKUP = previous;
    if (previousStorage === undefined) delete process.env.AGENT_VIEWER_STORAGE;
    else process.env.AGENT_VIEWER_STORAGE = previousStorage;
    if (previousPath === undefined) delete process.env.AGENT_VIEWER_SQLITE_PATH;
    else process.env.AGENT_VIEWER_SQLITE_PATH = previousPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('direct server startup reports a too-new database in one line and exits with status 1', () => {
  const { dir, file } = tempDbPath('startup-too-new');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, app_version TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES (${LATEST_VERSION + 1}, 'future', 1, '9.0.0');
  `);
  db.close();
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_VIEWER_STORAGE: 'sqlite',
      AGENT_VIEWER_SQLITE_PATH: file,
      AGENT_VIEWER_SQLITE_BACKUP: 'off',
      NODE_ENV: '',
      DEBUG: '',
    },
  });
  assert.equal(result.status, 1);
  const relevantLines = result.stderr
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.includes('ExperimentalWarning') && !line.includes('--trace-warnings'));
  assert.deepEqual(relevantLines, [
    `The database ${file} has schema version ${LATEST_VERSION + 1}, but this server (${appVersion}) only knows up to version ${LATEST_VERSION}. Upgrade agent-viewer, or set AGENT_VIEWER_SQLITE_PATH to another file. The file was not modified.`,
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migration registry is contiguous and only adds entries to its snapshot', () => {
  const snapshot = JSON.parse(fs.readFileSync(path.join(fixtures, 'migrations.snapshot.json'), 'utf8'));
  const current = MIGRATIONS.map(({ version, name }) => [version, name]);
  assert.deepEqual(current, snapshot);
  assert.deepEqual(current.map(([version]) => version), current.map((_, index) => index + 1));
});

test('committed SQLite fixtures match their manifest hashes and row counts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtures, 'manifest.json'), 'utf8'));
  for (const entry of manifest.fixtures) {
    const { dir, file } = tempDbPath('fixture-manifest');
    try {
      const committedFixture = path.join(fixtures, entry.file);
      assert.equal(hashFile(committedFixture), entry.sha256);
      fs.copyFileSync(committedFixture, file);
      const db = new DatabaseSync(file);
      assert.equal(db.prepare('SELECT count(*) AS count FROM events').get().count, entry.rowCount);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
