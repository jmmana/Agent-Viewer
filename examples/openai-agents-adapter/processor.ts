/**
 * OpenAI Agents SDK tracing processor for Agent Viewer (issue #100).
 *
 * Plugs into `@openai/agents`'s own tracing pipeline (`addTraceProcessor`/`setTraceProcessors`) instead of
 * requiring the host to call a callback at every step. The mapping, field names and privacy rules below were
 * verified against `@openai/agents@0.20.0` (`@openai/agents-core`, `@openai/agents-openai`) by reading the
 * installed package's type declarations and span-creation source, not from memory of the SDK; see
 * `examples/openai-agents-adapter/README.md` ("Step 0 findings") for what differs from the original issue
 * draft, in particular that usage is only observable on `generation`/`response` spans when the run's
 * `traceIncludeSensitiveData` is left at its SDK default of `true`.
 *
 * Kept in `examples/` for now, not `packages/openai-agents/`: publishing as an npm package needs the shared
 * `packages/sdk/` workspace extraction (issue #343, in progress in parallel). This module intentionally makes
 * no changes to `sdk/typescript/index.ts` so it does not conflict with that work: per-event session
 * attribution is achieved by keeping one `AgentViewer` instance per trace session instead of a per-event
 * `sessionId` override.
 */

import { AgentViewer, type EmitEventInput } from '../../sdk/typescript/index';
import { addTraceProcessor, setTraceProcessors } from '@openai/agents';
import type {
  TracingProcessor,
  Span,
  Trace,
  SpanData,
  AgentSpanData,
  FunctionSpanData,
  HandoffSpanData,
  GenerationSpanData,
  ResponseSpanData,
} from '@openai/agents';

/** Everything the processor sends is built from these fields only; it never calls `span.toJSON()` or reads
 * `spanData.input`/`spanData.output`/`_input`/`_response` beyond the narrow extraction helpers below. */
export interface AgentViewerTracingProcessorOptions {
  url?: string;
  apiKey?: string;
  /** Label stored on every `llm.usage`/`llm.failed` event. Default `'OpenAI'`; set it for an OpenAI-compatible endpoint. */
  provider?: string;
  runtimeId?: string;
  /** Fixed task id, or a function of the trace (for example reading `trace.metadata`). Never guessed. */
  taskId?: string | ((trace: Trace) => string | undefined);
  /** Maps an agent name to an Agent Viewer agent id. Default: a stable lowercase-and-hyphens slug. */
  agentId?: (name: string) => string;
  /** Opt in to a 120-char truncated summary of a tool's input and output. Default `false` (nothing is read). */
  includeToolInputSummary?: boolean;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  shutdownTimeoutMs?: number;
  /** Per-request timeout and retry count for the internal `AgentViewer` instances. Defaults: 5000ms, 2 retries. */
  timeoutMs?: number;
  maxRetries?: number;
  debug?: boolean;
}

export interface AgentViewerTracingProcessorStats {
  /** Events handed to the queue since construction. */
  queued: number;
  /** Events the server accepted. */
  sent: number;
  /** Events the server reported as already stored (deterministic id replay). */
  duplicates: number;
  /** Events dropped because the queue was full or a send failed after the SDK's own retries. */
  dropped: number;
  /** Subset of `dropped` that were `llm.usage`/`llm.failed` (dropped only when nothing else was left to drop). */
  droppedUsage: number;
  /** Reserved for the partial-rejection handling described in issue #100 section 4 (deferred, see README). */
  rejected: number;
  /** Model calls whose span carried no usable `inputTokens`/`outputTokens` pair; never sent as `0`. */
  noUsageCalls: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_MAX_QUEUE_SIZE = 1000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
const MAX_BATCH_SIZE = 100;
const MAX_SPAN_RECORDS = 10000;
const MAX_SESSION_VIEWERS = 1000;
const NO_SESSION_KEY = '__no_session__';

function truncate(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `name` slugified to `[a-z0-9-]+`; never empty. Used when `options.agentId` is not given. */
function defaultAgentId(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'agent';
}

function parseSpanTimeMs(iso: string | null): number | undefined {
  if (!iso) return undefined;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Span duration in whole milliseconds, or `undefined` when either timestamp is missing or unparsable. */
function spanDurationMs(span: Span<SpanData>): number | undefined {
  const start = parseSpanTimeMs(span.startedAt);
  const end = parseSpanTimeMs(span.endedAt);
  if (start === undefined || end === undefined) return undefined;
  return Math.max(0, Math.round(end - start));
}

/** Event `timestamp`: the span's own end (or start) time, never `Date.now()`, so replays are stable. */
function spanEventTimestamp(span: Span<SpanData>): number {
  return parseSpanTimeMs(span.endedAt) ?? parseSpanTimeMs(span.startedAt) ?? Date.now();
}

function spanEventId(traceId: string, spanId: string, kind: string): string {
  return `oa:${traceId}:${spanId}:${kind}`;
}

/**
 * Reads only `input_tokens`/`output_tokens` (or their snake_case provider siblings) and the cache-read and
 * reasoning breakdowns out of a raw usage record, in whatever shape OpenAI's SDK attached it (see the
 * README's "Step 0 findings" for the two shapes actually observed: `GenerationUsageData` and a raw provider
 * `usage` object). Never reads any other key, so prompts and completions sitting next to it are untouched.
 */
function extractTokenCounts(usage: Record<string, unknown> | undefined | null): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
} {
  if (!usage || typeof usage !== 'object') return {};
  const inputTokens = numberOrUndefined((usage as any).input_tokens) ?? numberOrUndefined((usage as any).prompt_tokens);
  const outputTokens = numberOrUndefined((usage as any).output_tokens) ?? numberOrUndefined((usage as any).completion_tokens);
  const inputDetails = ((usage as any).input_tokens_details ?? (usage as any).prompt_tokens_details) as Record<string, unknown> | undefined;
  const outputDetails = ((usage as any).output_tokens_details ?? (usage as any).completion_tokens_details) as Record<string, unknown> | undefined;
  const cacheReadTokens = numberOrUndefined(inputDetails?.cached_tokens);
  const reasoningTokens = numberOrUndefined(outputDetails?.reasoning_tokens);
  return { inputTokens, outputTokens, cacheReadTokens, reasoningTokens };
}

interface ExtractedUsage {
  /** `undefined` only when the span truly carries no model (for example a connection failure before the
   * model was chosen); the caller never substitutes a guess for it. */
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
  requestId?: string;
}

/**
 * Chat Completions ("generation") spans. `spanData.model` is always present (it is not sensitive data) and
 * is extracted independently of usage, so a failed call still reports which model was called. Usage is read
 * first from `spanData.usage` (the shape some provider paths, for example a truncated or failed completion,
 * assign directly) and otherwise from `spanData.output[0].usage` (the raw Chat Completions response, only
 * populated by `@openai/agents-openai` when the run's `traceIncludeSensitiveData` is `true`).
 */
function extractGenerationUsage(data: GenerationSpanData): ExtractedUsage {
  const model = typeof data.model === 'string' && data.model.length > 0 ? data.model : undefined;
  let tokens = extractTokenCounts(data.usage as Record<string, unknown> | undefined);
  if (tokens.inputTokens === undefined && tokens.outputTokens === undefined) {
    const rawOutput = Array.isArray(data.output) ? (data.output[0] as Record<string, unknown> | undefined) : undefined;
    tokens = extractTokenCounts(rawOutput?.usage as Record<string, unknown> | undefined);
  }
  return { model, ...tokens };
}

/**
 * Responses API spans. Neither `model` nor `usage` is a top-level field of `ResponseSpanData`: both live
 * inside `_response`, the raw OpenAI Response object, which `@openai/agents-openai` only attaches when
 * `traceIncludeSensitiveData` is `true` (the same flag that also attaches the full input/output). This
 * extractor reads only `.model`, `.usage` and `.id` off that object and never touches `.output`/`.instructions`,
 * and extracts the model independently of usage so a failed call still reports which model was called.
 */
function extractResponseUsage(data: ResponseSpanData): ExtractedUsage {
  const response = data._response as Record<string, unknown> | undefined;
  const model = typeof response?.model === 'string' ? (response.model as string) : undefined;
  const tokens = extractTokenCounts(response?.usage as Record<string, unknown> | undefined);
  const requestId = data.response_id ?? (typeof response?.id === 'string' ? (response.id as string) : undefined);
  return { model, ...tokens, requestId };
}

interface SpanRecord {
  traceId: string;
  parentId: string | null;
  kind: SpanData['type'];
  agentId?: string;
}

interface TraceInfo {
  sessionId: string | undefined;
  taskId: string | undefined;
}

type AgentStatusLabel = 'THINKING' | 'USING_TOOL' | 'IDLE' | 'ERROR' | 'DONE';

interface QueuedEvent {
  sessionKey: string;
  sessionId: string | undefined;
  input: EmitEventInput;
}

/**
 * Implements the `@openai/agents` `TracingProcessor` interface. Register it with `addTraceProcessor()` (to
 * run alongside OpenAI's own trace exporter) or via `instrumentOpenAIAgents({ exclusive: true })` (to replace
 * it). See the mapping table in `README.md` for the full span-to-event table and the acceptance criteria this
 * implementation covers.
 */
export class AgentViewerTracingProcessor implements TracingProcessor {
  private readonly provider: string;
  private readonly flushIntervalMs: number;
  private readonly maxQueueSize: number;
  private readonly shutdownTimeoutMs: number;
  private readonly unattributedAgentId: string;

  private readonly viewers = new Map<string, AgentViewer>();
  private readonly queue: QueuedEvent[] = [];
  private readonly traceSessions = new Map<string, TraceInfo>();
  private readonly spanRecords = new Map<string, SpanRecord>();
  private readonly registeredAgents = new Set<string>();
  private readonly activeAgentSpans = new Map<string, number>();
  private readonly toolsInFlight = new Map<string, number>();
  private readonly lastAgentStatus = new Map<string, AgentStatusLabel>();
  private readonly lastEndedAgentPerTrace = new Map<string, string>();
  private readonly lastEndedAgentTimestampPerTrace = new Map<string, number>();

  private readonly stats_: AgentViewerTracingProcessorStats = {
    queued: 0,
    sent: 0,
    duplicates: 0,
    dropped: 0,
    droppedUsage: 0,
    rejected: 0,
    noUsageCalls: 0,
  };

  private timer: ReturnType<typeof setInterval> | undefined;
  /**
   * Chains every flush trigger (the timer, `forceFlush()`, `onTraceEnd`, `shutdown()`) onto one promise
   * instead of a boolean lock: `triggerFlush()` always resolves only once a flush cycle that starts at or
   * after the call has finished, so `await forceFlush()` is a real synchronization point even when the
   * periodic timer is mid-flush. A plain "if already flushing, skip" lock cannot offer that guarantee: a
   * caller could resolve before a concurrently running flush had drained the events it just enqueued.
   */
  private flushChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: AgentViewerTracingProcessorOptions = {}) {
    this.provider = options.provider ?? 'OpenAI';
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.unattributedAgentId = options.runtimeId ?? 'openai-agents';
    this.timer = setInterval(() => {
      void this.triggerFlush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  /** Idempotent; the flush timer is already running once the processor is constructed. */
  start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.triggerFlush();
      }, this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  stats(): AgentViewerTracingProcessorStats {
    return { ...this.stats_ };
  }

  private resolveAgentId(name: string): string {
    const label = name && name.length > 0 ? name : 'Agent';
    return this.options.agentId ? this.options.agentId(label) : defaultAgentId(label);
  }

  private onInternalError(err: unknown): void {
    if (this.options.debug) {
      console.warn('[AgentViewerTracingProcessor] internal error (ignored, never thrown into the run):', err);
    }
  }

  private getViewer(sessionId: string | undefined): AgentViewer {
    const key = sessionId ?? NO_SESSION_KEY;
    let viewer = this.viewers.get(key);
    if (!viewer) {
      if (this.viewers.size >= MAX_SESSION_VIEWERS) {
        const oldestKey = this.viewers.keys().next().value;
        if (oldestKey !== undefined) this.viewers.delete(oldestKey);
      }
      viewer = new AgentViewer({
        url: this.options.url,
        apiKey: this.options.apiKey,
        runtimeId: this.options.runtimeId,
        sessionId,
        source: `runtime:${this.options.runtimeId ?? 'openai-agents'}`,
        autoRegisterAgents: false,
        maxRetries: this.options.maxRetries ?? 2,
        timeoutMs: this.options.timeoutMs ?? 5000,
        debug: this.options.debug,
      });
      this.viewers.set(key, viewer);
    }
    return viewer;
  }

  /** Enqueues one event; never awaits the network. Drops the oldest non-usage event first when the queue is
   * full, and only drops a usage/failed event when nothing else is left to drop. */
  private enqueue(sessionId: string | undefined, input: EmitEventInput): void {
    const sessionKey = sessionId ?? NO_SESSION_KEY;
    this.queue.push({ sessionKey, sessionId, input });
    this.stats_.queued++;
    while (this.queue.length > this.maxQueueSize) {
      let dropIndex = this.queue.findIndex((e) => e.input.type !== 'llm.usage' && e.input.type !== 'llm.failed');
      if (dropIndex === -1) dropIndex = 0;
      const [dropped] = this.queue.splice(dropIndex, 1);
      this.stats_.dropped++;
      if (dropped.input.type === 'llm.usage' || dropped.input.type === 'llm.failed') this.stats_.droppedUsage++;
    }
  }

  /**
   * `timestampMs` is the time of the span that triggered the registration (or, for the handoff target and
   * the unattributed fallback, of the span that first needed it), never `Date.now()`: the server's dedup
   * fingerprint includes the timestamp, so a non-deterministic one would turn a true redelivery of the same
   * span into a `conflict` instead of a harmless `duplicate`.
   */
  private ensureAgentRegistered(agentId: string, name: string, sessionId: string | undefined, timestampMs: number): void {
    if (this.registeredAgents.has(agentId)) return;
    this.registeredAgents.add(agentId);
    this.enqueue(sessionId, {
      id: `oa:agent:${agentId}:registered`,
      type: 'agent.registered',
      agentId,
      source: `agent:${agentId}`,
      timestamp: timestampMs,
      summary: `Registered ${name}`,
      payload: {
        id: agentId,
        name,
        provider: this.provider,
        // The agent span carries no model: the real model is reported per call on `llm.usage`.
        model: 'Custom',
        roleTitle: 'AI Agent',
        workspace: 'development',
      },
    });
  }

  private ensureUnattributedAgent(sessionId: string | undefined, timestampMs: number): string {
    this.ensureAgentRegistered(this.unattributedAgentId, 'OpenAI Agents (unattributed)', sessionId, timestampMs);
    return this.unattributedAgentId;
  }

  private emitStatus(
    sessionId: string | undefined,
    agentId: string,
    taskId: string | undefined,
    traceId: string,
    spanId: string,
    kind: string,
    status: AgentStatusLabel,
    timestampMs: number,
    statusText?: string,
  ): void {
    this.lastAgentStatus.set(agentId, status);
    this.enqueue(sessionId, {
      id: spanEventId(traceId, spanId, kind),
      type: 'agent.status.changed',
      agentId,
      taskId,
      source: `agent:${agentId}`,
      severity: status === 'ERROR' ? 'high' : 'normal',
      timestamp: timestampMs,
      summary: statusText ?? `${agentId} -> ${status}`,
      payload: { status, statusText },
    });
  }

  /** Walks `parentId` up from `span` through `spanRecords` to the nearest `agent` span (the owning agent) and
   * the nearest `function` span before it, if any (the tool call during which this span ran). Usage is never
   * dropped for lack of attribution: an unresolved owner falls back to a fixed "unattributed" agent. */
  private resolveOwningContext(span: {
    traceId: string;
    parentId: string | null;
  }, timestampMs: number): { agentId: string; toolCallId?: string; sessionId: string | undefined; taskId: string | undefined } {
    const traceInfo = this.traceSessions.get(span.traceId);
    let cursor: string | null = span.parentId;
    let toolCallId: string | undefined;
    let hops = 0;
    while (cursor && hops < 64) {
      const record = this.spanRecords.get(cursor);
      if (!record) break;
      if (record.kind === 'function' && toolCallId === undefined) toolCallId = cursor;
      if (record.kind === 'agent' && record.agentId) {
        return { agentId: record.agentId, toolCallId, sessionId: traceInfo?.sessionId, taskId: traceInfo?.taskId };
      }
      cursor = record.parentId;
      hops++;
    }
    return {
      agentId: this.ensureUnattributedAgent(traceInfo?.sessionId, timestampMs),
      toolCallId,
      sessionId: traceInfo?.sessionId,
      taskId: traceInfo?.taskId,
    };
  }

  private enforceSpanRecordsCap(): void {
    while (this.spanRecords.size > MAX_SPAN_RECORDS) {
      const oldestKey = this.spanRecords.keys().next().value;
      if (oldestKey === undefined) break;
      this.spanRecords.delete(oldestKey);
    }
  }

  async onTraceStart(trace: Trace): Promise<void> {
    try {
      const sessionId = trace.groupId ?? trace.traceId;
      const taskId = typeof this.options.taskId === 'function' ? this.options.taskId(trace) : this.options.taskId;
      this.traceSessions.set(trace.traceId, { sessionId, taskId });
    } catch (err) {
      this.onInternalError(err);
    }
  }

  async onTraceEnd(trace: Trace): Promise<void> {
    try {
      const traceInfo = this.traceSessions.get(trace.traceId);
      const lastAgent = this.lastEndedAgentPerTrace.get(trace.traceId);
      if (lastAgent && this.lastAgentStatus.get(lastAgent) !== 'ERROR') {
        const timestampMs = this.lastEndedAgentTimestampPerTrace.get(trace.traceId) ?? Date.now();
        this.emitStatus(traceInfo?.sessionId, lastAgent, traceInfo?.taskId, trace.traceId, trace.traceId, 'status.done', 'DONE', timestampMs);
      }
      this.traceSessions.delete(trace.traceId);
      this.lastEndedAgentPerTrace.delete(trace.traceId);
      this.lastEndedAgentTimestampPerTrace.delete(trace.traceId);
      for (const [spanId, record] of this.spanRecords) {
        if (record.traceId === trace.traceId) this.spanRecords.delete(spanId);
      }
    } catch (err) {
      this.onInternalError(err);
    } finally {
      void this.triggerFlush();
    }
  }

  async onSpanStart(span: Span<SpanData>): Promise<void> {
    try {
      const traceInfo = this.traceSessions.get(span.traceId);
      const sessionId = traceInfo?.sessionId;
      const data = span.spanData;
      this.spanRecords.set(span.spanId, { traceId: span.traceId, parentId: span.parentId, kind: data.type });
      this.enforceSpanRecordsCap();

      const timestampMs = spanEventTimestamp(span);

      if (data.type === 'agent') {
        const agentData = data as AgentSpanData;
        const agentId = this.resolveAgentId(agentData.name);
        const record = this.spanRecords.get(span.spanId);
        if (record) record.agentId = agentId;
        this.ensureAgentRegistered(agentId, agentData.name || 'Agent', sessionId, timestampMs);
        this.activeAgentSpans.set(agentId, (this.activeAgentSpans.get(agentId) ?? 0) + 1);
        this.emitStatus(sessionId, agentId, traceInfo?.taskId, span.traceId, span.spanId, 'status.thinking', 'THINKING', timestampMs);
      } else if (data.type === 'function') {
        const functionData = data as FunctionSpanData;
        const ctx = this.resolveOwningContext(span, timestampMs);
        this.toolsInFlight.set(ctx.agentId, (this.toolsInFlight.get(ctx.agentId) ?? 0) + 1);
        const inputSummary = this.options.includeToolInputSummary ? truncate(functionData.input, 120) : undefined;
        this.enqueue(sessionId, {
          id: spanEventId(span.traceId, span.spanId, 'tool.started'),
          type: 'tool.started',
          agentId: ctx.agentId,
          taskId: ctx.taskId,
          source: `agent:${ctx.agentId}`,
          timestamp: timestampMs,
          summary: `Started tool ${functionData.name}`,
          payload: { tool: functionData.name, toolCallId: span.spanId, inputSummary },
        });
        if ((this.activeAgentSpans.get(ctx.agentId) ?? 0) > 0) {
          this.emitStatus(sessionId, ctx.agentId, ctx.taskId, span.traceId, span.spanId, 'status.after-tool.start', 'USING_TOOL', timestampMs);
        }
      }
    } catch (err) {
      this.onInternalError(err);
    }
  }

  async onSpanEnd(span: Span<SpanData>): Promise<void> {
    try {
      const traceInfo = this.traceSessions.get(span.traceId);
      const sessionId = traceInfo?.sessionId;
      const data = span.spanData;
      const record = this.spanRecords.get(span.spanId);
      const timestampMs = spanEventTimestamp(span);

      switch (data.type) {
        case 'agent': {
          const agentData = data as AgentSpanData;
          const agentId = record?.agentId ?? this.resolveAgentId(agentData.name);
          const remaining = Math.max(0, (this.activeAgentSpans.get(agentId) ?? 1) - 1);
          this.activeAgentSpans.set(agentId, remaining);
          if (remaining === 0) {
            const status: AgentStatusLabel = span.error ? 'ERROR' : 'IDLE';
            this.emitStatus(
              sessionId,
              agentId,
              traceInfo?.taskId,
              span.traceId,
              span.spanId,
              span.error ? 'status.error' : 'status.idle',
              status,
              timestampMs,
              span.error ? truncate(span.error.message, 200) : undefined,
            );
          }
          this.lastEndedAgentPerTrace.set(span.traceId, agentId);
          this.lastEndedAgentTimestampPerTrace.set(span.traceId, timestampMs);
          break;
        }
        case 'function': {
          const functionData = data as FunctionSpanData;
          const ctx = this.resolveOwningContext(span, timestampMs);
          const durationMs = spanDurationMs(span);
          if (span.error) {
            this.enqueue(sessionId, {
              id: spanEventId(span.traceId, span.spanId, 'tool.failed'),
              type: 'tool.failed',
              agentId: ctx.agentId,
              taskId: ctx.taskId,
              severity: 'high',
              source: `agent:${ctx.agentId}`,
              timestamp: timestampMs,
              summary: `Failed tool ${functionData.name}`,
              payload: { tool: functionData.name, toolCallId: span.spanId, error: truncate(span.error.message, 200), durationMs },
            });
          } else {
            const outputSummary = this.options.includeToolInputSummary ? truncate(functionData.output, 120) : undefined;
            this.enqueue(sessionId, {
              id: spanEventId(span.traceId, span.spanId, 'tool.completed'),
              type: 'tool.completed',
              agentId: ctx.agentId,
              taskId: ctx.taskId,
              source: `agent:${ctx.agentId}`,
              timestamp: timestampMs,
              summary: `Completed tool ${functionData.name}`,
              payload: { tool: functionData.name, toolCallId: span.spanId, outputSummary, durationMs },
            });
          }
          const remaining = Math.max(0, (this.toolsInFlight.get(ctx.agentId) ?? 1) - 1);
          this.toolsInFlight.set(ctx.agentId, remaining);
          if ((this.activeAgentSpans.get(ctx.agentId) ?? 0) > 0) {
            this.emitStatus(
              sessionId,
              ctx.agentId,
              ctx.taskId,
              span.traceId,
              span.spanId,
              'status.after-tool.end',
              remaining > 0 ? 'USING_TOOL' : 'THINKING',
              timestampMs,
            );
          }
          break;
        }
        case 'handoff': {
          const handoffData = data as HandoffSpanData;
          const fromName = handoffData.from_agent;
          const toName = handoffData.to_agent;
          if (fromName && toName) {
            const fromId = this.resolveAgentId(fromName);
            const toId = this.resolveAgentId(toName);
            this.ensureAgentRegistered(toId, toName, sessionId, timestampMs);
            this.enqueue(sessionId, {
              id: spanEventId(span.traceId, span.spanId, 'handoff.message'),
              type: 'agent.message.sent',
              agentId: fromId,
              taskId: traceInfo?.taskId,
              source: `agent:${fromId}`,
              timestamp: timestampMs,
              summary: `${fromName}: Handoff to ${toName}`,
              payload: { text: `Handoff to ${toName}`, kind: 'statement', targetAgentName: toName, targetAgentId: toId },
            });
            this.emitStatus(sessionId, toId, traceInfo?.taskId, span.traceId, span.spanId, 'handoff.status', 'THINKING', timestampMs);
          }
          break;
        }
        case 'response':
        case 'generation': {
          const extracted = data.type === 'response' ? extractResponseUsage(data as ResponseSpanData) : extractGenerationUsage(data as GenerationSpanData);
          const ctx = this.resolveOwningContext(span, timestampMs);
          const latencyMs = spanDurationMs(span);
          if (span.error) {
            this.enqueue(sessionId, {
              id: spanEventId(span.traceId, span.spanId, 'llm.failed'),
              type: 'llm.failed',
              agentId: ctx.agentId,
              taskId: ctx.taskId,
              severity: 'high',
              source: `agent:${ctx.agentId}`,
              timestamp: spanEventTimestamp(span),
              summary: `${this.provider}/${extracted.model ?? 'unknown model'} call failed`,
              payload: {
                provider: this.provider,
                model: extracted.model,
                errorKind: 'unknown',
                latencyMs,
                traceId: span.traceId,
                parentId: span.parentId ?? undefined,
                toolCallId: ctx.toolCallId,
              },
            });
            break;
          }
          if (extracted.inputTokens === undefined || extracted.outputTokens === undefined) {
            this.stats_.noUsageCalls++;
            break;
          }
          this.enqueue(sessionId, {
            id: spanEventId(span.traceId, span.spanId, 'llm.usage'),
            type: 'llm.usage',
            agentId: ctx.agentId,
            taskId: ctx.taskId,
            source: `agent:${ctx.agentId}`,
            timestamp: spanEventTimestamp(span),
            summary: `${this.provider}/${extracted.model ?? 'unknown'} tokens (${extracted.inputTokens}+${extracted.outputTokens})`,
            payload: {
              provider: this.provider,
              // llm.usage requires a non-empty model; a missing one is recorded as the literal 'unknown',
              // never guessed as a specific model name (issue #100 acceptance criteria).
              model: extracted.model ?? 'unknown',
              inputTokens: extracted.inputTokens,
              outputTokens: extracted.outputTokens,
              cacheReadTokens: extracted.cacheReadTokens,
              reasoningTokens: extracted.reasoningTokens,
              latencyMs,
              requestId: extracted.requestId,
              cost: null,
              costSource: 'unknown',
              traceId: span.traceId,
              parentId: span.parentId ?? undefined,
              toolCallId: ctx.toolCallId,
            },
          });
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.onInternalError(err);
    }
  }

  /** Chains onto `flushChain` (see its doc comment) and returns the promise for the cycle that starts at or
   * after this call, so awaiting it always observes everything enqueued up to this point being sent. */
  private triggerFlush(): Promise<void> {
    const next = this.flushChain.catch(() => undefined).then(() => this.flush());
    this.flushChain = next.catch(() => undefined);
    return next;
  }

  /** Drains the queue, grouped by session (one `AgentViewer` per session, see the module doc comment), in
   * batches of at most 100 events. A batch that fails after the SDK's own retries is dropped and counted;
   * see the README for the partial-rejection and 413-halving behavior this defers. */
  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const drained = this.queue.splice(0, this.queue.length);
    const bySession = new Map<string, QueuedEvent[]>();
    for (const item of drained) {
      const list = bySession.get(item.sessionKey);
      if (list) list.push(item);
      else bySession.set(item.sessionKey, [item]);
    }
    const sends = Array.from(bySession.values()).map(async (items) => {
      const viewer = this.getViewer(items[0].sessionId);
      for (let i = 0; i < items.length; i += MAX_BATCH_SIZE) {
        const chunk = items.slice(i, i + MAX_BATCH_SIZE);
        try {
          const result = await viewer.emitBatch(chunk.map((e) => e.input));
          // `emitBatch()` resolves with `EmitBatchQueuedResult` instead when the SDK's local durable queue
          // (disabled by default, this example never enables it) takes over: every event was queued, not yet
          // confirmed by the server, so there is no accepted/duplicate split to report yet.
          if (typeof result.accepted === 'number') {
            this.stats_.sent += result.accepted;
            this.stats_.duplicates += result.duplicates;
          } else {
            this.stats_.sent += result.total;
          }
        } catch (err) {
          this.stats_.dropped += chunk.length;
          for (const e of chunk) {
            if (e.input.type === 'llm.usage' || e.input.type === 'llm.failed') this.stats_.droppedUsage++;
          }
          this.onInternalError(err);
        }
      }
    });
    await Promise.allSettled(sends);
  }

  async forceFlush(): Promise<void> {
    await this.triggerFlush();
  }

  async shutdown(timeout?: number): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const bound = timeout ?? this.shutdownTimeoutMs;
    await Promise.race([this.triggerFlush(), new Promise<void>((resolve) => setTimeout(resolve, bound))]);
  }
}

/**
 * Convenience wrapper: builds the processor and registers it. `exclusive: true` replaces every processor
 * (including OpenAI's own default exporter) via `setTraceProcessors`; omitted or `false`, it is added
 * alongside the existing ones via `addTraceProcessor`, so OpenAI's own trace backend still receives full
 * traces whenever the run's own tracing is configured to send them there (see the README privacy section).
 */
export function instrumentOpenAIAgents(
  options: AgentViewerTracingProcessorOptions & { exclusive?: boolean } = {},
): { processor: AgentViewerTracingProcessor; shutdown: () => Promise<void> } {
  const processor = new AgentViewerTracingProcessor(options);
  if (options.exclusive) {
    setTraceProcessors([processor]);
  } else {
    addTraceProcessor(processor);
  }
  return { processor, shutdown: () => processor.shutdown() };
}
