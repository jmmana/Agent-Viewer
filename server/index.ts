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
import type { AgentStatus } from '../src/types/agent';
import { OTLP_LOGS_PATH, OTLP_METRICS_PATH } from '../src/integrations/otelConstants';
import { serverEventId } from './ids';
import { webhookEventId, webhookUsageRequestEventId } from './webhookIds';
import {
  createEventStore,
  type AppendResult,
  type AppendBatchResult,
  type EventSeq,
  type EventStore,
  type TelemetryAppendOutcome,
} from './store';
import { parseRetentionConfig, startRetention, usageRetentionWarning, type RetentionConfig, type RetentionJobHandle } from './retention';
import { readPackageVersion } from './version';
import { parseUsageFilters } from './usage/filters';
import { decodeCursor, encodeCursor, filterHash } from './usage/calls';
import type { UsageFilters } from './usage/types';
import { mapOtlpLogsRequest, looksLikeOtlpLogsRequest, countLogRecords } from '../src/integrations/otlp/claudeCodeLogs';
import { assertSafeBind, envHost, isLoopbackAddress, isLoopbackHost, isOpenModeAllowed, OpenApiRefusedError } from './network';
import { createStreamTicketStore } from './stream-tickets';
import { mapOtlpMetricsRequest, looksLikeOtlpMetricsRequest, countMetricDataPoints } from './otlp/metrics';
import {
  decodeExportLogsServiceRequest,
  decodeExportMetricsServiceRequest,
  encodeExportLogsServiceResponse,
  encodeExportMetricsServiceResponse,
  encodeStatus,
} from './otlp/otlpProtobuf';

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
const port = Number(process.env.PORT ?? 8787);
const maxBatchSize = Number(process.env.AGENT_VIEWER_MAX_BATCH_SIZE ?? 100);
const rateLimitMax = Number(process.env.AGENT_VIEWER_RATE_LIMIT ?? 1000);
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
try {
  store = createEventStore();
  sseReplayMax = parseSseReplayMax(process.env.AGENT_VIEWER_SSE_REPLAY_MAX);
  // Issue #70: validated once at startup, like every other env-derived config here. A bad value must never be
  // silently ignored or guessed at, since it governs permanent deletion.
  retentionConfig = parseRetentionConfig(process.env);
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

if (retentionConfig.ledgerDays !== null) {
  console.log(usageRetentionWarning(retentionConfig.ledgerDays));
}
// Wired unconditionally, right after the store (issue #70): with both windows unset this creates no timer at
// all, so importing this module in a test (which never configures either variable) is unaffected. `shutdown()`
// below stops it before closing the store.
const retentionJob: RetentionJobHandle = startRetention({ store, config: retentionConfig });

/**
 * Stops the retention job (waiting for a run already in progress) and closes the store. Called by the direct-run
 * `SIGTERM`/`SIGINT` handlers below, and by the embedded CLI's `close()` (`cli/start.ts`) after it closes the
 * HTTP server (issue #70). Safe to call more than once: both steps it calls already are.
 */
export async function shutdown(): Promise<void> {
  await retentionJob.stop();
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

function rateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry && rateLimits.size >= rateLimitMaxTrackedClients) {
    for (const [key, value] of rateLimits) {
      if (value.resetAt <= now) rateLimits.delete(key);
    }
  }
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + rateLimitWindowMs };
    rateLimits.set(ip, entry);
  }
  entry.count++;
  if (entry.count > rateLimitMax) {
    // Issue #59: every 429, on every route this limiter guards, carries Retry-After so OTLP exporters (and any
    // other well-behaved client) back off instead of retrying immediately. At least 1 second, rounded up.
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
    res.status(429).json({ error: 'rate_limit_exceeded', message: `Too many requests. Limit: ${rateLimitMax}/min` });
    return;
  }
  next();
}

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
      res.status(415).json(otlpErrorBody(3, unsupportedMediaMessage));
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
      res.status(413).json(otlpErrorBody(3, limitMessage));
      return;
    }
    if (type === 'encoding.unsupported' || type === 'charset.unsupported' || status === 415) {
      res.status(415).json(otlpErrorBody(3, unsupportedMediaMessage));
      return;
    }
    // entity.parse.failed (malformed JSON), request.aborted, request.size.invalid, a corrupt gzip stream, or
    // anything else either route's parser can throw: all answered the same way as a malformed body (400).
    res.status(400).json(otlpErrorBody(3, malformedMessage));
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
 * The Bearer-token decision `/api/v1` and `/v1/logs` both use, factored out so the two stay identical (issue
 * #59). Since issue #71 this is Bearer-only: a `token` or `api_key` query parameter never authenticates
 * anything, on any route, so a leaked URL cannot grant access (that case is rejected even earlier, by
 * `rejectQueryToken`, with its own `query_token_not_supported` response). Reads `getApiToken` and `safeEqual`,
 * both defined later in this module as hoisted `function` declarations.
 */
function isRequestAuthorized(req: express.Request): boolean {
  const expectedToken = getApiToken();
  if (!expectedToken) return true;

  const bearerMatch = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  return bearerMatch ? safeEqual(bearerMatch[1], expectedToken) : false;
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
    if (isRequestAuthorized(req)) {
      next();
      return;
    }
    if (options.streamTicketRoute && req.method === 'GET' && req.path === options.streamTicketRoute && 'ticket' in req.query) {
      const ticketValue = req.query.ticket;
      if (typeof ticketValue === 'string' && streamTicketStore.consume(ticketValue)) {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.status(401).json({ error: 'invalid_stream_ticket' });
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
    res.status(403).json({ error: 'open_api_loopback_only' });
    return;
  }

  const hostHeader = (req.header('host') ?? '').trim();
  const hostOnly = hostHeader.startsWith('[')
    ? hostHeader.slice(1, Math.max(hostHeader.indexOf(']'), 1))
    : hostHeader.split(':')[0];
  if (!isLoopbackHost(hostOnly)) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(403).json({ error: 'open_api_host_not_allowed' });
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
      res.status(403).json({ error: 'open_api_origin_not_allowed' });
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
  try {
    appendResult = await store.appendBatch(mapped.events, { channel: 'otlp' });
  } catch (error) {
    otlpStats.requestsRejected += 1;
    if (isProtobufRequest) res.status(503).type('application/x-protobuf').send(Buffer.from(encodeStatus(14, 'Storage unavailable, retry')));
    else res.status(503).json(otlpErrorBody(14, 'Storage unavailable, retry'));
    return;
  }

  appendResult.acceptedEvents.forEach((event, index) => broadcastEvent(event, appendResult.acceptedSeqs[index] ?? null));

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
      res.status(400).type('application/x-protobuf').send(Buffer.from(encodeStatus(3, OTLP_METRICS_MALFORMED_BODY_MESSAGE)));
      return;
    }
  } else {
    body = req.body ?? {};
  }

  if (!looksLikeOtlpMetricsRequest(body)) {
    otlpMetricsStats.requestsRejected += 1;
    if (isProtobufRequest) res.status(400).type('application/x-protobuf').send(Buffer.from(encodeStatus(3, OTLP_METRICS_MALFORMED_BODY_MESSAGE)));
    else res.status(400).json(otlpErrorBody(3, OTLP_METRICS_MALFORMED_BODY_MESSAGE));
    return;
  }

  if (countMetricDataPoints(body) > otlpMaxRecords) {
    otlpMetricsStats.requestsRejected += 1;
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
    res.status(400).json({ error: 'bad_request', message: 'Malformed JSON payload' });
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
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

app.get('/ready', (_req, res) => {
  try {
    const readiness = store.readiness();
    const database = store.getSchemaInfo?.();
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

// Helper to broadcast event to SSE subscribers (without named event so EventSource.onmessage receives all)
/**
 * Broadcasts an accepted event to SSE subscribers (without a named event, so `EventSource.onmessage` receives
 * all of them). `seq` is the event's insertion seq (issue #54), used to order the live buffer of a connection
 * still replaying a reconnect gap: `broadcastEvent` queues the frame for it instead of writing it right away, so
 * nothing broadcast during its replay is ever lost or delivered out of order.
 */
function broadcastEvent(event: CanonicalEvent, seq: EventSeq | null) {
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
  const frame = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
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
 * Stores an event the server built itself and broadcasts it only when the store accepted it. Any other outcome
 * means a server-generated id was reused, which is a server bug: it is logged at error and answered with
 * `500 internal_id_collision` instead of being hidden. Returns false when the response was already sent.
 */
async function appendServerEvent(event: CanonicalEvent, res: express.Response): Promise<boolean> {
  const result: AppendResult = await store.append(event);
  if (result.outcome === 'accepted') {
    broadcastEvent(event, result.seq);
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

  const validation = validateCanonicalEvent(body);
  if (!validation.success || !validation.data) {
    res.status(400).json({
      error: 'validation_failed',
      issues: validation.issues ?? [{ path: '', message: 'Invalid event payload' }],
    });
    return;
  }

  const event = validation.data;
  const result = await store.append(event);

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

  broadcastEvent(event, result.seq);

  res.status(202).json({
    accepted: true,
    duplicate: false,
    id: event.id,
    fingerprint: result.fingerprint,
    receivedAt: result.receivedAt,
  });
});

// -------------------------------------------------------------
// Event Ingestion (Batch)
// -------------------------------------------------------------
app.post('/api/v1/events/batch', async (req, res) => {
  const rawEvents: unknown = Array.isArray(req.body) ? req.body : req.body?.events;

  if (!Array.isArray(rawEvents)) {
    res.status(400).json({
      error: 'invalid_batch',
      message: 'Expected JSON array of events or an object with "events" array',
    });
    return;
  }

  if (rawEvents.length === 0) {
    res.status(400).json({
      error: 'empty_batch',
      message: 'Batch cannot be empty',
    });
    return;
  }

  if (rawEvents.length > maxBatchSize) {
    res.status(413).json({
      error: 'batch_too_large',
      message: `Batch contains ${rawEvents.length} events; limit is ${maxBatchSize}`,
    });
    return;
  }

  const validatedEvents: CanonicalEvent[] = [];
  const errors: Array<{ index: number; issues: ValidationIssue[] }> = [];

  rawEvents.forEach((item, index) => {
    const val = validateCanonicalEvent(item);
    if (val.success && val.data) {
      validatedEvents.push(val.data);
    } else {
      errors.push({ index, issues: val.issues ?? [{ path: '', message: 'Validation failed' }] });
    }
  });

  if (errors.length > 0) {
    res.status(400).json({
      error: 'validation_failed',
      message: `${errors.length} event(s) in batch failed validation`,
      errors,
    });
    return;
  }

  const { accepted, duplicates, conflicts, results, acceptedEvents, acceptedSeqs } = await store.appendBatch(validatedEvents, {
    channel: 'events-batch',
  });

  acceptedEvents.forEach((event, index) => broadcastEvent(event, acceptedSeqs[index] ?? null));

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

  // Backward paging (issue #72): an unknown or evicted cursor is a client error, unlike `afterId`, which applies
  // no filter when it cannot be resolved. A partial history must never look complete.
  if (beforeId !== undefined && (await store.resolveCursor(beforeId)) === null) {
    res.status(400).json({ error: 'invalid_cursor', message: `Unknown or evicted beforeId "${beforeId}"` });
    return;
  }

  // Fetch one extra row to learn whether there is a next page, without exposing it in the response.
  const page = await store.list({ limit: limit + 1, since, afterId, beforeId, runtimeId, sessionId, agentId, type });
  const hasMore = page.length > limit;
  const events = hasMore ? page.slice(0, limit) : page;
  const nextBeforeId = hasMore ? (events[events.length - 1]?.id ?? null) : null;
  const retention = await store.retention();
  res.json({
    schemaVersion: '1.0',
    count: events.length,
    hasMore,
    nextBeforeId,
    events,
    retention,
  });
});

// -------------------------------------------------------------
// Snapshot
// -------------------------------------------------------------
app.get('/api/v1/snapshot', requireReady, async (_req, res) => {
  const snapshot = await store.snapshot();
  res.json(snapshot);
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
  });
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

  if (!(await appendServerEvent(regEvent, res))) return;

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
      if (!(await appendServerEvent(updatedEvent, res))) return;
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
    if (!(await appendServerEvent(statusEvent, res))) return;
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
    if (!(await appendServerEvent(updatedEvent, res))) return;
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
  if (!(await appendServerEvent(event, res))) return;

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
      res.status(401).json({
        error: 'missing_webhook_signature',
        message: 'Headers X-Agent-Viewer-Signature and X-Agent-Viewer-Timestamp required',
      });
      return;
    }

    const timestamp = Number(timestampStr);
    // Replay protection, part 1: the timestamp must be within 5 minutes
    if (isNaN(timestamp) || Math.abs(now - timestamp) > webhookToleranceMs) {
      res.status(401).json({
        error: 'replay_detected_or_clock_skew',
        message: 'Webhook timestamp is expired or too far in the future',
      });
      return;
    }

    const rawBody = (req as any).rawBody?.toString('utf-8') ?? JSON.stringify(req.body ?? {});
    const expected = crypto.createHmac('sha256', secret).update(`${timestampStr}.${rawBody}`).digest('hex');

    if (!safeEqual(signature, expected)) {
      res.status(401).json({
        error: 'invalid_webhook_signature',
        message: 'HMAC signature verification failed',
      });
      return;
    }

    verifiedSignature = expected;
  }

  // Step 2: Parse and validate the webhook payload
  const parseResult = GenericWebhookPayloadSchema.safeParse(req.body ?? {});
  if (!parseResult.success) {
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
    res.status(400).json({
      error: 'invalid_idempotency_key',
      message: 'idempotencyKey must be 1-255 printable ASCII characters',
    });
    return;
  }

  if (headerKey && !headerKey.match(/^[\x20-\x7E]+$/)) {
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
  } as any);

  // Step 7: Record signature only after successful append
  if (verifiedSignature && accepted > 0) {
    seenWebhookSignatures.set(verifiedSignature, {
      expiresAt: now + webhookToleranceMs,
      eventIds: generatedEvents.map(e => e.id)
    });
  }

  // Step 8: Broadcast only newly accepted events
  acceptedEvents.forEach((evt, index) => broadcastEvent(evt, acceptedSeqs[index] ?? null));

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
  const server = app.listen(portToListen, host);
  server.once('listening', () => warnIfApiOpen((server.address() as AddressInfo).port, host));
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

export { app, serverInstance, store };
