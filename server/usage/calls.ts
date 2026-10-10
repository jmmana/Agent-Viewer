/**
 * `GET /api/v1/usage/calls` (issue #67): the keyset query over `usage_ledger` (#65), its cursor, and the
 * `UsageLedgerRow -> CallRecord` serializer. `server/store.ts` calls `buildListCallsQuery` /
 * `matchesUsageFilters` from its `SQLiteEventStore.listCalls` / `MemoryEventStore.listCalls`; `server/index.ts`
 * calls `encodeCursor` / `decodeCursor` / `filterHash` directly, since cursor validation (shape, filter match,
 * store epoch) needs no database access and is identical for both stores.
 */
import crypto from 'node:crypto';
import { LEDGER_COLUMNS, dbRowToLedgerRowInput, type CostSource, type UsageLedgerRow } from '../usageLedger';
import { type CallRecord, type UsageFilters } from './types';

export interface CallsOrder {
  order: 'desc' | 'asc';
}

export interface CallsQuery {
  filters: UsageFilters;
  order: 'desc' | 'asc';
  /** Already validated to 1..1000 by `parseUsageFilters`. */
  limit: number;
  /** Decoded keyset position from the request's cursor. Absent on the first page of a walk. */
  after?: { seq: number };
}

export interface CallsPage {
  rows: CallRecord[];
  /** Computed with `LIMIT limit + 1`, never `COUNT(*)` (the issue's own rule: never expensive, never unstable
   * while rows keep arriving). */
  hasMore: boolean;
  /** `seq` of the last row in `rows` (in the page's own order), `null` when `rows` is empty. */
  lastSeq: number | null;
}

const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Returns `value` only when it already looks like a short machine code; otherwise `null`. See the "errorCode"
 * section of the module doc comment in `server/usage/types.ts`: today this only ever sees an `LLM_ERROR_KINDS`
 * value, which always passes, but the check stays as defense in depth. */
function safeErrorCode(value: string | null): string | null {
  return value !== null && ERROR_CODE_PATTERN.test(value) ? value : null;
}

/** The allow-list serializer (issue #67, section 3): every field on `CallRecord` is listed explicitly here, so
 * a new `usage_ledger` column is never exposed by accident. Never touches `event_json`, `summary` or any other
 * free-text source: its only input is an already-typed `UsageLedgerRow`. */
export function toCallRecord(row: UsageLedgerRow): CallRecord {
  return {
    seq: row.seq,
    eventId: row.eventId,
    type: row.eventType,
    status: row.status as CallRecord['status'],
    backfilled: row.origin === 'backfill',
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    agentId: row.agentId,
    sessionId: row.sessionId,
    runtimeId: row.runtimeId,
    taskId: row.taskId,
    provider: row.provider,
    model: row.model,
    tokens: {
      input: row.inputTokens,
      output: row.outputTokens,
      cacheRead: row.cacheReadTokens,
      cacheWrite: row.cacheWriteTokens,
      reasoning: row.reasoningTokens,
    },
    latencyMs: row.latencyMs,
    requestId: row.requestId,
    cost: row.cost,
    currency: row.currency,
    costSource: row.costSource,
    errorCode: safeErrorCode(row.errorKind),
    trace: {
      traceId: row.traceId,
      parentId: row.parentId,
      toolCallId: row.toolCallId,
      meetingId: row.meetingId,
    },
    userId: row.userId,
    tags: row.tags,
  };
}

// -------------------------------------------------------------
// In-memory matching (MemoryEventStore.listCalls)
// -------------------------------------------------------------

/**
 * True when `row` matches every filter in `filters` (AND across keys, OR within a repeated key), with the same
 * NULL semantics SQL's `IN` gives `buildListCallsQuery`: an unset ledger field never matches a non-empty filter
 * list on that key (`NULL IN (...)` is never true). Kept in lockstep with `buildListCallsQuery` by the shared
 * conformance tests (`tests/usage-calls-store.test.mjs`), since the two are necessarily separate implementations
 * (one filters an array, the other builds SQL).
 */
export function matchesUsageFilters(row: UsageLedgerRow, filters: UsageFilters): boolean {
  const timeValue = filters.timeBasis === 'occurred' ? row.occurredAt : row.receivedAt;
  if (filters.from !== null && timeValue < filters.from) return false;
  if (filters.to !== null && timeValue >= filters.to) return false;

  if (filters.agentId.length > 0 && (row.agentId === null || !filters.agentId.includes(row.agentId))) return false;
  if (filters.sessionId.length > 0 && (row.sessionId === null || !filters.sessionId.includes(row.sessionId))) return false;
  if (filters.runtimeId.length > 0 && (row.runtimeId === null || !filters.runtimeId.includes(row.runtimeId))) return false;
  if (filters.taskId.length > 0 && (row.taskId === null || !filters.taskId.includes(row.taskId))) return false;
  if (filters.provider.length > 0 && (row.provider === null || !filters.provider.includes(row.provider))) return false;
  if (filters.model.length > 0 && (row.model === null || !filters.model.includes(row.model))) return false;
  if (filters.status.length > 0 && !filters.status.includes(row.status as UsageFilters['status'][number])) return false;
  if (filters.costSource.length > 0 && !filters.costSource.includes(row.costSource as CostSource)) return false;

  if (filters.currency.length > 0) {
    const wantsNone = filters.currency.includes('none');
    const codes = filters.currency.filter((c) => c !== 'none');
    const matchesCode = row.currency !== null && codes.includes(row.currency);
    const matchesNone = row.currency === null && wantsNone;
    if (!matchesCode && !matchesNone) return false;
  }

  if (filters.requestId.length > 0 && (row.requestId === null || !filters.requestId.includes(row.requestId))) return false;
  if (filters.traceId !== null && row.traceId !== filters.traceId) return false;

  return true;
}

/**
 * The in-memory equivalent of `SQLiteEventStore.listCalls`, over an already-filtered, seq-ascending array
 * (`MemoryEventStore`'s `this.ledger` is append-only, so it is always seq-ascending; see its own field comment).
 * Pure function so the conformance tests can call it directly with handcrafted fixtures.
 */
export function listCallsInMemory(ledger: readonly UsageLedgerRow[], query: CallsQuery): CallsPage {
  let matched = ledger.filter((row) => matchesUsageFilters(row, query.filters));
  if (query.order === 'desc') matched = matched.slice().reverse();
  if (query.after) {
    const afterSeq = query.after.seq;
    matched = matched.filter((row) => (query.order === 'desc' ? row.seq < afterSeq : row.seq > afterSeq));
  }
  const windowRows = matched.slice(0, query.limit + 1);
  const hasMore = windowRows.length > query.limit;
  const rows = hasMore ? windowRows.slice(0, query.limit) : windowRows;
  return {
    rows: rows.map(toCallRecord),
    hasMore,
    lastSeq: rows.length > 0 ? rows[rows.length - 1].seq : null,
  };
}

// -------------------------------------------------------------
// SQLite keyset query (SQLiteEventStore.listCalls)
// -------------------------------------------------------------

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

/**
 * One keyset query over `usage_ledger`, explicit column list (never `SELECT *`, never a join), filtered and
 * ordered by `seq` so a filtered query still reads in `seq` order without a temp sort when the matching index
 * from migration 7 (`usage-calls-indexes`) applies (see its own doc comment for the index list).
 */
export function buildListCallsQuery(query: CallsQuery): BuiltQuery {
  const { filters } = query;
  const clauses: string[] = [];
  const params: unknown[] = [];

  const timeColumn = filters.timeBasis === 'occurred' ? 'occurred_at' : 'received_at';
  if (filters.from !== null) {
    clauses.push(`${timeColumn} >= ?`);
    params.push(filters.from);
  }
  if (filters.to !== null) {
    clauses.push(`${timeColumn} < ?`);
    params.push(filters.to);
  }

  function inClause(column: string, values: readonly string[]): void {
    if (values.length === 0) return;
    clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
    params.push(...values);
  }

  inClause('agent_id', filters.agentId);
  inClause('session_id', filters.sessionId);
  inClause('runtime_id', filters.runtimeId);
  inClause('task_id', filters.taskId);
  inClause('provider', filters.provider);
  inClause('model', filters.model);
  inClause('status', filters.status);
  inClause('cost_source', filters.costSource);

  if (filters.currency.length > 0) {
    const codes = filters.currency.filter((c) => c !== 'none');
    const wantsNone = filters.currency.includes('none');
    const parts: string[] = [];
    if (codes.length > 0) {
      parts.push(`currency IN (${codes.map(() => '?').join(', ')})`);
      params.push(...codes);
    }
    if (wantsNone) parts.push('currency IS NULL');
    clauses.push(`(${parts.join(' OR ')})`);
  }

  inClause('request_id', filters.requestId);
  if (filters.traceId !== null) {
    clauses.push('trace_id = ?');
    params.push(filters.traceId);
  }

  if (query.after) {
    clauses.push(query.order === 'desc' ? 'seq < ?' : 'seq > ?');
    params.push(query.after.seq);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const direction = query.order === 'desc' ? 'DESC' : 'ASC';
  const sql = `SELECT seq, ${LEDGER_COLUMNS.join(', ')} FROM usage_ledger ${where} ORDER BY seq ${direction} LIMIT ?`;
  params.push(query.limit + 1);
  return { sql, params };
}

/** Turns one raw `usage_ledger` row (as `buildListCallsQuery`'s column list returns it) into a `CallRecord`,
 * reusing `dbRowToLedgerRowInput` (#65) instead of re-deriving the column mapping. */
export function sqliteRowToCallRecord(row: Record<string, unknown>): CallRecord {
  const ledgerRow: UsageLedgerRow = { ...dbRowToLedgerRowInput(row), seq: Number(row.seq) };
  return toCallRecord(ledgerRow);
}

// -------------------------------------------------------------
// Cursor (issue #67, section 4)
// -------------------------------------------------------------

export const CURSOR_MAX_LENGTH = 512;

export interface DecodedCursor {
  v: 1;
  /** Store epoch: a persistent random id for SQLite, a per-process one for memory mode. */
  e: string;
  /** Keyset position on `seq`. */
  s: number;
  /** Order the cursor was issued for. */
  o: 'desc' | 'asc';
  /** First 16 hex chars of SHA-256 over the canonical filter set. */
  f: string;
}

/** Canonical JSON of the filter set a cursor is bound to: sorted keys, sorted values within each repeatable
 * key. Excludes `limit`, `cursor`, `order` (carried separately as `o`), `token` and `api_key` (never filters to
 * begin with), per the issue's own list. */
function canonicalFilterJson(filters: UsageFilters): string {
  const canonical = {
    agentId: [...filters.agentId].sort(),
    costSource: [...filters.costSource].sort(),
    currency: [...filters.currency].sort(),
    from: filters.from,
    model: [...filters.model].sort(),
    provider: [...filters.provider].sort(),
    requestId: [...filters.requestId].sort(),
    runtimeId: [...filters.runtimeId].sort(),
    sessionId: [...filters.sessionId].sort(),
    status: [...filters.status].sort(),
    taskId: [...filters.taskId].sort(),
    timeBasis: filters.timeBasis,
    to: filters.to,
    traceId: filters.traceId,
  };
  return JSON.stringify(canonical, Object.keys(canonical).sort());
}

export function filterHash(filters: UsageFilters): string {
  return crypto.createHash('sha256').update(canonicalFilterJson(filters)).digest('hex').slice(0, 16);
}

export function encodeCursor(cursor: DecodedCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export type DecodeCursorResult = { ok: true; cursor: DecodedCursor } | { ok: false };

export function decodeCursor(raw: string): DecodeCursorResult {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > CURSOR_MAX_LENGTH) return { ok: false };
  let json: string;
  try {
    json = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return { ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false };
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) return { ok: false };
  if (typeof p.e !== 'string' || p.e.length === 0) return { ok: false };
  if (typeof p.s !== 'number' || !Number.isInteger(p.s)) return { ok: false };
  if (p.o !== 'desc' && p.o !== 'asc') return { ok: false };
  if (typeof p.f !== 'string' || p.f.length !== 16) return { ok: false };
  return { ok: true, cursor: { v: 1, e: p.e, s: p.s, o: p.o, f: p.f } };
}
