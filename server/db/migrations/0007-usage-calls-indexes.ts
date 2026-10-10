import crypto from 'node:crypto';
import type { Migration } from '../migrations';

/**
 * Supports `GET /api/v1/usage/calls` (issue #67) on top of the ledger from #65: the keyset indexes section 1 of
 * the issue asks for, and a small key/value metadata table holding the SQLite store's "epoch" (section 4,
 * "Cursor"), a persistent random id a cursor carries so it can tell "this store restarted and its `seq` space
 * is unrelated" (memory mode, a new epoch every boot) apart from "this is the same store, keep walking"
 * (SQLite, the epoch survives a restart because it lives in the database file).
 *
 * `(agent_id, seq)`, `(session_id, seq)` and `(trace_id, seq)` are added even though `usage_ledger.seq` is the
 * table's own `INTEGER PRIMARY KEY` (so it already aliases `rowid`, and any index on `agent_id` alone would
 * already be ordered `(agent_id, rowid)`): naming `seq` explicitly keeps the query planner's choice visible and
 * self-documenting in `EXPLAIN QUERY PLAN` output, which the calls endpoint's test suite asserts against. A
 * plain `(request_id)` index is added for direct request-id lookups independent of `provider`; the existing
 * `ux_usage_ledger_request` unique index only serves a `(provider, request_id)` pair.
 */
export const usageCallsIndexes: Migration = {
  version: 7,
  name: 'usage-calls-indexes',
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS ix_usage_ledger_agent_seq ON usage_ledger(agent_id, seq);
      CREATE INDEX IF NOT EXISTS ix_usage_ledger_session_seq ON usage_ledger(session_id, seq);
      CREATE INDEX IF NOT EXISTS ix_usage_ledger_trace_seq ON usage_ledger(trace_id, seq);
      CREATE INDEX IF NOT EXISTS ix_usage_ledger_request_id ON usage_ledger(request_id);

      CREATE TABLE IF NOT EXISTS usage_ledger_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const existing = db.prepare("SELECT value FROM usage_ledger_meta WHERE key = 'store_epoch'").get() as
      | { value: string }
      | undefined;
    if (!existing) {
      const epoch = crypto.randomBytes(16).toString('hex');
      db.prepare("INSERT INTO usage_ledger_meta (key, value) VALUES ('store_epoch', ?)").run(epoch);
    }
  },
};
