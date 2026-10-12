import crypto from 'node:crypto';
import express from 'express';
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

// -------------------------------------------------------------
// Read API (issue #86, sub-issue #322): `GET /api/v1/budget-alerts[?budgetId=&since=&limit=]` and
// `GET /api/v1/budget-alerts/:alertId`, the read-only surface over the `budget_alerts` rows #319 above already
// fills. Pure HTTP/shaping code: the actual storage reads are `EventStore.listBudgetAlerts`/`getBudgetAlert`/
// `getBudgetAlertDeliveries` (`server/store.ts`), injected here the same narrow-interface way `BudgetHttpDeps`
// is for the budgets routes themselves, so this module never has to import `EventStore` itself.
//
// Delivery state (issue #86 section 6: `delivery: { status, attempts, lastStatus, deliveredAt }`) depends on
// #321, a separate sub-issue of #86 (the signed outbound webhook and its retry worker) that owns its own later
// migration adding `budget_alert_deliveries`. At the time this shipped, #321 had not necessarily merged yet in
// every environment: `getBudgetAlertDeliveries` is written defensively (table-existence check at the SQL level,
// `server/store.ts`) and returns nothing for an id it cannot resolve, which this module reads as "unknown here"
// and fills with `PENDING_BUDGET_ALERT_DELIVERY` below, never a fabricated "already delivered". This makes the
// endpoint correct no matter which of #321/#322 merges first, with no follow-up change required from either side.
// -------------------------------------------------------------

/** Issue #86 section 6's own delivery shape, read-only here (no endpoint ever creates, edits or redelivers one:
 * they are a pure consequence of #321's webhook worker attempting delivery). */
export interface BudgetAlertDeliveryState {
  status: string;
  attempts: number;
  lastStatus: number | null;
  deliveredAt: number | null;
}

/** The honest placeholder for an alert whose delivery state is not known here, either because `#321` has not
 * merged in this process yet (no `budget_alert_deliveries` table at all) or because the table exists but has no
 * row yet for this exact alert (a delivery attempt has not been made, or has not reached a terminal state). Never
 * a guess at a real delivery outcome. */
export const PENDING_BUDGET_ALERT_DELIVERY: BudgetAlertDeliveryState = {
  status: 'pending',
  attempts: 0,
  lastStatus: null,
  deliveredAt: null,
};

/** What this module's HTTP routes need from storage: a narrow slice of `EventStore` (`server/store.ts`), the same
 * dependency-injection pattern `BudgetHttpDeps` already uses for the budgets routes, so this file never has to
 * import the `EventStore` type itself (which would create a circular type import, since `store.ts` already
 * imports `BudgetAlertStoreInput` from this file). */
export interface BudgetAlertsHttpDeps {
  listBudgetAlerts: (filter: { budgetId?: string; since?: number; limit: number }) => Promise<BudgetAlertRow[]>;
  getBudgetAlert: (alertId: string) => Promise<BudgetAlertRow | null>;
  /** Batched: one call per request, never one per alert. Returns nothing for an id with no known delivery state
   * (see `PENDING_BUDGET_ALERT_DELIVERY` above), whether that is because the table does not exist yet or because
   * the table exists but has no row for that id. */
  getBudgetAlertDeliveries: (alertIds: readonly string[]) => Promise<Map<string, BudgetAlertDeliveryState>>;
  /** `configured`/`signed` only, issue #86 section 6: never the URL or the secret itself, in any response shape.
   * Derived by the caller (`server/index.ts`) from the same parsed `AlertWebhookConfig` #321's own startup
   * validation already produced (`alertWebhookConfig`), never a second, independent read of the raw env vars here
   * (which could silently drift from #321's own parsing rules, for example its URL/scheme validation or
   * whitespace trimming). */
  webhookSummary: () => { configured: boolean; signed: boolean };
}

interface BudgetAlertValidationIssue {
  path: string;
  message: string;
}

export interface BudgetAlertsQuery {
  budgetId?: string;
  since?: number;
  limit: number;
}

const DEFAULT_BUDGET_ALERTS_LIMIT = 100;
const MAX_BUDGET_ALERTS_LIMIT = 500;

/** A non-negative integer in its canonical decimal string form (no sign, no leading `+`, no decimal point,
 * matching the query-string shape every other numeric `/api/v1` query param here already requires, for example
 * `parseRecomputeRunsQuery`'s `limit`/`before` in `server/index.ts`). */
const NON_NEGATIVE_INTEGER = /^[0-9]+$/;

/**
 * Validates `GET /api/v1/budget-alerts`'s query params (issue #86 section 6): `budgetId` is an optional single
 * string; `since` is an optional epoch-ms floor, a non-numeric value is rejected, never silently ignored; `limit`
 * defaults to 100 and is capped at 500 (a value above 500 is silently clamped down, not rejected: "capped",
 * exactly as section 6 phrases it), but a non-numeric or non-positive `limit` is still rejected. Exported so
 * `tests/budget-alerts-api.test.mjs` can exercise the cap/default/rejection boundaries directly, without having
 * to create 500 real alerts through the HTTP layer.
 */
export function parseBudgetAlertsQuery(query: {
  budgetId?: unknown;
  since?: unknown;
  limit?: unknown;
}): { ok: true; value: BudgetAlertsQuery } | { ok: false; issues: BudgetAlertValidationIssue[] } {
  const issues: BudgetAlertValidationIssue[] = [];

  let budgetId: string | undefined;
  if (query.budgetId !== undefined) {
    if (typeof query.budgetId !== 'string' || query.budgetId === '') {
      issues.push({ path: 'budgetId', message: 'must be a single non-empty string value' });
    } else {
      budgetId = query.budgetId;
    }
  }

  let since: number | undefined;
  if (query.since !== undefined) {
    if (typeof query.since !== 'string' || !NON_NEGATIVE_INTEGER.test(query.since)) {
      issues.push({ path: 'since', message: 'must be a non-negative integer, epoch milliseconds' });
    } else {
      since = Number(query.since);
    }
  }

  let limit = DEFAULT_BUDGET_ALERTS_LIMIT;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !NON_NEGATIVE_INTEGER.test(query.limit) || Number(query.limit) < 1) {
      issues.push({ path: 'limit', message: 'must be a positive integer' });
    } else {
      limit = Math.min(Number(query.limit), MAX_BUDGET_ALERTS_LIMIT);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { budgetId, since, limit } };
}

/** The full alert, API-shaped: every `BudgetAlertRow` field plus its embedded `delivery`. */
function budgetAlertView(alert: BudgetAlertRow, delivery: BudgetAlertDeliveryState): BudgetAlertRow & { delivery: BudgetAlertDeliveryState } {
  return { ...alert, delivery };
}

function sendBudgetAlertValidationError(res: express.Response, issues: readonly BudgetAlertValidationIssue[]): void {
  res.status(400).json({ error: 'validation_failed', issues });
}

/**
 * Registers the two read-only `/api/v1/budget-alerts*` routes (issue #86 section 6). Called once from
 * `server/index.ts`, after its existing `/api/v1` middleware chain (rate limiter, query-token rejection,
 * open-mode guard, Bearer auth) is already registered, exactly the same way `registerBudgetsRoutes` is, so both
 * routes here get the same protection as every other `/api/v1` route with zero extra wiring. No `POST`/`PUT`/
 * `DELETE`: alerts are a pure consequence of spend, never created, edited or manually redelivered through this
 * API (issue #86 section 6's own rule).
 */
export function registerBudgetAlertsRoutes(app: express.Express, deps: BudgetAlertsHttpDeps): void {
  app.get('/api/v1/budget-alerts', async (req, res) => {
    const parsed = parseBudgetAlertsQuery(req.query as { budgetId?: unknown; since?: unknown; limit?: unknown });
    if (!parsed.ok) {
      sendBudgetAlertValidationError(res, parsed.issues);
      return;
    }

    const alerts = await deps.listBudgetAlerts(parsed.value);
    const deliveries = await deps.getBudgetAlertDeliveries(alerts.map((alert) => alert.id));
    res.json({
      schemaVersion: '1.0',
      count: alerts.length,
      alerts: alerts.map((alert) => budgetAlertView(alert, deliveries.get(alert.id) ?? PENDING_BUDGET_ALERT_DELIVERY)),
      webhook: deps.webhookSummary(),
    });
  });

  app.get('/api/v1/budget-alerts/:alertId', async (req, res) => {
    const alert = await deps.getBudgetAlert(req.params.alertId);
    if (!alert) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const deliveries = await deps.getBudgetAlertDeliveries([alert.id]);
    res.json(budgetAlertView(alert, deliveries.get(alert.id) ?? PENDING_BUDGET_ALERT_DELIVERY));
  });
}
