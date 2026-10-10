/**
 * Pure math for OTLP metric telemetry (issue #73, section 1 "Temporality"): a series key, the per-series total
 * for `delta` and `cumulative` aggregation temporality (including windowed sums), and grouping raw stored
 * points into a per-session, per-field metrics-only summary.
 *
 * Deliberately metrics-only: this module never reads the usage ledger and is never asked to. The full
 * ledger-vs-metrics cross-check (`GET /api/v1/usage/reconciliation`, issue #73 section 4) needs the ledger
 * accessor from issue #65, which is not merged yet (`gh issue view 65` showed it OPEN while this was built), so
 * that endpoint is out of scope here; `sumTelemetryBySession` below is the metrics-side half it will consume.
 * No I/O, no clock dependency beyond the timestamps already on each point, so it runs the same during live
 * ingestion and in a unit test.
 */
import { createHmac } from 'node:crypto';
import type { ReconciliationTokenField } from './otlp/metricsMap';

export type Temporality = 'delta' | 'cumulative';

interface AttributeLike {
  key: string;
  value?: unknown;
}

/** Deep, key-sorted `JSON.stringify`: objects get their keys sorted recursively, arrays keep their order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

/** First occurrence wins per key (same dedup rule `src/integrations/otlp/claudeCodeLogs.ts` uses for attribute lookups), then sorted
 * by key so two requests that list the same attributes in a different order produce the same series key. */
function canonicalAttributes(attributes: readonly AttributeLike[]): Array<[string, unknown]> {
  const seen = new Map<string, unknown>();
  for (const attr of attributes) {
    if (attr && typeof attr.key === 'string' && !seen.has(attr.key)) seen.set(attr.key, attr.value ?? null);
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * `series_key` (issue #73, section 1): `HMAC-SHA256` (hex) of the canonical JSON of the metric name, every
 * resource attribute and every point attribute (not just the ones that get stored), keyed by a secret so a
 * low-entropy attribute like `user.email` can never be recovered from the key by dictionary attack. Two
 * requests that differ only in attribute order, or only in which of the allowlisted fields they stored, still
 * collide here on purpose; two that differ in a dropped attribute (for example an account id) never do.
 */
export function computeSeriesKey(
  secret: Buffer,
  metricName: string,
  resourceAttributes: readonly AttributeLike[],
  pointAttributes: readonly AttributeLike[]
): string {
  const canonical = stableStringify({
    metric: metricName,
    resource: canonicalAttributes(resourceAttributes),
    point: canonicalAttributes(pointAttributes),
  });
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

/** One stored row of `telemetry_metric_points`, trimmed to the fields the math below needs. */
export interface TelemetryPointRecord {
  seriesKey: string;
  temporality: Temporality;
  metricKind: 'tokens' | 'cost';
  /** Raw `type` attribute for a `tokens` point; `null` for `cost` or when absent. */
  tokenType: string | null;
  /** `'USD'` only when the point's unit was exactly `USD`; `null` otherwise (issue #73, section 1). */
  currency: string | null;
  sessionId: string | null;
  runtimeId: string | null;
  startTimeUnixNano: string;
  timeUnixNano: string;
  timeMs: number;
  value: number;
}

export interface TelemetryWindow {
  /** Inclusive lower bound in epoch ms, or `undefined` for no lower bound. */
  since?: number;
  /** Inclusive upper bound in epoch ms, or `undefined` for no upper bound. */
  until?: number;
}

export interface SeriesTotal {
  /** `null` only when the series mixes `delta` and `cumulative` points (issue #73: "excluded from comparison"). */
  value: number | null;
  mixedTemporality: boolean;
}

/**
 * Totals one series (every point here must share the same `seriesKey`; the caller groups first). `delta` sums
 * every point inside the window; `cumulative` groups by `startTimeUnixNano` (one counter lifetime per group) and
 * sums each group's windowed difference, clamped at 0 so a counter reset never produces a negative total
 * (issue #73, section 1).
 */
export function sumSeriesValue(points: readonly TelemetryPointRecord[], window: TelemetryWindow = {}): SeriesTotal {
  if (points.length === 0) return { value: 0, mixedTemporality: false };

  const hasDelta = points.some((p) => p.temporality === 'delta');
  const hasCumulative = points.some((p) => p.temporality === 'cumulative');
  if (hasDelta && hasCumulative) return { value: null, mixedTemporality: true };

  const since = window.since ?? Number.NEGATIVE_INFINITY;
  const until = window.until ?? Number.POSITIVE_INFINITY;

  if (hasDelta) {
    let total = 0;
    for (const point of points) {
      if (point.timeMs >= since && point.timeMs <= until) total += point.value;
    }
    return { value: total, mixedTemporality: false };
  }

  // Cumulative: group by counter lifetime (startTimeUnixNano).
  const groups = new Map<string, TelemetryPointRecord[]>();
  for (const point of points) {
    const group = groups.get(point.startTimeUnixNano);
    if (group) group.push(point);
    else groups.set(point.startTimeUnixNano, [point]);
  }

  let total = 0;
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.timeMs - b.timeMs);
    const atOrBefore = (boundMs: number): number => {
      let best: number | null = null;
      for (const p of sorted) {
        if (p.timeMs <= boundMs) best = p.value;
        else break;
      }
      return best ?? 0;
    };
    const strictlyBefore = (boundMs: number): number => {
      let best: number | null = null;
      for (const p of sorted) {
        if (p.timeMs < boundMs) best = p.value;
        else break;
      }
      return best ?? 0;
    };
    const groupTotal = atOrBefore(until) - strictlyBefore(since);
    total += Math.max(0, groupTotal);
  }
  return { value: total, mixedTemporality: false };
}

export interface TelemetryFieldSummary {
  value: number | null;
  /** Series contributing to this field that were excluded for mixing temporality. */
  mixedTemporalitySeries: number;
}

export interface TelemetrySessionSummary {
  sessionId: string;
  runtimeId: string | null;
  tokens: Record<ReconciliationTokenField, TelemetryFieldSummary>;
  cost: TelemetryFieldSummary & { currency: 'USD' | null };
  /** Raw `type` attribute values seen that did not map to a reconciliation field (issue #73, section 1). */
  unmappedTypes: string[];
}

const TOKEN_FIELDS: readonly ReconciliationTokenField[] = ['input', 'output', 'cacheRead', 'cacheCreation'];

function emptyFieldSummary(): TelemetryFieldSummary {
  return { value: null, mixedTemporalitySeries: 0 };
}

function addToField(field: TelemetryFieldSummary, series: SeriesTotal): TelemetryFieldSummary {
  if (series.mixedTemporality) return { value: field.value, mixedTemporalitySeries: field.mixedTemporalitySeries + 1 };
  return { value: (field.value ?? 0) + (series.value ?? 0), mixedTemporalitySeries: field.mixedTemporalitySeries };
}

/**
 * Groups stored points (every field already resolved by the caller: `tokenField` for a `tokens` point that
 * mapped, `null` for one that did not) by session, then by series, and sums each field across its series.
 * Points with a null `sessionId` must be filtered out by the caller before calling this (issue #73: "never
 * attributed to a session").
 */
export function sumTelemetryBySession(
  points: ReadonlyArray<TelemetryPointRecord & { tokenField: ReconciliationTokenField | null }>,
  window: TelemetryWindow = {}
): TelemetrySessionSummary[] {
  const bySession = new Map<string, Array<TelemetryPointRecord & { tokenField: ReconciliationTokenField | null }>>();
  for (const point of points) {
    if (point.sessionId === null) continue;
    const list = bySession.get(point.sessionId);
    if (list) list.push(point);
    else bySession.set(point.sessionId, [point]);
  }

  const summaries: TelemetrySessionSummary[] = [];
  for (const [sessionId, sessionPoints] of bySession) {
    const runtimeId = sessionPoints.find((p) => p.runtimeId !== null)?.runtimeId ?? null;
    const tokens: Record<ReconciliationTokenField, TelemetryFieldSummary> = {
      input: emptyFieldSummary(),
      output: emptyFieldSummary(),
      cacheRead: emptyFieldSummary(),
      cacheCreation: emptyFieldSummary(),
    };
    let cost: TelemetryFieldSummary & { currency: 'USD' | null } = { ...emptyFieldSummary(), currency: null };
    const unmappedTypes = new Set<string>();

    const bySeriesKind = new Map<string, Array<TelemetryPointRecord & { tokenField: ReconciliationTokenField | null }>>();
    for (const point of sessionPoints) {
      if (point.metricKind === 'tokens' && point.tokenField === null && point.tokenType !== null) {
        unmappedTypes.add(point.tokenType);
      }
      const list = bySeriesKind.get(point.seriesKey);
      if (list) list.push(point);
      else bySeriesKind.set(point.seriesKey, [point]);
    }

    for (const seriesPoints of bySeriesKind.values()) {
      const first = seriesPoints[0];
      const total = sumSeriesValue(seriesPoints, window);
      if (first.metricKind === 'tokens' && first.tokenField !== null) {
        tokens[first.tokenField] = addToField(tokens[first.tokenField], total);
      } else if (first.metricKind === 'cost' && first.currency === 'USD') {
        cost = { ...addToField(cost, total), currency: 'USD' };
      }
    }

    summaries.push({ sessionId, runtimeId, tokens, cost, unmappedTypes: [...unmappedTypes] });
  }

  return summaries.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
}
