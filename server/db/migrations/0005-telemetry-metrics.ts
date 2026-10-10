import type { Migration } from '../migrations';

/**
 * OTLP metric telemetry storage (issue #73), kept apart from `events` on purpose: these rows are evidence for
 * the ledger-vs-metrics cross-check, never a source for the ledger, the snapshot, SSE or any rollup (issue #73,
 * "Metrics must be kept apart from the ledger").
 *
 * `telemetry_metric_points` stores one row per accepted OTLP data point. The `UNIQUE` constraint on
 * `(series_key, start_time_unix_nano, time_unix_nano)` is the idempotency key: a retried export of the same
 * point is an `INSERT ... ON CONFLICT DO NOTHING`, read back by the caller to tell a harmless duplicate apart
 * from a conflicting one (same key, different value).
 *
 * `telemetry_meta` holds the random HMAC secret behind `series_key` (`server/telemetry.ts`,
 * `computeSeriesKey`), generated once and persisted here so a restart does not mint a new secret and break
 * deduplication for every series already seen before the restart.
 */
export const telemetryMetrics: Migration = {
  version: 5,
  name: 'telemetry-metrics',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_metric_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at INTEGER NOT NULL,
        metric_name TEXT NOT NULL,
        metric_kind TEXT NOT NULL,
        token_type TEXT,
        unit TEXT,
        currency TEXT,
        temporality TEXT NOT NULL,
        series_key TEXT NOT NULL,
        session_id TEXT,
        runtime_id TEXT,
        model TEXT,
        service_name TEXT,
        service_version TEXT,
        start_time_unix_nano TEXT NOT NULL,
        time_unix_nano TEXT NOT NULL,
        time_ms INTEGER NOT NULL,
        value REAL NOT NULL,
        wire_format TEXT NOT NULL,
        UNIQUE (series_key, start_time_unix_nano, time_unix_nano)
      );

      CREATE INDEX IF NOT EXISTS idx_tmp_session ON telemetry_metric_points(session_id, metric_kind);
      CREATE INDEX IF NOT EXISTS idx_tmp_series ON telemetry_metric_points(series_key);

      CREATE TABLE IF NOT EXISTS telemetry_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
};
