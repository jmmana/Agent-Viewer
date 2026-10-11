import crypto from 'node:crypto';
import type { CanonicalEvent } from '../src/integrations/canonicalContract';
import type { BudgetCallCounts, BudgetTransition } from './budgets';

/**
 * Issue #86 (sub-issue #319): turns a `BudgetTransition` (issue #85, sub-issue #305, `server/budgets.ts`) into a
 * durable, deduplicated `budget.alert` canonical event. #86's original draft assumed a `BudgetEvaluation` with an
 * arbitrary `thresholds: number[]` array evaluated once per ingest batch; the engine that actually shipped instead
 * reports one concrete state change at a time, in a 4-state machine (`ok | warning | exceeded | unknown`). This
 * module adapts: "crossing a threshold" becomes "the transition lands on `warning` or `exceeded`" (`buildBudgetAlert`
 * returns `null` for every other transition, including a drop back to `ok` or into `unknown`), and a jump that
 * would have fired several thresholds at once in the original design (for example straight from `ok` to `exceeded`)
 * produces exactly one alert here, because the engine itself only ever reports one `to` state per transition.
 */

export type BudgetAlertState = 'warning' | 'exceeded';

/** Deterministic id for a `budget.alert` event, same construction as `webhookEventId`/`webhookUsageRequestEventId`
 * (`server/webhookIds.ts`): a SHA-256 of a versioned, namespaced tuple, never the clock or a random source. Built
 * only from `(budgetId, state, periodStart)` (issue #86's dedup key, adapted from the real transition shape: there
 * is no `thresholdBp` here, `state` already identifies which of the two alertable levels this is), so the exact
 * same crossing always produces the exact same id, which is what lets `recordBudgetAlert`'s `UNIQUE` constraint
 * (and, in memory mode, a plain `Set`) reject a second insert for a real-world crossing already recorded, even
 * across a restart (SQLite) or a concurrent race between two live checks for the same budget (the exact race
 * `onBudgetTransition`'s own doc comment in `server/budgets.ts` names as this listener's responsibility). Matches
 * the reserved id prefix `evt_budget_` that `server/index.ts` refuses on client-submitted events. */
export function budgetAlertEventId(budgetId: string, state: BudgetAlertState, periodStart: number): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(['agent-viewer:budget-alert:v1', budgetId, state, periodStart]))
    .digest('hex');
  return `evt_budget_${digest.slice(0, 32)}`;
}

/** What `EventStore.recordBudgetAlert` persists to `budget_alerts`, named after the real `BudgetTransition`/
 * `BudgetStatus` fields (`BudgetScope.type`/`value`, `BudgetStatus.knownSpent`), never the field names #86's
 * original draft guessed before #85 shipped (`thresholds`, `knownSpend`, a singular `pricingVersion`, ...). */
export interface BudgetAlertRow {
  /** Equals the event id (`budgetAlertEventId`'s output). */
  id: string;
  budgetId: string;
  budgetName: string;
  scopeType: string;
  scopeValue: string | null;
  periodType: string;
  periodStart: number;
  periodEnd: number;
  state: BudgetAlertState;
  /** The ratio of `limit` that was crossed: the budget's own `warningRatio` for `'warning'`, `1` for `'exceeded'`. */
  threshold: number;
  limit: number;
  currency: string;
  knownSpent: number;
  /** `true` when some in-scope, in-window call could not be counted (unknown cost, another currency, or no
   * currency at all): `knownSpent` is then a lower bound, never the true total. */
  spendIsLowerBound: boolean;
  /** `true` when `periodEnd <= detectedAt`: the crossing was found in a period that had already closed (for
   * example while importing old history). The webhook sub-issue (#321) never attempts delivery for these. */
  backfill: boolean;
  detectedAt: number;
}

export interface BudgetAlertStoreInput {
  alert: BudgetAlertRow;
  event: CanonicalEvent;
}

function severityFor(state: BudgetAlertState): 'high' | 'critical' {
  return state === 'exceeded' ? 'critical' : 'high';
}

function formatMoney(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

/** English fallback text only: a receiver that wants a localized message builds it from `payload` itself, the
 * same rule the inbound webhook docs already state for `summary` (issue #86 section 3). */
function summaryFor(state: BudgetAlertState, budgetName: string, threshold: number, limit: number, currency: string): string {
  if (state === 'exceeded') {
    return `Budget "${budgetName}" exceeded its limit of ${formatMoney(limit, currency)}`;
  }
  const pct = Math.round(threshold * 1000) / 10; // one decimal, e.g. 80 or 83.3
  return `Budget "${budgetName}" reached ${pct}% of ${formatMoney(limit, currency)}`;
}

/**
 * Builds the `budget_alerts` row and the canonical `budget.alert` event for a detected transition, or `null` when
 * the transition is not alertable: landing on `'ok'` (nothing to warn about) or `'unknown'` (a data-quality gap,
 * never itself a spend alert, even though a budget already in `'exceeded'` can stay there while also carrying
 * unknown reasons, see `spendIsLowerBound` below) produces no alert at all, matching issue #85's own honesty rule
 * that a provable breach from known data is reported as `'exceeded'` regardless of what else is unknown, while an
 * incomplete-but-not-yet-breached picture is `'unknown'`, never `'warning'`. Pure and synchronous: never touches
 * storage, so a test can call it directly against a hand-built `BudgetTransition` fixture.
 */
export function buildBudgetAlert(transition: BudgetTransition): BudgetAlertStoreInput | null {
  if (transition.to !== 'warning' && transition.to !== 'exceeded') return null;
  const state: BudgetAlertState = transition.to;
  const threshold = transition.threshold ?? (state === 'exceeded' ? 1 : transition.warningRatio);
  const { status } = transition;
  const calls: BudgetCallCounts = status.calls;
  const spendIsLowerBound = calls.unknownCost > 0 || calls.otherCurrency > 0 || calls.missingCurrency > 0;
  const periodStart = transition.window.start;
  const periodEnd = transition.window.end;
  const detectedAt = transition.detectedAt;
  const backfill = periodEnd <= detectedAt;
  const id = budgetAlertEventId(transition.budgetId, state, periodStart);

  const alert: BudgetAlertRow = {
    id,
    budgetId: transition.budgetId,
    budgetName: transition.budgetName,
    scopeType: transition.scope.type,
    scopeValue: transition.scope.value,
    periodType: transition.period,
    periodStart,
    periodEnd,
    state,
    threshold,
    limit: transition.limit,
    currency: transition.currency,
    knownSpent: status.knownSpent,
    spendIsLowerBound,
    backfill,
    detectedAt,
  };

  const event: CanonicalEvent = {
    schemaVersion: '1.0',
    id,
    type: 'budget.alert',
    timestamp: detectedAt,
    source: 'server:budgets',
    agentId: transition.scope.type === 'agent' && transition.scope.value ? transition.scope.value : undefined,
    severity: severityFor(state),
    summary: summaryFor(state, transition.budgetName, threshold, transition.limit, transition.currency),
    payload: {
      alertId: id,
      budgetId: transition.budgetId,
      budgetName: transition.budgetName,
      scope: { type: transition.scope.type, value: transition.scope.value },
      period: { type: transition.period, start: periodStart, end: periodEnd },
      state,
      threshold,
      limit: transition.limit,
      currency: transition.currency,
      knownSpent: status.knownSpent,
      spendIsLowerBound,
      calls: { ...calls },
      containsEstimates: status.containsEstimates,
      pricingVersions: [...status.pricingVersions],
      backfill,
      detectedAt,
    },
  };

  return { alert, event };
}
