import type express from 'express';

// -------------------------------------------------------------
// Prometheus /metrics (issue #350)
//
// A minimal writer for the Prometheus text exposition format 0.0.4, without prom-client: a registry of
// collectors that are read on every scrape, name/label sanitizing, label-value escaping and number formatting.
// Off unless AGENT_VIEWER_METRICS is set; when off, the route falls through so the 404 is the same as any
// unknown path. Mounted before the global body parser and CORS, with its own auth and rate limit.
// -------------------------------------------------------------

export const METRICS_PATH = '/metrics';
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export type MetricType = 'gauge' | 'counter' | 'histogram';
export type Labels = Record<string, string | number | boolean | undefined>;
export interface Sample {
  labels?: Labels;
  value: number;
  /** Appended to the family name: a histogram's `_bucket`, `_sum` and `_count` series. */
  suffix?: '_bucket' | '_sum' | '_count';
}

export interface MetricDefinition {
  name: string;
  help: string;
  type: MetricType;
  /** Read on every scrape. A bare number is one sample without labels. */
  collect: () => number | Sample[];
}

/** A metric or label name with every invalid character replaced by `_` (and a leading digit prefixed). */
export function sanitizeMetricName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_:]/g, '_');
  return /^[0-9]/.test(cleaned) || cleaned === '' ? `_${cleaned}` : cleaned;
}

/** Label names may not contain `:`, and `__` is reserved for Prometheus itself. */
export function sanitizeLabelName(name: string): string {
  let cleaned = name.replace(/[^a-zA-Z0-9_]/g, '_');
  if (/^[0-9]/.test(cleaned) || cleaned === '') cleaned = `_${cleaned}`;
  return cleaned.startsWith('__') ? cleaned.replace(/^_+/, '_') : cleaned;
}

/** Escapes a label value: backslash, double quote and line feed. */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Escapes HELP text: backslash and line feed only. */
export function escapeHelp(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Formats a sample value the way Prometheus parses it: `NaN`, `+Inf`, `-Inf`, otherwise a plain JS number. */
export function formatMetricValue(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  if (value === -Infinity) return '-Inf';
  if (Object.is(value, -0)) return '0';
  return String(value);
}

function formatLabels(labels: Labels | undefined): string {
  if (!labels) return '';
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(labels)) {
    if (raw === undefined) continue;
    parts.push(`${sanitizeLabelName(key)}="${escapeLabelValue(String(raw))}"`);
  }
  return parts.length ? `{${parts.join(',')}}` : '';
}

export interface MetricsRegistry {
  register(metric: MetricDefinition): void;
  /** The full exposition body, ending in a newline. A collector that throws is skipped, not fatal. */
  render(): string;
}

export function createMetricsRegistry(): MetricsRegistry {
  const metrics = new Map<string, MetricDefinition>();
  return {
    register(metric) {
      const name = sanitizeMetricName(metric.name);
      if (metrics.has(name)) throw new Error(`metric ${name} is already registered`);
      metrics.set(name, metric);
    },
    render() {
      const lines: string[] = [];
      for (const [name, metric] of metrics) {
        let samples: Sample[];
        try {
          const collected = metric.collect();
          samples = typeof collected === 'number' ? [{ value: collected }] : collected;
        } catch {
          continue;
        }
        lines.push(`# HELP ${name} ${escapeHelp(metric.help)}`, `# TYPE ${name} ${metric.type}`);
        for (const sample of samples) {
          lines.push(`${name}${sample.suffix ?? ''}${formatLabels(sample.labels)} ${formatMetricValue(sample.value)}`);
        }
      }
      return lines.length ? `${lines.join('\n')}\n` : '';
    },
  };
}

// ---- histograms and counters (issue #348) ----

/** The `_bucket` (cumulative, ending in `+Inf`), `_sum` and `_count` samples of one histogram series.
 * `cumulative[i]` is the number of observations `<= buckets[i]`. */
export function histogramSamples(labels: Labels, buckets: readonly number[], cumulative: readonly number[], sum: number, count: number): Sample[] {
  const samples: Sample[] = buckets.map((le, i) => ({ suffix: '_bucket', labels: { ...labels, le: formatMetricValue(le) }, value: cumulative[i] }));
  samples.push(
    { suffix: '_bucket', labels: { ...labels, le: '+Inf' }, value: count },
    { suffix: '_sum', labels, value: sum },
    { suffix: '_count', labels, value: count }
  );
  return samples;
}

/** Labelled series kept in insertion order, keyed by their label values. */
class SeriesMap<T> {
  private readonly series = new Map<string, { labels: Labels; value: T }>();
  private readonly init: () => T;
  constructor(init: () => T) {
    this.init = init;
  }
  get(labels: Labels): T {
    const key = JSON.stringify(Object.entries(labels));
    let entry = this.series.get(key);
    if (!entry) {
      entry = { labels, value: this.init() };
      this.series.set(key, entry);
    }
    return entry.value;
  }
  entries(): Array<{ labels: Labels; value: T }> {
    return [...this.series.values()];
  }
}

export interface Counter {
  inc(labels: Labels, by?: number): void;
  collect(): Sample[];
}

export function createCounter(): Counter {
  const series = new SeriesMap(() => ({ n: 0 }));
  return {
    inc(labels, by = 1) {
      if (by > 0) series.get(labels).n += by;
    },
    collect: () => series.entries().map(({ labels, value }) => ({ labels, value: value.n })),
  };
}

export interface Histogram {
  observe(labels: Labels, value: number): void;
  collect(): Sample[];
}

export function createHistogram(buckets: readonly number[]): Histogram {
  const series = new SeriesMap(() => ({ cumulative: buckets.map(() => 0), sum: 0, count: 0 }));
  return {
    observe(labels, value) {
      const entry = series.get(labels);
      buckets.forEach((le, i) => {
        if (value <= le) entry.cumulative[i]++;
      });
      entry.sum += value;
      entry.count++;
    },
    collect: () => series.entries().flatMap(({ labels, value }) => histogramSamples(labels, buckets, value.cumulative, value.sum, value.count)),
  };
}

// ---- ingestion and HTTP metrics (issue #348) ----

export const HTTP_DURATION_BUCKETS_SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/** What an ingestion handler stored, set on `res.locals.ingestion` before it responds. A response without it is
 * one rejected request (auth, rate limit, validation, body too large...), counted by its status code. */
export interface IngestionOutcome {
  accepted: number;
  duplicates: number;
  conflicts: number;
  /** Events refused as a whole (a batch that failed validation stores none of its items). */
  invalid?: number;
}

const INGESTION_CHANNELS: Record<string, string> = {
  '/api/v1/events': 'events',
  '/api/v1/events/batch': 'events-batch',
  '/api/v1/webhooks/generic': 'webhook',
};

function rejectReason(status: number): string {
  if (status === 400 || status === 422) return 'invalid';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too_large';
  if (status === 415) return 'unsupported_media_type';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'not_ready';
  if (status >= 500) return 'error';
  return 'other';
}

function requestPath(req: express.Request): string {
  const url = req.originalUrl ?? req.url;
  const end = url.indexOf('?');
  return end === -1 ? url : url.slice(0, end);
}

/** The route template, never the raw path (an id in the path must not become a label value). */
function routeLabel(req: express.Request): string {
  const routePath = (req as express.Request & { route?: { path?: unknown } }).route?.path;
  return typeof routePath === 'string' ? `${req.baseUrl ?? ''}${routePath}` : 'unmatched';
}

export interface HttpMetrics {
  /** Mount first: times every request and counts ingestion outcomes once the response has finished. */
  middleware: express.RequestHandler;
  register(registry: MetricsRegistry): void;
}

export function createHttpMetrics(): HttpMetrics {
  const accepted = createCounter();
  const duplicates = createCounter();
  const rejected = createCounter();
  const duration = createHistogram(HTTP_DURATION_BUCKETS_SECONDS);

  const middleware: express.RequestHandler = (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      duration.observe({ method: req.method, route: routeLabel(req), code: res.statusCode }, seconds);

      const channel = req.method === 'POST' ? INGESTION_CHANNELS[requestPath(req)] : undefined;
      if (!channel) return;
      const outcome = res.locals.ingestion as IngestionOutcome | undefined;
      if (!outcome) {
        if (res.statusCode >= 400) rejected.inc({ channel, reason: rejectReason(res.statusCode) });
        return;
      }
      accepted.inc({ channel }, outcome.accepted);
      duplicates.inc({ channel }, outcome.duplicates);
      rejected.inc({ channel, reason: 'conflict' }, outcome.conflicts);
      rejected.inc({ channel, reason: 'invalid' }, outcome.invalid ?? 0);
    });
    next();
  };

  return {
    middleware,
    register(registry) {
      registry.register({ name: 'agent_viewer_events_accepted_total', help: 'Events stored, since process start.', type: 'counter', collect: accepted.collect });
      registry.register({
        name: 'agent_viewer_events_duplicate_total',
        help: 'Events recognized as a retry of an already stored event, since process start.',
        type: 'counter',
        collect: duplicates.collect,
      });
      registry.register({
        name: 'agent_viewer_events_rejected_total',
        help: 'Events or ingestion requests refused, by reason, since process start.',
        type: 'counter',
        collect: rejected.collect,
      });
      registry.register({
        name: 'agent_viewer_http_request_duration_seconds',
        help: 'HTTP request duration by method, route template and status code.',
        type: 'histogram',
        collect: duration.collect,
      });
    },
  };
}

// ---- ledger-derived families (issue #348) ----

export const LLM_LATENCY_BUCKETS_SECONDS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120] as const;
export const TOKEN_KINDS = ['input', 'output', 'cache_read', 'cache_write', 'reasoning'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];
/** The provider/model label pair every model past `AGENT_VIEWER_METRICS_MAX_MODELS` is folded into. */
export const OVERFLOW_LABEL = '__other__';

/** One `EventStore.usageMetrics()` group: ledger rows sharing every key field below. */
export interface UsageMetricsGroup {
  provider: string | null;
  model: string | null;
  currency: string | null;
  status: string;
  errorKind: string | null;
  eventType: 'llm.usage' | 'llm.failed';
  /** Lowest ledger `seq` in the group: the model's first appearance, for the cardinality cap. */
  firstSeq: number;
  calls: number;
  tokens: Record<TokenKind, number>;
  /** Calls whose token count of that kind was never reported (NULL), never counted as zero. */
  tokensUnreported: Record<TokenKind, number>;
  /** `cost` with `costSource: provider-reported`. */
  costReported: number;
  /** `cost` with `costSource: estimated`. */
  costEstimated: number;
  /** Calls with no cost, or `costSource: unknown`. */
  costUnknownCalls: number;
  /** `llm.usage` rows with a latency only. */
  latencyCount: number;
  latencySumMs: number;
  /** Cumulative: `latencyBuckets[i]` = calls with `latencyMs <= LLM_LATENCY_BUCKETS_SECONDS[i] * 1000`. */
  latencyBuckets: number[];
}

export interface UsageMetricsSnapshot {
  groups: UsageMetricsGroup[];
  oldestReceivedAt: number | null;
  newestReceivedAt: number | null;
}

const UNKNOWN_LABEL = 'unknown';

function sumInto<K>(map: Map<string, { labels: K; value: number }>, labels: K, value: number): void {
  const key = JSON.stringify(labels);
  const entry = map.get(key);
  if (entry) entry.value += value;
  else map.set(key, { labels, value });
}

function toSamples(map: Map<string, { labels: Labels; value: number }>): Sample[] {
  return [...map.values()].map(({ labels, value }) => ({ labels, value }));
}

/** Every ledger family's samples, computed once per snapshot. Models are kept in order of first appearance up to
 * `maxModels` distinct provider/model pairs; the rest share `provider="__other__",model="__other__"`. */
export function buildLedgerSamples(snapshot: UsageMetricsSnapshot, maxModels: number): Record<string, Sample[]> {
  const firstSeen = new Map<string, number>();
  const pairKey = (g: UsageMetricsGroup) => JSON.stringify([g.provider, g.model]);
  for (const g of snapshot.groups) {
    const key = pairKey(g);
    const seen = firstSeen.get(key);
    if (seen === undefined || g.firstSeq < seen) firstSeen.set(key, g.firstSeq);
  }
  const kept = new Set([...firstSeen.entries()].sort((a, b) => a[1] - b[1]).slice(0, maxModels).map(([key]) => key));

  const tokens = new Map<string, { labels: Labels; value: number }>();
  const unreported = new Map<string, { labels: Labels; value: number }>();
  const costReported = new Map<string, { labels: Labels; value: number }>();
  const costEstimated = new Map<string, { labels: Labels; value: number }>();
  const costUnknown = new Map<string, { labels: Labels; value: number }>();
  const calls = new Map<string, { labels: Labels; value: number }>();
  const failures = new Map<string, { labels: Labels; value: number }>();
  const latency = new Map<string, { labels: Labels; cumulative: number[]; sumMs: number; count: number }>();

  for (const g of snapshot.groups) {
    const model: Labels = kept.has(pairKey(g))
      ? { provider: g.provider ?? UNKNOWN_LABEL, model: g.model ?? UNKNOWN_LABEL }
      : { provider: OVERFLOW_LABEL, model: OVERFLOW_LABEL };
    const currency = g.currency ?? UNKNOWN_LABEL;
    for (const kind of TOKEN_KINDS) {
      sumInto(tokens, { ...model, kind }, g.tokens[kind]);
      sumInto(unreported, { ...model, kind }, g.tokensUnreported[kind]);
    }
    if (g.costReported !== 0) sumInto(costReported, { ...model, currency }, g.costReported);
    if (g.costEstimated !== 0) sumInto(costEstimated, { ...model, currency }, g.costEstimated);
    sumInto(costUnknown, model, g.costUnknownCalls);
    sumInto(calls, { ...model, status: g.status }, g.calls);
    if (g.eventType === 'llm.failed') {
      const errorKind = g.errorKind === null || g.errorKind === 'unknown' ? 'unspecified' : g.errorKind;
      sumInto(failures, { ...model, error_kind: errorKind }, g.calls);
    }
    if (g.latencyCount > 0) {
      const key = JSON.stringify(model);
      const entry = latency.get(key) ?? { labels: model, cumulative: LLM_LATENCY_BUCKETS_SECONDS.map(() => 0), sumMs: 0, count: 0 };
      latency.set(key, entry);
      g.latencyBuckets.forEach((n, i) => (entry.cumulative[i] += n));
      entry.sumMs += g.latencySumMs;
      entry.count += g.latencyCount;
    }
  }

  return {
    agent_viewer_tokens_total: toSamples(tokens),
    agent_viewer_token_kind_unreported_calls_total: toSamples(unreported),
    agent_viewer_cost_reported_total: toSamples(costReported),
    agent_viewer_cost_estimated_total: toSamples(costEstimated),
    agent_viewer_cost_unknown_calls_total: toSamples(costUnknown),
    agent_viewer_llm_calls_total: toSamples(calls),
    agent_viewer_llm_failures_total: toSamples(failures),
    agent_viewer_llm_latency_seconds: [...latency.values()].flatMap((e) =>
      histogramSamples(e.labels, LLM_LATENCY_BUCKETS_SECONDS, e.cumulative, e.sumMs / 1000, e.count)
    ),
    agent_viewer_ledger_retained_since_seconds: snapshot.oldestReceivedAt === null ? [] : [{ value: snapshot.oldestReceivedAt / 1000 }],
    agent_viewer_ledger_last_usage_timestamp_seconds: snapshot.newestReceivedAt === null ? [] : [{ value: snapshot.newestReceivedAt / 1000 }],
  };
}

const LEDGER_FAMILIES: Array<Omit<MetricDefinition, 'collect'>> = [
  { name: 'agent_viewer_tokens_total', type: 'counter', help: 'Tokens reported in the retained usage ledger, by kind. Unreported counts are never added as zero.' },
  { name: 'agent_viewer_token_kind_unreported_calls_total', type: 'counter', help: 'Ledger calls that did not report a token count of this kind.' },
  { name: 'agent_viewer_cost_reported_total', type: 'counter', help: 'Provider-reported cost in the retained usage ledger, per currency.' },
  { name: 'agent_viewer_cost_estimated_total', type: 'counter', help: 'Cost sent as an estimate in the retained usage ledger, per currency.' },
  { name: 'agent_viewer_cost_unknown_calls_total', type: 'counter', help: 'Ledger calls with no known cost.' },
  { name: 'agent_viewer_llm_calls_total', type: 'counter', help: 'LLM calls (llm.usage and llm.failed) in the retained usage ledger, by status.' },
  { name: 'agent_viewer_llm_failures_total', type: 'counter', help: 'llm.failed calls in the retained usage ledger, by error kind.' },
  { name: 'agent_viewer_llm_latency_seconds', type: 'histogram', help: 'Reported latency of llm.usage calls in the retained usage ledger.' },
  { name: 'agent_viewer_ledger_retained_since_seconds', type: 'gauge', help: 'Receive time (Unix seconds) of the oldest retained ledger row; ledger totals cover only rows since then.' },
  { name: 'agent_viewer_ledger_last_usage_timestamp_seconds', type: 'gauge', help: 'Receive time (Unix seconds) of the newest ledger row.' },
];

export interface LedgerMetrics {
  /** Loads (or reuses) the snapshot. Rejects when the ledger query fails; the handler then answers 503. */
  load(): Promise<void>;
  register(registry: MetricsRegistry): void;
}

/**
 * The ledger families, read through a scrape cache: one `usageMetrics()` result serves every scrape for
 * `AGENT_VIEWER_METRICS_CACHE_MS`, and concurrent scrapes while a query is in flight all wait on that one query.
 * A failed query is never cached.
 */
export function createLedgerMetrics(deps: { usageMetrics: () => Promise<UsageMetricsSnapshot>; env?: NodeJS.ProcessEnv; now?: () => number }): LedgerMetrics {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  let cached: { at: number; maxModels: number; samples: Record<string, Sample[]> } | null = null;
  let inFlight: Promise<void> | null = null;

  return {
    load() {
      const maxModels = metricsMaxModels(env);
      if (cached && cached.maxModels === maxModels && now() - cached.at < metricsCacheMs(env)) return Promise.resolve();
      if (inFlight) return inFlight;
      inFlight = deps
        .usageMetrics()
        .then((snapshot) => {
          cached = { at: now(), maxModels, samples: buildLedgerSamples(snapshot, maxModels) };
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    register(registry) {
      for (const family of LEDGER_FAMILIES) {
        registry.register({
          ...family,
          collect: () => {
            if (!cached) throw new Error('ledger metrics not loaded');
            return cached.samples[family.name];
          },
        });
      }
    },
  };
}

// ---- configuration, read per request so tests (and operators) can change it without a restart ----

function nonNegativeIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = envValue(env, name);
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

/** AGENT_VIEWER_METRICS_MAX_MODELS: distinct provider/model pairs labelled before the rest fold into `__other__`. Default 100. */
export function metricsMaxModels(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeIntEnv(env, 'AGENT_VIEWER_METRICS_MAX_MODELS', 100);
}

/** AGENT_VIEWER_METRICS_CACHE_MS: how long one ledger query serves scrapes. Default 5000; 0 disables reuse. */
export function metricsCacheMs(env: NodeJS.ProcessEnv = process.env): number {
  return nonNegativeIntEnv(env, 'AGENT_VIEWER_METRICS_CACHE_MS', 5000);
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

/** AGENT_VIEWER_METRICS: `1`, `true`, `yes` or `on` (any case) turns /metrics on. Anything else keeps it off. */
export function metricsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(envValue(env, 'AGENT_VIEWER_METRICS') ?? '');
}

/** AGENT_VIEWER_METRICS_AUTH=off serves /metrics without a token. Any other value (or none) requires one. */
export function metricsAuthDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(off|false|0|no)$/i.test(envValue(env, 'AGENT_VIEWER_METRICS_AUTH') ?? '');
}

/** AGENT_VIEWER_METRICS_RATE_LIMIT, requests per minute per client IP. Default 120. */
export function metricsRateLimitMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = envValue(env, 'AGENT_VIEWER_METRICS_RATE_LIMIT');
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : 120;
}

export interface MetricsRouteDeps {
  registry: MetricsRegistry;
  /** The /api/v1 token, used when AGENT_VIEWER_METRICS_TOKEN is not set. */
  getApiToken: () => string | undefined;
  /** Constant-time comparison. */
  safeEqual: (provided: string, expected: string) => boolean;
  /** Awaited before every render (the ledger snapshot). A rejection is a 503, never a partial body. */
  prepare?: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_TRACKED_CLIENTS = 10_000;

/**
 * The whole /metrics route as one handler: off → fall through (same 404 as any unknown path), then its own
 * rate limit (separate from /api/v1's, so scrapes never eat into the API budget and vice versa), then 405 for
 * anything but GET/HEAD, then Bearer auth, then the body. `?token=`/`?api_key=` are never read.
 */
export function createMetricsHandler(deps: MetricsRouteDeps): express.RequestHandler {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const rateLimits = new Map<string, { count: number; resetAt: number }>();

  return async (req, res, next) => {
    if (!metricsEnabled(env)) {
      next();
      return;
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const at = now();
    const max = metricsRateLimitMax(env);
    let entry = rateLimits.get(ip);
    if (!entry && rateLimits.size >= RATE_LIMIT_MAX_TRACKED_CLIENTS) {
      for (const [key, value] of rateLimits) if (value.resetAt <= at) rateLimits.delete(key);
    }
    if (!entry || entry.resetAt <= at) {
      entry = { count: 0, resetAt: at + RATE_LIMIT_WINDOW_MS };
      rateLimits.set(ip, entry);
    }
    entry.count++;
    res.setHeader('Cache-Control', 'no-store');
    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - at) / 1000))));
      res.status(429).json({ error: 'rate_limit_exceeded', message: `Too many requests. Limit: ${max}/min` });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      res.status(405).json({ error: 'method_not_allowed', message: 'Use GET or HEAD' });
      return;
    }

    if (!metricsAuthDisabled(env)) {
      const expected = envValue(env, 'AGENT_VIEWER_METRICS_TOKEN') ?? deps.getApiToken();
      if (!expected) {
        res.status(403).json({
          error: 'metrics_require_token',
          message: 'Set AGENT_VIEWER_METRICS_TOKEN or AGENT_VIEWER_API_TOKEN, or AGENT_VIEWER_METRICS_AUTH=off',
        });
        return;
      }
      const header = req.header('authorization') ?? '';
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match || !deps.safeEqual(match[1].trim(), expected)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        res.status(401).json({ error: 'unauthorized', message: 'Valid Bearer token required' });
        return;
      }
    }

    try {
      await deps.prepare?.();
    } catch {
      res.status(503).json({ error: 'metrics_unavailable', message: 'The usage ledger could not be read; try again' });
      return;
    }

    // Written with res.end, not res.send: send would rewrite the content type and reorder its parameters.
    const body = deps.registry.render();
    res.status(200);
    res.setHeader('Content-Type', METRICS_CONTENT_TYPE);
    res.setHeader('Content-Length', String(Buffer.byteLength(body)));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
