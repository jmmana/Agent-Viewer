import type { Migration } from '../migrations';

/**
 * Issue #107: named API keys, stored as a hash only, plus an index on the `events.submitter_id` column #105
 * already added (needed here for the `submittedBy` filter on `GET /api/v1/events` and for the key list's
 * `eventCount`/`firstEventAt`/`lastEventAt` aggregates).
 */
export const apiKeys: Migration = {
  version: 18,
  name: 'api-keys',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        name_norm     TEXT NOT NULL UNIQUE,
        prefix        TEXT NOT NULL,
        secret_hash   TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        created_by    TEXT NOT NULL,
        expires_at    INTEGER,
        last_used_at  INTEGER,
        revoked_at    INTEGER,
        revoked_by    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_created_at ON api_keys(created_at);
    `);

    const columns = new Set(
      (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(({ name }) => name)
    );
    // Defensive: every schema this migration can run against already has `submitter_id` (migration 17), but a
    // bare `CREATE INDEX` on a missing column would fail outright rather than degrading gracefully.
    if (columns.has('submitter_id')) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_events_submitter_id ON events(submitter_id)');
    }
  },
};
