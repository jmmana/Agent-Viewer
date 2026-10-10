import type { Migration } from '../migrations';

/**
 * Adds the retention baseline (issue #70): an index so a purge by receive time never full-scans `events`, and the
 * two bookkeeping tables the purge job and `GET /api/v1/admin/retention` read and write.
 *
 * `retention_runs` is one row per scheduled (or startup) purge attempt, pruned to the latest 500 by the store
 * after every write (`finishRetentionRun` in `server/store.ts`). `retention_state` holds the two numbers that
 * must survive that pruning and a restart: `purged_before` (the largest cutoff under which rows were ever
 * actually deleted, the coverage signal for #66/#69) and `deleted_total` (the lifetime count). One row per scope
 * ('events' | 'usage_ledger') is seeded here so `purge()` can always `UPDATE ... WHERE scope = ?` without an
 * upsert.
 *
 * No foreign key from either table to `events` or `usage_ledger`, on purpose: this is audit information about
 * deletions, and it must outlive the very rows it describes.
 */
export const retention: Migration = {
  version: 8,
  name: 'retention',
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);

      CREATE TABLE retention_runs (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at          INTEGER NOT NULL,
        finished_at         INTEGER,
        trigger             TEXT    NOT NULL CHECK (trigger IN ('startup', 'schedule')),
        status              TEXT    NOT NULL CHECK (status IN ('running', 'ok', 'error', 'skipped')),
        events_window_days  INTEGER,
        events_cutoff_ms    INTEGER,
        events_deleted      INTEGER NOT NULL DEFAULT 0,
        ledger_window_days  INTEGER,
        ledger_cutoff_ms    INTEGER,
        ledger_deleted      INTEGER NOT NULL DEFAULT 0,
        error               TEXT
      );

      CREATE TABLE retention_state (
        scope           TEXT PRIMARY KEY CHECK (scope IN ('events', 'usage_ledger')),
        purged_before   INTEGER,
        deleted_total   INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO retention_state (scope, purged_before, deleted_total) VALUES ('events', NULL, 0);
      INSERT INTO retention_state (scope, purged_before, deleted_total) VALUES ('usage_ledger', NULL, 0);
    `);
  },
};
