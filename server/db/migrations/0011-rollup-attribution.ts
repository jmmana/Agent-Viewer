import type { Migration } from '../migrations';
import { ensureRollupAttributionTables, runRollupAttributionBackfill } from '../../rollupAttribution';

/**
 * Adds the `meeting` and `tool` rollup dimensions (issue #80): two small derived tables resolved by
 * `server/usage/rollup.ts`'s SQL builders, plus the indexes the join needs.
 *
 * `tool_calls` is one row per distinct `(session_id, agent_id, tool_call_id, tool)` seen on a `tool.started`
 * event: more than one row for the same `(session_id, agent_id, tool_call_id)` scope (different `tool` values)
 * is exactly what makes a usage row referencing that scope `ambiguous` (issue #80, section 1's table). `''` in
 * `session_id`/`agent_id` means "the event had none", never NULL, so the scope can be a `PRIMARY KEY` column
 * without `COALESCE` tricks at every comparison site.
 *
 * `meeting_labels` is one row per `meeting_id`, holding the latest accepted non-empty `title` from
 * `meeting.requested`/`meeting.started` ("latest" = last write, never event `timestamp`; see
 * `server/rollupAttribution.ts`). Neither table has a foreign key to `events` or to `usage_ledger`, for the same
 * reason the ledger itself does not (`server/db/migrations/0006-usage-ledger.ts`): both must be able to outlive
 * a pruned event (issue #70's retention), and they are derived, never a second source of truth, so a future
 * retention pass over `events` must never cascade into deleting a label or a tool call that a still-live ledger
 * row needs to resolve.
 *
 * `tool_call_resolution` is a VIEW, not a table: one row per `(session_id, agent_id, tool_call_id)` scope with
 * the distinct tool name when there is exactly one (`resolved_tool`) and a flag for when there is more than one
 * (`ambiguous`). `server/usage/rollup.ts` joins it once per rollup query instead of running the same `GROUP BY`
 * as a correlated subquery per row.
 *
 * Backfill: `runRollupAttributionBackfill` (`server/rollupAttribution.ts`) scans `events` directly (its `payload`
 * column, present since the baseline migration, so a pre-0.2.0 row needs no special handling) rather than the
 * `usage_ledger_tags`-style single `INSERT ... SELECT` migration `usage-rollup` (#66) uses, because
 * `meeting_labels` needs "last accepted wins" processed in `rowid` order, which a set-based `INSERT ... SELECT`
 * cannot express without window functions. The same function also runs on every later server open
 * (`server/store.ts`'s `SQLiteEventStore` constructor), the same "run once in the migration, run again as
 * startup catch-up" shape as the usage ledger itself (migration `usage-ledger`, #65): a database whose
 * `tool_calls`/`meeting_labels` tables were dropped reproduces them from `events` alone on the next restart.
 */
export const rollupAttribution: Migration = {
  version: 11,
  name: 'rollup-attribution',
  up(db) {
    ensureRollupAttributionTables(db);
    runRollupAttributionBackfill(db);
  },
};
