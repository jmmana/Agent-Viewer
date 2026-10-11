import type { Migration } from '../migrations';

/**
 * Storage for budget alerts (issue #86, sub-issue #319). On top of migration 14's `budgets`/`budget_revisions`/
 * `budget_state`, this adds the one table this sub-issue needs: a durable, deduplicated record of every real
 * `warning`/`exceeded` crossing a `BudgetTransition` (#85, sub-issue #305) ever produced.
 *
 * `UNIQUE (budget_id, period_start, state)` is the entire deduplication mechanism: `EventStore.recordBudgetAlert`
 * always attempts the insert first, and only the write that actually lands (SQLite rejects every other one with a
 * constraint violation) goes on to insert the event row and broadcast it. This is what makes two concurrent live
 * checks racing on the exact same transition (the race `onBudgetTransition`'s own doc comment in `server/budgets.ts`
 * names as the listener's responsibility, not the engine's), a server restart, or a re-imported history all safe:
 * the constraint lives in SQLite, not in a process-local cache that a restart would forget. `state` is part of the
 * key (not a `threshold_bp` column, since the real engine never reports an arbitrary basis-point threshold, only a
 * `to` state) so a new period re-arms both levels independently, and raising a budget's limit mid-period can still
 * only ever produce one `warning` and one `exceeded` alert per period, exactly like before the limit changed.
 *
 * No `budget_alert_deliveries` table yet: the outbound webhook and its retry worker are issue #321, a separate
 * sub-issue of #86, with its own migration adding that table (and extending `recordBudgetAlert`'s single
 * transaction to cover it) once it lands.
 */
export const budgetAlerts: Migration = {
  version: 15,
  name: 'budget-alerts',
  up(db) {
    db.exec(`
      CREATE TABLE budget_alerts (
        id                   TEXT    PRIMARY KEY,
        budget_id            TEXT    NOT NULL,
        budget_name          TEXT    NOT NULL,
        scope_type           TEXT    NOT NULL,
        scope_value          TEXT,
        period_type          TEXT    NOT NULL,
        period_start         INTEGER NOT NULL,
        period_end           INTEGER NOT NULL,
        state                TEXT    NOT NULL CHECK (state IN ('warning', 'exceeded')),
        threshold            REAL    NOT NULL,
        limit_amount         REAL    NOT NULL,
        currency             TEXT    NOT NULL,
        known_spent          REAL    NOT NULL,
        spend_is_lower_bound INTEGER NOT NULL CHECK (spend_is_lower_bound IN (0, 1)),
        backfill             INTEGER NOT NULL DEFAULT 0 CHECK (backfill IN (0, 1)),
        detected_at          INTEGER NOT NULL,
        UNIQUE (budget_id, period_start, state)
      );

      CREATE INDEX ix_budget_alerts_budget ON budget_alerts(budget_id, detected_at);
      CREATE INDEX ix_budget_alerts_detected_at ON budget_alerts(detected_at);
    `);
  },
};
