import crypto from 'node:crypto';
import type { Migration } from '../migrations';

/**
 * Issue #106 (first sub-issue, "formal audit" theme): a generic key/value table for audit metadata that needs
 * to survive a restart but does not deserve its own single-purpose table. The only row this migration writes is
 * `instance_id`, a random UUID identifying this specific database: `GET /api/v1/audit/verify`'s report carries
 * it so a signed checkpoint (#387) can later be pinned to the database it came from, and a checkpoint copied
 * onto a different database is rejected as `instance_mismatch` instead of silently "verifying". Deliberately
 * generic (`key TEXT PRIMARY KEY, value TEXT`), not `instance_id TEXT`, so a later issue can add another row
 * without another migration.
 */
export const auditMeta: Migration = {
  version: 18,
  name: 'audit-meta',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const existing = db.prepare("SELECT value FROM audit_meta WHERE key = 'instance_id'").get() as { value: string } | undefined;
    if (!existing) {
      db.prepare("INSERT INTO audit_meta (key, value) VALUES ('instance_id', ?)").run(crypto.randomUUID());
    }
  },
};
