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
import type { MeetingAttributionState, ToolAttributionState } from './attribution';
import type { ReliabilityFailures, ReliabilityLatency } from './reliability';
import { ESTIMATE_STATUSES, type EstimateStatus } from '../pricing/estimate';

export type { CostSource } from '../usageLedger';

// -------------------------------------------------------------
// Estimate exposure (issue #295, sub-issue of #84): the ledger's own ingestion-time cost estimate
// (`server/pricing/estimate.ts`), surfaced on calls/export rows and summarized on the rollup. Never the reported
// `cost` above: these are a separate fact, computed from a price table, never merged with what the runtime or
// provider reported.
// -------------------------------------------------------------

/** `estimateStatus` as exposed over the API: every real `EstimateStatus` plus the virtual `not_estimated`, for a
 * row written before migration `usage-ledger-estimates` (issue #84), whose five estimate columns are `NULL`
 * (`usage_ledger` is append-only and can never be backfilled in place). `UsageLedgerRow.estimateStatus === null`
 * is exactly this case; `toCallRecord`/`toExportCallRecord` map it to this virtual status, never to `null`. */
export type CallEstimateStatus = EstimateStatus | 'not_estimated';

export const CALL_ESTIMATE_STATUSES: readonly CallEstimateStatus[] = [...ESTIMATE_STATUSES, 'not_estimated'];

export function isCallEstimateStatus(value: unknown): value is CallEstimateStatus {
  return typeof value === 'string' && (CALL_ESTIMATE_STATUSES as readonly string[]).includes(value);
}

/** Which revision of each row's estimate a request reads (issue #295's own text, mirroring #84's "Estimate
 * basis" section). Only revision 0 (the ingestion-time figure) exists until the recompute endpoint (the other
 * #84 sub-issue) ships, so every mode resolves to the same data today; the parameter is still accepted and
 * validated now so the contract never needs to change once recompute lands. `asOfRevision` is the mode selected
 * by `estimateRevision=N`; `latest` and `original` are selected by `estimates=latest`/`estimates=original`
 * (`latest` is the default when neither parameter is given). */
export type EstimateBasisMode = 'latest' | 'original' | 'asOfRevision';

/** Echoed on every calls/rollup/export response (issue #295): which basis was requested, and which revisions it
 * actually drew from. `revisionsUsed` is always `[0]` today (see `EstimateBasisMode`'s doc comment above). */
export interface EstimateBasis {
  mode: EstimateBasisMode;
  /** The `N` of `estimateRevision=N`; `null` for `latest`/`original`. */
  revision: number | null;
  revisionsUsed: number[];
}

export function defaultEstimateBasis(): EstimateBasis {
  return { mode: 'latest', revision: null, revisionsUsed: [0] };
}

/** The eight fields issue #295 appends to every calls row and every export row, in this fixed order, always
 * after every pre-existing field. `estimatedCostSource` is the constant `'estimated'` when `estimatedCost` is
 * not `null`, and `null` otherwise (issue #84's own rule: it exists only so a client can never confuse it with
 * the reported `costSource`). `estimateRevision` is always `0` until the recompute endpoint ships (see
 * `EstimateBasisMode`). */
export interface CallEstimateFields {
  estimatedCost: number | null;
  estimatedCostNano: number | null;
  estimatedCurrency: string | null;
  estimatedCostSource: 'estimated' | null;
  pricingVersion: number | null;
  estimateStatus: CallEstimateStatus;
  estimateRevision: number;
  estimatedAt: number | null;
}

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
export interface CallRecord extends CallEstimateFields {
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
  /** Rollup-only (issue #80). Row-level equality filter on the ledger's `meeting_id`, independent of `groupBy`. */
  meetingId: string[];
  /** Rollup-only (issue #80). Row-level equality filter on the ledger's `tool_call_id`, independent of `groupBy`. */
  toolCallId: string[];
  /** Rollup-only (issue #80). Row-level equality filter on the *resolved* tool name: matches only rows whose
   * `tool` attribution is `attributed` with this name (an `unresolved`/`ambiguous`/`unattributed` row never has a
   * name to match). */
  tool: string[];
  /** Rollup-only (issue #80). Row-level equality filter on the row's `meeting` attribution state. */
  meetingAttribution: MeetingAttributionState[];
  /** Rollup-only (issue #80). Row-level equality filter on the row's `tool` attribution state. */
  toolAttribution: ToolAttributionState[];
  /** Export-only (issue #69). Only rows with ledger `seq > afterSeq`, for incremental pulls ("everything since my
   * last pull"). Never populated by `parseUsageFilters` (no route echoes it as a rollup query parameter): the
   * export route (`server/usage/export.ts`) parses its own `afterSeq`/`asOfSeq` pair and sets this directly, so
   * the export's totals sidecar can pin the same `(afterSeq, asOfSeq]` window by calling straight into the #66
   * rollup aggregation (`computeMemoryRollup`/`computeSqliteRollup`) instead of summing a second time. `null`
   * means no lower bound. */
  afterSeq: number | null;
  /** Issue #295. Shared by calls, rollup and export (`estimates=latest|original`, `estimateRevision=N`): never
   * filters which rows match (every row always has at most one estimate, revision 0, today), only which
   * revision each row's estimate fields are read from and what `estimateBasis` echoes back. Kept out of the
   * calls cursor's filter hash on purpose, for the same reason: it never changes the matching row set. */
  estimateBasis: EstimateBasis;
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
    meetingId: [],
    toolCallId: [],
    tool: [],
    meetingAttribution: [],
    toolAttribution: [],
    afterSeq: null,
    estimateBasis: defaultEstimateBasis(),
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
    ['meetingId', filters.meetingId],
    ['toolCallId', filters.toolCallId],
    ['tool', filters.tool],
    ['meetingAttribution', filters.meetingAttribution],
    ['toolAttribution', filters.toolAttribution],
  ];
  for (const [key, values] of repeatable) {
    if (values.length > 0) echo[key] = values;
  }
  return echo;
}

// -------------------------------------------------------------
// Rollup-specific types (issue #66). Pure additions: nothing above this point is changed by this endpoint.
// -------------------------------------------------------------

export type RollupDimension =
  | 'agent'
  | 'model'
  | 'provider'
  | 'session'
  | 'task'
  | 'day'
  | 'user'
  | 'tag'
  | 'meeting'
  | 'tool';

export const ROLLUP_DIMENSIONS: readonly RollupDimension[] = [
  'agent',
  'model',
  'provider',
  'session',
  'task',
  'day',
  'user',
  'tag',
  'meeting',
  'tool',
];

/** `meeting` and `tool` are the two "attribution" dimensions added by issue #80: unlike every other dimension,
 * a row that cannot be grouped is kept (never dropped) in an explicit `unattributed`/`unresolved`/`ambiguous`
 * bucket, and groups sort by attribution rank before anything else. */
export const ATTRIBUTION_DIMENSIONS: readonly RollupDimension[] = ['meeting', 'tool'];

export function isAttributionDimension(dim: RollupDimension): dim is 'meeting' | 'tool' {
  return dim === 'meeting' || dim === 'tool';
}

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

/** One currency's summed estimate (issue #295), only ever built from rows whose `estimateStatus === 'estimated'`
 * (an unestimable row never contributes a `0`; it is counted in `estimatedUnknownCalls` instead). Never converted
 * and never merged across currencies, mirroring `CostEntry` above. `pricingVersions` lists every distinct
 * `pricingVersion` that contributed, ascending; today that is always `[1]`-shaped (a single version), since no
 * recompute has ever run. */
export interface EstimatedCostEntry {
  currency: string;
  cost: number;
  calls: number;
  pricingVersions: number[];
}

/** Reported vs. estimated for rows that have *both*, in the *same* currency (issue #295). A row with a reported
 * cost in one currency and an estimate in another contributes to neither sum and is counted in neither `calls`:
 * never converted, never zero-filled. `delta = estimatedCost - reportedCost`. */
export interface ComparableEntry {
  currency: string;
  calls: number;
  reportedCost: number;
  estimatedCost: number;
  delta: number;
}

export type TokenKind = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning';

export const TOKEN_KINDS: readonly TokenKind[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

export interface UsageRollupTotals {
  calls: { total: number; succeeded: number; failed: number };
  tokens: Record<TokenKind, TokenKindRollup>;
  cost: { entries: CostEntry[]; unknownCostCalls: number };
  /** Issue #295: the ledger's own cost estimate, summed per currency, alongside `cost` above. Never added to it
   * and never converted. */
  estimated: EstimatedCostEntry[];
  /** Issue #295: calls whose `estimateStatus` is anything other than `'estimated'` (including the virtual
   * `not_estimated`), counted here instead of folded into `estimated` as a `0`. */
  estimatedUnknownCalls: number;
  /** Issue #295: `estimatedUnknownCalls`, broken down by `CallEstimateStatus`. Keys with a `0` count are omitted. */
  estimatedUnknownByStatus: Partial<Record<CallEstimateStatus, number>>;
  /** Issue #295: `true` only when `estimatedUnknownCalls` is `0` (every call in scope has an estimate). */
  estimatedComplete: boolean;
  /** Issue #295: reported vs. estimated, same-currency rows only. See `ComparableEntry`'s own doc comment. */
  comparable: ComparableEntry[];
  /** On the selected time basis. */
  firstAt: number | null;
  lastAt: number | null;
  /** Issue #89: present only when the request's `include` contains `failures`. Omitting `include` (or omitting
   * just `failures` from it) must reproduce byte-for-byte the response this endpoint returned before this issue,
   * so these fields are optional and simply absent, never `null`, when not requested. `failedCalls` duplicates
   * `calls.failed` (kept as its own top-level field because that is the literal shape the issue's API asks for). */
  failedCalls?: number;
  /** `calls.succeeded + failedCalls`. */
  attempts?: number;
  /** Unrounded; `null` only when `attempts` is `0` (never a false `0`). */
  failureRate?: number | null;
  failures?: ReliabilityFailures;
  /** Issue #89: present only when `include` contains `latency`. See `failedCalls` above for the same
   * byte-for-byte-unchanged-when-absent rule. */
  latency?: ReliabilityLatency;
}

/**
 * A group's key. For every dimension except `meeting` it is `{ [dimensionName]: value }` (`value` is `null` for
 * the no-value bucket of that dimension). `meeting` is the one exception (issue #80): its key field is named
 * `meetingId`, not `meeting`, and carries a second field, `title`, only when `meetingId` is non-null (matching
 * the issue's own response examples). The type is intentionally a plain string-keyed record rather than
 * `Partial<Record<RollupDimension, ...>>` so it can hold `meetingId`/`title` alongside the dimension-named keys.
 */
export type RollupGroupKey = Record<string, string | null>;

export interface UsageRollupGroup extends UsageRollupTotals {
  key: RollupGroupKey;
  /** Only present when `groupBy` includes `day`: epoch ms, inclusive, the local midnight expressed in UTC. */
  bucketStart?: number;
  /** Only present when `groupBy` includes `day`: epoch ms, exclusive, `bucketStart + 86400000`. */
  bucketEnd?: number;
  /** Present when `groupBy` includes `meeting` and/or `tool` (issue #80): one entry per attribution dimension
   * actually present in `groupBy`, always an object, never a bare string. */
  attribution?: Partial<Record<'meeting' | 'tool', MeetingAttributionState | ToolAttributionState>>;
  /** Present only when `groupBy` includes `meeting`: distinct session ids that contributed to this group,
   * sorted, capped at `SESSION_IDS_CAP` (issue #80). */
  sessionIds?: string[];
  /** Present only when `groupBy` includes `meeting`: the true distinct session count, uncapped, so a cap (or a
   * `meetingId` reused across sessions) is visible even when `sessionIds` itself was truncated. */
  sessionCount?: number;
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
  /** Issue #295: which estimate revision this whole response was computed from. See `EstimateBasis`'s own doc
   * comment. */
  estimateBasis: EstimateBasis;
  /** `false` only when `groupBy` includes `tag` (a row with 2 tags counts in 2 groups; `totals` still counts it
   * once). */
  groupsAreAdditive: boolean;
  /** Number of groups before `limit` was applied. */
  groupCount: number;
  truncated: boolean;
  groups: UsageRollupGroup[];
  totals: UsageRollupTotals;
}

/** Issue #89's opt-in extension to the rollup response: `latency` (p50/p95/samples/missing) and/or `failures`
 * (failedCalls/attempts/failureRate/byErrorKind/rateLimitCount). */
export type RollupInclude = 'latency' | 'failures';

export const ROLLUP_INCLUDE_VALUES: readonly RollupInclude[] = ['latency', 'failures'];

export function isRollupInclude(value: unknown): value is RollupInclude {
  return typeof value === 'string' && (ROLLUP_INCLUDE_VALUES as readonly string[]).includes(value);
}

/** A fully parsed, validated rollup request: `UsageFilters` plus the rollup-only `groupBy`/`sort`/`limit`/`include`
 * (kept out of the shared `UsageFilters`/`parseUsageFilters` on purpose: `limit` already means something
 * different, and with a different valid range, for the calls endpoint's pagination; `include` is rollup-only by
 * definition). */
export interface RollupQuery {
  groupBy: RollupDimension[];
  filters: UsageFilters;
  sort: RollupSort;
  limit: number;
  /** Issue #89. Empty (the default, when the `include` parameter is absent) means the response this endpoint
   * returned before this issue, byte-for-byte unchanged. */
  include: RollupInclude[];
}
