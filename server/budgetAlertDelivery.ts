import crypto from 'node:crypto';
import { isLoopbackHost } from './network';

/**
 * Signed outbound webhook delivery for `budget.alert` events (issue #86, sub-issue #321). Mirrors the inbound
 * HMAC scheme the server already verifies on `/api/v1/webhooks/generic` (`server/index.ts`, `safeEqual` +
 * `X-Agent-Viewer-Signature`/`X-Agent-Viewer-Timestamp`, hex HMAC-SHA256 of `${timestamp}.${rawBody}`), with its
 * own, separate secret (`AGENT_VIEWER_ALERT_WEBHOOK_SECRET`): the inbound `AGENT_VIEWER_WEBHOOK_SECRET` is never
 * read by this module.
 *
 * This module is pure config parsing, pure HMAC/retry math and a persisted polling worker; it never decides
 * *whether* a given alert is delivered (backfill vs. no URL configured) or how the delivery row is written
 * atomically with the alert and event rows: that is `server/store.ts#recordBudgetAlert`, called from
 * `server/index.ts`'s `onBudgetTransition` listener, which is also the only place config is read and the worker
 * is started.
 */

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_MAX_ATTEMPTS = 1;
const MAX_MAX_ATTEMPTS = 20;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 60_000;

/** `base = min(5s * 2^(attempt-1), 1h)`; the backoff ceiling and the `Retry-After` cap are both this value. */
const BASE_DELAY_MS = 5000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

/** Truncation cap for `last_error` (issue #321's own 2 KB rule), applied before a value ever reaches storage. */
export const LAST_ERROR_MAX_LENGTH = 2048;

export interface AlertWebhookConfig {
  /** Never logged and never part of a thrown error message: it may embed a token in its path or query. */
  url: string;
  /** `null` when `AGENT_VIEWER_ALERT_WEBHOOK_SECRET` is unset or blank: deliveries are sent unsigned. */
  secret: string | null;
  allowHttp: boolean;
  maxAttempts: number;
  timeoutMs: number;
}

function numericEnvError(varName: string, min: number, max: number): Error {
  return new Error(`[agent-viewer] ${varName} must be an integer from ${min} to ${max}`);
}

function parseRangedInt(raw: string | undefined, varName: string, min: number, max: number, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) throw numericEnvError(varName, min, max);
  const value = Number(trimmed);
  if (value < min || value > max) throw numericEnvError(varName, min, max);
  return value;
}

/**
 * Parses and validates the outbound alert webhook config, read once at module load by `server/index.ts` exactly
 * like `parseRetentionConfig` (`server/retention.ts`). Returns `null` when `AGENT_VIEWER_ALERT_WEBHOOK_URL` is
 * unset or blank: the feature is off, no worker is started, and every alert's delivery row is written `skipped`.
 *
 * Every thrown message is generic by design: it never echoes the configured URL (which may embed a token in its
 * path or query string) or any part of the secret, per issue #321's own startup-validation rule.
 */
export function parseAlertWebhookConfig(env: Record<string, string | undefined>): AlertWebhookConfig | null {
  const rawUrl = env.AGENT_VIEWER_ALERT_WEBHOOK_URL;
  const trimmedUrl = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (trimmedUrl === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmedUrl);
  } catch {
    throw new Error('[agent-viewer] AGENT_VIEWER_ALERT_WEBHOOK_URL is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('[agent-viewer] AGENT_VIEWER_ALERT_WEBHOOK_URL must use http or https');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('[agent-viewer] AGENT_VIEWER_ALERT_WEBHOOK_URL must not embed user:pass@ credentials');
  }

  const allowHttp = env.AGENT_VIEWER_ALERT_WEBHOOK_ALLOW_HTTP === '1';
  if (parsed.protocol === 'http:' && !allowHttp && !isLoopbackHost(parsed.hostname)) {
    throw new Error(
      '[agent-viewer] AGENT_VIEWER_ALERT_WEBHOOK_URL uses plain http on a non-loopback host; set ' +
        'AGENT_VIEWER_ALERT_WEBHOOK_ALLOW_HTTP=1 to allow it, or use https'
    );
  }

  const rawSecret = env.AGENT_VIEWER_ALERT_WEBHOOK_SECRET;
  const secret = typeof rawSecret === 'string' && rawSecret.trim() !== '' ? rawSecret : null;

  const maxAttempts = parseRangedInt(
    env.AGENT_VIEWER_ALERT_WEBHOOK_MAX_ATTEMPTS,
    'AGENT_VIEWER_ALERT_WEBHOOK_MAX_ATTEMPTS',
    MIN_MAX_ATTEMPTS,
    MAX_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS
  );
  const timeoutMs = parseRangedInt(
    env.AGENT_VIEWER_ALERT_WEBHOOK_TIMEOUT_MS,
    'AGENT_VIEWER_ALERT_WEBHOOK_TIMEOUT_MS',
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS
  );

  return { url: trimmedUrl, secret, allowHttp, maxAttempts, timeoutMs };
}

/** Hex HMAC-SHA256 of `${timestamp}.${rawBody}`, the same construction `server/index.ts` verifies inbound with,
 * computed here with the separate outbound secret. */
export function signAlertDeliveryBody(secret: string, timestamp: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export type DeliveryOutcome =
  | { kind: 'success'; status: number }
  | { kind: 'retry'; status: number | null; error: string; retryAfterMs: number | null }
  | { kind: 'terminal'; status: number | null; error: string };

/** `Retry-After` as either delta-seconds or an HTTP date (issue #321: raises the retry floor on `429`/`503`).
 * Returns `null` for a missing or unparseable header, never a negative delay. */
function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^[0-9]+$/.test(trimmed)) return Number(trimmed) * 1000;
  const parsedDate = Date.parse(trimmed);
  if (Number.isNaN(parsedDate)) return null;
  return Math.max(0, parsedDate - now);
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

async function readTruncatedBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return truncate(text, LAST_ERROR_MAX_LENGTH);
  } catch {
    return '';
  }
}

export interface DeliveryAttemptInput {
  alertId: string;
  /** The exact bytes stored at alert-creation time; identical on every attempt. */
  body: string;
  /** 1-based, incrementing on every attempt, never reset by a retry. */
  attempt: number;
}

export interface DeliveryAttemptDeps {
  fetchImpl: typeof fetch;
  now: () => number;
}

/**
 * Performs exactly one HTTP attempt and classifies the result (issue #321's retry table): any `2xx` is
 * `'success'`; a network error, a timeout, `408`, `429` or any `5xx` is `'retry'`; any other `4xx` and any
 * redirect (`redirect: 'manual'`, so a `3xx` is observed rather than followed) is `'terminal'`. Never throws: a
 * network failure or an abort is itself a classified `'retry'` outcome.
 */
export async function attemptAlertDelivery(
  config: AlertWebhookConfig,
  input: DeliveryAttemptInput,
  deps: DeliveryAttemptDeps
): Promise<DeliveryOutcome> {
  const timestamp = String(deps.now());
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-agent-viewer-event': 'budget.alert',
    'x-agent-viewer-delivery': input.alertId,
    'x-agent-viewer-attempt': String(input.attempt),
    'x-agent-viewer-timestamp': timestamp,
  };
  if (config.secret) {
    headers['x-agent-viewer-signature'] = signAlertDeliveryBody(config.secret, timestamp, input.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await deps.fetchImpl(config.url, {
      method: 'POST',
      headers,
      body: input.body,
      redirect: 'manual',
      signal: controller.signal,
    });

    const isRedirect = response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
    if (isRedirect) {
      return { kind: 'terminal', status: response.status || null, error: await readTruncatedBody(response) };
    }
    if (response.status >= 200 && response.status < 300) {
      return { kind: 'success', status: response.status };
    }
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), deps.now());
    const errorText = await readTruncatedBody(response);
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return { kind: 'retry', status: response.status, error: errorText, retryAfterMs };
    }
    return { kind: 'terminal', status: response.status, error: errorText };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'retry', status: null, error: truncate(message, LAST_ERROR_MAX_LENGTH), retryAfterMs: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `base = min(5s * 2^(attempt-1), 1h)`, delay uniform in `[base/2, base]` (an injectable `random` in `[0, 1)`,
 * defaulting to `Math.random`). A `Retry-After` value raises the floor (never lowers it) and, if it exceeds the
 * computed ceiling, raises the ceiling to match, so the delay becomes exactly that floor; both the floor and the
 * final delay stay capped at one hour.
 */
export function computeBackoffMs(attempt: number, retryAfterMs: number | null, random: () => number = Math.random): number {
  const base = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  let floor = base / 2;
  let ceiling = base;
  if (retryAfterMs !== null) {
    const cappedRetryAfter = Math.min(retryAfterMs, MAX_BACKOFF_MS);
    floor = Math.max(floor, cappedRetryAfter);
    ceiling = Math.max(ceiling, floor);
  }
  const span = ceiling - floor;
  const delay = floor + random() * span;
  return Math.min(Math.round(delay), MAX_BACKOFF_MS);
}

export interface AlertDeliveryRecordLike {
  alertId: string;
  body: string;
  attempts: number;
}

export interface AlertDeliveryAttemptPatch {
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  nextAttemptAt: number | null;
  lastStatus: number | null;
  lastError: string | null;
  deliveredAt: number | null;
}

export interface AlertDeliveryWorkerStore {
  /** Up to `limit` `pending` rows with `nextAttemptAt <= now`, oldest due first. */
  listDueAlertDeliveries(now: number, limit: number): Promise<AlertDeliveryRecordLike[]>;
  recordAlertDeliveryAttempt(alertId: string, patch: AlertDeliveryAttemptPatch): Promise<void>;
}

export interface AlertDeliveryWorkerOptions {
  store: AlertDeliveryWorkerStore;
  config: AlertWebhookConfig;
  now?: () => number;
  random?: () => number;
  fetchImpl?: typeof fetch;
  /** Defaults to a `console.warn` line with only the alert id and HTTP status (issue #321: never the secret or
   * URL). */
  log?: (message: string) => void;
  pollIntervalMs?: number;
  concurrency?: number;
}

export interface AlertDeliveryWorkerHandle {
  /** Stops the poll timer and waits for every in-flight attempt to settle. Safe to call more than once. */
  stop(): Promise<void>;
  /** Runs one poll immediately (used right after a new delivery is enqueued, and by tests) instead of waiting
   * for the next timer tick. Resolves once that poll (and everything it started) has settled. */
  checkNow(): Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_CONCURRENCY = 4;

/**
 * A single persisted worker (issue #321): concurrency cap `concurrency` (default 4), at most one in-flight
 * attempt per alert (an in-process `Set` guard, since this process is the only writer of `budget_alert_deliveries`
 * rows), polling `store.listDueAlertDeliveries` on an unref'd timer so it never keeps the process alive by
 * itself. Resuming `pending` rows after a restart falls out of the store being durable (SQLite): the first poll
 * after `startAlertDeliveryWorker` is called simply finds whatever is already due. A delivery exhausting
 * `config.maxAttempts` becomes `failed` (dead letter, never retried again) with a `warn` log line naming only the
 * alert id and the last HTTP status.
 */
export function startAlertDeliveryWorker(opts: AlertDeliveryWorkerOptions): AlertDeliveryWorkerHandle {
  const { store, config } = opts;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((message: string) => console.warn(message));
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  const inFlight = new Set<string>();
  let stopped = false;

  async function processOne(record: AlertDeliveryRecordLike): Promise<void> {
    inFlight.add(record.alertId);
    try {
      const attempt = record.attempts + 1;
      const outcome = await attemptAlertDelivery(config, { alertId: record.alertId, body: record.body, attempt }, { fetchImpl, now });

      if (outcome.kind === 'success') {
        await store.recordAlertDeliveryAttempt(record.alertId, {
          status: 'delivered',
          attempts: attempt,
          nextAttemptAt: null,
          lastStatus: outcome.status,
          lastError: null,
          deliveredAt: now(),
        });
        return;
      }

      if (outcome.kind === 'terminal' || attempt >= config.maxAttempts) {
        log(`[agent-viewer] budget alert delivery failed permanently: alert=${record.alertId} status=${outcome.status ?? 'network_error'}`);
        await store.recordAlertDeliveryAttempt(record.alertId, {
          status: 'failed',
          attempts: attempt,
          nextAttemptAt: null,
          lastStatus: outcome.status,
          lastError: truncate(outcome.error, LAST_ERROR_MAX_LENGTH),
          deliveredAt: null,
        });
        return;
      }

      const delayMs = computeBackoffMs(attempt, outcome.retryAfterMs, random);
      await store.recordAlertDeliveryAttempt(record.alertId, {
        status: 'pending',
        attempts: attempt,
        nextAttemptAt: now() + delayMs,
        lastStatus: outcome.status,
        lastError: truncate(outcome.error, LAST_ERROR_MAX_LENGTH),
        deliveredAt: null,
      });
    } catch (error) {
      // A bug here must never crash the worker loop or the server, the same policy every other background job
      // in this codebase follows (`checkBudgetLive`, `startRetention`'s `runNow`).
      log(`[agent-viewer] budget alert delivery worker error for alert=${record.alertId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight.delete(record.alertId);
    }
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const slots = concurrency - inFlight.size;
    if (slots <= 0) return;
    // Over-fetches by the current in-flight count so an already-claimed row found again is simply filtered out
    // below, rather than racing a second attempt for it.
    const due = await store.listDueAlertDeliveries(now(), slots + inFlight.size);
    const runnable = due.filter((row) => !inFlight.has(row.alertId)).slice(0, slots);
    if (runnable.length === 0) return;
    await Promise.all(runnable.map((row) => processOne(row)));
  }

  let tickPromise: Promise<void> | null = null;
  async function runTick(): Promise<void> {
    const run = tick().catch((error) => {
      log(`[agent-viewer] budget alert delivery worker poll failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    tickPromise = run;
    try {
      await run;
    } finally {
      if (tickPromise === run) tickPromise = null;
    }
  }

  const timer = setInterval(() => {
    void runTick();
  }, pollIntervalMs);
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (tickPromise) await tickPromise;
    },
    async checkNow() {
      if (stopped) return;
      await runTick();
    },
  };
}
