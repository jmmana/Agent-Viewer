import { z } from 'zod';

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
  'runtime.connected',
  'runtime.disconnected',
  'runtime.heartbeat',
] as const;

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

// Supported legacy/alternative aliases mapped to canonical V1 types
export const EVENT_TYPE_ALIASES: Record<string, CanonicalEventType> = {
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

// -------------------------------------------------------------
// Payload Schemas
// -------------------------------------------------------------

export const LlmUsagePayloadSchema = z.object({
  provider: z.string().min(1, 'Provider is required'),
  model: z.string().min(1, 'Model is required'),
  inputTokens: z.number().int().nonnegative('Expected non-negative integer'),
  outputTokens: z.number().int().nonnegative('Expected non-negative integer'),
  cachedTokens: z.number().int().nonnegative('Expected non-negative integer').optional().default(0),
  reasoningTokens: z.number().int().nonnegative('Expected non-negative integer').optional().default(0),
  latencyMs: z.number().int().nonnegative('Expected non-negative integer').optional(),
  requestId: z.string().optional(),
  cost: z.number().nonnegative('Cost cannot be negative').nullable().optional().default(null),
  costSource: z.enum(['provider-reported', 'estimated', 'unknown']).optional().default('unknown'),
});

export type LlmUsagePayload = z.infer<typeof LlmUsagePayloadSchema>;

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
  targetAgentName: z.string().optional(),
  targetAgentId: z.string().optional(),
});

export const TaskCreatedPayloadSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1, 'Task title is required'),
  description: z.string().optional().default(''),
  assignedAgentId: z.string().optional(),
  collaboratorIds: z.array(z.string()).optional().default([]),
});

export const TaskAssignedPayloadSchema = z.object({
  taskId: z.string().optional(),
  assignedAgentId: z.string().min(1, 'assignedAgentId is required'),
  collaboratorIds: z.array(z.string()).optional(),
});

export const TaskProgressPayloadSchema = z.object({
  taskId: z.string().optional(),
  progress: z.number().min(0).max(100, 'Progress must be between 0 and 100').optional(),
  status: z.string().optional(),
  statusText: z.string().optional(),
  artifacts: z.array(z.any()).optional(),
});

export const TaskCompletedPayloadSchema = z.object({
  taskId: z.string().optional(),
  summary: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const TaskFailedPayloadSchema = z.object({
  taskId: z.string().optional(),
  error: z.string().optional(),
  blockerReason: z.string().optional(),
});

export const TaskBlockedPayloadSchema = z.object({
  taskId: z.string().optional(),
  reason: z.string().optional().default('Blocked on dependency'),
});

export const ToolStartedPayloadSchema = z.object({
  tool: z.string().min(1, 'Tool name is required'),
  toolCallId: z.string().optional(),
  inputSummary: z.string().optional(),
  category: z.string().optional(),
});

export const ToolCompletedPayloadSchema = z.object({
  tool: z.string().min(1, 'Tool name is required'),
  toolCallId: z.string().optional(),
  outputSummary: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const ToolFailedPayloadSchema = z.object({
  tool: z.string().min(1, 'Tool name is required'),
  toolCallId: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
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
  type: z.enum(['statement', 'proposal', 'decision', 'question']).optional().default('statement'),
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
  runtimeId: z.string().optional(),
  sessionId: z.string().optional(),
  source: z.string().min(1, 'Source is required'),
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  severity: z.enum(['low', 'normal', 'high', 'critical']).optional().default('normal'),
  summary: z.string().min(1, 'Summary is required'),
  payload: z.record(z.string(), z.any()).default({}),
});

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
    runtimeId: validatedEnvelope.runtimeId,
    sessionId: validatedEnvelope.sessionId,
    source: validatedEnvelope.source,
    agentId,
    taskId: validatedEnvelope.taskId ?? validatedEnvelope.payload?.taskId,
    severity: validatedEnvelope.severity as EventSeverity,
    summary: validatedEnvelope.summary,
    payload: validatedPayload as Record<string, any>,
  };

  return {
    success: true,
    data: canonicalEvent,
  };
}

/**
 * Normalizes any loose input into a valid CanonicalEvent V1, generating missing IDs or timestamps if needed.
 */
export function normalizeCanonicalEvent(input: any): CanonicalEvent {
  const now = Date.now();
  const id = input?.id && typeof input.id === 'string' && input.id.length > 0
    ? input.id
    : `evt_${now}_${Math.random().toString(36).slice(2, 9)}`;

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

  let agentId = typeof input?.agentId === 'string'
    ? input.agentId
    : (typeof input?.payload?.agentId === 'string'
      ? input.payload.agentId
      : (source.startsWith('agent:') ? source.replace(/^agent:/, '') : undefined));

  const summary = typeof input?.summary === 'string' && input.summary.length > 0
    ? input.summary
    : `${type} event received`;

  const payload = input?.payload && typeof input.payload === 'object' ? { ...input.payload } : {};

  // Normalize usage payload if type is llm.usage
  if (type === 'llm.usage') {
    if (payload.cost === undefined) payload.cost = null;
    if (!payload.costSource) payload.costSource = 'unknown';
    if (typeof payload.inputTokens !== 'number') payload.inputTokens = 0;
    if (typeof payload.outputTokens !== 'number') payload.outputTokens = 0;
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
