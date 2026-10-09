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
import { serverEventId } from './ids';
import { webhookEventId, webhookUsageRequestEventId } from './webhookIds';
import { createEventStore, type AppendResult, type EventStore } from './store';
import { readPackageVersion } from './version';

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
try {
  store = createEventStore();
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
    res.status(429).json({ error: 'rate_limit_exceeded', message: `Too many requests. Limit: ${rateLimitMax}/min` });
    return;
  }
  next();
}

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
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

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

  const loopback = input.host !== undefined && LOOPBACK_HOSTS.has(input.host);
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

// Authentication middleware for /api/v1/*
app.use('/api/v1', (req, res, next) => {
  // With a webhook secret configured, webhooks authenticate with their HMAC signature (checked in the route).
  // Without one, they need the API token like every other ingestion endpoint.
  if (req.path.startsWith('/webhooks') && process.env.AGENT_VIEWER_WEBHOOK_SECRET) return next();

  const expectedToken = getApiToken();
  if (!expectedToken) return next();

  const bearerMatch = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  const queryToken =
    typeof req.query.token === 'string'
      ? req.query.token
      : typeof req.query.api_key === 'string'
        ? req.query.api_key
        : undefined;

  const headerOk = bearerMatch ? safeEqual(bearerMatch[1], expectedToken) : false;
  const queryOk = queryToken !== undefined ? safeEqual(queryToken, expectedToken) : false;
  if (headerOk || queryOk) {
    return next();
  }

  res.status(401).json({
    error: 'unauthorized',
    message: 'Valid Bearer token or token query parameter required',
  });
});

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
function broadcastEvent(event: CanonicalEvent) {
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
    broadcastEvent(event);
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
    });
    return;
  }

  broadcastEvent(event);

  res.status(202).json({
    accepted: true,
    duplicate: false,
    id: event.id,
    fingerprint: result.fingerprint,
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

  const { accepted, duplicates, conflicts, results, acceptedEvents } = await store.appendBatch(validatedEvents);

  for (const event of acceptedEvents) {
    broadcastEvent(event);
  }

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
app.get('/api/v1/events', async (req, res) => {
  const limit = req.query.limit ? Number(req.query.limit) : 100;
  const since = req.query.since ? Number(req.query.since) : undefined;
  const afterId = typeof req.query.afterId === 'string' ? req.query.afterId : undefined;
  const runtimeId = typeof req.query.runtimeId === 'string' ? req.query.runtimeId : undefined;
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;

  const events = await store.list({ limit, since, afterId, runtimeId, sessionId, agentId, type });
  const retention = await store.retention();
  res.json({
    schemaVersion: '1.0',
    count: events.length,
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

/** `limit` on a list endpoint: default 100, clamped to 1..1000. A non-numeric value falls back to the default. */
function clampedLimit(raw: unknown, fallback: number, max: number): number {
  const value = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
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

// -------------------------------------------------------------
// Realtime Stream (SSE)
// -------------------------------------------------------------
app.get('/api/v1/events/stream', async (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Handle missed events if Last-Event-ID or lastEventId query param is provided
  const lastEventId = req.header('last-event-id') || (typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined);
  if (lastEventId) {
    const missed = await store.list({ afterId: lastEventId, limit: 100 });
    // missed events are descending; replay in chronological order
    for (const evt of missed.reverse()) {
      res.write(`id: ${evt.id}\ndata: ${JSON.stringify(evt)}\n\n`);
    }
  }

  // Read retention before the first write and send ": connected" plus the first heartbeat in one write (issue
  // #53), so a client knows the retention state as soon as it connects and no live event can land between the
  // two frames. A rejected retention() falls back to the old empty heartbeat instead of failing the connection.
  let initialRetentionData = '{}';
  try {
    initialRetentionData = JSON.stringify({ retention: await store.retention() });
  } catch {
    // Keep the empty-payload fallback; the client watchdog only needs a frame to arrive, not its content.
  }
  res.write(`: connected\n\n: heartbeat\nevent: heartbeat\ndata: ${initialRetentionData}\n\n`);
  clients.add(res);

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
    clearInterval(heartbeat);
    clients.delete(res);
  });
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

  const { accepted, duplicates, conflicts, results, acceptedEvents } = await store.appendBatch(generatedEvents, appendOptions as any);

  // Step 7: Record signature only after successful append
  if (verifiedSignature && accepted > 0) {
    seenWebhookSignatures.set(verifiedSignature, {
      expiresAt: now + webhookToleranceMs,
      eventIds: generatedEvents.map(e => e.id)
    });
  }

  // Step 8: Broadcast only newly accepted events
  for (const evt of acceptedEvents) {
    broadcastEvent(evt);
  }

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

/** Starts listening. Without `host` it binds every interface, as before; the CLI passes `127.0.0.1`. */
export function startServer(portToListen = port, host?: string): Server {
  const server = host ? app.listen(portToListen, host) : app.listen(portToListen);
  server.once('listening', () => warnIfApiOpen((server.address() as AddressInfo).port, host));
  return server;
}

if (isDirectRun && process.env.NODE_ENV !== 'test') {
  // Express 5 passes listen errors (for example EADDRINUSE) to this callback instead of emitting them unhandled.
  serverInstance = app.listen(port, (err?: Error) => {
    if (err) throw err;
    warnIfApiOpen((serverInstance.address() as AddressInfo).port);
    console.log(`Agent Viewer ingestion server listening on every interface, port ${port} (http://localhost:${port} from this machine)`);
  });
}

export { app, serverInstance, store };
