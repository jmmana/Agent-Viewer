/**
 * Minimal Prometheus text-exposition writer for `GET /metrics` (issue #103, first sub-issue). No `prom-client`,
 * no runtime dependency, about 100 lines: a label sanitizer/escaper and a renderer for the text format 0.0.4.
 *
 * This slice ships only the in-process families `server/index.ts` can compute without a ledger query:
 * `agent_viewer_build_info` and `agent_viewer_sse_clients`. The ledger-derived families (tokens, cost, calls,
 * failures, latency) and the cardinality cap they need are a later sub-issue of #103, tracked separately so the
 * endpoint, its auth model and its opt-in/rate-limit plumbing can ship and be reviewed on their own first. See
 * `docs/metrics.md` for the full catalog.
 *
 * Issue #365 adds the in-process ingestion counters (`agent_viewer_events_accepted_total`,
 * `agent_viewer_events_duplicate_total`, `agent_viewer_events_rejected_total`) and the
 * `agent_viewer_http_request_duration_seconds` histogram, accumulated by `IngestionMetrics` below.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricSample {
  labels: Record<string, string>;
  value: number;
  /** Appended to the family name on this series line: `_bucket`, `_sum` or `_count` for a histogram. */
  suffix?: string;
}

export interface MetricFamily {
  name: string;
  help: string;
  type: MetricType;
  samples: MetricSample[];
}

const MAX_LABEL_VALUE_LENGTH = 100;

/**
 * Label hygiene (issue #103): strips control characters and caps length at 100 characters. Every label value
 * this module ever writes goes through this first, so two values that collapse to the same sanitized string
 * would merge in the caller's own grouping, never silently overwrite one another here.
 */
export function sanitizeLabelValue(value: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately stripping C0/DEL control characters from a label value
  const stripped = value.replace(/[\x00-\x1f\x7f]/g, '');
  return stripped.length > MAX_LABEL_VALUE_LENGTH ? stripped.slice(0, MAX_LABEL_VALUE_LENGTH) : stripped;
}

/** Escapes a label value for the text exposition format: backslash, then double quote, then newline, in that
 * order (escaping backslash first so the backslashes introduced by the later two steps are never re-escaped). */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Plain decimal, up to 10 fractional digits, trailing zeros trimmed, no exponent (issue #103's number format
 * rule). Non-finite values are never produced by a caller in this codebase; this still never writes one. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return '';
  return `{${keys.map((key) => `${key}="${escapeLabelValue(labels[key]!)}"`).join(',')}}`;
}

function writeFamily(lines: string[], family: MetricFamily): void {
  lines.push(`# HELP ${family.name} ${family.help}`);
  lines.push(`# TYPE ${family.name} ${family.type}`);
  for (const sample of family.samples) {
    lines.push(`${family.name}${sample.suffix ?? ''}${formatLabels(sample.labels)} ${formatNumber(sample.value)}`);
  }
}

/**
 * Renders every family to the final response body: `# HELP`/`# TYPE` plus each sample, in the order given, one
 * series line per sample. A family with zero samples still gets its `HELP`/`TYPE` lines, same as a Prometheus
 * client library's registered-but-unobserved metric. Ends with a trailing newline, per the exposition format;
 * returns `''` (no trailing newline) when there are no families at all.
 */
export function renderExposition(families: readonly MetricFamily[]): string {
  const lines: string[] = [];
  for (const family of families) writeFamily(lines, family);
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface InProcessMetricsInput {
  version: string;
  storage: 'memory' | 'sqlite';
  sseClients: number;
}

/**
 * The two in-process families this sub-issue ships. Both are computed fresh at scrape time from state
 * `server/index.ts` already keeps (`SERVER_VERSION`, `store.readiness().storage`, `clients.size`), never cached
 * and never reset except by a process restart.
 */
export function buildInProcessFamilies(input: InProcessMetricsInput): MetricFamily[] {
  return [
    {
      name: 'agent_viewer_build_info',
      help: 'Server version and storage mode. Value is always 1; the facts are in the labels.',
      type: 'gauge',
      samples: [
        {
          labels: { version: sanitizeLabelValue(input.version), storage: input.storage },
          value: 1,
        },
      ],
    },
    {
      name: 'agent_viewer_sse_clients',
      help: 'Open Server-Sent Events stream connections.',
      type: 'gauge',
      samples: [{ labels: {}, value: input.sseClients }],
    },
  ];
}

// -------------------------------------------------------------
// In-process ingestion counters (issue #365)
// -------------------------------------------------------------

export type DuplicateKind = 'identical' | 'conflicting';

export type RejectionEndpoint =
  | 'events'
  | 'events_batch'
  | 'webhook_generic'
  | 'otlp_logs'
  | 'otlp_metrics'
  | 'otlp_traces'
  | 'metrics'
  | 'other';

export type RejectionReason =
  | 'validation'
  | 'empty_batch'
  | 'batch_too_large'
  | 'malformed_json'
  | 'payload_too_large'
  | 'unrecognized_payload'
  | 'unauthorized'
  | 'rate_limited'
  | 'signature'
  | 'replay';

/** Upper bounds, in seconds, of `agent_viewer_http_request_duration_seconds` (issue #365). */
export const HTTP_DURATION_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Route label for a request no route matched (a 404, or a rejection by middleware before any route ran). */
export const UNMATCHED_ROUTE = '__unmatched__';

const ENDPOINT_BY_PATH: ReadonlyMap<string, RejectionEndpoint> = new Map<string, RejectionEndpoint>([
  ['/api/v1/events', 'events'],
  ['/api/v1/events/batch', 'events_batch'],
  ['/api/v1/webhooks/generic', 'webhook_generic'],
  ['/v1/logs', 'otlp_logs'],
  ['/v1/metrics', 'otlp_metrics'],
  ['/v1/traces', 'otlp_traces'],
  ['/metrics', 'metrics'],
]);

/** Path part of `req.originalUrl`, lowercased and without a trailing slash, matching Express's default
 * case-insensitive, non-strict routing. */
export function normalizeRequestPath(originalUrl: string): string {
  const path = originalUrl.split('?')[0]!.toLowerCase();
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** The `endpoint` label of a rejection, from `req.originalUrl` (the counting middleware runs before any route
 * matches, so it cannot rely on `req.route`). */
export function rejectionEndpoint(originalUrl: string): RejectionEndpoint {
  return ENDPOINT_BY_PATH.get(normalizeRequestPath(originalUrl)) ?? 'other';
}

/** `2xx`, `4xx`, ...; anything outside 100-599 collapses to `other`, so the label set stays bounded. */
export function statusClass(status: number): string {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? `${Math.floor(status / 100)}xx` : 'other';
}

interface HistogramSeries {
  labels: Record<string, string>;
  /** Non-cumulative per-bucket counts, same order as `HTTP_DURATION_BUCKETS`; the `+Inf` overflow is implied
   * by `count`. */
  buckets: number[];
  sum: number;
  count: number;
}

/**
 * Process-lifetime accumulator for the four ingestion families. Reset only by a restart (or `reset()`, for
 * tests). Every series key is built from a bounded label set: event `type` is the canonical event type the store
 * already validated, and `route` is an Express route template, never a raw URL.
 */
export class IngestionMetrics {
  private readonly accepted = new Map<string, number>();
  private readonly duplicates = new Map<DuplicateKind, number>();
  private readonly rejected = new Map<string, { endpoint: RejectionEndpoint; reason: RejectionReason; value: number }>();
  private readonly durations = new Map<string, HistogramSeries>();

  recordAccepted(type: string, count = 1): void {
    this.accepted.set(type, (this.accepted.get(type) ?? 0) + count);
  }

  recordDuplicate(kind: DuplicateKind, count = 1): void {
    if (count > 0) this.duplicates.set(kind, (this.duplicates.get(kind) ?? 0) + count);
  }

  recordRejected(endpoint: RejectionEndpoint, reason: RejectionReason): void {
    const key = `${endpoint}\u0000${reason}`;
    const entry = this.rejected.get(key);
    if (entry) entry.value += 1;
    else this.rejected.set(key, { endpoint, reason, value: 1 });
  }

  observeRequest(method: string, route: string, status: number, seconds: number): void {
    const labels = { method: sanitizeLabelValue(method.toUpperCase()), route: sanitizeLabelValue(route), status_class: statusClass(status) };
    const key = `${labels.method}\u0000${labels.route}\u0000${labels.status_class}`;
    let series = this.durations.get(key);
    if (!series) {
      series = { labels, buckets: HTTP_DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 };
      this.durations.set(key, series);
    }
    const index = HTTP_DURATION_BUCKETS.findIndex((bound) => seconds <= bound);
    if (index >= 0) series.buckets[index] = (series.buckets[index] ?? 0) + 1;
    series.sum += seconds;
    series.count += 1;
  }

  reset(): void {
    this.accepted.clear();
    this.duplicates.clear();
    this.rejected.clear();
    this.durations.clear();
  }

  families(): MetricFamily[] {
    const histogramSamples: MetricSample[] = [];
    for (const series of this.durations.values()) {
      let cumulative = 0;
      HTTP_DURATION_BUCKETS.forEach((bound, index) => {
        cumulative += series.buckets[index]!;
        histogramSamples.push({ suffix: '_bucket', labels: { ...series.labels, le: formatNumber(bound) }, value: cumulative });
      });
      histogramSamples.push({ suffix: '_bucket', labels: { ...series.labels, le: '+Inf' }, value: series.count });
      histogramSamples.push({ suffix: '_sum', labels: series.labels, value: series.sum });
      histogramSamples.push({ suffix: '_count', labels: series.labels, value: series.count });
    }
    return [
      {
        name: 'agent_viewer_events_accepted_total',
        help: 'Canonical events newly stored by the server, by event type.',
        type: 'counter',
        samples: [...this.accepted].map(([type, value]) => ({ labels: { type: sanitizeLabelValue(type) }, value })),
      },
      {
        name: 'agent_viewer_events_duplicate_total',
        help: 'Events re-sent under an already-stored id: identical content, or conflicting content (not applied).',
        type: 'counter',
        samples: [...this.duplicates].map(([kind, value]) => ({ labels: { kind }, value })),
      },
      {
        name: 'agent_viewer_events_rejected_total',
        help: 'Ingestion requests rejected before any event was stored, by endpoint and reason.',
        type: 'counter',
        samples: [...this.rejected.values()].map(({ endpoint, reason, value }) => ({ labels: { endpoint, reason }, value })),
      },
      {
        name: 'agent_viewer_http_request_duration_seconds',
        help: 'Server request handling time by method, route template and status class. Excludes /metrics and the SSE stream.',
        type: 'histogram',
        samples: histogramSamples,
      },
    ];
  }
}
