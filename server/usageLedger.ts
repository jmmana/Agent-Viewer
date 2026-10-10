/**
 * The usage ledger (issue #65): one append-only, typed row per accepted `llm.usage` or `llm.failed` event,
 * carrying the server receive time. Every later item from 0.4.0 onward that touches tokens or cost reads from
 * this table instead of `events.payload`.
 *
 * This module has no dependency on either `EventStore` implementation: it only maps a `CanonicalEvent` to a row
 * (`toLedgerRow`), compares two rows for the duplicate/conflict decision (`sameCall`), and runs the backfill scan
 * directly against a raw `node:sqlite` connection (`runUsageLedgerBackfill`). `server/store.ts` calls into it for
 * the live write path; `server/db/migrations/0006-usage-ledger.ts` calls into it once for the initial backfill;
 * `SQLiteEventStore` calls into it again on every open, for startup catch-up.
 *
 * Deviation from the issue's literal column list, recorded here because the issue told the implementer to:
 * the proposal names a `span_id` column mirroring a `payload.spanId` field. Issue #64 (correlation and
 * attribution fields), merged before this one, never added a `spanId` field: it shipped `traceId`, `parentId`,
 * `toolCallId`, `meetingId`, `userId` and `tags` (`src/integrations/canonicalContract.ts`,
 * `UsageCorrelationSchema`). This module and the migration use `meeting_id` in place of `span_id`, mirroring the
 * payload field that actually exists. If a later issue adds a real `spanId`, this table gains a column for it
 * then; `meeting_id` is not repurposed.
 *
 * Also resolved here (the issue asked the implementer to confirm against the merged 0.3.0 code): the "0 means
 * unknown" legacy rule for webhook `inputTokens`/`outputTokens` applies only to `legacy_contract = 1` rows.
 * `GenericWebhookPayloadSchema.usage` (`server/index.ts`) has used the strict `LlmUsagePayloadSchema` since
 * 0.3.0, whose `inputTokens`/`outputTokens` are required fields with no default: a live webhook call must send
 * an explicit value (including an explicit `0`), so a live webhook row never has an invented zero to begin with.
 *
 * Also resolved here: issue #46 shipped one enum for why an `llm.failed` call failed, `payload.errorKind`
 * (`LLM_ERROR_KINDS`), not two separate fields. `status` and `error_kind` both take that same value for a
 * `llm.failed` row (`status = 'ok'` for `llm.usage`, `error_kind = NULL`). The two columns are kept separate, as
 * the issue specifies, so a later issue that gives `llm.failed` a richer status (for example one that
 * distinguishes "failed after retries" from "failed once") can fill `status` without displacing `error_kind`.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { CanonicalEvent } from '../src/integrations/canonicalContract';
import { isLlmErrorKind } from '../src/integrations/canonicalTypes';
import { normalizeProvider, normalizeRequestId } from './requestKey';
import { rowToEvent } from './eventRow';

export type LedgerEventType = 'llm.usage' | 'llm.failed';
export type IngestChannel = 'events' | 'events-batch' | 'webhook' | 'otlp' | 'unknown';
export type LedgerOrigin = 'live' | 'backfill';
export type CostSource = 'provider-reported' | 'estimated' | 'unknown';
export type LedgerSkipReason = 'duplicate' | 'conflict' | 'unparseable';

export interface UsageLedgerRow {
  seq: number;
  eventId: string;
  eventType: LedgerEventType;
  requestId: string | null;
  /** ms epoch, SERVER clock (same value as `events.created_at` for this event). */
  receivedAt: number;
  /** ms epoch, CLIENT clock (`event.timestamp`). */
  occurredAt: number;
  origin: LedgerOrigin;
  legacyContract: boolean;
  ingestChannel: IngestChannel;
  runtimeId: string | null;
  sessionId: string | null;
  agentId: string | null;
  taskId: string | null;
  /** Normalized the same way as `requestKeyFor` (trimmed, lowercased): NULL when the event never carried it. */
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  cost: number | null;
  currency: string | null;
  costSource: CostSource;
  latencyMs: number | null;
  status: string;
  errorKind: string | null;
  traceId: string | null;
  parentId: string | null;
  toolCallId: string | null;
  meetingId: string | null;
  userId: string | null;
  tags: string[];
  /** `event.summary` (issue #69, migration `usage-ledger-summary`). `null` for a row written before that
   * migration: `usage_ledger` is append-only (`usage_ledger_no_update`), so an old row can never be backfilled. */
  summary: string | null;
}

export type LedgerRowInput = Omit<UsageLedgerRow, 'seq'>;

export interface ToLedgerRowContext {
  /** Server clock, taken once when the request arrived (or `events.created_at` during a backfill). */
  receivedAt: number;
  origin: LedgerOrigin;
  channel: IngestChannel;
  /** True when this event was stored by a pre-0.4.0 server (see `legacyContractCutoff` in the backfill). */
  legacyContract: boolean;
}

export interface UsageLedgerSkip {
  eventId: string;
  reason: LedgerSkipReason;
  /** The event whose row already holds this call. `null` for `unparseable`. */
  keptEventId: string | null;
  detectedAt: number;
  origin: LedgerOrigin;
}

function finiteNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

function finiteNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Exactly 3 letters (any case, stored as reported); anything else means "unknown", per the issue's own rule. */
function currencyOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value : null;
}

function costSourceOrDefault(value: unknown): CostSource {
  return value === 'provider-reported' || value === 'estimated' || value === 'unknown' ? value : 'unknown';
}

/** Normalizes a string with `normalize`, the same way `requestKeyFor` does; blank after trimming means "absent". */
function normalizedOrNull(value: unknown, normalize: (s: string) => string): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalize(value);
  return normalized.length > 0 ? normalized : null;
}

function tagsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === 'string');
}

/**
 * Maps one accepted `llm.usage` or `llm.failed` event to a ledger row. Returns `null` for any other event type,
 * or when the event's `payload` is not a plain object (only reachable from the backfill over pre-validation
 * data; live routes validate the payload shape before this is ever called). Never throws: every numeric field
 * that is not a finite, non-negative value of the right kind is stored as `NULL` (unknown), never invented as 0.
 */
export function toLedgerRow(event: CanonicalEvent, ctx: ToLedgerRowContext): LedgerRowInput | null {
  if (event.type !== 'llm.usage' && event.type !== 'llm.failed') return null;
  const payloadRaw = (event as { payload?: unknown }).payload;
  if (payloadRaw === null || typeof payloadRaw !== 'object' || Array.isArray(payloadRaw)) return null;
  const payload = payloadRaw as Record<string, unknown>;
  const isFailed = event.type === 'llm.failed';

  let inputTokens = finiteNonNegativeInt(payload.inputTokens);
  let outputTokens = finiteNonNegativeInt(payload.outputTokens);
  // The deprecated `cachedTokens` alias is read when `cacheReadTokens` itself is absent, same as the live
  // contract's own `applyCachedAlias` (`canonicalContract.ts`), so a legacy payload that only ever had
  // `cachedTokens` still maps to `cacheReadTokens` here.
  let cacheReadTokens = finiteNonNegativeInt(
    payload.cacheReadTokens !== undefined ? payload.cacheReadTokens : payload.cachedTokens
  );
  let cacheWriteTokens = finiteNonNegativeInt(payload.cacheWriteTokens);
  let reasoningTokens = finiteNonNegativeInt(payload.reasoningTokens);

  if (ctx.legacyContract) {
    // The 0.2.x contract and SDKs defaulted missing cached/reasoning tokens to 0 (issue #46's "Current behavior"
    // section); a reported 0 and "not reported" could never be told apart on those rows.
    if (cacheReadTokens === 0) cacheReadTokens = null;
    if (reasoningTokens === 0) reasoningTokens = null;
    if (ctx.channel === 'webhook') {
      // The pre-0.3.0 webhook loose normalizer defaulted missing inputTokens/outputTokens to 0
      // (`canonicalTypes.ts`'s normalizer, as it existed then). Live webhook rows cannot hit this: see the module
      // doc comment above.
      if (inputTokens === 0) inputTokens = null;
      if (outputTokens === 0) outputTokens = null;
    }
  }

  let cost = finiteNonNegativeNumber(payload.cost);
  let currency = currencyOrNull(payload.currency);
  let costSource = costSourceOrDefault(payload.costSource);
  if (cost === null) {
    // A currency or a cost source for a missing figure means nothing.
    currency = null;
    costSource = 'unknown';
  }

  const errorKind = isFailed && isLlmErrorKind(payload.errorKind) ? payload.errorKind : isFailed ? 'unknown' : null;

  return {
    eventId: event.id,
    eventType: event.type,
    requestId: normalizedOrNull(payload.requestId, normalizeRequestId),
    receivedAt: ctx.receivedAt,
    occurredAt: event.timestamp,
    origin: ctx.origin,
    legacyContract: ctx.legacyContract,
    ingestChannel: ctx.channel,
    runtimeId: stringOrNull(event.runtimeId ?? null),
    sessionId: stringOrNull(event.sessionId ?? null),
    agentId: stringOrNull(event.agentId ?? null),
    taskId: stringOrNull(event.taskId ?? null),
    provider: normalizedOrNull(payload.provider, normalizeProvider),
    model: stringOrNull(payload.model),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    cost,
    currency,
    costSource,
    latencyMs: finiteNonNegativeInt(payload.latencyMs),
    status: isFailed ? (errorKind ?? 'unknown') : 'ok',
    errorKind,
    traceId: stringOrNull(payload.traceId),
    parentId: stringOrNull(payload.parentId),
    toolCallId: stringOrNull(payload.toolCallId),
    meetingId: stringOrNull(payload.meetingId),
    userId: stringOrNull(payload.userId),
    tags: tagsOf(payload.tags),
    summary: event.summary,
  };
}

/** The request key of a ledger row, or `null` when either half is missing: a request key exists only when every
 * column of it is non-NULL (the issue's own rule, matching how `events.request_provider`/`request_id` work). */
export function ledgerRequestKey(row: Pick<LedgerRowInput, 'provider' | 'requestId'>): string | null {
  if (row.provider === null || row.requestId === null) return null;
  return `${row.provider}\u0000${row.requestId}`;
}

const COMPARED_SCALAR_FIELDS = [
  'eventType',
  'runtimeId',
  'sessionId',
  'agentId',
  'taskId',
  'provider',
  'model',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
  'cost',
  'currency',
  'costSource',
  'latencyMs',
  'status',
  'errorKind',
  'traceId',
  'parentId',
  'toolCallId',
  'meetingId',
  'userId',
] as const satisfies ReadonlyArray<keyof LedgerRowInput>;

/**
 * True when every usage-relevant field of `a` and `b` is equal: everything except ids, both timestamps, origin,
 * ingest channel and the legacy flag (the issue's own exclusion list), so a row that reached the ledger live and
 * its later backfilled twin (or vice versa) still compare as the same call.
 */
export function sameCall(a: LedgerRowInput, b: LedgerRowInput): boolean {
  for (const field of COMPARED_SCALAR_FIELDS) {
    if (a[field] !== b[field]) return false;
  }
  if (a.tags.length !== b.tags.length) return false;
  for (let i = 0; i < a.tags.length; i++) {
    if (a.tags[i] !== b.tags[i]) return false;
  }
  return true;
}

// -------------------------------------------------------------
// SQL helpers shared by the migration backfill and the startup catch-up (both run against a raw DatabaseSync).
// -------------------------------------------------------------

/** Exported for `server/usage/calls.ts` (issue #67), which selects the same column list (plus `seq`) for its
 * keyset query and reuses `dbRowToLedgerRowInput` to turn a raw row back into a `UsageLedgerRow`, instead of
 * re-deriving the ledger's column list a second time. */
export const LEDGER_COLUMNS = [
  'event_id', 'event_type', 'request_id', 'received_at', 'occurred_at', 'origin', 'legacy_contract',
  'ingest_channel', 'runtime_id', 'session_id', 'agent_id', 'task_id', 'provider', 'model', 'input_tokens',
  'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'cost', 'currency',
  'cost_source', 'latency_ms', 'status', 'error_kind', 'trace_id', 'parent_id', 'tool_call_id', 'meeting_id',
  'user_id', 'tags', 'summary',
] as const;

function ledgerInsertSql(): string {
  return `INSERT INTO usage_ledger (${LEDGER_COLUMNS.join(', ')}) VALUES (${LEDGER_COLUMNS.map(() => '?').join(', ')}) ON CONFLICT(event_id) DO NOTHING`;
}

function ledgerRowParams(row: LedgerRowInput): unknown[] {
  return [
    row.eventId,
    row.eventType,
    row.requestId,
    row.receivedAt,
    row.occurredAt,
    row.origin,
    row.legacyContract ? 1 : 0,
    row.ingestChannel,
    row.runtimeId,
    row.sessionId,
    row.agentId,
    row.taskId,
    row.provider,
    row.model,
    row.inputTokens,
    row.outputTokens,
    row.cacheReadTokens,
    row.cacheWriteTokens,
    row.reasoningTokens,
    row.cost,
    row.currency,
    row.costSource,
    row.latencyMs,
    row.status,
    row.errorKind,
    row.traceId,
    row.parentId,
    row.toolCallId,
    row.meetingId,
    row.userId,
    JSON.stringify(row.tags),
    row.summary,
  ];
}

/** Reconstructs a `LedgerRowInput` from a raw `usage_ledger` row (snake_case columns), for a `sameCall` compare. */
export function dbRowToLedgerRowInput(r: any): LedgerRowInput {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(r.tags ?? '[]');
    if (Array.isArray(parsed)) tags = parsed.filter((t: unknown): t is string => typeof t === 'string');
  } catch {
    tags = [];
  }
  return {
    eventId: r.event_id,
    eventType: r.event_type,
    requestId: r.request_id,
    receivedAt: Number(r.received_at),
    occurredAt: Number(r.occurred_at),
    origin: r.origin,
    legacyContract: Boolean(r.legacy_contract),
    ingestChannel: r.ingest_channel,
    runtimeId: r.runtime_id,
    sessionId: r.session_id,
    agentId: r.agent_id,
    taskId: r.task_id,
    provider: r.provider,
    model: r.model,
    inputTokens: r.input_tokens === null ? null : Number(r.input_tokens),
    outputTokens: r.output_tokens === null ? null : Number(r.output_tokens),
    cacheReadTokens: r.cache_read_tokens === null ? null : Number(r.cache_read_tokens),
    cacheWriteTokens: r.cache_write_tokens === null ? null : Number(r.cache_write_tokens),
    reasoningTokens: r.reasoning_tokens === null ? null : Number(r.reasoning_tokens),
    cost: r.cost === null ? null : Number(r.cost),
    currency: r.currency,
    costSource: r.cost_source,
    latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
    status: r.status,
    errorKind: r.error_kind,
    traceId: r.trace_id,
    parentId: r.parent_id,
    toolCallId: r.tool_call_id,
    meetingId: r.meeting_id,
    userId: r.user_id,
    tags,
    summary: r.summary ?? null,
  };
}

/** True once migration `usage-rollup` (issue #66) has run. Checked once per backfill/catch-up pass: migration
 * `usage-ledger` (#65) itself calls `runUsageLedgerBackfill` from inside its own `up()`, before that later
 * migration (and its table) exists, so tag rows cannot be written yet on that very first pass. Migration
 * `usage-rollup`'s own backfill step (`INSERT OR IGNORE ... SELECT ... FROM usage_ledger, json_each(tags)`) covers
 * that gap once it runs; every later catch-up pass (on every server start) finds the table and keeps it current. */
function usageLedgerTagsTableExists(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_ledger_tags'").get());
}

/**
 * Inserts one ledger decision for an already-computed row: the request key (when complete) is checked first,
 * exactly like the live path (`server/store.ts`), so a backfill or a catch-up pass reaches the same duplicate /
 * conflict decision a concurrent live write would. Idempotent: the row insert and the skip insert both use
 * `ON CONFLICT(event_id) DO NOTHING`, so calling this twice for the same event id is a no-op the second time.
 * When `stmts.insertTag` is set (issue #66: `usage_ledger_tags` exists), one tag row per tag is written in the
 * same step, keyed by the ledger row's own `seq` (the SQLite `rowid` alias, read back from `run()`), but only
 * when the ledger insert actually happened (`changes > 0`): a conflict that silently no-ops must not write tags
 * for a row it did not insert.
 */
function insertLedgerDecision(
  db: DatabaseSync,
  stmts: { insertLedger: any; insertSkip: any; lookupByRequestKey: any; insertTag: any | null },
  row: LedgerRowInput,
  now: number
): 'inserted' | 'duplicate' | 'conflict' {
  const key = ledgerRequestKey(row);
  if (key !== null) {
    const existingRaw = stmts.lookupByRequestKey.get(row.provider, row.requestId);
    if (existingRaw) {
      const existing = dbRowToLedgerRowInput(existingRaw);
      const reason: LedgerSkipReason = sameCall(existing, row) ? 'duplicate' : 'conflict';
      stmts.insertSkip.run(row.eventId, reason, existing.eventId, now, row.origin);
      return reason;
    }
  }
  const result = stmts.insertLedger.run(...ledgerRowParams(row));
  if (stmts.insertTag && Number(result.changes) > 0 && row.tags.length > 0) {
    const seq = Number(result.lastInsertRowid);
    for (const tag of row.tags) stmts.insertTag.run(seq, tag);
  }
  return 'inserted';
}

export interface BackfillStats {
  scanned: number;
  inserted: number;
  duplicate: number;
  conflict: number;
  unparseable: number;
  pages: number;
}

export interface BackfillOptions {
  /** Rows scanned from `events` per `rowid` page. Default 50000 (the issue's own default); tests override it to
   * exercise multi-page paging against a small fixture. */
  pageSize?: number;
  /** Server clock, injected for tests. */
  now?: () => number;
  /** One line per page plus a final summary line (the issue's required log shape), defaults to `console.log`. */
  log?: (message: string) => void;
}

/**
 * Scans `events` for `llm.usage`/`llm.failed` rows that have neither a ledger row nor a skip row yet, in `rowid`
 * pages, and gives each one a ledger decision. Used both for the one-time backfill inside migration
 * `0006-usage-ledger` (where the table starts empty, so every row needs a decision) and for the startup
 * catch-up `SQLiteEventStore` runs on every open (where normally nothing is left to do). `legacyContractCutoff`
 * is the baseline migration's `applied_at`: a row is legacy when its `created_at` is strictly before it.
 */
export function runUsageLedgerBackfill(
  db: DatabaseSync,
  args: { origin: LedgerOrigin; legacyContractCutoff: number | null },
  options: BackfillOptions = {}
): BackfillStats {
  const pageSize = options.pageSize && options.pageSize > 0 ? Math.trunc(options.pageSize) : 50_000;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.log(message));

  const stats: BackfillStats = { scanned: 0, inserted: 0, duplicate: 0, conflict: 0, unparseable: 0, pages: 0 };

  const pageStmt = db.prepare(`
    SELECT e.rowid AS rowid, e.*
    FROM events e
    WHERE e.rowid > ?
      AND e.type IN ('llm.usage', 'llm.failed')
      AND NOT EXISTS (SELECT 1 FROM usage_ledger l WHERE l.event_id = e.id)
      AND NOT EXISTS (SELECT 1 FROM usage_ledger_skips s WHERE s.event_id = e.id)
    ORDER BY e.rowid
    LIMIT ?
  `);
  const stmts = {
    insertLedger: db.prepare(ledgerInsertSql()),
    insertSkip: db.prepare(
      'INSERT INTO usage_ledger_skips (event_id, reason, kept_event_id, detected_at, origin) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING'
    ),
    lookupByRequestKey: db.prepare('SELECT * FROM usage_ledger WHERE provider = ? AND request_id = ? LIMIT 1'),
    insertTag: usageLedgerTagsTableExists(db)
      ? db.prepare('INSERT OR IGNORE INTO usage_ledger_tags (ledger_seq, tag) VALUES (?, ?)')
      : null,
  };

  let lastRowid = 0;
  while (true) {
    const rows = pageStmt.all(lastRowid, pageSize) as any[];
    if (rows.length === 0) break;
    stats.pages++;
    let pageInserted = 0;
    let pageDuplicate = 0;
    let pageConflict = 0;
    let pageUnparseable = 0;

    for (const row of rows) {
      lastRowid = row.rowid;
      stats.scanned++;

      let event: CanonicalEvent;
      try {
        event = rowToEvent(row);
      } catch {
        stmts.insertSkip.run(row.id, 'unparseable', null, now(), args.origin);
        pageUnparseable++;
        continue;
      }

      const receivedAt = Number(row.created_at);
      const legacyContract = args.legacyContractCutoff === null ? true : receivedAt < args.legacyContractCutoff;
      const channel: IngestChannel =
        typeof row.id === 'string' && row.id.startsWith('evt_wh_usage_') ? 'webhook' : 'unknown';

      const ledgerRow = toLedgerRow(event, { receivedAt, origin: args.origin, channel, legacyContract });
      if (ledgerRow === null) {
        stmts.insertSkip.run(row.id, 'unparseable', null, now(), args.origin);
        pageUnparseable++;
        continue;
      }

      const decision = insertLedgerDecision(db, stmts, ledgerRow, now());
      if (decision === 'inserted') pageInserted++;
      else if (decision === 'duplicate') pageDuplicate++;
      else pageConflict++;
    }

    stats.inserted += pageInserted;
    stats.duplicate += pageDuplicate;
    stats.conflict += pageConflict;
    stats.unparseable += pageUnparseable;
    log(
      `[agent-viewer] usage_ledger: page ${stats.pages} scanned=${rows.length} inserted=${pageInserted} duplicate=${pageDuplicate} conflict=${pageConflict} unparseable=${pageUnparseable} (${args.origin})`
    );

    if (rows.length < pageSize) break;
  }

  log(
    `[agent-viewer] usage_ledger: scanned=${stats.scanned} inserted=${stats.inserted} duplicate=${stats.duplicate} conflict=${stats.conflict} unparseable=${stats.unparseable} (${args.origin})`
  );
  return stats;
}
