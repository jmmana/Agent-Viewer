import { z } from 'zod';

export * from './canonicalTypes';
import {
  CANONICAL_EVENT_TYPES,
  EVENT_TYPE_ALIASES,
  LLM_ERROR_KINDS,
  MESSAGE_KINDS,
  type CanonicalEvent,
  type CanonicalEventType,
  type EventSeverity,
  type ValidationIssue,
  type ValidationResult,
} from './canonicalTypes';

// -------------------------------------------------------------
// Payload Schemas
// -------------------------------------------------------------

const tokenCount = z.number().int().nonnegative('Expected non-negative integer');

const costSchema = z.number().nonnegative('Cost cannot be negative').nullish().default(null);
const costSourceSchema = z.enum(['provider-reported', 'estimated', 'unknown']).nullish().default('unknown');
const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 currency code').nullish();

interface CacheFields {
  inputTokens?: number | null;
  cachedTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

/**
 * Shared by `llm.usage` and `llm.failed`. Runs before the alias transform, so it sees the values as sent.
 */
function checkCacheFields(value: CacheFields, ctx: z.RefinementCtx): void {
  // Conflict: only meaningful for llm.usage (llm.failed has no cachedTokens, so it never fires there).
  if (
    typeof value.cachedTokens === 'number'
    && typeof value.cacheReadTokens === 'number'
    && value.cachedTokens !== value.cacheReadTokens
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['cachedTokens'],
      message: 'cachedTokens is deprecated and conflicts with cacheReadTokens; send only cacheReadTokens',
    });
  }
  // Subset: only the new fields, and only when inputTokens is a number (it may be missing on llm.failed).
  // Values from the legacy cachedTokens are left out on purpose, because older clients used both meanings.
  const explicit = (typeof value.cacheReadTokens === 'number' ? value.cacheReadTokens : 0)
    + (typeof value.cacheWriteTokens === 'number' ? value.cacheWriteTokens : 0);
  if (typeof value.inputTokens === 'number' && explicit > value.inputTokens) {
    ctx.addIssue({
      code: 'custom',
      path: ['cacheReadTokens'],
      message: 'cacheReadTokens + cacheWriteTokens cannot exceed inputTokens (inputTokens includes cached tokens)',
    });
  }
}

/** Deprecated alias: copies cachedTokens (a number or null) into cacheReadTokens when that field is absent. */
function applyCachedAlias<T extends { cachedTokens?: number | null; cacheReadTokens?: number | null }>(value: T): T {
  return value.cacheReadTokens === undefined && value.cachedTokens !== undefined
    ? { ...value, cacheReadTokens: value.cachedTokens }
    : value;
}

/**
 * Payload of a successful model call. Token semantics: `inputTokens` includes `cacheReadTokens` and
 * `cacheWriteTokens`; `outputTokens` includes `reasoningTokens` when the provider bills them as output.
 * A breakdown field that was not reported stays absent (or `null`), never `0`.
 */
export const LlmUsagePayloadSchema = z.object({
  provider: z.string().min(1, 'Provider is required'),
  model: z.string().min(1, 'Model is required'),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheReadTokens: tokenCount.nullish(),
  cacheWriteTokens: tokenCount.nullish(),
  /** @deprecated Use cacheReadTokens. Kept as sent; copied to cacheReadTokens when that field is absent. */
  cachedTokens: tokenCount.nullish(),
  reasoningTokens: tokenCount.nullish(),
  latencyMs: tokenCount.nullish(),
  requestId: z.string().nullish(),
  cost: costSchema,
  costSource: costSourceSchema,
  currency: currencySchema,
}).superRefine(checkCacheFields).transform(applyCachedAlias);

export type LlmUsagePayload = z.infer<typeof LlmUsagePayloadSchema>;

/**
 * Payload of one failed model call attempt. A retry that succeeds is a separate `llm.usage` event.
 * Token and cost fields are filled only when the provider billed the failed attempt; none defaults to 0.
 * There is no free-text error field on purpose: provider messages can echo prompts or credentials.
 */
export const LlmFailedPayloadSchema = z.object({
  provider: z.string().min(1, 'Provider is required'),
  model: z.string().min(1, 'Model is required'),
  errorKind: z.enum(LLM_ERROR_KINDS).default('unknown'),
  httpStatus: z.number().int().min(100).max(599).nullish(),
  retryable: z.boolean().nullish(),
  requestId: z.string().max(200).nullish(),
  providerErrorCode: z.string().max(100).nullish(),
  latencyMs: tokenCount.nullish(),
  inputTokens: tokenCount.nullish(),
  outputTokens: tokenCount.nullish(),
  cacheReadTokens: tokenCount.nullish(),
  cacheWriteTokens: tokenCount.nullish(),
  reasoningTokens: tokenCount.nullish(),
  cost: costSchema,
  costSource: costSourceSchema,
  currency: currencySchema,
}).superRefine(checkCacheFields);

export type LlmFailedPayload = z.infer<typeof LlmFailedPayloadSchema>;

export const AgentRegisteredPayloadSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, 'Name is required'),
  roleTitle: z.string().optional().default('AI Agent'),
  role: z.string().optional().default('custom'),
  team: z.enum(['leadership', 'engineering', 'research', 'quality', 'operations', 'other']).optional().default('other'),
  provider: z.string().optional().default('Custom'),
  model: z.string().optional().default('Custom'),
  managerId: z.string().nullable().optional(),
  workspace: z.string().optional().default('development'),
  status: z.string().optional().default('IDLE'),
  statusText: z.string().optional(),
  avatarColor: z.string().optional(),
});

export const AgentUpdatedPayloadSchema = z.object({
  name: z.string().optional(),
  roleTitle: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  statusText: z.string().optional(),
  workspace: z.string().optional(),
});

export const AgentStatusChangedPayloadSchema = z.object({
  status: z.string().min(1, 'Status is required'),
  statusText: z.string().optional(),
  workspace: z.string().optional(),
  mood: z.string().optional(),
});

export const AgentMessageSentPayloadSchema = z.object({
  text: z.string().min(1, 'Message text is required'),
  targetAgentName: z.string().nullish(),
  targetAgentId: z.string().nullish(),
  kind: z.enum(MESSAGE_KINDS).nullish(),
});

export const TaskCreatedPayloadSchema = z.object({
  id: z.string().nullish(),
  title: z.string().min(1, 'Task title is required'),
  description: z.string().nullish().default(''),
  assignedAgentId: z.string().nullish(),
  collaboratorIds: z.array(z.string()).nullish().default([]),
});

export const TaskAssignedPayloadSchema = z.object({
  taskId: z.string().nullish(),
  assignedAgentId: z.string().min(1, 'assignedAgentId is required'),
  collaboratorIds: z.array(z.string()).nullish(),
});

export const TaskProgressPayloadSchema = z.object({
  taskId: z.string().nullish(),
  progress: z.number().min(0).max(100, 'Progress must be between 0 and 100').nullish(),
  status: z.string().nullish(),
  statusText: z.string().nullish(),
  artifacts: z.array(z.any()).nullish(),
});

export const TaskCompletedPayloadSchema = z.object({
  taskId: z.string().nullish(),
  summary: z.string().nullish(),
  durationMs: z.number().int().nonnegative().nullish(),
});

export const TaskFailedPayloadSchema = z.object({
  taskId: z.string().nullish(),
  error: z.string().nullish(),
  blockerReason: z.string().nullish(),
});

export const TaskBlockedPayloadSchema = z.object({
  taskId: z.string().nullish(),
  reason: z.string().nullish().default('Blocked on dependency'),
});

export const ToolStartedPayloadSchema = z.object({
  tool: z.string().min(1, 'Tool name is required'),
  toolCallId: z.string().nullish(),
  inputSummary: z.string().nullish(),
  category: z.string().nullish(),
});

export const ToolCompletedPayloadSchema = z.object({
  tool: z.string().min(1, 'Tool name is required'),
  toolCallId: z.string().nullish(),
  outputSummary: z.string().nullish(),
  durationMs: z.number().int().nonnegative().nullish(),
});

export const ToolFailedPayloadSchema = z.object({
  tool: z.string().min(1, 'Tool name is required'),
  toolCallId: z.string().nullish(),
  error: z.string().nullish(),
  durationMs: z.number().int().nonnegative().nullish(),
});

export const MeetingRequestedPayloadSchema = z.object({
  meetingId: z.string().optional(),
  title: z.string().min(1, 'Meeting title is required'),
  topic: z.string().optional().default('General discussion'),
  participantIds: z.array(z.string()).min(1, 'At least one participant is required'),
  roomId: z.string().optional(),
});

export const MeetingStartedPayloadSchema = z.object({
  meetingId: z.string().optional(),
  title: z.string().optional(),
  participantIds: z.array(z.string()).optional(),
  roomId: z.string().optional(),
});

export const MeetingMessagePayloadSchema = z.object({
  meetingId: z.string().optional(),
  text: z.string().min(1, 'Message text is required'),
  type: z.enum(MESSAGE_KINDS).optional().default('statement'),
  targetAgentId: z.string().nullish(),
  targetAgentName: z.string().nullish(),
});

export const MeetingEndedPayloadSchema = z.object({
  meetingId: z.string().optional(),
  summary: z.string().optional(),
  decisions: z.array(z.string()).optional(),
});

export const MeetingCancelledPayloadSchema = z.object({
  meetingId: z.string().optional(),
  reason: z.string().optional(),
});

export const RuntimeConnectedPayloadSchema = z.object({
  runtimeId: z.string().optional(),
  name: z.string().optional(),
  framework: z.string().optional(),
  version: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export const RuntimeDisconnectedPayloadSchema = z.object({
  runtimeId: z.string().optional(),
  reason: z.string().optional(),
});

export const RuntimeHeartbeatPayloadSchema = z.object({
  runtimeId: z.string().optional(),
  status: z.string().optional().default('healthy'),
  activeAgentsCount: z.number().int().nonnegative().optional(),
});

// Map of type to schema validator
const PAYLOAD_SCHEMAS: Record<CanonicalEventType, z.ZodTypeAny> = {
  'agent.registered': AgentRegisteredPayloadSchema,
  'agent.updated': AgentUpdatedPayloadSchema,
  'agent.status.changed': AgentStatusChangedPayloadSchema,
  'agent.message.sent': AgentMessageSentPayloadSchema,
  'task.created': TaskCreatedPayloadSchema,
  'task.assigned': TaskAssignedPayloadSchema,
  'task.progress': TaskProgressPayloadSchema,
  'task.completed': TaskCompletedPayloadSchema,
  'task.failed': TaskFailedPayloadSchema,
  'task.blocked': TaskBlockedPayloadSchema,
  'tool.started': ToolStartedPayloadSchema,
  'tool.completed': ToolCompletedPayloadSchema,
  'tool.failed': ToolFailedPayloadSchema,
  'meeting.requested': MeetingRequestedPayloadSchema,
  'meeting.started': MeetingStartedPayloadSchema,
  'meeting.message': MeetingMessagePayloadSchema,
  'meeting.ended': MeetingEndedPayloadSchema,
  'meeting.cancelled': MeetingCancelledPayloadSchema,
  'llm.usage': LlmUsagePayloadSchema,
  'llm.failed': LlmFailedPayloadSchema,
  'runtime.connected': RuntimeConnectedPayloadSchema,
  'runtime.disconnected': RuntimeDisconnectedPayloadSchema,
  'runtime.heartbeat': RuntimeHeartbeatPayloadSchema,
};

// -------------------------------------------------------------
// Canonical Event Envelope
// -------------------------------------------------------------

export const CanonicalEventEnvelopeSchema = z.object({
  schemaVersion: z.literal('1.0').default('1.0'),
  id: z.string().min(1, 'Event ID must be a non-empty string'),
  type: z.string().min(1, 'Event type is required'),
  timestamp: z.number().int().positive('Timestamp must be a positive integer in milliseconds'),
  runtimeId: z.string().nullish(),
  sessionId: z.string().nullish(),
  source: z.string().min(1, 'Source is required'),
  target: z.string().nullish(),
  agentId: z.string().nullish(),
  taskId: z.string().nullish(),
  severity: z.enum(['low', 'normal', 'high', 'critical']).optional().default('normal'),
  summary: z.string().min(1, 'Summary is required'),
  payload: z.record(z.string(), z.any()).default({}),
});

/**
 * Validates an event against the canonical envelope and typed payload.
 * Returns formatted issues with paths and clear error messages.
 */
export function validateCanonicalEvent(input: unknown): ValidationResult<CanonicalEvent> {
  if (!input || typeof input !== 'object') {
    return {
      success: false,
      error: 'validation_failed',
      issues: [{ path: '', message: 'Event body must be an object' }],
    };
  }

  const raw = input as Record<string, any>;
  
  // Resolve type alias if necessary
  const resolvedType = EVENT_TYPE_ALIASES[raw.type] ?? raw.type;

  const envelopeResult = CanonicalEventEnvelopeSchema.safeParse({
    ...raw,
    type: resolvedType,
  });

  if (!envelopeResult.success) {
    const issues: ValidationIssue[] = envelopeResult.error.issues.map((err) => ({
      path: err.path.join('.'),
      message: err.message,
    }));
    return {
      success: false,
      error: 'validation_failed',
      issues,
    };
  }

  const validatedEnvelope = envelopeResult.data;

  // Validate that type is a known canonical type
  if (!CANONICAL_EVENT_TYPES.includes(resolvedType as CanonicalEventType)) {
    return {
      success: false,
      error: 'validation_failed',
      issues: [
        {
          path: 'type',
          message: `Unknown event type "${raw.type}". Expected one of: ${CANONICAL_EVENT_TYPES.join(', ')}`,
        },
      ],
    };
  }

  // Validate payload if schema exists
  const canonicalType = resolvedType as CanonicalEventType;
  const payloadSchema = PAYLOAD_SCHEMAS[canonicalType];
  let validatedPayload: any = validatedEnvelope.payload;

  if (payloadSchema) {
    const payloadResult = payloadSchema.safeParse(validatedEnvelope.payload);
    if (!payloadResult.success) {
      const issues: ValidationIssue[] = payloadResult.error.issues.map((err) => ({
        path: `payload.${err.path.join('.')}`,
        message: err.message,
      }));
      return {
        success: false,
        error: 'validation_failed',
        issues,
      };
    }
    validatedPayload = payloadResult.data;
  }

  // Deduce or normalize agentId
  let agentId = validatedEnvelope.agentId;
  if (!agentId) {
    if (typeof validatedEnvelope.payload?.agentId === 'string') {
      agentId = validatedEnvelope.payload.agentId;
    } else if (typeof validatedEnvelope.payload?.id === 'string' && canonicalType.startsWith('agent.')) {
      agentId = validatedEnvelope.payload.id;
    } else if (validatedEnvelope.source.startsWith('agent:')) {
      agentId = validatedEnvelope.source.replace(/^agent:/, '');
    }
  }

  const canonicalEvent: CanonicalEvent = {
    schemaVersion: '1.0',
    id: validatedEnvelope.id,
    type: canonicalType,
    timestamp: validatedEnvelope.timestamp,
    runtimeId: validatedEnvelope.runtimeId ?? undefined,
    sessionId: validatedEnvelope.sessionId ?? undefined,
    source: validatedEnvelope.source,
    agentId: agentId ?? undefined,
    taskId: (validatedEnvelope.taskId ?? validatedEnvelope.payload?.taskId) ?? undefined,
    severity: validatedEnvelope.severity as EventSeverity,
    summary: validatedEnvelope.summary,
    payload: validatedPayload as Record<string, any>,
  };

  return {
    success: true,
    data: canonicalEvent,
  };
}
