import type { Migration } from '../migrations';

/**
 * Adds the tag join table and the extra indexes `GET /api/v1/usage/rollup` needs (issue #66), on top of the
 * `usage_ledger` table migration `usage-ledger` (#65) already created.
 *
 * `usage_ledger.tags` is a JSON array in a `TEXT` column (#65's own choice: no tag join table, see the issue's
 * section 0 "what #65 provides"), which cannot be indexed or grouped by in SQL. `usage_ledger_tags` is the
 * normalized form: one `(ledger_seq, tag)` row per tag, `WITHOUT ROWID` since the pair is already the natural key.
 * It is append-only like the ledger itself (issue #65's own rule), enforced by a trigger, and cascades on delete
 * so a future retention purge (#70) never leaves an orphaned tag row behind.
 *
 * The three plain indexes (`model` alone, `task_id`, `user_id`) exist because #65 only indexed `model` as part of
 * `(provider, model, received_at)` and never indexed `task_id` or `user_id` at all; the rollup's `EXPLAIN QUERY
 * PLAN` requirement (a named-index `SEARCH`, never a bare table scan, for a filtered query) needs all three.
 *
 * Version 9, not 7 or 8: issue #67 (the calls API, merged first) claimed version 7 for its own
 * `usage-calls-indexes` migration (`(agent_id, seq)`/`(session_id, seq)`/`(trace_id, seq)`/`(request_id)`
 * indexes plus `usage_ledger_meta`), and issue #70 (retention, merged next) claimed version 8 for
 * `retention_runs`/`retention_state`. No table, index or trigger name collides with either.
 */
export const usageRollup: Migration = {
  version: 9,
  name: 'usage-rollup',
  up(db) {
    db.exec(`
      CREATE TABLE usage_ledger_tags (
        ledger_seq INTEGER NOT NULL REFERENCES usage_ledger(seq),
        tag        TEXT    NOT NULL,
        PRIMARY KEY (ledger_seq, tag)
      ) WITHOUT ROWID;
      CREATE INDEX ix_usage_ledger_tags_tag ON usage_ledger_tags(tag, ledger_seq);

      -- Rows are evidence like the ledger itself (issue #65's own rule); retention (#70) deletes ledger rows,
      -- never edits them, so a tag row only ever disappears via the cascade below.
      CREATE TRIGGER usage_ledger_tags_no_update BEFORE UPDATE ON usage_ledger_tags
      BEGIN SELECT RAISE(ABORT, 'usage_ledger_tags is append-only'); END;
      CREATE TRIGGER usage_ledger_tags_cascade AFTER DELETE ON usage_ledger
      BEGIN DELETE FROM usage_ledger_tags WHERE ledger_seq = OLD.seq; END;

      CREATE INDEX ix_usage_ledger_model_received ON usage_ledger(model, received_at);
      CREATE INDEX ix_usage_ledger_task ON usage_ledger(task_id, received_at);
      CREATE INDEX ix_usage_ledger_user ON usage_ledger(user_id, received_at);
    `);

    // Backfill (issue #66's acceptance criteria: "a second run changes nothing", guaranteed here by running once,
    // inside this migration, never again; `INSERT OR IGNORE` also makes a hypothetical re-run idempotent).
    db.exec(`
      INSERT OR IGNORE INTO usage_ledger_tags (ledger_seq, tag)
      SELECT l.seq, j.value FROM usage_ledger l, json_each(l.tags) j;
    `);
  },
};
