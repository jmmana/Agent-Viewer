/**
 * Canonical event contract V1: constants, types and loose normalization.
 *
 * This module has no runtime dependencies so the embeddable office can import it without pulling the
 * zod validators. Strict validation lives in `canonicalContract.ts`.
 */

export const SCHEMA_VERSION = '1.0' as const;

export const CANONICAL_EVENT_TYPES = [
  'agent.registered',
  'agent.updated',
  'agent.status.changed',
  'agent.message.sent',
  'task.created',
  'task.assigned',
  'task.progress',
  'task.completed',
  'task.failed',
  'task.blocked',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'meeting.requested',
  'meeting.started',
  'meeting.message',
  'meeting.ended',
  'meeting.cancelled',
  'llm.usage',
  'llm.failed',
  'runtime.connected',
  'runtime.disconnected',
  'runtime.heartbeat',
  /** Server-generated only (issue #86): a budget (#85) crossed into `warning` or `exceeded`. `POST /api/v1/events`
   * and `/events/batch` reject a client-submitted event of this type, or whose id starts with `evt_budget_`
   * (`server/budgetAlerts.ts`). */
  'budget.alert',
] as const;

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

/**
 * Server-internal event types (issue #107): recorded in the log (and therefore the hash chain, #105) so key
 * creation and revocation are themselves auditable, but never accepted from a client. Deliberately **not**
 * added to `CANONICAL_EVENT_TYPES`: `validateCanonicalEvent` keeps rejecting a client-submitted event of one of
 * these types with `400 validation_failed`, and `normalizeCanonicalEvent` never produces one. The server writes
 * them with a direct internal `store.append`, bypassing both. Never broadcast to SSE, never passed to
 * `onEventAccepted` listeners (so `--record` files stay canonical V1), and omitted from `GET /api/v1/events` and
 * the snapshot unless `includeAudit=true` or an explicit `type` filter asks for one.
 */
export const AUDIT_EVENT_TYPES = ['audit.key.created', 'audit.key.revoked'] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/**
 * A `CanonicalEvent` as the server actually returns it (issue #107): `submittedBy` is a server-side, read-only
 * fact (the id of the key, `'bootstrap'`, `'webhook'` or `'anonymous'` that submitted it; `null` for an event
 * stored before this item, never back-filled). It is never part of what a client sends: `CanonicalEventInput`
 * is unchanged, and any `submittedBy` a client puts in a request body is ignored. Hosts that replay server
 * events (the SSE stream, `GET /api/v1/events`) can use this type for the extra field; it is purely additive.
 */
export type StoredEvent<T = Record<string, any>> = CanonicalEvent<T> & { readonly submittedBy: string | null };

/** Older or alternative type names that are still accepted and mapped to a V1 type. */
export type LegacyEventType =
  | 'message.sent'
  | 'agent.phone_call.started'
  | 'agent.phone_call.ended'
  | 'meeting.room.reserved'
  | 'meeting.decision'
  | 'task.started'
  | 'approval.requested'
  | 'approval.approved'
  | 'artifact.created';

/** Supported legacy/alternative aliases mapped to canonical V1 types. */
export const EVENT_TYPE_ALIASES: Record<LegacyEventType, CanonicalEventType> & Record<string, CanonicalEventType | undefined> = {
  'message.sent': 'agent.message.sent',
  'agent.phone_call.started': 'meeting.started',
  'agent.phone_call.ended': 'meeting.ended',
  'meeting.room.reserved': 'meeting.started',
  'meeting.decision': 'meeting.message',
  'task.started': 'task.progress',
  'approval.requested': 'task.blocked',
  'approval.approved': 'task.progress',
  'artifact.created': 'task.progress',
};

/**
 * What a message does in a conversation. Shown as the header of the speech bubble.
 * `statement` is the default when a runtime does not classify its messages.
 */
export const MESSAGE_KINDS = [
  'statement',
  'proposal',
  'question',
  'answer',
  'objection',
  'critique',
  'agreement',
  'summary',
  'decision',
] as const;

export type MessageKind = (typeof MESSAGE_KINDS)[number];

export function isMessageKind(value: unknown): value is MessageKind {
  return typeof value === 'string' && (MESSAGE_KINDS as readonly string[]).includes(value);
}

/**
 * Why a model call failed, carried by `llm.failed`. A label, not a figure. Senders map errors they do not
 * recognize to `unknown` and may put the provider's own code in `providerErrorCode`.
 */
export const LLM_ERROR_KINDS = [
  'rate_limited',
  'overloaded',
  'timeout',
  'invalid_request',
  'auth',
  'server_error',
  'cancelled',
  /** A call that never got an HTTP response at all (connection failure). Added by issue #59 (OTLP receiver):
   * Claude Code's `api_error` event reports no `status_code` for this case, and `timeout` already means
   * something more specific (a request that did get a response, just too slowly, or was cancelled locally). */
  'network',
  'unknown',
] as const;

export type LlmErrorKind = (typeof LLM_ERROR_KINDS)[number];

export function isLlmErrorKind(value: unknown): value is LlmErrorKind {
  return typeof value === 'string' && (LLM_ERROR_KINDS as readonly string[]).includes(value);
}

export type EventSeverity = 'low' | 'normal' | 'high' | 'critical';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  issues?: ValidationIssue[];
  error?: string;
}

export interface CanonicalEvent<T = Record<string, any>> {
  schemaVersion: '1.0';
  id: string;
  type: CanonicalEventType;
  timestamp: number;
  runtimeId?: string;
  sessionId?: string;
  source: string;
  agentId?: string;
  taskId?: string;
  severity: EventSeverity;
  summary: string;
  payload: T;
}

/**
 * What a runtime or host sends. The type is checked at compile time; envelope fields the office can
 * complete on its own (`schemaVersion`, `severity`, `source`, `summary`, `payload`) are optional.
 */
export interface CanonicalEventInput<T = Record<string, unknown>> {
  schemaVersion?: '1.0';
  id: string;
  type: CanonicalEventType | LegacyEventType;
  /** Milliseconds since the epoch, or an ISO 8601 string. */
  timestamp: number | string;
  runtimeId?: string;
  sessionId?: string;
  source?: string;
  agentId?: string;
  target?: string;
  taskId?: string;
  severity?: EventSeverity;
  summary?: string;
  payload?: T;
}

/**
 * Id for an event that arrived without one: `crypto.randomUUID()` when the platform has it, and the older
 * clock plus `Math.random` form otherwise, so the library still runs in browsers without `randomUUID`.
 */
function generatedEventId(now: number): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `evt_${cryptoApi.randomUUID()}`;
  }
  return `evt_${now}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Normalizes any loose input into a valid CanonicalEvent V1, generating missing IDs or timestamps if needed.
 */
export function normalizeCanonicalEvent(input: any): CanonicalEvent {
  const now = Date.now();
  const id = input?.id && typeof input.id === 'string' && input.id.length > 0
    ? input.id
    : generatedEventId(now);

  const rawType = typeof input?.type === 'string' ? input.type : 'agent.status.changed';
  const type: CanonicalEventType = EVENT_TYPE_ALIASES[rawType] ?? (
    CANONICAL_EVENT_TYPES.includes(rawType as CanonicalEventType) ? rawType : 'agent.status.changed'
  );

  const timestamp = typeof input?.timestamp === 'number' && input.timestamp > 0
    ? Math.floor(input.timestamp)
    : (typeof input?.timestamp === 'string' && !isNaN(Date.parse(input.timestamp))
      ? Date.parse(input.timestamp)
      : now);

  const source = typeof input?.source === 'string' && input.source.length > 0
    ? input.source
    : (input?.agentId ? `agent:${input.agentId}` : 'external-runtime');

  // Same order as the strict validator: envelope, payload.agentId, payload.id for agent.* events, then source.
  const agentId = typeof input?.agentId === 'string'
    ? input.agentId
    : (typeof input?.payload?.agentId === 'string'
      ? input.payload.agentId
      : (typeof input?.payload?.id === 'string' && type.startsWith('agent.')
        ? input.payload.id
        : (source.startsWith('agent:') ? source.replace(/^agent:/, '') : undefined)));

  const summary = typeof input?.summary === 'string' && input.summary.length > 0
    ? input.summary
    : `${type} event received`;

  const payload = input?.payload && typeof input.payload === 'object' ? { ...input.payload } : {};

  // Usage and failure payloads: unknown figures stay unknown. Token counts are never invented here.
  if (type === 'llm.usage' || type === 'llm.failed') {
    if (payload.cost === undefined) payload.cost = null;
    if (!payload.costSource) payload.costSource = 'unknown';
  }
  if (
    type === 'llm.usage'
    && payload.cacheReadTokens === undefined
    && (typeof payload.cachedTokens === 'number' || payload.cachedTokens === null)
  ) {
    // Deprecated alias, copied as the strict validator does. The normalizer never rejects a conflict.
    payload.cacheReadTokens = payload.cachedTokens;
  }
  if (type === 'llm.failed' && !isLlmErrorKind(payload.errorKind)) {
    payload.errorKind = 'unknown';
  }

  return {
    schemaVersion: '1.0',
    id,
    type,
    timestamp,
    runtimeId: typeof input?.runtimeId === 'string' ? input.runtimeId : undefined,
    sessionId: typeof input?.sessionId === 'string' ? input.sessionId : undefined,
    source,
    agentId,
    taskId: typeof input?.taskId === 'string' ? input.taskId : (typeof payload.taskId === 'string' ? payload.taskId : undefined),
    severity: (['low', 'normal', 'high', 'critical'].includes(input?.severity) ? input.severity : 'normal') as EventSeverity,
    summary,
    payload,
  };
}
