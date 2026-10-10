/**
 * Pure mapping of an OTLP metrics export (`POST /v1/metrics`, issue #73) into telemetry point rows.
 *
 * No network, no store, no process-wide state: `mapOtlpMetricsRequest` takes a parsed body (JSON, or already
 * normalized from protobuf by `server/otlp/otlpProtobuf.ts`), the current time and the series-key secret, and
 * returns the points it could build plus counters. The route in `server/index.ts` owns auth, rate limiting,
 * body size and persistence through `EventStore.appendTelemetryPoints`.
 *
 * This module never builds a canonical event and never touches the ledger: issue #73's whole point is that a
 * metric and the `llm.usage` event for the same call must be countable independently, so the two paths must
 * never merge upstream of storage. See `docs/otlp.md` for the full reference.
 */
import { sessionIdentity } from '../../src/integrations/claudeCodeIdentity';
import { TRACKED_METRIC_NAMES, reconciliationFieldForType, type MetricKind, type ReconciliationTokenField } from './metricsMap';
import { computeSeriesKey } from '../telemetry';

const MAX_ATTRIBUTE_VALUE_LENGTH = 200;
/** `DATA_POINT_FLAGS_NO_RECORDED_VALUE_MASK` (OTLP data point flags, bit 0). */
const NO_RECORDED_VALUE_FLAG = 0x1;
/** The largest integer a `double` can hold exactly; also this route's cap on any stored value (issue #73). */
const MAX_SAFE_VALUE = 2 ** 53;

// -------------------------------------------------------------
// Loose OTLP/JSON input shapes: JSON bodies may send `timeUnixNano`/`asInt` as either a decimal string or a
// plain JSON number (issue #73, section 1), and a protobuf-decoded body (see `otlpProtobuf.ts`) always already
// normalized numbers into decimal strings, so these types accept either and the parsing below picks one path.
// -------------------------------------------------------------

interface OtlpAnyValueIn {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: number | string;
  doubleValue?: number;
}

interface OtlpKeyValueIn {
  key: string;
  value?: OtlpAnyValueIn;
}

interface OtlpNumberDataPointIn {
  startTimeUnixNano?: string | number;
  timeUnixNano?: string | number;
  asDouble?: number;
  asInt?: string | number;
  attributes?: OtlpKeyValueIn[];
  flags?: number;
}

interface OtlpSumIn {
  dataPoints?: OtlpNumberDataPointIn[];
  aggregationTemporality?: number | string;
  isMonotonic?: boolean;
}

interface OtlpMetricIn {
  name?: string;
  unit?: string;
  sum?: OtlpSumIn;
  isOtherKind?: boolean;
  // JSON bodies name the other point kinds directly instead of a decoder-set `isOtherKind` flag.
  gauge?: unknown;
  histogram?: unknown;
  exponentialHistogram?: unknown;
  summary?: unknown;
}

interface OtlpScopeMetricsIn {
  metrics?: OtlpMetricIn[];
}

interface OtlpResourceMetricsIn {
  resource?: { attributes?: OtlpKeyValueIn[] };
  scopeMetrics?: OtlpScopeMetricsIn[];
}

export interface OtlpExportMetricsServiceRequest {
  resourceMetrics?: OtlpResourceMetricsIn[];
}

export function looksLikeOtlpMetricsRequest(body: unknown): body is OtlpExportMetricsServiceRequest {
  return typeof body === 'object' && body !== null && Array.isArray((body as OtlpExportMetricsServiceRequest).resourceMetrics);
}

export function countMetricDataPoints(body: OtlpExportMetricsServiceRequest): number {
  let count = 0;
  for (const rm of body.resourceMetrics ?? []) {
    for (const sm of rm.scopeMetrics ?? []) {
      for (const metric of sm.metrics ?? []) count += metric.sum?.dataPoints?.length ?? 0;
    }
  }
  return count;
}

// -------------------------------------------------------------
// Output: what gets persisted by `EventStore.appendTelemetryPoints`
// -------------------------------------------------------------

export type Temporality = 'delta' | 'cumulative';

export interface TelemetryPointInput {
  /** Server receive time (ms), independent of the point's own `timeMs` (issue #73's `received_at` column). */
  receivedAt: number;
  metricName: string;
  metricKind: MetricKind;
  tokenType: string | null;
  unit: string | null;
  currency: 'USD' | null;
  temporality: Temporality;
  seriesKey: string;
  sessionId: string | null;
  runtimeId: string | null;
  model: string | null;
  serviceName: string | null;
  serviceVersion: string | null;
  startTimeUnixNano: string;
  timeUnixNano: string;
  timeMs: number;
  value: number;
  wireFormat: 'json' | 'protobuf';
}

export interface MetricsParseStats {
  /** `Metric` entries seen, tracked or not. */
  metricsSeen: number;
  /** `Metric` entries whose name is not one of the two tracked names: never counted as rejected. */
  metricsIgnored: number;
  /** Data points under a tracked metric name. */
  dataPointsReceived: number;
  /** Points ignored for the no-recorded-value flag: not rejected, not stored. */
  dataPointsIgnoredFlag: number;
  /** Points that failed a validity rule: not stored, counted in `partialSuccess`. */
  dataPointsInvalid: number;
  /** Valid points with no `session.id` on the point or the resource. */
  dataPointsWithoutSession: number;
}

export interface MapOtlpMetricsResult {
  points: TelemetryPointInput[];
  stats: MetricsParseStats;
  /** Raw `type` attribute values that did not map to a reconciliation field, for `telemetry.unmappedTypes`. */
  unmappedTypes: Set<string>;
  /** Short, content-free reasons for every rejected point. */
  rejectionReasons: string[];
}

export interface MapOtlpMetricsOptions {
  now?: number;
  wireFormat: 'json' | 'protobuf';
  /** The HMAC key behind `series_key` (issue #73, section 1). Never logged, never stored. */
  hmacSecret: Buffer;
}

// -------------------------------------------------------------
// Value parsing helpers (mirrors the flexibility `src/integrations/otlp/claudeCodeLogs.ts` already needs for OTLP/JSON numbers)
// -------------------------------------------------------------

function attributeMap(attributes: OtlpKeyValueIn[] | undefined): Map<string, OtlpAnyValueIn> {
  const map = new Map<string, OtlpAnyValueIn>();
  for (const attr of attributes ?? []) {
    if (attr && typeof attr.key === 'string' && attr.value && !map.has(attr.key)) map.set(attr.key, attr.value);
  }
  return map;
}

function stringOf(value: OtlpAnyValueIn | undefined): string | undefined {
  return typeof value?.stringValue === 'string' ? value.stringValue : undefined;
}

function cut(value: string): string {
  return value.length > MAX_ATTRIBUTE_VALUE_LENGTH ? value.slice(0, MAX_ATTRIBUTE_VALUE_LENGTH) : value;
}

/** A decimal-string-or-number `int64`/`fixed64` field, parsed through `BigInt` so values above 2^53 stay exact. */
function bigIntOf(value: string | number | undefined): bigint | null {
  if (value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? BigInt(value) : null;
  }
  return /^-?\d+$/.test(value) ? BigInt(value) : null;
}

/** `timeUnixNano`/`startTimeUnixNano` as the decimal-string form OTLP/JSON stores them in, or `null` if unset or `"0"`. */
function nanoStringOf(value: string | number | undefined): string | null {
  const parsed = bigIntOf(value);
  if (parsed === null || parsed <= 0n) return null;
  return parsed.toString();
}

function msFromNanoString(nanoString: string): number {
  return Number(BigInt(nanoString) / 1_000_000n);
}

const TEMPORALITY_NAME_MAP: ReadonlyMap<string, number> = new Map([
  ['AGGREGATION_TEMPORALITY_UNSPECIFIED', 0],
  ['AGGREGATION_TEMPORALITY_DELTA', 1],
  ['AGGREGATION_TEMPORALITY_CUMULATIVE', 2],
]);

/** Accepts the OTLP/JSON integer form or its enum name string (issue #73, section 1 content-type table). */
function temporalityCodeOf(value: number | string | undefined): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return TEMPORALITY_NAME_MAP.get(value);
  return undefined;
}

function isOtherPointKind(metric: OtlpMetricIn): boolean {
  return Boolean(metric.isOtherKind || metric.gauge || metric.histogram || metric.exponentialHistogram || metric.summary);
}

// -------------------------------------------------------------
// Mapping
// -------------------------------------------------------------

export function mapOtlpMetricsRequest(body: OtlpExportMetricsServiceRequest, options: MapOtlpMetricsOptions): MapOtlpMetricsResult {
  const receivedAtMs = options.now ?? Date.now();
  const points: TelemetryPointInput[] = [];
  const unmappedTypes = new Set<string>();
  const rejectionReasons: string[] = [];
  const stats: MetricsParseStats = {
    metricsSeen: 0,
    metricsIgnored: 0,
    dataPointsReceived: 0,
    dataPointsIgnoredFlag: 0,
    dataPointsInvalid: 0,
    dataPointsWithoutSession: 0,
  };

  for (const rm of body.resourceMetrics ?? []) {
    const resourceAttrsRaw = rm.resource?.attributes ?? [];
    const resourceAttrs = attributeMap(resourceAttrsRaw);
    const serviceName = stringOf(resourceAttrs.get('service.name'));
    const serviceVersion = stringOf(resourceAttrs.get('service.version'));

    for (const sm of rm.scopeMetrics ?? []) {
      for (const metric of sm.metrics ?? []) {
        stats.metricsSeen += 1;
        const metricName = metric.name ?? '';
        const metricKind = TRACKED_METRIC_NAMES.get(metricName);
        if (!metricKind) {
          stats.metricsIgnored += 1;
          continue;
        }

        const dataPoints = metric.sum?.dataPoints ?? [];
        // A tracked name sent as a non-Sum kind, or with no data points at all, has nothing to reject: an empty
        // `dataPoints` array (Sum present, zero points) is not an error either way.
        if (dataPoints.length === 0) continue;

        stats.dataPointsReceived += dataPoints.length;

        const isOther = isOtherPointKind(metric);
        const isMonotonic = metric.sum?.isMonotonic === true;
        const temporalityCode = temporalityCodeOf(metric.sum?.aggregationTemporality);
        const temporality: Temporality | null = temporalityCode === 1 ? 'delta' : temporalityCode === 2 ? 'cumulative' : null;

        if (isOther) {
          stats.dataPointsInvalid += dataPoints.length;
          rejectionReasons.push(`${metricName}: rejected, not a monotonic Sum (gauge, histogram or summary)`);
          continue;
        }
        if (!isMonotonic) {
          stats.dataPointsInvalid += dataPoints.length;
          rejectionReasons.push(`${metricName}: rejected, Sum is not monotonic`);
          continue;
        }
        if (temporality === null) {
          stats.dataPointsInvalid += dataPoints.length;
          rejectionReasons.push(`${metricName}: rejected, unspecified or unknown aggregationTemporality`);
          continue;
        }

        const unit = metric.unit ?? null;
        const currency: 'USD' | null = metricKind === 'cost' && unit === 'USD' ? 'USD' : null;

        for (const dp of dataPoints) {
          const flags = typeof dp.flags === 'number' ? dp.flags : 0;
          if ((flags & NO_RECORDED_VALUE_FLAG) !== 0) {
            stats.dataPointsIgnoredFlag += 1;
            continue;
          }

          const timeUnixNano = nanoStringOf(dp.timeUnixNano);
          if (timeUnixNano === null) {
            stats.dataPointsInvalid += 1;
            rejectionReasons.push(`${metricName}: rejected, missing or zero timeUnixNano`);
            continue;
          }
          const startTimeUnixNano = nanoStringOf(dp.startTimeUnixNano) ?? '0';

          const asIntBig = bigIntOf(dp.asInt);
          const hasDouble = typeof dp.asDouble === 'number';
          if (asIntBig === null && !hasDouble) {
            stats.dataPointsInvalid += 1;
            rejectionReasons.push(`${metricName}: rejected, neither asInt nor asDouble present`);
            continue;
          }

          let value: number;
          if (asIntBig !== null) {
            if (asIntBig < 0n) {
              stats.dataPointsInvalid += 1;
              rejectionReasons.push(`${metricName}: rejected, negative value`);
              continue;
            }
            if (asIntBig > BigInt(MAX_SAFE_VALUE)) {
              stats.dataPointsInvalid += 1;
              rejectionReasons.push(`${metricName}: rejected, value above 2^53`);
              continue;
            }
            value = Number(asIntBig);
          } else {
            const asDouble = dp.asDouble as number;
            if (!Number.isFinite(asDouble)) {
              stats.dataPointsInvalid += 1;
              rejectionReasons.push(`${metricName}: rejected, value is NaN or infinite`);
              continue;
            }
            if (asDouble < 0) {
              stats.dataPointsInvalid += 1;
              rejectionReasons.push(`${metricName}: rejected, negative value`);
              continue;
            }
            if (Math.abs(asDouble) > MAX_SAFE_VALUE) {
              stats.dataPointsInvalid += 1;
              rejectionReasons.push(`${metricName}: rejected, value above 2^53`);
              continue;
            }
            if (metricKind === 'tokens' && !Number.isInteger(asDouble)) {
              stats.dataPointsInvalid += 1;
              rejectionReasons.push(`${metricName}: rejected, fractional value for a token count`);
              continue;
            }
            value = asDouble;
          }

          const pointAttrsRaw = dp.attributes ?? [];
          const pointAttrs = attributeMap(pointAttrsRaw);
          const rawSessionId = stringOf(pointAttrs.get('session.id')) ?? stringOf(resourceAttrs.get('session.id'));
          const rawModel = stringOf(pointAttrs.get('model')) ?? stringOf(resourceAttrs.get('model'));
          const rawType = stringOf(pointAttrs.get('type'));

          let sessionId: string | null = null;
          let runtimeId: string | null = null;
          if (rawSessionId) {
            const identity = sessionIdentity(rawSessionId);
            sessionId = identity.sessionId;
            runtimeId = 'claude-code';
          } else {
            stats.dataPointsWithoutSession += 1;
          }

          let tokenType: string | null = null;
          if (metricKind === 'tokens') {
            tokenType = rawType ?? null;
            if (tokenType !== null && reconciliationFieldForType(tokenType) === null) unmappedTypes.add(cut(tokenType));
          }

          const seriesKey = computeSeriesKey(options.hmacSecret, metricName, resourceAttrsRaw, pointAttrsRaw);

          points.push({
            receivedAt: receivedAtMs,
            metricName,
            metricKind,
            tokenType: tokenType !== null ? cut(tokenType) : null,
            unit,
            currency,
            temporality,
            seriesKey,
            sessionId,
            runtimeId,
            model: rawModel ? cut(rawModel) : null,
            serviceName: serviceName ? cut(serviceName) : null,
            serviceVersion: serviceVersion ? cut(serviceVersion) : null,
            startTimeUnixNano,
            timeUnixNano,
            timeMs: msFromNanoString(timeUnixNano),
            value,
            wireFormat: options.wireFormat,
          });
        }
      }
    }
  }

  return { points, stats, unmappedTypes, rejectionReasons };
}

export type { ReconciliationTokenField };
