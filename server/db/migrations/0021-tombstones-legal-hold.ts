import type { Migration } from '../migrations';

/**
 * Issue #109: chain-compatible retention. A chained row is never deleted or freely edited; it can only be
 * *tombstoned* once: `summary`/`payload`/`event_json` are replaced together (all or nothing, no field-by-field
 * redaction), `content_salt` is destroyed, and the four `tombstone_*` columns record when, why, under which
 * rules version and by which audit event (`tombstone_audit_seq` is that audit event's own `seq`, so the
 * tombstone is itself anchored in the chain). Every new column is nullable and `NULL` always means "unknown /
 * never set", never `0`.
 *
 * `legal_holds` is a convenience projection only: the evidence is the chained `audit.legal_hold.changed` events,
 * written in the same transaction as each row here.
 *
 * The `events_immutable` trigger from migration 17 is replaced (same name, so existing tooling that drops it by
 * name keeps working) by one that still rejects every UPDATE of a chained row except exactly the tombstone
 * transition: from not-tombstoned to tombstoned, with the fixed replacement content, a NULL salt, and every
 * header, chain and fingerprint column unchanged. An already-tombstoned row, and any `audit.*` row, stay fully
 * immutable.
 */
export const tombstonesLegalHold: Migration = {
  version: 21,
  name: 'tombstones-legal-hold',
  up(db) {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>).map(({ name }) => name)
    );
    const added: Array<[string, string]> = [
      ['redaction_rules_version', 'TEXT'],
      ['content_salt', 'BLOB'],
      ['tombstoned_at', 'INTEGER'],
      ['tombstone_reason', 'TEXT'],
      ['tombstone_audit_seq', 'INTEGER'],
      ['tombstone_rules_version', 'TEXT'],
    ];
    for (const [name, type] of added) {
      if (!columns.has(name)) db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_tombstoned_at ON events(tombstoned_at);

      CREATE TABLE IF NOT EXISTS legal_holds (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        placed_at          INTEGER NOT NULL,
        placed_reason      TEXT NOT NULL,
        placed_audit_seq   INTEGER NOT NULL,
        released_at        INTEGER,
        released_reason    TEXT,
        released_audit_seq INTEGER
      );
      -- At most one active hold at a time.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_holds_one_active ON legal_holds((released_at IS NULL)) WHERE released_at IS NULL;

      DROP TRIGGER IF EXISTS events_immutable;
      CREATE TRIGGER events_immutable
      BEFORE UPDATE ON events
      WHEN OLD.hash IS NOT NULL AND NOT (
        OLD.tombstoned_at IS NULL
        AND OLD.type NOT LIKE 'audit.%'
        AND NEW.tombstoned_at IS NOT NULL
        AND NEW.tombstone_reason IN ('retention', 'redaction')
        AND NEW.tombstone_audit_seq IS NOT NULL
        AND NEW.summary = '[removed]'
        AND NEW.payload = '{}'
        AND NEW.content_salt IS NULL
        AND NEW.id IS OLD.id
        AND NEW.seq IS OLD.seq
        AND NEW.hash IS OLD.hash
        AND NEW.prev_hash IS OLD.prev_hash
        AND NEW.submitter_id IS OLD.submitter_id
        AND NEW.content_hash IS OLD.content_hash
        AND NEW.created_at IS OLD.created_at
        AND NEW.type IS OLD.type
        AND NEW.timestamp IS OLD.timestamp
        AND NEW.runtime_id IS OLD.runtime_id
        AND NEW.session_id IS OLD.session_id
        AND NEW.agent_id IS OLD.agent_id
        AND NEW.task_id IS OLD.task_id
        AND NEW.severity IS OLD.severity
        AND NEW.request_provider IS OLD.request_provider
        AND NEW.request_id IS OLD.request_id
        AND NEW.duplicate_of IS OLD.duplicate_of
        AND NEW.matches_original IS OLD.matches_original
        AND NEW.redaction_rules_version IS OLD.redaction_rules_version
      )
      BEGIN
        SELECT RAISE(ABORT, 'chained events are immutable');
      END;
    `);
  },
};
