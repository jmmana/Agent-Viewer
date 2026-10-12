/**
 * Callback-to-event mapping of the LangGraph adapter (issue #344), kept free of any `@langchain/core` import
 * so it can be replayed in tests without the framework installed. `AgentViewerCallbackHandler` (`./index.ts`)
 * is the `BaseCallbackHandler` subclass that forwards every LangChain callback here.
 *
 * Same business rules and id scheme as the Python adapter (`sdk/python/agent_viewer_langgraph.py`, issue
 * #345): ids are `lg:<runtimeId>:<runId>:<eventKind>`, only the keys in `METADATA_WHITELIST` are read from
 * callback metadata, and prompts, completions, tool arguments/results and error messages are never sent.
 * A model or tool run is attributed to the nearest node run up its own `parentRunId` chain, never to a global
 * "current node", so parallel branches (`Send`, map-reduce) and subgraphs stay apart.
 */

import { AgentViewer, type EmitEventInput, type EventSeverity, type LlmErrorKind } from '@warlockcode/agent-viewer-sdk';

/** The only callback metadata keys ever read. Everything else (user config metadata, checkpoint ids) is ignored. */
export const METADATA_WHITELIST = ['langgraph_node', 'thread_id', 'ls_provider', 'ls_model_name', 'ls_model_type'] as const;

export type LangGraphMetadataKey = (typeof METADATA_WHITELIST)[number];
export type LangGraphMetadata = Partial<Record<LangGraphMetadataKey, string | number | boolean>>;

export interface AgentViewerLangGraphAgent {
  id: string;
  name?: string;
  roleTitle?: string;
  workspace?: string;
}

export interface AgentViewerLangGraphOptions {
  /** Client to send through. Its url, key, timeout and retries are reused for every session. */
  viewer?: AgentViewer;
  url?: string;
  apiKey?: string;
  /** Default `'langgraph'` (or the viewer's own `runtimeId`). Part of every event id. */
  runtimeId?: string;
  /** Default: the node name is the agent id. Receives the whitelisted metadata only. */
  agentForNode?(node: string, metadata: LangGraphMetadata): string | AgentViewerLangGraphAgent;
  /** Default: `metadata.thread_id` when present, otherwise no session. Never invented. */
  sessionFor?(metadata: LangGraphMetadata): string | undefined;
  /** Default: no task id. */
  taskFor?(metadata: LangGraphMetadata): string | undefined;
  /** Opt-in summary of a tool's input. Default `false`: the input is never read. */
  toolInputSummary?: false | ((tool: string, input: string) => string | undefined);
  /** Opt-in summary of a tool's output. Default `false`: the output is never read. */
  toolOutputSummary?: false | ((tool: string, output: unknown) => string | undefined);
  /** Cost the provider itself reported for a model call. The adapter never computes or estimates a cost. */
  reportedCost?(result: unknown): { cost: number; currency?: string } | undefined;
  /** Events waiting to be sent before new ones are dropped. Default 1000. */
  maxQueue?: number;
  /** Events per batch request. Default 50, capped at the server's default `AGENT_VIEWER_MAX_BATCH_SIZE` (100). */
  batchSize?: number;
  onError?(error: unknown, droppedEvent?: EmitEventInput): void;
  debug?: boolean;
  /** Clock for timestamps and latencies, in epoch milliseconds. Default `Date.now`; tests pass a fixed one. */
  now?: () => number;
}

export interface AgentViewerLangGraphStats {
  /** Events the server accepted or recognized as an identical duplicate. */
  sent: number;
  /** Events a send error or an id conflict kept from being stored. */
  failed: number;
  /** Events dropped on a full queue, and run entries evicted from a full run map. */
  dropped: number;
  /** Model calls that ended without both input and output token counts; no `llm.usage` is sent for them. */
  callsWithoutUsage: number;
}

/** Structural subset of `@langchain/core`'s `Serialized`: only the run name is read. */
export interface SerializedLike {
  id?: string[];
  name?: string;
}

const DEFAULT_RUNTIME_ID = 'langgraph';
const DEFAULT_AGENT_ID = 'langgraph';
const DEFAULT_MAX_QUEUE = 1000;
const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 100;
const MAX_RUNS = 10000;
const MAX_SESSION_VIEWERS = 1000;
const NO_SESSION_KEY = '\u0000no-session';
/** Control-flow exceptions LangGraph raises through a node; they pause the node, they do not fail it. */
const INTERRUPT_ERRORS = new Set(['GraphInterrupt', 'NodeInterrupt', 'ParentCommand', 'GraphBubbleUp']);

interface RunEntry {
  kind: 'node' | 'chain' | 'tool' | 'llm';
  parentRunId?: string;
  startedAtMs: number;
  meta: LangGraphMetadata;
  agentId?: string;
  node?: string;
  toolName?: string;
  toolCallId?: string;
  provider?: string;
  model?: string;
}

interface QueuedEvent {
  sessionId: string | undefined;
  input: EmitEventInput;
}

interface TokenCounts {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export function filterMetadata(metadata: unknown): LangGraphMetadata {
  const result: LangGraphMetadata = {};
  if (!metadata || typeof metadata !== 'object') return result;
  for (const key of METADATA_WHITELIST) {
    const value = (metadata as Record<string, unknown>)[key];
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      result[key] = value;
    }
  }
  return result;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function runName(serialized: SerializedLike | undefined | null, name: unknown): string | undefined {
  return nonEmptyString(name) ?? nonEmptyString(serialized?.name) ?? nonEmptyString(serialized?.id?.at(-1));
}

/** The error's class name only, never its message: provider messages can echo prompts or credentials. */
function errorName(error: unknown): string {
  if (error && typeof error === 'object') {
    const name = nonEmptyString((error as { name?: unknown }).name);
    if (name) return name;
    const ctor = nonEmptyString((error as { constructor?: { name?: unknown } }).constructor?.name);
    if (ctor) return ctor;
  }
  return 'Error';
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/** Maps a model error to an `llm.failed` `errorKind` from its HTTP status and class name only. */
function errorKind(error: unknown, status: number | undefined): LlmErrorKind {
  if (status === 429) return 'rate_limited';
  if (status === 529) return 'overloaded';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status !== undefined && status >= 500) return 'server_error';
  if (status === 400 || status === 404 || status === 422) return 'invalid_request';
  const name = errorName(error).toLowerCase();
  if (name.includes('ratelimit') || name.includes('rate_limit')) return 'rate_limited';
  if (name.includes('overload')) return 'overloaded';
  if (name.includes('timeout')) return 'timeout';
  if (name.includes('auth') || name.includes('permission')) return 'auth';
  if (name.includes('abort') || name.includes('cancel')) return 'cancelled';
  if (name.includes('connection') || name.includes('network') || name.includes('fetch')) return 'network';
  if (name.includes('badrequest') || name.includes('invalid') || name.includes('validation')) return 'invalid_request';
  if (name.includes('server') || name.includes('internal')) return 'server_error';
  return 'unknown';
}

/**
 * Reads token counts from an `LLMResult`: the first message's `usage_metadata`, otherwise the provider's
 * `llmOutput.tokenUsage` (OpenAI) or `llmOutput.usage` (Anthropic). `llmOutput.estimatedTokenUsage` is never
 * read: it is LangChain's own estimate. A count the provider did not report stays `undefined`, never 0.
 */
export function extractUsage(result: unknown): TokenCounts {
  const output = (result ?? {}) as { generations?: unknown; llmOutput?: unknown };
  if (Array.isArray(output.generations)) {
    for (const batch of output.generations) {
      if (!Array.isArray(batch)) continue;
      for (const generation of batch) {
        const usage = (generation as { message?: { usage_metadata?: unknown } } | null)?.message?.usage_metadata;
        if (!usage || typeof usage !== 'object') continue;
        const u = usage as Record<string, any>;
        return {
          inputTokens: tokenCount(u.input_tokens),
          outputTokens: tokenCount(u.output_tokens),
          cacheReadTokens: tokenCount(u.input_token_details?.cache_read),
          cacheWriteTokens: tokenCount(u.input_token_details?.cache_creation),
          reasoningTokens: tokenCount(u.output_token_details?.reasoning),
        };
      }
    }
  }
  const llmOutput = output.llmOutput as Record<string, any> | undefined;
  if (llmOutput && typeof llmOutput === 'object') {
    const tokenUsage = llmOutput.tokenUsage;
    if (tokenUsage && typeof tokenUsage === 'object') {
      return { inputTokens: tokenCount(tokenUsage.promptTokens), outputTokens: tokenCount(tokenUsage.completionTokens) };
    }
    const usage = llmOutput.usage;
    if (usage && typeof usage === 'object') {
      return {
        inputTokens: tokenCount(usage.input_tokens),
        outputTokens: tokenCount(usage.output_tokens),
        cacheReadTokens: tokenCount(usage.cache_read_input_tokens),
        cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens),
      };
    }
  }
  return {};
}

function withoutUndefined(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * The callback methods have the names and positional signatures of `@langchain/core`'s
 * `BaseCallbackHandler` (`handleChainStart`, `handleLLMEnd`, ...). None of them awaits the network: each
 * builds its events, enqueues them and returns. Nothing raised here reaches the graph.
 */
export class AgentViewerLangGraphCore {
  readonly runtimeId: string;

  private readonly options: AgentViewerLangGraphOptions;
  private readonly now: () => number;
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly runs = new Map<string, RunEntry>();
  private readonly registeredAgents = new Set<string>();
  private readonly viewers = new Map<string, AgentViewer>();
  private readonly queue: QueuedEvent[] = [];
  private readonly counters: AgentViewerLangGraphStats = { sent: 0, failed: 0, dropped: 0, callsWithoutUsage: 0 };
  /** Every drain chains onto this promise, so `flush()` resolves only after a drain started at or after the call. */
  private drainChain: Promise<void> = Promise.resolve();
  private drainScheduled = false;

  constructor(options: AgentViewerLangGraphOptions = {}) {
    this.options = options;
    this.runtimeId = options.runtimeId ?? options.viewer?.runtimeId ?? DEFAULT_RUNTIME_ID;
    this.now = options.now ?? Date.now;
    this.maxQueue = Math.max(1, Math.floor(options.maxQueue ?? DEFAULT_MAX_QUEUE));
    this.batchSize = Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE)));
  }

  // -------------------------------------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------------------------------------

  stats(): AgentViewerLangGraphStats {
    return { ...this.counters };
  }

  /** Resolves once every event queued before the call has been sent or has failed. */
  flush(): Promise<void> {
    return this.triggerDrain();
  }

  // -------------------------------------------------------------------------------------------------------
  // Chain (node) callbacks
  // -------------------------------------------------------------------------------------------------------

  handleChainStart(
    chain: SerializedLike | undefined,
    _inputs: unknown,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    name?: string,
  ): void {
    this.guard(() => {
      if (this.runs.has(runId)) return;
      const meta = filterMetadata(metadata);
      const node = nonEmptyString(meta.langgraph_node);
      // LangGraph tags the node and every runnable inside it with the same langgraph_node; only the run named
      // after the node is the node, and a same-named run nested in that node run is still the same node.
      const isNode = node !== undefined && runName(chain, name) === node && this.nodeRunFor(parentRunId)?.node !== node;
      if (!isNode) {
        this.track(runId, { kind: 'chain', parentRunId, startedAtMs: this.now(), meta });
        return;
      }
      const agent = this.resolveAgent(node, meta);
      this.track(runId, { kind: 'node', parentRunId, startedAtMs: this.now(), meta, node, agentId: agent.id });
      this.register(runId, agent, meta);
      this.emit(runId, 'node.started', 'agent.status.changed', agent.id, meta, `${node} started`, {
        status: 'THINKING',
        statusText: `Running node ${node}`,
        workspace: agent.workspace,
      });
    });
  }

  handleChainEnd(_outputs: unknown, runId: string): void {
    this.guard(() => {
      const run = this.take(runId);
      if (!run || run.kind !== 'node' || !run.agentId) return;
      this.emit(runId, 'node.completed', 'agent.status.changed', run.agentId, run.meta, `${run.node} finished`, {
        status: 'DONE',
        statusText: `Finished node ${run.node}`,
      });
    });
  }

  handleChainError(error: unknown, runId: string): void {
    this.guard(() => {
      const run = this.take(runId);
      if (!run || run.kind !== 'node' || !run.agentId) return;
      const name = errorName(error);
      const interrupted = INTERRUPT_ERRORS.has(name);
      const text = interrupted ? `Node ${run.node} interrupted` : `Node ${run.node} failed (${name})`;
      this.emit(
        runId,
        'node.failed',
        'agent.status.changed',
        run.agentId,
        run.meta,
        text,
        { status: interrupted ? 'WAITING' : 'BLOCKED', statusText: text },
        interrupted ? 'normal' : 'high',
      );
    });
  }

  // -------------------------------------------------------------------------------------------------------
  // Tool callbacks
  // -------------------------------------------------------------------------------------------------------

  handleToolStart(
    tool: SerializedLike | undefined,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    name?: string,
    toolCallId?: string,
  ): void {
    this.guard(() => {
      if (this.runs.has(runId)) return;
      const meta = filterMetadata(metadata);
      const agent = this.agentFor(runId, parentRunId, meta);
      const toolName = runName(tool, name) ?? 'tool';
      // No toolCallId outside a tool-calling model turn: the run id keeps started/completed paired.
      const callId = nonEmptyString(toolCallId) ?? runId;
      this.track(runId, { kind: 'tool', parentRunId, startedAtMs: this.now(), meta, agentId: agent.id, toolName, toolCallId: callId });
      const summarize = this.options.toolInputSummary;
      this.emit(runId, 'tool.started', 'tool.started', agent.id, meta, `Started tool ${toolName}`, {
        tool: toolName,
        toolCallId: callId,
        inputSummary: summarize ? this.safeSummary(() => summarize(toolName, input)) : undefined,
      });
    });
  }

  handleToolEnd(output: unknown, runId: string): void {
    this.guard(() => {
      const run = this.take(runId);
      if (!run || run.kind !== 'tool' || !run.agentId || !run.toolName) return;
      const toolName = run.toolName;
      const summarize = this.options.toolOutputSummary;
      this.emit(runId, 'tool.completed', 'tool.completed', run.agentId, run.meta, `Completed tool ${toolName}`, {
        tool: toolName,
        toolCallId: run.toolCallId,
        outputSummary: summarize ? this.safeSummary(() => summarize(toolName, output)) : undefined,
        durationMs: this.elapsed(run),
      });
    });
  }

  handleToolError(error: unknown, runId: string): void {
    this.guard(() => {
      const run = this.take(runId);
      if (!run || run.kind !== 'tool' || !run.agentId) return;
      this.emit(
        runId,
        'tool.failed',
        'tool.failed',
        run.agentId,
        run.meta,
        `Failed tool ${run.toolName}`,
        { tool: run.toolName, toolCallId: run.toolCallId, error: errorName(error), durationMs: this.elapsed(run) },
        'high',
      );
    });
  }

  // -------------------------------------------------------------------------------------------------------
  // Model callbacks
  // -------------------------------------------------------------------------------------------------------

  handleLLMStart(
    _llm: SerializedLike | undefined,
    _prompts: unknown,
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    this.guard(() => this.modelStart(runId, parentRunId, metadata));
  }

  handleChatModelStart(
    _llm: SerializedLike | undefined,
    _messages: unknown,
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    this.guard(() => this.modelStart(runId, parentRunId, metadata));
  }

  handleLLMEnd(output: unknown, runId: string): void {
    this.guard(() => {
      const run = this.take(runId);
      if (!run || run.kind !== 'llm' || !run.agentId) return;
      const usage = extractUsage(output);
      if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
        // llm.usage requires both counts; sending a guessed 0 would understate the call.
        this.counters.callsWithoutUsage++;
        this.debugLog(`model run ${runId} ended without input and output token counts; no llm.usage sent`);
        return;
      }
      const reported = this.reportedCost(output);
      const provider = run.provider ?? 'unknown';
      const model = run.model ?? 'unknown';
      this.emit(
        runId,
        'llm.usage',
        'llm.usage',
        run.agentId,
        run.meta,
        `${provider}/${model} tokens (${usage.inputTokens}+${usage.outputTokens})`,
        {
          provider,
          model,
          ...usage,
          latencyMs: this.elapsed(run),
          cost: reported?.cost,
          currency: reported?.currency,
          costSource: reported ? 'provider-reported' : 'unknown',
        },
      );
    });
  }

  handleLLMError(error: unknown, runId: string): void {
    this.guard(() => {
      const run = this.take(runId);
      if (!run || run.kind !== 'llm' || !run.agentId) return;
      const provider = run.provider ?? 'unknown';
      const status = httpStatus(error);
      this.emit(
        runId,
        'llm.failed',
        'llm.failed',
        run.agentId,
        run.meta,
        `${provider}/${run.model ?? 'unknown'} call failed`,
        {
          provider,
          model: run.model,
          errorKind: errorKind(error, status),
          httpStatus: status,
          latencyMs: this.elapsed(run),
          costSource: 'unknown',
        },
        'high',
      );
    });
  }

  // -------------------------------------------------------------------------------------------------------
  // Run map and attribution
  // -------------------------------------------------------------------------------------------------------

  private modelStart(runId: string, parentRunId: string | undefined, metadata: Record<string, unknown> | undefined): void {
    if (this.runs.has(runId)) return;
    const meta = filterMetadata(metadata);
    const agent = this.agentFor(runId, parentRunId, meta);
    this.track(runId, {
      kind: 'llm',
      parentRunId,
      startedAtMs: this.now(),
      meta,
      agentId: agent.id,
      provider: nonEmptyString(meta.ls_provider),
      model: nonEmptyString(meta.ls_model_name),
    });
  }

  private track(runId: string, entry: RunEntry): void {
    while (this.runs.size >= MAX_RUNS) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) break;
      this.runs.delete(oldest);
      this.counters.dropped++;
    }
    this.runs.set(runId, entry);
  }

  private take(runId: string): RunEntry | undefined {
    const run = this.runs.get(runId);
    if (run) this.runs.delete(runId);
    return run;
  }

  /** Nearest node run up the parent chain, starting at `runId` itself. Bounded, so a cycle cannot hang. */
  private nodeRunFor(runId: string | undefined): RunEntry | undefined {
    let current = runId;
    for (let depth = 0; current !== undefined && depth < MAX_RUNS; depth++) {
      const run = this.runs.get(current);
      if (!run) return undefined;
      if (run.kind === 'node') return run;
      current = run.parentRunId;
    }
    return undefined;
  }

  /**
   * Agent of a model or tool run: the nearest node run ancestor's. When that ancestor is unknown (evicted, or
   * the handler was attached below the node) the run's own `langgraph_node` metadata is used, then the
   * `langgraph` fallback agent.
   */
  private agentFor(runId: string, parentRunId: string | undefined, meta: LangGraphMetadata): AgentViewerLangGraphAgent {
    const owner = this.nodeRunFor(parentRunId);
    if (owner?.agentId) return { id: owner.agentId };
    const node = nonEmptyString(meta.langgraph_node);
    const agent = node ? this.resolveAgent(node, meta) : { id: DEFAULT_AGENT_ID, name: 'LangGraph', roleTitle: 'LangGraph graph' };
    this.register(runId, agent, meta);
    return agent;
  }

  private resolveAgent(node: string, meta: LangGraphMetadata): AgentViewerLangGraphAgent {
    const mapped = this.options.agentForNode?.(node, { ...meta });
    if (typeof mapped === 'string' && mapped.length > 0) return { id: mapped, name: node };
    if (mapped && typeof mapped === 'object' && nonEmptyString(mapped.id)) return { name: node, ...mapped };
    return { id: node, name: node };
  }

  private register(runId: string, agent: AgentViewerLangGraphAgent, meta: LangGraphMetadata): void {
    if (this.registeredAgents.has(agent.id)) return;
    this.registeredAgents.add(agent.id);
    this.emit(runId, 'agent.registered', 'agent.registered', agent.id, meta, `Registered ${agent.id}`, {
      id: agent.id,
      name: agent.name ?? agent.id,
      roleTitle: agent.roleTitle ?? 'LangGraph node',
      workspace: agent.workspace,
      provider: 'LangGraph',
      model: 'LangGraph',
    });
  }

  private elapsed(run: RunEntry): number {
    return Math.max(0, Math.round(this.now() - run.startedAtMs));
  }

  // -------------------------------------------------------------------------------------------------------
  // Event building and the send queue
  // -------------------------------------------------------------------------------------------------------

  private emit(
    runId: string,
    kind: string,
    type: string,
    agentId: string,
    meta: LangGraphMetadata,
    summary: string,
    payload: Record<string, unknown>,
    severity: EventSeverity = 'normal',
  ): void {
    const sessionFor = this.options.sessionFor;
    const sessionId = sessionFor
      ? sessionFor({ ...meta })
      : meta.thread_id !== undefined ? String(meta.thread_id) : undefined;
    const input: EmitEventInput = {
      id: `lg:${this.runtimeId}:${runId}:${kind}`,
      type,
      timestamp: this.now(),
      source: `agent:${agentId}`,
      agentId,
      taskId: this.options.taskFor?.({ ...meta }),
      severity,
      summary,
      payload: withoutUndefined(payload),
    };
    if (input.taskId === undefined) delete input.taskId;
    if (this.queue.length >= this.maxQueue) {
      this.counters.dropped++;
      this.reportError(new Error('Agent Viewer LangGraph queue is full; event dropped'), input);
      return;
    }
    this.queue.push({ sessionId: nonEmptyString(sessionId), input });
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    void this.triggerDrain();
  }

  private triggerDrain(): Promise<void> {
    const next = this.drainChain.then(() => this.drain());
    this.drainChain = next.catch(() => undefined);
    return next;
  }

  private async drain(): Promise<void> {
    this.drainScheduled = false;
    while (this.queue.length > 0) {
      const chunk = this.queue.splice(0, this.batchSize);
      const bySession = new Map<string, QueuedEvent[]>();
      for (const item of chunk) {
        const key = item.sessionId ?? NO_SESSION_KEY;
        const list = bySession.get(key);
        if (list) list.push(item);
        else bySession.set(key, [item]);
      }
      for (const items of bySession.values()) {
        await this.send(items);
      }
    }
  }

  private async send(items: QueuedEvent[]): Promise<void> {
    try {
      const result = await this.viewerFor(items[0].sessionId).emitBatch(items.map((item) => item.input));
      // `emitBatch()` resolves with `EmitBatchQueuedResult` instead when the SDK's local durable queue
      // (this adapter never enables it) takes over: every event was queued, not yet confirmed by the server.
      if (typeof result.accepted !== 'number') {
        this.counters.sent += result.total;
        return;
      }
      this.counters.sent += result.accepted + result.duplicates;
      this.counters.failed += result.conflicts;
      for (const item of result.results) {
        if (item.status !== 'conflict') continue;
        const event = items.find((queued) => queued.input.id === item.id)?.input;
        this.reportError(new Error(`Agent Viewer rejected event ${item.id}: ${item.error ?? 'conflicting_duplicate'}`), event);
      }
    } catch (error) {
      this.counters.failed += items.length;
      for (const item of items) this.reportError(error, item.input);
    }
  }

  /** One client per session: `emitBatch` takes the session from the client, not from each event. */
  private viewerFor(sessionId: string | undefined): AgentViewer {
    const base = this.options.viewer;
    if (base && base.sessionId === sessionId && base.runtimeId === this.runtimeId) return base;
    const key = sessionId ?? NO_SESSION_KEY;
    let viewer = this.viewers.get(key);
    if (!viewer) {
      if (this.viewers.size >= MAX_SESSION_VIEWERS) {
        const oldest = this.viewers.keys().next().value;
        if (oldest !== undefined) this.viewers.delete(oldest);
      }
      viewer = new AgentViewer({
        url: base?.url ?? this.options.url,
        apiKey: base?.token ?? this.options.apiKey,
        runtimeId: this.runtimeId,
        sessionId,
        source: `runtime:${this.runtimeId}`,
        timeoutMs: base?.timeoutMs,
        maxRetries: base?.maxRetries,
        debug: base?.debug ?? this.options.debug,
        autoRegisterAgents: false,
      });
      this.viewers.set(key, viewer);
    }
    return viewer;
  }

  // -------------------------------------------------------------------------------------------------------
  // Error isolation
  // -------------------------------------------------------------------------------------------------------

  private reportedCost(output: unknown): { cost: number; currency?: string } | undefined {
    if (!this.options.reportedCost) return undefined;
    try {
      const reported = this.options.reportedCost(output);
      if (!reported || typeof reported.cost !== 'number' || !Number.isFinite(reported.cost) || reported.cost < 0) return undefined;
      return { cost: reported.cost, currency: nonEmptyString(reported.currency) };
    } catch (error) {
      this.reportError(error);
      return undefined;
    }
  }

  private safeSummary(fn: () => string | undefined): string | undefined {
    try {
      return nonEmptyString(fn());
    } catch (error) {
      this.reportError(error);
      return undefined;
    }
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown, droppedEvent?: EmitEventInput): void {
    if (this.options.onError) {
      try {
        this.options.onError(error, droppedEvent);
      } catch {
        // A throwing onError must not reach the graph either.
      }
      return;
    }
    this.debugLog('error (ignored, never thrown into the graph):', error);
  }

  private debugLog(...args: unknown[]): void {
    if (this.options.debug) console.warn('[AgentViewerCallbackHandler]', ...args);
  }
}
