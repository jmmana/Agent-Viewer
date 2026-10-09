import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { baseline } from './migrations/0001-baseline';

export interface Migration {
  /** 1-based, contiguous, never reused. */
  version: number;
  /** Stable kebab-case name, recorded in schema_migrations. */
  name: string;
  /** Runs inside the transaction opened by the runner. Must not change PRAGMA state. */
  up(db: DatabaseSync): void;
}

export const MIGRATIONS: readonly Migration[] = [baseline];

export interface MigrationOptions {
  appVersion: string;
  filePath: string;
  backup: 'auto' | 'off';
  migrations?: readonly Migration[];
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  applied: Array<{ version: number; name: string }>;
  backupPath: string | null;
}

const LEGACY_EVENT_COLUMNS = [
  'id', 'type', 'timestamp', 'runtime_id', 'session_id', 'agent_id',
  'task_id', 'severity', 'summary', 'payload', 'created_at',
];
const CURRENT_EVENT_COLUMNS = [...LEGACY_EVENT_COLUMNS, 'event_json'];

export class SchemaTooNewError extends Error {
  readonly code = 'schema_too_new';

  constructor(
    readonly fileVersion: number,
    readonly knownVersion: number,
    readonly filePath: string,
    appVersion: string
  ) {
    super(
      `The database ${filePath} has schema version ${fileVersion}, but this server (${appVersion}) only knows up to version ${knownVersion}. Upgrade agent-viewer, or set AGENT_VIEWER_SQLITE_PATH to another file. The file was not modified.`
    );
    this.name = 'SchemaTooNewError';
  }
}

export class SchemaHistoryMismatchError extends Error {
  readonly code = 'schema_history_mismatch';

  constructor(readonly detail: string) {
    super(`The SQLite schema migration history is inconsistent: ${detail}. Restore a valid database backup before starting agent-viewer.`);
    this.name = 'SchemaHistoryMismatchError';
  }
}

export class SchemaShapeError extends Error {
  readonly code = 'schema_shape';

  constructor(readonly missingColumns: string[]) {
    super(
      `The SQLite events table is missing required columns: ${missingColumns.join(', ')}. Check that AGENT_VIEWER_SQLITE_PATH points to an Agent Viewer database.`
    );
    this.name = 'SchemaShapeError';
  }
}

export class MigrationFailedError extends Error {
  readonly code = 'migration_failed';

  constructor(
    readonly version: number,
    readonly migrationName: string,
    cause: unknown
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(
      `Migration ${version} (${migrationName}) failed and was rolled back; the database stays at version ${version - 1}. Cause: ${message}.`,
      { cause }
    );
    this.name = 'MigrationFailedError';
  }
}

export class SchemaBackupError extends Error {
  readonly code = 'schema_backup_failed';

  constructor(readonly backupPath: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(
      `Could not write the pre-migration backup ${backupPath}. Free disk space, or set AGENT_VIEWER_SQLITE_BACKUP=off to migrate without a backup. The database was not modified. Cause: ${message}.`,
      { cause }
    );
    this.name = 'SchemaBackupError';
  }
}

interface MigrationRow {
  version: number;
  name: string;
  applied_at: number;
}

function withBusyRetry<T>(fn: () => T): T {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      return fn();
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      const message = err.message ?? '';
      if (!message.includes('database is locked') && err.code !== 'SQLITE_BUSY') throw error;
      if (Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

function eventColumns(db: DatabaseSync): Set<string> {
  return new Set(
    (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(({ name }) => name)
  );
}

function readHistory(db: DatabaseSync): MigrationRow[] {
  return db
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
    .all() as unknown as MigrationRow[];
}

function validateHistory(
  rows: MigrationRow[],
  migrations: readonly Migration[],
  options: MigrationOptions
): number {
  const knownVersion = migrations.at(-1)?.version ?? 0;
  const fileVersion = rows.at(-1)?.version ?? 0;
  if (fileVersion > knownVersion) {
    throw new SchemaTooNewError(fileVersion, knownVersion, options.filePath, options.appVersion);
  }

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const expected = migrations[index];
    if (row.version !== index + 1 || !expected || row.name !== expected.name) {
      throw new SchemaHistoryMismatchError(
        `version ${row.version} is ${row.name}, expected ${expected ? `${expected.version} (${expected.name})` : 'no recorded migration'}`
      );
    }
  }
  return fileVersion;
}

function assertEventShape(db: DatabaseSync, expectedColumns: readonly string[]): void {
  if (!tableExists(db, 'events')) {
    throw new SchemaShapeError([...expectedColumns]);
  }
  const columns = eventColumns(db);
  const missingColumns = expectedColumns.filter((column) => !columns.has(column));
  if (missingColumns.length > 0) throw new SchemaShapeError(missingColumns);
}

function backupDatabase(
  db: DatabaseSync,
  filePath: string,
  fromVersion: number,
  toVersion: number
): string {
  const backupPath = `${filePath}.pre-v${fromVersion}-to-v${toVersion}.${Date.now()}.bak`;
  const escapedPath = backupPath.replaceAll("'", "''");
  try {
    withBusyRetry(() => db.exec(`VACUUM INTO '${escapedPath}'`));
  } catch (error) {
    throw new SchemaBackupError(backupPath, error);
  }
  return backupPath;
}

export function runMigrations(db: DatabaseSync, options: MigrationOptions): MigrationResult {
  const migrations = options.migrations ?? MIGRATIONS;
  for (let index = 0; index < migrations.length; index++) {
    if (migrations[index].version !== index + 1) {
      throw new SchemaHistoryMismatchError('known migrations must be numbered contiguously from 1');
    }
  }

  db.exec('PRAGMA busy_timeout = 5000');
  const initial = withBusyRetry(() => {
    const hasHistory = tableExists(db, 'schema_migrations');
    if (!hasHistory) {
      if (tableExists(db, 'events')) {
        const columns = eventColumns(db);
        const missingColumns = LEGACY_EVENT_COLUMNS.filter((column) => !columns.has(column));
        if (missingColumns.length > 0) throw new SchemaShapeError(missingColumns);
      }
      return { hasHistory, rows: [] as MigrationRow[] };
    }
    const rows = readHistory(db);
    validateHistory(rows, migrations, options);
    return { hasHistory, rows };
  });
  const fromVersion = validateHistory(initial.rows, migrations, options);

  withBusyRetry(() => {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  });

  const pending = migrations.filter(({ version }) => version > fromVersion);
  let backupPath: string | null = null;
  if (
    pending.length > 0 &&
    tableExists(db, 'events') &&
    options.filePath !== ':memory:' &&
    options.filePath !== '' &&
    fs.existsSync(options.filePath) &&
    options.backup === 'auto'
  ) {
    backupPath = backupDatabase(db, options.filePath, fromVersion, migrations.at(-1)?.version ?? fromVersion);
  }

  const applied: Array<{ version: number; name: string }> = [];
  for (const migration of pending) {
    withBusyRetry(() => {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            applied_at INTEGER NOT NULL,
            app_version TEXT NOT NULL
          )
        `);

        const rows = readHistory(db);
        const currentVersion = validateHistory(rows, migrations, options);
        if (currentVersion >= migration.version) {
          db.exec('ROLLBACK');
          return;
        }

        migration.up(db);
        if (migration.version === 1) assertEventShape(db, CURRENT_EVENT_COLUMNS);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, applied_at, app_version) VALUES (?, ?, ?, ?)'
        ).run(migration.version, migration.name, Date.now(), options.appVersion);
        db.exec('COMMIT');
        applied.push({ version: migration.version, name: migration.name });
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The transaction may already have been rolled back.
        }
        if (error instanceof SchemaTooNewError || error instanceof SchemaHistoryMismatchError) throw error;
        throw new MigrationFailedError(migration.version, migration.name, error);
      }
    });
  }

  const rows = tableExists(db, 'schema_migrations') ? readHistory(db) : [];
  const toVersion = validateHistory(rows, migrations, options);
  assertEventShape(db, CURRENT_EVENT_COLUMNS);
  return { fromVersion, toVersion, applied, backupPath };
}
