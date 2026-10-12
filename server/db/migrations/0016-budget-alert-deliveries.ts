import type { Migration } from '../migrations';

/**
 * Storage for outbound budget alert webhook deliveries (issue #86, sub-issue #321). One row per `budget_alerts`
 * row (migration 15), written in the same transaction `EventStore.recordBudgetAlert` already opens for the alert
 * and event rows, so an alert can never exist without its delivery row, nor the reverse.
 *
 * `body` holds the exact JSON bytes of the `budget.alert` canonical event, serialized once at insert time: every
 * delivery attempt (including every retry) sends these same bytes, never a bytes computed fresh per attempt,
 * which is what keeps `X-Agent-Viewer-Delivery` and the body stable across retries even if the event's own
 * serialization logic changes in a later release.
 *
 * `status`: `pending` (due for an attempt), `delivered` (a `2xx` response), `failed` (dead letter: the maximum
 * attempt count was reached, never retried again) or `skipped` (a backfill alert, see migration 15's own doc
 * comment, or an alert detected while no `AGENT_VIEWER_ALERT_WEBHOOK_URL` was configured; enabling the webhook
 * later never retroactively delivers a `skipped` row). `last_error` is truncated to 2 KB (issue #321's own cap)
 * before it is stored, never the raw response body or a stack trace.
 */
export const budgetAlertDeliveries: Migration = {
  version: 16,
  name: 'budget-alert-deliveries',
  up(db) {
    db.exec(`
      CREATE TABLE budget_alert_deliveries (
        alert_id        TEXT    PRIMARY KEY REFERENCES budget_alerts(id),
        status          TEXT    NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'skipped')),
        attempts        INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        body            TEXT    NOT NULL,
        last_status     INTEGER,
        last_error      TEXT,
        delivered_at    INTEGER
      );

      CREATE INDEX ix_budget_alert_deliveries_due ON budget_alert_deliveries(status, next_attempt_at);
    `);
  },
};
