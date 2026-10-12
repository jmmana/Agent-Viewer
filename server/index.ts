import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { z } from 'zod';
import {
  type CanonicalEvent,
  validateCanonicalEvent,
  normalizeCanonicalEvent,
  ValidationIssue,
  LlmUsagePayloadSchema,
} from '../src/integrations/canonicalContract';
import { AUDIT_EVENT_TYPES, type AuditEventType } from '../src/integrations/canonicalTypes';
import type { AgentStatus } from '../src/types/agent';
import { OTLP_LOGS_PATH, OTLP_METRICS_PATH, OTLP_TRACES_PATH } from '../src/integrations/otelConstants';
import { serverEventId } from './ids';
import { webhookEventId, webhookUsageRequestEventId } from './webhookIds';
import {
  createEventStore,
  parseRetentionBatchSize,
  type AuditActor,
  type TombstoneResult,
  type AppendResult,
  type AppendBatchResult,
  type EventSeq,
  type EventStore,
  type TelemetryAppendOutcome,
} from './store';
import { parseRetentionConfig, startRetention, usageRetentionWarning, type RetentionConfig, type RetentionJobHandle } from './retention';
import { readPackageVersion } from './version';
import { verifyChain } from './audit/verify';
import { AuditCheckpointService, auditCheckpointsSupported, parseCheckpointScheduleConfig } from './audit/checkpoints';
import { loadSigningKey } from './audit/signingKey';
import { parseUsageFilters } from './usage/filters';
import { decodeCursor, encodeCursor, filterHash } from './usage/calls';
import type { RollupQuery, UsageFilters } from './usage/types';
import { mapOtlpLogsRequest, looksLikeOtlpLogsRequest, countLogRecords } from '../src/integrations/otlp/claudeCodeLogs';
import { mapOtlpTraces, looksLikeOtlpTracesRequest, countSpans } from '../src/integrations/otlpTraces';
import { assertSafeBind, envHost, isLoopbackAddress, isLoopbackHost, isOpenModeAllowed, OpenApiRefusedError } from './network';
import { createStreamTicketStore } from './stream-tickets';
import { getPricingStore } from './pricing/store';
import { registerPricingRoutes } from './pricing/api';
import {
  createMemoryBudgetRegistry,
  createSqliteBudgetRegistry,
  registerBudgetsRoutes,
  listBudgetViews,
  evaluateBudgetLive,
  emitBudgetTransition,
  onBudgetTransition,
  startBudgetRolloverWatcher,
  type Budget,
  type BudgetRegistry,
  type BudgetHttpDeps,
  type BudgetTransition,
  type BudgetTransitionTrigger,
  type BudgetRolloverWatcherHandle,
} from './budgets';
import { buildBudgetAlert, registerBudgetAlertsRoutes, type BudgetAlertsHttpDeps } from './budgetAlerts';
import {
  type ApiKeyStore,
  type ApiKeyRecord,
  createSqliteApiKeyStore,
  createUnsupportedApiKeyStore,
  ApiKeyValidationError,
  ApiKeyNameTakenError,
  ApiKeyRevokedError,
  LastAdminError,
  API_KEY_TOKEN_PATTERN,
  verifyKeySecret,
} from './apiKeys';
import {
  type Principal,
  ENV_TOKEN_PRINCIPAL,
  OPEN_MODE_PRINCIPAL,
  STREAM_TICKET_PRINCIPAL,
  makePrincipal,
} from './auth/scopes';
import { describePrincipal, enforceRoutePolicy, principalOf, requireScope } from './auth/routePolicy';
import { parseAlertWebhookConfig, startAlertDeliveryWorker, type AlertWebhookConfig, type AlertDeliveryWorkerHandle } from './budgetAlertDelivery';
import {
  parseRecomputeRequest,
  PricingVersionNotFoundError,
  RecomputeInProgressError,
  RecomputeTooBroadError,
} from './pricing/recompute';
import { mapOtlpMetricsRequest, looksLikeOtlpMetricsRequest, countMetricDataPoints } from './otlp/metrics';
import {
  renderExposition,
  buildInProcessFamilies,
  METRICS_CONTENT_TYPE,
  IngestionMetrics,
  UNMATCHED_ROUTE,
  normalizeRequestPath,
  rejectionEndpoint,
  type RejectionReason,
} from './metrics';
import { buildLedgerGaugeFamilies, DEFAULT_METRICS_MAX_MODELS } from './metrics/ledgerFamilies';
import { LedgerFamiliesCache } from './metrics/ledgerFamiliesCache';
import {
  decodeExportLogsServiceRequest,
  decodeExportMetricsServiceRequest,
  decodeExportTraceServiceRequest,
  encodeExportLogsServiceResponse,
  encodeExportMetricsServiceResponse,
  encodeExportTraceServiceResponse,
  encodeStatus,
} from './otlp/otlpProtobuf';
import { parseRollupQuery, UsageFilterError } from './usage/rollup';
import {
  buildExportFilename,
  CSV_HEADER,
  EXPORT_SCHEMA,
  ExportQueryError,
  formatCsvRow,
  formatJsonlRow,
  parseExportQuery,
  parseExportTotalsQuery,
  shapeExportTotals,
  toExportCallRecord,
} from './usage/export';

/**
 * Set by the `agent-viewer` CLI before it imports this module. The CLI configures the server through its own
 * flags, so it neither reads a `.env` file from the user's directory nor lets this module listen on its own.
 */
const embedded = process.env.AGENT_VIEWER_EMBEDDED === '1';
const isDirectRun =
  !embedded &&
  process.argv[1] &&
  (process.argv[1].endsWith('server/index.ts') ||
    process.argv[1].endsWith('server/index.js') ||
    process.argv[1].endsWith('server') ||
    process.env.npm_lifecycle_event === 'server');

// dotenv is a development dependency: the published CLI runs embedded and never loads it.
if (!embedded) {
  const dotenv = await import('dotenv');
  dotenv.config({ quiet: true });
}

const app = express();
// Express 5 defaults to the "simple" query parser. Keep the "extended" (qs) parser of Express 4 so query
// strings such as `?type[a]=b` keep parsing the same way.
app.set('query parser', 'extended');

// -------------------------------------------------------------
// In-process ingestion counters (issue #365). Mounted first, before every body parser, rate limiter and auth
// check, so a request rejected anywhere (including a malformed or oversized JSON body) is still observed. Each
// rejection site records its reason with `reject()`/`markRejection()`; this middleware reads it back once the
// response finishes. Instrumentation must never break a request: every step is wrapped in its own try/catch.
// -------------------------------------------------------------
const ingestionMetrics = new IngestionMetrics();

/** Request paths whose duration is not observed: `/metrics` itself, and the SSE stream (its "duration" is the
 * life of the connection). */
const DURATION_EXCLUDED_PATHS = new Set(['/metrics', '/api/v1/events/stream']);

/** Records why `res` is being rejected, for `agent_viewer_events_rejected_total`. */
function markRejection(res: express.Response, reason: RejectionReason): void {
  res.locals.avRejection = reason;
}

/** Sends a JSON rejection and records its reason (issue #365). */
function reject(res: express.Response, status: number, body: unknown, reason: RejectionReason): void {
  markRejection(res, reason);
  res.status(status).json(body);
}

/** Counts each result of a `store.append`/`appendBatch` call: accepted by event type, duplicates by kind. */
function recordAppendResults(results: readonly AppendResult[], events: readonly CanonicalEvent[]): void {
  try {
    results.forEach((result, index) => {
      if (result.outcome === 'accepted') ingestionMetrics.recordAccepted(events[index]?.type ?? 'unknown');
      else if (result.outcome === 'duplicate') ingestionMetrics.recordDuplicate('identical');
      else if (result.outcome === 'conflict') ingestionMetrics.recordDuplicate('conflicting');
    });
  } catch {
    // Instrumentation never breaks ingestion.
  }
}

app.use((req, res, next) => {
  try {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      try {
        const reason = res.locals.avRejection as RejectionReason | undefined;
        if (reason) ingestionMetrics.recordRejected(rejectionEndpoint(req.originalUrl), reason);
      } catch {
        // Ignored on purpose, see above.
      }
      try {
        if (DURATION_EXCLUDED_PATHS.has(normalizeRequestPath(req.originalUrl))) return;
        const routePath: unknown = req.route?.path;
        const route = typeof routePath === 'string' ? `${req.baseUrl ?? ''}${routePath}` : UNMATCHED_ROUTE;
        const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
        ingestionMetrics.observeRequest(req.method, route, res.statusCode, seconds);
      } catch {
        // Ignored on purpose, see above.
      }
    });
  } catch {
    // Ignored on purpose, see above.
  }
  next();
});

const port = Number(process.env.PORT ?? 8787);
const maxBatchSize = Number(process.env.AGENT_VIEWER_MAX_BATCH_SIZE ?? 100);
const rateLimitMax = Number(process.env.AGENT_VIEWER_RATE_LIMIT ?? 1000);
/** Above this many matching rows, `GET /api/v1/usage/export` answers `422 export_too_large` before streaming
 * anything (issue #69): an export is never silently truncated. Read per request, like `getApiToken()`, so it can
 * change without a restart (and so tests can flip it with `process.env` directly). */
function getExportMaxRows(): number {
  return Number(process.env.AGENT_VIEWER_EXPORT_MAX_ROWS ?? 1_000_000);
}
/** Concurrent `GET /api/v1/usage/export` requests this process serves at once (issue #69). The totals sidecar
 * never counts against this cap (it is a fast, single read, not a long-running stream). */
function getExportConcurrencyMax(): number {
  return Number(process.env.AGENT_VIEWER_EXPORT_CONCURRENCY ?? 2);
}
const rateLimitWindowMs = 60 * 1000;
/** Upper bound of tracked client IPs before expired windows are swept. */
const rateLimitMaxTrackedClients = 10_000;
/** Accepted clock skew for signed webhooks, and how long a signature stays in the replay cache. */
const webhookToleranceMs = 300_000;
/** Upper bound of remembered webhook signatures. */
const webhookReplayCacheMax = 10_000;

/**
 * Maximum number of missed events a reconnect replays in full (issue #54). `0` means a reconnect that missed
 * anything always resyncs instead of replaying. Read and validated once at module load, like `parseMaxEvents`.
 */
function parseSseReplayMax(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 10000;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`AGENT_VIEWER_SSE_REPLAY_MAX must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return Number(trimmed);
}

/** Events fetched from the store per `listBetween` page while replaying a reconnect (issue #54). */
const sseReplayPageSize = 500;
/** Live frames buffered per connection while its replay is in flight; past this, the connection resyncs instead. */
const sseReplayBufferMax = 5000;
/** How long a stalled connection may take to drain before it is disconnected mid-replay. */
const sseDrainTimeoutMs = 30_000;

/** Agent statuses the office understands. Kept exhaustive against `AgentStatus` at compile time. */
const AGENT_STATUSES = [
  'OFFLINE', 'IDLE', 'AVAILABLE', 'THINKING', 'READING', 'RESEARCHING', 'CODING', 'WRITING', 'TESTING',
  'USING_TOOL', 'WAITING', 'WAITING_APPROVAL', 'BLOCKED', 'DELEGATING', 'PHONE_CALL', 'WALKING',
  'IN_MEETING', 'COFFEE_BREAK', 'CHATTING', 'REVIEWING', 'DELIVERING', 'DONE', 'ERROR',
] as const satisfies readonly AgentStatus[];
type MissingAgentStatus = Exclude<AgentStatus, (typeof AGENT_STATUSES)[number]>;
const agentStatusesAreExhaustive: [MissingAgentStatus] extends [never] ? true : never = true;
void agentStatusesAreExhaustive;
const AGENT_STATUS_SET: ReadonlySet<string> = new Set(AGENT_STATUSES);
const PATCH_USAGE_FIELDS: ReadonlySet<string> = new Set([
  'tokensInput', 'tokensOutput', 'inputTokens', 'outputTokens', 'cachedTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'reasoningTokens', 'totalTokens', 'cost', 'currency', 'costSource', 'latencyMs', 'usage',
]);
const PATCH_READ_ONLY_FIELDS: ReadonlySet<string> = new Set(['lastSeenAt']);
const PATCH_PROFILE_FIELDS: ReadonlySet<string> = new Set(['name', 'roleTitle', 'provider', 'model']);
const PATCH_STATUS_FIELDS: ReadonlySet<string> = new Set(['status', 'statusText', 'workspace']);
const PATCH_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  ...PATCH_PROFILE_FIELDS,
  ...PATCH_STATUS_FIELDS,
]);
const PATCH_USAGE_MESSAGE =
  'Usage and cost cannot be edited through PATCH. Send an llm.usage event to POST /api/v1/events (or use the SDK usage() helper) so the spend is recorded and auditable.';

let store: EventStore;
let sseReplayMax: number;
let retentionConfig: RetentionConfig;
let retentionBatchSize: number;
let alertWebhookConfig: AlertWebhookConfig | null;
try {
  store = createEventStore();
  sseReplayMax = parseSseReplayMax(process.env.AGENT_VIEWER_SSE_REPLAY_MAX);
  // Issue #70: validated once at startup, like every other env-derived config here. A bad value must never be
  // silently ignored or guessed at, since it governs permanent deletion.
  retentionConfig = parseRetentionConfig(process.env);
  // Issue #109: rows per tombstone transaction (and per chained audit event). Same rule as above.
  retentionBatchSize = parseRetentionBatchSize(process.env.AGENT_VIEWER_RETENTION_BATCH_SIZE);
  // Issue #86 (sub-issue #321): same rule, for the outbound budget alert webhook. `null` means the feature is off
  // (no `AGENT_VIEWER_ALERT_WEBHOOK_URL`); an invalid URL, a refused plain `http://` or an out-of-range numeric
  // value stops the server here, with a message that never echoes the URL.
  alertWebhookConfig = parseAlertWebhookConfig(process.env);
} catch (error) {
  if (!isDirectRun) throw error;
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/[\r\n]+/g, ' ').trim());
  if (process.env.DEBUG && error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
}
// Starts the SQLite startup rebuild without blocking the server from listening (issue #52). Memory storage
// resolves at once. `init()` is safe to call more than once: `SQLiteEventStore` already started it from its own
// constructor, so this just lets callers await the same promise if they need to.
void store.init();

// Budgets (issue #85, sub-issue #304): the registry picks SQLite when the running store exposes a raw database
// handle (migrations, including the `budgets` migration version 14, already ran synchronously in
// `SQLiteEventStore`'s own constructor, before `createEventStore()` above ever returns), and falls back to the
// in-memory registry otherwise, same storage-mode split as every other feature here.
const budgetRegistry: BudgetRegistry = (() => {
  const handle = store.getDatabaseHandle?.();
  return handle ? createSqliteBudgetRegistry(handle) : createMemoryBudgetRegistry();
})();

// Named API keys (issue #107): same storage-mode split as budgets. `createUnsupportedApiKeyStore()` throws
// `KeysUnsupportedError` from every method except `touchLastUsed` (a silent no-op), which the key routes and
// the auth middleware both map to `501 keys_require_sqlite`.
const apiKeyStore: ApiKeyStore = (() => {
  const handle = store.getDatabaseHandle?.();
  return handle ? createSqliteApiKeyStore(handle) : createUnsupportedApiKeyStore();
})();
const apiKeysSupported = store.getDatabaseHandle?.() !== undefined;

// Signed audit checkpoints (issue #387): SQLite only, and only once migration 22 has run. Loading the signing key
// (env, key file, or a generated 0600 default next to the database) and the schedule both validate at startup;
// a bad key or value stops a direct run with a message that never contains key material, like every other
// env-derived config above. `start()` registers the key (retiring a different, previously active one and signing
// a `key_change` checkpoint) and starts the unref'd interval timer.
let auditCheckpoints: AuditCheckpointService | null = null;
try {
  const handle = store.getDatabaseHandle?.();
  const dbPath = store.getDatabasePath?.();
  if (handle && dbPath !== undefined && auditCheckpointsSupported(handle)) {
    auditCheckpoints = new AuditCheckpointService({
      db: handle,
      key: loadSigningKey({ env: process.env, dbPath }),
      schedule: parseCheckpointScheduleConfig(process.env),
    });
    auditCheckpoints.start();
  }
} catch (error) {
  if (!isDirectRun) throw error;
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/[\r\n]+/g, ' ').trim());
  process.exit(1);
}

const budgetDeps: BudgetHttpDeps = {
  getRegistry: () => budgetRegistry,
  currentAuthMode: () => currentAuthMode(),
  rollup: (query) => store.rollup(query),
  iterateLedgerRows: (filters, asOfSeq) => store.iterateExportRows(filters, asOfSeq),
};

// Budget alerts read API (issue #86, sub-issue #322): a narrow slice of `store` (memory or SQLite, whichever
// `createEventStore()` picked above), the same dependency-injection shape `budgetDeps` already uses.
const budgetAlertsDeps: BudgetAlertsHttpDeps = {
  listBudgetAlerts: (filter) => store.listBudgetAlerts(filter),
  getBudgetAlert: (alertId) => store.getBudgetAlert(alertId),
  getBudgetAlertDeliveries: (alertIds) => store.getBudgetAlertDeliveries(alertIds),
  // Derived from the same parsed `alertWebhookConfig` #321's own startup validation already produced (above),
  // never a second independent read of the raw env vars: `configured` is "a destination URL passed validation",
  // `signed` additionally requires a secret (an unsigned webhook is still "configured", just never "signed").
  webhookSummary: () => ({ configured: alertWebhookConfig !== null, signed: alertWebhookConfig !== null && alertWebhookConfig.secret !== null }),
};

// Started further below, once `broadcastBudgetTransition` and `onEventAccepted` exist (issue #85 section 6,
// sub-issue #305): forward-declared here, next to `budgetRegistry`/`budgetDeps`, so `shutdown()` (right below) can
// stop it without the whole live-transitions wiring having to live above `shutdown()`'s own definition.
let budgetRolloverWatcher: BudgetRolloverWatcherHandle | null = null;

if (retentionConfig.ledgerDays !== null) {
  console.log(usageRetentionWarning(retentionConfig.ledgerDays));
}
// Wired unconditionally, right after the store (issue #70): with both windows unset this creates no timer at
// all, so importing this module in a test (which never configures either variable) is unaffected. `shutdown()`
// below stops it before closing the store.
const retentionJob: RetentionJobHandle = startRetention({ store, config: retentionConfig });

// Issue #86 (sub-issue #321): the outbound alert webhook worker only exists when a destination is configured.
// With `alertWebhookConfig === null` every alert's delivery row is written `skipped` (`onBudgetTransition` below)
// and there is nothing for a worker to ever pick up, so none is started at all. Logged without the secret or the
// URL, like every other config line in this file.
if (alertWebhookConfig) {
  console.log(
    `[agent-viewer] budget alert webhook is enabled${alertWebhookConfig.secret ? '' : ' (unsigned: AGENT_VIEWER_ALERT_WEBHOOK_SECRET is not set)'}`
  );
}
const alertDeliveryWorker: AlertDeliveryWorkerHandle | null = alertWebhookConfig
  ? startAlertDeliveryWorker({ store, config: alertWebhookConfig })
  : null;

/**
 * Stops the retention job (waiting for a run already in progress), the alert delivery worker (waiting for every
 * in-flight attempt) and closes the store. Called by the direct-run `SIGTERM`/`SIGINT` handlers below, and by the
 * embedded CLI's `close()` (`cli/start.ts`) after it closes the HTTP server (issue #70). Safe to call more than
 * once: every step it calls already is.
 */
export async function shutdown(): Promise<void> {
  budgetRolloverWatcher?.stop();
  await retentionJob.stop();
  await alertDeliveryWorker?.stop();
  // Issue #387: a final `shutdown` checkpoint (only if the head advanced), before the store closes its handle.
  auditCheckpoints?.shutdown();
  await store.close();
}

/** Blocks a route that reads or writes derived state until the startup rebuild has finished. */
// Generic over the route's own params/body/query types, so mixing this in as an extra handler before a typed
// route (for example one with a `:agentId` param) never widens that route's own handler to `ParamsDictionary`.
function requireReady<P = Record<string, string>, ResBody = any, ReqBody = any, ReqQuery = any>(
  _req: express.Request<P, ResBody, ReqBody, ReqQuery>,
  res: express.Response<ResBody>,
  next: express.NextFunction
): void {
  const readiness = store.readiness();
  if (readiness.ready) {
    next();
    return;
  }
  res.setHeader('Retry-After', '1');
  res.status(503).json({
    error: readiness.rebuild.state === 'failed' ? 'store_rebuild_failed' : 'store_rebuilding',
    message: 'Server state is being rebuilt from storage',
    rebuild: readiness.rebuild,
  } as ResBody);
}

const clients = new Set<express.Response>();
/**
 * Live frames queued for a connection while its reconnect replay is in flight, keyed by the response (issue
 * #54). A connection is present here only between being added to `clients` and going live (or resyncing).
 */
const replayBuffers = new Map<express.Response, { buffer: Array<{ seq: EventSeq | null; frame: string }>; overflowed: boolean }>();
/** Stream counters exposed by `/health` (issue #54). Per process, reset on restart. */
const sseCounters = { replaysSinceStart: 0, eventsReplayedSinceStart: 0, resyncsSinceStart: 0 };

// Rate limiter storage
const rateLimits = new Map<string, { count: number; resetAt: number }>();
/** Issue #103: `/metrics` gets its own bucket, same limiter code and `AGENT_VIEWER_RATE_LIMIT`, so a flood of
 * failed scrape-token guesses against one IP never spends that IP's `/api/v1` ingestion budget and vice versa. */
const metricsRateLimits = new Map<string, { count: number; resetAt: number }>();

/** Shared rate-limiter logic, parameterized over which bucket map it reads and writes (issue #103). */
function makeRateLimiter(limits: Map<string, { count: number; resetAt: number }>) {
  return function rateLimiterMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = limits.get(ip);
    if (!entry && limits.size >= rateLimitMaxTrackedClients) {
      for (const [key, value] of limits) {
        if (value.resetAt <= now) limits.delete(key);
      }
    }
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + rateLimitWindowMs };
      limits.set(ip, entry);
    }
    entry.count++;
    if (entry.count > rateLimitMax) {
      // Issue #59: every 429, on every route this limiter guards, carries Retry-After so OTLP exporters (and any
      // other well-behaved client) back off instead of retrying immediately. At least 1 second, rounded up.
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      reject(res, 429, { error: 'rate_limit_exceeded', message: `Too many requests. Limit: ${rateLimitMax}/min` }, 'rate_limited');
      return;
    }
    next();
  };
}

const rateLimiter = makeRateLimiter(rateLimits);
/** Issue #103: separate bucket, mounted on `/metrics` only (see below). */
const metricsRateLimiter = makeRateLimiter(metricsRateLimits);

/** Builds a short, fixed-shape body for a `/v1/logs` error response. Never includes request content. */
function otlpErrorBody(code: number, message: string): { code: number; message: string } {
  return { code, message };
}

// -------------------------------------------------------------
// OTLP/HTTP receivers: POST /v1/logs (issue #59) and POST /v1/metrics (issue #73)
//
// Claude Code's native OpenTelemetry telemetry (not the hook above, which never reads tokens or cost) is the
// only documented source of per-request token and cost figures. `/v1/logs` turns its `claude_code.api_request`
// and `claude_code.api_error` events into `llm.usage`/`llm.failed` on the same main agent the hook already
// draws. `/v1/metrics` stores the same consumption's counters (`claude_code.token.usage`,
// `claude_code.cost.usage`) as a second, independent measurement, kept in its own tables and never folded into
// the ledger, the snapshot, SSE or any rollup: it exists only as a cross-check against the logs path. See
// `docs/otlp.md` for the full reference.
//
// Both routes are mounted before the global `express.json()` below, each with its own middleware chain, so
// none of the global body-parsing, auth or rate-limit decisions for /api/v1 ever apply here and vice versa:
// rate limit, then token check, then content-type/encoding check, then this route's own size-limited body
// parser (JSON or protobuf, by content type), then a shape/count check, then the handler. An unauthenticated
// request never reaches the body parser; a wrong token with a malformed body still answers 401, not 400.
//
// `http/protobuf` (issue #73, section 2): both routes accept `application/x-protobuf` using the zero-dependency
// wire decoder in `server/otlp/protobufWire.ts` and `server/otlp/otlpProtobuf.ts`, so the install stays at
// `express` and `zod`. A protobuf request gets a protobuf response (`Content-Type: application/x-protobuf`);
// gRPC is not supported, only `http/json` and `http/protobuf`.
// -------------------------------------------------------------
function isValidByteSizeString(value: string): boolean {
  return /^[0-9]+(\.[0-9]+)?\s*(b|kb|mb|gb|tb)?$/i.test(value.trim());
}

const otlpMaxBodyLabel = (() => {
  const raw = process.env.AGENT_VIEWER_OTLP_MAX_BODY;
  return raw && isValidByteSizeString(raw) ? raw.trim() : '5mb';
})();

const otlpMaxRecords = (() => {
  const raw = Number(process.env.AGENT_VIEWER_OTLP_MAX_RECORDS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 5000;
})();

const OTLP_UNSUPPORTED_MEDIA_MESSAGE =
  `Agent Viewer accepts OTLP http/json or http/protobuf on ${OTLP_LOGS_PATH}, uncompressed or gzip. Set OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json or http/protobuf.`;
const OTLP_MALFORMED_BODY_MESSAGE = 'Expected an OTLP ExportLogsServiceRequest with resourceLogs';
const OTLP_METRICS_UNSUPPORTED_MEDIA_MESSAGE =
  `Agent Viewer accepts OTLP http/json or http/protobuf on ${OTLP_METRICS_PATH}, uncompressed or gzip. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json or http/protobuf.`;
const OTLP_METRICS_MALFORMED_BODY_MESSAGE = 'Expected an OTLP ExportMetricsServiceRequest with resourceMetrics';

/** Accepted media types on both OTLP routes, content-type parameters (for example `; charset=utf-8`) ignored. */
const OTLP_ACCEPTED_CONTENT_TYPES = new Set(['application/json', 'application/x-protobuf']);

/**
 * Content-Type guard shared by `/v1/logs` and `/v1/metrics` (issue #73, "one code path"): body-parser's own
 * `type` option silently skips parsing for a non-matching type instead of erroring, so a wrong (or missing but
 * non-empty-body) type needs its own check before either parser runs.
 */
function otlpContentTypeGuard(onReject: () => void, unsupportedMediaMessage: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const contentType = (req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (contentType !== '' && !OTLP_ACCEPTED_CONTENT_TYPES.has(contentType)) {
      onReject();
      reject(res, 415, otlpErrorBody(3, unsupportedMediaMessage), 'unrecognized_payload');
      return;
    }
    next();
  };
}

/**
 * Route-specific body-parser error handler, shared by `/v1/logs` and `/v1/metrics`: body-parser (via raw-body)
 * tags its errors with `err.type`, which this maps to the OTLP-style bodies from issue #59/#73's status-code
 * table, so the global, non-OTLP error handler further down in this file never answers on either route.
 */
function otlpBodyErrorHandler(onReject: () => void, limitMessage: string, unsupportedMediaMessage: string, malformedMessage: string) {
  return (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!err) {
      next();
      return;
    }
    const type = typeof err?.type === 'string' ? err.type : undefined;
    const status = typeof err?.status === 'number' ? err.status : typeof err?.statusCode === 'number' ? err.statusCode : undefined;

    onReject();
    if (type === 'entity.too.large' || status === 413) {
      reject(res, 413, otlpErrorBody(3, limitMessage), 'payload_too_large');
      return;
    }
    if (type === 'encoding.unsupported' || type === 'charset.unsupported' || status === 415) {
      reject(res, 415, otlpErrorBody(3, unsupportedMediaMessage), 'unrecognized_payload');
      return;
    }
    // entity.parse.failed (malformed JSON), request.aborted, request.size.invalid, a corrupt gzip stream, or
    // anything else either route's parser can throw: all answered the same way as a malformed body (400).
    reject(res, 400, otlpErrorBody(3, malformedMessage), 'malformed_json');
  };
}

/** Per-process counters behind `GET /api/v1/otlp/stats`. Documented as reset on restart. */
const otlpStats = {
  since: Date.now(),
  requestsAccepted: 0,
  requestsRejected: 0,
  logRecordsReceived: 0,
  logRecordsMapped: 0,
  logRecordsDuplicates: 0,
  logRecordsIgnored: 0,
  logRecordsUnknown: 0,
  logRecordsUnattributed: 0,
  logRecordsInvalid: 0,
  mappedByType: { 'llm.usage': 0, 'llm.failed': 0 } as Record<'llm.usage' | 'llm.failed', number>,
  unknownEventNames: new Map<string, number>(),
};

/**
 * Issue #107: who a request authenticated as. `id` is the value recorded as `events.submitter_id` (issue #105
 * reused, not a second column): `'key_...'` for a named key, `'bootstrap'` for the single `AGENT_VIEWER_API_TOKEN`
 * (the pre-#107 "shared token"), `'webhook'` for an HMAC-verified webhook with no key, `'anonymous'` when the
 * API is open and no key matched. Never derived from token material itself.
 */
export type Submitter =
  | { kind: 'key'; id: string; name: string }
  | { kind: 'bootstrap'; id: 'bootstrap' }
  | { kind: 'webhook'; id: 'webhook' }
  | { kind: 'anonymous'; id: 'anonymous' };

/** `principal` (issue #108) is what the request may do; `submitter` stays the identity recorded on events. */
type AuthResolution =
  | { ok: true; submitter: Submitter; principal: Principal }
  | { ok: false; reason: 'unauthorized' | 'key_revoked' | 'key_expired' };

/**
 * The Bearer-token decision `/api/v1` and `/v1/logs` both use, factored out so the two stay identical (issue
 * #59) and extended by issue #107 to resolve a full identity, not just a yes/no. Since issue #71 this is
 * Bearer-only: a `token` or `api_key` query parameter never authenticates anything, including a named key (that
 * case is rejected even earlier, by `rejectQueryToken`, with its own `query_token_not_supported` response, and a
 * key-shaped value reaching here through some other channel is still never accepted outside the header).
 *
 * Resolution order for the presented Bearer value: (1) if it is shaped like `avk_<id>.<secret>`, look up the id
 * and compare the secret (constant-time, always running one comparison even for an unknown id, see
 * `verifyKeySecret`); a match on a revoked or expired key returns that specific reason instead of falling
 * through, so a legitimate holder can diagnose it, while an unknown id or a wrong secret falls through to (2);
 * (2) compare the raw presented value against the configured bootstrap token (`AGENT_VIEWER_API_TOKEN`), so a
 * bootstrap token that happens to be `avk_`-shaped still authenticates; (3) with no token configured at all
 * (open API) and no key matched, `anonymous`. Reads `getApiToken` and `safeEqual`, both defined later in this
 * module as hoisted `function` declarations.
 */
function resolveAuth(req: express.Request): AuthResolution {
  const expectedToken = getApiToken();
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  const presented = bearerMatch ? bearerMatch[1] : null;

  if (presented) {
    const keyMatch = API_KEY_TOKEN_PATTERN.exec(presented);
    if (keyMatch) {
      const id = `key_${keyMatch[1]}`;
      const secret = keyMatch[2];
      let found: ReturnType<ApiKeyStore['findForAuth']> = null;
      try {
        found = apiKeyStore.findForAuth(id);
      } catch {
        found = null; // KeysUnsupportedError in memory mode: named keys simply never match.
      }
      if (verifyKeySecret(secret, found ? found.secretHash : null)) {
        // The hash matched, so `found` is non-null here; narrow for TypeScript.
        if (found) {
          if (found.status === 'revoked') return { ok: false, reason: 'key_revoked' };
          if (found.status === 'expired') return { ok: false, reason: 'key_expired' };
          apiKeyStore.touchLastUsed(id);
          return {
            ok: true,
            submitter: { kind: 'key', id, name: found.name },
            principal: makePrincipal({ keyId: id, name: found.name, source: 'named', granted: found.scopes }),
          };
        }
      }
    }
    // Issue #108: the bootstrap token (also the CLI session token `agent-viewer start` exports) is always admin.
    if (expectedToken && safeEqual(presented, expectedToken)) {
      return { ok: true, submitter: { kind: 'bootstrap', id: 'bootstrap' }, principal: ENV_TOKEN_PRINCIPAL };
    }
  }

  if (!expectedToken) return { ok: true, submitter: { kind: 'anonymous', id: 'anonymous' }, principal: OPEN_MODE_PRINCIPAL };
  return { ok: false, reason: 'unauthorized' };
}

/** Back-compat boolean view of `resolveAuth`, for the one caller (`requireApiToken`) that only needs yes/no
 * before deciding how to report a `no`. */
function isRequestAuthorized(req: express.Request): boolean {
  return resolveAuth(req).ok;
}

/** The id to record as `submitter_id` (issue #105, reused by #107) for the current request. Reads the
 * `Submitter` `requireApiToken` already resolved and stored on `res.locals.submitter`; re-resolves from `req`
 * only as a defensive fallback for a call site that somehow bypassed that middleware (every real route here
 * does not). */
function submitterIdForRequest(req: express.Request, res: express.Response): string {
  const submitter = res.locals.submitter as Submitter | undefined;
  if (submitter) return submitter.id;
  const resolution = resolveAuth(req);
  return resolution.ok ? resolution.submitter.id : 'anonymous';
}

/**
 * Named token-check middleware (issue #59), parameterized so `/api/v1` keeps its own response shape and
 * webhook HMAC exemption while `/v1/logs` gets an OTLP-style 401. The authorization decision itself
 * (`isRequestAuthorized`) is identical on both routes.
 *
 * `streamTicketRoute` (issue #71) is the one exception to "Bearer only": when set (only `/api/v1` passes it,
 * with `/events/stream`), a `GET` request to exactly that path, relative to the mount, may authenticate with a
 * single-use `ticket` query parameter instead, because `EventSource` cannot send an `Authorization` header. A
 * valid Bearer header is still checked first and always wins, leaving the ticket unconsumed. Any other method,
 * any other route, or a missing/repeated/array `ticket` all fall through to `invalid_stream_ticket` once a
 * `ticket` key is present, or to the normal `onUnauthorized` otherwise.
 */
function requireApiToken(options: {
  webhookBypass?: boolean;
  streamTicketRoute?: string;
  onUnauthorized: (res: express.Response) => void;
}) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (options.webhookBypass && req.path.startsWith('/webhooks') && process.env.AGENT_VIEWER_WEBHOOK_SECRET) {
      next();
      return;
    }
    const resolution = resolveAuth(req);
    if (resolution.ok) {
      res.locals.submitter = resolution.submitter;
      res.locals.principal = resolution.principal;
      next();
      return;
    }
    if (options.streamTicketRoute && req.method === 'GET' && req.path === options.streamTicketRoute && 'ticket' in req.query) {
      const ticketValue = req.query.ticket;
      if (typeof ticketValue === 'string' && streamTicketStore.consume(ticketValue)) {
        res.locals.principal = STREAM_TICKET_PRINCIPAL;
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      reject(res, 401, { error: 'invalid_stream_ticket' }, 'unauthorized');
      return;
    }
    markRejection(res, 'unauthorized');
    // Issue #107: a revoked or expired *known* key says so, so a legitimate holder can diagnose it; every other
    // failure (unknown id, wrong secret, malformed value, no credential at all) stays the generic, uninformative
    // `onUnauthorized` body, so a probe learns nothing.
    if (resolution.reason === 'key_revoked' || resolution.reason === 'key_expired') {
      res.status(401).json({ error: resolution.reason, message: `This API key is ${resolution.reason === 'key_revoked' ? 'revoked' : 'expired'}.` });
      return;
    }
    options.onUnauthorized(res);
  };
}

/** `sha256(getApiToken())`, hex, or `''` in open mode. Lets a stream ticket store detect a token rotation. */
function currentTokenFingerprint(): string {
  const token = getApiToken();
  return token ? crypto.createHash('sha256').update(token).digest('hex') : '';
}

const streamTicketStore = createStreamTicketStore({ tokenFingerprint: currentTokenFingerprint });

/** Issue #108: a `403 insufficient_scope` counts as an auth rejection in the request metrics, like the
 * open-mode `403`s below. */
const scopeGuardOptions = { onReject: (res: express.Response) => markRejection(res, 'unauthorized') };

/**
 * Rejects any `/api/v1` request carrying `token` or `api_key` in the query string, including the `token[]=`
 * array form some query parsers produce (issue #71). Runs right after the rate limiter, before the webhook
 * bypass and the Bearer check, in every auth mode, so a leaked `?token=` URL never authenticates even by
 * accident, even when the value is correct. Reads the raw URL rather than `req.query`, because a query parser
 * can turn a repeated or array-style key into a shape that no longer looks like `token`/`api_key` by the time
 * `req.query` is built.
 */
function rejectQueryToken(req: express.Request, res: express.Response, next: express.NextFunction): void {
  let hasForbiddenKey = false;
  try {
    for (const key of new URL(req.originalUrl, 'http://placeholder').searchParams.keys()) {
      if (key === 'token' || key === 'api_key' || key.startsWith('token[') || key.startsWith('api_key[')) {
        hasForbiddenKey = true;
        break;
      }
    }
  } catch {
    // An unparsable URL cannot carry a recognizable token key either.
  }
  if (!hasForbiddenKey) {
    next();
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  markRejection(res, 'unauthorized');
  res.status(401).json({
    error: 'query_token_not_supported',
    message: 'Send the token in an Authorization: Bearer header. EventSource clients use POST /api/v1/stream-tickets.',
  });
}

/**
 * Defense in depth for the no-token state (issue #71). `assertSafeBind` already refuses to *bind* a
 * non-loopback interface without a token, but an embedder that calls `app.listen` itself bypasses that, and so
 * does a DNS-rebinding page even on a loopback bind. This blocks the *requests* too, for as long as the server
 * actually has no token and the operator has not opted in with `AGENT_VIEWER_ALLOW_OPEN=1`. Mirrors the
 * webhook HMAC bypass so a signed webhook from another host keeps working; the signature itself is still
 * checked by the route.
 */
function openModeGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (getApiToken() || isOpenModeAllowed()) {
    next();
    return;
  }
  if (req.path.startsWith('/webhooks') && process.env.AGENT_VIEWER_WEBHOOK_SECRET) {
    next();
    return;
  }

  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.setHeader('Cache-Control', 'no-store');
    reject(res, 403, { error: 'open_api_loopback_only' }, 'unauthorized');
    return;
  }

  const hostHeader = (req.header('host') ?? '').trim();
  const hostOnly = hostHeader.startsWith('[')
    ? hostHeader.slice(1, Math.max(hostHeader.indexOf(']'), 1))
    : hostHeader.split(':')[0];
  if (!isLoopbackHost(hostOnly)) {
    res.setHeader('Cache-Control', 'no-store');
    reject(res, 403, { error: 'open_api_host_not_allowed' }, 'unauthorized');
    return;
  }

  const origin = req.header('origin');
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).hostname;
    } catch {
      originHost = '';
    }
    const explicitOrigins = (process.env.AGENT_VIEWER_CORS_ORIGIN ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value !== '' && value !== '*');
    const allowed =
      isLoopbackHost(originHost) ||
      explicitOrigins.some((value) => {
        try {
          return new URL(value).hostname === originHost;
        } catch {
          return value === origin;
        }
      });
    if (!allowed) {
      res.setHeader('Cache-Control', 'no-store');
      reject(res, 403, { error: 'open_api_origin_not_allowed' }, 'unauthorized');
      return;
    }
  }

  next();
}

app.use(OTLP_LOGS_PATH, rateLimiter);
app.use(
  OTLP_LOGS_PATH,
  requireApiToken({
    onUnauthorized: (res) => res.status(401).json(otlpErrorBody(16, 'Valid Bearer token required')),
  })
);
// Issue #108: OTLP export is ingestion. Checked before the body parser, like the token itself.
app.use(OTLP_LOGS_PATH, requireScope('ingest', scopeGuardOptions));

app.use(OTLP_LOGS_PATH, otlpContentTypeGuard(() => (otlpStats.requestsRejected += 1), OTLP_UNSUPPORTED_MEDIA_MESSAGE));

app.use(OTLP_LOGS_PATH, express.json({ type: 'application/json', limit: otlpMaxBodyLabel }));
app.use(OTLP_LOGS_PATH, express.raw({ type: 'application/x-protobuf', limit: otlpMaxBodyLabel }));

app.use(
  OTLP_LOGS_PATH,
  otlpBodyErrorHandler(
    () => (otlpStats.requestsRejected += 1),
    `OTLP request exceeds ${otlpMaxBodyLabel} or ${otlpMaxRecords} log records`,
    OTLP_UNSUPPORTED_MEDIA_MESSAGE,
    OTLP_MALFORMED_BODY_MESSAGE
  )
);

app.post(OTLP_LOGS_PATH, async (req, res) => {
  // `express.raw` leaves a protobuf body as a `Buffer`; `express.json` leaves a JSON body as a plain object.
  // Exactly one of the two parsers above ever matches a given request (the content-type guard already rejected
  // anything else), so this is enough to tell which wire format arrived (issue #73, section 2: "one code path"
  // downstream of this point, `looksLikeOtlpLogsRequest` onward never knows the difference).
  const isProtobufRequest = Buffer.isBuffer(req.body);
  const respondStatus = (status: 400, message: string) => {
    otlpStats.requestsRejected += 1;
    markRejection(res, 'unrecognized_payload');
    if (isProtobufRequest) {
      res.status(status).type('application/x-protobuf').send(Buffer.from(encodeStatus(3, message)));
    } else {
      res.status(status).json(otlpErrorBody(3, message));
    }
  };

  let body: unknown;
  if (isProtobufRequest) {
    try {
      body = decodeExportLogsServiceRequest(req.body as Buffer);
    } catch (error) {
      respondStatus(400, OTLP_MALFORMED_BODY_MESSAGE);
      return;
    }
  } else {
    body = req.body ?? {};
  }

  if (!looksLikeOtlpLogsRequest(body)) {
    respondStatus(400, OTLP_MALFORMED_BODY_MESSAGE);
    return;
  }

  if (countLogRecords(body) > otlpMaxRecords) {
    otlpStats.requestsRejected += 1;
    markRejection(res, 'payload_too_large');
    const message = `OTLP request exceeds ${otlpMaxBodyLabel} or ${otlpMaxRecords} log records`;
    if (isProtobufRequest) res.status(413).type('application/x-protobuf').send(Buffer.from(encodeStatus(3, message)));
    else res.status(413).json(otlpErrorBody(3, message));
    return;
  }

  const mapped = mapOtlpLogsRequest(body, {
    onUnknownEventName: (name) => {
      if (process.env.AGENT_VIEWER_DEBUG) {
        console.warn(`[agent-viewer otlp] unrecognized Claude Code event name: ${name}`);
      }
    },
  });

  let appendResult: AppendBatchResult;
  const otlpSubmitterId = submitterIdForRequest(req, res);
  try {
    appendResult = await store.appendBatch(mapped.events, { channel: 'otlp', submitterId: otlpSubmitterId });
    recordAppendResults(appendResult.results, mapped.events);
  } catch (error) {
    otlpStats.requestsRejected += 1;
    if (isProtobufRequest) res.status(503).type('application/x-protobuf').send(Buffer.from(encodeStatus(14, 'Storage unavailable, retry')));
    else res.status(503).json(otlpErrorBody(14, 'Storage unavailable, retry'));
    return;
  }

  appendResult.acceptedEvents.forEach((event, index) => broadcastEvent(event, appendResult.acceptedSeqs[index] ?? null, otlpSubmitterId));

  // A conflict (same content-derived id already stored with different content) can only happen when two
  // otherwise-identical records resolved to different timestamps because neither had `event.timestamp` nor a
  // `timeUnixNano`/`observedTimeUnixNano` (see the id formula in `src/integrations/otlp/claudeCodeLogs.ts`): a vanishingly rare
  // case, folded into `invalid` here so the published counter invariant still holds.
  const acceptedByType: Record<'llm.usage' | 'llm.failed', number> = { 'llm.usage': 0, 'llm.failed': 0 };
  for (const event of appendResult.acceptedEvents) {
    if (event.type === 'llm.usage' || event.type === 'llm.failed') acceptedByType[event.type] += 1;
  }

  otlpStats.requestsAccepted += 1;
  otlpStats.logRecordsReceived += mapped.stats.received;
  otlpStats.logRecordsMapped += appendResult.accepted;
  otlpStats.logRecordsDuplicates += appendResult.duplicates;
  otlpStats.logRecordsIgnored += mapped.stats.ignored;
  otlpStats.logRecordsUnknown += mapped.stats.unknown;
  otlpStats.logRecordsUnattributed += mapped.stats.unattributed;
  otlpStats.logRecordsInvalid += mapped.stats.invalid + appendResult.conflicts;
  otlpStats.mappedByType['llm.usage'] += acceptedByType['llm.usage'];
  otlpStats.mappedByType['llm.failed'] += acceptedByType['llm.failed'];
  for (const [name, count] of mapped.unknownEventNames) {
    otlpStats.unknownEventNames.set(name, (otlpStats.unknownEventNames.get(name) ?? 0) + count);
  }

  const rejectedCount = mapped.stats.unattributed + mapped.stats.invalid;
  if (rejectedCount === 0) {
    if (isProtobufRequest) res.status(200).type('application/x-protobuf').send(Buffer.from(encodeExportLogsServiceResponse()));
    else res.status(200).json({});
    return;
  }

  const reasonCounts = new Map<string, number>();
  for (const reason of mapped.rejectionReasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  const errorMessage = Array.from(reasonCounts.entries())
    .map(([reason, count]) => `${count} ${reason}`)
    .join('; ')
    .slice(0, 2000);

  if (isProtobufRequest) {
    res
      .status(200)
      .type('application/x-protobuf')
      .send(Buffer.from(encodeExportLogsServiceResponse({ rejectedCount, errorMessage })));
  } else {
    res.status(200).json({
      partialSuccess: {
        rejectedLogRecords: String(rejectedCount),
        errorMessage,
      },
    });
  }
});

// -------------------------------------------------------------
// OTLP/HTTP metrics receiver: POST /v1/metrics (issue #73)
//
// Same middleware order as `/v1/logs` above. The handler never calls `store.appendBatch` and never broadcasts:
// a metric point is stored through `store.appendTelemetryPoints` into its own tables, and is invisible to the
// ledger, the snapshot, SSE and `--record` by design (issue #73, section 1).
// -------------------------------------------------------------

/** Per-process counters behind a future `GET /api/v1/otlp/metrics-stats` (not added by this change; see
 * `docs/otlp.md` for why the reconciliation endpoint itself is deferred). Kept here so the route's own
 * bookkeeping has one place to live, the same shape as `otlpStats` above. */
const otlpMetricsStats = {
  since: Date.now(),
  requestsAccepted: 0,
  requestsRejected: 0,
  dataPointsReceived: 0,
  dataPointsStored: 0,
  dataPointsDuplicates: 0,
  dataPointsInvalid: 0,
  dataPointsIgnoredFlag: 0,
  dataPointsWithoutSession: 0,
  metricsIgnored: 0,
};

app.use(OTLP_METRICS_PATH, rateLimiter);
app.use(
  OTLP_METRICS_PATH,
  requireApiToken({
    onUnauthorized: (res) => res.status(401).json(otlpErrorBody(16, 'Valid Bearer token required')),
  })
);
app.use(OTLP_METRICS_PATH, requireScope('ingest', scopeGuardOptions));
app.use(OTLP_METRICS_PATH, otlpContentTypeGuard(() => (otlpMetricsStats.requestsRejected += 1), OTLP_METRICS_UNSUPPORTED_MEDIA_MESSAGE));

app.use(OTLP_METRICS_PATH, express.json({ type: 'application/json', limit: otlpMaxBodyLabel }));
app.use(OTLP_METRICS_PATH, express.raw({ type: 'application/x-protobuf', limit: otlpMaxBodyLabel }));

app.use(
  OTLP_METRICS_PATH,
  otlpBodyErrorHandler(
    () => (otlpMetricsStats.requestsRejected += 1),
    `OTLP request exceeds ${otlpMaxBodyLabel} or ${otlpMaxRecords} data points`,
    OTLP_METRICS_UNSUPPORTED_MEDIA_MESSAGE,
    OTLP_METRICS_MALFORMED_BODY_MESSAGE
  )
);

app.post(OTLP_METRICS_PATH, async (req, res) => {
  const isProtobufRequest = Buffer.isBuffer(req.body);

  let body: unknown;
  if (isProtobufRequest) {
    try {
      body = decodeExportMetricsServiceRequest(req.body as Buffer);
    } catch (error) {
      otlpMetricsStats.requestsRejected += 1;
      markRejection(res, 'unrecognized_payload');
      res.status(400).type('application/x-protobuf').send(Buffer.from(encodeStatus(3, OTLP_METRICS_MALFORMED_BODY_MESSAGE)));
      return;
    }
  } else {
    body = req.body ?? {};
  }

  if (!looksLikeOtlpMetricsRequest(body)) {
    otlpMetricsStats.requestsRejected += 1;
    markRejection(res, 'unrecognized_payload');
    if (isProtobufRequest) res.status(400).type('application/x-protobuf').send(Buffer.from(encodeStatus(3, OTLP_METRICS_MALFORMED_BODY_MESSAGE)));
    else res.status(400).json(otlpErrorBody(3, OTLP_METRICS_MALFORMED_BODY_MESSAGE));
    return;
  }

  if (countMetricDataPoints(body) > otlpMaxRecords) {
    otlpMetricsStats.requestsRejected += 1;
    markRejection(res, 'payload_too_large');
    const message = `OTLP request exceeds ${otlpMaxBodyLabel} or ${otlpMaxRecords} data points`;
    if (isProtobufRequest) res.status(413).type('application/x-protobuf').send(Buffer.from(encodeStatus(3, message)));
    else res.status(413).json(otlpErrorBody(3, message));
    return;
  }

  let hmacSecret: Buffer;
  try {
    hmacSecret = await store.getTelemetryHmacSecret();
  } catch (error) {
    otlpMetricsStats.requestsRejected += 1;
    if (isProtobufRequest) res.status(503).type('application/x-protobuf').send(Buffer.from(encodeStatus(14, 'Storage unavailable, retry')));
    else res.status(503).json(otlpErrorBody(14, 'Storage unavailable, retry'));
    return;
  }

  const mapped = mapOtlpMetricsRequest(body, { wireFormat: isProtobufRequest ? 'protobuf' : 'json', hmacSecret });

  let appendResult: TelemetryAppendOutcome;
  try {
    appendResult = await store.appendTelemetryPoints(mapped.points);
  } catch (error) {
    otlpMetricsStats.requestsRejected += 1;
    if (isProtobufRequest) res.status(503).type('application/x-protobuf').send(Buffer.from(encodeStatus(14, 'Storage unavailable, retry')));
    else res.status(503).json(otlpErrorBody(14, 'Storage unavailable, retry'));
    return;
  }

  otlpMetricsStats.requestsAccepted += 1;
  otlpMetricsStats.dataPointsReceived += mapped.stats.dataPointsReceived;
  otlpMetricsStats.dataPointsStored += appendResult.accepted;
  otlpMetricsStats.dataPointsDuplicates += appendResult.duplicates;
  otlpMetricsStats.dataPointsInvalid += mapped.stats.dataPointsInvalid + appendResult.conflicts + appendResult.rejectedCapacity;
  otlpMetricsStats.dataPointsIgnoredFlag += mapped.stats.dataPointsIgnoredFlag;
  otlpMetricsStats.dataPointsWithoutSession += mapped.stats.dataPointsWithoutSession;
  otlpMetricsStats.metricsIgnored += mapped.stats.metricsIgnored;

  const rejectedCount = mapped.stats.dataPointsInvalid + appendResult.conflicts + appendResult.rejectedCapacity;
  if (rejectedCount === 0) {
    if (isProtobufRequest) res.status(200).type('application/x-protobuf').send(Buffer.from(encodeExportMetricsServiceResponse()));
    else res.status(200).json({});
    return;
  }

  const reasonCounts = new Map<string, number>();
  for (const reason of [...mapped.rejectionReasons, ...appendResult.messages]) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  const errorMessage = Array.from(reasonCounts.entries())
    .map(([reason, count]) => `${count} ${reason}`)
    .join('; ')
    .slice(0, 2000);

  if (isProtobufRequest) {
    res
      .status(200)
      .type('application/x-protobuf')
      .send(Buffer.from(encodeExportMetricsServiceResponse({ rejectedCount, errorMessage })));
  } else {
    res.status(200).json({
      partialSuccess: {
        rejectedDataPoints: String(rejectedCount),
        errorMessage,
      },
    });
  }
});

// -------------------------------------------------------------
// OTLP/HTTP GenAI traces receiver: POST /v1/traces (issue #97)
//
// Converts GenAI spans (OpenTelemetry's `gen_ai.*` semantic conventions) into `llm.usage`/`llm.failed` and
// `tool.started`/`tool.completed`/`tool.failed` canonical events, through the pure mapper in
// `src/integrations/otlpTraces.ts`. It does not store spans: only the derived events reach `store.appendBatch`,
// the same append-then-broadcast shape `/v1/logs` above uses. See `docs/otlp.md` for the full mapping table.
//
// Same middleware order, body limits and record-count env vars as `/v1/logs`/`/v1/metrics` (one shared
// `AGENT_VIEWER_OTLP_MAX_BODY`/`AGENT_VIEWER_OTLP_MAX_RECORDS` pair across all three OTLP routes, documented in
// `docs/otlp.md`), rather than the separate `AGENT_VIEWER_OTLP_MAX_BODY_BYTES`/`AGENT_VIEWER_OTLP_MAX_SPANS`
// names in the issue's original draft, which predates the shared limiter #59/#73 actually shipped.
// -------------------------------------------------------------

const OTLP_TRACES_UNSUPPORTED_MEDIA_MESSAGE =
  `Agent Viewer accepts OTLP http/json or http/protobuf on ${OTLP_TRACES_PATH}, uncompressed or gzip. Set OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json or http/protobuf.`;
const OTLP_TRACES_MALFORMED_BODY_MESSAGE = 'Expected an OTLP ExportTraceServiceRequest with resourceSpans';

/** Per-process counters behind a future stats surface, the same shape as `otlpStats`/`otlpMetricsStats` above. */
const otlpTracesStats = {
  since: Date.now(),
  requestsAccepted: 0,
  requestsRejected: 0,
  spansReceived: 0,
  spansMapped: 0,
  spansDuplicates: 0,
  spansIgnored: 0,
  spansRejected: 0,
  warnings: 0,
};

app.use(OTLP_TRACES_PATH, rateLimiter);
app.use(
  OTLP_TRACES_PATH,
  requireApiToken({
    onUnauthorized: (res) => res.status(401).json(otlpErrorBody(16, 'Valid Bearer token required')),
  })
);
app.use(OTLP_TRACES_PATH, requireScope('ingest', scopeGuardOptions));
app.use(OTLP_TRACES_PATH, otlpContentTypeGuard(() => (otlpTracesStats.requestsRejected += 1), OTLP_TRACES_UNSUPPORTED_MEDIA_MESSAGE));

app.use(OTLP_TRACES_PATH, express.json({ type: 'application/json', limit: otlpMaxBodyLabel }));
app.use(OTLP_TRACES_PATH, express.raw({ type: 'application/x-protobuf', limit: otlpMaxBodyLabel }));

app.use(
  OTLP_TRACES_PATH,
  otlpBodyErrorHandler(
    () => (otlpTracesStats.requestsRejected += 1),
    `OTLP request exceeds ${otlpMaxBodyLabel} or ${otlpMaxRecords} spans`,
    OTLP_TRACES_UNSUPPORTED_MEDIA_MESSAGE,
    OTLP_TRACES_MALFORMED_BODY_MESSAGE
  )
);

app.post(OTLP_TRACES_PATH, async (req, res) => {
  const isProtobufRequest = Buffer.isBuffer(req.body);
  const respondStatus = (status: 400 | 413, message: string) => {
    otlpTracesStats.requestsRejected += 1;
    markRejection(res, status === 413 ? 'payload_too_large' : 'unrecognized_payload');
    if (isProtobufRequest) {
      res.status(status).type('application/x-protobuf').send(Buffer.from(encodeStatus(3, message)));
    } else {
      res.status(status).json(otlpErrorBody(3, message));
    }
  };

  let body: unknown;
  if (isProtobufRequest) {
    try {
      body = decodeExportTraceServiceRequest(req.body as Buffer);
    } catch (error) {
      respondStatus(400, OTLP_TRACES_MALFORMED_BODY_MESSAGE);
      return;
    }
  } else {
    body = req.body ?? {};
  }

  if (!looksLikeOtlpTracesRequest(body)) {
    respondStatus(400, OTLP_TRACES_MALFORMED_BODY_MESSAGE);
    return;
  }

  const totalSpans = countSpans(body);
  if (totalSpans > otlpMaxRecords) {
    respondStatus(413, `OTLP request exceeds ${otlpMaxBodyLabel} or ${otlpMaxRecords} spans`);
    return;
  }

  const mapped = mapOtlpTraces(body);

  let appendResult: AppendBatchResult;
  const otlpSubmitterId = submitterIdForRequest(req, res);
  try {
    appendResult = await store.appendBatch(mapped.events, { channel: 'otlp', submitterId: otlpSubmitterId });
    recordAppendResults(appendResult.results, mapped.events);
  } catch (error) {
    otlpTracesStats.requestsRejected += 1;
    if (isProtobufRequest) res.status(503).type('application/x-protobuf').send(Buffer.from(encodeStatus(14, 'Storage unavailable, retry')));
    else res.status(503).json(otlpErrorBody(14, 'Storage unavailable, retry'));
    return;
  }

  appendResult.acceptedEvents.forEach((event, index) => broadcastEvent(event, appendResult.acceptedSeqs[index] ?? null, otlpSubmitterId));

  otlpTracesStats.requestsAccepted += 1;
  otlpTracesStats.spansReceived += totalSpans;
  otlpTracesStats.spansMapped += appendResult.accepted;
  otlpTracesStats.spansDuplicates += appendResult.duplicates;
  otlpTracesStats.spansIgnored += mapped.ignored;
  otlpTracesStats.spansRejected += mapped.rejected.count + appendResult.conflicts;
  otlpTracesStats.warnings += mapped.warnings;

  // Debug header (issue #97): on every 200, so "why do I not see my spans" is answerable with `curl -i`.
  // `accepted`/`duplicates` are the store's own post-dedup counts; `ignored`/`rejected`/`warnings` come straight
  // from the mapper, which never touches the store.
  const rejectedCount = mapped.rejected.count + appendResult.conflicts;
  res.setHeader(
    'X-Agent-Viewer-OTLP',
    `accepted=${appendResult.accepted}; duplicates=${appendResult.duplicates}; ignored=${mapped.ignored}; rejected=${rejectedCount}; warnings=${mapped.warnings}`
  );

  if (rejectedCount === 0) {
    if (isProtobufRequest) res.status(200).type('application/x-protobuf').send(Buffer.from(encodeExportTraceServiceResponse()));
    else res.status(200).json({});
    return;
  }

  const reasonCounts = new Map<string, number>();
  for (const reason of mapped.rejected.reasons) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  if (appendResult.conflicts > 0) reasonCounts.set('conflicting_duplicate', (reasonCounts.get('conflicting_duplicate') ?? 0) + appendResult.conflicts);
  const reasonSummary = Array.from(reasonCounts.entries())
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
  const errorMessage = `rejected ${rejectedCount} of ${totalSpans} spans: ${reasonSummary}`.slice(0, 2000);

  if (isProtobufRequest) {
    res
      .status(200)
      .type('application/x-protobuf')
      .send(Buffer.from(encodeExportTraceServiceResponse({ rejectedCount, errorMessage })));
  } else {
    res.status(200).json({
      partialSuccess: {
        rejectedSpans: String(rejectedCount),
        errorMessage,
      },
    });
  }
});

// -------------------------------------------------------------
// GET /metrics (issue #103): Prometheus text-exposition export. Mounted here, before the global JSON body
// parser and the CORS middleware below, so it is never CORS-enabled (no Access-Control-Allow-Origin header,
// ever) and a cross-origin page can never read it even when AGENT_VIEWER_CORS_ORIGIN is unset or `*`.
// `OPTIONS /metrics` therefore never reaches `app.options('*')` either; the method guard below answers it
// directly.
//
// The first sub-issue (#350) shipped the endpoint's enabling, auth and rate-limit plumbing plus the two
// families computable without a ledger query (`agent_viewer_build_info`, `agent_viewer_sse_clients`). This
// sub-issue (#348) adds the ledger-derived families (tokens, cost, calls, failures, latency, the two ledger
// gauges; `server/metrics/ledgerFamilies.ts`), cached per `AGENT_VIEWER_METRICS_CACHE_MS`
// (`server/metrics/ledgerFamiliesCache.ts`). The optional OTLP metrics push remains a later sub-issue of #103
// (#349); the in-process ingestion counters shipped separately (#365, #378).
// -------------------------------------------------------------

/** `AGENT_VIEWER_METRICS_CACHE_MS` (issue #103): default 5000, `0` disables the cache. An invalid value (not a
 * finite number, or negative) falls back to the default rather than silently caching forever or never. */
function getMetricsCacheMs(): number {
  const raw = process.env.AGENT_VIEWER_METRICS_CACHE_MS;
  if (raw === undefined || raw.trim() === '') return 5000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5000;
}

/** `AGENT_VIEWER_METRICS_MAX_MODELS` (issue #103): default 100. An invalid value (not a positive integer) falls
 * back to the default. */
function getMetricsMaxModels(): number {
  const raw = process.env.AGENT_VIEWER_METRICS_MAX_MODELS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_METRICS_MAX_MODELS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_METRICS_MAX_MODELS;
}

const ledgerFamiliesCache = new LedgerFamiliesCache({
  getStore: () => store,
  getTtlMs: getMetricsCacheMs,
  getMaxModels: getMetricsMaxModels,
});

/** Opt-in (issue #103): disabled by default, so existing deployments see no new surface. CLI: `--metrics`. */
function isMetricsEnabled(): boolean {
  return process.env.AGENT_VIEWER_METRICS === '1';
}

/** A metrics-only token, read per request like every other token in this file. Blank counts as unset, so it can
 * never silently turn into an empty, always-matching string. When unset, `/metrics` falls back to the API token;
 * when set, the API token is no longer accepted on this route (issue #103: a scraper holds a credential that
 * cannot ingest events). */
function getMetricsToken(): string | undefined {
  const token = process.env.AGENT_VIEWER_METRICS_TOKEN?.trim();
  return token ? token : undefined;
}

/** Explicit auth opt-out (issue #103): serves `/metrics` with no credential check at all, for a private network
 * or sidecar scrape. Any value other than exactly `off` leaves auth on. */
function isMetricsAuthOff(): boolean {
  return process.env.AGENT_VIEWER_METRICS_AUTH === 'off';
}

/** Runs first, independent of enabled/auth state, so a client sending the wrong method always gets a clear
 * `405` instead of a `404` (disabled) or `401`/`403` (auth) that would suggest the method was the problem. */
function metricsMethodGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    next();
    return;
  }
  res.setHeader('Allow', 'GET, HEAD');
  res.status(405).json({ error: 'method_not_allowed', message: 'GET and HEAD only' });
}

/** `404`, identical for every disabled state, so a scan cannot tell "feature off" from "route does not exist". */
function metricsEnabledGuard(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (isMetricsEnabled()) {
    next();
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).json({ error: 'not_found', message: 'Not found' });
}

/** Issue #103's auth decision for `/metrics`: Bearer-only (no `?token=`/`?api_key=` support, since this
 * middleware never reads the query string at all), `AGENT_VIEWER_METRICS_TOKEN` when set, else the API token,
 * `403 metrics_require_token` when neither is set and auth is not explicitly off. */
function metricsAuthGuard(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (isMetricsAuthOff()) {
    next();
    return;
  }
  const expectedToken = getMetricsToken() ?? getApiToken();
  if (!expectedToken) {
    res.setHeader('Cache-Control', 'no-store');
    markRejection(res, 'unauthorized');
    res.status(403).json({
      error: 'metrics_require_token',
      message: 'Set AGENT_VIEWER_METRICS_TOKEN or AGENT_VIEWER_API_TOKEN, or set AGENT_VIEWER_METRICS_AUTH=off',
    });
    return;
  }
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  if (bearerMatch && safeEqual(bearerMatch[1], expectedToken)) {
    next();
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  reject(res, 401, { error: 'unauthorized', message: 'Valid Bearer token required' }, 'unauthorized');
}

app.use('/metrics', metricsMethodGuard);
app.use('/metrics', metricsEnabledGuard);
app.use('/metrics', metricsRateLimiter);
app.use('/metrics', metricsAuthGuard);

function writeMetricsResponse(res: express.Response, body: string): void {
  // A string body makes Express's `res.send()` run the existing Content-Type through `setCharset`, which
  // re-serializes its parameters in sorted key order (`charset` before `version`); sending a Buffer instead
  // skips that path entirely, so the header comes out byte for byte as the exposition format specifies.
  res.setHeader('Content-Type', METRICS_CONTENT_TYPE);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(Buffer.from(body, 'utf8'));
}

app.get('/metrics', async (_req, res) => {
  let ledger: Awaited<ReturnType<typeof ledgerFamiliesCache.get>>;
  try {
    ledger = await ledgerFamiliesCache.get();
  } catch (err) {
    // Issue #103: never a partial body without the ledger families (an absent series must not look like zero).
    // The failure itself is not cached (`LedgerFamiliesCache`), so the next scrape retries.
    console.error('[agent-viewer] /metrics: ledger query failed:', err);
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({ error: 'metrics_unavailable' });
    return;
  }
  const body = renderExposition([
    ...buildInProcessFamilies({
      version: SERVER_VERSION,
      storage: store.readiness().storage,
      sseClients: clients.size,
    }),
    ...ingestionMetrics.families(),
    ...ledger.families,
    ...buildLedgerGaugeFamilies(ledger.gauges),
  ]);
  writeMetricsResponse(res, body);
});

// HEAD must answer with the same headers as GET and no body (issue #103's "GET (and HEAD)" requirement).
app.head('/metrics', (_req, res) => {
  writeMetricsResponse(res, '');
});

// Body parsing with raw buffer capture for webhook HMAC
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);

// Malformed JSON handler
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && 'body' in err) {
    reject(res, 400, { error: 'bad_request', message: 'Malformed JSON payload' }, 'malformed_json');
    return;
  }
  next(err);
});

// CORS configuration
app.use((req, res, next) => {
  const allowedOrigin = process.env.AGENT_VIEWER_CORS_ORIGIN ?? '*';
  const requestOrigin = req.header('origin');

  if (allowedOrigin === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (requestOrigin && (allowedOrigin === requestOrigin || allowedOrigin.split(',').map((s) => s.trim()).includes(requestOrigin))) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin.split(',')[0].trim());
  }

  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, idempotency-key, last-event-id, x-agent-viewer-signature, x-agent-viewer-timestamp');
  // PUT and DELETE added for the portal's pricing/budgets REST client (issue #88, sub-issue #332): the Model Ops
  // pricing editor and budgets panel run on a different origin in dev (:3000 against the server's :8787) and
  // need both verbs for `POST /api/v1/pricing/changes` (unaffected, still POST) and `PUT`/`DELETE
  // /api/v1/budgets/:id`.
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  next();
});

// Express 5 (path-to-regexp 8) needs a named wildcard; `/{*path}` also matches `/`, like `*` did in Express 4.
app.options('/{*path}', (_req, res) => {
  res.sendStatus(204);
});

let warnedDeprecatedApiKey = false;

/**
 * API token that protects /api/v1. AGENT_VIEWER_API_TOKEN is canonical; AGENT_VIEWER_API_KEY is a
 * deprecated alias kept for older setups. Read per request so the value can change without a restart.
 */
function getApiToken(): string | undefined {
  const token = process.env.AGENT_VIEWER_API_TOKEN;
  if (token) return token;

  const legacy = process.env.AGENT_VIEWER_API_KEY;
  if (legacy) {
    if (!warnedDeprecatedApiKey) {
      warnedDeprecatedApiKey = true;
      console.warn('[agent-viewer] AGENT_VIEWER_API_KEY is deprecated; rename it to AGENT_VIEWER_API_TOKEN.');
    }
    return legacy;
  }
  return undefined;
}

/** Whether /api/v1 asks for a token right now. Read per request, like getApiToken(). */
export type AuthMode = 'token' | 'open';
/** How webhooks authenticate right now. */
export type WebhookAuthMode = 'signature' | 'token' | 'open';

export function currentAuthMode(): AuthMode {
  return getApiToken() ? 'token' : 'open';
}

export function currentWebhookAuthMode(): WebhookAuthMode {
  if (process.env.AGENT_VIEWER_WEBHOOK_SECRET) return 'signature';
  return currentAuthMode();
}

/** Lines printed at start when /api/v1 is open. Empty when a token is set. Never contains the token. */
export function openApiWarning(input: {
  port: number;
  host?: string;
  webhookSecret: boolean;
  tokenSet: boolean;
}): string[] {
  if (input.tokenSet) return [];

  const loopback = input.host !== undefined && isLoopbackHost(input.host);
  const lines = [
    '[agent-viewer] WARNING: AGENT_VIEWER_API_TOKEN is not set, so /api/v1 is OPEN.',
    loopback
      ? `[agent-viewer]   Listening on ${input.host} only, port ${input.port}. Any process on this machine can send events, change the token and cost figures you see, and read every agent, task and usage record.`
      : `[agent-viewer]   Listening on every interface, port ${input.port}. Anyone who can reach it can send events,`,
    ...(!loopback
      ? ['[agent-viewer]   change the token and cost figures you see, and read every agent, task and usage record.']
      : []),
  ];
  if (!input.webhookSecret) lines.push('[agent-viewer]   Webhooks are open too (no AGENT_VIEWER_WEBHOOK_SECRET).');
  lines.push(
    '[agent-viewer]   Fix: set AGENT_VIEWER_API_TOKEN to a long random value (for example: openssl rand -base64 32)',
    '[agent-viewer]   and restart, or use `agent-viewer start`, which always runs with a token.',
    '[agent-viewer]   A future release will refuse to start without a token.',
  );
  return lines;
}

/** Prints openApiWarning() to stderr, reading the live env state at call time. */
function warnIfApiOpen(portToListen: number, host?: string): void {
  for (const line of openApiWarning({
    port: portToListen,
    host,
    webhookSecret: Boolean(process.env.AGENT_VIEWER_WEBHOOK_SECRET),
    tokenSet: currentAuthMode() === 'token',
  })) {
    console.warn(line);
  }
}

/** One-line startup warning when `AGENT_VIEWER_METRICS_AUTH=off` serves `/metrics` without a credential check
 * (issue #103), mirroring the wording style of the open-API warning above. A no-op unless `/metrics` is also
 * enabled, since the off switch has no effect otherwise. */
function warnIfMetricsAuthOff(): void {
  if (isMetricsEnabled() && isMetricsAuthOff()) {
    console.warn('[agent-viewer] WARNING: AGENT_VIEWER_METRICS_AUTH=off, so /metrics serves with no credential check.');
  }
}

/** Constant-time string comparison. Hashing first gives equal-length buffers, so length does not leak or throw. */
function safeEqual(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Rate limiting runs before authentication so failed token guesses count toward the limit.
app.use('/api/v1', rateLimiter);

// A leaked `?token=`/`?api_key=` must never authenticate, in any mode, even in the open-mode window below
// (issue #71). Runs before the open-mode guard and the Bearer check so the response is always the same.
app.use('/api/v1', rejectQueryToken);

// Defense in depth for the no-token state: blocks non-loopback requests, non-loopback Host headers and
// cross-origin pages even when the open-mode guard at bind time (assertSafeBind) was itself bypassed by an
// embedder calling app.listen() directly (issue #71). A no-op once a token is set or AGENT_VIEWER_ALLOW_OPEN=1.
app.use('/api/v1', openModeGuard);

// Authentication middleware for /api/v1/*. With a webhook secret configured, webhooks authenticate with
// their HMAC signature (checked in the route) instead of the token; every other /api/v1 route, and
// OTLP_LOGS_PATH above, share the same isRequestAuthorized decision through requireApiToken (issue #59).
// GET /events/stream additionally accepts a single-use ticket in place of the Bearer header (issue #71),
// because EventSource cannot send one.
app.use(
  '/api/v1',
  requireApiToken({
    webhookBypass: true,
    streamTicketRoute: '/events/stream',
    onUnauthorized: (res) =>
      res.status(401).json({
        error: 'unauthorized',
        message: 'Valid Bearer token required',
      }),
  })
);

// Issue #108: default-deny scope policy. Runs after authentication (401) and before every route handler (so
// before its body validation, 400): each method+path needs the scope `server/auth/routePolicy.ts` declares for
// it, `admin` for anything not declared, `403 insufficient_scope` otherwise. The HMAC-signed webhook is the one
// request that legitimately arrives here without a principal (`requireApiToken`'s `webhookBypass`); its route
// verifies the signature itself.
app.use(
  '/api/v1',
  enforceRoutePolicy({
    ...scopeGuardOptions,
    selfAuthenticated: (req) => req.path.startsWith('/webhooks') && Boolean(process.env.AGENT_VIEWER_WEBHOOK_SECRET),
  })
);

// -------------------------------------------------------------
// Health & Ready
// -------------------------------------------------------------
const SERVER_VERSION: string = readPackageVersion();

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    service: 'agent-viewer',
    version: SERVER_VERSION,
    schemaVersion: '1.0',
    clientsConnected: clients.size,
    auth: currentAuthMode(),
    webhookAuth: currentWebhookAuthMode(),
    sse: {
      replayMax: sseReplayMax,
      replaysSinceStart: sseCounters.replaysSinceStart,
      eventsReplayedSinceStart: sseCounters.eventsReplayedSinceStart,
      resyncsSinceStart: sseCounters.resyncsSinceStart,
    },
  });
});

app.get('/ready', async (_req, res) => {
  try {
    const readiness = store.readiness();
    const database = store.getSchemaInfo?.();
    // Issue #105: 'enabled'/'disabled', not the full chain body (that is GET /api/v1/audit/chain).
    const chain = (await store.chainInfo()).enabled ? 'enabled' : 'disabled';
    if (!readiness.ready) res.setHeader('Retry-After', '1');
    res.status(readiness.ready ? 200 : 503).json({
      ok: readiness.ready,
      ready: readiness.ready,
      storage: readiness.storage,
      ...(database ? { database } : {}),
      // Per process, reset on restart: conflicting duplicates rejected and legacy rows matched by id only.
      ingestion: store.ingestionCounters(),
      // Startup rebuild from SQLite (issue #52): 'done' at once for memory storage, nothing to replay.
      rebuild: readiness.rebuild,
      chain,
    });
  } catch (err: any) {
    res.status(503).json({ ok: false, ready: false, error: err?.message || 'Storage error' });
  }
});

/** Listeners told about every event the server accepts, in the order they are broadcast (used by `--record`). */
type AcceptedEventListener = (event: CanonicalEvent) => void | Promise<void>;
const acceptedEventListeners = new Set<AcceptedEventListener>();

/** Calls `listener` with each accepted event. Returns a function that removes the listener. */
export function onEventAccepted(listener: AcceptedEventListener): () => void {
  acceptedEventListeners.add(listener);
  return () => {
    acceptedEventListeners.delete(listener);
  };
}

// Issue #387: drives the `AGENT_VIEWER_CHECKPOINT_EVERY_EVENTS` trigger. Events appended without a broadcast
// (`appendAuditKeyEvent`) are not counted here, but are still covered by the next checkpoint of any kind.
if (auditCheckpoints) {
  const service = auditCheckpoints;
  onEventAccepted(() => service.noteChainedEvents());
}

// Helper to broadcast event to SSE subscribers (without named event so EventSource.onmessage receives all)
/**
 * Broadcasts an accepted event to SSE subscribers (without a named event, so `EventSource.onmessage` receives
 * all of them). `seq` is the event's insertion seq (issue #54), used to order the live buffer of a connection
 * still replaying a reconnect gap: `broadcastEvent` queues the frame for it instead of writing it right away, so
 * nothing broadcast during its replay is ever lost or delivered out of order. `submittedBy` (issue #107) is
 * included in the live frame's data when known; a reconnect's replayed frames (built from the stored event
 * through a separate path, `listBetween`) do not yet carry it, a documented gap of this item.
 */
function broadcastEvent(event: CanonicalEvent, seq: EventSeq | null, submittedBy: string | null = null) {
  for (const listener of acceptedEventListeners) {
    // A failing listener must never break ingestion, whether it throws or returns a rejected promise.
    try {
      const result = listener(event);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Ignored on purpose, see above.
    }
  }
  const frame = `id: ${event.id}\ndata: ${JSON.stringify(submittedBy !== null ? { ...event, submittedBy } : event)}\n\n`;
  for (const client of clients) {
    const replay = replayBuffers.get(client);
    if (replay) {
      if (replay.overflowed) continue;
      if (replay.buffer.length >= sseReplayBufferMax) {
        replay.overflowed = true;
        continue;
      }
      replay.buffer.push({ seq, frame });
      continue;
    }
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

/** Body of a `409 conflicting_duplicate`, also used for conflicting items of a batch. */
function conflictMessage(id: string): string {
  return `An event with id "${id}" was already stored with different content. The new event was not applied.`;
}

/**
 * Issue #86 (sub-issue #319): `budget.alert` is emitted by the server only (`server/budgetAlerts.ts`); a client
 * must never be able to forge one, or squat its reserved id prefix ahead of time. Checked on both ingest endpoints
 * against the resolved `type`/`id` (after `Idempotency-Key` merging on the single endpoint), before validation.
 * Returns the matching `{ path, message }`, used as-is both for the single endpoint's top-level `message` and for
 * a batch item's own `issues` entry.
 */
function reservedBudgetAlertIssue(body: unknown): { path: 'type' | 'id'; message: string } | null {
  if (!body || typeof body !== 'object') return null;
  const candidate = body as { type?: unknown; id?: unknown };
  const message = 'reserved_event_type: budget.alert is emitted by the server only';
  if (candidate.type === 'budget.alert') return { path: 'type', message };
  if (typeof candidate.id === 'string' && candidate.id.startsWith('evt_budget_')) return { path: 'id', message };
  return null;
}

/**
 * Issue #109: every `audit.*` type is server-only, and `tombstone`/`redactionRulesVersion` are server-assigned.
 * Checked on the raw body (before validation, which would otherwise just drop the unknown fields) so a client
 * learns it tried to forge server state instead of having it silently ignored.
 */
function reservedAuditIssue(body: unknown): { error: 'reserved_type' | 'reserved_field'; path: string; message: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.type === 'string' && candidate.type.startsWith('audit.')) {
    return { error: 'reserved_type', path: 'type', message: 'reserved_type: audit.* events are emitted by the server only' };
  }
  for (const field of ['tombstone', 'redactionRulesVersion']) {
    if (Object.prototype.hasOwnProperty.call(candidate, field)) {
      return { error: 'reserved_field', path: field, message: `reserved_field: ${field} is assigned by the server only` };
    }
  }
  return null;
}

/**
 * Stores an event the server built itself and broadcasts it only when the store accepted it. Any other outcome
 * means a server-generated id was reused, which is a server bug: it is logged at error and answered with
 * `500 internal_id_collision` instead of being hidden. Returns false when the response was already sent.
 * Issue #105: `submitter_id` on a server-generated event is the submitter of the request that triggered it
 * (`POST /agents`, `PATCH /agents`, `POST /runtimes`), never a separate "server" identity.
 */
async function appendServerEvent(event: CanonicalEvent, req: express.Request, res: express.Response): Promise<boolean> {
  const submitterId = submitterIdForRequest(req, res);
  const result: AppendResult = await store.append(event, { submitterId });
  if (result.outcome === 'accepted') {
    broadcastEvent(event, result.seq, submitterId);
    return true;
  }
  console.error(
    `[agent-viewer] Server-generated event id collided: ${JSON.stringify({ id: event.id, type: event.type, outcome: result.outcome })}`
  );
  res.status(500).json({
    error: 'internal_id_collision',
    message: `The server generated event id "${event.id}", which was already stored. The event was not applied.`,
  });
  return false;
}

// -------------------------------------------------------------
// Budgets: live transitions (issue #85 section 6, sub-issue #305)
// -------------------------------------------------------------

/**
 * Writes the `event: budget` SSE frame for a detected live transition. Deliberately has no `id:` line, unlike
 * `broadcastEvent`'s canonical-event frames: a transition is a live, derived signal about currently-computed
 * state, never stored, never replayed on reconnect, and never counted toward `CANONICAL_EVENT_TYPES` or any
 * `Last-Event-ID` cursor. A client that misses one (not yet connected, or disconnected at the time) can always
 * recover the current truth with a plain `GET /api/v1/budgets/:id`; there is nothing to "replay" for a value
 * computed fresh on every read. Broadcast to every open `/api/v1/events/stream` connection, bypassing
 * `replayBuffers` entirely: a connection mid-reconnect-replay simply never sees this one broadcast, the same way
 * it never sees a mid-replay heartbeat, because both are regenerable from scratch, unlike a canonical event, which
 * `replayBuffers` exists specifically to never lose.
 */
function broadcastBudgetTransition(transition: BudgetTransition): void {
  const frame = `event: budget\ndata: ${JSON.stringify(transition)}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

/**
 * Runs one live check for `budget` and reacts to its result: a detected transition is broadcast as the `event:
 * budget` SSE frame and handed to every `onBudgetTransition` listener (#86's own integration point). A failure
 * (a ledger read error, for example) is logged and swallowed, exactly like `evaluateBudgetView`'s own per-budget
 * error handling: one budget's live check failing must never stop ingestion, the SSE broadcast loop, or the
 * rollover sweep for every other budget.
 */
async function checkBudgetLive(budget: Budget, trigger: BudgetTransitionTrigger): Promise<void> {
  try {
    const { transition } = await evaluateBudgetLive(budget, budgetDeps, trigger);
    if (transition) {
      broadcastBudgetTransition(transition);
      emitBudgetTransition(transition);
    }
  } catch (error) {
    console.error(
      `[agent-viewer] budget live check failed for ${budget.id}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Re-checks every enabled budget on every accepted `llm.usage`/`llm.failed` event (issue #85 section 2 rule 3: only
// these two event types can ever move a budget's spend). Checking every enabled budget, not a scope-matched
// subset, is the simple, correct v1 behavior: a scope-based pre-filter to skip budgets the event cannot possibly
// affect is a performance optimization left for #307, the same place #304 already deferred the registry's own
// exact-key evaluation cache. Fire-and-forget, like every other `onEventAccepted` listener (`broadcastEvent`
// never awaits one either): a slow or failing budget check must never delay the event-ingestion response.
onEventAccepted((event) => {
  if (event.type !== 'llm.usage' && event.type !== 'llm.failed') return;
  for (const budget of budgetRegistry.list()) {
    if (!budget.enabled) continue;
    checkBudgetLive(budget, 'ledger_event').catch(() => {
      // checkBudgetLive already logs and swallows its own failure; this guards only against a bug in that
      // function itself, so it can never surface as an unhandled rejection.
    });
  }
});

// The window-rollover watcher (issue #85 section 6, sub-issue #305): an unref'd `setInterval`, same pattern as
// `server/retention.ts`'s `startRetention`, so a budget whose window rolls over (most commonly back to `'ok'` at
// midnight) is still observed and still produces a transition even with zero matching ledger events near the
// boundary. `shutdown()` above already stops it.
budgetRolloverWatcher = startBudgetRolloverWatcher({
  getRegistry: () => budgetRegistry,
  check: (budget, trigger) => checkBudgetLive(budget, trigger),
});

// -------------------------------------------------------------
// Budget alerts (issue #86, sub-issue #319, extended by #321): the durable, deduplicated `budget.alert` canonical
// event, plus its outbound webhook delivery row. Registered once at process bootstrap, on top of #85's own
// `onBudgetTransition` subscription point, exactly as that hook's own doc comment in `server/budgets.ts`
// anticipates. `buildBudgetAlert` ignores every transition that does not land on `warning`/`exceeded` (a drop back
// to `ok`, or into `unknown`, is never an alert); `store.recordBudgetAlert` is the actual dedup (a real crossing
// can reach this listener more than once, the same race `onBudgetTransition` documents), so only a genuinely new
// row is broadcast. `attemptDelivery` is `false` (the delivery row is written `skipped`) for a backfill alert or
// when no webhook URL is configured; a webhook enabled afterward never retroactively delivers that row. A failing
// listener must never break the live-transition broadcast (`checkBudgetLive`) or any other `onBudgetTransition`
// subscriber: errors are caught, logged and swallowed here, the same policy `broadcastEvent`'s own listeners and
// `emitBudgetTransition` already follow.
// -------------------------------------------------------------
onBudgetTransition(async (transition) => {
  const built = buildBudgetAlert(transition);
  if (!built) return;
  const attemptDelivery = alertWebhookConfig !== null && !built.alert.backfill;
  try {
    const result = await store.recordBudgetAlert(built, { attemptDelivery });
    if (result.inserted) {
      broadcastEvent(result.event, result.seq, 'system');
      // Off the ingest request path (this whole listener already is): wakes the poll worker so a configured
      // webhook fires promptly instead of waiting out its poll interval, without ever blocking this handler's
      // own caller on the delivery attempt itself.
      if (attemptDelivery) void alertDeliveryWorker?.checkNow();
    }
  } catch (error) {
    console.error(
      `[agent-viewer] failed to record budget alert for ${transition.budgetId} (${transition.to}): ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

// -------------------------------------------------------------
// Event Ingestion (Single)
// -------------------------------------------------------------
app.post('/api/v1/events', async (req, res) => {
  const idempotencyKey = req.header('idempotency-key');
  // Express 5 leaves req.body undefined when the request has no JSON body (Express 4 set it to {}).
  let body = req.body ?? {};

  if (idempotencyKey) {
    // The header and the body id name the same event. When both are given and differ, nothing is stored.
    const bodyId: unknown = typeof body === 'object' && body !== null ? body.id : undefined;
    if (typeof bodyId === 'string' && bodyId.length > 0 && bodyId !== idempotencyKey) {
      markRejection(res, 'validation');
      res.status(400).json({
        error: 'idempotency_key_mismatch',
        message: `Idempotency-Key "${idempotencyKey}" does not match the event id "${bodyId}".`,
      });
      return;
    }
    if (!body.id) {
      body = { ...body, id: idempotencyKey };
    }
  }

  const reservedAudit = reservedAuditIssue(body);
  if (reservedAudit) {
    markRejection(res, 'validation');
    res.status(400).json({ error: reservedAudit.error, path: reservedAudit.path, message: reservedAudit.message });
    return;
  }

  const reserved = reservedBudgetAlertIssue(body);
  if (reserved) {
    markRejection(res, 'validation');
    res.status(400).json({
      error: 'reserved_event_type',
      message: 'budget.alert is emitted by the server only',
    });
    return;
  }

  const validation = validateCanonicalEvent(body);
  if (!validation.success || !validation.data) {
    markRejection(res, 'validation');
    res.status(400).json({
      error: 'validation_failed',
      issues: validation.issues ?? [{ path: '', message: 'Invalid event payload' }],
    });
    return;
  }

  const event = validation.data;
  const submitterId = submitterIdForRequest(req, res);
  const result = await store.append(event, { submitterId });
  recordAppendResults([result], [event]);

  if (result.outcome === 'conflict') {
    // Same id, different content: not applied, not stored, not broadcast. The stored event stays as it was.
    res.status(409).json({
      error: 'conflicting_duplicate',
      message: conflictMessage(event.id),
      id: event.id,
      fingerprint: result.fingerprint,
      storedFingerprint: result.storedFingerprint,
    });
    return;
  }

  if (result.outcome === 'duplicate') {
    // `id` is the id the figure is held under: the original event id for a request_id duplicate, the same id
    // sent for an event_id duplicate. `submittedId` and `matchesOriginal` appear only when they apply (#48).
    res.status(200).json({
      accepted: true,
      duplicate: true,
      duplicateReason: result.duplicateReason,
      id: result.id,
      ...(result.submittedId !== undefined ? { submittedId: result.submittedId } : {}),
      ...(result.matchesOriginal !== undefined ? { matchesOriginal: result.matchesOriginal } : {}),
      fingerprint: result.fingerprint,
      // The original acceptance time, not the retry's (issue #65).
      receivedAt: result.receivedAt,
    });
    return;
  }

  broadcastEvent(event, result.seq, submitterId);

  // Issue #105: an optional receipt, SQLite mode only (chainRecords returns {} in memory mode and when the
  // chain is disabled).
  const chainRecords = await store.chainRecords([event.id]);
  const chainReceipt = chainRecords[event.id];

  res.status(202).json({
    accepted: true,
    duplicate: false,
    id: event.id,
    fingerprint: result.fingerprint,
    receivedAt: result.receivedAt,
    ...(chainReceipt ? { chain: { seq: chainReceipt.seq, hash: chainReceipt.hash, receivedAt: chainReceipt.receivedAt } } : {}),
  });
});

// -------------------------------------------------------------
// Event Ingestion (Batch)
// -------------------------------------------------------------
app.post('/api/v1/events/batch', async (req, res) => {
  const rawEvents: unknown = Array.isArray(req.body) ? req.body : req.body?.events;

  if (!Array.isArray(rawEvents)) {
    markRejection(res, 'validation');
    res.status(400).json({
      error: 'invalid_batch',
      message: 'Expected JSON array of events or an object with "events" array',
    });
    return;
  }

  if (rawEvents.length === 0) {
    markRejection(res, 'empty_batch');
    res.status(400).json({
      error: 'empty_batch',
      message: 'Batch cannot be empty',
    });
    return;
  }

  if (rawEvents.length > maxBatchSize) {
    markRejection(res, 'batch_too_large');
    res.status(413).json({
      error: 'batch_too_large',
      message: `Batch contains ${rawEvents.length} events; limit is ${maxBatchSize}`,
    });
    return;
  }

  // Issue #109: the whole batch is refused when any raw item forges a server-only type or field.
  for (let index = 0; index < rawEvents.length; index++) {
    const reservedAudit = reservedAuditIssue(rawEvents[index]);
    if (reservedAudit) {
      markRejection(res, 'validation');
      res.status(400).json({ error: reservedAudit.error, index, path: reservedAudit.path, message: reservedAudit.message });
      return;
    }
  }

  const validatedEvents: CanonicalEvent[] = [];
  const errors: Array<{ index: number; issues: ValidationIssue[] }> = [];

  rawEvents.forEach((item, index) => {
    const reserved = reservedBudgetAlertIssue(item);
    if (reserved) {
      errors.push({ index, issues: [reserved] });
      return;
    }
    const val = validateCanonicalEvent(item);
    if (val.success && val.data) {
      validatedEvents.push(val.data);
    } else {
      errors.push({ index, issues: val.issues ?? [{ path: '', message: 'Validation failed' }] });
    }
  });

  if (errors.length > 0) {
    markRejection(res, 'validation');
    res.status(400).json({
      error: 'validation_failed',
      message: `${errors.length} event(s) in batch failed validation`,
      errors,
    });
    return;
  }

  const batchSubmitterId = submitterIdForRequest(req, res);
  const { accepted, duplicates, conflicts, results, acceptedEvents, acceptedSeqs } = await store.appendBatch(validatedEvents, {
    channel: 'events-batch',
    submitterId: batchSubmitterId,
  });
  recordAppendResults(results, validatedEvents);

  acceptedEvents.forEach((event, index) => broadcastEvent(event, acceptedSeqs[index] ?? null, batchSubmitterId));

  // Issue #105: an optional receipt per accepted item, SQLite mode only, looked up by id (absent for
  // duplicates and conflicts).
  const chainRecords = await store.chainRecords(acceptedEvents.map((event) => event.id));

  // 202 even when every item is a conflict, so existing clients keep working: read `conflicts` and each `status`.
  res.status(202).json({
    accepted,
    duplicates,
    conflicts,
    total: rawEvents.length,
    results: results.map((result) =>
      result.outcome === 'conflict'
        ? {
            id: result.id,
            status: result.outcome,
            duplicate: false,
            fingerprint: result.fingerprint,
            error: 'conflicting_duplicate',
            storedFingerprint: result.storedFingerprint,
          }
        : {
            id: result.id,
            status: result.outcome,
            duplicate: result.duplicate,
            fingerprint: result.fingerprint,
            // The original acceptance time for a duplicate, never the retry's (issue #65).
            receivedAt: result.receivedAt,
            ...(result.duplicateReason ? { duplicateReason: result.duplicateReason } : {}),
            ...(result.submittedId !== undefined ? { submittedId: result.submittedId } : {}),
            ...(result.matchesOriginal !== undefined ? { matchesOriginal: result.matchesOriginal } : {}),
            ...(result.outcome === 'accepted' && chainRecords[result.id]
              ? {
                  chain: {
                    seq: chainRecords[result.id].seq,
                    hash: chainRecords[result.id].hash,
                    receivedAt: chainRecords[result.id].receivedAt,
                  },
                }
              : {}),
          }
    ),
  });
});

// -------------------------------------------------------------
// Events Query
// -------------------------------------------------------------
/**
 * `limit` clamp for `GET /api/v1/events` (issue #72): absent or not a finite number gives the default `100`;
 * otherwise `Math.floor` then clamp to `[1, 500]`. Before this the value was unbounded and unchecked.
 */
function parseEventsLimit(raw: unknown): number {
  const defaultLimit = 100;
  if (raw === undefined || raw === '') return defaultLimit;
  // `Number(...)` on purpose, like the previous unclamped implementation: with the "extended" query parser a
  // single-value array such as `limit[0]=1` still coerces to the expected number.
  const parsed = Number(raw as string);
  if (!Number.isFinite(parsed)) return defaultLimit;
  return Math.min(500, Math.max(1, Math.floor(parsed)));
}

app.get('/api/v1/events', async (req, res) => {
  const limit = parseEventsLimit(req.query.limit);
  const since = req.query.since ? Number(req.query.since) : undefined;
  const afterId = typeof req.query.afterId === 'string' ? req.query.afterId : undefined;
  const beforeId = typeof req.query.beforeId === 'string' ? req.query.beforeId : undefined;
  const runtimeId = typeof req.query.runtimeId === 'string' ? req.query.runtimeId : undefined;
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  const submittedBy = typeof req.query.submittedBy === 'string' ? req.query.submittedBy : undefined;
  // Issue #107: `audit.*` events are hidden by default, so a consumer that re-validates returned events against
  // `CANONICAL_EVENT_TYPES` (replay, import) never meets a type it does not know. Shown with `includeAudit=true`
  // or when `type` explicitly names one of them.
  const includeAudit = req.query.includeAudit === 'true' || (type !== undefined && (AUDIT_EVENT_TYPES as readonly string[]).includes(type));
  const excludeTypes = includeAudit ? undefined : AUDIT_EVENT_TYPES;

  // Backward paging (issue #72): an unknown or evicted cursor is a client error, unlike `afterId`, which applies
  // no filter when it cannot be resolved. A partial history must never look complete.
  if (beforeId !== undefined && (await store.resolveCursor(beforeId)) === null) {
    res.status(400).json({ error: 'invalid_cursor', message: `Unknown or evicted beforeId "${beforeId}"` });
    return;
  }

  // Fetch one extra row to learn whether there is a next page, without exposing it in the response.
  const page = await store.list({ limit: limit + 1, since, afterId, beforeId, runtimeId, sessionId, agentId, type, submittedBy, excludeTypes });
  const hasMore = page.length > limit;
  const events = hasMore ? page.slice(0, limit) : page;
  const nextBeforeId = hasMore ? (events[events.length - 1]?.id ?? null) : null;
  const retention = await store.retention();
  // Issue #105: `include=chain` adds a sibling map keyed by event id, byte-identical `events` otherwise. Any
  // other `include` value is ignored, as before this item.
  const includeChain = req.query.include === 'chain';
  const chain = includeChain ? await store.chainRecords(events.map((e) => e.id)) : undefined;
  res.json({
    schemaVersion: '1.0',
    count: events.length,
    hasMore,
    nextBeforeId,
    events,
    retention,
    ...(chain ? { chain } : {}),
  });
});

// -------------------------------------------------------------
// Snapshot
// -------------------------------------------------------------
app.get('/api/v1/snapshot', requireReady, async (_req, res) => {
  const snapshot = await store.snapshot();
  // Issue #85 section 5: additive field, `[]` with no budgets configured, built here (not inside `EventStore`)
  // so neither `snapshot()` implementation needs to know about budgets at all.
  const budgets = await listBudgetViews(budgetDeps);
  res.json({ ...snapshot, budgets });
});

// Usage aggregates only (the snapshot's `usage` block), without the event list.
app.get('/api/v1/usage', async (_req, res) => {
  res.json(await store.usageSummary());
});

// Usage ledger health (issue #65): counts and time bounds only, never a sum of tokens or cost (that is #66).
// Sits under /api/v1, so it gets the same auth and rate limit as every other route here.
app.get('/api/v1/usage/ledger/status', async (_req, res) => {
  res.json(await store.usageLedgerStatus());
});

/**
 * Issue #105: the current state of the hash chain. Read-only and under `/api/v1`, so it gets the same rate
 * limit, query-token rejection and Bearer auth as every other route here, including the future read-only
 * auditor role of #108. Never includes event payloads.
 */
app.get('/api/v1/audit/chain', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await store.chainInfo());
});

/** Per-scope in-flight de-duplication (issue #106): concurrent `GET /api/v1/audit/verify` requests with the
 * same `scope` share one walk instead of each opening their own read-only connection and re-walking the whole
 * chain. Keyed by `dbPath` too, mostly for `tests/audit-verify.test.mjs`, which constructs several stores (and
 * therefore several database files) within one process. */
const auditVerifyInFlight = new Map<string, Promise<unknown>>();

/**
 * Issue #106 (first sub-issue of the "formal audit" theme): walks the hash chain #105 added and reports the
 * first broken link, if any. `?scope=full|recent` (default `full`); this slice has no signed checkpoints yet
 * (#387), so `recent` always behaves like `full` and the report says so via `coverage.scope`. Memory storage,
 * and a SQLite store whose schema predates migration 17, answer the same `{ enabled: false, ... }` shape
 * `GET /api/v1/audit/chain` already uses (issue #105), not a `409`: this is a read about the chain's
 * availability, not a write this server refuses to perform.
 */
app.get('/api/v1/audit/verify', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const scopeParam = req.query.scope;
  if (scopeParam !== undefined && scopeParam !== 'full' && scopeParam !== 'recent') {
    res.status(400).json({ error: 'validation_failed', message: 'scope must be "full" or "recent"' });
    return;
  }
  const scope = (scopeParam as 'full' | 'recent' | undefined) ?? 'full';

  // getDatabasePath is synchronous (unlike chainInfo), so the in-flight map below is checked and set with no
  // await in between: two requests dispatched back to back always see the map in the state the first one left
  // it in, never both starting their own walk (issue #106's "share one walk" requirement). chainInfo() itself
  // only runs inside the cached promise, once.
  const dbPath = store.getDatabasePath?.();
  if (!dbPath) {
    // Memory mode (or any future store with no backing file): the same disabled shape GET /api/v1/audit/chain
    // already uses (issue #105), not a 409.
    res.json(await store.chainInfo());
    return;
  }

  const key = `${scope}\u0000${dbPath}`;
  let promise = auditVerifyInFlight.get(key);
  if (!promise) {
    promise = (async () => {
      const chainInfo = await store.chainInfo();
      if (!chainInfo.enabled) return chainInfo;
      return verifyChain({ dbPath, scope });
    })();
    auditVerifyInFlight.set(key, promise);
    promise.finally(() => {
      if (auditVerifyInFlight.get(key) === promise) auditVerifyInFlight.delete(key);
    });
  }
  try {
    const report = await promise;
    res.json(report);
  } catch (err) {
    console.error('[agent-viewer] /api/v1/audit/verify failed:', err);
    res.status(503).json({ error: 'audit_verify_failed', message: 'The chain could not be read.' });
  }
});

// -------------------------------------------------------------
// Chain-compatible retention, redaction and legal hold (issue #109)
// -------------------------------------------------------------

/** Issue #109: fixed until scoped identities (#107/#108) are wired into audit events. */
const AUDIT_API_ACTOR: AuditActor = { kind: 'api', name: 'api-token' };
const MAX_HOLD_REASON_LENGTH = 500;
const MAX_RULES_VERSION_LENGTH = 100;

/** One destructive run at a time per process: every batch is atomic on its own, this only stops two operators
 * from racing the same candidate list. */
let auditDestructiveRunInFlight = false;

/** Whether the store can tombstone with a chained audit trail (SQLite past migration 21). */
function storeSupportsAuditRetention(): boolean {
  return Boolean(store.getDatabasePath?.() && store.setLegalHold && store.activeLegalHold && store.listTombstoneCandidates && store.auditRetentionStatus);
}

/**
 * The fixed, fail-closed order for every mutating `/api/v1/audit` route (issue #109): `401` already came from the
 * `/api/v1` middleware; then `403 admin_token_required` when no API token is configured at all (open mode never
 * destroys anything), `403 admin_required` for any credential but the bootstrap token, then `409
 * audit_requires_sqlite`. The route itself then answers `400` for a bad body and `423` for an active hold.
 * Returns `true` (response sent) when the request must stop here.
 */
function refuseAuditMutation(res: express.Response): boolean {
  res.setHeader('Cache-Control', 'no-store');
  if (!getApiToken()) {
    res.status(403).json({
      error: 'admin_token_required',
      message: 'Set AGENT_VIEWER_API_TOKEN: destructive audit operations never run on an open API.',
    });
    return true;
  }
  const submitter = res.locals.submitter as Submitter | undefined;
  if (submitter?.kind !== 'bootstrap') {
    res.status(403).json({ error: 'admin_required', message: 'Only the bootstrap token (AGENT_VIEWER_API_TOKEN) may run this.' });
    return true;
  }
  if (!storeSupportsAuditRetention()) {
    res.status(409).json({ error: 'audit_requires_sqlite', message: 'Tombstones and legal holds need SQLite storage.' });
    return true;
  }
  return false;
}

function legalHoldLocked(res: express.Response): void {
  res.status(423).json({ error: 'legal_hold_active', message: 'A legal hold is active; nothing can be removed until it is released.' });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Shared tail of purge and redact: `423` when a hold stopped the run before anything was committed. */
function sendTombstoneResult(res: express.Response, result: TombstoneResult): void {
  if (result.stoppedByHold && result.batches === 0) {
    legalHoldLocked(res);
    return;
  }
  res.json(result);
}

/**
 * Policy, legal hold and tombstone state. `409` in memory mode: nothing there is chained, so there is nothing
 * auditable to report. Read-only, so it only needs the normal `/api/v1` credential.
 */
app.get('/api/v1/audit/retention', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!storeSupportsAuditRetention()) {
    res.status(409).json({ error: 'audit_requires_sqlite', message: 'Tombstones and legal holds need SQLite storage.' });
    return;
  }
  try {
    const status = await store.auditRetentionStatus!();
    res.json({
      storage: 'sqlite',
      policy: {
        eventsWindowDays: retentionConfig.eventsDays,
        intervalMinutes: retentionConfig.intervalMinutes,
        batchSize: retentionBatchSize,
        // The scheduled #70 job still deletes rows outright; only the routes below tombstone (see docs/retention.md).
        scheduledJobMode: retentionConfig.eventsDays === null ? 'off' : 'delete',
        destructiveRoutesEnabled: Boolean(getApiToken()),
      },
      legalHold: status.legalHold,
      lastRun: status.lastRun,
      tombstones: status.tombstones,
      // No redaction rules engine exists yet, so no rules version is in force.
      redactionRulesVersion: null,
      rowsByRedactionRulesVersion: status.rowsByRedactionRulesVersion,
    });
  } catch (err) {
    console.error('[agent-viewer] /api/v1/audit/retention failed:', err);
    res.status(503).json({ error: 'audit_retention_failed', message: 'Retention state could not be read.' });
  }
});

/** Places or releases the legal hold. Never `423`: releasing is exactly what a hold must still allow. */
app.post('/api/v1/audit/legal-hold', async (req, res) => {
  if (refuseAuditMutation(res)) return;
  const body = req.body;
  const action = isPlainObject(body) ? body.action : undefined;
  const reason = isPlainObject(body) ? body.reason : undefined;
  if (
    (action !== 'place' && action !== 'release')
    || typeof reason !== 'string'
    || reason.trim() === ''
    || reason.length > MAX_HOLD_REASON_LENGTH
  ) {
    res.status(400).json({
      error: 'validation_failed',
      message: `Expected { action: "place" | "release", reason: non-empty string up to ${MAX_HOLD_REASON_LENGTH} characters }`,
    });
    return;
  }
  try {
    const result = await store.setLegalHold!({
      active: action === 'place',
      reason,
      actor: AUDIT_API_ACTOR,
      submitterId: submitterIdForRequest(req, res),
    });
    if (!result.changed) {
      res.status(409).json({
        error: result.reason === 'already_active' ? 'legal_hold_already_active' : 'no_active_legal_hold',
        legalHold: result.hold,
      });
      return;
    }
    res.json({ legalHold: result.hold, auditEventId: result.auditEventId });
  } catch (err) {
    console.error('[agent-viewer] /api/v1/audit/legal-hold failed:', err);
    res.status(500).json({ error: 'legal_hold_failed', message: 'The legal hold could not be changed.' });
  }
});

/**
 * Tombstones every eligible event received before `before` (ms epoch). Batches of `AGENT_VIEWER_RETENTION_BATCH_SIZE`,
 * one chained `audit.retention.purged` event per batch; a hold placed mid-run stops it cleanly
 * (`stoppedByHold: true`, committed batches stay).
 */
app.post('/api/v1/audit/retention/purge', async (req, res) => {
  if (refuseAuditMutation(res)) return;
  const before = isPlainObject(req.body) ? req.body.before : undefined;
  if (typeof before !== 'number' || !Number.isSafeInteger(before) || before <= 0 || before > Date.now()) {
    res.status(400).json({ error: 'validation_failed', message: 'Expected { before: integer ms epoch, not in the future }' });
    return;
  }
  if (await store.activeLegalHold!()) {
    legalHoldLocked(res);
    return;
  }
  if (auditDestructiveRunInFlight) {
    res.status(409).json({ error: 'run_in_progress', message: 'Another retention or redaction run is in progress.' });
    return;
  }
  auditDestructiveRunInFlight = true;
  const total: TombstoneResult = { tombstoned: 0, skipped: 0, batches: 0, auditEventIds: [], stoppedByHold: false };
  try {
    const submitterId = submitterIdForRequest(req, res);
    while (true) {
      const ids = await store.listTombstoneCandidates!(before, retentionBatchSize);
      if (ids.length === 0) break;
      const result = await store.tombstone(ids, {
        reason: 'retention',
        rulesVersion: null,
        actor: AUDIT_API_ACTOR,
        submitterId,
        batchSize: retentionBatchSize,
        context: { cutoff: before },
      });
      total.tombstoned += result.tombstoned;
      total.skipped += result.skipped;
      total.batches += result.batches;
      total.auditEventIds.push(...result.auditEventIds);
      if (result.stoppedByHold) {
        total.stoppedByHold = true;
        break;
      }
      // Candidates are re-read after every page; a page that tombstoned nothing would loop forever.
      if (result.tombstoned === 0) break;
    }
    sendTombstoneResult(res, total);
  } catch (err) {
    console.error('[agent-viewer] /api/v1/audit/retention/purge failed:', err);
    res.status(500).json({ error: 'retention_purge_failed', message: 'The run failed; committed batches stay.', partial: total });
  } finally {
    auditDestructiveRunInFlight = false;
  }
});

/**
 * Tombstones explicitly named events (`reason: 'redaction'`), all or nothing per event: there is no field-level
 * redaction. Pattern-based selection is not implemented yet (see docs/redaction.md).
 */
app.post('/api/v1/audit/redact', async (req, res) => {
  if (refuseAuditMutation(res)) return;
  const body = isPlainObject(req.body) ? req.body : {};
  const eventIds = body.eventIds;
  const rulesVersion = body.rulesVersion;
  if (
    !Array.isArray(eventIds)
    || eventIds.length === 0
    || eventIds.length > retentionBatchSize
    || !eventIds.every((id) => typeof id === 'string' && id.length > 0)
    || (rulesVersion !== undefined && (typeof rulesVersion !== 'string' || rulesVersion === '' || rulesVersion.length > MAX_RULES_VERSION_LENGTH))
  ) {
    res.status(400).json({
      error: 'validation_failed',
      message: `Expected { eventIds: 1 to ${retentionBatchSize} non-empty strings, rulesVersion?: string up to ${MAX_RULES_VERSION_LENGTH} characters }`,
    });
    return;
  }
  if (await store.activeLegalHold!()) {
    legalHoldLocked(res);
    return;
  }
  if (auditDestructiveRunInFlight) {
    res.status(409).json({ error: 'run_in_progress', message: 'Another retention or redaction run is in progress.' });
    return;
  }
  auditDestructiveRunInFlight = true;
  try {
    const result = await store.tombstone(eventIds as string[], {
      reason: 'redaction',
      rulesVersion: (rulesVersion as string | undefined) ?? null,
      actor: AUDIT_API_ACTOR,
      submitterId: submitterIdForRequest(req, res),
      batchSize: retentionBatchSize,
    });
    sendTombstoneResult(res, result);
  } catch (err) {
    console.error('[agent-viewer] /api/v1/audit/redact failed:', err);
    res.status(500).json({ error: 'redaction_failed', message: 'The run failed; committed batches stay.' });
  } finally {
    auditDestructiveRunInFlight = false;
  }
});

// -------------------------------------------------------------
// Signed audit checkpoints (issue #387). Under `/api/v1`, so they share the rate limiter, query-token rejection,
// open-mode guard and Bearer auth registered above. Without a checkpoint service (memory storage, or a database
// opened against a migration list that stops before migration 22) every route answers `409 audit_unavailable`.
// -------------------------------------------------------------

/** `null` and already responded `409 audit_unavailable` when there is no checkpoint service. */
function requireAuditCheckpoints(res: express.Response): AuditCheckpointService | null {
  res.setHeader('Cache-Control', 'no-store');
  if (auditCheckpoints) return auditCheckpoints;
  const reason = store.getDatabaseHandle?.() ? 'schema_not_migrated' : 'memory_storage';
  res.status(409).json({ error: 'audit_unavailable', reason, message: 'Signed audit checkpoints require SQLite storage.' });
  return null;
}

const CHECKPOINT_PAGE_DEFAULT = 100;
const CHECKPOINT_PAGE_MAX = 1000;

function parseNonNegativeIntParam(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** `?afterSeq=<n>` (keyset cursor, default 0), `?limit=1..1000` (default 100), `?format=json|jsonl`. */
app.get('/api/v1/audit/checkpoints', (req, res) => {
  const service = requireAuditCheckpoints(res);
  if (!service) return;
  const afterSeq = req.query.afterSeq === undefined ? 0 : parseNonNegativeIntParam(req.query.afterSeq);
  const limit = req.query.limit === undefined ? CHECKPOINT_PAGE_DEFAULT : parseNonNegativeIntParam(req.query.limit);
  const format = req.query.format ?? 'json';
  if (afterSeq === null) {
    res.status(400).json({ error: 'validation_failed', message: 'afterSeq must be a non-negative integer' });
    return;
  }
  if (limit === null || limit < 1 || limit > CHECKPOINT_PAGE_MAX) {
    res.status(400).json({ error: 'validation_failed', message: `limit must be an integer from 1 to ${CHECKPOINT_PAGE_MAX}` });
    return;
  }
  if (format !== 'json' && format !== 'jsonl') {
    res.status(400).json({ error: 'validation_failed', message: 'format must be "json" or "jsonl"' });
    return;
  }
  const checkpoints = service.list(afterSeq, limit);
  const nextAfterSeq = checkpoints.length === limit ? checkpoints[checkpoints.length - 1].body.checkpointSeq : null;
  if (format === 'jsonl') {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    if (nextAfterSeq !== null) res.setHeader('X-Next-After-Seq', String(nextAfterSeq));
    res.send(checkpoints.map((checkpoint) => `${JSON.stringify(checkpoint)}\n`).join(''));
    return;
  }
  res.json({ checkpoints, nextAfterSeq });
});

app.get('/api/v1/audit/checkpoints/latest', (_req, res) => {
  const service = requireAuditCheckpoints(res);
  if (!service) return;
  const checkpoint = service.latest();
  if (!checkpoint) {
    res.status(404).json({ error: 'checkpoint_not_found', message: 'No signed checkpoint exists yet.' });
    return;
  }
  res.json({ checkpoint });
});

/** On-demand checkpoint (`reason: 'manual'`). `201` when one was signed; `200` with `created: false` when the
 * chain is empty or the head has not advanced since the latest checkpoint; `409` when signing was refused
 * (head behind the latest checkpoint, or this server's key is no longer the active one). */
app.post('/api/v1/audit/checkpoints', (_req, res) => {
  const service = requireAuditCheckpoints(res);
  if (!service) return;
  try {
    const result = service.createCheckpoint('manual');
    if (result.created) {
      res.status(201).json({ created: true, checkpoint: result.checkpoint });
      return;
    }
    if (result.skipped === 'head_behind_checkpoint' || result.skipped === 'key_not_active') {
      res.status(409).json({ error: 'checkpoint_refused', reason: result.skipped, message: 'The checkpoint was not signed; run GET /api/v1/audit/verify.' });
      return;
    }
    res.json({ created: false, reason: result.skipped, checkpoint: result.checkpoint });
  } catch (err) {
    console.error('[agent-viewer] POST /api/v1/audit/checkpoints failed:', err);
    res.status(503).json({ error: 'audit_checkpoint_failed', message: 'The checkpoint could not be written.' });
  }
});

/** Every public key that ever signed here (never a private key), oldest first; exactly one is `active`. */
app.get('/api/v1/audit/keys', (_req, res) => {
  const service = requireAuditCheckpoints(res);
  if (!service) return;
  res.json({ activeKeyId: service.key.keyId, keys: service.keys() });
});

// -------------------------------------------------------------
// Usage calls (issue #67): read-only, metadata-only listing of usage_ledger rows (#65), with the shared filters
// from `parseUsageFilters` (server/usage/filters.ts) and a stable, opaque cursor (server/usage/calls.ts). Never
// returns summary, payload, event_json, message text, tool input/output or a provider error message: the
// serializer (`toCallRecord`) is an explicit allow-list over an already-typed ledger row, never "event minus
// some keys". Sits under /api/v1, so it gets the same rate limit, query-token rejection and Bearer auth as
// every other route registered above.
app.get('/api/v1/usage/calls', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const parsed = parseUsageFilters(req.query as Record<string, unknown>, { allowCallsOnly: true });
  if (!parsed.ok) {
    res.status(400).json({ error: 'invalid_filter', issues: parsed.issues });
    return;
  }
  const { filters, order, limit, cursor } = parsed.value;

  let after: { seq: number } | undefined;
  if (cursor !== null) {
    const decoded = decodeCursor(cursor);
    if (!decoded.ok) {
      res.status(400).json({ error: 'invalid_cursor', message: 'The cursor could not be decoded.' });
      return;
    }
    const expectedFilterHash = filterHash(filters);
    if (decoded.cursor.o !== order || decoded.cursor.f !== expectedFilterHash) {
      res.status(400).json({
        error: 'cursor_mismatch',
        message: 'This cursor was issued for different filters or a different order. Changing only "limit" between pages is allowed.',
      });
      return;
    }
    if (decoded.cursor.e !== store.usageLedgerEpoch()) {
      res.status(410).json({
        error: 'cursor_expired',
        message: 'This cursor was issued before a store restart and can no longer be resolved. Restart the walk without a cursor.',
      });
      return;
    }
    after = { seq: decoded.cursor.s };
  }

  const page = await store.listCalls({ filters, order, limit, after });

  const epoch = store.usageLedgerEpoch();
  const hash = filterHash(filters);
  let nextCursor: string | null = null;
  if (page.lastSeq !== null && (order === 'asc' || page.hasMore)) {
    nextCursor = encodeCursor({ v: 1, e: epoch, s: page.lastSeq, o: order, f: hash });
  }

  if (page.hasMore && nextCursor) {
    const query = buildCallsLinkQueryString(filters, order, limit, nextCursor);
    res.setHeader('Link', `</api/v1/usage/calls?${query}>; rel="next"`);
  }

  res.json({
    schemaVersion: '1.0',
    asOf: Date.now(),
    storage: store.readiness().storage,
    data: page.rows,
    page: { limit, order, hasMore: page.hasMore, nextCursor },
    // Issue #295: which estimate revision every row's estimate fields above were read from.
    estimateBasis: filters.estimateBasis,
  });
});

// -------------------------------------------------------------
// Per-call revision history (issue #296, sub-issue of #84): every pricing-estimate revision of one ledger row,
// revision 0 (ingestion time) first, each with a component breakdown derived on read. SQLite-only, same as the
// recompute endpoints below: a store that does not implement it (memory mode) answers 501, never a silently
// different shape.
// -------------------------------------------------------------
app.get('/api/v1/usage/calls/:id/estimates', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (typeof store.getCallEstimates !== 'function') {
    res.status(501).json({ error: 'ledger_unavailable', message: 'The usage ledger is not available in this storage mode.' });
    return;
  }
  const result = await store.getCallEstimates(req.params.id);
  if (!result) {
    res.status(404).json({ error: 'call_not_found', message: `No call with id "${req.params.id}" exists.` });
    return;
  }
  res.json({ schemaVersion: '1.0', eventId: result.eventId, revisions: result.revisions });
});

/** `limit` for GET /api/v1/admin/retention: an integer from 1 to 200, default 20. Unlike `clampedLimit` above,
 * an invalid value is a 400, not a silent fallback: this is an audit endpoint, and a typo here should be visible
 * rather than quietly answering with the wrong amount of history. */
function parseRetentionLimit(raw: unknown): number | 'invalid' {
  if (raw === undefined) return 20;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return 'invalid';
  const value = Number(raw);
  return value >= 1 && value <= 200 ? value : 'invalid';
}

// Read-only retention admin surface (issue #70): same auth and rate limit as every /api/v1 route, no endpoint to
// trigger a purge or change a window. `windowDays`/`policy` come straight from the config parsed once at startup
// (`retentionConfig`); everything else (counts, coverage, run history) comes from the store, so this route runs
// no SQL of its own.
app.get('/api/v1/admin/retention', async (req, res) => {
  const limit = parseRetentionLimit(req.query.limit);
  if (limit === 'invalid') {
    res.status(400).json({ error: 'invalid_limit', message: 'limit must be an integer from 1 to 200' });
    return;
  }
  const status = await store.retentionStatus(limit);
  const readiness = store.readiness();
  const totals = retentionJob.totals();
  res.json({
    schemaVersion: '1.0',
    storage: readiness.storage,
    now: Date.now(),
    intervalMinutes: retentionConfig.intervalMinutes,
    events: {
      windowDays: retentionConfig.eventsDays,
      policy: retentionConfig.eventsDays === null ? 'keep' : 'purge',
      ...status.events,
      totalDeletedSinceStart: totals.events,
    },
    usageLedger: {
      windowDays: retentionConfig.ledgerDays,
      policy: retentionConfig.ledgerDays === null ? 'keep' : 'purge',
      ...status.usageLedger,
      totalDeletedSinceStart: totals.usageLedger,
    },
    lastRun: status.lastRun,
    runs: status.runs,
  });
});

// Grouped sums over the usage ledger (issue #66): the auditable read API, built for "how much did agent X spend
// with model Y this week". Read only, never writes to the ledger. `Cache-Control: no-store` because the answer
// is only ever as fresh as this one request's read transaction.
app.get('/api/v1/usage/rollup', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  let query;
  try {
    query = parseRollupQuery(req.query as Record<string, unknown>);
  } catch (error) {
    if (error instanceof UsageFilterError) {
      res.status(400).json({ error: 'invalid_filter', issues: error.issues });
      return;
    }
    throw error;
  }
  res.json(await store.rollup(query));
});

// -------------------------------------------------------------
// Usage export (issue #69): CSV/JSONL streaming export of the usage ledger, redacted, plus its totals sidecar.
// Both routes sit under /api/v1, so they already get the rate limiter, the query-token rejection, the no-token
// loopback/Host/Origin guard and the Bearer auth every other /api/v1 route gets (issue #71's `openModeGuard`
// already implements, generically, exactly the access rule section 4 of #69 asks the export routes to add: no
// token configured -> loopback peer, loopback Host header, no cross-origin Origin, else 403). The one guard #69
// asks for that nothing upstream already provides is the per-process export concurrency cap, added here.
// -------------------------------------------------------------

/** Headers a cross-origin portal must be able to read (issue #69: today only Allow-Headers/Allow-Methods are
 * exposed, `server/index.ts`'s CORS middleware above). Set directly on these two routes rather than widening the
 * shared CORS middleware, which every other /api/v1 route would otherwise also start exposing these headers on. */
const EXPORT_EXPOSE_HEADERS = [
  'Content-Disposition',
  'X-Agent-Viewer-Export-Schema',
  'X-Agent-Viewer-Export-Id',
  'X-Agent-Viewer-As-Of-Seq',
  'X-Agent-Viewer-Row-Count',
  'X-Agent-Viewer-Estimate-Basis',
].join(', ');

function exportQueryErrorResponse(res: express.Response, error: ExportQueryError): void {
  if (error.code === 'invalid_format') {
    res.status(400).json({ error: 'invalid_format' });
    return;
  }
  if (error.code === 'unsupported_parameter') {
    res.status(400).json({ error: 'unsupported_parameter', parameters: (error.detail as { parameters: string[] }).parameters });
    return;
  }
  res.status(400).json({ error: 'invalid_filter', issues: (error.detail as { issues: { path: string; message: string }[] }).issues });
}

/**
 * One rollup call (issue #66), grouped by a throwaway single dimension whose groups are never read, gives the
 * export route and the totals sidecar everything they need from one read-consistent snapshot: the resolved,
 * clamped `asOfSeq` (`asOf.ledgerSeq`), the pre-stream row count (`totals.calls.total`, used for both the
 * `X-Agent-Viewer-Row-Count` header and the `422` guard) and the coverage signal (`complete`/`droppedRows`/
 * `purgedThrough`) the totals sidecar's `complete`/`incompleteReason` come from. Calling `store.rollup()` instead
 * of summing the matching rows a second time is exactly issue #69's own instruction for the totals sidecar.
 */
const EXPORT_SCOPE_GROUP_BY: RollupQuery['groupBy'] = ['agent'];

async function resolveExportScope(filters: UsageFilters) {
  // Issue #89: the export route never needs `latency`/`failures` (it reads only `asOf`/`totals.calls`/
  // `coverage`), so `include` stays empty here, same as every other caller that predates that issue.
  return store.rollup({ groupBy: EXPORT_SCOPE_GROUP_BY, filters, sort: 'key', limit: 1, include: [] });
}

let activeExports = 0;

app.get('/api/v1/usage/export', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Expose-Headers', EXPORT_EXPOSE_HEADERS);

  let query: ReturnType<typeof parseExportQuery>;
  try {
    query = parseExportQuery(req.query as Record<string, unknown>);
  } catch (error) {
    if (error instanceof ExportQueryError) {
      exportQueryErrorResponse(res, error);
      return;
    }
    throw error;
  }

  if (activeExports >= getExportConcurrencyMax()) {
    res.setHeader('Retry-After', '5');
    res.status(429).json({ error: 'export_busy' });
    return;
  }

  const scope = await resolveExportScope(query.filters);
  const rowCount = scope.totals.calls.total;
  const maxRows = getExportMaxRows();
  if (rowCount > maxRows) {
    res.status(422).json({ error: 'export_too_large', rowCount, maxRows });
    return;
  }

  activeExports++;
  let released = false;
  const releaseSlot = () => {
    if (!released) {
      released = true;
      activeExports--;
    }
  };
  res.on('close', releaseSlot);
  res.on('finish', releaseSlot);

  try {
    // 0 when the ledger is empty: `iterateExportRows` with asOfSeq 0 correctly yields no rows on both backends
    // (real seqs start at 1), so this needs no special-cased empty-ledger branch below.
    const asOfSeq = scope.asOf.ledgerSeq ?? 0;
    const exportId = `exp_${crypto.randomUUID()}`;
    const filename = buildExportFilename(query.filters, asOfSeq, query.format);

    res.status(200);
    res.setHeader('Content-Type', query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Agent-Viewer-Export-Schema', EXPORT_SCHEMA);
    res.setHeader('X-Agent-Viewer-Export-Id', exportId);
    res.setHeader('X-Agent-Viewer-As-Of-Seq', String(asOfSeq));
    res.setHeader('X-Agent-Viewer-Row-Count', String(rowCount));
    // Issue #295: CSV has no per-request metadata record (unlike JSONL's trailing "summary" line below), so the
    // estimate basis this export resolved against is echoed as a header instead, same tier as the headers above.
    res.setHeader('X-Agent-Viewer-Estimate-Basis', JSON.stringify(scope.estimateBasis));

    let aborted = false;
    req.on('close', () => {
      aborted = true;
    });

    async function writeChunk(chunk: string): Promise<void> {
      if (res.destroyed || res.writableEnded) return;
      const canContinue = res.write(chunk);
      if (!canContinue) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }

    if (query.bom && query.format === 'csv') await writeChunk('﻿');
    if (query.format === 'csv') await writeChunk(`${CSV_HEADER}\r\n`);

    const filtersAtAsOf: UsageFilters = { ...query.filters, asOfSeq };
    let written = 0;
    try {
      for await (const row of store.iterateExportRows(filtersAtAsOf, asOfSeq)) {
        if (aborted || res.destroyed) break;
        const record = toExportCallRecord(row);
        await writeChunk(query.format === 'csv' ? formatCsvRow(record) : `${formatJsonlRow(record)}\n`);
        written++;
      }
    } catch (streamError) {
      if (query.format === 'jsonl' && !res.destroyed && !res.writableEnded) {
        try {
          res.write('{"record":"error","code":"export_aborted"}\n');
        } catch {
          // The socket is already gone; destroying it below is enough.
        }
      }
      console.error('[agent-viewer] usage export failed mid-stream', streamError);
      res.destroy();
      return;
    }

    // A client that disconnected mid-stream never gets a summary line: the socket is already closing, and
    // writing to it now would either throw or silently vanish.
    if (aborted || res.destroyed || res.writableEnded) return;

    if (query.format === 'jsonl') {
      const totals = shapeExportTotals(scope, query.filters);
      const summary = {
        record: 'summary' as const,
        schema: EXPORT_SCHEMA,
        exportId,
        generatedAt: new Date().toISOString(),
        asOfSeq,
        afterSeq: query.filters.afterSeq,
        filters: totals.filters,
        rowCount: written,
        complete: totals.complete,
        ...(totals.incompleteReason ? { incompleteReason: totals.incompleteReason } : {}),
        estimateBasis: totals.estimateBasis,
        totals: {
          cost: totals.cost,
          tokens: totals.tokens,
          byStatus: totals.byStatus,
          estimated: totals.estimated,
          estimatedUnknownCalls: totals.estimatedUnknownCalls,
          estimatedUnknownByStatus: totals.estimatedUnknownByStatus,
          estimatedComplete: totals.estimatedComplete,
          comparable: totals.comparable,
        },
      };
      await writeChunk(`${JSON.stringify(summary)}\n`);
    }
    res.end();
  } finally {
    releaseSlot();
  }
});

// Totals sidecar (issue #69): the per-currency reconciliation numbers CSV cannot carry as a footer row without
// breaking `pandas.read_csv`/`COPY FROM`. Never counts against AGENT_VIEWER_EXPORT_CONCURRENCY: a single read
// transaction, not a long-running stream.
app.get('/api/v1/usage/export/totals', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Expose-Headers', EXPORT_EXPOSE_HEADERS);

  let filters: UsageFilters;
  try {
    filters = parseExportTotalsQuery(req.query as Record<string, unknown>);
  } catch (error) {
    if (error instanceof ExportQueryError) {
      exportQueryErrorResponse(res, error);
      return;
    }
    throw error;
  }

  const scope = await resolveExportScope(filters);
  const asOfSeq = scope.asOf.ledgerSeq ?? 0;
  const totals = shapeExportTotals(scope, filters);

  res.setHeader('X-Agent-Viewer-Export-Schema', EXPORT_SCHEMA);
  res.setHeader('X-Agent-Viewer-As-Of-Seq', String(asOfSeq));
  res.setHeader('X-Agent-Viewer-Row-Count', String(totals.rowCount));
  res.json(totals);
});

// OTLP/HTTP logs receiver counters (issue #59). Per-process, reset on restart like store.ingestionCounters().
// Holds no token or cost sums: this is a shape/volume view of what the route did, never a usage figure.
app.get('/api/v1/otlp/stats', (_req, res) => {
  const unknownEventNames: Record<string, number> = {};
  for (const [name, count] of otlpStats.unknownEventNames) {
    unknownEventNames[`claude_code.${name}`] = count;
  }
  res.json({
    since: otlpStats.since,
    requests: { accepted: otlpStats.requestsAccepted, rejected: otlpStats.requestsRejected },
    logRecords: {
      received: otlpStats.logRecordsReceived,
      mapped: otlpStats.logRecordsMapped,
      duplicates: otlpStats.logRecordsDuplicates,
      ignored: otlpStats.logRecordsIgnored,
      unknown: otlpStats.logRecordsUnknown,
      unattributed: otlpStats.logRecordsUnattributed,
      invalid: otlpStats.logRecordsInvalid,
    },
    mappedByType: { ...otlpStats.mappedByType },
    unknownEventNames,
  });
});

/** `limit` on a list endpoint: default 100, clamped to 1..1000. A non-numeric value falls back to the default. */
function clampedLimit(raw: unknown, fallback: number, max: number): number {
  const value = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/**
 * Builds the query string of the `Link: rel="next"` header for `GET /api/v1/usage/calls` (issue #67): the
 * request's own filters plus `order`, `limit` and the new cursor, rebuilt from the already-validated filter
 * object rather than echoed from `req.query`, so it can never carry `token`, `api_key`, an unknown parameter or
 * a value in a shape the parser would have rejected. The caller turns this into a relative reference (never
 * built from the `Host` header), per the issue's own rule.
 */
function buildCallsLinkQueryString(filters: UsageFilters, order: 'desc' | 'asc', limit: number, cursor: string): string {
  const params = new URLSearchParams();
  if (filters.from !== null) params.set('from', String(filters.from));
  if (filters.to !== null) params.set('to', String(filters.to));
  if (filters.timeBasis !== 'received') params.set('timeBasis', filters.timeBasis);
  for (const value of filters.agentId) params.append('agentId', value);
  for (const value of filters.sessionId) params.append('sessionId', value);
  for (const value of filters.runtimeId) params.append('runtimeId', value);
  for (const value of filters.taskId) params.append('taskId', value);
  for (const value of filters.provider) params.append('provider', value);
  for (const value of filters.model) params.append('model', value);
  for (const value of filters.status) params.append('status', value);
  for (const value of filters.costSource) params.append('costSource', value);
  for (const value of filters.currency) params.append('currency', value);
  for (const value of filters.requestId) params.append('requestId', value);
  if (filters.traceId !== null) params.set('traceId', filters.traceId);
  params.set('order', order);
  params.set('limit', String(limit));
  params.set('cursor', cursor);
  return params.toString();
}

// Audit view of request-id duplicate references (issue #48): same auth and rate limit as every /api/v1 route,
// and the same payload shape as GET /api/v1/events, so it exposes nothing new to a token holder.
app.get('/api/v1/usage/duplicates', async (req, res) => {
  const limit = clampedLimit(req.query.limit, 100, 1000);
  const provider = typeof req.query.provider === 'string' ? req.query.provider : undefined;
  const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : undefined;
  const duplicateOf = typeof req.query.duplicateOf === 'string' ? req.query.duplicateOf : undefined;

  const duplicates = await store.listDuplicates({ limit, provider, requestId, duplicateOf });
  res.json({
    schemaVersion: '1.0',
    count: duplicates.length,
    duplicates,
  });
});

/**
 * Issues a single-use stream ticket (issue #71). Requires a Bearer token: a ticket cannot mint tickets, since
 * `requireApiToken`'s ticket branch only ever applies to `GET /events/stream`. Empty body or `{}`; any other
 * field is rejected so a later `scope` field (#108) can be added without ambiguity about old clients.
 */
const StreamTicketRequestSchema = z.object({}).strict();

app.post('/api/v1/stream-tickets', (req, res) => {
  const parsed = StreamTicketRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'validation_failed' });
    return;
  }
  const result = streamTicketStore.issue();
  res.setHeader('Cache-Control', 'no-store');
  if (!result.ok) {
    res.status(429).json({ error: 'stream_ticket_limit' });
    return;
  }
  res.status(201).json({
    ticket: result.ticket,
    expiresAt: new Date(result.expiresAt).toISOString(),
    ttlMs: result.ttlMs,
    streamPath: `/api/v1/events/stream?ticket=${result.ticket}`,
  });
});

// -------------------------------------------------------------
// Realtime Stream (SSE)
// -------------------------------------------------------------
/** Resolves once `res` drains or `timeoutMs` elapses; resolves early (as "not drained") if `res` closes first. */
function waitForDrain(res: express.Response, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(drained);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

app.get('/api/v1/events/stream', async (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;

  // Registered before any await (issue #54), so a client that disconnects during a longer replay never leaks in
  // `clients` and the heartbeat timer is always cleared. The heartbeat itself still carries retention (issue
  // #53), read fresh on every tick.
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    store.retention().then(
      (retention) => {
        try {
          res.write(`: heartbeat\nevent: heartbeat\ndata: ${JSON.stringify({ retention })}\n\n`);
        } catch {
          // client disconnected
        }
      },
      () => {
        try {
          res.write(': heartbeat\nevent: heartbeat\ndata: {}\n\n');
        } catch {
          // client disconnected
        }
      }
    );
  }, 15000);
  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    clients.delete(res);
    replayBuffers.delete(res);
  });

  /**
   * Writes ": connected" and the first heartbeat atomically (issue #53), so a client knows the retention state as
   * soon as it connects and no live event can land between the two frames. Called right after the reconnect
   * replay or resync frame (issue #54), so existing clients and tests keep seeing "connected" at that point.
   */
  async function sendConnectedFrame(): Promise<void> {
    let initialRetentionData = '{}';
    try {
      initialRetentionData = JSON.stringify({ retention: await store.retention() });
    } catch {
      // Keep the empty-payload fallback; the client watchdog only needs a frame to arrive, not its content.
    }
    if (closed) return;
    try {
      res.write(`: connected\n\n: heartbeat\nevent: heartbeat\ndata: ${initialRetentionData}\n\n`);
    } catch {
      clients.delete(res);
    }
  }

  const lastEventId = req.header('last-event-id') || (typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined);

  if (!lastEventId) {
    // No cursor: today's first-connection behavior, unchanged.
    clients.add(res);
    await sendConnectedFrame();
    return;
  }

  /** Writes a `resync` frame and counts it (issue #54). */
  function sendResync(reason: 'cursor_unknown' | 'gap_too_large' | 'buffer_overflow', missed: number | null) {
    sseCounters.resyncsSinceStart++;
    try {
      res.write(
        `event: resync\ndata: ${JSON.stringify({
          schemaVersion: '1.0',
          reason,
          cursor: lastEventId,
          missed,
          replayMax: sseReplayMax,
          snapshotPath: '/api/v1/snapshot',
        })}\n\n`
      );
    } catch {
      clients.delete(res);
    }
  }

  /** Flushes the buffered live frames (if any) accumulated during the replay, then sends "connected". */
  async function goLive(): Promise<void> {
    const replay = replayBuffers.get(res);
    replayBuffers.delete(res);
    if (closed) return;
    if (replay) {
      for (const { frame } of replay.buffer) {
        try {
          res.write(frame);
        } catch {
          clients.delete(res);
          return;
        }
      }
    }
    await sendConnectedFrame();
  }

  // The connection is added to `clients` (so `/health` counts it right away) in a "replaying" state before any
  // await: `broadcastEvent` queues live frames for it instead of writing them, so nothing stored after the
  // replay query and broadcast before `goLive()` is ever lost (issue #54).
  clients.add(res);
  replayBuffers.set(res, { buffer: [], overflowed: false });

  const resolvedCursorSeq = await store.resolveCursor(lastEventId);
  if (closed) return;
  if (resolvedCursorSeq === null) {
    // No event frames are replayed, but `goLive()` still flushes whatever was buffered during the `await`
    // above, so a live event broadcast while the cursor lookup was pending is never lost.
    sendResync('cursor_unknown', null);
    await goLive();
    return;
  }
  // Narrowed to a plain `const` so the closures below can use it without `null` in its type.
  const cursorSeq: EventSeq = resolvedCursorSeq;

  /** Reads the buffer-overflow flag and, if set, discards the buffer and resyncs instead of flushing it. */
  async function bailOnOverflow(): Promise<boolean> {
    const replay = replayBuffers.get(res);
    if (!replay?.overflowed) return false;
    replayBuffers.delete(res);
    const headNow = (await store.headSeq()) ?? cursorSeq;
    const missedNow = await store.countBetween(cursorSeq, headNow);
    sendResync('buffer_overflow', missedNow);
    return true;
  }

  const head = (await store.headSeq()) ?? cursorSeq;
  if (closed) return;
  const missed = await store.countBetween(cursorSeq, head);
  if (closed) return;

  if (missed > sseReplayMax) {
    // Same as above: no event frames from the gap, but the live buffer accumulated so far is still flushed.
    sendResync('gap_too_large', missed);
    await goLive();
    return;
  }

  let replayedCount = 0;
  let lastReplayedId: string | null = null;
  let cursorPos = cursorSeq;
  while (cursorPos < head) {
    if (await bailOnOverflow()) return;
    const page = await store.listBetween(cursorPos, head, sseReplayPageSize);
    if (closed) return;
    if (page.length === 0) break;
    for (const { seq, event } of page) {
      if (await bailOnOverflow()) return;
      const frame = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
      let ok: boolean;
      try {
        ok = res.write(frame);
      } catch {
        clients.delete(res);
        replayBuffers.delete(res);
        return;
      }
      replayedCount++;
      lastReplayedId = event.id;
      cursorPos = seq;
      if (!ok) {
        const drained = await waitForDrain(res, sseDrainTimeoutMs);
        if (closed) return;
        if (!drained) {
          replayBuffers.delete(res);
          res.destroy();
          return;
        }
      }
    }
  }

  if (await bailOnOverflow()) return;
  sseCounters.replaysSinceStart++;
  sseCounters.eventsReplayedSinceStart += replayedCount;
  try {
    res.write(
      `event: replayed\ndata: ${JSON.stringify({
        schemaVersion: '1.0',
        cursor: lastEventId,
        replayed: replayedCount,
        lastEventId: lastReplayedId,
      })}\n\n`
    );
  } catch {
    clients.delete(res);
  }
  await goLive();
});

// -------------------------------------------------------------
// Agent Management
// -------------------------------------------------------------
app.post('/api/v1/agents', requireReady, async (req, res) => {
  const { id, name, roleTitle, role, provider, model, workspace, status, statusText } = req.body ?? {};
  if (!id || typeof id !== 'string' || !name || typeof name !== 'string') {
    res.status(400).json({ error: 'validation_failed', message: 'Fields "id" and "name" are required' });
    return;
  }

  // Every default this route would once have passed straight to `store.upsertAgent` now goes into the event
  // payload instead (issue #52): the record below is read back from `ServerState` after the event is applied,
  // the same state a startup rebuild reaches by replaying this same event.
  const resolvedStatus = typeof status === 'string' && status.trim() ? status.trim().toUpperCase() : 'IDLE';
  const regEvent: CanonicalEvent = {
    schemaVersion: '1.0',
    id: serverEventId('reg'),
    type: 'agent.registered',
    timestamp: Date.now(),
    source: `agent:${id}`,
    agentId: id,
    severity: 'normal',
    summary: `Registered ${name}`,
    payload: {
      id,
      name,
      roleTitle: roleTitle || 'AI Agent',
      role: role || 'custom',
      provider: provider || 'Custom',
      model: model || 'Custom',
      workspace: workspace || 'development',
      status: resolvedStatus,
      statusText: statusText || 'Registered',
    },
  };

  if (!(await appendServerEvent(regEvent, req, res))) return;

  res.status(201).json(await store.getAgent(id));
});

app.patch('/api/v1/agents/:agentId', requireReady, async (req, res) => {
  const agentId = req.params.agentId;

  // Checked before the existence lookup: `resolveEventAgentId` (issue #52's reducer, `serverState.ts`) never
  // files these ids under an agent in the first place, so one would otherwise see 404 here instead of the
  // dedicated reserved-id error.
  if (agentId === 'system' || agentId === 'external-runtime' || agentId.startsWith('runtime:')) {
    res.status(400).json({
      error: 'validation_failed',
      message: `Agent "${agentId}" is reserved and cannot be updated through PATCH`,
      issues: [{
        path: 'agentId',
        code: 'reserved_agent_id',
        message: 'Reserved agent ids cannot be updated through PATCH',
      }],
    });
    return;
  }

  const existing = await store.getAgent(agentId);
  if (!existing) {
    res.status(404).json({ error: 'agent_not_found', message: `Agent "${agentId}" not found` });
    return;
  }

  const body: unknown = req.body ?? {};
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    res.status(400).json({ error: 'validation_failed', message: 'Request body must be a JSON object' });
    return;
  }

  const changes = body as Record<string, unknown>;
  const issues: Array<{ path: string; code: string; message: string }> = [];
  const profilePayload: Record<string, string> = {};
  const statusPayload: Record<string, string> = {};
  let status: AgentStatus | undefined;
  let hasAllowedField = false;

  for (const key of Object.keys(changes)) {
    if (key === 'id') continue;
    if (PATCH_USAGE_FIELDS.has(key)) {
      const codeMessage =
        key === 'cost' || key === 'currency' || key === 'costSource'
          ? 'Report cost with an llm.usage event.'
          : key === 'latencyMs' || key === 'usage'
            ? 'Report usage with an llm.usage event.'
            : 'Report tokens with an llm.usage event.';
      issues.push({ path: key, code: 'usage_not_patchable', message: codeMessage });
      continue;
    }
    if (PATCH_READ_ONLY_FIELDS.has(key)) {
      issues.push({ path: key, code: 'read_only_field', message: 'This field is managed by the server.' });
      continue;
    }
    if (!PATCH_ALLOWED_FIELDS.has(key)) {
      issues.push({ path: key, code: 'unknown_field', message: 'This field is not patchable.' });
      continue;
    }

    hasAllowedField = true;
    const value = changes[key];
    if (key === 'status') {
      const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
      if (!AGENT_STATUS_SET.has(normalized)) {
        const message = `Invalid status "${String(value).slice(0, 100)}". Expected one of: ${AGENT_STATUSES.join(', ')}`;
        issues.push({ path: 'status', code: 'invalid_status', message });
      } else {
        status = normalized as AgentStatus;
        statusPayload.status = status;
      }
      continue;
    }

    if (typeof value !== 'string') {
      issues.push({ path: key, code: 'invalid_type', message: 'Expected a string.' });
      continue;
    }
    const normalized = value.trim();
    const maxLength = key === 'statusText' ? 1000 : 200;
    if (normalized.length > maxLength || (key !== 'statusText' && normalized.length === 0)) {
      issues.push({
        path: key,
        code: 'invalid_type',
        message: key === 'statusText' ? 'Expected a string of at most 1000 characters.' : 'Expected a non-empty string of at most 200 characters.',
      });
      continue;
    }

    if (key === 'statusText' || key === 'workspace') statusPayload[key] = normalized;
    else profilePayload[key] = normalized;
  }

  if (!hasAllowedField) {
    issues.push({ path: '', code: 'empty_patch', message: 'At least one patchable field is required.' });
  }

  if (issues.length > 0) {
    const usageIssue = issues.find((issue) => issue.code === 'usage_not_patchable');
    res.status(400).json({
      error: 'validation_failed',
      message: usageIssue ? PATCH_USAGE_MESSAGE : issues[0].message,
      issues,
    });
    return;
  }

  if (status) {
    const statusEventTimestamp = Date.now();
    if (Object.keys(profilePayload).length > 0) {
      const updatedEvent: CanonicalEvent = {
        schemaVersion: '1.0',
        id: serverEventId('upd'),
        type: 'agent.updated',
        timestamp: statusEventTimestamp,
        source: `agent:${agentId}`,
        agentId,
        severity: 'normal',
        summary: `${agentId} profile updated`,
        payload: profilePayload,
      };
      if (!(await appendServerEvent(updatedEvent, req, res))) return;
    }

    const statusEvent: CanonicalEvent = {
      schemaVersion: '1.0',
      id: serverEventId('status'),
      type: 'agent.status.changed',
      timestamp: statusEventTimestamp,
      source: `agent:${agentId}`,
      agentId,
      severity: 'normal',
      summary: `${agentId} status updated to ${status}`,
      payload: statusPayload,
    };
    if (!(await appendServerEvent(statusEvent, req, res))) return;
  } else {
    const updatedEvent: CanonicalEvent = {
      schemaVersion: '1.0',
      id: serverEventId('upd'),
      type: 'agent.updated',
      timestamp: Date.now(),
      source: `agent:${agentId}`,
      agentId,
      severity: 'normal',
      summary: `${agentId} profile updated`,
      payload: { ...profilePayload, ...statusPayload },
    };
    if (!(await appendServerEvent(updatedEvent, req, res))) return;
  }

  res.json(await store.getAgent(agentId));
});

// -------------------------------------------------------------
// Runtimes & Sessions
// -------------------------------------------------------------
app.post('/api/v1/runtimes', requireReady, async (req, res) => {
  const { id, name, framework, version, metadata } = req.body ?? {};
  if (!id || typeof id !== 'string') {
    res.status(400).json({ error: 'validation_failed', message: 'Field "id" is required' });
    return;
  }

  // The route resolves the 'custom' default itself and puts it in the event payload (issue #52), so the reducer
  // never has to guess a runtime's framework from an event it only auto-created: `runtime.connected` always
  // carries every field it sets, for a new runtime and for one that already exists.
  const resolvedFramework = typeof framework === 'string' && framework.trim() ? framework.trim() : 'custom';
  const event: CanonicalEvent = {
    schemaVersion: '1.0',
    id: serverEventId('rt'),
    type: 'runtime.connected',
    timestamp: Date.now(),
    runtimeId: id,
    source: `runtime:${id}`,
    severity: 'normal',
    summary: `Runtime ${id} connected`,
    payload: { id, name, framework: resolvedFramework, version, metadata },
  };
  if (!(await appendServerEvent(event, req, res))) return;

  const runtime = (await store.listRuntimes()).find((r) => r.id === id) ?? null;
  res.status(201).json(runtime);
});

app.get('/api/v1/runtimes', requireReady, async (_req, res) => {
  const runtimes = await store.listRuntimes();
  res.json({ runtimes });
});

app.get('/api/v1/sessions', requireReady, async (_req, res) => {
  const sessions = await store.listSessions();
  res.json({ sessions });
});

app.get('/api/v1/sessions/:sessionId', requireReady, async (req, res) => {
  const session = await store.getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session_not_found', message: `Session ${req.params.sessionId} not found` });
    return;
  }
  const events = await store.list({ sessionId: req.params.sessionId, limit: 1000 });
  res.json({ session, events });
});

// -------------------------------------------------------------
// Generic Webhook with optional HMAC & replay protection
// -------------------------------------------------------------
const GenericWebhookPayloadSchema = z.object({
  agent: z.string().max(200).optional(),
  agentId: z.string().max(200).optional(),
  status: z.string().max(100).optional(),
  statusText: z.string().max(500).optional(),
  message: z.string().max(5000).optional(),
  text: z.string().max(5000).optional(),
  tool: z.string().max(200).optional(),
  timestamp: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
  usage: LlmUsagePayloadSchema.optional(),
});

/** Signatures already accepted, mapped to the time after which their timestamp is outside the window anyway. */
const seenWebhookSignatures = new Map<string, { expiresAt: number; eventIds: string[] }>();

/**
 * Records a verified signature after successful store acceptance.
 * Returns the stored event IDs if the same signature was already accepted, or null if this is new.
 */
function rememberWebhookSignature(signature: string, expiresAt: number, now: number, eventIds: string[]): string[] | null {
  const seen = seenWebhookSignatures.get(signature);
  if (seen !== undefined && seen.expiresAt > now) {
    return seen.eventIds; // Duplicate: return the cached ids
  }

  if (seenWebhookSignatures.size >= webhookReplayCacheMax) {
    for (const [key, value] of seenWebhookSignatures) {
      if (value.expiresAt <= now) seenWebhookSignatures.delete(key);
    }
    // Still full: evict the oldest entries. Only verified signatures get here, so filling it needs the secret.
    for (const key of seenWebhookSignatures.keys()) {
      if (seenWebhookSignatures.size < webhookReplayCacheMax) break;
      seenWebhookSignatures.delete(key);
    }
  }

  seenWebhookSignatures.set(signature, { expiresAt, eventIds });
  return null; // New: not a duplicate
}

app.post('/api/v1/webhooks/generic', async (req, res) => {
  const secret = process.env.AGENT_VIEWER_WEBHOOK_SECRET;
  const now = Date.now();
  let verifiedSignature: string | null = null;
  let idempotencySource: 'body' | 'header' | 'signature' | 'requestId' | 'none' | null = null;
  let idempotencyKey = '';

  // Step 1: Verify HMAC signature if a secret is configured
  if (secret) {
    const signature = req.header('x-agent-viewer-signature');
    const timestampStr = req.header('x-agent-viewer-timestamp');

    if (!signature || !timestampStr) {
      markRejection(res, 'signature');
      res.status(401).json({
        error: 'missing_webhook_signature',
        message: 'Headers X-Agent-Viewer-Signature and X-Agent-Viewer-Timestamp required',
      });
      return;
    }

    const timestamp = Number(timestampStr);
    // Replay protection, part 1: the timestamp must be within 5 minutes
    if (isNaN(timestamp) || Math.abs(now - timestamp) > webhookToleranceMs) {
      markRejection(res, 'replay');
      res.status(401).json({
        error: 'replay_detected_or_clock_skew',
        message: 'Webhook timestamp is expired or too far in the future',
      });
      return;
    }

    const rawBody = (req as any).rawBody?.toString('utf-8') ?? JSON.stringify(req.body ?? {});
    const expected = crypto.createHmac('sha256', secret).update(`${timestampStr}.${rawBody}`).digest('hex');

    if (!safeEqual(signature, expected)) {
      markRejection(res, 'signature');
      res.status(401).json({
        error: 'invalid_webhook_signature',
        message: 'HMAC signature verification failed',
      });
      return;
    }

    verifiedSignature = expected;
  }

  // Issue #107: this route bypasses the normal `requireApiToken` middleware when a webhook secret is configured
  // (`webhookBypass`), so `res.locals.submitter` is never set for it in that case; HMAC (already verified above
  // when `secret` is set) is the actual credential. An optional Bearer value is still resolved, but only for
  // attribution: a valid, active named key names the submitter, and anything else (missing, malformed, unknown,
  // wrong secret, the bootstrap token, revoked, expired) is the generic `'webhook'`, never surfaced as an auth
  // failure on a request that already authenticated via its signature. With no webhook secret configured, the
  // webhook needs a normal Bearer credential like every other route (`requireApiToken` already ran it).
  const submitterId = secret
    ? (() => {
        const resolution = resolveAuth(req);
        // Issue #108: only a key that could have ingested this itself may claim the attribution.
        return resolution.ok && resolution.submitter.kind === 'key' && resolution.principal.effective.has('ingest')
          ? resolution.submitter.id
          : 'webhook';
      })()
    : submitterIdForRequest(req, res);

  // Step 2: Parse and validate the webhook payload
  const parseResult = GenericWebhookPayloadSchema.safeParse(req.body ?? {});
  if (!parseResult.success) {
    markRejection(res, 'validation');
    res.status(400).json({
      error: 'validation_failed',
      message: 'Invalid webhook payload structure',
      issues: parseResult.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }

  const payload = parseResult.data;
  if (!payload.status && !payload.message && !payload.text && !payload.tool && !payload.usage) {
    markRejection(res, 'unrecognized_payload');
    res.status(400).json({
      error: 'unrecognized_webhook_payload',
      message:
        'Webhook payload does not describe any agent activity. Include at least one of "status", "message", "text", "tool" or "usage"',
    });
    return;
  }

  // Step 3: Determine the idempotency key from multiple sources
  const headerKey = req.header('idempotency-key')?.trim();
  const bodyKey = payload.idempotencyKey?.trim();

  if (bodyKey && !bodyKey.match(/^[\x20-\x7E]+$/)) {
    markRejection(res, 'validation');
    res.status(400).json({
      error: 'invalid_idempotency_key',
      message: 'idempotencyKey must be 1-255 printable ASCII characters',
    });
    return;
  }

  if (headerKey && !headerKey.match(/^[\x20-\x7E]+$/)) {
    markRejection(res, 'validation');
    res.status(400).json({
      error: 'invalid_idempotency_key',
      message: 'Idempotency-Key header must be 1-255 printable ASCII characters',
    });
    return;
  }

  // Determine delivery key in priority order
  if (bodyKey) {
    idempotencyKey = bodyKey;
    idempotencySource = 'body';
  } else if (headerKey && !secret) {
    // Header is ignored when a secret is set
    idempotencyKey = headerKey;
    idempotencySource = 'header';
  } else if (verifiedSignature) {
    idempotencyKey = verifiedSignature;
    idempotencySource = 'signature';
  } else if (payload.usage?.requestId) {
    idempotencyKey = payload.usage.requestId;
    idempotencySource = 'requestId';
  } else {
    idempotencySource = 'none';
  }

  if (headerKey && bodyKey && headerKey !== bodyKey && !secret) {
    markRejection(res, 'validation');
    res.status(400).json({
      error: 'idempotency_key_mismatch',
      message: 'Idempotency-Key header and idempotencyKey body field differ',
    });
    return;
  }

  // Step 4: Build canonical events
  const agentName = payload.agent || payload.agentId || 'generic-agent';
  const status = payload.status || (payload.message || payload.text ? 'THINKING' : 'IDLE');
  const message = payload.message || payload.text;
  const tool = payload.tool;
  const usage = payload.usage;
  const eventTimestamp = payload.timestamp || now;

  const generatedEvents: CanonicalEvent[] = [];

  // Generate status changed event
  if (true) {
    const eventId = idempotencySource === 'none'
      ? serverEventId('wh_status')
      : webhookEventId('status', idempotencySource, idempotencyKey);

    const validatedEvent = validateCanonicalEvent({
      id: eventId,
      type: 'agent.status.changed',
      timestamp: eventTimestamp,
      agentId: agentName,
      source: `agent:${agentName}`,
      summary: `${agentName} → ${status}`,
      payload: { status, statusText: payload.statusText || status },
    });

    if (!validatedEvent.success) {
      markRejection(res, 'validation');
      res.status(400).json({
        error: 'validation_failed',
        message: 'Generated status event failed validation',
        issues: validatedEvent.issues,
      });
      return;
    }

    generatedEvents.push(validatedEvent.data!);
  }

  // Generate message sent event if present
  if (message) {
    const eventId = idempotencySource === 'none'
      ? serverEventId('wh_msg')
      : webhookEventId('msg', idempotencySource, idempotencyKey);

    const validatedEvent = validateCanonicalEvent({
      id: eventId,
      type: 'agent.message.sent',
      timestamp: eventTimestamp,
      agentId: agentName,
      source: `agent:${agentName}`,
      summary: `${agentName}: ${message.slice(0, 60)}`,
      payload: { text: message },
    });

    if (!validatedEvent.success) {
      markRejection(res, 'validation');
      res.status(400).json({
        error: 'validation_failed',
        message: 'Generated message event failed validation',
        issues: validatedEvent.issues,
      });
      return;
    }

    generatedEvents.push(validatedEvent.data!);
  }

  // Generate tool started event if present
  if (tool) {
    const eventId = idempotencySource === 'none'
      ? serverEventId('wh_tool')
      : webhookEventId('tool', idempotencySource, idempotencyKey);

    const validatedEvent = validateCanonicalEvent({
      id: eventId,
      type: 'tool.started',
      timestamp: eventTimestamp,
      agentId: agentName,
      source: `agent:${agentName}`,
      summary: `${agentName} using ${tool}`,
      payload: { tool },
    });

    if (!validatedEvent.success) {
      markRejection(res, 'validation');
      res.status(400).json({
        error: 'validation_failed',
        message: 'Generated tool event failed validation',
        issues: validatedEvent.issues,
      });
      return;
    }

    generatedEvents.push(validatedEvent.data!);
  }

  // Generate usage event if present
  if (usage) {
    let usageEventId: string;
    if (usage.requestId) {
      // Usage events with requestId get a stable ID based on provider and requestId
      usageEventId = webhookUsageRequestEventId(usage.provider, usage.requestId);
    } else if (idempotencySource === 'none') {
      usageEventId = serverEventId('wh_usage');
    } else {
      usageEventId = webhookEventId('usage', idempotencySource, idempotencyKey);
    }

    const validatedEvent = validateCanonicalEvent({
      id: usageEventId,
      type: 'llm.usage',
      timestamp: eventTimestamp,
      agentId: agentName,
      source: `agent:${agentName}`,
      summary: `${agentName} LLM usage reported`,
      payload: usage,
    });

    if (!validatedEvent.success) {
      markRejection(res, 'validation');
      res.status(400).json({
        error: 'validation_failed',
        message: 'Generated usage event failed validation',
        issues: validatedEvent.issues,
      });
      return;
    }

    generatedEvents.push(validatedEvent.data!);
  }

  // Step 5: Check for signature replay before appending to store
  let cacheResult: string[] | null = null;
  if (verifiedSignature) {
    cacheResult = rememberWebhookSignature(verifiedSignature, now + webhookToleranceMs, now, generatedEvents.map(e => e.id));
    if (cacheResult) {
      // This is a duplicate of a previously accepted signed delivery
      try {
        ingestionMetrics.recordDuplicate('identical', generatedEvents.length);
      } catch {
        // Instrumentation never breaks ingestion.
      }
      const isDuplicate = true;
      const results = generatedEvents.map((e, i) => ({
        id: e.id,
        type: e.type,
        duplicate: true,
      }));

      res.status(200).json({
        accepted: true,
        duplicate: isDuplicate,
        eventsGenerated: generatedEvents.length,
        acceptedCount: 0,
        duplicates: generatedEvents.length,
        idempotency: { source: idempotencySource },
        eventIds: generatedEvents.map((e) => e.id),
        results,
      });
      return;
    }
  }

  // Step 6: Append events to store
  const appendOptions: { atomic?: boolean; ignoreTimestamp?: boolean } = {};
  if (idempotencySource !== 'none') {
    appendOptions.atomic = true;
    appendOptions.ignoreTimestamp = payload.timestamp === undefined;
  }

  const { accepted, duplicates, conflicts, results, acceptedEvents, acceptedSeqs } = await store.appendBatch(generatedEvents, {
    ...appendOptions,
    channel: 'webhook',
    submitterId,
  } as any);
  recordAppendResults(results, generatedEvents);

  // Step 7: Record signature only after successful append
  if (verifiedSignature && accepted > 0) {
    seenWebhookSignatures.set(verifiedSignature, {
      expiresAt: now + webhookToleranceMs,
      eventIds: generatedEvents.map(e => e.id)
    });
  }

  // Step 8: Broadcast only newly accepted events
  acceptedEvents.forEach((evt, index) => broadcastEvent(evt, acceptedSeqs[index] ?? null, submitterId));

  const isDuplicate = accepted === 0 && duplicates > 0 && conflicts === 0;
  const statusCode = conflicts > 0 ? 409 : accepted > 0 ? 202 : 200;

  const formattedResults = results.map((r) => ({
    id: r.id,
    type: generatedEvents.find(e => e.id === r.id)?.type || 'unknown',
    duplicate: r.outcome === 'duplicate',
  }));

  if (statusCode === 409) {
    res.status(409).json({
      error: 'event_id_conflict',
      message: 'A webhook event with the same id was already stored with different content',
      idempotency: { source: idempotencySource },
      conflictingIds: results.filter(r => r.outcome === 'conflict').map(r => r.id),
    });
  } else {
    res.status(statusCode).json({
      accepted: true,
      duplicate: isDuplicate,
      eventsGenerated: generatedEvents.length,
      acceptedCount: accepted,
      duplicates,
      idempotency: { source: idempotencySource },
      eventIds: generatedEvents.map((e) => e.id),
      results: formattedResults,
    });
  }
});

// -------------------------------------------------------------
// Named API keys (issue #107): `/api/v1/keys*` (bootstrap-only management) and `/api/v1/whoami` (any valid
// credential). Sits under `/api/v1` like every route above, so it already has the rate limiter, the query-token
// rejection, the open-mode guard and the Bearer auth (which also resolves `res.locals.submitter`) registered
// earlier in this file.
// -------------------------------------------------------------

/** Issue #107: appends an `audit.key.created`/`audit.key.revoked` event directly, bypassing
 * `validateCanonicalEvent`/`normalizeCanonicalEvent` (these types are deliberately not in
 * `CANONICAL_EVENT_TYPES`) and never calling `broadcastEvent`, so it is never sent over SSE and never reaches an
 * `onEventAccepted` listener (`--record` files stay canonical V1). It still enters the stored log, and therefore
 * the hash chain (#105), like any other event. Failures are logged, never thrown: a key change must not fail
 * because its own audit trail entry could not be written. */
async function appendAuditKeyEvent(type: AuditEventType, actorId: string, payload: Record<string, unknown>): Promise<void> {
  const event = {
    schemaVersion: '1.0' as const,
    id: `evt_audit_${crypto.randomUUID()}`,
    type: type as unknown as CanonicalEvent['type'],
    timestamp: Date.now(),
    source: 'server',
    severity: 'normal' as const,
    summary: type,
    payload,
  };
  try {
    await store.append(event, { submitterId: actorId });
  } catch (error) {
    console.error(`[agent-viewer] Failed to record ${type} audit event:`, error);
  }
}

// Issue #108: key management needs `admin`, listing and reading keys needs `audit`. The `/api/v1` route policy
// (`server/auth/routePolicy.ts`) already enforces this; each route below repeats its own `requireScope` as
// defense in depth, so moving or renaming a route can never silently drop its guard.
const requireAdminScope = requireScope('admin', scopeGuardOptions);
const requireAuditScope = requireScope('audit', scopeGuardOptions);

/** The last-admin rule (issue #108) only applies while no bootstrap token is configured: one that is, is always
 * an implicit admin. */
function adminGuard(): { envTokenConfigured: boolean } {
  return { envTokenConfigured: Boolean(getApiToken()) };
}

function sendLastAdmin(res: express.Response, error: LastAdminError): void {
  res.status(409).json({ error: 'last_admin', message: error.message });
}

/** `true` and already responded `501 keys_require_sqlite` when the store has no key registry (memory mode);
 * `false` otherwise. Every `/api/v1/keys*` handler (not `/whoami`, which needs no registry) checks this first. */
function requireKeysSupported(res: express.Response): boolean {
  if (apiKeysSupported) return false;
  res.status(501).json({
    error: 'keys_require_sqlite',
    message: 'Named API keys require AGENT_VIEWER_STORAGE=sqlite: set it and restart to use this endpoint.',
  });
  return true;
}

function serializeApiKey(record: ApiKeyRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    status: record.status,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
    revokedBy: record.revokedBy,
    eventCount: record.eventCount,
    firstEventAt: record.firstEventAt,
    lastEventAt: record.lastEventAt,
    scopes: record.scopes,
  };
}

app.post('/api/v1/keys', requireAdminScope, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (requireKeysSupported(res)) return;
  const submitter = res.locals.submitter as Submitter;

  const body = (req.body ?? {}) as { name?: unknown; expiresAt?: unknown; expiresIn?: unknown; scopes?: unknown };
  if (body.expiresAt !== undefined && body.expiresIn !== undefined) {
    res.status(400).json({ error: 'validation_failed', issues: [{ path: 'expiresAt', message: 'expiresAt and expiresIn are mutually exclusive' }] });
    return;
  }
  let expiresAt: number | null = null;
  if (typeof body.expiresAt === 'number') {
    expiresAt = body.expiresAt;
  } else if (body.expiresAt !== undefined) {
    res.status(400).json({ error: 'validation_failed', issues: [{ path: 'expiresAt', message: 'must be an integer epoch-ms timestamp' }] });
    return;
  } else if (typeof body.expiresIn === 'number') {
    if (!Number.isInteger(body.expiresIn) || body.expiresIn < 60 || body.expiresIn > 31_536_000) {
      res.status(400).json({ error: 'validation_failed', issues: [{ path: 'expiresIn', message: 'must be an integer number of seconds, 60 to 31536000' }] });
      return;
    }
    expiresAt = Date.now() + body.expiresIn * 1000;
  } else if (body.expiresIn !== undefined) {
    res.status(400).json({ error: 'validation_failed', issues: [{ path: 'expiresIn', message: 'must be an integer number of seconds' }] });
    return;
  }

  try {
    const created = apiKeyStore.create({
      name: typeof body.name === 'string' ? body.name : '',
      expiresAt,
      createdBy: submitter.id,
      scopes: body.scopes,
    });
    await appendAuditKeyEvent('audit.key.created', submitter.id, {
      keyId: created.id,
      name: created.name,
      prefix: created.prefix,
      expiresAt: created.expiresAt ?? undefined,
      scopes: created.scopes,
    });
    res.status(201).json(created);
  } catch (error) {
    if (error instanceof ApiKeyValidationError) {
      res.status(400).json({ error: 'validation_failed', issues: [{ path: error.path, message: error.message }] });
      return;
    }
    if (error instanceof ApiKeyNameTakenError) {
      res.status(409).json({ error: 'key_name_taken', message: error.message });
      return;
    }
    throw error;
  }
});

app.get('/api/v1/keys', requireAuditScope, async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (requireKeysSupported(res)) return;
  res.json({ keys: apiKeyStore.list().map(serializeApiKey) });
});

app.get('/api/v1/keys/:id', requireAuditScope, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (requireKeysSupported(res)) return;
  const record = apiKeyStore.get(String(req.params.id));
  if (!record) {
    res.status(404).json({ error: 'key_not_found' });
    return;
  }
  res.json(serializeApiKey(record));
});

app.post('/api/v1/keys/:id/revoke', requireAdminScope, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (requireKeysSupported(res)) return;
  const submitter = res.locals.submitter as Submitter;
  let outcome: ReturnType<ApiKeyStore['revoke']>;
  try {
    outcome = apiKeyStore.revoke(String(req.params.id), submitter.id, adminGuard());
  } catch (error) {
    if (error instanceof LastAdminError) {
      sendLastAdmin(res, error);
      return;
    }
    throw error;
  }
  if (!outcome) {
    res.status(404).json({ error: 'key_not_found' });
    return;
  }
  if (!outcome.alreadyRevoked) {
    await appendAuditKeyEvent('audit.key.revoked', submitter.id, { keyId: outcome.record.id, name: outcome.record.name, prefix: outcome.record.prefix });
  }
  res.json(serializeApiKey(outcome.record));
});

app.get('/api/v1/whoami', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const submitter = res.locals.submitter as Submitter | undefined;
  if (!submitter) {
    // Unreachable on a route behind `requireApiToken` (every `/api/v1` route), kept as a defensive default.
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.json(submitter.kind === 'key' ? { kind: submitter.kind, id: submitter.id, name: submitter.name } : { kind: submitter.kind, id: submitter.id });
});

// Issue #108: changes a key's granted scopes. Admin only (the route policy and `requireAdminScope`), never on
// the caller's own key (a key cannot widen or narrow itself), never on the bootstrap token (always admin, has no
// row), and never demoting the last active admin key while no bootstrap token is configured (`409 last_admin`).
app.patch('/api/v1/keys/:id', requireAdminScope, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (requireKeysSupported(res)) return;
  const principal = principalOf(res) as Principal;
  const id = String(req.params.id);

  if (id === ENV_TOKEN_PRINCIPAL.keyId) {
    res.status(400).json({ error: 'env_token_scopes_immutable', message: 'AGENT_VIEWER_API_TOKEN is always admin; its scopes cannot be set.' });
    return;
  }
  if (principal.source === 'named' && principal.keyId === id) {
    res.status(403).json({ error: 'cannot_modify_own_scopes', message: 'A key cannot change its own scopes; use another admin credential.' });
    return;
  }

  const body = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    res.status(400).json({ error: 'validation_failed', issues: [{ path: '', message: 'body must be an object { scopes }' }] });
    return;
  }
  const unknownField = Object.keys(body).find((key) => key !== 'scopes');
  if (unknownField !== undefined) {
    res.status(400).json({ error: 'validation_failed', issues: [{ path: unknownField, message: 'only "scopes" can be changed' }] });
    return;
  }

  try {
    const outcome = apiKeyStore.setScopes(id, (body as { scopes?: unknown }).scopes, adminGuard());
    if (!outcome) {
      res.status(404).json({ error: 'key_not_found' });
      return;
    }
    res.json(serializeApiKey(outcome.record));
  } catch (error) {
    if (error instanceof ApiKeyValidationError) {
      res.status(400).json({ error: 'validation_failed', issues: [{ path: error.path, message: error.message }] });
      return;
    }
    if (error instanceof ApiKeyRevokedError) {
      res.status(409).json({ error: 'key_revoked', message: error.message });
      return;
    }
    if (error instanceof LastAdminError) {
      sendLastAdmin(res, error);
      return;
    }
    throw error;
  }
});

// Issue #108: who the presented credential is and what it may do. Any valid credential (route policy
// `authenticated`); `open: true` when no bootstrap token is configured, so the whole API is open.
app.get('/api/v1/auth/whoami', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const principal = principalOf(res);
  if (!principal) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.json({ ...describePrincipal(principal), ...(getApiToken() ? {} : { open: true }) });
});

// -------------------------------------------------------------
// Pricing admin API (issue #83 section 5, sub-issue #272): the 8 `/api/v1/pricing*` endpoints, built on the
// contract/resolver (issue #270) and the file store (issue #271). Sits under `/api/v1` like every route above,
// so it already has the rate limiter, the query-token rejection, the open-mode guard and the Bearer auth
// registered earlier in this file. `getStore` is passed as a thunk (never called here at import time) so that
// importing this module alone still creates no file (issue #83's own acceptance criterion).
// -------------------------------------------------------------
registerPricingRoutes(app, {
  getStore: getPricingStore,
  hasAdminToken: () => currentAuthMode() === 'token',
  usageRollup: (query) => store.rollup(query),
});

// -------------------------------------------------------------
// Budgets API (issue #85, sub-issue #304): the 6 `/api/v1/budgets*` endpoints, built on the pure engine and
// registry of sub-issues #302/#303 (`server/budgets.ts`). Sits under `/api/v1` like every route above, so it
// already has the rate limiter, the query-token rejection, the open-mode guard and the Bearer auth registered
// earlier in this file.
// -------------------------------------------------------------
registerBudgetsRoutes(app, budgetDeps);

// -------------------------------------------------------------
// Budget alerts read API (issue #86, sub-issue #322): the two read-only `/api/v1/budget-alerts*` routes
// (`server/budgetAlerts.ts`). Sits under `/api/v1` right after the budgets routes above, so it already has the
// same rate limiter, query-token rejection, open-mode guard and Bearer auth with zero extra wiring.
// -------------------------------------------------------------
registerBudgetAlertsRoutes(app, budgetAlertsDeps);

// -------------------------------------------------------------
// Pricing recompute (issue #296, sub-issue of #84): re-runs the ingestion-time estimator (`server/pricing/
// estimate.ts`) against a corrected or explicitly pinned price-table version. A write operation: it shares the
// same Bearer-token auth and rate limit as every other `/api/v1` route above (there are no scoped keys yet,
// issue #108), and is therefore just as open as the rest of the API when `AGENT_VIEWER_API_TOKEN` is unset
// (README.md's existing "open API" note covers this; see the README/docs updates in this same change).
// SQLite-only: `store.recomputePricing` is `undefined` in memory mode (see `EventStore`'s own doc comment), so
// every route below answers 501 `ledger_unavailable` rather than silently behaving differently.
// -------------------------------------------------------------
app.post('/api/v1/pricing/recompute', async (req, res) => {
  if (typeof store.recomputePricing !== 'function') {
    res.status(501).json({ error: 'ledger_unavailable', message: 'The usage ledger is not available in this storage mode.' });
    return;
  }
  const parsed = parseRecomputeRequest(req.body);
  if (!parsed.ok) {
    res.status(parsed.status).json({ error: parsed.code, message: parsed.message, issues: parsed.issues });
    return;
  }
  try {
    const outcome = await store.recomputePricing(parsed.value);
    res.status(outcome.dryRun ? 200 : 201).json(outcome);
  } catch (error) {
    if (error instanceof PricingVersionNotFoundError) {
      res.status(404).json({ error: 'pricing_version_not_found', message: error.message });
      return;
    }
    if (error instanceof RecomputeTooBroadError) {
      res.status(413).json({ error: 'filter_too_broad', message: error.message, matched: error.matched, maxRows: error.maxRows });
      return;
    }
    if (error instanceof RecomputeInProgressError) {
      res.status(409).json({ error: 'recompute_in_progress', message: error.message });
      return;
    }
    throw error;
  }
});

/** `limit`/`before` for GET /api/v1/pricing/recompute-runs: `limit` is 1..200, default 20 (same range as
 * `parseRetentionLimit`, another small audit listing); `before` is a positive integer revision cursor. An
 * invalid value of either is a 400, never a silent fallback. */
function parseRecomputeRunsQuery(query: {
  limit?: unknown;
  before?: unknown;
}): { limit: number; before: number | null } | 'invalid' {
  let limit = 20;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^[0-9]+$/.test(query.limit)) return 'invalid';
    const value = Number(query.limit);
    if (value < 1 || value > 200) return 'invalid';
    limit = value;
  }
  let before: number | null = null;
  if (query.before !== undefined) {
    if (typeof query.before !== 'string' || !/^[0-9]+$/.test(query.before)) return 'invalid';
    const value = Number(query.before);
    if (value < 1) return 'invalid';
    before = value;
  }
  return { limit, before };
}

app.get('/api/v1/pricing/recompute-runs', async (req, res) => {
  if (typeof store.listRecomputeRuns !== 'function') {
    res.status(501).json({ error: 'ledger_unavailable', message: 'The usage ledger is not available in this storage mode.' });
    return;
  }
  const parsed = parseRecomputeRunsQuery(req.query as { limit?: unknown; before?: unknown });
  if (parsed === 'invalid') {
    res.status(400).json({ error: 'invalid_request', message: 'limit must be 1..200 and before must be a positive integer revision.' });
    return;
  }
  const page = await store.listRecomputeRuns(parsed);
  res.json({ schemaVersion: '1.0', data: page.runs, page: { limit: parsed.limit, hasMore: page.hasMore } });
});

app.get('/api/v1/pricing/recompute-runs/:runId', async (req, res) => {
  if (typeof store.getRecomputeRun !== 'function') {
    res.status(501).json({ error: 'ledger_unavailable', message: 'The usage ledger is not available in this storage mode.' });
    return;
  }
  const run = await store.getRecomputeRun(req.params.runId);
  if (!run) {
    res.status(404).json({ error: 'run_not_found', message: `No recompute run with id "${req.params.runId}" exists.` });
    return;
  }
  res.json({ schemaVersion: '1.0', ...run });
});

// Safe global error handler returning JSON without stack traces or absolute paths.
// Express 5 also routes rejected promises from async handlers here.
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  // A stream (SSE) that already sent its headers cannot get a JSON error; let Express close the connection.
  if (res.headersSent) {
    next(err);
    return;
  }
  // Express 5 throws on status codes that are not integers between 100 and 999.
  const status = Number.isInteger(err?.status) && err.status >= 100 && err.status <= 999 ? err.status : 500;
  if (status === 413) markRejection(res, 'payload_too_large');
  res.status(status).json({
    error: err?.code || 'internal_server_error',
    message: err?.message ? String(err.message).slice(0, 200) : 'An internal error occurred',
  });
});

let serverInstance: any = null;

/** The real bound address for a listen() log line: IPv6 wrapped in brackets, never a hard-coded `localhost`. */
function boundUrl(address: AddressInfo): string {
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
}

/**
 * Starts listening. Without an explicit `host` this reads `AGENT_VIEWER_HOST`, defaulting to loopback (issue
 * #71: this default used to be "every interface"). The CLI always passes its own `command.host`. Throws
 * `OpenApiRefusedError` before binding when `host` is not loopback, no token is configured and the operator has
 * not set `AGENT_VIEWER_ALLOW_OPEN=1`.
 */
export function startServer(portToListen = port, host: string = envHost()): Server {
  assertSafeBind(host, portToListen, { hasToken: Boolean(getApiToken()) });
  // Issue #271: loads or seeds the pricing table now, so a bad data directory shows up in the log at boot
  // instead of on the first pricing request (the HTTP endpoints that read it land in the next sub-issue).
  try {
    getPricingStore().getSnapshot();
  } catch (error) {
    console.error(`[agent-viewer] pricing store failed to initialize: ${error instanceof Error ? error.message : String(error)}`);
  }
  const server = app.listen(portToListen, host);
  server.once('listening', () => {
    warnIfApiOpen((server.address() as AddressInfo).port, host);
    warnIfMetricsAuthOff();
  });
  return server;
}

if (isDirectRun && process.env.NODE_ENV !== 'test') {
  const directRunHost = envHost();
  try {
    assertSafeBind(directRunHost, port, { hasToken: Boolean(getApiToken()) });
  } catch (error) {
    if (error instanceof OpenApiRefusedError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  // Express 5 passes listen errors (for example EADDRINUSE) to this callback instead of emitting them unhandled.
  serverInstance = app.listen(port, directRunHost, (err?: Error) => {
    if (err) throw err;
    const address = serverInstance.address() as AddressInfo;
    warnIfApiOpen(address.port, directRunHost);
    warnIfMetricsAuthOff();
    console.log(`Agent Viewer ingestion server listening on ${directRunHost}, port ${address.port} (${boundUrl(address)})`);
  });

  // Issue #70: a direct run (npm run server, the Docker `api` image) owns its own process, so it stops the
  // retention job and closes the store itself on SIGTERM/SIGINT. The embedded CLI installs no handler here: its
  // `close()` (cli/start.ts) calls the same exported `shutdown()` after it closes the HTTP server, so neither
  // path double-closes the store.
  let shuttingDown = false;
  const handleShutdownSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdown()
      .catch((error) => {
        console.error(`[agent-viewer] shutdown error: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', handleShutdownSignal);
  process.on('SIGINT', handleShutdownSignal);
}

export { app, serverInstance, store, ingestionMetrics };
