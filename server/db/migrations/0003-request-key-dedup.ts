import type { Migration } from '../migrations';

/**
 * Adds the `(provider, requestId)` dedup key to `events`: a second deduplication key for `llm.usage` and
 * `llm.failed`, on top of the id dedup from migration 2. See issue #48.
 *
 * `request_provider` and `request_id` are backfilled from the stored `payload` column, which every row has.
 * Rows without a usable provider never get a request key, even if they report a `requestId`: they can never be
 * deduplicated this way. Among rows that share a key, the earliest row (lowest rowid) stays the original; later
 * rows get `duplicate_of` set to it, with `matches_original` left NULL because the legacy content was never
 * compared under this rule (0.2.x did not know it).
 *
 * The non-unique lookup index is created first so the backfill is not quadratic on large databases, and dropped
 * once the backfill is done. The unique partial index that remains only covers originals (`duplicate_of IS
 * NULL`), so two accepted rows can never share a key afterward.
 *
 * Downstream aggregates and rebuilds (#51, #52) must only count rows where `duplicate_of IS NULL`.
 */
export const requestKeyDedup: Migration = {
  version: 3,
  name: 'request-key-dedup',
  up(db) {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(({ name }) => name)
    );
    const newColumns: Array<[string, string]> = [
      ['request_provider', 'ALTER TABLE events ADD COLUMN request_provider TEXT'],
      ['request_id', 'ALTER TABLE events ADD COLUMN request_id TEXT'],
      ['duplicate_of', 'ALTER TABLE events ADD COLUMN duplicate_of TEXT'],
      ['matches_original', 'ALTER TABLE events ADD COLUMN matches_original INTEGER'],
    ];
    for (const [name, ddl] of newColumns) {
      if (!columns.has(name)) db.exec(ddl);
    }

    db.exec(`
      UPDATE events
      SET request_provider = lower(trim(json_extract(payload, '$.provider'))),
          request_id       = nullif(trim(CAST(json_extract(payload, '$.requestId') AS TEXT)), '')
      WHERE type IN ('llm.usage', 'llm.failed') AND json_valid(payload);

      UPDATE events SET request_id = NULL
      WHERE request_id IS NOT NULL AND (request_provider IS NULL OR request_provider = '');

      CREATE INDEX IF NOT EXISTS idx_events_request_lookup_tmp ON events(request_provider, request_id);

      UPDATE events
      SET duplicate_of = (
        SELECT o.id FROM events o
        WHERE o.request_provider = events.request_provider AND o.request_id = events.request_id
        ORDER BY o.rowid LIMIT 1
      )
      WHERE request_id IS NOT NULL
        AND rowid > (
          SELECT min(o.rowid) FROM events o
          WHERE o.request_provider = events.request_provider AND o.request_id = events.request_id
        );

      DROP INDEX idx_events_request_lookup_tmp;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_request_key
        ON events(request_provider, request_id)
        WHERE request_id IS NOT NULL AND duplicate_of IS NULL;

      CREATE INDEX IF NOT EXISTS idx_events_duplicate_of
        ON events(duplicate_of)
        WHERE duplicate_of IS NOT NULL;
    `);
  },
};
