/**
 * `@warlockcode/agent-viewer-sdk`: a minimal client for sending canonical events to Agent Viewer from any
 * Node runtime. No framework, no React, no `zod`, no import of anything under `src/integrations/*`,
 * `server/*` or `src/lib/*` (issue #343): every structural type below is copied from the root contract and
 * server modules, not imported, so the published `.d.ts` references no file outside this package.
 *
 * `tests/types/sdk-package-canonical-event.ts` asserts that this file's `CanonicalEvent` stays assignable to
 * `src/integrations/canonicalTypes.ts`'s `CanonicalEvent`, so the two copies cannot silently drift apart.
 * `sdk/typescript/index.ts` re-exports everything in this file unchanged, so existing SDK consumers see no
 * behavior change.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

// =====================================================================================
// Structural types copied from the root contract and server modules (never imported).
// =====================================================================================

// ---- Canonical event contract V1 (mirrors src/integrations/canonicalTypes.ts) ----

export type CanonicalEventType =
  | 'agent.registered'
  | 'agent.updated'
  | 'agent.status.changed'
  | 'agent.message.sent'
  | 'task.created'
  | 'task.assigned'
  | 'task.progress'
  | 'task.completed'
  | 'task.failed'
  | 'task.blocked'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'meeting.requested'
  | 'meeting.started'
  | 'meeting.message'
  | 'meeting.ended'
  | 'meeting.cancelled'
  | 'llm.usage'
  | 'llm.failed'
  | 'runtime.connected'
  | 'runtime.disconnected'
  | 'runtime.heartbeat'
  /** Server-generated only (issue #86): a budget crossed into `warning` or `exceeded`. */
  | 'budget.alert';

export type EventSeverity = 'low' | 'normal' | 'high' | 'critical';

/** Why a model call failed, carried by `llm.failed`. Mirrors `LLM_ERROR_KINDS`. */
export type LlmErrorKind =
  | 'rate_limited'
  | 'overloaded'
  | 'timeout'
  | 'invalid_request'
  | 'auth'
  | 'server_error'
  | 'cancelled'
  | 'network'
  | 'unknown';

/** Issue #109: why a chained event's content was removed. */
export type TombstoneReason = 'retention' | 'redaction';

/** Issue #109: present only on an event whose content the server removed. */
export interface TombstoneInfo {
  at: number;
  reason: TombstoneReason;
  auditEventId: string;
  rulesVersion: string | null;
  contentHash: string | null;
}

export interface CanonicalEvent<T = Record<string, any>> {
  schemaVersion: '1.0';
  id: string;
  type: CanonicalEventType;
  timestamp: number;
  runtimeId?: string;
  sessionId?: string;
  source: string;
  agentId?: string;
  taskId?: string;
  severity: EventSeverity;
  summary: string;
  payload: T;
  /** Issue #109: server-assigned, never accepted from a client. */
  tombstone?: TombstoneInfo;
  /** Issue #109: server-assigned, never accepted from a client. */
  redactionRulesVersion?: string;
}

// ---- Usage/tool payload shapes (mirror canonicalContract.ts's z.input types) ----

/** Where a reported cost comes from. The SDK never chooses it for the caller. */
export type CostSource = 'provider-reported' | 'estimated' | 'unknown';

const COST_SOURCES: readonly CostSource[] = ['provider-reported', 'estimated', 'unknown'];

/** Shape accepted by `LlmUsagePayloadSchema` before its defaults and transform run (its `z.input`). */
export interface LlmUsagePayloadInput {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  /** @deprecated Use cacheReadTokens. */
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  latencyMs?: number | null;
  requestId?: string | null;
  cost?: number | null;
  costSource?: CostSource | null;
  currency?: string | null;
  traceId?: string | null;
  parentId?: string | null;
  toolCallId?: string | null;
  meetingId?: string | null;
  userId?: string | null;
  tags?: readonly string[] | null;
}

/** Shape accepted by `LlmFailedPayloadSchema` before its defaults and transform run (its `z.input`). */
export interface LlmFailedPayloadInput {
  provider: string;
  model?: string | null;
  errorKind?: LlmErrorKind;
  httpStatus?: number | null;
  retryable?: boolean | null;
  requestId?: string | null;
  providerErrorCode?: string | null;
  attempts?: number | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  cost?: number | null;
  costSource?: CostSource | null;
  currency?: string | null;
  traceId?: string | null;
  parentId?: string | null;
  toolCallId?: string | null;
  meetingId?: string | null;
  userId?: string | null;
  tags?: readonly string[] | null;
}

// ---- Runtime/session/agent records (mirror server/serverState.ts) ----

export interface RuntimeRecord {
  id: string;
  name?: string;
  framework?: string;
  version?: string;
  metadata?: Record<string, any>;
  status: 'active' | 'idle' | 'disconnected';
  firstSeenAt: number;
  lastSeenAt: number;
  eventsCount: number;
}

export interface SessionRecord {
  id: string;
  runtimeId?: string;
  name?: string;
  createdAt: number;
  lastActiveAt: number;
  status: 'active' | 'completed' | 'archived';
  eventsCount: number;
}

export interface AgentRecord {
  id: string;
  name: string;
  roleTitle?: string;
  role?: string;
  provider?: string;
  model?: string;
  status: string;
  statusText?: string;
  workspace?: string;
  /** @deprecated Use the usage summary. */
  tokensInput: number;
  /** @deprecated Use the usage summary. */
  tokensOutput: number;
  /** @deprecated Use the usage summary. */
  cachedTokens: number;
  /** @deprecated Use the usage summary. */
  reasoningTokens: number;
  /** @deprecated Use the usage summary. */
  cost: number | null;
  lastSeenAt: number;
}

// ---- Usage aggregates (mirror server/usageAggregates.ts) ----

export type TokenKind = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning';

export interface TokenFigure {
  sum: number | null;
  unreportedCount: number;
}

export interface CurrencyCost {
  currency: string;
  costSource: CostSource;
  amount: number;
  amountExact: string;
  calls: number;
}

export interface UsageBucket {
  calls: number;
  tokens: Record<TokenKind, TokenFigure>;
  byCurrency: CurrencyCost[];
  costUnknownCount: number;
  costMissingCount: number;
  currencyMissingCount: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
}

export interface UsageAggregate extends UsageBucket {
  failed: UsageBucket;
}

export interface ModelUsage extends UsageAggregate {
  provider: string | null;
  model: string | null;
}

export interface AgentUsage extends UsageAggregate {
  agentId: string | null;
  byModel: ModelUsage[];
}

export interface UsageSummary {
  schemaVersion: '1.0';
  eventsReduced: number;
  total: UsageAggregate;
  byModel: ModelUsage[];
  byAgent: AgentUsage[];
}

// ---- Snapshot (mirror server/store.ts) ----

export interface UsageDuplicateStats {
  count: number;
  mismatched: number;
  unverified: number;
}

export interface SnapshotRetention {
  storage: 'memory' | 'sqlite';
  maxEvents: number | null;
  retainedEvents: number;
  acceptedEvents: number;
  droppedEvents: number;
  since: number | null;
  totalsSince: number;
}

export interface ViewerSnapshot {
  schemaVersion: '1.0';
  timestamp: number;
  lastEventId: string | null;
  runtimes: RuntimeRecord[];
  sessions: SessionRecord[];
  agents: AgentRecord[];
  activeTasks: any[];
  activeMeetings: any[];
  usage: UsageSummary;
  usageDuplicates: UsageDuplicateStats;
  /** @deprecated Use usage.total.tokens. */
  totalTokens: { input: number; output: number; cached: number; reasoning: number };
  /** @deprecated Use usage.total.byCurrency. */
  totalCost: number | null;
  eventsCount: number;
  events: CanonicalEvent[];
  retention: SnapshotRetention;
}

// ---- Usage ledger calls (mirror server/usage/types.ts and its own dependencies) ----

export type LedgerEventType = 'llm.usage' | 'llm.failed';

export type EstimateStatus =
  | 'estimated'
  | 'no_price_in_force'
  | 'no_price_for_model'
  | 'no_price_for_component'
  | 'missing_usage'
  | 'inconsistent_usage'
  | 'failed';

export type CallEstimateStatus = EstimateStatus | 'not_estimated';

export type EstimateBasisMode = 'latest' | 'original' | 'asOfRevision';

export interface EstimateBasis {
  mode: EstimateBasisMode;
  revision: number | null;
  revisionsUsed: number[];
}

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

export type CallStatus = 'ok' | LlmErrorKind;

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
  meetingId: string | null;
}

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

export type TimeBasis = 'received' | 'occurred';

// ---- Usage rollup (mirror server/usage/types.ts's rollup section and its dependencies) ----

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

export interface EstimatedCostEntry {
  currency: string;
  cost: number;
  calls: number;
  pricingVersions: number[];
}

export interface ComparableEntry {
  currency: string;
  calls: number;
  reportedCost: number;
  estimatedCost: number;
  delta: number;
}

/** Mirrors server/usage/reliability.ts. */
export type ReliabilityMethod = 'nearest-rank';

export interface ReliabilityLatency {
  p50Ms: number | null;
  p95Ms: number | null;
  samples: number;
  missing: number;
  method: ReliabilityMethod;
}

export interface ReliabilityFailures {
  byErrorKind: Record<string, number>;
  rateLimitCount: number;
}

/** Mirrors server/usage/attribution.ts. */
export type ToolAttributionState = 'attributed' | 'unattributed' | 'unresolved' | 'ambiguous';
export type MeetingAttributionState = 'attributed' | 'unattributed';

export interface UsageRollupTotals {
  calls: { total: number; succeeded: number; failed: number };
  tokens: Record<TokenKind, TokenKindRollup>;
  cost: { entries: CostEntry[]; unknownCostCalls: number };
  estimated: EstimatedCostEntry[];
  estimatedUnknownCalls: number;
  estimatedUnknownByStatus: Partial<Record<CallEstimateStatus, number>>;
  estimatedComplete: boolean;
  comparable: ComparableEntry[];
  firstAt: number | null;
  lastAt: number | null;
  failedCalls?: number;
  attempts?: number;
  failureRate?: number | null;
  failures?: ReliabilityFailures;
  latency?: ReliabilityLatency;
}

export type RollupGroupKey = Record<string, string | null>;

export interface UsageRollupGroup extends UsageRollupTotals {
  key: RollupGroupKey;
  bucketStart?: number;
  bucketEnd?: number;
  attribution?: Partial<Record<'meeting' | 'tool', MeetingAttributionState | ToolAttributionState>>;
  sessionIds?: string[];
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
  ledgerSeq: number | null;
  lastRowReceivedAt: number | null;
  generatedAt: number;
}

export interface UsageRollupCoverage {
  storage: 'memory' | 'sqlite';
  complete: boolean;
  droppedRows: number;
  purgedThrough: number | null;
  backfilledRows: number;
  legacyContractRows: number;
}

export interface UsageRollupResponse {
  schemaVersion: '1.0';
  query: UsageRollupQueryEcho;
  asOf: UsageRollupAsOf;
  coverage: UsageRollupCoverage;
  estimateBasis: EstimateBasis;
  groupsAreAdditive: boolean;
  groupCount: number;
  truncated: boolean;
  groups: UsageRollupGroup[];
  totals: UsageRollupTotals;
}

// ---- Budgets (mirror server/budgets.ts, issue #85) ----

export type BudgetScopeType = 'all' | 'agent' | 'model' | 'session' | 'user' | 'tag';
export type BudgetPeriod = 'day' | 'week' | 'month';
export type BudgetBasis = 'reported' | 'reported_plus_estimated';
export type BudgetState = 'ok' | 'warning' | 'exceeded' | 'unknown';
export type BudgetUnknownReason =
  | 'unknown_cost'
  | 'currency_mismatch'
  | 'missing_currency'
  | 'history_truncated'
  | 'evaluation_error';

export interface BudgetScope {
  type: BudgetScopeType;
  value: string | null;
}

export interface Budget {
  id: string;
  name: string;
  scope: BudgetScope;
  period: BudgetPeriod;
  timezone: string;
  currency: string;
  basis: BudgetBasis;
  limit: number;
  warningRatio: number;
  enabled: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** What the API returns for a budget. `status` is `null` exactly when `enabled` is `false`. */
export type BudgetView = Budget & { status: BudgetStatus | null };

export interface BudgetWindow {
  start: number;
  end: number;
}

export interface BudgetCallCounts {
  total: number;
  withCost: number;
  unknownCost: number;
  otherCurrency: number;
  missingCurrency: number;
}

export interface BudgetStatus {
  state: BudgetState;
  window: BudgetWindow;
  spent: number | null;
  spentComplete: boolean;
  knownSpent: number;
  breakdown: { reported: number; estimated: number };
  containsEstimates: boolean;
  limitRemaining: number | null;
  ratio: number | null;
  calls: BudgetCallCounts;
  unknownReasons: BudgetUnknownReason[];
  pricingVersions: number[];
  evaluatedAt: number;
}

// ---- UsageFigures (mirror src/lib/usage.ts) ----

export interface UsageFigures {
  totalTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  cost?: number | null;
  currency?: string | null;
  costSource?: CostSource | null;
  failedCalls?: number | null;
}

// =====================================================================================
// End of copied structural types. Everything below is the SDK logic itself.
// =====================================================================================

const UNSTATED_COST_SOURCE_WARNING =
  "[AgentViewer] a cost was reported without costSource, so it is sent as costSource: 'unknown'. "
  + "Pass costSource: 'provider-reported' or 'estimated' to state where the cost comes from.";

/** Turns `null` into `undefined`, so an unknown figure is left out of the JSON body. */
function omitNull<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

// -------------------------------------------------------------
// Usage correlation block (issue #64)
// -------------------------------------------------------------
//
// This SDK ships standalone and must not import the server contract at runtime. So the three limits and the
// whitespace rule are kept here as an explicit copy, and `tests/fixtures/usage-correlation-vectors.json` is
// the shared test-vector file that keeps this copy, the server contract and the Python SDK from drifting apart.

const CORRELATION_ID_MAX_LENGTH = 128;
const USAGE_TAGS_MAX = 20;
const USAGE_TAG_MAX_LENGTH = 64;

/** Same exact whitespace set as `String.prototype.trim` (`value !== value.trim()`); see canonicalContract.ts. */
const TRIMMABLE_WHITESPACE_CLASS =
  '\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF';
const LEADING_OR_TRAILING_WHITESPACE = new RegExp(`^[${TRIMMABLE_WHITESPACE_CLASS}]|[${TRIMMABLE_WHITESPACE_CLASS}]$`);
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/** Correlation and attribution fields shared by `usage()` and `llmFailed()`. All optional, never truncated. */
export interface UsageCorrelation {
  traceId?: string;
  parentId?: string;
  toolCallId?: string;
  meetingId?: string;
  userId?: string;
  tags?: readonly string[];
}

export interface ToolCallOptions {
  toolCallId?: string;
}

/**
 * Options for `toolCompleted()`/`toolFailed()`: the contract (`ToolCompletedPayloadSchema`,
 * `ToolFailedPayloadSchema`) accepts `durationMs` on those two only, not on `toolStarted()`, which has no
 * end time yet. The adapter (issue #99) measures it itself with a monotonic clock; the SDK never times a
 * call on its own.
 */
export interface ToolCallFinishOptions extends ToolCallOptions {
  durationMs?: number;
}

/**
 * Validates one correlation id field with the same rules as the server: 1 to 128 UTF-16 code units, no
 * control characters, no leading or trailing whitespace. Zod-style `.length` counting is avoided on
 * purpose, since some validators count Unicode code points instead of UTF-16 code units for astral
 * characters; `String.length` always counts UTF-16 code units, matching the server exactly.
 */
function validateCorrelationId(name: string, value: unknown, path: string, issues: Array<{ path: string; message: string }>): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    issues.push({ path, message: `${name} must be a string` });
    return;
  }
  if (value.length < 1) {
    issues.push({ path, message: `${name} must not be empty` });
  } else if (value.length > CORRELATION_ID_MAX_LENGTH) {
    issues.push({ path, message: `${name} must be at most ${CORRELATION_ID_MAX_LENGTH} characters` });
  } else if (CONTROL_CHARACTERS.test(value)) {
    issues.push({ path, message: `${name} must not contain control characters` });
  } else if (LEADING_OR_TRAILING_WHITESPACE.test(value)) {
    issues.push({ path, message: `${name} must not have leading or trailing whitespace` });
  }
}

function validateUsageTags(tags: unknown, path: string, issues: Array<{ path: string; message: string }>): void {
  if (tags === undefined || tags === null) return;
  if (typeof tags === 'string' || !Array.isArray(tags)) {
    issues.push({ path, message: 'tags must be an array of strings' });
    return;
  }
  if (tags.length > USAGE_TAGS_MAX) {
    issues.push({ path, message: `At most ${USAGE_TAGS_MAX} tags are allowed` });
  }
  tags.forEach((tag: unknown, index: number) => {
    const tagPath = `${path}.${index}`;
    if (typeof tag !== 'string') {
      issues.push({ path: tagPath, message: 'Each tag must be a string' });
      return;
    }
    if (tag.length < 1) {
      issues.push({ path: tagPath, message: 'Each tag must not be empty' });
    } else if (tag.length > USAGE_TAG_MAX_LENGTH) {
      issues.push({ path: tagPath, message: `Each tag must be at most ${USAGE_TAG_MAX_LENGTH} characters` });
    } else if (CONTROL_CHARACTERS.test(tag)) {
      issues.push({ path: tagPath, message: 'Each tag must not contain control characters' });
    } else if (LEADING_OR_TRAILING_WHITESPACE.test(tag)) {
      issues.push({ path: tagPath, message: 'Each tag must not have leading or trailing whitespace' });
    }
  });
}

/**
 * Validates the six correlation fields and throws `AgentViewerError` with the same `{ path, message }`
 * shape the server returns (`status` left `undefined`, since nothing was sent) when any is invalid. Never
 * truncates. Called before building the payload, so an invalid value never reaches the network.
 */
function validateUsageCorrelationOrThrow(options: UsageCorrelation): void {
  const issues: Array<{ path: string; message: string }> = [];
  validateCorrelationId('traceId', options.traceId, 'payload.traceId', issues);
  validateCorrelationId('parentId', options.parentId, 'payload.parentId', issues);
  validateCorrelationId('toolCallId', options.toolCallId, 'payload.toolCallId', issues);
  validateCorrelationId('meetingId', options.meetingId, 'payload.meetingId', issues);
  validateCorrelationId('userId', options.userId, 'payload.userId', issues);
  validateUsageTags(options.tags, 'payload.tags', issues);
  if (issues.length > 0) {
    throw new AgentViewerError('Invalid usage correlation fields', undefined, issues);
  }
}

/** Copies the six correlation fields into a payload object, only when defined (never `undefined` or `null` on the wire). */
function buildCorrelationPayload(options: UsageCorrelation): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (options.traceId !== undefined) payload.traceId = options.traceId;
  if (options.parentId !== undefined) payload.parentId = options.parentId;
  if (options.toolCallId !== undefined) payload.toolCallId = options.toolCallId;
  if (options.meetingId !== undefined) payload.meetingId = options.meetingId;
  if (options.userId !== undefined) payload.userId = options.userId;
  if (options.tags !== undefined) payload.tags = options.tags;
  return payload;
}

export interface AgentViewerOptions {
  url?: string;
  baseUrl?: string; // alias for url
  apiKey?: string;
  token?: string; // alias for apiKey
  runtimeId?: string;
  sessionId?: string;
  source?: string;
  timeoutMs?: number;
  maxRetries?: number;
  debug?: boolean;
  autoRegisterAgents?: boolean;

  /**
   * Directory for the optional durable local queue / spool (issue #102, shared contract
   * `docs/sdk-queue.md`). Falls back to `AGENT_VIEWER_SPOOL_DIR` when unset; omitting both keeps today's
   * behavior exactly (no spool, a transient failure after the normal retries throws `AgentViewerError`).
   * With it set, that same failure is written to disk instead and replayed in order once the server
   * returns. SQLite-backed (`node:sqlite`, Node only); never touched when unset.
   */
  spoolDir?: string;
  /** Max rows kept in the spool (not counting dead-lettered ones). Default `10000`. */
  spoolMaxEvents?: number;
  /** Max total serialized bytes kept in the spool. Default `50 * 1024 * 1024` (50 MiB). */
  spoolMaxBytes?: number;
  /** `'drop_oldest'` (default) or `'drop_newest'`; see `SpoolOverflowPolicy`. */
  spoolOverflow?: SpoolOverflowPolicy;
  /** Replay chunk size, `1..100`. Default `50`. */
  spoolBatchSize?: number;
  /** Drain on a background timer. Default `true` when the spool is enabled. */
  spoolBackground?: boolean;
  /** First backoff delay (seconds) after a failed probe. Default `2.0`. */
  spoolProbeInterval?: number;
  /** Backoff cap (seconds). Default `60.0`. */
  spoolMaxProbeInterval?: number;
}

export interface AgentInitOptions {
  id: string;
  name?: string;
  roleTitle?: string;
  provider?: string;
  model?: string;
  workspace?: string;
}

export interface EmitEventInput {
  id?: string;
  type: string;
  timestamp?: number;
  source?: string;
  target?: string;
  taskId?: string;
  /**
   * Overrides the client's own `sessionId` for this one event. A long-lived process that serves many
   * sessions through one client (for example a LangGraph app with one handler per `thread_id` per run,
   * issue #99) sets this per event instead of constructing a new `AgentViewer` per session.
   */
  sessionId?: string;
  agentId?: string;
  severity?: EventSeverity;
  summary?: string;
  payload?: Record<string, unknown>;
}

export interface UsageOptions extends UsageCorrelation {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Legacy name of cacheReadTokens in the contract; prefer cacheReadTokens. */
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  cost?: number | null;
  costSource?: CostSource | null;
  /** ISO 4217 code, forwarded as given. No default. */
  currency?: string | null;
  latencyMs?: number;
  requestId?: string;
  /** Goes to the envelope `taskId`, not to the payload. */
  taskId?: string;
}

/**
 * Options for `llmFailed()`: the payload of one failed model call attempt (issue #64), plus the same
 * correlation fields as `usage()`. A retry that succeeds is reported as a separate `usage()` call. There is
 * no free-text error field on purpose: provider messages can echo prompts or credentials.
 */
export interface LlmFailedOptions extends UsageCorrelation {
  provider: string;
  /** Optional: a connection failure before a model was chosen never invents one. */
  model?: string | null;
  errorKind?: LlmErrorKind;
  httpStatus?: number | null;
  retryable?: boolean | null;
  requestId?: string | null;
  providerErrorCode?: string | null;
  /** Attempts made before giving up, including the first one. */
  attempts?: number | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  cost?: number | null;
  costSource?: CostSource | null;
  currency?: string | null;
  /** Goes to the envelope `taskId`, not to the payload. */
  taskId?: string;
}

/**
 * Error raised when the server refuses a request or cannot be reached.
 *
 * `code` is the `error` field of the response body when there is one. `'conflicting_duplicate'` (status 409) means
 * an event with the same id was already stored with different content: the new event was not applied, and
 * resending it will never succeed. Give each distinct event its own id, and resend the identical event (same
 * `timestamp`) only to retry. The client never retries a 409.
 */
/** `GET /api/v1/whoami` (issue #107). `name` is present only for `kind: 'key'`. */
export interface WhoamiResponse {
  kind: 'key' | 'bootstrap' | 'webhook' | 'anonymous';
  id: string;
  name?: string;
}

export class AgentViewerError extends Error {
  public readonly status?: number;
  public readonly issues?: Array<{ path: string; message: string }>;
  public readonly code?: string;
  /** `true` when every retry was exhausted on a cause that could plausibly succeed later: a network error,
   * a timeout, or HTTP 408/429/5xx (issue #102). `false` (the default) for a 4xx the server answered
   * conclusively (including 409), which is never queued: replaying it could never succeed. With the local
   * queue enabled, `emit()`/`emitBatch()` queue an event only when `transient` is `true`. */
  public readonly transient: boolean;

  constructor(
    message: string,
    status?: number,
    issues?: Array<{ path: string; message: string }>,
    code?: string,
    transient = false
  ) {
    super(message);
    this.name = 'AgentViewerError';
    this.status = status;
    this.issues = issues;
    this.code = code;
    this.transient = transient;
  }
}

// -------------------------------------------------------------
// GET /api/v1/usage/calls (issue #67): metadata-only, cursor-paginated ledger rows.
// -------------------------------------------------------------

/**
 * Filters for `listCalls` / `iterateCalls`, mapped to the query parameters `GET /api/v1/usage/calls` accepts
 * (`server/usage/filters.ts`). `from`/`to` are passed through unmodified (epoch ms or an ISO 8601 date-time
 * with an explicit offset): the SDK never reformats a date, so a caller's own offset is never silently dropped.
 * Every repeatable filter accepts either one value or a list, sent as repeated query parameters.
 */
export interface ListCallsOptions {
  from?: number | string;
  to?: number | string;
  timeBasis?: 'received' | 'occurred';
  agentId?: string | readonly string[];
  sessionId?: string | readonly string[];
  runtimeId?: string | readonly string[];
  taskId?: string | readonly string[];
  provider?: string | readonly string[];
  model?: string | readonly string[];
  status?: string | readonly string[];
  costSource?: CostSource | readonly CostSource[];
  currency?: string | readonly string[];
  requestId?: string | readonly string[];
  traceId?: string;
  order?: 'desc' | 'asc';
  limit?: number;
  cursor?: string;
}

export interface CallsPageInfo {
  limit: number;
  order: 'desc' | 'asc';
  hasMore: boolean;
  nextCursor: string | null;
}

export interface CallsPageResult {
  schemaVersion: string;
  asOf: number;
  storage: 'memory' | 'sqlite';
  data: CallRecord[];
  page: CallsPageInfo;
}

/** What the server did with one item of a batch. */
export type EmitBatchItemStatus = 'accepted' | 'duplicate' | 'conflict';

export interface EmitBatchItemResult {
  id: string;
  status: EmitBatchItemStatus;
  duplicate: boolean;
  /** `sha256:<hex>` of the event as the server validated it. */
  fingerprint?: string;
  /** `'conflicting_duplicate'` for a conflict. */
  error?: string;
  /** Fingerprint of the event already stored under this id, for a conflict. */
  storedFingerprint?: string;
}

export interface EmitBatchResult {
  accepted: number;
  duplicates: number;
  /** Items whose id was already stored with different content; they were not applied. */
  conflicts: number;
  /** One entry per event, in input order. */
  results: EmitBatchItemResult[];
}

/** 128 random bits from the platform CSPRNG (`crypto.randomUUID`), never the clock. */
function defaultEventId(): string {
  return `evt_${globalThis.crypto.randomUUID()}`;
}

// -------------------------------------------------------------
// Budgets (issue #85, sub-issue #306: read only)
// -------------------------------------------------------------

/** Options for `AgentViewer.budgets()`. `state` filters to one of the four computed states server side; an
 * invalid value rejects with `AgentViewerError` (`status` 400). */
export interface BudgetsOptions {
  state?: BudgetState;
}

/** `GET /api/v1/budgets` response body: every matching budget with its `status` evaluated fresh against the
 * usage ledger (`status: null` for a disabled budget). `schemaVersion` stays `'1.0'`, additive field. */
export interface BudgetsResponse {
  schemaVersion: string;
  generatedAt: number;
  count: number;
  budgets: BudgetView[];
}

// -------------------------------------------------------------
// Usage rollup (issue #66)
// -------------------------------------------------------------

/** Flat params for `AgentViewer.usageRollup()`. Repeatable filters accept a single value or an array; a `Date`
 * for `from`/`to` is sent as ISO 8601. Mirrors the server's own `parseUsageFilters`/`parseRollupQuery`. */
export interface UsageRollupParams {
  groupBy: RollupDimension[];
  from?: number | string | Date;
  to?: number | string | Date;
  timeBasis?: TimeBasis;
  utcOffsetMinutes?: number;
  sort?: RollupSort;
  limit?: number;
  asOfSeq?: number;
  agentId?: string | string[];
  model?: string | string[];
  provider?: string | string[];
  sessionId?: string | string[];
  taskId?: string | string[];
  runtimeId?: string | string[];
  userId?: string | string[];
  tag?: string | string[];
  status?: string | string[];
  costSource?: CostSource | CostSource[];
  currency?: string | string[];
}

function formatRollupDateParam(value: number | string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function appendRepeatableParam(search: URLSearchParams, key: string, value: string | string[] | undefined): void {
  if (value === undefined) return;
  for (const item of Array.isArray(value) ? value : [value]) search.append(key, item);
}

/**
 * Maps one rollup group (or `totals`) to the library's own `UsageFigures` shape, so a host that already
 * renders `UsageFigures` can feed it a rollup group directly. `cost` is a number only when there is exactly
 * one cost entry, it has the requested `costSource`, and `unknownCostCalls` is 0; any mix of currencies,
 * cost sources, or an unknown cost gives `null`. `inputTokens`/`outputTokens` are `null` unless every
 * matching call reported that kind; `totalTokens` is their sum (excluding cache and reasoning tokens) only
 * when both are non-null.
 */
export function toUsageFigures(
  group: UsageRollupGroup | UsageRollupTotals,
  options: { costSource: 'provider-reported' | 'estimated' }
): UsageFigures {
  const { entries, unknownCostCalls } = group.cost;
  const singleEntry = entries.length === 1 ? entries[0] : undefined;
  const matches = singleEntry !== undefined && singleEntry.costSource === options.costSource && unknownCostCalls === 0;
  const cost = matches ? singleEntry!.sum : null;
  const currency = matches ? singleEntry!.currency : null;

  const inputTokens = group.tokens.input.sum !== null && group.tokens.input.unreportedCalls === 0 ? group.tokens.input.sum : null;
  const outputTokens = group.tokens.output.sum !== null && group.tokens.output.unreportedCalls === 0 ? group.tokens.output.sum : null;
  const totalTokens = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;

  return { cost, currency, inputTokens, outputTokens, totalTokens };
}

// -------------------------------------------------------------
// Outbound webhook signature verification (issue #86, sub-issue #323)
// -------------------------------------------------------------

/** Options for `verifyWebhookSignature()`. `toleranceMs` defaults to 300000 (5 minutes), the same window
 * the server's own inbound HMAC check uses; `nowMs` defaults to `Date.now()`. */
export interface VerifyWebhookSignatureOptions {
  secret: string;
  timestamp: number | string;
  rawBody: string | Buffer;
  signature: string;
  toleranceMs?: number;
  nowMs?: number;
}

/** Constant-time comparison of two hex strings. Hashing first (SHA-256) gives equal-length buffers, so a
 * `signature` of any length, or any shape, never throws and never leaks its length through timing. */
function constantTimeHexEqual(expectedHex: string, providedHex: string): boolean {
  const a = crypto.createHash('sha256').update(expectedHex).digest();
  const b = crypto.createHash('sha256').update(providedHex).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verifies an outbound Agent Viewer webhook (for example a `budget.alert` delivery, issue #86's sub-issue
 * #321), the receiver-side counterpart of the inbound HMAC check `server/index.ts` already does for
 * `POST /api/v1/webhooks/generic`. Same scheme: HMAC-SHA256 hex digest of `${timestamp}.${rawBody}`. This
 * function never sends anything and never builds or emits a `budget.alert` event itself; that type is
 * reserved to the server (issue #319). It is header-agnostic: the caller extracts
 * `X-Agent-Viewer-Signature`/`X-Agent-Viewer-Timestamp` (or whatever headers its own transport uses) and
 * passes their values in.
 *
 * Returns `false`, never throws, for every failure: a `timestamp` more than `toleranceMs` milliseconds away
 * from `nowMs` in either direction (older *or* newer, replay and clock-skew protection alike), or a
 * signature mismatch, including one of the wrong length. The comparison is constant-time
 * (`crypto.timingSafeEqual` over equal-length SHA-256 digests of the two hex strings, never a plain `===`),
 * so neither a wrong signature nor its length leaks through timing.
 *
 * `rawBody` must be the exact bytes (or the exact string) the sender signed, before any JSON
 * re-serialization: re-encoding a parsed body can reorder keys or change whitespace and would make a
 * genuine signature fail to verify.
 */
export function verifyWebhookSignature(options: VerifyWebhookSignatureOptions): boolean {
  const { secret, timestamp, rawBody, signature, toleranceMs = 300_000, nowMs } = options;
  const effectiveNow = nowMs ?? Date.now();
  const parsedTimestamp = Number(timestamp);
  if (!Number.isFinite(parsedTimestamp) || Math.abs(effectiveNow - parsedTimestamp) > toleranceMs) {
    return false;
  }

  const bodyBuffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf-8') : rawBody;
  const message = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf-8'), bodyBuffer]);
  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex');

  return constantTimeHexEqual(expected, signature);
}

// -------------------------------------------------------------
// Durable local queue / spool (issue #102). Shared contract with the Python SDK (#101) is
// docs/sdk-queue.md; cross-language vectors live in tests/fixtures/sdk-queue-scenarios.json. Mirrors
// sdk/python/agent_viewer.py's `_Spool` 1:1 (same schema, counters and eviction rule): where this file and
// that one disagree, it is a bug in this port, not an intentional divergence.
// -------------------------------------------------------------

const SPOOL_SCHEMA_VERSION = 1;
const SPOOL_OVERFLOW_POLICIES = ['drop_oldest', 'drop_newest'] as const;
/** `'drop_oldest'` (default) evicts the oldest non-usage row before ever touching a usage row; `'drop_newest'`
 * refuses the incoming event and evicts nothing. */
export type SpoolOverflowPolicy = (typeof SPOOL_OVERFLOW_POLICIES)[number];
const SPOOL_DEAD_LETTER_CAP = 100;
const SPOOL_USAGE_TYPES = new Set(['llm.usage', 'llm.failed']);
const SPOOL_COUNTER_NAMES = [
  'enqueuedTotal',
  'replayedTotal',
  'duplicatesAckedTotal',
  'droppedOverflowTotal',
  'droppedOverflowUsageTotal',
  'droppedSpoolErrorTotal',
  'droppedSpoolErrorUsageTotal',
  'rejectedTotal',
  'rejectedUsageTotal',
  'rejectedEvictedTotal',
  'corruptSpoolTotal',
] as const;
type SpoolCounterName = (typeof SPOOL_COUNTER_NAMES)[number];

/** `'idle'`: spool empty, no known outage, new events go straight to a live send. `'server_down'`: the
 * backlog is non-empty or the last live attempt failed transiently, new events are appended behind it.
 * `'draining'`: a drain pass is in progress. `'auth_failed'`: the last drain request answered 401/403, every
 * event is kept and draining is paused until `flush()` or `spoolMaxProbeInterval` elapses. `'disabled'`: no
 * `spoolDir` was given, or the spool failed to initialize. */
export type SpoolStateValue = 'idle' | 'draining' | 'server_down' | 'auth_failed' | 'disabled';

/** Return value of `AgentViewer.flush()`. With the spool disabled every count is `0`, `timedOut` is `false`
 * and `state` is `'disabled'`, so callers never need to branch on whether the spool is on. */
export interface FlushResult {
  /** Events acknowledged by the server in this call (accepted or duplicate). */
  delivered: number;
  /** Still in the spool after this call. */
  remaining: number;
  /** Moved to the dead letter in this call. */
  rejected: number;
  timedOut: boolean;
  state: SpoolStateValue;
}

/** Snapshot returned by `AgentViewer.spoolStats()`. Every counter is an event count: the SDK never sums,
 * prices or defaults tokens or cost here. With the spool disabled every counter is `0` and
 * `oldestPendingAgeS`/`lastError`/`lastSuccessAt` are `null`. */
export interface SpoolStats {
  state: SpoolStateValue;
  pendingEvents: number;
  pendingBytes: number;
  oldestPendingAgeS: number | null;
  enqueuedTotal: number;
  replayedTotal: number;
  duplicatesAckedTotal: number;
  droppedOverflowTotal: number;
  droppedOverflowUsageTotal: number;
  droppedSpoolErrorTotal: number;
  droppedSpoolErrorUsageTotal: number;
  rejectedTotal: number;
  rejectedUsageTotal: number;
  rejectedEvictedTotal: number;
  corruptSpoolTotal: number;
  lastError: string | null;
  lastSuccessAt: number | null;
}

/** One dead-letter row from `AgentViewer.spoolRejected()`, newest first: an event the server rejected
 * outright during replay. `eventJson` is parsed back into an object. */
export interface SpoolRejectedRow {
  seq: number;
  eventId: string;
  eventType: string;
  rejectedAt: number;
  statusCode: number | null;
  reason: string;
  eventJson: Record<string, unknown> | null;
}

/** `emit()`/`emitBatch()` resolve with this instead of the server body when the event could not be sent live
 * and was written to the spool instead. Re-emitting an id already in the spool is a no-op that returns this
 * same shape: the id is the idempotency key, never an overflow drop or an error. */
export interface EmitQueuedResult {
  accepted: false;
  queued: true;
  duplicate: false;
  id: string;
}

/** `emit()` resolves with this when a single event's own serialized size exceeds `spoolMaxBytes`: it can
 * never fit under the cap, so it is refused (never queued, never mixed into `EmitQueuedResult`) and counted
 * once in `droppedOverflowTotal` (plus the usage variant for `llm.usage`/`llm.failed`). */
export interface EmitDroppedResult {
  accepted: false;
  queued: false;
  dropped: true;
  id: string;
}

/** `emitBatch()` resolves with this when the queue took over: every normalized event was enqueued
 * individually (each keeping its own id, in list order); `ids` lists only the ones that were actually
 * queued (an oversized one is dropped and left out). */
export interface EmitBatchQueuedResult {
  accepted: false;
  queued: true;
  total: number;
  ids: string[];
}

/** `true` for a status the shared contract classifies as transient (retried, and queued when the local
 * queue is enabled): 408, 429 or any 5xx. Exported for the test suite's shared-vector check; not meant to be
 * called by host code. See `tests/fixtures/sdk-queue-scenarios.json`'s `transientClassification`. */
export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/** `spool-<sha256(url + "|" + runtimeId)[:12]>.sqlite3`. File naming is shared with the Python SDK so an
 * operator looking at a spool directory recognizes the pattern regardless of which SDK wrote it (the two
 * languages still keep separate files). Vectors in `tests/fixtures/sdk-queue-scenarios.json`'s
 * `spoolFileNaming`. */
export function computeSpoolFileName(url: string, runtimeId: string | undefined): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${url}|${runtimeId ?? ''}`, 'utf-8')
    .digest('hex')
    .slice(0, 12);
  return `spool-${digest}.sqlite3`;
}

function parseRetryAfterSeconds(headers: Headers | undefined): number | null {
  if (!headers) return null;
  const value = headers.get('retry-after');
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, (dateMs - Date.now()) / 1000);
  return null;
}

interface BatchValidationErrorEntry {
  index?: number;
  issues?: Array<{ path?: string; message?: string } | string>;
}

function formatValidationIssueText(errors: BatchValidationErrorEntry[], index: number): string {
  const entry = errors.find((e) => e.index === index);
  if (!entry) return 'validation_failed';
  const parts = (entry.issues ?? [])
    .map((issue) => (typeof issue === 'string' ? issue : issue.path ? `${issue.path}: ${issue.message ?? ''}` : issue.message ?? ''))
    .filter(Boolean);
  return parts.length > 0 ? parts.join('; ') : 'validation_failed';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
  });
}

/** Raised internally by one no-retry drain request on any network-level failure; never escapes `AgentViewer`.
 * Exported only so the test suite can simulate a network-level failure in `sendAndResolve()` without a real
 * socket (same reason `isTransientHttpStatus`/`computeSpoolFileName` are exported); not meant for host code. */
export class TransientNetworkError extends Error {}

interface SpoolRow {
  seq: number;
  eventId: string;
  eventType: string;
  eventJson: string;
}

let cachedDatabaseSyncCtor: (new (path: string) => DatabaseSync) | null = null;
/** `node:sqlite` is loaded through `createRequire` rather than a static import (matching
 * `server/store.ts`'s `getDatabaseSync()`): it is still a newer, version-gated Node API, and loading it this
 * way keeps it out of the module graph entirely until a caller actually enables the spool. */
function loadDatabaseSync(): new (path: string) => DatabaseSync {
  if (!cachedDatabaseSyncCtor) {
    const req = createRequire(import.meta.url);
    cachedDatabaseSyncCtor = req('node:sqlite').DatabaseSync;
  }
  return cachedDatabaseSyncCtor!;
}

/**
 * SQLite-backed, bounded, on-disk spool for one `(url, runtimeId)` destination (issue #102). Pure storage
 * and counters; all network I/O lives on `AgentViewer`. Node's single-threaded event loop plus synchronous
 * `node:sqlite` calls serialize every storage operation without an explicit lock, since nothing here ever
 * awaits mid-transaction.
 */
class Spool {
  readonly path: string;
  disabled = false;
  private db!: DatabaseSync;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly overflow: SpoolOverflowPolicy;
  private stateValue: SpoolStateValue = 'idle';

  constructor(
    spoolDir: string,
    url: string,
    runtimeId: string | undefined,
    maxEvents: number,
    maxBytes: number,
    overflow: SpoolOverflowPolicy
  ) {
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
    this.overflow = overflow;

    fs.mkdirSync(spoolDir, { recursive: true });
    try {
      fs.chmodSync(spoolDir, 0o700);
    } catch {
      // Best effort: platforms without POSIX permission bits (Windows) silently keep the default mode.
    }
    this.path = path.join(spoolDir, computeSpoolFileName(url, runtimeId));

    try {
      this.openAndInit();
    } catch (err) {
      this.quarantineAndRecreate(err);
    }
  }

  private openAndInit(): void {
    const DatabaseSyncCtor = loadDatabaseSync();
    this.db = new DatabaseSyncCtor(this.path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    try {
      fs.chmodSync(this.path, 0o600);
    } catch {
      // Best effort, see above.
    }
    this.initDb();
  }

  private createSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS spool (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      enqueued_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      event_json TEXT NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS rejected (
      seq INTEGER PRIMARY KEY,
      event_id TEXT,
      event_type TEXT,
      rejected_at INTEGER,
      status_code INTEGER,
      reason TEXT,
      event_json TEXT
    )`);
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  private initDb(): void {
    this.createSchema();
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (!row) {
      this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SPOOL_SCHEMA_VERSION));
    } else if (Number(row.value) > SPOOL_SCHEMA_VERSION) {
      console.error(
        `[AgentViewer] spool file ${this.path} has schema_version ${row.value}, newer than this SDK's ${SPOOL_SCHEMA_VERSION}. ` +
          'Leaving it untouched and disabling the spool for this run.'
      );
      this.disabled = true;
    }
  }

  private quarantineAndRecreate(err: unknown): void {
    try {
      this.db?.close();
    } catch {
      // ignore
    }
    const quarantinePath = `${this.path}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(this.path, quarantinePath);
    } catch {
      // The file may never have been created at all.
    }
    console.error(
      `[AgentViewer] spool file ${this.path} was corrupt (${String(err)}). Quarantined to ${quarantinePath} and starting a fresh spool.`
    );
    const DatabaseSyncCtor = loadDatabaseSync();
    this.db = new DatabaseSyncCtor(this.path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.createSchema();
    this.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SPOOL_SCHEMA_VERSION));
    this.incrCounters({ corruptSpoolTotal: 1 });
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, value);
  }

  private incrCounters(deltas: Partial<Record<SpoolCounterName, number>>): void {
    for (const [name, delta] of Object.entries(deltas) as Array<[SpoolCounterName, number | undefined]>) {
      if (!delta) continue;
      const key = `counter:${name}`;
      const current = Number(this.getMeta(key) ?? '0');
      this.setMeta(key, String(current + delta));
    }
  }

  incrCounter(name: SpoolCounterName, delta: number): void {
    this.incrCounters({ [name]: delta } as Partial<Record<SpoolCounterName, number>>);
  }

  setLastError(message: string): void {
    this.setMeta('last_error', message.slice(0, 500));
  }

  setMetaLastSuccess(): void {
    this.setMeta('last_success_at', String(Date.now()));
  }

  markAuthFailedNow(): void {
    this.setMeta('auth_failed_since', String(Date.now()));
  }

  authRetryDue(maxProbeIntervalSeconds: number, force: boolean): boolean {
    if (force) return true;
    const since = this.getMeta('auth_failed_since');
    if (since === null) return true;
    const elapsedS = (Date.now() - Number(since)) / 1000;
    return elapsedS >= maxProbeIntervalSeconds;
  }

  get state(): SpoolStateValue {
    return this.stateValue;
  }

  setState(value: SpoolStateValue): void {
    this.stateValue = value;
  }

  pendingCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM spool').get() as { c: number };
    return row.c;
  }

  isBacklogged(): boolean {
    return this.state !== 'idle' || this.pendingCount() > 0;
  }

  private currentTotals(): { count: number; bytes: number } {
    const row = this.db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size_bytes), 0) AS b FROM spool').get() as {
      c: number;
      b: number;
    };
    return { count: row.c, bytes: row.b };
  }

  private makeRoom(incomingSize: number): void {
    if (this.overflow === 'drop_newest') return;
    while (true) {
      const { count, bytes } = this.currentTotals();
      if (count + 1 <= this.maxEvents && bytes + incomingSize <= this.maxBytes) return;
      let victim = this.db
        .prepare("SELECT seq, event_type AS eventType FROM spool WHERE event_type NOT IN ('llm.usage', 'llm.failed') ORDER BY seq ASC LIMIT 1")
        .get() as { seq: number; eventType: string } | undefined;
      if (!victim) {
        victim = this.db.prepare('SELECT seq, event_type AS eventType FROM spool ORDER BY seq ASC LIMIT 1').get() as
          | { seq: number; eventType: string }
          | undefined;
      }
      if (!victim) return;
      this.db.prepare('DELETE FROM spool WHERE seq = ?').run(victim.seq);
      const deltas: Partial<Record<SpoolCounterName, number>> = { droppedOverflowTotal: 1 };
      if (SPOOL_USAGE_TYPES.has(victim.eventType)) deltas.droppedOverflowUsageTotal = 1;
      this.incrCounters(deltas);
    }
  }

  /** Returns `'queued'`, `'duplicateNoop'`, `'refusedOversized'` or `'writeError'`. Never throws. */
  enqueue(event: { id: string; type: string }, serialized: string): 'queued' | 'duplicateNoop' | 'refusedOversized' | 'writeError' {
    const eventId = event.id;
    const eventType = event.type;
    const sizeBytes = Buffer.byteLength(serialized, 'utf-8');
    try {
      const existing = this.db.prepare('SELECT 1 FROM spool WHERE event_id = ?').get(eventId);
      if (existing) return 'duplicateNoop';

      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (sizeBytes > this.maxBytes) {
          const deltas: Partial<Record<SpoolCounterName, number>> = { droppedOverflowTotal: 1 };
          if (SPOOL_USAGE_TYPES.has(eventType)) deltas.droppedOverflowUsageTotal = 1;
          this.incrCounters(deltas);
          this.db.exec('COMMIT');
          return 'refusedOversized';
        }

        this.makeRoom(sizeBytes);
        const { count, bytes } = this.currentTotals();
        if (count + 1 > this.maxEvents || bytes + sizeBytes > this.maxBytes) {
          const deltas: Partial<Record<SpoolCounterName, number>> = { droppedOverflowTotal: 1 };
          if (SPOOL_USAGE_TYPES.has(eventType)) deltas.droppedOverflowUsageTotal = 1;
          this.incrCounters(deltas);
          this.db.exec('COMMIT');
          return 'refusedOversized';
        }

        this.db
          .prepare('INSERT INTO spool(event_id, event_type, size_bytes, enqueued_at, attempts, event_json) VALUES (?, ?, ?, ?, 0, ?)')
          .run(eventId, eventType, sizeBytes, Date.now(), serialized);
        this.incrCounters({ enqueuedTotal: 1 });
        this.db.exec('COMMIT');
      } catch (err) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // ignore
        }
        throw err;
      }
    } catch (err) {
      console.error(`[AgentViewer] spool write failed (${String(err)}); event dropped and counted.`);
      try {
        const deltas: Partial<Record<SpoolCounterName, number>> = { droppedSpoolErrorTotal: 1 };
        if (SPOOL_USAGE_TYPES.has(eventType)) deltas.droppedSpoolErrorUsageTotal = 1;
        this.incrCounters(deltas);
      } catch {
        // ignore
      }
      return 'writeError';
    }
    this.setState('server_down');
    return 'queued';
  }

  peekBatch(limit: number): SpoolRow[] {
    return this.db
      .prepare('SELECT seq, event_id AS eventId, event_type AS eventType, event_json AS eventJson FROM spool ORDER BY seq ASC LIMIT ?')
      .all(limit) as unknown as SpoolRow[];
  }

  deleteSeqs(seqs: number[]): void {
    if (seqs.length === 0) return;
    const stmt = this.db.prepare('DELETE FROM spool WHERE seq = ?');
    for (const seq of seqs) stmt.run(seq);
  }

  moveToRejected(row: SpoolRow, statusCode: number | null, reason: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM spool WHERE seq = ?').run(row.seq);
      this.db
        .prepare(
          'INSERT OR REPLACE INTO rejected(seq, event_id, event_type, rejected_at, status_code, reason, event_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(row.seq, row.eventId, row.eventType, Date.now(), statusCode, reason, row.eventJson);
      const deltas: Partial<Record<SpoolCounterName, number>> = { rejectedTotal: 1 };
      if (SPOOL_USAGE_TYPES.has(row.eventType)) deltas.rejectedUsageTotal = 1;
      this.incrCounters(deltas);
      const total = (this.db.prepare('SELECT COUNT(*) AS c FROM rejected').get() as { c: number }).c;
      const overflowCount = total - SPOOL_DEAD_LETTER_CAP;
      if (overflowCount > 0) {
        const victims = this.db.prepare('SELECT seq FROM rejected ORDER BY seq ASC LIMIT ?').all(overflowCount) as Array<{ seq: number }>;
        const del = this.db.prepare('DELETE FROM rejected WHERE seq = ?');
        for (const v of victims) del.run(v.seq);
        this.incrCounters({ rejectedEvictedTotal: overflowCount });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      throw err;
    }
  }

  rejected(limit = 100): SpoolRejectedRow[] {
    const rows = this.db
      .prepare(
        'SELECT seq, event_id AS eventId, event_type AS eventType, rejected_at AS rejectedAt, status_code AS statusCode, reason, event_json AS eventJson ' +
          'FROM rejected ORDER BY seq DESC LIMIT ?'
      )
      .all(limit) as unknown as Array<{
      seq: number;
      eventId: string;
      eventType: string;
      rejectedAt: number;
      statusCode: number | null;
      reason: string;
      eventJson: string;
    }>;
    return rows.map((r) => {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(r.eventJson);
      } catch {
        parsed = null;
      }
      return {
        seq: r.seq,
        eventId: r.eventId,
        eventType: r.eventType,
        rejectedAt: r.rejectedAt,
        statusCode: r.statusCode,
        reason: r.reason,
        eventJson: parsed,
      };
    });
  }

  stats(): SpoolStats {
    const { count, bytes } = this.currentTotals();
    const oldestRow = this.db.prepare('SELECT enqueued_at AS enqueuedAt FROM spool ORDER BY seq ASC LIMIT 1').get() as
      | { enqueuedAt: number }
      | undefined;
    const oldestAge = oldestRow ? Math.max(0, (Date.now() - oldestRow.enqueuedAt) / 1000) : null;
    const counters = {} as Record<SpoolCounterName, number>;
    for (const name of SPOOL_COUNTER_NAMES) counters[name] = Number(this.getMeta(`counter:${name}`) ?? '0');
    const lastError = this.getMeta('last_error');
    const lastSuccessAt = this.getMeta('last_success_at');
    return {
      state: this.state,
      pendingEvents: count,
      pendingBytes: bytes,
      oldestPendingAgeS: oldestAge,
      lastError,
      lastSuccessAt: lastSuccessAt !== null ? Number(lastSuccessAt) : null,
      ...counters,
    };
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // ignore
    }
  }
}

export class AgentHandle {
  public readonly id: string;
  public readonly name: string;
  public readonly roleTitle?: string;
  public readonly provider?: string;
  public readonly model?: string;
  public readonly workspace?: string;

  private readonly viewer: AgentViewer;
  private registered = false;

  constructor(viewer: AgentViewer, options: AgentInitOptions) {
    this.viewer = viewer;
    this.id = options.id;
    this.name = options.name ?? options.id;
    this.roleTitle = options.roleTitle;
    this.provider = options.provider;
    this.model = options.model;
    this.workspace = options.workspace;
  }

  private async ensureRegistered(): Promise<void> {
    if (!this.registered && this.viewer.shouldAutoRegister()) {
      try {
        await this.viewer.emit({
          type: 'agent.registered',
          source: `agent:${this.id}`,
          agentId: this.id,
          summary: `Registered ${this.name}`,
          payload: {
            id: this.id,
            name: this.name,
            roleTitle: this.roleTitle ?? 'AI Agent',
            provider: this.provider ?? 'Custom',
            model: this.model ?? 'Custom',
            workspace: this.workspace ?? 'development',
          },
        });
        this.registered = true;
      } catch (err) {
        if (this.viewer.isDebug()) {
          console.warn(`[AgentViewer] Auto-registration warning for ${this.id}:`, err);
        }
      }
    }
  }

  async status(status: string, options: { workspace?: string; statusText?: string } = {}): Promise<void> {
    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'agent.status.changed',
      source: `agent:${this.id}`,
      agentId: this.id,
      summary: options.statusText ?? `${this.id} → ${status}`,
      payload: {
        status,
        statusText: options.statusText,
        workspace: options.workspace ?? this.workspace,
      },
    });
  }

  async idle(summary = 'Idle and awaiting tasks'): Promise<void> {
    await this.status('IDLE', { statusText: summary });
  }

  async thinking(summary = 'Thinking and processing'): Promise<void> {
    await this.status('THINKING', { statusText: summary });
  }

  async researching(summary = 'Researching information'): Promise<void> {
    await this.status('RESEARCHING', { statusText: summary, workspace: 'research_area' });
  }

  async coding(summary = 'Writing code'): Promise<void> {
    await this.status('CODING', { statusText: summary, workspace: 'development' });
  }

  async testing(summary = 'Running tests'): Promise<void> {
    await this.status('TESTING', { statusText: summary, workspace: 'qa_lab' });
  }

  async waiting(summary = 'Waiting for dependencies'): Promise<void> {
    await this.status('WAITING', { statusText: summary });
  }

  async blocked(reason = 'Execution blocked'): Promise<void> {
    await this.status('BLOCKED', { statusText: reason });
  }

  async done(summary = 'Task completed successfully'): Promise<void> {
    await this.status('DONE', { statusText: summary });
  }

  async message(text: string, targetAgentName?: string): Promise<void> {
    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'agent.message.sent',
      source: `agent:${this.id}`,
      agentId: this.id,
      summary: `${this.name}: ${text.slice(0, 60)}`,
      payload: {
        text,
        targetAgentName,
      },
    });
  }

  async toolStarted(tool: string, inputSummary?: string, options: ToolCallOptions = {}): Promise<void> {
    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'tool.started',
      source: `agent:${this.id}`,
      agentId: this.id,
      summary: inputSummary ? `Started ${tool}: ${inputSummary}` : `Started tool ${tool}`,
      payload: {
        tool,
        inputSummary,
        toolCallId: options.toolCallId,
      },
    });
  }

  async toolCompleted(tool: string, outputSummary?: string, options: ToolCallFinishOptions = {}): Promise<void> {
    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'tool.completed',
      source: `agent:${this.id}`,
      agentId: this.id,
      summary: outputSummary ? `Completed ${tool}: ${outputSummary}` : `Completed tool ${tool}`,
      payload: {
        tool,
        outputSummary,
        toolCallId: options.toolCallId,
        durationMs: options.durationMs,
      },
    });
  }

  async toolFailed(tool: string, errorSummary?: string, options: ToolCallFinishOptions = {}): Promise<void> {
    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'tool.failed',
      source: `agent:${this.id}`,
      agentId: this.id,
      severity: 'high',
      summary: errorSummary ? `Failed ${tool}: ${errorSummary}` : `Failed tool ${tool}`,
      payload: {
        tool,
        error: errorSummary,
        toolCallId: options.toolCallId,
        durationMs: options.durationMs,
      },
    });
  }

  /**
   * Reports the usage of one model call exactly as the caller knows it. A figure that is not
   * given (or is `null`) is left out, never sent as 0. `costSource` is never inferred: a cost
   * without it is sent as `'unknown'` and the client warns once.
   */
  async usage(options: UsageOptions): Promise<void> {
    const costSource: unknown = options.costSource;
    if (costSource !== undefined && costSource !== null && !COST_SOURCES.includes(costSource as CostSource)) {
      throw new TypeError(`costSource must be one of ${COST_SOURCES.join(', ')} (got "${String(costSource)}")`);
    }
    validateUsageCorrelationOrThrow(options);
    const cost = options.cost ?? null;
    const statedCostSource = options.costSource ?? undefined;
    if (cost !== null && statedCostSource === undefined) {
      this.viewer.warnOnce('unstated-cost-source', UNSTATED_COST_SOURCE_WARNING);
    }

    const payload = {
      provider: options.provider,
      model: options.model,
      inputTokens: options.inputTokens,
      outputTokens: options.outputTokens,
      cachedTokens: omitNull(options.cachedTokens),
      cacheReadTokens: omitNull(options.cacheReadTokens),
      cacheWriteTokens: omitNull(options.cacheWriteTokens),
      reasoningTokens: omitNull(options.reasoningTokens),
      cost,
      costSource: statedCostSource ?? 'unknown',
      currency: omitNull(options.currency),
      latencyMs: options.latencyMs,
      requestId: options.requestId,
      ...buildCorrelationPayload(options),
    } satisfies LlmUsagePayloadInput;

    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'llm.usage',
      source: `agent:${this.id}`,
      agentId: this.id,
      taskId: options.taskId,
      summary: `${options.provider}/${options.model} tokens (${options.inputTokens}+${options.outputTokens})`,
      payload,
    });
  }

  /**
   * Reports one failed model call attempt (issue #64). A figure that is not given (or is `null`) is left
   * out, never sent as 0 or invented. `costSource` follows the same unstated-warning rule as `usage()`. A
   * retry that succeeds is a separate `usage()` call, not part of this one.
   */
  async llmFailed(options: LlmFailedOptions): Promise<void> {
    const costSource: unknown = options.costSource;
    if (costSource !== undefined && costSource !== null && !COST_SOURCES.includes(costSource as CostSource)) {
      throw new TypeError(`costSource must be one of ${COST_SOURCES.join(', ')} (got "${String(costSource)}")`);
    }
    validateUsageCorrelationOrThrow(options);
    const cost = options.cost ?? null;
    const statedCostSource = options.costSource ?? undefined;
    if (cost !== null && statedCostSource === undefined) {
      this.viewer.warnOnce('unstated-cost-source', UNSTATED_COST_SOURCE_WARNING);
    }

    const payload = {
      provider: options.provider,
      model: omitNull(options.model),
      errorKind: options.errorKind,
      httpStatus: omitNull(options.httpStatus),
      retryable: omitNull(options.retryable),
      requestId: omitNull(options.requestId),
      providerErrorCode: omitNull(options.providerErrorCode),
      attempts: omitNull(options.attempts),
      latencyMs: omitNull(options.latencyMs),
      inputTokens: omitNull(options.inputTokens),
      outputTokens: omitNull(options.outputTokens),
      cacheReadTokens: omitNull(options.cacheReadTokens),
      cacheWriteTokens: omitNull(options.cacheWriteTokens),
      reasoningTokens: omitNull(options.reasoningTokens),
      cost,
      costSource: statedCostSource ?? 'unknown',
      currency: omitNull(options.currency),
      ...buildCorrelationPayload(options),
    } satisfies LlmFailedPayloadInput;

    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'llm.failed',
      source: `agent:${this.id}`,
      agentId: this.id,
      taskId: options.taskId,
      severity: 'high',
      summary: options.model
        ? `${options.provider}/${options.model} call failed`
        : `${options.provider} call failed`,
      payload,
    });
  }
}

export class AgentViewer {
  public readonly url: string;
  public readonly token?: string;
  public readonly runtimeId?: string;
  public readonly sessionId?: string;
  public readonly source: string;
  public readonly timeoutMs: number;
  public readonly maxRetries: number;
  public readonly debug: boolean;
  public readonly autoRegisterAgents: boolean;

  private registeredAgents = new Map<string, AgentHandle>();
  private readonly warnedKeys = new Set<string>();

  // Durable local queue / spool (issue #102). See docs/sdk-queue.md for the full contract.
  private spool: Spool | null = null;
  private readonly spoolBackground: boolean;
  private readonly spoolProbeInterval: number;
  private readonly spoolMaxProbeInterval: number;
  private spoolChunkSize: number;
  private spoolBackoffSeconds: number;
  private drainTimer: ReturnType<typeof setInterval> | null = null;
  private drainQueue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly beforeExitFlush = (): void => {
    void this.close(5000);
  };

  constructor(options: AgentViewerOptions = {}) {
    const rawUrl = options.url || options.baseUrl || 'http://localhost:8787';
    this.url = rawUrl.replace(/\/$/, '');
    this.token = options.apiKey || options.token;
    this.runtimeId = options.runtimeId;
    this.sessionId = options.sessionId;
    this.source = options.source || (options.runtimeId ? `runtime:${options.runtimeId}` : 'external-runtime');
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.maxRetries = options.maxRetries ?? 3;
    this.debug = Boolean(options.debug);
    this.autoRegisterAgents = options.autoRegisterAgents !== false;

    const spoolMaxEvents = options.spoolMaxEvents ?? 10_000;
    const spoolMaxBytes = options.spoolMaxBytes ?? 50 * 1024 * 1024;
    const spoolOverflow = options.spoolOverflow ?? 'drop_oldest';
    const spoolBatchSize = options.spoolBatchSize ?? 50;
    if (spoolMaxEvents < 1) throw new Error('spoolMaxEvents must be >= 1');
    if (spoolMaxBytes < 1) throw new Error('spoolMaxBytes must be >= 1');
    if (!SPOOL_OVERFLOW_POLICIES.includes(spoolOverflow)) {
      throw new Error(`spoolOverflow must be one of ${SPOOL_OVERFLOW_POLICIES.join(', ')} (got "${String(spoolOverflow)}")`);
    }
    if (spoolBatchSize < 1 || spoolBatchSize > 100) {
      throw new Error('spoolBatchSize must be between 1 and 100');
    }

    this.spoolBackground = options.spoolBackground ?? true;
    this.spoolProbeInterval = options.spoolProbeInterval ?? 2.0;
    this.spoolMaxProbeInterval = options.spoolMaxProbeInterval ?? 60.0;
    this.spoolChunkSize = spoolBatchSize;
    this.spoolBackoffSeconds = this.spoolProbeInterval;

    const effectiveSpoolDir = options.spoolDir ?? (typeof process !== 'undefined' ? process.env?.AGENT_VIEWER_SPOOL_DIR : undefined);
    if (effectiveSpoolDir) {
      try {
        const candidate = new Spool(effectiveSpoolDir, this.url, this.runtimeId, spoolMaxEvents, spoolMaxBytes, spoolOverflow);
        this.spool = candidate.disabled ? null : candidate;
      } catch (err) {
        console.error(`[AgentViewer] failed to initialize spool at ${effectiveSpoolDir} (${String(err)}). Spool disabled for this run.`);
        this.spool = null;
      }
      if (this.spool && typeof process !== 'undefined' && typeof process.on === 'function') {
        process.on('beforeExit', this.beforeExitFlush);
      }
    }
  }

  isDebug(): boolean {
    return this.debug;
  }

  shouldAutoRegister(): boolean {
    return this.autoRegisterAgents;
  }

  /** Prints `message` with `console.warn` the first time `key` is seen by this client, whatever `debug` says. */
  warnOnce(key: string, message: string): void {
    if (this.warnedKeys.has(key)) return;
    this.warnedKeys.add(key);
    console.warn(message);
  }

  agent(init: string | AgentInitOptions): AgentHandle {
    const options: AgentInitOptions = typeof init === 'string' ? { id: init, name: init } : init;
    const existing = this.registeredAgents.get(options.id);
    if (existing) return existing;

    const handle = new AgentHandle(this, options);
    this.registeredAgents.set(options.id, handle);
    return handle;
  }

  /**
   * Emits one canonical event. With the local queue disabled (the default), this behaves exactly as before:
   * it resolves with the server's response body, or throws `AgentViewerError` once retries are exhausted.
   *
   * With `spoolDir` set (issue #102) and the spool already backlogged, or a transient failure (network
   * error, timeout, 408, 429, 5xx) after the normal retries, the event is written to disk with its original
   * `id` and `timestamp` instead of throwing, and this resolves with `EmitQueuedResult`
   * (`{ accepted: false, queued: true, ... }`) or, if the event's own serialized size exceeds
   * `spoolMaxBytes`, `EmitDroppedResult`. A conclusive rejection (any other 4xx) still throws immediately and
   * is never queued: replaying it could never succeed.
   */
  async emit(input: EmitEventInput): Promise<Record<string, unknown> | EmitQueuedResult | EmitDroppedResult> {
    const event: CanonicalEvent = {
      schemaVersion: '1.0',
      id: input.id ?? defaultEventId(),
      type: input.type as CanonicalEventType,
      timestamp: input.timestamp ?? Date.now(),
      runtimeId: this.runtimeId,
      sessionId: input.sessionId ?? this.sessionId,
      source: input.source ?? this.source,
      agentId: input.agentId,
      taskId: input.taskId,
      severity: input.severity ?? 'normal',
      summary: input.summary ?? `${input.type} reported`,
      payload: input.payload ?? {},
    };

    if (this.spool) {
      if (this.spool.isBacklogged()) {
        return this.spoolQueueSingle(event);
      }
      try {
        return await this.postWithRetry('/api/v1/events', event, event.id);
      } catch (err) {
        if (err instanceof AgentViewerError && err.transient) {
          return this.spoolQueueSingle(event);
        }
        throw err;
      }
    }
    return this.postWithRetry('/api/v1/events', event, event.id);
  }

  /**
   * Sends up to the server's batch limit in one request. The server answers 202 even when some items were not
   * applied, so read `conflicts` and each item's `status`: `'conflict'` means the id was already stored with
   * different content (`error: 'conflicting_duplicate'`), and that item was dropped. A 0.2.x server sends no
   * `conflicts` (reported here as 0) and no per-item `status`; its `results` are passed through as received.
   *
   * With the local queue enabled (issue #102) and the server unreachable (or the spool already backlogged),
   * each normalized event is queued individually (keeping its own id, in list order) and this resolves with
   * `EmitBatchQueuedResult` instead.
   */
  async emitBatch(inputs: EmitEventInput[]): Promise<EmitBatchResult | EmitBatchQueuedResult> {
    const events: CanonicalEvent[] = inputs.map((input) => ({
      schemaVersion: '1.0',
      id: input.id ?? defaultEventId(),
      type: input.type as CanonicalEventType,
      timestamp: input.timestamp ?? Date.now(),
      runtimeId: this.runtimeId,
      sessionId: input.sessionId ?? this.sessionId,
      source: input.source ?? this.source,
      agentId: input.agentId,
      taskId: input.taskId,
      severity: input.severity ?? 'normal',
      summary: input.summary ?? `${input.type} reported`,
      payload: input.payload ?? {},
    }));

    const toBatchResult = (result: any): EmitBatchResult => ({
      accepted: result?.accepted ?? 0,
      duplicates: result?.duplicates ?? 0,
      conflicts: result?.conflicts ?? 0,
      results: Array.isArray(result?.results) ? result.results : [],
    });

    if (this.spool) {
      if (this.spool.isBacklogged()) {
        return this.spoolQueueBatch(events);
      }
      try {
        return toBatchResult(await this.postWithRetry('/api/v1/events/batch', { events }));
      } catch (err) {
        if (err instanceof AgentViewerError && err.transient) {
          return this.spoolQueueBatch(events);
        }
        throw err;
      }
    }
    return toBatchResult(await this.postWithRetry('/api/v1/events/batch', { events }));
  }

  // -- Durable local queue: enqueue, drain, flush/close/stats (issue #102) --------------------------------

  private spoolQueueSingle(event: CanonicalEvent): EmitQueuedResult | EmitDroppedResult {
    const serialized = JSON.stringify(event);
    const outcome = this.spool!.enqueue({ id: event.id, type: event.type }, serialized);
    this.ensureDrainRunning();
    if (outcome === 'refusedOversized' || outcome === 'writeError') {
      return { accepted: false, queued: false, dropped: true, id: event.id };
    }
    return { accepted: false, queued: true, duplicate: false, id: event.id };
  }

  private spoolQueueBatch(events: CanonicalEvent[]): EmitBatchQueuedResult {
    const ids: string[] = [];
    for (const event of events) {
      const result = this.spoolQueueSingle(event);
      if (result.queued) ids.push(result.id);
    }
    return { accepted: false, queued: true, total: events.length, ids };
  }

  private ensureDrainRunning(): void {
    if (!this.spool || !this.spoolBackground) return;
    // Kick a drain pass right away; drainSession() is reentrant-safe through its own internal lock queue.
    void this.drainSession(null, false);
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      if (!this.spool || this.spool.disabled) return;
      if (this.spool.state === 'idle' && this.spool.pendingCount() === 0) return;
      void this.drainSession(null, false);
    }, 100);
    (this.drainTimer as unknown as { unref?: () => void }).unref?.();
  }

  private resetBackoff(): void {
    this.spoolBackoffSeconds = this.spoolProbeInterval;
  }

  private nextBackoff(): number {
    const current = this.spoolBackoffSeconds;
    const sleepFor = current + current * Math.random() * 0.2;
    this.spoolBackoffSeconds = Math.min(current * 2, this.spoolMaxProbeInterval);
    return sleepFor;
  }

  /**
   * Runs drain passes until the spool is empty, a stop condition is reached (auth failure, or a backoff wait
   * that would exceed `deadline`), or `deadline` elapses. `deadline` is an epoch-ms timestamp, or `null` to
   * run until idle/stopped with no time bound (the background timer's own call). Never throws. Only one
   * drain session actually runs at a time (`drainQueue`): a concurrent call (for example `flush()` while the
   * background drain is already mid-pass) waits for it too, bounded by its own `deadline`, so `flush()`
   * genuinely waits for and contributes to the in-flight work instead of silently no-op'ing.
   */
  private async drainSession(
    deadline: number | null,
    forceAuthRetry: boolean
  ): Promise<{ delivered: number; rejected: number; timedOut: boolean }> {
    const previous = this.drainQueue;
    let release!: () => void;
    this.drainQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    let acquired: boolean;
    if (deadline === null) {
      await previous;
      acquired = true;
    } else {
      const timeLeft = Math.max(0, deadline - Date.now());
      acquired = await Promise.race([previous.then(() => true), sleep(timeLeft).then(() => false)]);
    }
    if (!acquired) {
      release();
      return { delivered: 0, rejected: 0, timedOut: true };
    }

    try {
      const spool = this.spool;
      if (!spool) return { delivered: 0, rejected: 0, timedOut: false };
      let deliveredTotal = 0;
      let rejectedTotal = 0;
      while (true) {
        if (deadline !== null && Date.now() >= deadline) {
          return { delivered: deliveredTotal, rejected: rejectedTotal, timedOut: true };
        }
        if (spool.state === 'auth_failed' && !spool.authRetryDue(this.spoolMaxProbeInterval, forceAuthRetry)) {
          return { delivered: deliveredTotal, rejected: rejectedTotal, timedOut: false };
        }

        const batch = spool.peekBatch(this.spoolChunkSize);
        if (batch.length === 0) {
          spool.setState('idle');
          return { delivered: deliveredTotal, rejected: rejectedTotal, timedOut: false };
        }

        spool.setState('draining');
        const outcome = await this.sendAndResolve(batch);

        if (outcome.duplicates) spool.incrCounter('duplicatesAckedTotal', outcome.duplicates);
        if (outcome.delivered) spool.incrCounter('replayedTotal', outcome.delivered);
        if (outcome.delivered || outcome.duplicates) {
          spool.setMetaLastSuccess();
          this.resetBackoff();
        }
        deliveredTotal += outcome.delivered + outcome.duplicates;
        rejectedTotal += outcome.rejected;

        if (outcome.stop === 'auth_failed') {
          spool.setState('auth_failed');
          spool.markAuthFailedNow();
          console.warn(
            '[AgentViewer] spool drain stopped, the server rejected the token (401/403). Every queued event is kept; call flush() after fixing the token.'
          );
          return { delivered: deliveredTotal, rejected: rejectedTotal, timedOut: false };
        }

        if (outcome.stop === 'backoff') {
          spool.setState('server_down');
          if (outcome.error) spool.setLastError(outcome.error);
          let sleepForSeconds: number;
          if (outcome.backoffSeconds !== null && outcome.backoffSeconds !== undefined) {
            sleepForSeconds = Math.min(outcome.backoffSeconds, this.spoolMaxProbeInterval);
            this.resetBackoff();
          } else {
            sleepForSeconds = this.nextBackoff();
          }
          if (deadline !== null) {
            const remainingSeconds = Math.max(0, (deadline - Date.now()) / 1000);
            sleepForSeconds = Math.min(sleepForSeconds, remainingSeconds);
            if (sleepForSeconds <= 0) {
              return { delivered: deliveredTotal, rejected: rejectedTotal, timedOut: true };
            }
          }
          await sleep(sleepForSeconds * 1000);
          continue;
        }

        // Delivered (fully or partially) with the rest rejected, or the chunk size just changed (413/400
        // bisection): loop immediately so the next iteration re-peeks the (possibly smaller) backlog.
        continue;
      }
    } finally {
      release();
    }
  }

  /** One no-retry drain request: a probe after an outage never blocks the host for the full retry budget,
   * only for `min(timeoutMs, 2000)` ms. Throws `TransientNetworkError` on any network-level failure; never
   * throws for an HTTP error response. */
  private async rawBatchRequest(bodyStr: string): Promise<{ status: number; body: any; headers: Headers }> {
    const controller = new AbortController();
    const timeoutMs = Math.min(this.timeoutMs, 2000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.url}/api/v1/events/batch`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: bodyStr,
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: any = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = {};
      }
      return { status: response.status, body: parsed, headers: response.headers };
    } catch (err: any) {
      throw new TransientNetworkError(err?.message ?? String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sends `rows` as one batch request and resolves the outcome against `docs/sdk-queue.md`'s drain response
   * table. Never throws. A 413 or an index-less 400 only shrinks `spoolChunkSize` and returns with nothing
   * resolved yet (`stop: null`): bisection is lazy, driven by `drainSession`'s own loop re-peeking a smaller
   * chunk off the same, untouched backlog on its very next iteration.
   */
  private async sendAndResolve(rows: SpoolRow[]): Promise<{
    delivered: number;
    duplicates: number;
    rejected: number;
    stop: 'auth_failed' | 'backoff' | null;
    backoffSeconds: number | null;
    error?: string;
  }> {
    const empty = { delivered: 0, duplicates: 0, rejected: 0, stop: null as 'auth_failed' | 'backoff' | null, backoffSeconds: null as number | null };
    if (rows.length === 0) return { ...empty };

    const body = `{"events":[${rows.map((r) => r.eventJson).join(',')}]}`;
    let status: number;
    let parsed: any;
    let headers: Headers;
    try {
      ({ status, body: parsed, headers } = await this.rawBatchRequest(body));
    } catch (err) {
      if (err instanceof TransientNetworkError) {
        return { ...empty, stop: 'backoff', error: err.message };
      }
      throw err;
    }

    if (status === 200 || status === 202) {
      const results = Array.isArray(parsed?.results) ? parsed.results : [];
      let delivered = 0;
      let duplicates = 0;
      const ackedSeqs: number[] = [];
      rows.forEach((row, idx) => {
        ackedSeqs.push(row.seq);
        const result = results[idx];
        if (result && typeof result === 'object' && result.duplicate) duplicates++;
        else delivered++;
      });
      this.spool!.deleteSeqs(ackedSeqs);
      return { ...empty, delivered, duplicates };
    }

    if (status === 413) {
      if (rows.length === 1) {
        this.spool!.moveToRejected(rows[0], status, "HTTP 413: event exceeds the server's body size limit");
        return { ...empty, rejected: 1 };
      }
      this.spoolChunkSize = Math.max(1, Math.floor(rows.length / 2));
      return { ...empty };
    }

    if (status === 400) {
      const errors: BatchValidationErrorEntry[] | null = Array.isArray(parsed?.errors) ? parsed.errors : null;
      const allIndexed = errors && errors.length > 0 && errors.every((e) => typeof e?.index === 'number');
      if (allIndexed && errors) {
        const badIndexes = new Set(errors.map((e) => e.index));
        let rejected = 0;
        rows.forEach((row, idx) => {
          if (badIndexes.has(idx)) {
            this.spool!.moveToRejected(row, 400, formatValidationIssueText(errors, idx));
            rejected++;
          }
        });
        return { ...empty, rejected };
      }
      const message = typeof parsed?.message === 'string' ? parsed.message : undefined;
      if (rows.length === 1) {
        this.spool!.moveToRejected(rows[0], 400, message ?? 'validation_failed');
        return { ...empty, rejected: 1 };
      }
      this.spoolChunkSize = Math.max(1, Math.floor(rows.length / 2));
      return { ...empty };
    }

    if (status === 401 || status === 403) {
      return { ...empty, stop: 'auth_failed' };
    }

    if (status === 429) {
      const retryAfter = parseRetryAfterSeconds(headers);
      return { ...empty, stop: 'backoff', backoffSeconds: retryAfter };
    }

    if (status === 408 || (status >= 500 && status < 600)) {
      return { ...empty, stop: 'backoff' };
    }

    console.warn(`[AgentViewer] spool drain got an unexpected status ${status}; keeping the backlog and backing off.`);
    return { ...empty, stop: 'backoff' };
  }

  /** Drains the spool now, blocking up to `timeoutMs`. Never throws on a transient error. With the spool
   * disabled, returns all zeros with `state: 'disabled'`. */
  async flush(timeoutMs = 30_000): Promise<FlushResult> {
    if (!this.spool) {
      return { delivered: 0, remaining: 0, rejected: 0, timedOut: false, state: 'disabled' };
    }
    this.ensureDrainRunning();
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const result = await this.drainSession(deadline, true);
    return {
      delivered: result.delivered,
      remaining: this.spool.pendingCount(),
      rejected: result.rejected,
      timedOut: result.timedOut,
      state: this.spool.state,
    };
  }

  /** Final bounded flush attempt, then stops the background drain timer and releases the spool. Safe to
   * call more than once. With the spool disabled this is a no-op. */
  async close(timeoutMs = 5000): Promise<void> {
    if (!this.spool) {
      this.closed = true;
      return;
    }
    if (this.closed) return;
    this.closed = true;
    try {
      await this.flush(timeoutMs);
    } catch {
      // close() never throws
    }
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    if (typeof process !== 'undefined' && typeof process.off === 'function') {
      process.off('beforeExit', this.beforeExitFlush);
    }
    this.spool.close();
  }

  /** Snapshot of the spool's counters and backlog (issue #102). With the spool disabled, every counter is
   * `0` and `state` is `'disabled'`. */
  spoolStats(): SpoolStats {
    if (!this.spool) {
      return {
        state: 'disabled',
        pendingEvents: 0,
        pendingBytes: 0,
        oldestPendingAgeS: null,
        enqueuedTotal: 0,
        replayedTotal: 0,
        duplicatesAckedTotal: 0,
        droppedOverflowTotal: 0,
        droppedOverflowUsageTotal: 0,
        droppedSpoolErrorTotal: 0,
        droppedSpoolErrorUsageTotal: 0,
        rejectedTotal: 0,
        rejectedUsageTotal: 0,
        rejectedEvictedTotal: 0,
        corruptSpoolTotal: 0,
        lastError: null,
        lastSuccessAt: null,
      };
    }
    return this.spool.stats();
  }

  /** Dead-letter rows (newest first): events the server rejected outright during replay (issue #102). Empty
   * when the spool is disabled. */
  spoolRejected(limit = 100): SpoolRejectedRow[] {
    if (!this.spool) return [];
    return this.spool.rejected(limit);
  }

  async registerAgent(agent: {
    id: string;
    name: string;
    roleTitle?: string;
    provider?: string;
    model?: string;
    workspace?: string;
  }): Promise<void> {
    await this.emit({
      type: 'agent.registered',
      source: `agent:${agent.id}`,
      agentId: agent.id,
      summary: `Registered ${agent.name}`,
      payload: agent,
    });
  }

  async heartbeat(activeAgentsCount?: number): Promise<void> {
    await this.emit({
      type: 'runtime.heartbeat',
      source: this.source,
      summary: `Heartbeat from ${this.runtimeId ?? 'runtime'}`,
      payload: {
        runtimeId: this.runtimeId,
        status: 'healthy',
        activeAgentsCount,
      },
    });
  }

  async snapshot(): Promise<ViewerSnapshot> {
    const response = await fetch(`${this.url}/api/v1/snapshot`, {
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      throw new AgentViewerError(`Failed to fetch snapshot: ${response.status}`, response.status);
    }
    return (await response.json()) as ViewerSnapshot;
  }

  /**
   * `GET /api/v1/budgets` (issue #85, sub-issue #306): every configured budget with its `status` evaluated
   * fresh against the usage ledger (`ok`, `warning`, `exceeded` or `unknown`; `status: null` for a disabled
   * budget). `options.state` filters server side to one of the four states. Uses the same `getWithRetry` as
   * `listCalls()`/`usageRollup()`: 400/401/410 fail immediately, 429 and 5xx retry with backoff. Read only,
   * like the rest of the SDK: there is no helper here to create, update or delete a budget, since that is an
   * operator action, not something an agent should be able to do to itself.
   */
  async budgets(options?: BudgetsOptions): Promise<BudgetsResponse> {
    const search = new URLSearchParams();
    if (options?.state !== undefined) search.set('state', options.state);
    const query = search.toString();
    return this.getWithRetry(`/api/v1/budgets${query ? `?${query}` : ''}`) as Promise<BudgetsResponse>;
  }

  /**
   * Usage aggregates from `GET /api/v1/usage`, by agent and by `(provider, model)`. A token `sum` is `null` when
   * no call reported that kind, and costs are listed per currency and cost source, never added together.
   */
  async usageSummary(): Promise<UsageSummary> {
    const response = await fetch(`${this.url}/api/v1/usage`, {
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      throw new AgentViewerError(`Failed to fetch usage summary: ${response.status}`, response.status);
    }
    return (await response.json()) as UsageSummary;
  }

  /**
   * `GET /api/v1/whoami` (issue #107): the identity the configured credential authenticates as. Handy as a
   * startup check that a named key is still valid: `getWithRetry` already throws immediately (never retries) on
   * 401, with `error.code` set to the server's `key_revoked`/`key_expired` when that is why.
   */
  async whoami(): Promise<WhoamiResponse> {
    return this.getWithRetry('/api/v1/whoami') as Promise<WhoamiResponse>;
  }

  /**
   * One page of `GET /api/v1/usage/calls` (issue #67): metadata only (no prompt, completion, message or error
   * text), `null` left as `null` (never defaulted to `0`), never summed or priced by the SDK.
   */
  async listCalls(options: ListCallsOptions = {}): Promise<CallsPageResult> {
    const query = this.buildCallsQueryString(options);
    return this.getWithRetry(`/api/v1/usage/calls${query ? `?${query}` : ''}`) as Promise<CallsPageResult>;
  }

  /**
   * Walks every page of `listCalls` by following `page.nextCursor` until `hasMore` is `false`, yielding one
   * `CallRecord` at a time. Guards against a server bug that would otherwise loop forever: if a response's
   * `nextCursor` is identical to the cursor just used, this throws instead of repeating the same page.
   */
  async *iterateCalls(options: ListCallsOptions = {}): AsyncGenerator<CallRecord, void, undefined> {
    let cursor = options.cursor;
    while (true) {
      const page = await this.listCalls({ ...options, cursor });
      for (const call of page.data) yield call;
      if (!page.page.hasMore) return;
      const next = page.page.nextCursor;
      if (!next || next === cursor) {
        throw new AgentViewerError('Agent Viewer usage calls walk did not advance: the server returned the same cursor twice in a row.');
      }
      cursor = next;
    }
  }

  private buildCallsQueryString(options: ListCallsOptions): string {
    const params = new URLSearchParams();
    const appendRepeatable = (key: string, value: string | readonly string[] | undefined) => {
      if (value === undefined) return;
      for (const v of Array.isArray(value) ? value : [value]) params.append(key, v as string);
    };
    if (options.from !== undefined) params.set('from', String(options.from));
    if (options.to !== undefined) params.set('to', String(options.to));
    if (options.timeBasis !== undefined) params.set('timeBasis', options.timeBasis);
    appendRepeatable('agentId', options.agentId);
    appendRepeatable('sessionId', options.sessionId);
    appendRepeatable('runtimeId', options.runtimeId);
    appendRepeatable('taskId', options.taskId);
    appendRepeatable('provider', options.provider);
    appendRepeatable('model', options.model);
    appendRepeatable('status', options.status);
    appendRepeatable('costSource', options.costSource as string | readonly string[] | undefined);
    appendRepeatable('currency', options.currency);
    appendRepeatable('requestId', options.requestId);
    if (options.traceId !== undefined) params.set('traceId', options.traceId);
    if (options.order !== undefined) params.set('order', options.order);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.cursor !== undefined) params.set('cursor', options.cursor);
    return params.toString();
  }

  /**
   * Shared GET helper for read endpoints that need retry and error mapping (issue #67; `snapshot()` and
   * `usageSummary()` predate it and keep their own simpler fetch). Sends the token only in the `Authorization`
   * header, never in the URL. 400, 401 and 410 fail immediately (not retried); 429 and 5xx are retried with the
   * same backoff as `postWithRetry`, since a GET is always safe to repeat.
   */
  private async getWithRetry(path: string): Promise<unknown> {
    let attempt = 0;
    let delay = 300;

    while (true) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        const response = await fetch(`${this.url}${path}`, {
          method: 'GET',
          headers: this.buildHeaders(),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.ok) return await response.json();

        const responseText = await response.text();
        let parsedJson: any = null;
        try {
          parsedJson = JSON.parse(responseText);
        } catch {
          // not json
        }
        const code = typeof parsedJson?.error === 'string' ? parsedJson.error : undefined;

        if (response.status < 500 && response.status !== 429) {
          throw new AgentViewerError(
            parsedJson?.message || `Agent Viewer rejected request: ${response.status} ${responseText}`,
            response.status,
            parsedJson?.issues,
            code
          );
        }

        attempt++;
        if (attempt > this.maxRetries) {
          throw new AgentViewerError(
            `Agent Viewer request failed after ${this.maxRetries} retries: ${response.status} ${responseText}`,
            response.status,
            undefined,
            code
          );
        }
        if (this.debug) {
          console.warn(`[AgentViewer] Request failed with ${response.status}, retrying in ${delay}ms... (attempt ${attempt}/${this.maxRetries})`);
        }
        await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 100));
        delay = Math.min(delay * 2, 5000);
      } catch (err: any) {
        if (err instanceof AgentViewerError) throw err;

        attempt++;
        if (attempt > this.maxRetries) {
          throw new AgentViewerError(`Agent Viewer network error after ${this.maxRetries} retries: ${err.message}`);
        }
        if (this.debug) {
          console.warn(`[AgentViewer] Network error (${err.message}), retrying in ${delay}ms...`);
        }
        await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 100));
        delay = Math.min(delay * 2, 5000);
      }
    }
  }

  /**
   * `GET /api/v1/usage/rollup` (issue #66): grouped sums over the usage ledger, for an audit question such as
   * "how much did agent X spend with model Y this week". The token always goes in the `Authorization` header,
   * never the URL; repeated filters (`agentId`, `tag`, ...) are sent as repeated query params, never joined with
   * commas. Uses the same `getWithRetry` as `listCalls()` (issue #67): 400/401/410 fail immediately, 429 and 5xx
   * retry with backoff.
   */
  async usageRollup(params: UsageRollupParams): Promise<UsageRollupResponse> {
    const search = new URLSearchParams();
    search.set('groupBy', params.groupBy.join(','));
    if (params.from !== undefined) search.set('from', formatRollupDateParam(params.from));
    if (params.to !== undefined) search.set('to', formatRollupDateParam(params.to));
    if (params.timeBasis !== undefined) search.set('timeBasis', params.timeBasis);
    if (params.utcOffsetMinutes !== undefined) search.set('utcOffsetMinutes', String(params.utcOffsetMinutes));
    if (params.sort !== undefined) search.set('sort', params.sort);
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    if (params.asOfSeq !== undefined) search.set('asOfSeq', String(params.asOfSeq));
    appendRepeatableParam(search, 'agentId', params.agentId);
    appendRepeatableParam(search, 'model', params.model);
    appendRepeatableParam(search, 'provider', params.provider);
    appendRepeatableParam(search, 'sessionId', params.sessionId);
    appendRepeatableParam(search, 'taskId', params.taskId);
    appendRepeatableParam(search, 'runtimeId', params.runtimeId);
    appendRepeatableParam(search, 'userId', params.userId);
    appendRepeatableParam(search, 'tag', params.tag);
    appendRepeatableParam(search, 'status', params.status);
    appendRepeatableParam(search, 'costSource', params.costSource);
    appendRepeatableParam(search, 'currency', params.currency);

    return this.getWithRetry(`/api/v1/usage/rollup?${search.toString()}`) as Promise<UsageRollupResponse>;
  }

  private buildHeaders(idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.token) {
      headers['authorization'] = `Bearer ${this.token}`;
    }
    if (idempotencyKey) {
      headers['idempotency-key'] = idempotencyKey;
    }
    return headers;
  }

  private async postWithRetry(endpoint: string, body: unknown, idempotencyKey?: string): Promise<any> {
    let attempt = 0;
    let delay = 300;

    while (attempt <= this.maxRetries) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(`${this.url}${endpoint}`, {
          method: 'POST',
          headers: this.buildHeaders(idempotencyKey),
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok || response.status === 200 || response.status === 202) {
          return await response.json();
        }

        const responseText = await response.text();
        let parsedJson: any = null;
        try {
          parsedJson = JSON.parse(responseText);
        } catch {
          // not json
        }

        const code = typeof parsedJson?.error === 'string' ? parsedJson.error : undefined;

        // Client errors (4xx except 408/429) fail immediately and are never queued: replaying one could
        // never succeed. 408 is retried (issue #102): the server never finished reading the request, exactly
        // as safe to retry as a network timeout. A 409 conflicting_duplicate is final either way.
        if (response.status < 500 && response.status !== 429 && response.status !== 408) {
          throw new AgentViewerError(
            parsedJson?.message || `Agent Viewer rejected request: ${response.status} ${responseText}`,
            response.status,
            parsedJson?.issues || parsedJson?.errors,
            code
          );
        }

        // Retryable server error, 408 or 429
        attempt++;
        if (attempt > this.maxRetries) {
          throw new AgentViewerError(
            `Agent Viewer request failed after ${this.maxRetries} retries: ${response.status} ${responseText}`,
            response.status,
            undefined,
            code,
            true
          );
        }

        if (this.debug) {
          console.warn(`[AgentViewer] Request failed with ${response.status}, retrying in ${delay}ms... (attempt ${attempt}/${this.maxRetries})`);
        }

        await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 100));
        delay = Math.min(delay * 2, 5000);
      } catch (err: any) {
        if (err instanceof AgentViewerError) {
          throw err;
        }

        attempt++;
        if (attempt > this.maxRetries) {
          throw new AgentViewerError(
            `Agent Viewer network error after ${this.maxRetries} retries: ${err.message}`,
            undefined,
            undefined,
            undefined,
            true
          );
        }

        if (this.debug) {
          console.warn(`[AgentViewer] Network error (${err.message}), retrying in ${delay}ms...`);
        }

        await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 100));
        delay = Math.min(delay * 2, 5000);
      }
    }
  }
}

// Backward compatibility alias
export { AgentViewer as AgentViewerClient };
export default AgentViewer;
