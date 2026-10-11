/**
 * Budgets (issue #85): a `Budget` is configuration an operator writes; a `BudgetStatus` is computed fresh on
 * every read, from the same ledger rows an auditor can export, and is never itself a source of truth.
 *
 * This module is sub-issue #302 of #85: the pure evaluation engine only (types, window math and
 * `evaluateBudget`). It has no HTTP route, no storage and no SSE wiring; those are later sub-issues (#303
 * storage, #304 API, #305 live transitions, #306 SDKs, #307 docs/benchmark). `server/budgets.ts` is still the
 * file #85 itself names for all of that: the registry and the route wiring are added to this same file by the
 * later sub-issues, on top of what ships here.
 *
 * Field names for the ledger columns this engine reads (reported cost, estimated cost, cost currency, pricing
 * version, `userId`, `tags`, `agentId`, `sessionId`, model, received-at) come from issues #64, #65 and #84
 * (`server/usageLedger.ts`, `server/pricing/estimate.ts`). This module consumes them through `BudgetLedgerRow`
 * (a `Pick` of the real `UsageLedgerRow`, so a renamed or removed column fails to compile here instead of
 * silently drifting) and never redefines or re-derives them: it never recomputes a cost from token columns, and
 * it never reads the running per-agent counters at `server/store.ts:388-403` (the whole reason this engine
 * exists is that those counters already report `0` for an unknown cost, the "never show an unknown figure as
 * zero" rule this engine must not repeat, README.md:719).
 */
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { UsageLedgerRow, CostSource } from './usageLedger';
import { nanoToDecimalCost } from './pricing/estimate';

// -------------------------------------------------------------
// 1. Configuration types (issue #85, section 1)
// -------------------------------------------------------------

export type BudgetScopeType = 'all' | 'agent' | 'model' | 'session' | 'user' | 'tag';

export const BUDGET_SCOPE_TYPES: readonly BudgetScopeType[] = ['all', 'agent', 'model', 'session', 'user', 'tag'];

export function isBudgetScopeType(value: unknown): value is BudgetScopeType {
  return typeof value === 'string' && (BUDGET_SCOPE_TYPES as readonly string[]).includes(value);
}

export type BudgetPeriod = 'day' | 'week' | 'month';

export const BUDGET_PERIODS: readonly BudgetPeriod[] = ['day', 'week', 'month'];

export function isBudgetPeriod(value: unknown): value is BudgetPeriod {
  return typeof value === 'string' && (BUDGET_PERIODS as readonly string[]).includes(value);
}

export type BudgetBasis = 'reported' | 'reported_plus_estimated';

export const BUDGET_BASES: readonly BudgetBasis[] = ['reported', 'reported_plus_estimated'];

export function isBudgetBasis(value: unknown): value is BudgetBasis {
  return typeof value === 'string' && (BUDGET_BASES as readonly string[]).includes(value);
}

export type BudgetState = 'ok' | 'warning' | 'exceeded' | 'unknown';

export const BUDGET_STATES: readonly BudgetState[] = ['ok', 'warning', 'exceeded', 'unknown'];

export function isBudgetState(value: unknown): value is BudgetState {
  return typeof value === 'string' && (BUDGET_STATES as readonly string[]).includes(value);
}

export type BudgetUnknownReason =
  | 'unknown_cost'
  | 'currency_mismatch'
  | 'missing_currency'
  | 'history_truncated'
  | 'evaluation_error';

export const BUDGET_UNKNOWN_REASONS: readonly BudgetUnknownReason[] = [
  'unknown_cost',
  'currency_mismatch',
  'missing_currency',
  'history_truncated',
  'evaluation_error',
];

export interface BudgetScope {
  type: BudgetScopeType;
  /** `null` only when `type` is `'all'`. 1..200 chars otherwise, matched exactly and case sensitively against
   * the stored ledger value: no trim, no case fold. */
  value: string | null;
}

export interface Budget {
  /** `"bud_" + UUID` when not supplied on create. Never reused, even for a deleted budget (#303). */
  id: string;
  /** 1..120 chars. */
  name: string;
  scope: BudgetScope;
  period: BudgetPeriod;
  /** IANA name accepted by `Intl.DateTimeFormat`. Default `"UTC"`. Defines where a day, week or month starts. */
  timezone: string;
  /** ISO 4217, `^[A-Z]{3}$` (same pattern as `src/integrations/canonicalContract.ts`'s `currencySchema`). */
  currency: string;
  basis: BudgetBasis;
  /** Finite, `> 0`, `<= 1e12`, in `currency`. */
  limit: number;
  /** `0 < x < 1`. Default `0.8`. Warning starts at `limit * warningRatio`. */
  warningRatio: number;
  enabled: boolean;
  /** Starts at `1`, `+1` on every change (#303). */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** What the API returns for a budget (#304). `status` is `null` exactly when `enabled` is `false`: a disabled
 * budget is never evaluated. */
export type BudgetView = Budget & { status: BudgetStatus | null };

export interface BudgetWindow {
  /** Epoch ms, inclusive. */
  start: number;
  /** Epoch ms, exclusive. `end - start` is not constant across a DST change. */
  end: number;
}

export interface BudgetCallCounts {
  /** In-scope, in-window `llm.usage` rows plus in-scope, in-window `llm.failed` rows that carry a cost.
   * Invariant: `total === withCost + unknownCost + otherCurrency + missingCurrency`. */
  total: number;
  withCost: number;
  unknownCost: number;
  otherCurrency: number;
  missingCurrency: number;
}

export interface BudgetStatus {
  state: BudgetState;
  window: BudgetWindow;
  /** `null` whenever the figure is incomplete: an unknown spend is never shown as zero or as a complete number. */
  spent: number | null;
  spentComplete: boolean;
  /** The sum of every in-scope, in-window call that has a usable cost in the budget's own currency: a true
   * lower bound, always a number (never `null`), even when the budget is `unknown`. */
  knownSpent: number;
  /** `reported + estimated === knownSpent` (checked at 1e-8). */
  breakdown: { reported: number; estimated: number };
  containsEstimates: boolean;
  /** `limit - spent`; `null` exactly when `spent` is `null`. Negative once exceeded. */
  limitRemaining: number | null;
  /** `spent / limit`; `null` exactly when `spent` is `null`. */
  ratio: number | null;
  calls: BudgetCallCounts;
  /** Empty exactly when every in-scope call was countable and history is complete; may still be non-empty with
   * `state: "exceeded"` (rule 5: a provable breach is reported even while other calls remain unknown). */
  unknownReasons: BudgetUnknownReason[];
  /** Distinct price-table versions behind the estimated part of `knownSpent`, sorted ascending. */
  pricingVersions: number[];
  evaluatedAt: number;
}

// -------------------------------------------------------------
// 2. Window computation (issue #85, section 2 rule 1): day / ISO week (Monday start) / calendar month, in an
//    arbitrary IANA timezone, correct across a DST change, using only `Intl.DateTimeFormat` (no new dependency).
// -------------------------------------------------------------

const DAY_MS = 86_400_000;

/** The timezone's offset at instant `ts`, in minutes, defined so that `local = utc + offset`: for example
 * `America/Mexico_City` (UTC-6) returns `-360`. Implemented by reading the zone's own wall-clock fields for
 * `ts` and comparing them, as if they were UTC, against `ts` itself; this is the standard `Intl`-only technique
 * for inverting a timezone offset with no extra dependency. */
function offsetMinutesAt(ts: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ts))) parts[part.type] = part.value;
  // `hourCycle: 'h23'` can still print "24" for midnight on some engines; normalize defensively.
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  // Rounded to the nearest whole minute: every real IANA offset is a whole number of minutes, and `ts` itself
  // is not always an exact second boundary (the gap-search bisection below probes arbitrary millisecond
  // instants), which would otherwise leave a sub-minute floating remainder that breaks exact equality checks.
  return Math.round((asIfUtc - ts) / 60_000);
}

/**
 * The real instant whose wall clock in `timeZone` reads `year-month-day hour:minute:second`, resolving the two
 * DST edge cases the issue calls out by name:
 *
 * - **Gap** (the wall clock never happens, a spring-forward skipping it): returns the first valid instant at or
 *   after it, found by bisecting the `+-24h` bracket around the naive guess for the exact transition instant.
 * - **Ambiguous** (the wall clock happens twice, a fall-back repeating it): returns the earlier of the two real
 *   instants.
 *
 * Assumes at most one transition inside any `+-24h` window around the requested wall clock, true for every real
 * IANA zone transition (the rare, decades-old exceptions, such as a zone skipping a whole calendar day, are out
 * of scope: this engine targets the DST transitions operators actually configure a budget's `timezone` against).
 */
function resolveLocalWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): number {
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetBefore = offsetMinutesAt(naiveUtc - DAY_MS, timeZone);
  const offsetAfter = offsetMinutesAt(naiveUtc + DAY_MS, timeZone);

  if (offsetBefore === offsetAfter) {
    // No transition within a day of this wall clock: the ordinary, overwhelmingly common case.
    return naiveUtc - offsetBefore * 60_000;
  }

  const candidateBefore = naiveUtc - offsetBefore * 60_000;
  const candidateAfter = naiveUtc - offsetAfter * 60_000;
  const validBefore = offsetMinutesAt(candidateBefore, timeZone) === offsetBefore;
  const validAfter = offsetMinutesAt(candidateAfter, timeZone) === offsetAfter;

  if (validBefore && validAfter) {
    // Ambiguous: both the pre- and post-transition offset reconstruct this exact wall clock as a real instant
    // (a fall-back repeating the hour). The rule picks the earlier one.
    return Math.min(candidateBefore, candidateAfter);
  }
  if (validBefore) return candidateBefore;
  if (validAfter) return candidateAfter;

  // Gap: this wall clock does not exist (a spring-forward skipping it). Bisect the +-24h bracket for the exact
  // transition instant and return it, the first valid instant at or after the nominal (nonexistent) one.
  let lo = naiveUtc - DAY_MS; // offset here is offsetBefore
  let hi = naiveUtc + DAY_MS; // offset here is offsetAfter
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetMinutesAt(mid, timeZone) === offsetBefore) lo = mid;
    else hi = mid;
  }
  return hi;
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  /** ISO weekday: 1 = Monday .. 7 = Sunday. */
  isoWeekday: number;
}

const ISO_WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function zonedDateParts(ts: number, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ts))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    isoWeekday: ISO_WEEKDAY[parts.weekday] ?? 1,
  };
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** Plain calendar-day arithmetic: never consults a timezone, since adding whole calendar days to a date is a
 * timezone-independent operation (only mapping the resulting Y/M/D to a real instant needs the zone, done
 * separately by `resolveLocalWallClock`). */
function addCalendarDays(date: CalendarDate, deltaDays: number): CalendarDate {
  const base = new Date(Date.UTC(date.year, date.month - 1, date.day) + deltaDays * DAY_MS);
  return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() };
}

function addCalendarMonths(year: number, month: number, deltaMonths: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + deltaMonths;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 + 1 };
}

/**
 * The calendar day, ISO week (Monday 00:00 start) or calendar month that contains `now`, in `timezone`, correct
 * across a DST change (rule 1 of issue #85's section 2). A call belongs to `[window.start, window.end)` by the
 * ledger's own server receive time; this function never looks at a client timestamp.
 */
export function computeBudgetWindow(period: BudgetPeriod, timeZone: string, now: number): BudgetWindow {
  const { year, month, day, isoWeekday } = zonedDateParts(now, timeZone);

  if (period === 'day') {
    const start = resolveLocalWallClock(year, month, day, 0, 0, 0, timeZone);
    const next = addCalendarDays({ year, month, day }, 1);
    const end = resolveLocalWallClock(next.year, next.month, next.day, 0, 0, 0, timeZone);
    return { start, end };
  }

  if (period === 'week') {
    const monday = addCalendarDays({ year, month, day }, -(isoWeekday - 1));
    const start = resolveLocalWallClock(monday.year, monday.month, monday.day, 0, 0, 0, timeZone);
    const nextMonday = addCalendarDays(monday, 7);
    const end = resolveLocalWallClock(nextMonday.year, nextMonday.month, nextMonday.day, 0, 0, 0, timeZone);
    return { start, end };
  }

  // month
  const start = resolveLocalWallClock(year, month, 1, 0, 0, 0, timeZone);
  const next = addCalendarMonths(year, month, 1);
  const end = resolveLocalWallClock(next.year, next.month, 1, 0, 0, 0, timeZone);
  return { start, end };
}

// -------------------------------------------------------------
// 3. Aggregation over ledger rows (issue #85, section 2 rules 2-4, 7): pure, so the future SQLite aggregate
//    query (#303) and this in-memory path can be tested against the same fixtures and can never silently
//    diverge, the same discipline `server/usage/rollup.ts` already follows for the rollup endpoint.
// -------------------------------------------------------------

/** The ledger columns this engine ever reads, named and typed exactly as `UsageLedgerRow` (#65/#84) already
 * declares them: a `Pick`, not a redefinition, so a renamed or removed column fails this file at compile time
 * instead of silently drifting. */
export type BudgetLedgerRow = Pick<
  UsageLedgerRow,
  | 'eventType'
  | 'receivedAt'
  | 'agentId'
  | 'sessionId'
  | 'model'
  | 'userId'
  | 'tags'
  | 'cost'
  | 'currency'
  | 'costSource'
  | 'estimatedCostNano'
  | 'estimatedCurrency'
  | 'pricingVersion'
  | 'estimateStatus'
>;

/** Rounds to 8 decimal places before any comparison (issue #85, rule 6), including `limit * warningRatio`, so
 * float noise on a sum of micro-costs can never flip a state. */
export function roundBudgetAmount(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

export interface BudgetAggregates {
  calls: BudgetCallCounts;
  /** Sum of the reported-cost part of `knownSpent`, in the budget's currency, unrounded. */
  reportedSum: number;
  /** Sum of the estimated-cost part of `knownSpent` (basis `reported_plus_estimated` only), in the budget's
   * currency, unrounded. Never includes a row that also had a usable reported cost (rule 3: no double count). */
  estimatedSum: number;
  /** Distinct `pricingVersion`s behind `estimatedSum`, sorted ascending. */
  pricingVersions: number[];
  /** Rule 7: `true` when the store reports rows were dropped inside this window (memory mode cap), or the
   * ledger's coverage start is after the window start. `false` here (the default) is what every caller except
   * the storage layer (#303) will ever pass: this pure function never computes it itself. */
  historyTruncated: boolean;
}

function scopeMatches(row: BudgetLedgerRow, scope: BudgetScope): boolean {
  switch (scope.type) {
    case 'all':
      return true;
    case 'agent':
      return row.agentId !== null && row.agentId === scope.value;
    case 'model':
      return row.model !== null && row.model === scope.value;
    case 'session':
      return row.sessionId !== null && row.sessionId === scope.value;
    case 'user':
      return row.userId !== null && row.userId === scope.value;
    case 'tag':
      return scope.value !== null && row.tags.includes(scope.value);
  }
}

interface CostCandidate {
  source: Extract<CostSource, 'provider-reported' | 'estimated'> | null;
  cost: number | null;
  currency: string | null;
  pricingVersion: number | null;
}

const NO_CANDIDATE: CostCandidate = { source: null, cost: null, currency: null, pricingVersion: null };

/**
 * Picks the one cost figure a row contributes under `basis` (rule 3). A numeric `cost` with
 * `costSource: 'unknown'` is never trusted under either basis. `reported_plus_estimated` falls back to the
 * ledger's own ingestion-time estimate (#84) only when no reported cost is usable, so a row with both never
 * counts twice.
 */
function resolveCostCandidate(row: BudgetLedgerRow, basis: BudgetBasis): CostCandidate {
  if (row.costSource === 'provider-reported' && row.cost !== null) {
    return { source: 'provider-reported', cost: row.cost, currency: row.currency, pricingVersion: null };
  }
  if (basis === 'reported_plus_estimated' && row.estimateStatus === 'estimated' && row.estimatedCostNano !== null && row.estimatedCurrency !== null) {
    return {
      source: 'estimated',
      cost: nanoToDecimalCost(row.estimatedCostNano),
      currency: row.estimatedCurrency,
      pricingVersion: row.pricingVersion,
    };
  }
  return NO_CANDIDATE;
}

/**
 * Aggregates an already window-and-scope-eligible-or-not row set for one budget: applies the window (by
 * `receivedAt`, rule 1), the scope match (rule 2), the `llm.failed`-without-cost exclusion (rule 3) and the
 * basis/currency rules (rules 3-4), and returns the per-currency-matched sums plus the four-way call partition.
 * Pure and synchronous, callable directly from an in-memory store; the SQLite storage layer (#303) computes the
 * same `BudgetAggregates` shape with one aggregate SQL query instead of iterating rows, and both are checked
 * against the same fixtures so they can never diverge.
 */
export function aggregateBudgetCalls(rows: readonly BudgetLedgerRow[], budget: Pick<Budget, 'scope' | 'basis' | 'currency'>, window: BudgetWindow): BudgetAggregates {
  let total = 0;
  let withCost = 0;
  let unknownCost = 0;
  let otherCurrency = 0;
  let missingCurrency = 0;
  let reportedSum = 0;
  let estimatedSum = 0;
  const pricingVersions = new Set<number>();

  for (const row of rows) {
    if (row.receivedAt < window.start || row.receivedAt >= window.end) continue;
    if (!scopeMatches(row, budget.scope)) continue;
    // Rule 3: a failed call without a cost is excluded from every counter, not just left unknown.
    if (row.eventType === 'llm.failed' && row.cost === null) continue;

    total++;
    const candidate = resolveCostCandidate(row, budget.basis);
    if (candidate.source === null) {
      unknownCost++;
      continue;
    }
    if (candidate.currency === null) {
      missingCurrency++;
      continue;
    }
    if (candidate.currency !== budget.currency) {
      otherCurrency++;
      continue;
    }
    withCost++;
    if (candidate.source === 'provider-reported') {
      reportedSum += candidate.cost as number;
    } else {
      estimatedSum += candidate.cost as number;
      if (candidate.pricingVersion !== null) pricingVersions.add(candidate.pricingVersion);
    }
  }

  return {
    calls: { total, withCost, unknownCost, otherCurrency, missingCurrency },
    reportedSum,
    estimatedSum,
    pricingVersions: [...pricingVersions].sort((a, b) => a - b),
    historyTruncated: false,
  };
}

// -------------------------------------------------------------
// 4. State evaluation (issue #85, section 2 rules 5-8)
// -------------------------------------------------------------

/**
 * Computes a budget's status from a pre-aggregated window (rules 5-6). `aggregates.historyTruncated` (rule 7)
 * is supplied by the caller: this pure function never inspects store internals. A failed aggregate query (rule
 * 8) is not represented here; the caller catches that and builds its status directly with
 * `evaluationErrorStatus` below, without ever calling this function (there is nothing for it to evaluate).
 */
export function evaluateBudget(budget: Pick<Budget, 'limit' | 'warningRatio'>, aggregates: BudgetAggregates, now: number, window: BudgetWindow): BudgetStatus {
  const knownSpent = roundBudgetAmount(aggregates.reportedSum + aggregates.estimatedSum);
  const limit = roundBudgetAmount(budget.limit);
  const warningThreshold = roundBudgetAmount(budget.limit * budget.warningRatio);

  const unknownReasons: BudgetUnknownReason[] = [];
  if (aggregates.calls.unknownCost > 0) unknownReasons.push('unknown_cost');
  if (aggregates.calls.otherCurrency > 0) unknownReasons.push('currency_mismatch');
  if (aggregates.calls.missingCurrency > 0) unknownReasons.push('missing_currency');
  if (aggregates.historyTruncated) unknownReasons.push('history_truncated');

  const breakdown = { reported: roundBudgetAmount(aggregates.reportedSum), estimated: roundBudgetAmount(aggregates.estimatedSum) };
  const containsEstimates = aggregates.estimatedSum > 0;
  const base = {
    window,
    knownSpent,
    breakdown,
    containsEstimates,
    calls: aggregates.calls,
    pricingVersions: aggregates.pricingVersions,
    evaluatedAt: now,
  };

  // Rule 5, first clause: a provable breach is reported even while other calls are unknown (costs are
  // non-negative, so `knownSpent` alone already crosses `limit`). `spent` only stays `null` when there really is
  // an incomplete part to the figure; with no unknowns at all, the breach is simply reported with its real,
  // complete number, same as any other state.
  if (knownSpent >= limit) {
    if (unknownReasons.length > 0) {
      return { ...base, state: 'exceeded', spent: null, spentComplete: false, limitRemaining: null, ratio: null, unknownReasons };
    }
    return {
      ...base,
      state: 'exceeded',
      spent: knownSpent,
      spentComplete: true,
      limitRemaining: roundBudgetAmount(limit - knownSpent),
      ratio: limit > 0 ? knownSpent / limit : null,
      unknownReasons,
    };
  }

  if (unknownReasons.length > 0) {
    return { ...base, state: 'unknown', spent: null, spentComplete: false, limitRemaining: null, ratio: null, unknownReasons };
  }

  // `knownSpent < limit` is already established above, so only "warning" or "ok" remain.
  const spent = knownSpent;
  const state: BudgetState = spent >= warningThreshold ? 'warning' : 'ok';
  return {
    ...base,
    state,
    spent,
    spentComplete: true,
    limitRemaining: roundBudgetAmount(limit - spent),
    ratio: limit > 0 ? spent / limit : null,
    unknownReasons,
  };
}

/** Rule 8: when the aggregate query itself fails, the state is `unknown` with `evaluation_error`, `spent` is
 * `null`, and nothing else about the window is known. The route layer (#304) logs the real error server side
 * with the budget id and still answers 200 with this status. */
export function evaluationErrorStatus(window: BudgetWindow, now: number): BudgetStatus {
  return {
    state: 'unknown',
    window,
    spent: null,
    spentComplete: false,
    knownSpent: 0,
    breakdown: { reported: 0, estimated: 0 },
    containsEstimates: false,
    limitRemaining: null,
    ratio: null,
    calls: { total: 0, withCost: 0, unknownCost: 0, otherCurrency: 0, missingCurrency: 0 },
    unknownReasons: ['evaluation_error'],
    pricingVersions: [],
    evaluatedAt: now,
  };
}

// -------------------------------------------------------------
// 5. Storage (issue #85, sub-issue #303): `BudgetRegistry`, a memory and a SQLite implementation sharing one
//    validation path, append-only revisions with `actor`/`auth`, soft delete, and the evaluation cache the issue
//    asks for. No new "coverage start" table: issue #70's `retention_state.purged_before` (SQLite) and
//    `MemoryEventStore`'s own `ledgerDroppedRows`/`ledgerComplete`/`retentionState.usageLedger.purgedBefore`
//    (memory, see migration 0014's own comment for the full citation) already give a `historyTruncated` caller
//    everything #85's rule 7 needs; this module never reads the ledger itself; that stays the caller's job
//    (#304's API layer, which already holds a live store reference).
// -------------------------------------------------------------

export interface BudgetValidationIssue {
  path: string;
  message: string;
}

/** Thrown by every `BudgetRegistry` write method when the input fails validation, before anything is persisted
 * (memory) or inside the still-open transaction, which is then rolled back (SQLite). */
export class BudgetValidationError extends Error {
  readonly code = 'budget_validation' as const;
  constructor(readonly issues: readonly BudgetValidationIssue[]) {
    super(`Invalid budget input: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
    this.name = 'BudgetValidationError';
  }
}

/** What `BudgetRegistry.create` accepts. `id` is normally omitted (minted as `"bud_" + UUID`); accepting it lets
 * a test or a seed script pin a deterministic id. Every optional field here has the same default `Budget`'s own
 * field comments document (`timezone: "UTC"`, `warningRatio: 0.8`, `enabled: true`). */
export interface BudgetInput {
  id?: string;
  name: string;
  scope: BudgetScope;
  period: BudgetPeriod;
  timezone?: string;
  currency: string;
  basis: BudgetBasis;
  limit: number;
  warningRatio?: number;
  enabled?: boolean;
}

/** What `BudgetRegistry.update` accepts: every field optional, and replaced as a whole when present (`scope` is
 * never merged field by field: supplying it means supplying both `type` and `value` together, never just one). */
export type BudgetPatch = Partial<Omit<BudgetInput, 'id'>>;

export type BudgetRevisionAction = 'create' | 'update' | 'delete';

/** `'token'` when the request carried a valid admin/API token, `'open'` when the server has none configured,
 * mirroring `server/index.ts`'s own `AuthMode`. Duplicated here as a plain union instead of imported so this
 * storage module keeps zero dependency on the route layer; the caller (#304's API) passes whichever one it
 * already computed from `currentAuthMode()`. */
export type BudgetRevisionAuth = 'token' | 'open';

export interface BudgetChangeMeta {
  /** Free text, 1 to 100 characters when provided (same bound `server/pricing/api.ts` already uses for its own
   * `actor` field); `null` when the caller does not supply one. */
  actor: string | null;
  auth: BudgetRevisionAuth;
}

/** One append-only row per `create`/`update`/`delete` (issue #85 section 3). `snapshot` is the full `Budget` as
 * it stood immediately after this change (for `delete`, its config fields right before the row was marked
 * deleted; `Budget` itself carries no `deletedAt` field, the registry tracks that separately). */
export interface BudgetRevision {
  id: string;
  budgetId: string;
  revision: number;
  action: BudgetRevisionAction;
  snapshot: Budget;
  actor: string | null;
  auth: BudgetRevisionAuth;
  createdAt: number;
}

/** The evaluation cache key the issue names: a result computed for one ledger write sequence, one window start
 * and one budget revision is valid forever, since the ledger never rewrites history and a past window never
 * changes. `getCachedStatus` only ever returns a hit on an exact match of all three fields. */
export interface BudgetEvalCacheKey {
  ledgerSeq: number;
  windowStart: number;
  revision: number;
}

export interface BudgetRegistry {
  /** Throws `BudgetValidationError` on invalid input, including an explicitly supplied `id` that already exists
   * (active or soft-deleted: an id is never reused, issue #85 section 3). */
  create(input: BudgetInput, meta: BudgetChangeMeta): Budget;
  /** `null` when `id` does not exist or is soft-deleted. Throws `BudgetValidationError` on invalid input. */
  update(id: string, patch: BudgetPatch, meta: BudgetChangeMeta): Budget | null;
  /** Soft delete: `false` when `id` does not exist or is already deleted. The row, its revisions and any cached
   * status are kept, just excluded from `get`/`list` from here on. */
  delete(id: string, meta: BudgetChangeMeta): boolean;
  /** `null` when `id` does not exist or is soft-deleted. */
  get(id: string): Budget | null;
  /** Every non-deleted budget, oldest `createdAt` first (ties broken by `id`). */
  list(): Budget[];
  /** Every revision for `budgetId`, oldest first. Empty for an unknown id. */
  listRevisions(budgetId: string): BudgetRevision[];
  /** `null` on a miss (no cached entry, or one whose key does not match exactly). Never throws for an unknown
   * `budgetId`: the caller already resolved the budget before asking for its cached status. */
  getCachedStatus(budgetId: string, key: BudgetEvalCacheKey): BudgetStatus | null;
  /** Upserts the single cached entry for `budgetId`, replacing whatever was cached before. */
  setCachedStatus(budgetId: string, key: BudgetEvalCacheKey, status: BudgetStatus): void;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function isValidTimeZone(timeZone: string): boolean {
  try {
    // eslint-disable-next-line no-new -- constructed only to validate; `Intl` throws `RangeError` on a bad name.
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function validateActor(actor: string | null): void {
  if (actor === null) return;
  if (typeof actor !== 'string' || actor.length < 1 || actor.length > 100) {
    throw new BudgetValidationError([{ path: 'actor', message: 'must be 1 to 100 characters when provided' }]);
  }
}

/**
 * Validates whichever fields are present in `candidate`, shared by `create` (every `BudgetInput` field present)
 * and `update` (only the fields a `BudgetPatch` actually supplies): a field absent from `candidate` is simply
 * not checked, since `update` leaves it at its current, already-valid stored value.
 */
function validateBudgetFields(candidate: {
  name?: string;
  scope?: BudgetScope;
  period?: BudgetPeriod;
  timezone?: string;
  currency?: string;
  basis?: BudgetBasis;
  limit?: number;
  warningRatio?: number;
}): BudgetValidationIssue[] {
  const issues: BudgetValidationIssue[] = [];

  if (candidate.name !== undefined) {
    if (typeof candidate.name !== 'string' || candidate.name.length < 1 || candidate.name.length > 120) {
      issues.push({ path: 'name', message: 'must be 1 to 120 characters' });
    }
  }
  if (candidate.scope !== undefined) {
    const { scope } = candidate;
    if (!isBudgetScopeType(scope.type)) {
      issues.push({ path: 'scope.type', message: `must be one of ${BUDGET_SCOPE_TYPES.join(', ')}` });
    } else if (scope.type === 'all') {
      if (scope.value !== null) issues.push({ path: 'scope.value', message: 'must be null when scope.type is "all"' });
    } else if (typeof scope.value !== 'string' || scope.value.length < 1 || scope.value.length > 200) {
      issues.push({ path: 'scope.value', message: 'must be 1 to 200 characters when scope.type is not "all"' });
    }
  }
  if (candidate.period !== undefined && !isBudgetPeriod(candidate.period)) {
    issues.push({ path: 'period', message: `must be one of ${BUDGET_PERIODS.join(', ')}` });
  }
  if (candidate.timezone !== undefined) {
    if (typeof candidate.timezone !== 'string' || candidate.timezone.length < 1 || !isValidTimeZone(candidate.timezone)) {
      issues.push({ path: 'timezone', message: 'must be a valid IANA time zone name' });
    }
  }
  if (candidate.currency !== undefined) {
    if (typeof candidate.currency !== 'string' || !CURRENCY_PATTERN.test(candidate.currency)) {
      issues.push({ path: 'currency', message: 'must be a 3 letter uppercase ISO 4217 code' });
    }
  }
  if (candidate.basis !== undefined && !isBudgetBasis(candidate.basis)) {
    issues.push({ path: 'basis', message: `must be one of ${BUDGET_BASES.join(', ')}` });
  }
  if (candidate.limit !== undefined) {
    if (typeof candidate.limit !== 'number' || !Number.isFinite(candidate.limit) || candidate.limit <= 0 || candidate.limit > 1e12) {
      issues.push({ path: 'limit', message: 'must be finite, greater than 0 and at most 1e12' });
    }
  }
  if (candidate.warningRatio !== undefined) {
    if (
      typeof candidate.warningRatio !== 'number'
      || !Number.isFinite(candidate.warningRatio)
      || candidate.warningRatio <= 0
      || candidate.warningRatio >= 1
    ) {
      issues.push({ path: 'warningRatio', message: 'must be greater than 0 and less than 1' });
    }
  }
  return issues;
}

function sortBudgets(list: Budget[]): Budget[] {
  return [...list].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---- Memory implementation ------------------------------------------------

export interface MemoryBudgetRegistryOptions {
  now?: () => number;
}

/**
 * In-process `BudgetRegistry`: nothing survives a restart (the memory store never does, issue #85 section 5
 * assumes this of every memory-mode feature), but the same validation, revision and cache semantics as the
 * SQLite implementation below, checked against it directly by `tests/budgets-registry.test.mjs`'s parity suite.
 */
export function createMemoryBudgetRegistry(options: MemoryBudgetRegistryOptions = {}): BudgetRegistry {
  const now = options.now ?? Date.now;
  const budgetsById = new Map<string, Budget>();
  const deletedIds = new Set<string>();
  const revisionsByBudget = new Map<string, BudgetRevision[]>();
  const cacheByBudget = new Map<string, { key: BudgetEvalCacheKey; status: BudgetStatus }>();

  function recordRevision(budget: Budget, action: BudgetRevisionAction, meta: BudgetChangeMeta): void {
    const list = revisionsByBudget.get(budget.id) ?? [];
    list.push({
      id: `budrev_${crypto.randomUUID()}`,
      budgetId: budget.id,
      revision: budget.revision,
      action,
      snapshot: { ...budget, scope: { ...budget.scope } },
      actor: meta.actor,
      auth: meta.auth,
      createdAt: now(),
    });
    revisionsByBudget.set(budget.id, list);
  }

  function create(input: BudgetInput, meta: BudgetChangeMeta): Budget {
    validateActor(meta.actor);
    const issues = validateBudgetFields(input);
    if (issues.length > 0) throw new BudgetValidationError(issues);
    const id = input.id ?? `bud_${crypto.randomUUID()}`;
    if (budgetsById.has(id)) {
      throw new BudgetValidationError([{ path: 'id', message: `a budget with id "${id}" already exists` }]);
    }
    const timestamp = now();
    const budget: Budget = {
      id,
      name: input.name,
      scope: { ...input.scope },
      period: input.period,
      timezone: input.timezone ?? 'UTC',
      currency: input.currency,
      basis: input.basis,
      limit: input.limit,
      warningRatio: input.warningRatio ?? 0.8,
      enabled: input.enabled ?? true,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    budgetsById.set(id, budget);
    recordRevision(budget, 'create', meta);
    return { ...budget, scope: { ...budget.scope } };
  }

  function update(id: string, patch: BudgetPatch, meta: BudgetChangeMeta): Budget | null {
    validateActor(meta.actor);
    const current = budgetsById.get(id);
    if (!current || deletedIds.has(id)) return null;
    const issues = validateBudgetFields(patch);
    if (issues.length > 0) throw new BudgetValidationError(issues);
    const timestamp = now();
    const next: Budget = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.scope !== undefined ? { scope: { ...patch.scope } } : {}),
      ...(patch.period !== undefined ? { period: patch.period } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.basis !== undefined ? { basis: patch.basis } : {}),
      ...(patch.limit !== undefined ? { limit: patch.limit } : {}),
      ...(patch.warningRatio !== undefined ? { warningRatio: patch.warningRatio } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      revision: current.revision + 1,
      updatedAt: timestamp,
    };
    budgetsById.set(id, next);
    recordRevision(next, 'update', meta);
    return { ...next, scope: { ...next.scope } };
  }

  function del(id: string, meta: BudgetChangeMeta): boolean {
    validateActor(meta.actor);
    const current = budgetsById.get(id);
    if (!current || deletedIds.has(id)) return false;
    const timestamp = now();
    const next: Budget = { ...current, revision: current.revision + 1, updatedAt: timestamp };
    budgetsById.set(id, next);
    deletedIds.add(id);
    recordRevision(next, 'delete', meta);
    return true;
  }

  function get(id: string): Budget | null {
    if (deletedIds.has(id)) return null;
    const budget = budgetsById.get(id);
    return budget ? { ...budget, scope: { ...budget.scope } } : null;
  }

  function list(): Budget[] {
    const active = [...budgetsById.values()].filter((budget) => !deletedIds.has(budget.id));
    return sortBudgets(active).map((budget) => ({ ...budget, scope: { ...budget.scope } }));
  }

  function listRevisions(budgetId: string): BudgetRevision[] {
    return (revisionsByBudget.get(budgetId) ?? []).map((revision) => ({ ...revision, snapshot: { ...revision.snapshot, scope: { ...revision.snapshot.scope } } }));
  }

  function getCachedStatus(budgetId: string, key: BudgetEvalCacheKey): BudgetStatus | null {
    const entry = cacheByBudget.get(budgetId);
    if (!entry) return null;
    if (entry.key.ledgerSeq !== key.ledgerSeq || entry.key.windowStart !== key.windowStart || entry.key.revision !== key.revision) {
      return null;
    }
    return { ...entry.status };
  }

  function setCachedStatus(budgetId: string, key: BudgetEvalCacheKey, status: BudgetStatus): void {
    cacheByBudget.set(budgetId, { key: { ...key }, status: { ...status } });
  }

  return { create, update, delete: del, get, list, listRevisions, getCachedStatus, setCachedStatus };
}

// ---- SQLite implementation -------------------------------------------------

interface BudgetRow {
  id: string;
  name: string;
  scope_type: string;
  scope_value: string | null;
  period: string;
  timezone: string;
  currency: string;
  basis: string;
  limit_amount: number;
  warning_ratio: number;
  enabled: number;
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

function rowToBudget(row: BudgetRow): Budget {
  return {
    id: row.id,
    name: row.name,
    scope: { type: row.scope_type as BudgetScopeType, value: row.scope_value },
    period: row.period as BudgetPeriod,
    timezone: row.timezone,
    currency: row.currency,
    basis: row.basis as BudgetBasis,
    limit: row.limit_amount,
    warningRatio: row.warning_ratio,
    enabled: row.enabled === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SqliteBudgetRegistryOptions {
  now?: () => number;
}

/**
 * SQLite `BudgetRegistry`, backed by the `budgets`/`budget_revisions`/`budget_state` tables migration 0014
 * creates. `db` must already have those tables (the caller runs migrations first, exactly like every other
 * SQLite-backed module in this codebase); this constructor never runs a migration itself. Each write method is
 * its own transaction, so a budget row and its revision row are always written, or neither is.
 */
export function createSqliteBudgetRegistry(db: DatabaseSync, options: SqliteBudgetRegistryOptions = {}): BudgetRegistry {
  const now = options.now ?? Date.now;

  function insertRevision(budget: Budget, action: BudgetRevisionAction, meta: BudgetChangeMeta): void {
    db.prepare(
      `INSERT INTO budget_revisions (id, budget_id, revision, action, snapshot_json, actor, auth, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(`budrev_${crypto.randomUUID()}`, budget.id, budget.revision, action, JSON.stringify(budget), meta.actor, meta.auth, now());
  }

  function runInTransaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction may already have been rolled back by a prior statement failure.
      }
      throw error;
    }
  }

  function create(input: BudgetInput, meta: BudgetChangeMeta): Budget {
    validateActor(meta.actor);
    const issues = validateBudgetFields(input);
    if (issues.length > 0) throw new BudgetValidationError(issues);
    const id = input.id ?? `bud_${crypto.randomUUID()}`;
    return runInTransaction(() => {
      const existing = db.prepare('SELECT id FROM budgets WHERE id = ?').get(id);
      if (existing) throw new BudgetValidationError([{ path: 'id', message: `a budget with id "${id}" already exists` }]);
      const timestamp = now();
      const timezone = input.timezone ?? 'UTC';
      const warningRatio = input.warningRatio ?? 0.8;
      const enabled = input.enabled ?? true;
      db.prepare(
        `INSERT INTO budgets
           (id, name, scope_type, scope_value, period, timezone, currency, basis, limit_amount, warning_ratio, enabled, revision, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`
      ).run(id, input.name, input.scope.type, input.scope.value, input.period, timezone, input.currency, input.basis, input.limit, warningRatio, enabled ? 1 : 0, timestamp, timestamp);
      const budget: Budget = {
        id,
        name: input.name,
        scope: { ...input.scope },
        period: input.period,
        timezone,
        currency: input.currency,
        basis: input.basis,
        limit: input.limit,
        warningRatio,
        enabled,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      insertRevision(budget, 'create', meta);
      return budget;
    });
  }

  function update(id: string, patch: BudgetPatch, meta: BudgetChangeMeta): Budget | null {
    validateActor(meta.actor);
    const issues = validateBudgetFields(patch);
    if (issues.length > 0) throw new BudgetValidationError(issues);
    return runInTransaction(() => {
      const row = db.prepare('SELECT * FROM budgets WHERE id = ? AND deleted_at IS NULL').get(id) as BudgetRow | undefined;
      if (!row) return null;
      const current = rowToBudget(row);
      const timestamp = now();
      const next: Budget = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.scope !== undefined ? { scope: { ...patch.scope } } : {}),
        ...(patch.period !== undefined ? { period: patch.period } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
        ...(patch.basis !== undefined ? { basis: patch.basis } : {}),
        ...(patch.limit !== undefined ? { limit: patch.limit } : {}),
        ...(patch.warningRatio !== undefined ? { warningRatio: patch.warningRatio } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        revision: current.revision + 1,
        updatedAt: timestamp,
      };
      db.prepare(
        `UPDATE budgets
         SET name = ?, scope_type = ?, scope_value = ?, period = ?, timezone = ?, currency = ?, basis = ?,
             limit_amount = ?, warning_ratio = ?, enabled = ?, revision = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        next.name,
        next.scope.type,
        next.scope.value,
        next.period,
        next.timezone,
        next.currency,
        next.basis,
        next.limit,
        next.warningRatio,
        next.enabled ? 1 : 0,
        next.revision,
        next.updatedAt,
        id
      );
      insertRevision(next, 'update', meta);
      return next;
    });
  }

  function del(id: string, meta: BudgetChangeMeta): boolean {
    validateActor(meta.actor);
    return runInTransaction(() => {
      const row = db.prepare('SELECT * FROM budgets WHERE id = ? AND deleted_at IS NULL').get(id) as BudgetRow | undefined;
      if (!row) return false;
      const current = rowToBudget(row);
      const timestamp = now();
      const next: Budget = { ...current, revision: current.revision + 1, updatedAt: timestamp };
      db.prepare('UPDATE budgets SET revision = ?, updated_at = ?, deleted_at = ? WHERE id = ?').run(next.revision, next.updatedAt, timestamp, id);
      insertRevision(next, 'delete', meta);
      return true;
    });
  }

  function get(id: string): Budget | null {
    const row = db.prepare('SELECT * FROM budgets WHERE id = ? AND deleted_at IS NULL').get(id) as BudgetRow | undefined;
    return row ? rowToBudget(row) : null;
  }

  function list(): Budget[] {
    const rows = db.prepare('SELECT * FROM budgets WHERE deleted_at IS NULL ORDER BY created_at, id').all() as unknown as BudgetRow[];
    return rows.map(rowToBudget);
  }

  function listRevisions(budgetId: string): BudgetRevision[] {
    const rows = db
      .prepare('SELECT * FROM budget_revisions WHERE budget_id = ? ORDER BY revision')
      .all(budgetId) as Array<{
        id: string;
        budget_id: string;
        revision: number;
        action: BudgetRevisionAction;
        snapshot_json: string;
        actor: string | null;
        auth: BudgetRevisionAuth;
        created_at: number;
      }>;
    return rows.map((row) => ({
      id: row.id,
      budgetId: row.budget_id,
      revision: row.revision,
      action: row.action,
      snapshot: JSON.parse(row.snapshot_json) as Budget,
      actor: row.actor,
      auth: row.auth,
      createdAt: row.created_at,
    }));
  }

  function getCachedStatus(budgetId: string, key: BudgetEvalCacheKey): BudgetStatus | null {
    const row = db
      .prepare('SELECT ledger_seq, window_start, budget_revision, status_json FROM budget_state WHERE budget_id = ?')
      .get(budgetId) as { ledger_seq: number; window_start: number; budget_revision: number; status_json: string } | undefined;
    if (!row) return null;
    if (row.ledger_seq !== key.ledgerSeq || row.window_start !== key.windowStart || row.budget_revision !== key.revision) {
      return null;
    }
    return JSON.parse(row.status_json) as BudgetStatus;
  }

  function setCachedStatus(budgetId: string, key: BudgetEvalCacheKey, status: BudgetStatus): void {
    db.prepare(
      `INSERT INTO budget_state (budget_id, ledger_seq, window_start, budget_revision, status_json, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(budget_id) DO UPDATE SET
         ledger_seq = excluded.ledger_seq,
         window_start = excluded.window_start,
         budget_revision = excluded.budget_revision,
         status_json = excluded.status_json,
         evaluated_at = excluded.evaluated_at`
    ).run(budgetId, key.ledgerSeq, key.windowStart, key.revision, JSON.stringify(status), now());
  }

  return { create, update, delete: del, get, list, listRevisions, getCachedStatus, setCachedStatus };
}
