import type { Migration } from '../migrations';

/**
 * Issue #387: signed audit checkpoints. `audit_keys` records every Ed25519 public key that ever signed a
 * checkpoint here (never a private key); at most one row is active (`retired_at IS NULL`). A key that is retired
 * and later configured again gets a new row, so `key_id` is deliberately not unique. `audit_checkpoints` stores
 * each signed checkpoint: `body_json` is the canonical signed body (authoritative), the other columns are a
 * queryable copy of it.
 *
 * Both tables are append-only through triggers, the same "defense against accidental edits, not against an
 * attacker with file access" stance as #105's `events_immutable`: a checkpoint can never be updated or deleted,
 * and a key row can only be retired once (its `retired_at` set from NULL), never edited or deleted.
 */
export const auditCheckpoints: Migration = {
  version: 22,
  name: 'audit-checkpoints',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_keys (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        key_id         TEXT NOT NULL,
        algorithm      TEXT NOT NULL,
        public_key_pem TEXT NOT NULL,
        source         TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        retired_at     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_audit_keys_key_id ON audit_keys(key_id);
      -- At most one active key: \`algorithm\` is NOT NULL and always 'ed25519' in v1, so a partial unique index on
      -- it is a portable "only one row may match" constraint.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_keys_one_active ON audit_keys(algorithm) WHERE retired_at IS NULL;

      CREATE TABLE IF NOT EXISTS audit_checkpoints (
        seq            INTEGER PRIMARY KEY,
        created_at     INTEGER NOT NULL,
        reason         TEXT NOT NULL,
        head_seq       INTEGER NOT NULL,
        head_hash      TEXT NOT NULL,
        chained_count  INTEGER NOT NULL,
        key_id         TEXT NOT NULL,
        prev_digest    TEXT,
        digest         TEXT NOT NULL UNIQUE,
        body_json      TEXT NOT NULL,
        signature      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_checkpoints_created_at ON audit_checkpoints(created_at);

      CREATE TRIGGER IF NOT EXISTS audit_checkpoints_no_update
      BEFORE UPDATE ON audit_checkpoints
      BEGIN
        SELECT RAISE(ABORT, 'audit checkpoints are immutable');
      END;
      CREATE TRIGGER IF NOT EXISTS audit_checkpoints_no_delete
      BEFORE DELETE ON audit_checkpoints
      BEGIN
        SELECT RAISE(ABORT, 'audit checkpoints are immutable');
      END;

      CREATE TRIGGER IF NOT EXISTS audit_keys_retire_only
      BEFORE UPDATE ON audit_keys
      WHEN OLD.retired_at IS NOT NULL
        OR NEW.retired_at IS NULL
        OR NEW.id IS NOT OLD.id
        OR NEW.key_id IS NOT OLD.key_id
        OR NEW.algorithm IS NOT OLD.algorithm
        OR NEW.public_key_pem IS NOT OLD.public_key_pem
        OR NEW.source IS NOT OLD.source
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'audit keys can only be retired once');
      END;
      CREATE TRIGGER IF NOT EXISTS audit_keys_no_delete
      BEFORE DELETE ON audit_keys
      BEGIN
        SELECT RAISE(ABORT, 'audit keys are append-only');
      END;
    `);
  },
};
