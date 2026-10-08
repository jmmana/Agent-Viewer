import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import {
  type CanonicalEvent,
  validateCanonicalEvent,
  normalizeCanonicalEvent,
  ValidationIssue,
} from '../src/integrations/canonicalContract';
import type { AgentStatus } from '../src/types/agent';
import { createEventStore, type EventStore } from './store';

/**
 * Set by the `agent-viewer` CLI before it imports this module. The CLI configures the server through its own
 * flags, so it neither reads a `.env` file from the user's directory nor lets this module listen on its own.
 */
const embedded = process.env.AGENT_VIEWER_EMBEDDED === '1';

// dotenv is a development dependency: the published CLI runs embedded and never loads it.
if (!embedded) {
  const dotenv = await import('dotenv');
  dotenv.config({ quiet: true });
}

const app = express();
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

const store: EventStore = createEventStore();
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

app.options('*', (_req, res) => {
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
/**
 * Single source of the version: package.json, the same number the release tag uses. The file is looked up
 * from this module's folder upwards, so the lookup works from the TypeScript sources and from the bundled CLI.
 */
function readPackageVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
      if (pkg.name === '@warlockcode/agent-viewer' && typeof pkg.version === 'string') return pkg.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}
const SERVER_VERSION: string = readPackageVersion();

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    status: 'healthy',
    service: 'agent-viewer',
    version: SERVER_VERSION,
    schemaVersion: '1.0',
    clientsConnected: clients.size,
  });
});

app.get('/ready', async (_req, res) => {
  try {
    const storageType = process.env.AGENT_VIEWER_STORAGE || 'memory';
    res.json({
      ok: true,
      ready: true,
      storage: storageType,
    });
  } catch (err: any) {
    res.status(503).json({ ok: false, ready: false, error: err?.message || 'Storage error' });
  }
});

/** Listeners told about every event the server accepts, in the order they are broadcast (used by `--record`). */
const acceptedEventListeners = new Set<(event: CanonicalEvent) => void>();

/** Calls `listener` with each accepted event. Returns a function that removes the listener. */
export function onEventAccepted(listener: (event: CanonicalEvent) => void): () => void {
  acceptedEventListeners.add(listener);
  return () => acceptedEventListeners.delete(listener);
}

// Helper to broadcast event to SSE subscribers (without named event so EventSource.onmessage receives all)
function broadcastEvent(event: CanonicalEvent) {
  for (const listener of acceptedEventListeners) {
    try {
      listener(event);
    } catch {
      // A failing listener must never break ingestion.
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

// -------------------------------------------------------------
// Event Ingestion (Single)
// -------------------------------------------------------------
app.post('/api/v1/events', async (req, res) => {
  const idempotencyKey = req.header('idempotency-key');
  let body = req.body;

  if (idempotencyKey && !body.id) {
    body = { ...body, id: idempotencyKey };
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

  if (result.duplicate) {
    res.status(200).json({
      accepted: true,
      duplicate: true,
      id: event.id,
    });
    return;
  }

  broadcastEvent(event);

  res.status(202).json({
    accepted: true,
    duplicate: false,
    id: event.id,
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

  const { accepted, duplicates, acceptedEvents } = await store.appendBatch(validatedEvents);

  for (const event of acceptedEvents) {
    broadcastEvent(event);
  }

  res.status(202).json({
    accepted,
    duplicates,
    total: rawEvents.length,
    results: validatedEvents.map((e) => ({
      id: e.id,
      duplicate: !acceptedEvents.some((acc) => acc.id === e.id),
    })),
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
  res.json({
    schemaVersion: '1.0',
    count: events.length,
    events,
  });
});

// -------------------------------------------------------------
// Snapshot
// -------------------------------------------------------------
app.get('/api/v1/snapshot', async (_req, res) => {
  const snapshot = await store.snapshot();
  res.json(snapshot);
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

  res.write(': connected\n\n');
  clients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\nevent: heartbeat\ndata: {}\n\n');
    } catch {
      // client disconnected
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

// -------------------------------------------------------------
// Agent Management
// -------------------------------------------------------------
app.post('/api/v1/agents', async (req, res) => {
  const { id, name, roleTitle, role, provider, model, workspace, status, statusText } = req.body ?? {};
  if (!id || typeof id !== 'string' || !name || typeof name !== 'string') {
    res.status(400).json({ error: 'validation_failed', message: 'Fields "id" and "name" are required' });
    return;
  }

  const agent = await store.upsertAgent({
    id,
    name,
    roleTitle,
    role,
    provider,
    model,
    workspace,
    status: status || 'IDLE',
    statusText: statusText || 'Registered',
  });

  const regEvent: CanonicalEvent = {
    schemaVersion: '1.0',
    id: `evt_reg_${id}_${Date.now()}`,
    type: 'agent.registered',
    timestamp: Date.now(),
    source: `agent:${id}`,
    agentId: id,
    severity: 'normal',
    summary: `Registered ${name}`,
    payload: { id, name, roleTitle, provider, model, workspace },
  };

  await store.append(regEvent);
  broadcastEvent(regEvent);

  res.status(201).json(agent);
});

app.patch('/api/v1/agents/:agentId', async (req, res) => {
  const agentId = req.params.agentId;
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
  const changes = body as Record<string, any>;

  let status: AgentStatus | undefined;
  if (changes.status !== undefined && changes.status !== null) {
    const normalized = typeof changes.status === 'string' ? changes.status.trim().toUpperCase() : '';
    if (!AGENT_STATUS_SET.has(normalized)) {
      const message = `Invalid status "${String(changes.status).slice(0, 100)}". Expected one of: ${AGENT_STATUSES.join(', ')}`;
      res.status(400).json({ error: 'validation_failed', message, issues: [{ path: 'status', message }] });
      return;
    }
    status = normalized as AgentStatus;
  }

  // The path id always wins over any id in the body.
  const updated = await store.upsertAgent({
    ...changes,
    id: agentId,
    status: status ?? existing.status,
  });

  // Emit status change or update event
  if (status) {
    const statusEvt: CanonicalEvent = {
      schemaVersion: '1.0',
      id: `evt_status_${agentId}_${Date.now()}`,
      type: 'agent.status.changed',
      timestamp: Date.now(),
      source: `agent:${agentId}`,
      agentId,
      severity: 'normal',
      summary: `${agentId} status updated to ${status}`,
      payload: { status, statusText: changes.statusText, workspace: changes.workspace },
    };
    await store.append(statusEvt);
    broadcastEvent(statusEvt);
  }

  res.json(updated);
});

// -------------------------------------------------------------
// Runtimes & Sessions
// -------------------------------------------------------------
app.post('/api/v1/runtimes', async (req, res) => {
  const { id, name, framework, version, metadata } = req.body ?? {};
  if (!id || typeof id !== 'string') {
    res.status(400).json({ error: 'validation_failed', message: 'Field "id" is required' });
    return;
  }

  const runtime = await store.upsertRuntime({ id, name, framework, version, metadata });
  const event: CanonicalEvent = {
    schemaVersion: '1.0',
    id: `evt_rt_${id}_${Date.now()}`,
    type: 'runtime.connected',
    timestamp: Date.now(),
    runtimeId: id,
    source: `runtime:${id}`,
    severity: 'normal',
    summary: `Runtime ${id} connected`,
    payload: { id, name, framework, version, metadata },
  };
  await store.append(event);
  broadcastEvent(event);

  res.status(201).json(runtime);
});

app.get('/api/v1/runtimes', async (_req, res) => {
  const runtimes = await store.listRuntimes();
  res.json({ runtimes });
});

app.get('/api/v1/sessions', async (_req, res) => {
  const sessions = await store.listSessions();
  res.json({ sessions });
});

app.get('/api/v1/sessions/:sessionId', async (req, res) => {
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
  usage: z
    .object({
      provider: z.string().max(100).optional(),
      model: z.string().max(100).optional(),
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      cachedTokens: z.number().int().nonnegative().optional(),
      reasoningTokens: z.number().int().nonnegative().optional(),
      cost: z.number().nonnegative().optional(),
      latencyMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

/** Signatures already accepted, mapped to the time after which their timestamp is outside the window anyway. */
const seenWebhookSignatures = new Map<string, number>();

/** Records a verified signature. Returns false when the same signature was already accepted inside the window. */
function rememberWebhookSignature(signature: string, expiresAt: number, now: number): boolean {
  const seenUntil = seenWebhookSignatures.get(signature);
  if (seenUntil !== undefined && seenUntil > now) return false;

  if (seenWebhookSignatures.size >= webhookReplayCacheMax) {
    for (const [key, until] of seenWebhookSignatures) {
      if (until <= now) seenWebhookSignatures.delete(key);
    }
    // Still full: evict the oldest entries. Only verified signatures get here, so filling it needs the secret.
    for (const key of seenWebhookSignatures.keys()) {
      if (seenWebhookSignatures.size < webhookReplayCacheMax) break;
      seenWebhookSignatures.delete(key);
    }
  }

  seenWebhookSignatures.set(signature, expiresAt);
  return true;
}

app.post('/api/v1/webhooks/generic', async (req, res) => {
  const secret = process.env.AGENT_VIEWER_WEBHOOK_SECRET;

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
    const now = Date.now();
    // Replay protection, part 1: the timestamp must be within 5 minutes
    if (isNaN(timestamp) || Math.abs(now - timestamp) > webhookToleranceMs) {
      res.status(401).json({
        error: 'replay_detected_or_clock_skew',
        message: 'Webhook timestamp is expired or too far in the future',
      });
      return;
    }

    const rawBody = (req as any).rawBody?.toString('utf-8') ?? JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', secret).update(`${timestampStr}.${rawBody}`).digest('hex');

    if (!safeEqual(signature, expected)) {
      res.status(401).json({
        error: 'invalid_webhook_signature',
        message: 'HMAC signature verification failed',
      });
      return;
    }

    // Replay protection, part 2: each signed request is accepted once inside the window
    if (!rememberWebhookSignature(expected, timestamp + webhookToleranceMs, now)) {
      res.status(409).json({
        error: 'webhook_replay_detected',
        message: 'This signed webhook was already accepted. Sign each delivery with a new timestamp',
      });
      return;
    }
  }

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
  const hasUsage = payload.usage !== undefined && Object.keys(payload.usage).length > 0;
  if (!payload.status && !payload.message && !payload.text && !payload.tool && !hasUsage) {
    res.status(400).json({
      error: 'unrecognized_webhook_payload',
      message:
        'Webhook payload does not describe any agent activity. Include at least one of "status", "message", "text", "tool" or a non-empty "usage" object',
    });
    return;
  }

  const agentName = payload.agent || payload.agentId || 'generic-agent';
  const status = payload.status || (payload.message || payload.text ? 'THINKING' : 'IDLE');
  const message = payload.message || payload.text;
  const tool = payload.tool;
  const usage = payload.usage;

  const generatedEvents: CanonicalEvent[] = [];

  // Generate status changed event
  generatedEvents.push(
    normalizeCanonicalEvent({
      id: `evt_wh_status_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: 'agent.status.changed',
      agentId: agentName,
      source: `agent:${agentName}`,
      summary: `${agentName} → ${status}`,
      payload: { status, statusText: payload.statusText || status },
    })
  );

  // Generate message sent event if present
  if (message) {
    generatedEvents.push(
      normalizeCanonicalEvent({
        id: `evt_wh_msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'agent.message.sent',
        agentId: agentName,
        source: `agent:${agentName}`,
        summary: `${agentName}: ${message.slice(0, 60)}`,
        payload: { text: message },
      })
    );
  }

  // Generate tool started event if present
  if (tool) {
    generatedEvents.push(
      normalizeCanonicalEvent({
        id: `evt_wh_tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'tool.started',
        agentId: agentName,
        source: `agent:${agentName}`,
        summary: `${agentName} using ${tool}`,
        payload: { tool },
      })
    );
  }

  // Generate usage event if present
  if (usage && typeof usage === 'object') {
    generatedEvents.push(
      normalizeCanonicalEvent({
        id: `evt_wh_usage_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: 'llm.usage',
        agentId: agentName,
        source: `agent:${agentName}`,
        summary: `${agentName} LLM usage reported`,
        payload: usage,
      })
    );
  }

  const { accepted, acceptedEvents } = await store.appendBatch(generatedEvents);
  for (const evt of acceptedEvents) {
    broadcastEvent(evt);
  }

  res.status(202).json({
    accepted: true,
    eventsGenerated: generatedEvents.length,
    acceptedCount: accepted,
    eventIds: generatedEvents.map((e) => e.id),
  });
});

// Safe global error handler returning JSON without stack traces or absolute paths
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = typeof err?.status === 'number' ? err.status : 500;
  res.status(status).json({
    error: err?.code || 'internal_server_error',
    message: err?.message ? String(err.message).slice(0, 200) : 'An internal error occurred',
  });
});

let serverInstance: any = null;
const isDirectRun =
  !embedded &&
  process.argv[1] &&
  (process.argv[1].endsWith('server/index.ts') ||
    process.argv[1].endsWith('server/index.js') ||
    process.argv[1].endsWith('server') ||
    (process.env.npm_lifecycle_event === 'server'));

/** Starts listening. Without `host` it binds every interface, as before; the CLI passes `127.0.0.1`. */
export function startServer(portToListen = port, host?: string): Server {
  return host ? app.listen(portToListen, host) : app.listen(portToListen);
}

if (isDirectRun && process.env.NODE_ENV !== 'test') {
  serverInstance = app.listen(port, () => {
    console.log(`Agent Viewer ingestion server listening on http://localhost:${port}`);
  });
}

export { app, serverInstance, store };
