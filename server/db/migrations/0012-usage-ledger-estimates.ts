import type { Migration } from '../migrations';

/**
 * Adds the five ingestion-time cost-estimate columns to `usage_ledger` (issue #84): `estimated_cost_nano`,
 * `estimated_currency`, `pricing_version`, `estimate_status`, `estimated_at`. See
 * `server/pricing/estimate.ts` for what computes them and `server/usageLedger.ts` for the full column reference.
 *
 * Guarded with a `PRAGMA table_info` check, the same pattern migration `usage-ledger-summary` (version 10) used
 * for `summary`: a database created fresh already has all five columns from migration `usage-ledger`'s own
 * `CREATE TABLE` (version 6, amended for this issue, since that migration's own backfill step needs them to
 * exist in the same transaction); only a database that applied version 6 before #84 landed still needs the
 * `ALTER TABLE` here. SQLite has no `ADD COLUMN IF NOT EXISTS`, hence the check.
 *
 * `ALTER TABLE ADD COLUMN` cannot add a multi-column `CHECK` that spans several columns (only a single-column
 * one, and only when it is satisfied by every existing row's new, `NULL` value): the per-column range checks
 * below mirror the ones in migration 6's `CREATE TABLE` body exactly, but the cross-column invariant there
 * ("a cost is present only when `estimate_status = 'estimated'`") is not repeated here. Both code paths already
 * only ever produce rows through `estimateLedgerRow` (`server/pricing/estimate.ts`), which is the one place that
 * invariant is actually enforced; the database-level `CHECK` on a fresh install is defense in depth, not the
 * only place that rule lives, so its absence on an upgraded database changes nothing about correctness.
 *
 * No backfill: existing rows keep every new column `NULL` (append-only `usage_ledger`, `usage_ledger_no_update`,
 * same as every other column this release's issues have added). They read as the virtual status
 * `not_estimated` (`server/usage/calls.ts`, a later sub-issue of #84). An operator estimates them explicitly
 * with `POST /api/v1/pricing/recompute` and `filter: { onlyUnestimated: true }` once that endpoint exists.
 */
export const usageLedgerEstimates: Migration = {
  version: 12,
  name: 'usage-ledger-estimates',
  up(db) {
    const columns = (db.prepare('PRAGMA table_info(usage_ledger)').all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    if (!columns.includes('estimated_cost_nano')) {
      db.exec('ALTER TABLE usage_ledger ADD COLUMN estimated_cost_nano INTEGER CHECK (estimated_cost_nano >= 0);');
    }
    if (!columns.includes('estimated_currency')) {
      db.exec(
        "ALTER TABLE usage_ledger ADD COLUMN estimated_currency TEXT CHECK (estimated_currency IS NULL OR length(estimated_currency) = 3);"
      );
    }
    if (!columns.includes('pricing_version')) {
      db.exec('ALTER TABLE usage_ledger ADD COLUMN pricing_version INTEGER CHECK (pricing_version >= 1);');
    }
    if (!columns.includes('estimate_status')) {
      db.exec(`ALTER TABLE usage_ledger ADD COLUMN estimate_status TEXT CHECK (estimate_status IS NULL OR estimate_status IN (
        'estimated', 'no_price_in_force', 'no_price_for_model', 'no_price_for_component', 'missing_usage',
        'inconsistent_usage', 'failed'
      ));`);
    }
    if (!columns.includes('estimated_at')) {
      db.exec('ALTER TABLE usage_ledger ADD COLUMN estimated_at INTEGER;');
    }

    db.exec('CREATE INDEX IF NOT EXISTS ix_usage_ledger_pricing_version ON usage_ledger(pricing_version);');
  },
};
