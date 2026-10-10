import type { Migration } from '../migrations';
import { runUsageLedgerBackfill } from '../../usageLedger';

/**
 * Adds the usage ledger (issue #65): one append-only, typed row per accepted `llm.usage` or `llm.failed` event,
 * with the server receive time, plus `usage_ledger_skips` recording why an accepted usage event produced no row
 * (a duplicate or conflicting `(provider, requestId)`, or a payload that could not be parsed). Neither table has
 * a foreign key to `events` on purpose: the ledger is evidence and must be able to outlive a pruned event
 * (issue #70), and `node:sqlite` opens with `PRAGMA foreign_keys = 1`, so a foreign key here would make deleting
 * an old event fail or force its ledger row to be deleted with it.
 *
 * See `server/usageLedger.ts` for the mapping rules and two deliberate deviations from the issue's literal
 * column list (`meeting_id` in place of `span_id`; `status`/`error_kind` both taking `errorKind`'s value for a
 * `llm.failed` row), and `docs/usage-ledger.md` for the column reference.
 *
 * After creating the tables, this migration runs the same backfill scan `SQLiteEventStore`'s startup catch-up
 * runs on every later open (`runUsageLedgerBackfill`): every stored `llm.usage`/`llm.failed` event gets exactly
 * one ledger decision, paged by `rowid` so a large database is scanned with flat memory use. A row is
 * `legacy_contract = 1` when its `created_at` is strictly before the baseline migration's own `applied_at`: that
 * timestamp is recorded (within this same migration run, by migration 1) the first time this server's versioned
 * migration runner ever touches the file, so any row older than it was written by a pre-0.4.0 server.
 */
export const usageLedger: Migration = {
  version: 6,
  name: 'usage-ledger',
  up(db) {
    db.exec(`
      CREATE TABLE usage_ledger (
        seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id            TEXT    NOT NULL UNIQUE,
        event_type          TEXT    NOT NULL CHECK (event_type IN ('llm.usage', 'llm.failed')),
        request_id          TEXT,
        received_at         INTEGER NOT NULL,
        occurred_at         INTEGER NOT NULL,
        origin              TEXT    NOT NULL CHECK (origin IN ('live', 'backfill')),
        legacy_contract     INTEGER NOT NULL DEFAULT 0 CHECK (legacy_contract IN (0, 1)),
        ingest_channel      TEXT    NOT NULL CHECK (ingest_channel IN ('events', 'events-batch', 'webhook', 'otlp', 'unknown')),
        runtime_id          TEXT,
        session_id          TEXT,
        agent_id            TEXT,
        task_id             TEXT,
        provider            TEXT,
        model               TEXT,
        input_tokens        INTEGER CHECK (input_tokens >= 0),
        output_tokens       INTEGER CHECK (output_tokens >= 0),
        cache_read_tokens   INTEGER CHECK (cache_read_tokens >= 0),
        cache_write_tokens  INTEGER CHECK (cache_write_tokens >= 0),
        reasoning_tokens    INTEGER CHECK (reasoning_tokens >= 0),
        cost                REAL    CHECK (cost >= 0),
        currency            TEXT    CHECK (currency IS NULL OR length(currency) = 3),
        cost_source         TEXT    NOT NULL CHECK (cost_source IN ('provider-reported', 'estimated', 'unknown')),
        latency_ms          INTEGER CHECK (latency_ms >= 0),
        status              TEXT    NOT NULL,
        error_kind          TEXT,
        trace_id            TEXT,
        parent_id           TEXT,
        tool_call_id        TEXT,
        meeting_id          TEXT,
        user_id             TEXT,
        tags                TEXT    NOT NULL DEFAULT '[]',
        -- Added retroactively for issue #69 (see migration usage-ledger-summary, version 10): a brand-new
        -- database runs this migration's own backfill step (below) in the same transaction, which already needs
        -- the column (toLedgerRow / LEDGER_COLUMNS, server/usageLedger.ts, both updated by #69) to exist here.
        -- An existing database that already applied this migration before #69 gets the column from migration 10
        -- instead, via ALTER TABLE (this CREATE TABLE body never re-runs once version 6 is recorded).
        summary             TEXT,
        CHECK (cost IS NOT NULL OR (currency IS NULL AND cost_source = 'unknown'))
      );

      CREATE UNIQUE INDEX ux_usage_ledger_request ON usage_ledger(provider, request_id) WHERE request_id IS NOT NULL;
      CREATE INDEX ix_usage_ledger_received ON usage_ledger(received_at);
      CREATE INDEX ix_usage_ledger_occurred ON usage_ledger(occurred_at);
      CREATE INDEX ix_usage_ledger_agent    ON usage_ledger(agent_id, received_at);
      CREATE INDEX ix_usage_ledger_model    ON usage_ledger(provider, model, received_at);
      CREATE INDEX ix_usage_ledger_session  ON usage_ledger(session_id, received_at);

      CREATE TRIGGER usage_ledger_no_update BEFORE UPDATE ON usage_ledger
      BEGIN SELECT RAISE(ABORT, 'usage_ledger is append-only'); END;

      CREATE TABLE usage_ledger_skips (
        event_id       TEXT    PRIMARY KEY,
        reason         TEXT    NOT NULL CHECK (reason IN ('duplicate', 'conflict', 'unparseable')),
        kept_event_id  TEXT,
        detected_at    INTEGER NOT NULL,
        origin         TEXT    NOT NULL CHECK (origin IN ('live', 'backfill'))
      );
    `);

    const baselineRow = db.prepare('SELECT applied_at FROM schema_migrations WHERE version = 1').get() as
      | { applied_at: number }
      | undefined;
    const legacyContractCutoff = baselineRow ? Number(baselineRow.applied_at) : null;

    runUsageLedgerBackfill(db, { origin: 'backfill', legacyContractCutoff });
  },
};
