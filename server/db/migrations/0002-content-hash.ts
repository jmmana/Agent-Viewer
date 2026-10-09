import crypto from 'node:crypto';
import { canonicalJson, FINGERPRINT_PREFIX } from '../../eventFingerprint';
import type { Migration } from '../migrations';

/** Rows hashed per chunk. All chunks run inside the transaction the runner opened for this migration. */
const BACKFILL_CHUNK_SIZE = 500;

/**
 * Adds `events.content_hash`, the fingerprint used to tell a true retry (same content) from a conflicting
 * duplicate (same id, different content), and backfills it from `event_json`. SQLite has no sha256, so the
 * hash is computed here. Rows without `event_json` (written before 0.2.0) and rows whose `event_json` does not
 * parse keep NULL: their content cannot be compared, and the store reports them as unverified duplicates.
 * The value is the same as `eventFingerprint` gives for the parsed event, because `canonicalJson` survives the
 * JSON round trip.
 */
export const contentHash: Migration = {
  version: 2,
  name: 'content-hash',
  up(db) {
    const columns = db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === 'content_hash')) {
      db.exec('ALTER TABLE events ADD COLUMN content_hash TEXT');
    }

    const selectChunk = db.prepare(`
      SELECT rowid AS seq, event_json FROM events
      WHERE rowid > ? AND content_hash IS NULL AND event_json IS NOT NULL AND event_json != ''
      ORDER BY rowid
      LIMIT ?
    `);
    const update = db.prepare('UPDATE events SET content_hash = ? WHERE rowid = ?');

    let lastSeq = 0;
    while (true) {
      const rows = selectChunk.all(lastSeq, BACKFILL_CHUNK_SIZE) as Array<{ seq: number; event_json: string }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        lastSeq = row.seq;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.event_json);
        } catch {
          continue;
        }
        const hash = crypto.createHash('sha256').update(canonicalJson(parsed), 'utf8').digest('hex');
        update.run(`${FINGERPRINT_PREFIX}${hash}`, row.seq);
      }
    }
  },
};
