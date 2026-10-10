/**
 * Pure mapper from the server's usage read APIs (`GET /api/v1/usage/rollup`, issue #66, and
 * `GET /api/v1/usage/calls`, issue #67) to the embeddable library's display types (`OfficeUsage` and
 * `AgentCallDetails`, issues #76/#77/#78). All server-shape knowledge lives in this one file: `HostOffice.tsx`
 * never reads a rollup or calls field directly, it only calls `rollupToUsage`/`callsToDetail`.
 *
 * No arithmetic, no coercion. Every figure here is either copied unchanged from the server response or set to
 * `null` when the server did not fully report it for every call being summarized. Neither `rollupToUsage` nor
 * `callsToDetail` adds, subtracts, multiplies, divides or invents a number; `tests/lib/libraryHost.test.ts`
 * checks this on the TypeScript AST, not by grepping text.
 *
 * `totalTokens` note: the shipped rollup response has no single combined token field, only a per-kind
 * breakdown (`tokens.input.sum`, `tokens.output.sum`, ...), each already summed server-side with its own
 * `unreportedCalls` count. The library's `UsageFigures.totalTokens` drives the compact usage badge's headline
 * number. Computing it here as `input.sum + output.sum` would be exactly the client-side arithmetic this
 * mapper must not do, so `totalTokens` stays `null` (shown as "unknown" on the badge) until the rollup API
 * grows a combined field; see the follow-up filed against the rollup API from issue #260. The per-kind
 * breakdown (`inputTokens`, `outputTokens`, ...) is still copied field by field, so the full usage panel and
 * the call detail panel show real figures.
 */
import type { OfficeUsage, UsageFigures, UsageCostSource } from '../../src/lib/usage';
import type { AgentCallDetail, AgentCallDetails, AgentCallStatus, AgentCallTokens } from '../../src/lib/callDetails';

// -------------------------------------------------------------
// Server response shapes. Only the fields this file reads: the full contracts live in
// `server/usage/types.ts` (`UsageRollupResponse`, `CallRecord`).
// -------------------------------------------------------------

export interface RollupTokenKindFigure {
  sum: number | null;
  reportedCalls: number;
  unreportedCalls: number;
}

export interface RollupTokens {
  input: RollupTokenKindFigure;
  output: RollupTokenKindFigure;
  cacheRead: RollupTokenKindFigure;
  cacheWrite: RollupTokenKindFigure;
  reasoning: RollupTokenKindFigure;
}

export interface RollupCostEntry {
  currency: string | null;
  costSource: UsageCostSource;
  sum: number;
  calls: number;
}

export interface RollupCost {
  entries: RollupCostEntry[];
  unknownCostCalls: number;
}

export interface RollupTotals {
  calls: { total: number; succeeded: number; failed: number };
  tokens: RollupTokens;
  cost: RollupCost;
}

export interface RollupGroup extends RollupTotals {
  /** `{ agent: "builder" }`, or `{ agent: null }` for calls with no attributable agent. */
  key: Record<string, string | null>;
}

export interface RollupResponse {
  groups: RollupGroup[];
  totals: RollupTotals;
}

export type CallStatus =
  | 'ok'
  | 'rate_limited'
  | 'overloaded'
  | 'timeout'
  | 'invalid_request'
  | 'auth'
  | 'server_error'
  | 'cancelled'
  | 'network'
  | 'unknown';

export interface CallTokenFigures {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
}

export interface CallRecord {
  eventId: string;
  agentId: string | null;
  provider: string | null;
  model: string | null;
  status: CallStatus;
  tokens: CallTokenFigures;
  latencyMs: number | null;
  requestId: string | null;
  cost: number | null;
  currency: string | null;
  costSource: UsageCostSource;
}

export interface CallsResponse {
  data: CallRecord[];
}

// -------------------------------------------------------------
// rollupToUsage
// -------------------------------------------------------------

/** One token kind, copied unchanged: `null` the moment any call in the group did not report it, never a
 * partial sum passed off as complete. */
function tokenKindFigure(kind: RollupTokenKindFigure): number | null {
  if (kind.unreportedCalls > 0) return null;
  return kind.sum;
}

/** `cost`/`currency` are copied only when the group has exactly one cost entry and no unknown-cost call.
 * More than one entry (mixed currency or cost source) or any unknown-cost call makes the figure `null`: a
 * partial or cross-currency sum is never shown as the group's cost. */
function costFigures(totals: RollupTotals): Pick<UsageFigures, 'cost' | 'currency' | 'costSource'> {
  if (totals.cost.entries.length !== 1 || totals.cost.unknownCostCalls > 0) {
    return { cost: null, currency: null, costSource: null };
  }
  const [entry] = totals.cost.entries;
  return { cost: entry.sum, currency: entry.currency, costSource: entry.costSource };
}

function totalsToFigures(totals: RollupTotals): UsageFigures {
  return {
    // See the module doc comment: the rollup response has no single combined token field.
    totalTokens: null,
    inputTokens: tokenKindFigure(totals.tokens.input),
    outputTokens: tokenKindFigure(totals.tokens.output),
    cacheReadTokens: tokenKindFigure(totals.tokens.cacheRead),
    cacheWriteTokens: tokenKindFigure(totals.tokens.cacheWrite),
    reasoningTokens: tokenKindFigure(totals.tokens.reasoning),
    ...costFigures(totals),
    failedCalls: totals.calls.failed > 0 ? totals.calls.failed : null,
  };
}

/** `null` for the no-agent bucket (`key.agent` absent, `null` or empty): such calls still count in `total`,
 * read from the response's own `totals`, but get no `byAgent` entry of their own. */
function agentKey(group: RollupGroup): string | null {
  const value = group.key.agent;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * `rollup` must come from a `groupBy=agent` (or `groupBy=agent,...` with `agent` the only dimension that
 * varies across groups) request. An agent absent from `rollup.groups` gets no `byAgent` entry, which the
 * library then renders as no badge at all, never a stale or zero figure.
 */
export function rollupToUsage(rollup: RollupResponse): OfficeUsage {
  const byAgent: Record<string, UsageFigures> = {};
  for (const group of rollup.groups) {
    const agentId = agentKey(group);
    if (agentId === null) continue;
    byAgent[agentId] = totalsToFigures(group);
  }
  return { total: totalsToFigures(rollup.totals), byAgent };
}

// -------------------------------------------------------------
// callsToDetail
// -------------------------------------------------------------

/** The library's `AgentCallStatus` is coarser than the ledger's `CallStatus`: every `llm.failed` error kind
 * other than `rate_limited` maps to the generic `failed`, since the detail panel shows only outcome, not the
 * error taxonomy (that stays in `errorCode`, which this mapper does not expose). */
function callStatus(status: CallStatus): AgentCallStatus {
  if (status === 'ok') return 'ok';
  if (status === 'rate_limited') return 'rate_limited';
  return 'failed';
}

function callTokens(tokens: CallTokenFigures): AgentCallTokens {
  return {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    reasoning: tokens.reasoning,
  };
}

/**
 * `calls` must come from `GET /api/v1/usage/calls` filtered to the agents the host wants a detail panel for.
 * A call with no `agentId` is dropped: the library's `AgentCallDetails` is keyed by agent, and there is no
 * "unattributed" bucket for it to render. Calls keep the server's own order (newest first by default).
 */
export function callsToDetail(calls: CallsResponse): AgentCallDetails {
  const byAgent: Record<string, AgentCallDetail[]> = {};
  for (const call of calls.data) {
    const agentId = call.agentId;
    if (agentId === null || agentId.length === 0) continue;
    const detail: AgentCallDetail = {
      id: call.eventId,
      provider: call.provider,
      model: call.model,
      tokens: callTokens(call.tokens),
      requestId: call.requestId,
      latencyMs: call.latencyMs,
      status: callStatus(call.status),
      costSource: call.costSource,
      cost: call.cost,
      currency: call.currency,
    };
    if (byAgent[agentId] === undefined) byAgent[agentId] = [];
    byAgent[agentId].push(detail);
  }
  return byAgent;
}
