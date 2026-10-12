/**
 * Optional OTLP/HTTP JSON metrics push (issue #103 section 4, sub-issue #349). Off by default
 * (`AGENT_VIEWER_OTLP_METRICS_ENDPOINT` unset): encodes the same `MetricFamily[]` catalog `server/metrics.ts`
 * renders for `GET /metrics` into an OTLP `ExportMetricsServiceRequest` JSON body and POSTs it to a collector on
 * an interval, independent of whether `AGENT_VIEWER_METRICS` itself is enabled.
 *
 * This module never aggregates anything on its own: `collectFamilies()` (injected by `server/index.ts`, the same
 * `buildInProcessFamilies()` call the `/metrics` route uses) is the single source of truth, so the two surfaces
 * can never disagree. Today every family is in-process (the ledger-derived families land with issue #348), so
 * every data point uses the process start time as `startTimeUnixNano`; once #348 adds ledger-derived families,
 * `server/index.ts` should pass a `startTimeUnixNanoFor` that resolves those by name to the oldest retained
 * ledger row instead, per issue #103 section 4's rule. `buildOtlpMetricsPayload`'s `switch` over `MetricType` is
 * written to fail to compile (not silently mis-encode) the day that union grows a third member such as a
 * histogram, so that follow-up work cannot be missed here.
 *
 * Push is best-effort and fully isolated from request handling: it never awaits inside a request handler, a slow
 * or unreachable collector never affects ingestion latency, and every failure is swallowed into a counted outcome
 * rather than thrown. Header values and the configured endpoint are deliberately never logged (they may embed a
 * bearer token), mirroring `server/budgetAlertDelivery.ts`'s same rule for its own outbound webhook URL/secret.
 */
import type { MetricFamily } from './metrics';

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 10_000;

/** `base = min(5s * 2^(attempt-1), 5min)`; the backoff ceiling per issue #103 section 4 ("capped exponential
 * backoff (max 5 minutes)"), a lower cap than `budgetAlertDelivery.ts`'s own 1-hour one since a metrics push that
 * stays silent for an hour is far less useful than a webhook retried that slowly. */
const OTLP_PUSH_BASE_DELAY_MS = 5_000;
export const OTLP_PUSH_MAX_BACKOFF_MS = 5 * 60 * 1000;

export interface OtlpMetricsPushConfig {
  /** Never logged: may embed a token in its path or query string, same rule as `AlertWebhookConfig.url`. */
  endpoint: string;
  /** Parsed from `k=v,k2=v2`. Never logged. */
  headers: Record<string, string>;
  intervalMs: number;
  timeoutMs: number;
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!raw) return headers;
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    // No `=`, or an empty key: skipped rather than thrown, since a malformed single pair should not take down a
    // best-effort feature's entire config (unlike the endpoint itself, which is load-bearing).
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === '') continue;
    headers[key] = value;
  }
  return headers;
}

function parseNonNegativeIntEnv(raw: string | undefined, varName: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(`[agent-viewer] ${varName} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return Number(trimmed);
}

/**
 * Parses and validates the OTLP metrics push config, read once at startup like `parseAlertWebhookConfig`. Returns
 * `null` when `AGENT_VIEWER_OTLP_METRICS_ENDPOINT` is unset or blank (the feature is off) or when it fails the
 * `http:`/`https:` check, in which case `onInvalidEndpoint` (if given) receives a short, URL-free message so
 * `server/index.ts` can log the "startup error line" issue #103 section 4 calls for. Unlike
 * `parseAlertWebhookConfig`, a bad endpoint here only disables the push; it never fails the whole server, since
 * this feature is independent of `AGENT_VIEWER_METRICS` and the rest of the server.
 */
export function parseOtlpMetricsPushConfig(
  env: Record<string, string | undefined>,
  onInvalidEndpoint?: (message: string) => void
): OtlpMetricsPushConfig | null {
  const rawEndpoint = env.AGENT_VIEWER_OTLP_METRICS_ENDPOINT;
  const trimmedEndpoint = typeof rawEndpoint === 'string' ? rawEndpoint.trim() : '';
  if (trimmedEndpoint === '') return null;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedEndpoint);
  } catch {
    onInvalidEndpoint?.(
      '[agent-viewer] AGENT_VIEWER_OTLP_METRICS_ENDPOINT is not a valid URL; OTLP metrics push is disabled.'
    );
    return null;
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    onInvalidEndpoint?.(
      '[agent-viewer] AGENT_VIEWER_OTLP_METRICS_ENDPOINT must use http or https; OTLP metrics push is disabled.'
    );
    return null;
  }

  const headers = parseHeaders(env.AGENT_VIEWER_OTLP_METRICS_HEADERS);
  const rawIntervalMs = parseNonNegativeIntEnv(
    env.AGENT_VIEWER_OTLP_METRICS_INTERVAL_MS,
    'AGENT_VIEWER_OTLP_METRICS_INTERVAL_MS',
    DEFAULT_INTERVAL_MS
  );
  // "minimum 5000" (issue #103 section 4) is a floor, not a startup failure: a too-low value is simply raised.
  const intervalMs = Math.max(rawIntervalMs, MIN_INTERVAL_MS);
  const timeoutMs = parseNonNegativeIntEnv(
    env.AGENT_VIEWER_OTLP_METRICS_TIMEOUT_MS,
    'AGENT_VIEWER_OTLP_METRICS_TIMEOUT_MS',
    DEFAULT_TIMEOUT_MS
  );

  return { endpoint: trimmedEndpoint, headers, intervalMs, timeoutMs };
}

// -------------------------------------------------------------
// OTLP/HTTP JSON encoding (issue #103 section 4: same data model as the Prometheus catalog, decimal-string
// 64-bit fields, `service.name`/`service.version` resource attributes).
// -------------------------------------------------------------

interface OtlpKeyValueOut {
  key: string;
  value: { stringValue: string };
}

function attributesFromLabels(labels: Record<string, string>): OtlpKeyValueOut[] {
  return Object.keys(labels).map((key) => ({ key, value: { stringValue: labels[key]! } }));
}

/** Per the OTLP JSON mapping, an integer value is written as a decimal-string `asInt` (so a 64-bit count is never
 * truncated by JSON's own `number` precision); any non-integer (every cost family) is `asDouble`. */
function encodeNumberValue(value: number): { asInt: string } | { asDouble: number } {
  return Number.isInteger(value) ? { asInt: String(value) } : { asDouble: value };
}

export interface OtlpPushEncodeOptions {
  serviceVersion: string;
  /** Decimal-string nanoseconds, this push's `timeUnixNano`. */
  nowUnixNano: string;
  /** Resolves a family's `startTimeUnixNano` by name; see this module's top comment for the #348 hand-off. */
  startTimeUnixNanoFor: (familyName: string) => string;
}

/**
 * Builds the OTLP `ExportMetricsServiceRequest` JSON body for one push, or `null` when every family is empty
 * (issue #103 section 4: "omission of empty series" applies to the whole request, not just one family, since an
 * empty `resourceMetrics` is pointless to send). A family with zero samples is skipped entirely, matching
 * `/metrics`'s own cardinality rules (unlike the Prometheus text format, OTLP has no "registered but unobserved"
 * concept worth encoding).
 */
export function buildOtlpMetricsPayload(
  families: readonly MetricFamily[],
  options: OtlpPushEncodeOptions
): Record<string, unknown> | null {
  const metrics: Record<string, unknown>[] = [];
  for (const family of families) {
    if (family.samples.length === 0) continue;
    switch (family.type) {
      case 'counter':
        metrics.push({
          name: family.name,
          description: family.help,
          sum: {
            dataPoints: family.samples.map((sample) => ({
              attributes: attributesFromLabels(sample.labels),
              startTimeUnixNano: options.startTimeUnixNanoFor(family.name),
              timeUnixNano: options.nowUnixNano,
              ...encodeNumberValue(sample.value),
            })),
            aggregationTemporality: 2, // AGGREGATION_TEMPORALITY_CUMULATIVE
            isMonotonic: true,
          },
        });
        break;
      case 'gauge':
        // Gauges carry no start time (issue #103 section 4).
        metrics.push({
          name: family.name,
          description: family.help,
          gauge: {
            dataPoints: family.samples.map((sample) => ({
              attributes: attributesFromLabels(sample.labels),
              timeUnixNano: options.nowUnixNano,
              ...encodeNumberValue(sample.value),
            })),
          },
        });
        break;
      default: {
        // Exhaustiveness guard: a future `MetricType` member (for example a histogram, added by issue #348) must
        // fail this build until this encoder is taught to handle it, rather than silently falling through as a
        // gauge or a counter.
        const exhaustive: never = family.type;
        throw new Error(`OTLP metrics push: unsupported metric type ${String(exhaustive)}`);
      }
    }
  }
  if (metrics.length === 0) return null;
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'agent-viewer' } },
            { key: 'service.version', value: { stringValue: options.serviceVersion } },
          ],
        },
        scopeMetrics: [{ scope: { name: 'agent-viewer' }, metrics }],
      },
    ],
  };
}

// -------------------------------------------------------------
// One push attempt (mirrors `budgetAlertDelivery.ts#attemptAlertDelivery`'s classification table).
// -------------------------------------------------------------

export type OtlpPushOutcome =
  | { kind: 'success'; status: number }
  | { kind: 'retry'; status: number | null; retryAfterMs: number | null }
  | { kind: 'terminal'; status: number };

export interface OtlpPushAttemptDeps {
  fetchImpl: typeof fetch;
  now: () => number;
}

/** `Retry-After` as delta-seconds or an HTTP date, same parsing `budgetAlertDelivery.ts` uses. */
function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^[0-9]+$/.test(trimmed)) return Number(trimmed) * 1000;
  const parsedDate = Date.parse(trimmed);
  if (Number.isNaN(parsedDate)) return null;
  return Math.max(0, parsedDate - now);
}

/**
 * Performs exactly one HTTP attempt and classifies it (issue #103 section 4): any `2xx` is `'success'`; a network
 * error, a timeout, `429` or any `5xx` is `'retry'` (honoring `Retry-After`); any other `4xx` is `'terminal'` (not
 * retried until the next normal interval). Never throws. The response body is never read into the outcome: it may
 * come from a misconfigured proxy that echoes request headers, and nothing here needs its content.
 */
export async function attemptOtlpMetricsPush(
  config: OtlpMetricsPushConfig,
  payload: Record<string, unknown>,
  deps: OtlpPushAttemptDeps
): Promise<OtlpPushOutcome> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...config.headers };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await deps.fetchImpl(config.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // Drain the body so the connection can be reused; a read failure here is not itself a push failure.
    await response.text().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) {
      return { kind: 'success', status: response.status };
    }
    if (response.status === 429 || response.status >= 500) {
      return { kind: 'retry', status: response.status, retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), deps.now()) };
    }
    return { kind: 'terminal', status: response.status };
  } catch {
    // A network error or an aborted (timed out) request: issue #103 section 4 treats both as retryable.
    return { kind: 'retry', status: null, retryAfterMs: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `base = min(5s * 2^(attempt-1), 5min)`, delay uniform in `[base/2, base]` (an injectable `random` in `[0, 1)`).
 * A `Retry-After` value raises the floor (never lowers it) and, if it would exceed the computed ceiling, raises
 * the ceiling to match; both the floor and the final delay stay capped at `OTLP_PUSH_MAX_BACKOFF_MS`. Same shape
 * as `budgetAlertDelivery.ts#computeBackoffMs`, with this feature's own, shorter 5-minute cap.
 */
export function computeOtlpPushBackoffMs(attempt: number, retryAfterMs: number | null, random: () => number = Math.random): number {
  const base = Math.min(OTLP_PUSH_BASE_DELAY_MS * 2 ** (attempt - 1), OTLP_PUSH_MAX_BACKOFF_MS);
  let floor = base / 2;
  let ceiling = base;
  if (retryAfterMs !== null) {
    const cappedRetryAfter = Math.min(retryAfterMs, OTLP_PUSH_MAX_BACKOFF_MS);
    floor = Math.max(floor, cappedRetryAfter);
    ceiling = Math.max(ceiling, floor);
  }
  const span = ceiling - floor;
  const delay = floor + random() * span;
  return Math.min(Math.round(delay), OTLP_PUSH_MAX_BACKOFF_MS);
}

// -------------------------------------------------------------
// `agent_viewer_otlp_push_total`/`agent_viewer_otlp_push_last_success_timestamp_seconds` (issue #103 section 2):
// only meaningful, and only exposed on `/metrics`, when the push itself is on.
// -------------------------------------------------------------

export interface OtlpPushStats {
  total: { ok: number; error: number };
  /** `null` until the first successful push; never written as `0` before then (issue #103's "unknown is never
   * zero" rule, applied here to "no success yet" rather than to a ledger figure). */
  lastSuccessUnixSeconds: number | null;
}

export function buildOtlpPushFamilies(stats: OtlpPushStats): MetricFamily[] {
  return [
    {
      name: 'agent_viewer_otlp_push_total',
      help: 'Outcomes of the optional OTLP metrics push.',
      type: 'counter',
      samples: [
        { labels: { outcome: 'ok' }, value: stats.total.ok },
        { labels: { outcome: 'error' }, value: stats.total.error },
      ],
    },
    {
      name: 'agent_viewer_otlp_push_last_success_timestamp_seconds',
      help: 'Unix time of the last successful OTLP metrics push. Absent until the first success.',
      type: 'gauge',
      samples: stats.lastSuccessUnixSeconds !== null ? [{ labels: {}, value: stats.lastSuccessUnixSeconds }] : [],
    },
  ];
}

// -------------------------------------------------------------
// The periodic worker.
// -------------------------------------------------------------

export interface OtlpMetricsPushWorkerOptions {
  config: OtlpMetricsPushConfig;
  /** The exact family list `/metrics` itself renders (today, `buildInProcessFamilies(...)`); this module never
   * aggregates its own. */
  collectFamilies: () => readonly MetricFamily[];
  serviceVersion: string;
  /** Decimal-string nanoseconds; defaults to this call's own time, i.e. "process start" when the worker is
   * started at process startup, as every current family is in-process. */
  processStartUnixNano?: string;
  now?: () => number;
  random?: () => number;
  fetchImpl?: typeof fetch;
  /** Defaults to `console.warn`. Never receives header values, the endpoint or a response body. */
  log?: (message: string) => void;
}

export interface OtlpMetricsPushWorkerHandle {
  /** Stops the scheduled timer and waits for an in-flight push to settle. Safe to call more than once. */
  stop(): Promise<void>;
  /** Runs one push immediately instead of waiting for the next scheduled tick (used by tests). Resolves once that
   * push has settled. */
  pushNow(): Promise<void>;
  getStats(): OtlpPushStats;
}

function nowUnixNanoString(nowMs: number): string {
  return `${BigInt(Math.max(0, Math.round(nowMs))) * 1_000_000n}`;
}

/**
 * Starts the push loop (issue #103 section 4): a recursive, unref'd `setTimeout` (not `setInterval`) so the delay
 * can vary with backoff, wired independently of `AGENT_VIEWER_METRICS`. The very first push happens one interval
 * after this is called (an exporter's conventional "wait, then report" shape; `pushNow()` exists precisely so
 * tests do not have to wait a real interval). A bug anywhere in one push's handling is caught and counted as an
 * `'error'` outcome rather than ever propagating, the same policy `startAlertDeliveryWorker` follows.
 */
export function startOtlpMetricsPush(opts: OtlpMetricsPushWorkerOptions): OtlpMetricsPushWorkerHandle {
  const { config, collectFamilies, serviceVersion } = opts;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((message: string) => console.warn(message));
  const processStartUnixNano = opts.processStartUnixNano ?? nowUnixNanoString(now());

  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  const stats: OtlpPushStats = { total: { ok: 0, error: 0 }, lastSuccessUnixSeconds: null };

  function scheduleNext(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = runPush();
    }, delayMs);
    timer.unref?.();
  }

  async function runPush(): Promise<void> {
    try {
      const families = collectFamilies();
      const payload = buildOtlpMetricsPayload(families, {
        serviceVersion,
        nowUnixNano: nowUnixNanoString(now()),
        startTimeUnixNanoFor: () => processStartUnixNano,
      });
      if (payload === null) {
        scheduleNext(config.intervalMs);
        return;
      }

      const outcome = await attemptOtlpMetricsPush(config, payload, { fetchImpl, now });
      if (outcome.kind === 'success') {
        attempt = 0;
        stats.total.ok += 1;
        stats.lastSuccessUnixSeconds = Math.floor(now() / 1000);
        scheduleNext(config.intervalMs);
        return;
      }

      stats.total.error += 1;
      if (outcome.kind === 'retry') {
        attempt += 1;
        const delay = computeOtlpPushBackoffMs(attempt, outcome.retryAfterMs, random);
        log(`[agent-viewer] OTLP metrics push failed (status=${outcome.status ?? 'network_error'}); retrying in ${delay}ms`);
        scheduleNext(delay);
      } else {
        // terminal 4xx: never retried before the next normal interval, and never escalates the backoff counter.
        attempt = 0;
        log(`[agent-viewer] OTLP metrics push rejected (status=${outcome.status}); not retrying until the next interval`);
        scheduleNext(config.intervalMs);
      }
    } catch (error) {
      stats.total.error += 1;
      log(`[agent-viewer] OTLP metrics push worker error: ${error instanceof Error ? error.message : String(error)}`);
      scheduleNext(config.intervalMs);
    }
  }

  scheduleNext(config.intervalMs);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight;
    },
    async pushNow() {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      const run = runPush();
      inFlight = run;
      await run;
    },
    getStats() {
      return { total: { ...stats.total }, lastSuccessUnixSeconds: stats.lastSuccessUnixSeconds };
    },
  };
}
