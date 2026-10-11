import type { Migration } from '../migrations';

/**
 * Storage for budgets (issue #85, sub-issue #303: `BudgetRegistry`). The pure engine (#302, `server/budgets.ts`)
 * already defines `Budget`/`BudgetStatus`/`evaluateBudget`; this migration only adds where a `Budget` an operator
 * writes lives, its append-only change history, and a small evaluation cache.
 *
 * `budgets` is the live, mutable row: current configuration plus `revision` (starts at 1, `+1` on every
 * `update`) and `deleted_at` (soft delete, issue #85 section 3: a deleted budget keeps its id and history, it is
 * just excluded from `get`/`list`). There is no `FOREIGN KEY` from `budget_revisions` or `budget_state` to
 * `budgets`, the same choice migration 13's `usage_estimates` documents for its own ledger reference: nothing
 * here is ever pruned by retention the way a ledger row can be, but keeping the three tables independently
 * addressable (by `id` string, never a `rowid` join) avoids coupling their lifecycles for no benefit.
 *
 * `budget_revisions` is the append-only audit trail `BudgetRegistry.create`/`update`/`delete` each write exactly
 * once: a full `snapshot_json` of the `Budget` as it stood right after the change, who made it (`actor`, operator
 * supplied free text, nullable) and how they authenticated (`auth`, `'token'` or `'open'`, mirroring
 * `server/index.ts`'s own `AuthMode`, duplicated here as a plain string column rather than imported so this
 * storage module never depends on the route layer). `UNIQUE (budget_id, revision)` matches `budgets.revision`
 * one for one; the `no_update`/`no_delete` triggers below are the same append-only guard migration 13 already
 * uses for `usage_estimates`.
 *
 * `budget_state` is the evaluation cache the issue asks for, keyed by `(budget_id, ledger_seq, window_start,
 * budget_revision)`: a result computed for one ledger write sequence, one window and one budget revision is
 * valid forever (the ledger is append-only and a past window never changes retroactively), so this stores only
 * the single latest cached answer per budget (`PRIMARY KEY (budget_id)`, upserted) rather than growing one row
 * per evaluation. A cache lookup compares its own current `(ledgerSeq, windowStart, revision)` against the
 * stored key and only trusts a hit on an exact match; any difference (new ledger rows, a new window after the
 * old one elapsed, or the budget itself edited) is a cache miss, never a stale hit.
 *
 * No new `ledger_meta`-style coverage table: issue #65's retention work (issue #70, migration 8) already exposes
 * exactly the "coverage start" signal a budget's `historyTruncated` needs, via `retention_state.purged_before`
 * for `scope = 'usage_ledger'` (SQLite) and the `MemoryEventStore` counters `ledgerDroppedRows`/`ledgerComplete`/
 * `retentionState.usageLedger.purgedBefore` (memory, `server/store.ts`), the same pair `server/usage/rollup.ts`
 * already reads for the rollup endpoint's own `coverage.complete`. `BudgetRegistry` here does not read either
 * one directly (that is the caller's job, #304's API layer, which already holds a live store reference); adding
 * a second, duplicate coverage table here would just be two sources of truth for the same fact.
 */
export const budgets: Migration = {
  version: 14,
  name: 'budgets',
  up(db) {
    db.exec(`
      CREATE TABLE budgets (
        id            TEXT    PRIMARY KEY,
        name          TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
        scope_type    TEXT    NOT NULL CHECK (scope_type IN ('all', 'agent', 'model', 'session', 'user', 'tag')),
        scope_value   TEXT    CHECK (
          (scope_type = 'all' AND scope_value IS NULL)
          OR (scope_type != 'all' AND scope_value IS NOT NULL AND length(scope_value) BETWEEN 1 AND 200)
        ),
        period        TEXT    NOT NULL CHECK (period IN ('day', 'week', 'month')),
        timezone      TEXT    NOT NULL CHECK (length(timezone) >= 1),
        currency      TEXT    NOT NULL CHECK (length(currency) = 3),
        basis         TEXT    NOT NULL CHECK (basis IN ('reported', 'reported_plus_estimated')),
        limit_amount  REAL    NOT NULL CHECK (limit_amount > 0 AND limit_amount <= 1e12),
        warning_ratio REAL    NOT NULL CHECK (warning_ratio > 0 AND warning_ratio < 1),
        enabled       INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        revision      INTEGER NOT NULL CHECK (revision >= 1),
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        deleted_at    INTEGER
      );

      CREATE INDEX ix_budgets_deleted_at ON budgets(deleted_at);

      CREATE TABLE budget_revisions (
        id            TEXT    PRIMARY KEY,
        budget_id     TEXT    NOT NULL,
        revision      INTEGER NOT NULL CHECK (revision >= 1),
        action        TEXT    NOT NULL CHECK (action IN ('create', 'update', 'delete')),
        snapshot_json TEXT    NOT NULL,
        actor         TEXT    CHECK (actor IS NULL OR length(actor) BETWEEN 1 AND 100),
        auth          TEXT    NOT NULL CHECK (auth IN ('token', 'open')),
        created_at    INTEGER NOT NULL,
        UNIQUE (budget_id, revision)
      );

      CREATE INDEX ix_budget_revisions_budget ON budget_revisions(budget_id, revision);

      CREATE TRIGGER budget_revisions_no_update BEFORE UPDATE ON budget_revisions
      BEGIN SELECT RAISE(ABORT, 'budget_revisions is append-only'); END;

      CREATE TRIGGER budget_revisions_no_delete BEFORE DELETE ON budget_revisions
      BEGIN SELECT RAISE(ABORT, 'budget_revisions is append-only'); END;

      CREATE TABLE budget_state (
        budget_id       TEXT    PRIMARY KEY,
        ledger_seq      INTEGER NOT NULL,
        window_start    INTEGER NOT NULL,
        budget_revision INTEGER NOT NULL CHECK (budget_revision >= 1),
        status_json     TEXT    NOT NULL,
        evaluated_at    INTEGER NOT NULL
      );
    `);
  },
};
