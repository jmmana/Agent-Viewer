/**
 * Shared types for the usage ledger read APIs: the per-call list (`GET /api/v1/usage/calls`, issue #67, which
 * merged first and so is the module's original owner) and the rollup endpoint (`GET /api/v1/usage/rollup`,
 * issue #66, which extends it). Everything here is derived from the ledger shipped by issue #65
 * (`server/usageLedger.ts`), never re-derived from `events`.
 *
 * `UsageFilters` is shared so an identical filter query string selects the identical row set on both routes;
 * `parseUsageFilters` (`server/usage/filters.ts`) is the one parser for both. Fields marked "calls-only" or
 * "rollup-only" below are always present (so one object shape serves both routes) but only ever populated when
 * `parseUsageFilters` is called with the matching option; the other route's own parser call always leaves them
 * at their empty default, and its own handler never reads them.
 *
 * Two deliberate deviations from issue #67's literal `CallRecord` table, both forced by what #65 actually
 * stored (mirroring how `server/usageLedger.ts` itself documents its own deviations from #65's literal text):
 *
 * 1. `source` (the envelope's `source` identifier) is listed in the issue's table, but `usage_ledger` has no
 *    `source` column (`UsageLedgerRow`, #65). Adding it here would mean joining back to `events`, which section
 *    1 of the issue forbids outright ("never a join to `events.event_json` or `summary`") and which would also
 *    make the field vanish for a row whose source event was pruned by retention (#70), defeating the ledger's
 *    whole point of outliving the event it was built from. `source` is omitted from `CallRecord`.
 * 2. The issue's `trace` object is `{ traceId, spanId, parentId, toolCallId }`. #65 never added a `spanId`
 *    column: issue #64 (which #65 consumed) shipped `traceId`, `parentId`, `toolCallId`, `meetingId`, `userId`,
 *    `tags` instead, and `usageLedger.ts` stores `meetingId` in the column the original proposal called
 *    `span_id`. This module's `trace` carries `meetingId` in place of the nonexistent `spanId`; `userId` and
 *    `tags` are promoted to top-level `CallRecord` fields, matching the issue's own "#64 attribution fields"
 *    row in the same table.
 *
 * `errorCode`: #65 never stored the provider's own error code (`payload.providerErrorCode` is dropped by
 * `toLedgerRow`, on purpose, since it is free-ish provider text that could echo request content). The only
 * machine-readable failure classification the ledger keeps is `errorKind` (one of `LLM_ERROR_KINDS`), which is
 * what `errorCode` is sourced from here. It already always matches the short-code regex the issue specifies
 * (`^[A-Za-z0-9_.:-]{1,64}$`); the regex check is kept anyway as defense in depth, per the issue's own rule, in
 * case a future ledger column ever carries a less constrained value.
 */
import type { LedgerEventType, CostSource } from '../usageLedger';
import { LLM_ERROR_KINDS, type LlmErrorKind } from '../../src/integrations/canonicalTypes';

export type { CostSource } from '../usageLedger';

/** `'ok'` for a successful `llm.usage` row, otherwise the `llm.failed` row's `errorKind` (issue #46's enum). */
export type CallStatus = 'ok' | LlmErrorKind;

export const CALL_STATUSES: readonly CallStatus[] = ['ok', ...LLM_ERROR_KINDS];

export function isCallStatus(value: unknown): value is CallStatus {
  return typeof value === 'string' && (CALL_STATUSES as readonly string[]).includes(value);
}

export const COST_SOURCES: readonly CostSource[] = ['provider-reported', 'estimated', 'unknown'];

export function isCostSource(value: unknown): value is CostSource {
  return typeof value === 'string' && (COST_SOURCES as readonly string[]).includes(value);
}

export interface CallTokenFigures {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
}

export interface CallTrace {
  traceId: string | null;
  parentId: string | null;
  toolCallId: string | null;
  /** In place of the issue's `spanId`, which #65 never stored. See the module doc comment above. */
  meetingId: string | null;
}

/**
 * One ledger row, metadata only (issue #67). The serializer (`toCallRecord` in `server/usage/calls.ts`) is an
 * explicit allow-list: every field returned here is enumerated, so a new `usage_ledger` column never leaks
 * through this type until someone adds it here, to the serializer and to the key-set test.
 */
export interface CallRecord {
  seq: number;
  eventId: string;
  type: LedgerEventType;
  status: CallStatus;
  backfilled: boolean;
  occurredAt: number;
  receivedAt: number;
  agentId: string | null;
  sessionId: string | null;
  runtimeId: string | null;
  taskId: string | null;
  provider: string | null;
  model: string | null;
  tokens: CallTokenFigures;
  latencyMs: number | null;
  requestId: string | null;
  cost: number | null;
  currency: string | null;
  costSource: CostSource;
  errorCode: string | null;
  trace: CallTrace;
  userId: string | null;
  tags: string[];
}

/** `'received'` (server receive time, #65) is the default so an audit never depends on a client clock. */
export type TimeBasis = 'received' | 'occurred';

/**
 * The query shape shared by the calls endpoint (#67) and the rollup endpoint (#66): same filters, same AND
 * across keys / OR within a repeated key semantics, enforced identically in SQL and in memory.
 * `requestId`/`traceId` are calls-only (section 2 of issue #67): populated only when `parseUsageFilters` is
 * called with `allowCallsOnly: true`. `userId`/`tag`/`asOfSeq`/`utcOffsetMinutes` are rollup-only (issue #66):
 * populated only with `allowRollupOnly: true`. `parseUsageFilters` rejects a calls-only or rollup-only
 * parameter as unknown when the matching option is not set, so a rollup query can never smuggle in `requestId`
 * and a calls query can never smuggle in `tag`.
 */
export interface UsageFilters {
  /** Half-open window lower bound, epoch ms, inclusive. `null` means unbounded. */
  from: number | null;
  /** Half-open window upper bound, epoch ms, exclusive. `null` means unbounded. */
  to: number | null;
  timeBasis: TimeBasis;
  agentId: string[];
  sessionId: string[];
  runtimeId: string[];
  taskId: string[];
  provider: string[];
  model: string[];
  status: CallStatus[];
  costSource: CostSource[];
  /** Uppercase ISO 4217 codes, plus the literal `'none'` meaning "no currency" (`currency IS NULL`). */
  currency: string[];
  /** Calls-only. Exact match on the provider request id. */
  requestId: string[];
  /** Calls-only. Exact match on `traceId`; not repeatable (one trace per query). */
  traceId: string | null;
  /** Rollup-only (issue #66). Exact match on the ledger's `user_id`. */
  userId: string[];
  /** Rollup-only (issue #66). A row matches when it has any of the given tags (OR, never a dimension filter on
   * its own commas). */
  tag: string[];
  /** Rollup-only (issue #66). Only rows with ledger `seq <= asOfSeq`. `null` means the current end of the ledger. */
  asOfSeq: number | null;
  /** Rollup-only (issue #66). -720..840, fixed offset (no DST), used for `day` bucketing. `0` when not given. */
  utcOffsetMinutes: number;
  /** Export-only (issue #69). Only rows with ledger `seq > afterSeq`, for incremental pulls ("everything since my
   * last pull"). Never populated by `parseUsageFilters` (no route echoes it as a rollup query parameter): the
   * export route (`server/usage/export.ts`) parses its own `afterSeq`/`asOfSeq` pair and sets this directly, so
   * the export's totals sidecar can pin the same `(afterSeq, asOfSeq]` window by calling straight into the #66
   * rollup aggregation (`computeMemoryRollup`/`computeSqliteRollup`) instead of summing a second time. `null`
   * means no lower bound. */
  afterSeq: number | null;
}

export function emptyUsageFilters(): UsageFilters {
  return {
    from: null,
    to: null,
    timeBasis: 'received',
    agentId: [],
    sessionId: [],
    runtimeId: [],
    taskId: [],
    provider: [],
    model: [],
    status: [],
    costSource: [],
    currency: [],
    requestId: [],
    traceId: null,
    userId: [],
    tag: [],
    asOfSeq: null,
    utcOffsetMinutes: 0,
    afterSeq: null,
  };
}

/** Echoes `UsageFilters` back as the flat `Record<string, string[]>` the rollup response's `query.filters`
 * field uses: only the keys that were actually supplied. Calls-only fields are never echoed by the rollup
 * route, since `parseUsageFilters` never populates them there. */
export function filtersToEcho(filters: UsageFilters): Record<string, string[]> {
  const echo: Record<string, string[]> = {};
  const repeatable: Array<[string, string[]]> = [
    ['agentId', filters.agentId],
    ['model', filters.model],
    ['provider', filters.provider],
    ['sessionId', filters.sessionId],
    ['taskId', filters.taskId],
    ['runtimeId', filters.runtimeId],
    ['userId', filters.userId],
    ['tag', filters.tag],
    ['status', filters.status],
    ['costSource', filters.costSource],
    ['currency', filters.currency],
  ];
  for (const [key, values] of repeatable) {
    if (values.length > 0) echo[key] = values;
  }
  return echo;
}

// -------------------------------------------------------------
// Rollup-specific types (issue #66). Pure additions: nothing above this point is changed by this endpoint.
// -------------------------------------------------------------

export type RollupDimension = 'agent' | 'model' | 'provider' | 'session' | 'task' | 'day' | 'user' | 'tag';

export const ROLLUP_DIMENSIONS: readonly RollupDimension[] = [
  'agent',
  'model',
  'provider',
  'session',
  'task',
  'day',
  'user',
  'tag',
];

export type RollupSort = 'key' | 'calls';

export interface TokenKindRollup {
  sum: number | null;
  reportedCalls: number;
  unreportedCalls: number;
}

export interface CostEntry {
  currency: string | null;
  costSource: CostSource;
  sum: number;
  calls: number;
}

export type TokenKind = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning';

export const TOKEN_KINDS: readonly TokenKind[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

export interface UsageRollupTotals {
  calls: { total: number; succeeded: number; failed: number };
  tokens: Record<TokenKind, TokenKindRollup>;
  cost: { entries: CostEntry[]; unknownCostCalls: number };
  /** On the selected time basis. */
  firstAt: number | null;
  lastAt: number | null;
}

export interface UsageRollupGroup extends UsageRollupTotals {
  key: Partial<Record<RollupDimension, string | null>>;
  /** Only present when `groupBy` includes `day`: epoch ms, inclusive, the local midnight expressed in UTC. */
  bucketStart?: number;
  /** Only present when `groupBy` includes `day`: epoch ms, exclusive, `bucketStart + 86400000`. */
  bucketEnd?: number;
}

export interface UsageRollupQueryEcho {
  groupBy: RollupDimension[];
  timeBasis: TimeBasis;
  from: number | null;
  to: number | null;
  utcOffsetMinutes: number;
  filters: Record<string, string[]>;
  asOfSeq: number | null;
  sort: RollupSort;
  limit: number;
}

export interface UsageRollupAsOf {
  /** Highest ledger `seq` included: the lower of a supplied `asOfSeq` and the current max. `null` for an empty
   * ledger. */
  ledgerSeq: number | null;
  /** `received_at` of that row; `null` if it no longer exists (for example after retention purges it). */
  lastRowReceivedAt: number | null;
  generatedAt: number;
}

export interface UsageRollupCoverage {
  storage: 'memory' | 'sqlite';
  /** `false` when rows that could belong to the query may be gone (memory-mode cap, or retention purge reaching
   * the query range). Never silently partial: when `false`, the figure may be incomplete. */
  complete: boolean;
  /** Memory mode only: ledger rows this process could not keep (upper bound, not an exact per-query count). */
  droppedRows: number;
  /** Highest `received_at` any retention run (issue #70) has purged the usage ledger through. `null` until the
   * first run that actually reaches a row. */
  purgedThrough: number | null;
  backfilledRows: number;
  legacyContractRows: number;
}

export interface UsageRollupResponse {
  schemaVersion: '1.0';
  query: UsageRollupQueryEcho;
  asOf: UsageRollupAsOf;
  coverage: UsageRollupCoverage;
  /** `false` only when `groupBy` includes `tag` (a row with 2 tags counts in 2 groups; `totals` still counts it
   * once). */
  groupsAreAdditive: boolean;
  /** Number of groups before `limit` was applied. */
  groupCount: number;
  truncated: boolean;
  groups: UsageRollupGroup[];
  totals: UsageRollupTotals;
}

/** A fully parsed, validated rollup request: `UsageFilters` plus the rollup-only `groupBy`/`sort`/`limit` (kept
 * out of the shared `UsageFilters`/`parseUsageFilters` on purpose: `limit` already means something different,
 * and with a different valid range, for the calls endpoint's pagination). */
export interface RollupQuery {
  groupBy: RollupDimension[];
  filters: UsageFilters;
  sort: RollupSort;
  limit: number;
}
