/**
 * Shared types for the usage ledger read APIs (issue #67, "Calls API"; shared with issue #66, "Rollup API",
 * whichever lands first owns this module per both issues' own text). Everything here is derived from the
 * ledger shipped by issue #65 (`server/usageLedger.ts`), never re-derived from `events`.
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
 * across keys / OR within a repeated key semantics, enforced identically in SQL (`buildListCallsQuery`,
 * `server/usage/calls.ts`) and in memory (`matchesUsageFilters`). `requestId` and `traceId` are calls-only
 * (section 2 of issue #67): `parseUsageFilters` rejects them as unknown parameters when its caller passes
 * `allowCallsOnly: false`, so they are always empty/`null` on a rollup query.
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
  };
}
