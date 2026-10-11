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
