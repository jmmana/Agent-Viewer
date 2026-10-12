import type { Migration } from '../migrations';
import { rowToEventForDigest } from '../../eventRow';
import { UnchainedDigest, checkpointHash } from '../../chain';
import { readPackageVersion } from '../../version';

/** Rows scanned per page while building the genesis digest; keeps peak memory bounded on a large database. */
const GENESIS_PAGE_SIZE = 500;

/**
 * Issue #105: adds the hash-chain columns to `events` and writes the one-time `genesis` checkpoint that commits
 * to every pre-chain row as a single digest. `events.seq` already exists (migration 4, issue #52): it is a
 * gapless, monotonically increasing insertion counter, assigned synchronously inside the same transaction as
 * every insert, so it is reused directly as the chain's position instead of introducing a second sequence space.
 * A "chained" row is one with a non-NULL `hash`; everything inserted before this migration keeps `hash`,
 * `prev_hash` and `submitter_id` NULL forever; it is covered, not rewritten.
 *
 * The runner (`runMigrations`) already wraps `up()` in its own `BEGIN IMMEDIATE ... COMMIT` and re-checks the
 * applied version under that lock before calling `up()`, so two processes racing to migrate the same fresh file
 * cannot both reach this function: the loser sees the migration already applied and skips it. The unique index
 * on `chain_checkpoints(kind) WHERE kind = 'genesis'` is kept anyway as a second line of defense.
 */
export const eventHashChain: Migration = {
  version: 17,
  name: 'event-hash-chain',
  up(db) {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(({ name }) => name)
    );
    if (!columns.has('prev_hash')) db.exec('ALTER TABLE events ADD COLUMN prev_hash TEXT');
    if (!columns.has('hash')) db.exec('ALTER TABLE events ADD COLUMN hash TEXT');
    if (!columns.has('submitter_id')) db.exec('ALTER TABLE events ADD COLUMN submitter_id TEXT');

    db.exec(`
      CREATE TABLE IF NOT EXISTS chain_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('genesis', 'resume')),
        prev_hash TEXT,
        unchained_count INTEGER NOT NULL,
        unchained_digest TEXT NOT NULL,
        first_event_id TEXT,
        last_event_id TEXT,
        created_at INTEGER NOT NULL,
        server_version TEXT NOT NULL,
        last_seq INTEGER NOT NULL,
        hash TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_one_genesis ON chain_checkpoints(kind) WHERE kind = 'genesis';
      CREATE INDEX IF NOT EXISTS idx_events_hash_seq ON events(seq) WHERE hash IS NOT NULL;
    `);

    // Defense in depth only (see the module comment on `events_immutable` in the docs): the server never issues
    // an UPDATE against a chained row. Unchained rows (legacy, pre-genesis) stay updatable so old tooling that
    // never learned about the chain keeps working.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS events_immutable
      BEFORE UPDATE ON events
      WHEN OLD.hash IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'chained events are immutable');
      END;
    `);

    const digest = new UnchainedDigest();
    let count = 0;
    let firstEventId: string | null = null;
    let lastEventId: string | null = null;
    let lastId = '';
    let maxSeq = 0;
    const selectPage = db.prepare('SELECT * FROM events WHERE id > ? AND hash IS NULL ORDER BY id LIMIT ?');
    while (true) {
      const rows = selectPage.all(lastId, GENESIS_PAGE_SIZE) as any[];
      if (rows.length === 0) break;
      for (const row of rows) {
        lastId = row.id;
        if (firstEventId === null) firstEventId = row.id;
        lastEventId = row.id;
        if (Number(row.seq) > maxSeq) maxSeq = Number(row.seq);
        digest.update(row.id, rowToEventForDigest(row));
        count++;
      }
    }

    const unchainedDigest = digest.digest();
    const createdAt = Date.now();
    const hash = checkpointHash({
      kind: 'genesis',
      prevHash: null,
      unchainedCount: count,
      unchainedDigest,
      firstEventId,
      lastEventId,
      createdAt,
    });
    db.prepare(
      `INSERT INTO chain_checkpoints
         (kind, prev_hash, unchained_count, unchained_digest, first_event_id, last_event_id, created_at, server_version, last_seq, hash)
       VALUES ('genesis', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(count, unchainedDigest, firstEventId, lastEventId, createdAt, readPackageVersion(), maxSeq, hash);
  },
};
