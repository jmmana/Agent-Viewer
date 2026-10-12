/**
 * Structural copies of the server and contract types the SDK reads or sends (issue #343).
 *
 * The published package must not depend on `src/integrations/*`, `server/*` or zod, not even through
 * `import type`: a consumer's `tsc` would then need those files. So every shape the SDK exposes is copied here.
 * `test/contract-drift.ts` (type-checked by the repository's `npm run lint`, never published) asserts each copy
 * against its source, so a renamed or retyped field fails the build instead of drifting silently.
 */

// -------------------------------------------------------------
// Canonical event contract (`src/integrations/canonicalTypes.ts`)
// -------------------------------------------------------------

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
  | 'budget.alert';

export type EventSeverity = 'low' | 'normal' | 'high' | 'critical';

/** Why a model call failed, carried by `llm.failed`. Unrecognized errors map to `unknown`. */
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
}

/** Where a reported cost comes from. The SDK never chooses it for the caller. */
export type CostSource = 'provider-reported' | 'estimated' | 'unknown';

/** Correlation fields of `llm.usage` and `llm.failed` as the contract accepts them (issue #64). */
export interface UsageCorrelationInput {
  traceId?: string | null;
  parentId?: string | null;
  toolCallId?: string | null;
  meetingId?: string | null;
  userId?: string | null;
  tags?: string[] | null;
}

/** `llm.usage` payload as the contract accepts it (the input side of `LlmUsagePayloadSchema`). */
export interface LlmUsagePayloadInput extends UsageCorrelationInput {
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
}

/** `llm.failed` payload as the contract accepts it (the input side of `LlmFailedPayloadSchema`). */
export interface LlmFailedPayloadInput extends UsageCorrelationInput {
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
}

// -------------------------------------------------------------
// Usage figures of the embeddable office (`src/lib/usage.ts`)
// -------------------------------------------------------------

/** Usage figures exactly as the host knows them. A missing value is shown as "unknown", never as zero. */
export interface UsageFigures {
  totalTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Input tokens served from a provider cache instead of processed fresh. */
  cacheReadTokens?: number | null;
  /** Input tokens written to a provider cache for later reuse. */
  cacheWriteTokens?: number | null;
  /** Hidden "thinking" tokens some providers bill as output. */
  reasoningTokens?: number | null;
  cost?: number | null;
  /** ISO 4217 code such as `USD`. Without it the cost is shown as a plain number. */
  currency?: string | null;
  /** Where the cost figure came from. `null` or an unrecognized value is shown as unknown. */
  costSource?: CostSource | null;
  /** Count of failed model call attempts. */
  failedCalls?: number | null;
}

// -------------------------------------------------------------
// Usage summary (`server/usageAggregates.ts`)
// -------------------------------------------------------------

export type TokenKind = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning';

/** Sum of the calls that reported this token kind. `sum` is null when no call in the bucket reported it. */
export interface TokenFigure {
  sum: number | null;
  /** Calls in the bucket whose payload omitted the field (undefined, null or an invalid value). */
  unreportedCount: number;
}

/** Cost for one (currency, costSource) pair. Amounts of different pairs are never added together. */
export interface CurrencyCost {
  /** ISO 4217 code exactly as reported. */
  currency: string;
  costSource: CostSource;
  /** Convenience value, `Number(amountExact)`. */
  amount: number;
  /** Exact decimal string accumulated in fixed point (nano units), without trailing zeros. */
  amountExact: string;
  /** Calls that contributed to this pair. */
  calls: number;
}

export interface UsageBucket {
  /** Events reduced into this bucket. */
  calls: number;
  tokens: Record<TokenKind, TokenFigure>;
  /** Sorted by currency, then costSource (code-unit order). */
  byCurrency: CurrencyCost[];
  /** `costMissingCount + currencyMissingCount`. */
  costUnknownCount: number;
  /** Calls whose cost was undefined, null, negative or not finite. */
  costMissingCount: number;
  /** Calls with a valid cost but a currency that is missing or not an ISO 4217 shape (`/^[A-Z]{3}$/`). */
  currencyMissingCount: number;
  /** Smallest `event.timestamp` in the bucket (client clock). */
  firstTimestamp: number | null;
  /** Largest `event.timestamp` in the bucket (client clock). */
  lastTimestamp: number | null;
}

/** Successful calls (`llm.usage`) at the top level, failed calls (`llm.failed`) kept apart. */
export interface UsageAggregate extends UsageBucket {
  failed: UsageBucket;
}

export interface ModelUsage extends UsageAggregate {
  /** The provider of the call itself, never the agent's current provider. */
  provider: string | null;
  /** The model of the call itself, never the agent's current model. */
  model: string | null;
}

export interface AgentUsage extends UsageAggregate {
  /** `null` groups the calls without an agent (runtime or system level). */
  agentId: string | null;
  byModel: ModelUsage[];
}

export interface UsageSummary {
  schemaVersion: '1.0';
  /** `llm.usage` and `llm.failed` events applied. */
  eventsReduced: number;
  total: UsageAggregate;
  /** Sorted by provider, then model, nulls last. */
  byModel: ModelUsage[];
  /** Sorted by agentId, null last. */
  byAgent: AgentUsage[];
}

// -------------------------------------------------------------
// Snapshot (`server/store.ts`, `server/serverState.ts`)
// -------------------------------------------------------------

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
  /** @deprecated Use the usage summary. Sum of reported input tokens only. */
  tokensInput: number;
  /** @deprecated Use the usage summary. Sum of reported output tokens only. */
  tokensOutput: number;
  /** @deprecated Use the usage summary. Sum of reported cache-read tokens only. */
  cachedTokens: number;
  /** @deprecated Use the usage summary. Sum of reported reasoning tokens only. */
  reasoningTokens: number;
  /** @deprecated Use the usage summary (`byAgent[].byCurrency`). */
  cost: number | null;
  lastSeenAt: number;
}

export interface UsageDuplicateStats {
  /** Every stored duplicate reference. */
  count: number;
  /** `matchesOriginal === false`. */
  mismatched: number;
  /** `matchesOriginal === null` (rows migrated from 0.2.x). Never counted as matched or mismatched. */
  unverified: number;
}

export interface SnapshotRetention {
  /** Store backend that produced this snapshot. */
  storage: 'memory' | 'sqlite';
  /** Cap on events kept for listing and replay. `null` when the store keeps every event. */
  maxEvents: number | null;
  /** Events currently available to `GET /api/v1/events` and SSE replay. */
  retainedEvents: number;
  /** Events accepted since `totalsSince`, including dropped ones. Duplicates are never counted. */
  acceptedEvents: number;
  /** Accepted events no longer retained. `0` means the event list is complete since `totalsSince`. */
  droppedEvents: number;
  /** Server receive time (ms) of the oldest retained event when `droppedEvents > 0`; `null` when nothing was dropped. */
  since: number | null;
  /** Server time (ms) from which totals and per-agent figures are counted. */
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
  /** Canonical usage figures, aggregated call by call. Same object as `GET /api/v1/usage`. */
  usage: UsageSummary;
  /** Counts of request-id duplicate references (issue #48). Never includes a duplicate's tokens or cost. */
  usageDuplicates: UsageDuplicateStats;
  /** @deprecated Use usage.total.tokens. Sum of reported values only. */
  totalTokens: {
    input: number;
    output: number;
    cached: number;
    reasoning: number;
  };
  /** @deprecated Use usage.total.byCurrency. */
  totalCost: number | null;
  /** Retained window size: capped in memory mode, the true row count in SQLite mode. */
  eventsCount: number;
  events: CanonicalEvent[];
  /** No silent loss, no double counting (issue #53): tells a reader whether the list above is complete. */
  retention: SnapshotRetention;
}

// -------------------------------------------------------------
// Calls and rollup (`server/usage/types.ts` and its dependencies)
// -------------------------------------------------------------

export type LedgerEventType = 'llm.usage' | 'llm.failed';

export type EstimateStatus =
  | 'estimated'
  | 'no_price_in_force'
  | 'no_price_for_model'
  | 'no_price_for_component'
  | 'missing_usage'
  | 'inconsistent_usage'
  | 'failed';

/** Every `EstimateStatus` plus `not_estimated`, for a row written before estimates existed (issue #295). */
export type CallEstimateStatus = EstimateStatus | 'not_estimated';

export type EstimateBasisMode = 'latest' | 'original' | 'asOfRevision';

export interface EstimateBasis {
  mode: EstimateBasisMode;
  /** The `N` of `estimateRevision=N`; `null` for `latest`/`original`. */
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

/** `'ok'` for a successful `llm.usage` row, otherwise the `llm.failed` row's `errorKind`. */
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

/** One ledger row, metadata only (issue #67). */
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

/** `'received'` (server receive time) is the default so an audit never depends on a client clock. */
export type TimeBasis = 'received' | 'occurred';

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

export type ToolAttributionState = 'attributed' | 'unattributed' | 'unresolved' | 'ambiguous';
export type MeetingAttributionState = 'attributed' | 'unattributed';

export interface ReliabilityLatency {
  p50Ms: number | null;
  p95Ms: number | null;
  samples: number;
  missing: number;
  method: 'nearest-rank';
}

export interface ReliabilityFailures {
  byErrorKind: Record<string, number>;
  rateLimitCount: number;
}

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

/** One currency's summed estimate (issue #295), never converted and never merged across currencies. */
export interface EstimatedCostEntry {
  currency: string;
  cost: number;
  calls: number;
  pricingVersions: number[];
}

/** Reported vs. estimated for rows that have both, in the same currency. `delta = estimatedCost - reportedCost`. */
export interface ComparableEntry {
  currency: string;
  calls: number;
  reportedCost: number;
  estimatedCost: number;
  delta: number;
}

export interface UsageRollupTotals {
  calls: { total: number; succeeded: number; failed: number };
  tokens: Record<TokenKind, TokenKindRollup>;
  cost: { entries: CostEntry[]; unknownCostCalls: number };
  estimated: EstimatedCostEntry[];
  estimatedUnknownCalls: number;
  estimatedUnknownByStatus: Partial<Record<CallEstimateStatus, number>>;
  estimatedComplete: boolean;
  comparable: ComparableEntry[];
  /** On the selected time basis. */
  firstAt: number | null;
  lastAt: number | null;
  /** Present only when the request's `include` contains `failures`. */
  failedCalls?: number;
  attempts?: number;
  failureRate?: number | null;
  failures?: ReliabilityFailures;
  /** Present only when `include` contains `latency`. */
  latency?: ReliabilityLatency;
}

/** A group's key: `{ [dimensionName]: value }`, except `meeting`, keyed `meetingId` (plus `title`). */
export type RollupGroupKey = Record<string, string | null>;

export interface UsageRollupGroup extends UsageRollupTotals {
  key: RollupGroupKey;
  /** Only present when `groupBy` includes `day`: epoch ms, inclusive. */
  bucketStart?: number;
  /** Only present when `groupBy` includes `day`: epoch ms, exclusive. */
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
  /** `false` when rows that could belong to the query may be gone. Never silently partial. */
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
  /** `false` only when `groupBy` includes `tag`. */
  groupsAreAdditive: boolean;
  groupCount: number;
  truncated: boolean;
  groups: UsageRollupGroup[];
  totals: UsageRollupTotals;
}

// -------------------------------------------------------------
// Budgets (`server/budgets.ts`, issue #85)
// -------------------------------------------------------------

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
  /** `null` only when `type` is `'all'`. */
  value: string | null;
}

export interface Budget {
  id: string;
  name: string;
  scope: BudgetScope;
  period: BudgetPeriod;
  /** IANA timezone name. Defines where a day, week or month starts. */
  timezone: string;
  /** ISO 4217 code. */
  currency: string;
  basis: BudgetBasis;
  limit: number;
  warningRatio: number;
  enabled: boolean;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** `status` is `null` exactly when `enabled` is `false`: a disabled budget is never evaluated. */
export type BudgetView = Budget & { status: BudgetStatus | null };

export interface BudgetWindow {
  /** Epoch ms, inclusive. */
  start: number;
  /** Epoch ms, exclusive. */
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
  /** `null` whenever the figure is incomplete: an unknown spend is never shown as zero. */
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
