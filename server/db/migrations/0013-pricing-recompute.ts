import type { Migration } from '../migrations';

/**
 * Adds the two tables the pricing recompute endpoint (issue #296, sub-issue of #84) writes to. Neither table is
 * ever edited or deleted by this feature; `usage_ledger` itself (revision 0) is never touched (it already has
 * its own `usage_ledger_no_update` trigger from migration 6).
 *
 * `usage_estimates` is the append-only history of every revision after 0 for one ledger row. One deliberate
 * deviation from the issue's literal column list, recorded here the same way other modules in this codebase
 * record their own: the issue names the foreign key `ledger_id -> usage_ledger.id`, assuming an `id` column.
 * `usage_ledger` (issue #65, `server/usageLedger.ts`) has no such column: its own external identifier, used
 * everywhere else a ledger row is addressed (`CallRecord.eventId`, the export rows, this very feature's own
 * `GET /api/v1/usage/calls/:id/estimates` route param), is `event_id`. `ledger_id` here stores that value. No
 * `FOREIGN KEY` constraint is declared, for the same reason migration 6 gives for not adding one to `events`:
 * `usage_ledger` can outlive a pruned `events` row (issue #70), and `usage_estimates` must be free to outlive a
 * retention-pruned ledger row's row in the same way, without a constraint forcing it to be deleted alongside it.
 *
 * `pricing_recompute_runs` has one row per committed run (issue #296: "a run that fails writes nothing", so a
 * run with zero matched rows is still the row's own full justification for existing: it documents that an
 * operator checked). `pricing_version_selector` is the operator's explicit `pricingVersion` from the request
 * body, `NULL` when omitted (each row resolved against the version in force at its own `occurred_at` instead).
 * `filter_json` is the exact filter object the request sent, stored for the audit trail the `reason` already
 * starts.
 *
 * The only index this issue requires by name is on `usage_estimates(revision)`. The table's own
 * `PRIMARY KEY (ledger_id, revision)` already gives SQLite a unique index usable for "every revision of this
 * ledger row, in order" (`GET /api/v1/usage/calls/:id/estimates`) and for "the latest revision of this ledger
 * row" (`MAX(revision) WHERE ledger_id = ?`, used by the recompute engine's own "did this row's result change"
 * check and by `onlyUnestimated` filtering), both of which lead with `ledger_id`.
 */
export const pricingRecompute: Migration = {
  version: 13,
  name: 'pricing-recompute',
  up(db) {
    db.exec(`
      CREATE TABLE usage_estimates (
        ledger_id           TEXT    NOT NULL,
        revision            INTEGER NOT NULL CHECK (revision >= 1),
        run_id              TEXT    NOT NULL,
        estimated_cost_nano INTEGER CHECK (estimated_cost_nano >= 0),
        estimated_currency  TEXT    CHECK (estimated_currency IS NULL OR length(estimated_currency) = 3),
        pricing_version     INTEGER CHECK (pricing_version >= 1),
        estimate_status     TEXT    NOT NULL CHECK (estimate_status IN (
          'estimated', 'no_price_in_force', 'no_price_for_model', 'no_price_for_component', 'missing_usage',
          'inconsistent_usage', 'failed'
        )),
        estimated_at        INTEGER NOT NULL,
        PRIMARY KEY (ledger_id, revision)
      );

      CREATE INDEX ix_usage_estimates_revision ON usage_estimates(revision);

      CREATE TABLE pricing_recompute_runs (
        run_id                    TEXT    PRIMARY KEY,
        revision                  INTEGER NOT NULL UNIQUE CHECK (revision >= 1),
        created_at                INTEGER NOT NULL,
        reason                    TEXT    NOT NULL,
        pricing_version_selector  INTEGER,
        filter_json               TEXT    NOT NULL,
        rows_matched              INTEGER NOT NULL CHECK (rows_matched >= 0),
        rows_written              INTEGER NOT NULL CHECK (rows_written >= 0),
        rows_unchanged            INTEGER NOT NULL CHECK (rows_unchanged >= 0),
        rows_estimated            INTEGER NOT NULL CHECK (rows_estimated >= 0),
        rows_unestimable          INTEGER NOT NULL CHECK (rows_unestimable >= 0)
      );

      CREATE TRIGGER pricing_recompute_runs_no_update BEFORE UPDATE ON pricing_recompute_runs
      BEGIN SELECT RAISE(ABORT, 'pricing_recompute_runs is append-only'); END;

      CREATE TRIGGER usage_estimates_no_update BEFORE UPDATE ON usage_estimates
      BEGIN SELECT RAISE(ABORT, 'usage_estimates is append-only'); END;
    `);
  },
};
