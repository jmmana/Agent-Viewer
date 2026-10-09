import type { z } from 'zod';
import type {
  CanonicalEvent,
  CanonicalEventType,
  EventSeverity,
  LlmUsagePayloadSchema,
  LlmFailedPayloadSchema,
} from '../../src/integrations/canonicalContract';
import type { LlmErrorKind } from '../../src/integrations/canonicalTypes';
import type { ViewerSnapshot } from '../../server/store';
import type { UsageSummary } from '../../server/usageAggregates';
import type { CallRecord } from '../../server/usage/types';

export type { ViewerSnapshot } from '../../server/store';
export type { CallRecord, CallTokenFigures, CallTrace, CallStatus } from '../../server/usage/types';
export type {
  UsageSummary,
  UsageAggregate,
  UsageBucket,
  ModelUsage,
  AgentUsage,
  TokenFigure,
  CurrencyCost,
} from '../../server/usageAggregates';

/** Where a reported cost comes from. The SDK never chooses it for the caller. */
export type CostSource = 'provider-reported' | 'estimated' | 'unknown';

const COST_SOURCES: readonly CostSource[] = ['provider-reported', 'estimated', 'unknown'];

/** Usage payload as the contract accepts it, so a renamed contract field fails type checking here. */
type LlmUsagePayloadInput = z.input<typeof LlmUsagePayloadSchema>;
/** Same for the `llm.failed` payload. */
type LlmFailedPayloadInput = z.input<typeof LlmFailedPayloadSchema>;

const UNSTATED_COST_SOURCE_WARNING =
  "[AgentViewer] a cost was reported without costSource, so it is sent as costSource: 'unknown'. "
  + "Pass costSource: 'provider-reported' or 'estimated' to state where the cost comes from.";

/** Turns `null` into `undefined`, so an unknown figure is left out of the JSON body. */
function omitNull<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

// -------------------------------------------------------------
// Usage correlation block (issue #64)
// -------------------------------------------------------------
//
// This SDK ships standalone and must not import the server contract at runtime (only `import type`,
// erased at build time, is used above). So the three limits and the whitespace rule are kept here as an
// explicit copy, and `tests/fixtures/usage-correlation-vectors.json` is the shared test-vector file that
// keeps this copy, the server contract and the Python SDK from drifting apart.

const CORRELATION_ID_MAX_LENGTH = 128;
const USAGE_TAGS_MAX = 20;
const USAGE_TAG_MAX_LENGTH = 64;

/** Same exact whitespace set as `String.prototype.trim` (`value !== value.trim()`); see canonicalContract.ts. */
const TRIMMABLE_WHITESPACE_CLASS =
  '\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF';
const LEADING_OR_TRAILING_WHITESPACE = new RegExp(`^[${TRIMMABLE_WHITESPACE_CLASS}]|[${TRIMMABLE_WHITESPACE_CLASS}]$`);
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/** Correlation and attribution fields shared by `usage()` and `llmFailed()`. All optional, never truncated. */
export interface UsageCorrelation {
  traceId?: string;
  parentId?: string;
  toolCallId?: string;
  meetingId?: string;
  userId?: string;
  tags?: readonly string[];
}

export interface ToolCallOptions {
  toolCallId?: string;
}

/**
 * Validates one correlation id field with the same rules as the server: 1 to 128 UTF-16 code units, no
 * control characters, no leading or trailing whitespace. Zod-style `.length` counting is avoided on
 * purpose, since some validators count Unicode code points instead of UTF-16 code units for astral
 * characters; `String.length` always counts UTF-16 code units, matching the server exactly.
 */
function validateCorrelationId(name: string, value: unknown, path: string, issues: Array<{ path: string; message: string }>): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    issues.push({ path, message: `${name} must be a string` });
    return;
  }
  if (value.length < 1) {
    issues.push({ path, message: `${name} must not be empty` });
  } else if (value.length > CORRELATION_ID_MAX_LENGTH) {
    issues.push({ path, message: `${name} must be at most ${CORRELATION_ID_MAX_LENGTH} characters` });
  } else if (CONTROL_CHARACTERS.test(value)) {
    issues.push({ path, message: `${name} must not contain control characters` });
  } else if (LEADING_OR_TRAILING_WHITESPACE.test(value)) {
    issues.push({ path, message: `${name} must not have leading or trailing whitespace` });
  }
}

function validateUsageTags(tags: unknown, path: string, issues: Array<{ path: string; message: string }>): void {
  if (tags === undefined || tags === null) return;
  if (typeof tags === 'string' || !Array.isArray(tags)) {
    issues.push({ path, message: 'tags must be an array of strings' });
    return;
  }
  if (tags.length > USAGE_TAGS_MAX) {
    issues.push({ path, message: `At most ${USAGE_TAGS_MAX} tags are allowed` });
  }
  tags.forEach((tag: unknown, index: number) => {
    const tagPath = `${path}.${index}`;
    if (typeof tag !== 'string') {
      issues.push({ path: tagPath, message: 'Each tag must be a string' });
      return;
    }
    if (tag.length < 1) {
      issues.push({ path: tagPath, message: 'Each tag must not be empty' });
    } else if (tag.length > USAGE_TAG_MAX_LENGTH) {
      issues.push({ path: tagPath, message: `Each tag must be at most ${USAGE_TAG_MAX_LENGTH} characters` });
    } else if (CONTROL_CHARACTERS.test(tag)) {
      issues.push({ path: tagPath, message: 'Each tag must not contain control characters' });
    } else if (LEADING_OR_TRAILING_WHITESPACE.test(tag)) {
      issues.push({ path: tagPath, message: 'Each tag must not have leading or trailing whitespace' });
    }
  });
}

/**
 * Validates the six correlation fields and throws `AgentViewerError` with the same `{ path, message }`
 * shape the server returns (`status` left `undefined`, since nothing was sent) when any is invalid. Never
 * truncates. Called before building the payload, so an invalid value never reaches the network.
 */
function validateUsageCorrelationOrThrow(options: UsageCorrelation): void {
  const issues: Array<{ path: string; message: string }> = [];
  validateCorrelationId('traceId', options.traceId, 'payload.traceId', issues);
  validateCorrelationId('parentId', options.parentId, 'payload.parentId', issues);
  validateCorrelationId('toolCallId', options.toolCallId, 'payload.toolCallId', issues);
  validateCorrelationId('meetingId', options.meetingId, 'payload.meetingId', issues);
  validateCorrelationId('userId', options.userId, 'payload.userId', issues);
  validateUsageTags(options.tags, 'payload.tags', issues);
  if (issues.length > 0) {
    throw new AgentViewerError('Invalid usage correlation fields', undefined, issues);
  }
}

/** Copies the six correlation fields into a payload object, only when defined (never `undefined` or `null` on the wire). */
function buildCorrelationPayload(options: UsageCorrelation): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (options.traceId !== undefined) payload.traceId = options.traceId;
  if (options.parentId !== undefined) payload.parentId = options.parentId;
  if (options.toolCallId !== undefined) payload.toolCallId = options.toolCallId;
  if (options.meetingId !== undefined) payload.meetingId = options.meetingId;
  if (options.userId !== undefined) payload.userId = options.userId;
  if (options.tags !== undefined) payload.tags = options.tags;
  return payload;
}

export interface AgentViewerOptions {
  url?: string;
  baseUrl?: string; // alias for url
  apiKey?: string;
  token?: string; // alias for apiKey
  runtimeId?: string;
  sessionId?: string;
  source?: string;
  timeoutMs?: number;
  maxRetries?: number;
  debug?: boolean;
  autoRegisterAgents?: boolean;
}

export interface AgentInitOptions {
  id: string;
  name?: string;
  roleTitle?: string;
  provider?: string;
  model?: string;
  workspace?: string;
}

export interface EmitEventInput {
  id?: string;
  type: string;
  timestamp?: number;
  source?: string;
  target?: string;
  taskId?: string;
  agentId?: string;
  severity?: EventSeverity;
  summary?: string;
  payload?: Record<string, unknown>;
}

export interface UsageOptions extends UsageCorrelation {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Legacy name of cacheReadTokens in the contract; prefer cacheReadTokens. */
  cachedTokens?: number | null;
  reasoningTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  cost?: number | null;
  costSource?: CostSource | null;
  /** ISO 4217 code, forwarded as given. No default. */
  currency?: string | null;
  latencyMs?: number;
  requestId?: string;
  /** Goes to the envelope `taskId`, not to the payload. */
  taskId?: string;
}

/**
 * Options for `llmFailed()`: the payload of one failed model call attempt (issue #64), plus the same
 * correlation fields as `usage()`. A retry that succeeds is reported as a separate `usage()` call. There is
 * no free-text error field on purpose: provider messages can echo prompts or credentials.
 */
export interface LlmFailedOptions extends UsageCorrelation {
  provider: string;
  /** Optional: a connection failure before a model was chosen never invents one. */
  model?: string | null;
  errorKind?: LlmErrorKind;
  httpStatus?: number | null;
  retryable?: boolean | null;
  requestId?: string | null;
  providerErrorCode?: string | null;
  /** Attempts made before giving up, including the first one. */
  attempts?: number | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  cost?: number | null;
  costSource?: CostSource | null;
  currency?: string | null;
  /** Goes to the envelope `taskId`, not to the payload. */
  taskId?: string;
}

/**
 * Error raised when the server refuses a request or cannot be reached.
 *
 * `code` is the `error` field of the response body when there is one. `'conflicting_duplicate'` (status 409) means
 * an event with the same id was already stored with different content: the new event was not applied, and
 * resending it will never succeed. Give each distinct event its own id, and resend the identical event (same
 * `timestamp`) only to retry. The client never retries a 409.
 */
export class AgentViewerError extends Error {
  public readonly status?: number;
  public readonly issues?: Array<{ path: string; message: string }>;
  public readonly code?: string;

  constructor(message: string, status?: number, issues?: Array<{ path: string; message: string }>, code?: string) {
    super(message);
    this.name = 'AgentViewerError';
    this.status = status;
    this.issues = issues;
    this.code = code;
  }
}

// -------------------------------------------------------------
// GET /api/v1/usage/calls (issue #67): metadata-only, cursor-paginated ledger rows.
// -------------------------------------------------------------

/**
 * Filters for `listCalls` / `iterateCalls`, mapped to the query parameters `GET /api/v1/usage/calls` accepts
 * (`server/usage/filters.ts`). `from`/`to` are passed through unmodified (epoch ms or an ISO 8601 date-time
 * with an explicit offset): the SDK never reformats a date, so a caller's own offset is never silently dropped.
 * Every repeatable filter accepts either one value or a list, sent as repeated query parameters.
 */
export interface ListCallsOptions {
  from?: number | string;
  to?: number | string;
  timeBasis?: 'received' | 'occurred';
  agentId?: string | readonly string[];
  sessionId?: string | readonly string[];
  runtimeId?: string | readonly string[];
  taskId?: string | readonly string[];
  provider?: string | readonly string[];
  model?: string | readonly string[];
  status?: string | readonly string[];
  costSource?: CostSource | readonly CostSource[];
  currency?: string | readonly string[];
  requestId?: string | readonly string[];
  traceId?: string;
  order?: 'desc' | 'asc';
  limit?: number;
  cursor?: string;
}

export interface CallsPageInfo {
  limit: number;
  order: 'desc' | 'asc';
  hasMore: boolean;
  nextCursor: string | null;
}

export interface CallsPageResult {
  schemaVersion: string;
  asOf: number;
  storage: 'memory' | 'sqlite';
  data: CallRecord[];
  page: CallsPageInfo;
}

/** What the server did with one item of a batch. */
export type EmitBatchItemStatus = 'accepted' | 'duplicate' | 'conflict';

export interface EmitBatchItemResult {
  id: string;
  status: EmitBatchItemStatus;
  duplicate: boolean;
  /** `sha256:<hex>` of the event as the server validated it. */
  fingerprint?: string;
  /** `'conflicting_duplicate'` for a conflict. */
  error?: string;
  /** Fingerprint of the event already stored under this id, for a conflict. */
  storedFingerprint?: string;
}

export interface EmitBatchResult {
  accepted: number;
  duplicates: number;
  /** Items whose id was already stored with different content; they were not applied. */
  conflicts: number;
  /** One entry per event, in input order. */
  results: EmitBatchItemResult[];
}

/** 128 random bits from the platform CSPRNG (`crypto.randomUUID`), never the clock. */
function defaultEventId(): string {
  return `evt_${globalThis.crypto.randomUUID()}`;
}

export class AgentHandle {
  public readonly id: string;
  public readonly name: string;
  public readonly roleTitle?: string;
  public readonly provider?: string;
  public readonly model?: string;
  public readonly workspace?: string;

  private readonly viewer: AgentViewer;
  private registered = false;

  constructor(viewer: AgentViewer, options: AgentInitOptions) {
    this.viewer = viewer;
    this.id = options.id;
    this.name = options.name ?? options.id;
    this.roleTitle = options.roleTitle;
    this.provider = options.provider;
    this.model = options.model;
    this.workspace = options.workspace;
  }

  private async ensureRegistered(): Promise<void> {
    if (!this.registered && this.viewer.shouldAutoRegister()) {
      try {
        await this.viewer.emit({
          type: 'agent.registered',
          source: `agent:${this.id}`,
          agentId: this.id,
          summary: `Registered ${this.name}`,
          payload: {
            id: this.id,
            name: this.name,
            roleTitle: this.roleTitle ?? 'AI Agent',
            provider: this.provider ?? 'Custom',
            model: this.model ?? 'Custom',
            workspace: this.workspace ?? 'development',
          },
        });
        this.registered = true;
      } catch (err) {
        if (this.viewer.isDebug()) {
          console.warn(`[AgentViewer] Auto-registration warning for ${this.id}:`, err);
        }
      }
    }
  }

  async status(status: string, options: { workspace?: string; statusText?: string } = {}): Promise<void> {
    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'agent.status.changed',
      source: `agent:${this.id}`,
      agentId: this.id,
      summary: options.statusText ?? `${this.id} → ${status}`,
      payload: {
        status,
        statusText: options.statusText,
        workspace: options.workspace ?? this.workspace,
      },
    });
  }

  async idle(summary = 'Idle and awaiting tasks'): Promise<void> {
    await this.status('IDLE', { statusText: summary });
  }

  async thinking(summary = 'Thinking and processing'): Promise<void> {
    await this.status('THINKING', { statusText: summary });
  }

  async researching(summary = 'Researching information'): Promise<void> {
    await this.status('RESEARCHING', { statusText: summary, workspace: 'research_area' });
  }

  async coding(summary = 'Writing code'): Promise<void> {
    await this.status('CODING', { statusText: summary, workspace: 'development' });
  }

  async testing(summary = 'Running tests'): Promise<void> {
    await this.status('TESTING', { statusText: summary, workspace: 'qa_lab' });
  }

  async waiting(summary = 'Waiting for dependencies'): Promise<void> {
    await this.status('WAITING', { statusText: summary });
  }

  async blocked(reason = 'Execution blocked'): Promise<void> {
    await this.status('BLOCKED', { statusText: reason });
  }

  async done(summary = 'Task completed successfully'): Promise<void> {
    await this.status('DONE', { statusText: summary });
  }

  async message(text: string, targetAgentName?: string): Promise<void> {
    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'agent.message.sent',
      source: `agent:${this.id}`,
      agentId: this.id,
      summary: `${this.name}: ${text.slice(0, 60)}`,
      payload: {
        text,
        targetAgentName,
      },
    });
  }

  async toolStarted(tool: string, inputSummary?: string, options: ToolCallOptions = {}): Promise<void> {
    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'tool.started',
      source: `agent:${this.id}`,
      agentId: this.id,
      summary: inputSummary ? `Started ${tool}: ${inputSummary}` : `Started tool ${tool}`,
      payload: {
        tool,
        inputSummary,
        toolCallId: options.toolCallId,
      },
    });
  }

  async toolCompleted(tool: string, outputSummary?: string, options: ToolCallOptions = {}): Promise<void> {
    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'tool.completed',
      source: `agent:${this.id}`,
      agentId: this.id,
      summary: outputSummary ? `Completed ${tool}: ${outputSummary}` : `Completed tool ${tool}`,
      payload: {
        tool,
        outputSummary,
        toolCallId: options.toolCallId,
      },
    });
  }

  async toolFailed(tool: string, errorSummary?: string, options: ToolCallOptions = {}): Promise<void> {
    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'tool.failed',
      source: `agent:${this.id}`,
      agentId: this.id,
      severity: 'high',
      summary: errorSummary ? `Failed ${tool}: ${errorSummary}` : `Failed tool ${tool}`,
      payload: {
        tool,
        error: errorSummary,
        toolCallId: options.toolCallId,
      },
    });
  }

  /**
   * Reports the usage of one model call exactly as the caller knows it. A figure that is not
   * given (or is `null`) is left out, never sent as 0. `costSource` is never inferred: a cost
   * without it is sent as `'unknown'` and the client warns once.
   */
  async usage(options: UsageOptions): Promise<void> {
    const costSource: unknown = options.costSource;
    if (costSource !== undefined && costSource !== null && !COST_SOURCES.includes(costSource as CostSource)) {
      throw new TypeError(`costSource must be one of ${COST_SOURCES.join(', ')} (got "${String(costSource)}")`);
    }
    validateUsageCorrelationOrThrow(options);
    const cost = options.cost ?? null;
    const statedCostSource = options.costSource ?? undefined;
    if (cost !== null && statedCostSource === undefined) {
      this.viewer.warnOnce('unstated-cost-source', UNSTATED_COST_SOURCE_WARNING);
    }

    const payload = {
      provider: options.provider,
      model: options.model,
      inputTokens: options.inputTokens,
      outputTokens: options.outputTokens,
      cachedTokens: omitNull(options.cachedTokens),
      cacheReadTokens: omitNull(options.cacheReadTokens),
      cacheWriteTokens: omitNull(options.cacheWriteTokens),
      reasoningTokens: omitNull(options.reasoningTokens),
      cost,
      costSource: statedCostSource ?? 'unknown',
      currency: omitNull(options.currency),
      latencyMs: options.latencyMs,
      requestId: options.requestId,
      ...buildCorrelationPayload(options),
    } satisfies LlmUsagePayloadInput;

    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'llm.usage',
      source: `agent:${this.id}`,
      agentId: this.id,
      taskId: options.taskId,
      summary: `${options.provider}/${options.model} tokens (${options.inputTokens}+${options.outputTokens})`,
      payload,
    });
  }

  /**
   * Reports one failed model call attempt (issue #64). A figure that is not given (or is `null`) is left
   * out, never sent as 0 or invented. `costSource` follows the same unstated-warning rule as `usage()`. A
   * retry that succeeds is a separate `usage()` call, not part of this one.
   */
  async llmFailed(options: LlmFailedOptions): Promise<void> {
    const costSource: unknown = options.costSource;
    if (costSource !== undefined && costSource !== null && !COST_SOURCES.includes(costSource as CostSource)) {
      throw new TypeError(`costSource must be one of ${COST_SOURCES.join(', ')} (got "${String(costSource)}")`);
    }
    validateUsageCorrelationOrThrow(options);
    const cost = options.cost ?? null;
    const statedCostSource = options.costSource ?? undefined;
    if (cost !== null && statedCostSource === undefined) {
      this.viewer.warnOnce('unstated-cost-source', UNSTATED_COST_SOURCE_WARNING);
    }

    const payload = {
      provider: options.provider,
      model: omitNull(options.model),
      errorKind: options.errorKind,
      httpStatus: omitNull(options.httpStatus),
      retryable: omitNull(options.retryable),
      requestId: omitNull(options.requestId),
      providerErrorCode: omitNull(options.providerErrorCode),
      attempts: omitNull(options.attempts),
      latencyMs: omitNull(options.latencyMs),
      inputTokens: omitNull(options.inputTokens),
      outputTokens: omitNull(options.outputTokens),
      cacheReadTokens: omitNull(options.cacheReadTokens),
      cacheWriteTokens: omitNull(options.cacheWriteTokens),
      reasoningTokens: omitNull(options.reasoningTokens),
      cost,
      costSource: statedCostSource ?? 'unknown',
      currency: omitNull(options.currency),
      ...buildCorrelationPayload(options),
    } satisfies LlmFailedPayloadInput;

    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'llm.failed',
      source: `agent:${this.id}`,
      agentId: this.id,
      taskId: options.taskId,
      severity: 'high',
      summary: options.model
        ? `${options.provider}/${options.model} call failed`
        : `${options.provider} call failed`,
      payload,
    });
  }
}

export class AgentViewer {
  public readonly url: string;
  public readonly token?: string;
  public readonly runtimeId?: string;
  public readonly sessionId?: string;
  public readonly source: string;
  public readonly timeoutMs: number;
  public readonly maxRetries: number;
  public readonly debug: boolean;
  public readonly autoRegisterAgents: boolean;

  private registeredAgents = new Map<string, AgentHandle>();
  private readonly warnedKeys = new Set<string>();

  constructor(options: AgentViewerOptions = {}) {
    const rawUrl = options.url || options.baseUrl || 'http://localhost:8787';
    this.url = rawUrl.replace(/\/$/, '');
    this.token = options.apiKey || options.token;
    this.runtimeId = options.runtimeId;
    this.sessionId = options.sessionId;
    this.source = options.source || (options.runtimeId ? `runtime:${options.runtimeId}` : 'external-runtime');
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.maxRetries = options.maxRetries ?? 3;
    this.debug = Boolean(options.debug);
    this.autoRegisterAgents = options.autoRegisterAgents !== false;
  }

  isDebug(): boolean {
    return this.debug;
  }

  shouldAutoRegister(): boolean {
    return this.autoRegisterAgents;
  }

  /** Prints `message` with `console.warn` the first time `key` is seen by this client, whatever `debug` says. */
  warnOnce(key: string, message: string): void {
    if (this.warnedKeys.has(key)) return;
    this.warnedKeys.add(key);
    console.warn(message);
  }

  agent(init: string | AgentInitOptions): AgentHandle {
    const options: AgentInitOptions = typeof init === 'string' ? { id: init, name: init } : init;
    const existing = this.registeredAgents.get(options.id);
    if (existing) return existing;

    const handle = new AgentHandle(this, options);
    this.registeredAgents.set(options.id, handle);
    return handle;
  }

  async emit(input: EmitEventInput): Promise<void> {
    const event: CanonicalEvent = {
      schemaVersion: '1.0',
      id: input.id ?? defaultEventId(),
      type: input.type as CanonicalEventType,
      timestamp: input.timestamp ?? Date.now(),
      runtimeId: this.runtimeId,
      sessionId: this.sessionId,
      source: input.source ?? this.source,
      agentId: input.agentId,
      taskId: input.taskId,
      severity: input.severity ?? 'normal',
      summary: input.summary ?? `${input.type} reported`,
      payload: input.payload ?? {},
    };

    await this.postWithRetry('/api/v1/events', event, event.id);
  }

  /**
   * Sends up to the server's batch limit in one request. The server answers 202 even when some items were not
   * applied, so read `conflicts` and each item's `status`: `'conflict'` means the id was already stored with
   * different content (`error: 'conflicting_duplicate'`), and that item was dropped. A 0.2.x server sends no
   * `conflicts` (reported here as 0) and no per-item `status`; its `results` are passed through as received.
   */
  async emitBatch(inputs: EmitEventInput[]): Promise<EmitBatchResult> {
    const events: CanonicalEvent[] = inputs.map((input) => ({
      schemaVersion: '1.0',
      id: input.id ?? defaultEventId(),
      type: input.type as CanonicalEventType,
      timestamp: input.timestamp ?? Date.now(),
      runtimeId: this.runtimeId,
      sessionId: this.sessionId,
      source: input.source ?? this.source,
      agentId: input.agentId,
      taskId: input.taskId,
      severity: input.severity ?? 'normal',
      summary: input.summary ?? `${input.type} reported`,
      payload: input.payload ?? {},
    }));

    const result = await this.postWithRetry('/api/v1/events/batch', { events });
    return {
      accepted: result?.accepted ?? 0,
      duplicates: result?.duplicates ?? 0,
      conflicts: result?.conflicts ?? 0,
      results: Array.isArray(result?.results) ? result.results : [],
    };
  }

  async registerAgent(agent: {
    id: string;
    name: string;
    roleTitle?: string;
    provider?: string;
    model?: string;
    workspace?: string;
  }): Promise<void> {
    await this.emit({
      type: 'agent.registered',
      source: `agent:${agent.id}`,
      agentId: agent.id,
      summary: `Registered ${agent.name}`,
      payload: agent,
    });
  }

  async heartbeat(activeAgentsCount?: number): Promise<void> {
    await this.emit({
      type: 'runtime.heartbeat',
      source: this.source,
      summary: `Heartbeat from ${this.runtimeId ?? 'runtime'}`,
      payload: {
        runtimeId: this.runtimeId,
        status: 'healthy',
        activeAgentsCount,
      },
    });
  }

  async snapshot(): Promise<ViewerSnapshot> {
    const response = await fetch(`${this.url}/api/v1/snapshot`, {
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      throw new AgentViewerError(`Failed to fetch snapshot: ${response.status}`, response.status);
    }
    return (await response.json()) as ViewerSnapshot;
  }

  /**
   * Usage aggregates from `GET /api/v1/usage`, by agent and by `(provider, model)`. A token `sum` is `null` when
   * no call reported that kind, and costs are listed per currency and cost source, never added together.
   */
  async usageSummary(): Promise<UsageSummary> {
    const response = await fetch(`${this.url}/api/v1/usage`, {
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      throw new AgentViewerError(`Failed to fetch usage summary: ${response.status}`, response.status);
    }
    return (await response.json()) as UsageSummary;
  }

  /**
   * One page of `GET /api/v1/usage/calls` (issue #67): metadata only (no prompt, completion, message or error
   * text), `null` left as `null` (never defaulted to `0`), never summed or priced by the SDK.
   */
  async listCalls(options: ListCallsOptions = {}): Promise<CallsPageResult> {
    const query = this.buildCallsQueryString(options);
    return this.getWithRetry(`/api/v1/usage/calls${query ? `?${query}` : ''}`) as Promise<CallsPageResult>;
  }

  /**
   * Walks every page of `listCalls` by following `page.nextCursor` until `hasMore` is `false`, yielding one
   * `CallRecord` at a time. Guards against a server bug that would otherwise loop forever: if a response's
   * `nextCursor` is identical to the cursor just used, this throws instead of repeating the same page.
   */
  async *iterateCalls(options: ListCallsOptions = {}): AsyncGenerator<CallRecord, void, undefined> {
    let cursor = options.cursor;
    while (true) {
      const page = await this.listCalls({ ...options, cursor });
      for (const call of page.data) yield call;
      if (!page.page.hasMore) return;
      const next = page.page.nextCursor;
      if (!next || next === cursor) {
        throw new AgentViewerError('Agent Viewer usage calls walk did not advance: the server returned the same cursor twice in a row.');
      }
      cursor = next;
    }
  }

  private buildCallsQueryString(options: ListCallsOptions): string {
    const params = new URLSearchParams();
    const appendRepeatable = (key: string, value: string | readonly string[] | undefined) => {
      if (value === undefined) return;
      for (const v of Array.isArray(value) ? value : [value]) params.append(key, v as string);
    };
    if (options.from !== undefined) params.set('from', String(options.from));
    if (options.to !== undefined) params.set('to', String(options.to));
    if (options.timeBasis !== undefined) params.set('timeBasis', options.timeBasis);
    appendRepeatable('agentId', options.agentId);
    appendRepeatable('sessionId', options.sessionId);
    appendRepeatable('runtimeId', options.runtimeId);
    appendRepeatable('taskId', options.taskId);
    appendRepeatable('provider', options.provider);
    appendRepeatable('model', options.model);
    appendRepeatable('status', options.status);
    appendRepeatable('costSource', options.costSource as string | readonly string[] | undefined);
    appendRepeatable('currency', options.currency);
    appendRepeatable('requestId', options.requestId);
    if (options.traceId !== undefined) params.set('traceId', options.traceId);
    if (options.order !== undefined) params.set('order', options.order);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    if (options.cursor !== undefined) params.set('cursor', options.cursor);
    return params.toString();
  }

  /**
   * Shared GET helper for read endpoints that need retry and error mapping (issue #67; `snapshot()` and
   * `usageSummary()` predate it and keep their own simpler fetch). Sends the token only in the `Authorization`
   * header, never in the URL. 400, 401 and 410 fail immediately (not retried); 429 and 5xx are retried with the
   * same backoff as `postWithRetry`, since a GET is always safe to repeat.
   */
  private async getWithRetry(path: string): Promise<unknown> {
    let attempt = 0;
    let delay = 300;

    while (true) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        const response = await fetch(`${this.url}${path}`, {
          method: 'GET',
          headers: this.buildHeaders(),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.ok) return await response.json();

        const responseText = await response.text();
        let parsedJson: any = null;
        try {
          parsedJson = JSON.parse(responseText);
        } catch {
          // not json
        }
        const code = typeof parsedJson?.error === 'string' ? parsedJson.error : undefined;

        if (response.status < 500 && response.status !== 429) {
          throw new AgentViewerError(
            parsedJson?.message || `Agent Viewer rejected request: ${response.status} ${responseText}`,
            response.status,
            parsedJson?.issues,
            code
          );
        }

        attempt++;
        if (attempt > this.maxRetries) {
          throw new AgentViewerError(
            `Agent Viewer request failed after ${this.maxRetries} retries: ${response.status} ${responseText}`,
            response.status,
            undefined,
            code
          );
        }
        if (this.debug) {
          console.warn(`[AgentViewer] Request failed with ${response.status}, retrying in ${delay}ms... (attempt ${attempt}/${this.maxRetries})`);
        }
        await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 100));
        delay = Math.min(delay * 2, 5000);
      } catch (err: any) {
        if (err instanceof AgentViewerError) throw err;

        attempt++;
        if (attempt > this.maxRetries) {
          throw new AgentViewerError(`Agent Viewer network error after ${this.maxRetries} retries: ${err.message}`);
        }
        if (this.debug) {
          console.warn(`[AgentViewer] Network error (${err.message}), retrying in ${delay}ms...`);
        }
        await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 100));
        delay = Math.min(delay * 2, 5000);
      }
    }
  }

  private buildHeaders(idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.token) {
      headers['authorization'] = `Bearer ${this.token}`;
    }
    if (idempotencyKey) {
      headers['idempotency-key'] = idempotencyKey;
    }
    return headers;
  }

  private async postWithRetry(endpoint: string, body: unknown, idempotencyKey?: string): Promise<any> {
    let attempt = 0;
    let delay = 300;

    while (attempt <= this.maxRetries) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(`${this.url}${endpoint}`, {
          method: 'POST',
          headers: this.buildHeaders(idempotencyKey),
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok || response.status === 200 || response.status === 202) {
          return await response.json();
        }

        const responseText = await response.text();
        let parsedJson: any = null;
        try {
          parsedJson = JSON.parse(responseText);
        } catch {
          // not json
        }

        const code = typeof parsedJson?.error === 'string' ? parsedJson.error : undefined;

        // 4xx errors (client errors) should not be retried except 429. A 409 conflicting_duplicate is final.
        if (response.status < 500 && response.status !== 429) {
          throw new AgentViewerError(
            parsedJson?.message || `Agent Viewer rejected request: ${response.status} ${responseText}`,
            response.status,
            parsedJson?.issues || parsedJson?.errors,
            code
          );
        }

        // Retryable server error or 429
        attempt++;
        if (attempt > this.maxRetries) {
          throw new AgentViewerError(
            `Agent Viewer request failed after ${this.maxRetries} retries: ${response.status} ${responseText}`,
            response.status,
            undefined,
            code
          );
        }

        if (this.debug) {
          console.warn(`[AgentViewer] Request failed with ${response.status}, retrying in ${delay}ms... (attempt ${attempt}/${this.maxRetries})`);
        }

        await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 100));
        delay = Math.min(delay * 2, 5000);
      } catch (err: any) {
        if (err instanceof AgentViewerError) {
          throw err;
        }

        attempt++;
        if (attempt > this.maxRetries) {
          throw new AgentViewerError(`Agent Viewer network error after ${this.maxRetries} retries: ${err.message}`);
        }

        if (this.debug) {
          console.warn(`[AgentViewer] Network error (${err.message}), retrying in ${delay}ms...`);
        }

        await new Promise((resolve) => setTimeout(resolve, delay + Math.random() * 100));
        delay = Math.min(delay * 2, 5000);
      }
    }
  }
}

// Backward compatibility alias
export { AgentViewer as AgentViewerClient };
export default AgentViewer;
