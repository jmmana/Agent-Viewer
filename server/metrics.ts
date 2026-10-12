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

export type MetricType = 'gauge' | 'counter';
export type Labels = Record<string, string | number | boolean | undefined>;
export interface Sample {
  labels?: Labels;
  value: number;
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
        for (const sample of samples) lines.push(`${name}${formatLabels(sample.labels)} ${formatMetricValue(sample.value)}`);
      }
      return lines.length ? `${lines.join('\n')}\n` : '';
    },
  };
}

// ---- configuration, read per request so tests (and operators) can change it without a restart ----

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

  return (req, res, next) => {
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

    // Written with res.end, not res.send: send would rewrite the content type and reorder its parameters.
    const body = deps.registry.render();
    res.status(200);
    res.setHeader('Content-Type', METRICS_CONTENT_TYPE);
    res.setHeader('Content-Length', String(Buffer.byteLength(body)));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
