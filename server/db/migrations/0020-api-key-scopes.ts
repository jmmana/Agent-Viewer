import type { Migration } from '../migrations';

/**
 * Issue #108: scoped API keys. Adds `api_keys.scopes`, a JSON array of scope names (see `server/auth/scopes.ts`).
 * Every key #107 created before this migration becomes `["ingest"]`, the least-privileged scope and the only thing
 * a #107 named key was ever useful for (key management was bootstrap-only), so no existing key gains a capability.
 */
export const apiKeyScopes: Migration = {
  version: 20,
  name: 'api-key-scopes',
  up(db) {
    const columns = new Set((db.prepare('PRAGMA table_info(api_keys)').all() as Array<{ name: string }>).map(({ name }) => name));
    if (!columns.has('scopes')) {
      db.exec(`ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '["ingest"]'`);
    }
  },
};
