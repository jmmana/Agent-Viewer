import type { Migration } from '../migrations';

/**
 * Adds `events.seq`, a durable insertion-order counter independent of `rowid` (issue #52). `events.id` is a
 * `TEXT PRIMARY KEY`, so `rowid` is not an alias of an `INTEGER PRIMARY KEY`; SQLite is free to renumber such
 * rowids on `VACUUM`. The startup rebuild replays events in `seq` order, and the `afterId` cursor moves from
 * `rowid` to `seq`.
 *
 * Backfilled from `rowid`, which is still the true insertion order at the moment this migration runs. New rows
 * get their `seq` from an in-memory counter the store keeps after this migration, seeded from
 * `SELECT COALESCE(MAX(seq), 0) + 1 FROM events`. A row with `seq IS NULL` found at a later startup (written by
 * an older server pointed at the same file, after this migration already ran) is handled separately by the
 * store, not by this migration.
 */
export const eventsSeq: Migration = {
  version: 4,
  name: 'events-seq',
  up(db) {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(({ name }) => name)
    );
    if (!columns.has('seq')) {
      db.exec('ALTER TABLE events ADD COLUMN seq INTEGER');
    }
    db.exec('UPDATE events SET seq = rowid WHERE seq IS NULL');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_seq ON events(seq)');
  },
};
