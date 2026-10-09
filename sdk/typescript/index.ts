import type { z } from 'zod';
import type {
  CanonicalEvent,
  CanonicalEventType,
  EventSeverity,
  LlmUsagePayloadSchema,
} from '../../src/integrations/canonicalContract';
import type { ViewerSnapshot } from '../../server/store';
import type { UsageSummary } from '../../server/usageAggregates';

export type { ViewerSnapshot } from '../../server/store';
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

const UNSTATED_COST_SOURCE_WARNING =
  "[AgentViewer] a cost was reported without costSource, so it is sent as costSource: 'unknown'. "
  + "Pass costSource: 'provider-reported' or 'estimated' to state where the cost comes from.";

/** Turns `null` into `undefined`, so an unknown figure is left out of the JSON body. */
function omitNull<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
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

export interface UsageOptions {
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

export class AgentViewerError extends Error {
  public readonly status?: number;
  public readonly issues?: Array<{ path: string; message: string }>;

  constructor(message: string, status?: number, issues?: Array<{ path: string; message: string }>) {
    super(message);
    this.name = 'AgentViewerError';
    this.status = status;
    this.issues = issues;
  }
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

  async toolStarted(tool: string, inputSummary?: string): Promise<void> {
    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'tool.started',
      source: `agent:${this.id}`,
      agentId: this.id,
      summary: inputSummary ? `Started ${tool}: ${inputSummary}` : `Started tool ${tool}`,
      payload: {
        tool,
        inputSummary,
      },
    });
  }

  async toolCompleted(tool: string, outputSummary?: string): Promise<void> {
    await this.ensureRegistered();
    await this.viewer.emit({
      type: 'tool.completed',
      source: `agent:${this.id}`,
      agentId: this.id,
      summary: outputSummary ? `Completed ${tool}: ${outputSummary}` : `Completed tool ${tool}`,
      payload: {
        tool,
        outputSummary,
      },
    });
  }

  async toolFailed(tool: string, errorSummary?: string): Promise<void> {
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
      id: input.id ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
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

  async emitBatch(inputs: EmitEventInput[]): Promise<{ accepted: number; duplicates: number }> {
    const events: CanonicalEvent[] = inputs.map((input) => ({
      schemaVersion: '1.0',
      id: input.id ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
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
    return result;
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

        // 4xx errors (client errors) should not be retried except 429
        if (response.status < 500 && response.status !== 429) {
          throw new AgentViewerError(
            parsedJson?.message || `Agent Viewer rejected request: ${response.status} ${responseText}`,
            response.status,
            parsedJson?.issues || parsedJson?.errors
          );
        }

        // Retryable server error or 429
        attempt++;
        if (attempt > this.maxRetries) {
          throw new AgentViewerError(`Agent Viewer request failed after ${this.maxRetries} retries: ${response.status} ${responseText}`, response.status);
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
