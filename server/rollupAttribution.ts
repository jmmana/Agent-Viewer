/**
 * SQLite half of the `meeting`/`tool` rollup dimensions (issue #80): the derived tables `tool_calls` and
 * `meeting_labels`, kept current on the live write path and backfilled from `events` for history written before
 * this feature existed. Mirrors `server/usageLedger.ts`'s own split (a pure row-mapper, a live-write insert, and a
 * paged backfill scan reused by both the migration and the server's startup catch-up).
 *
 * `events.payload` (a `TEXT NOT NULL` column since the very first migration, `server/db/migrations/0001-baseline.ts`)
 * is used for the backfill instead of `event_json` (added later, nullable): every stored row, including one
 * written before 0.2.0, has a `payload`, so no legacy-row fallback like `usageLedger.ts`'s `rowToEvent` is needed
 * here. Memory mode never calls into this module: its equivalent of these two tables is
 * `ServerState.toolCallNames`/`meetingTitles` (`server/serverState.ts`), kept current by the same `applyEvent`
 * reducer both stores already share.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { CanonicalEvent } from '../src/integrations/canonicalContract';

/**
 * Creates `tool_calls`, `meeting_labels`, the `tool_call_resolution` view and the two `usage_ledger` indexes the
 * join needs, if they do not already exist. The single source of truth for this DDL: the migration
 * (`server/db/migrations/0011-rollup-attribution.ts`) calls it once, and `SQLiteEventStore`'s constructor
 * (`server/store.ts`) calls it again on every open, unconditionally, before the backfill catch-up below. That
 * second call is what makes "drop `tool_calls`/`meeting_labels` and restart" reproduce them (issue #80's own
 * acceptance criterion): `schema_migrations` only remembers that migration 11 *ran*, not that its tables still
 * exist, so a dropped table is never recreated by the migration runner alone.
 */
export function ensureRollupAttributionTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      session_id      TEXT    NOT NULL DEFAULT '',
      agent_id        TEXT    NOT NULL DEFAULT '',
      tool_call_id    TEXT    NOT NULL,
      tool            TEXT    NOT NULL,
      first_event_id  TEXT    NOT NULL,
      first_seen_at   INTEGER NOT NULL,
      PRIMARY KEY (session_id, agent_id, tool_call_id, tool)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS ix_tool_calls_scope ON tool_calls(session_id, agent_id, tool_call_id);

    CREATE TABLE IF NOT EXISTS meeting_labels (
      meeting_id  TEXT    PRIMARY KEY,
      title       TEXT,
      updated_at  INTEGER NOT NULL
    ) WITHOUT ROWID;

    CREATE VIEW IF NOT EXISTS tool_call_resolution AS
    SELECT
      session_id,
      agent_id,
      tool_call_id,
      CASE WHEN COUNT(DISTINCT tool) = 1 THEN MAX(tool) ELSE NULL END AS resolved_tool,
      CASE WHEN COUNT(DISTINCT tool) > 1 THEN 1 ELSE 0 END AS ambiguous
    FROM tool_calls
    GROUP BY session_id, agent_id, tool_call_id;

    CREATE INDEX IF NOT EXISTS ix_usage_ledger_tool_call ON usage_ledger(tool_call_id);
    CREATE INDEX IF NOT EXISTS ix_usage_ledger_meeting ON usage_ledger(meeting_id);
  `);
}

/** Applies one accepted event's rollup-attribution side effect to the SQL tables, if it has one. Called from the
 * same code path (and therefore the same transaction) as the event's own insert, both in `append` and in
 * `appendBatch` (`server/store.ts`), so an event's row and its derived row(s) always land or roll back together.
 * A no-op for every event type other than `tool.started`, `meeting.requested` and `meeting.started`.
 */
export function applyRollupAttributionSideEffect(db: DatabaseSync, event: CanonicalEvent, receivedAt: number): void {
  if (event.type === 'tool.started') {
    const toolCallId = event.payload?.toolCallId;
    const tool = event.payload?.tool;
    if (typeof toolCallId === 'string' && toolCallId.length > 0 && typeof tool === 'string' && tool.length > 0) {
      db.prepare(
        `INSERT OR IGNORE INTO tool_calls (session_id, agent_id, tool_call_id, tool, first_event_id, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(event.sessionId ?? '', event.agentId ?? '', toolCallId, tool, event.id, receivedAt);
    }
    return;
  }
  if (event.type === 'meeting.requested' || event.type === 'meeting.started') {
    const meetingId = event.payload?.meetingId;
    const title = event.payload?.title;
    if (typeof meetingId === 'string' && meetingId.length > 0 && typeof title === 'string' && title.length > 0) {
      db.prepare(
        `INSERT INTO meeting_labels (meeting_id, title, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(meeting_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`
      ).run(meetingId, title, receivedAt);
    }
  }
}

export interface RollupAttributionBackfillStats {
  scanned: number;
  toolCallsInserted: number;
  meetingLabelsUpserted: number;
  pages: number;
}

export interface RollupAttributionBackfillOptions {
  pageSize?: number;
  log?: (message: string) => void;
}

/**
 * Scans `events` for `tool.started`/`meeting.requested`/`meeting.started` rows, paged by `rowid` so a large
 * database is scanned with flat memory use, and gives each one its rollup-attribution side effect. Idempotent
 * (`INSERT OR IGNORE` for `tool_calls`, upsert for `meeting_labels`), so it is safe to call on every server open
 * (the same "run once in the migration, run again on every later open" pattern as `runUsageLedgerBackfill`,
 * `server/usageLedger.ts`): a restart after the two tables were dropped reproduces them from `events` alone
 * (issue #80's own acceptance criterion), and a server that was offline while this feature was deployed elsewhere
 * (or a downgrade-then-upgrade) still catches up. Rows are read in ascending `rowid` order, which for
 * `meeting_labels` is also acceptance order, so "last accepted title wins" is reproduced exactly on every run.
 */
export function runRollupAttributionBackfill(db: DatabaseSync, options: RollupAttributionBackfillOptions = {}): RollupAttributionBackfillStats {
  const pageSize = options.pageSize && options.pageSize > 0 ? Math.trunc(options.pageSize) : 50_000;
  const log = options.log ?? ((message: string) => console.log(message));

  const stats: RollupAttributionBackfillStats = { scanned: 0, toolCallsInserted: 0, meetingLabelsUpserted: 0, pages: 0 };

  const pageStmt = db.prepare(`
    SELECT rowid AS rowid, id, type, session_id, agent_id, payload, created_at
    FROM events
    WHERE rowid > ? AND type IN ('tool.started', 'meeting.requested', 'meeting.started')
    ORDER BY rowid
    LIMIT ?
  `);
  const insertToolCall = db.prepare(
    `INSERT OR IGNORE INTO tool_calls (session_id, agent_id, tool_call_id, tool, first_event_id, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const upsertMeetingLabel = db.prepare(
    `INSERT INTO meeting_labels (meeting_id, title, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(meeting_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`
  );

  let lastRowid = 0;
  while (true) {
    const rows = pageStmt.all(lastRowid, pageSize) as Array<{
      rowid: number;
      id: string;
      type: string;
      session_id: string | null;
      agent_id: string | null;
      payload: string;
      created_at: number;
    }>;
    if (rows.length === 0) break;
    stats.pages++;

    for (const row of rows) {
      lastRowid = row.rowid;
      stats.scanned++;

      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.payload || '{}');
        payload = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        continue;
      }

      if (row.type === 'tool.started') {
        const toolCallId = payload.toolCallId;
        const tool = payload.tool;
        if (typeof toolCallId === 'string' && toolCallId.length > 0 && typeof tool === 'string' && tool.length > 0) {
          const result = insertToolCall.run(row.session_id ?? '', row.agent_id ?? '', toolCallId, tool, row.id, Number(row.created_at));
          if (Number(result.changes) > 0) stats.toolCallsInserted++;
        }
      } else {
        const meetingId = payload.meetingId;
        const title = payload.title;
        if (typeof meetingId === 'string' && meetingId.length > 0 && typeof title === 'string' && title.length > 0) {
          upsertMeetingLabel.run(meetingId, title, Number(row.created_at));
          stats.meetingLabelsUpserted++;
        }
      }
    }

    log(
      `[agent-viewer] rollup_attribution: page ${stats.pages} scanned=${stats.scanned} toolCallsInserted=${stats.toolCallsInserted} meetingLabelsUpserted=${stats.meetingLabelsUpserted}`
    );
    if (rows.length < pageSize) break;
  }

  return stats;
}
