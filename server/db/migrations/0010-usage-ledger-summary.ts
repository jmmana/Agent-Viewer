import type { Migration } from '../migrations';

/**
 * Adds `usage_ledger.summary` (issue #69): the export's own section 1 lists `summary` as a required ledger
 * column ("the `summary` column... ledger `summary` column (redacted)") and says plainly that if #65 never
 * stored it, "that is a blocker for this item and must be raised there, not worked around by reading
 * `event_json`". #65, as actually merged, stores no `summary` column at all (only `events.summary` does); this
 * migration closes that gap directly rather than reading `event_json` from the export path, which would defeat
 * the whole point of the ledger outliving a pruned event (#70).
 *
 * Nullable, no backfill: `usage_ledger_no_update` (migration `usage-ledger`, #65) makes every row append-only,
 * so an `UPDATE` to backfill existing rows from `events.summary` would abort against that trigger. A row written
 * before this migration keeps `summary = NULL` forever, exactly like every other "legacy row has an empty cell
 * for a field it never had" case this release already documents (issue #69's own "Migration and backward
 * compatibility" section). Every row written after this migration gets `summary` from `toLedgerRow`
 * (`server/usageLedger.ts`), which already has `CanonicalEvent.summary` on hand (a required, non-empty string on
 * every canonical event) for both the live append path and the backfill/catch-up path (`rowToEvent` restores it
 * from `events.summary`).
 *
 * Deliberately excluded from `sameCall`'s `COMPARED_SCALAR_FIELDS` (`server/usageLedger.ts`): `summary` is
 * descriptive, human-readable metadata, not a usage figure, so two reports of the same call with slightly
 * different summary text still compare equal for dedup purposes.
 *
 * Guarded with a `PRAGMA table_info` check rather than a bare `ALTER TABLE` (SQLite has no
 * `ADD COLUMN IF NOT EXISTS`): a database created fresh already has `summary` from migration `usage-ledger`'s own
 * `CREATE TABLE` (version 6, amended for this issue, since that migration's own backfill step needs the column to
 * exist in the same transaction); only a database that applied version 6 before this issue landed still needs the
 * `ALTER TABLE` here.
 */
export const usageLedgerSummary: Migration = {
  version: 10,
  name: 'usage-ledger-summary',
  up(db) {
    const columns = (db.prepare('PRAGMA table_info(usage_ledger)').all() as Array<{ name: string }>).map(
      (c) => c.name
    );
    if (!columns.includes('summary')) {
      db.exec('ALTER TABLE usage_ledger ADD COLUMN summary TEXT;');
    }
  },
};
