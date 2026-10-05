export interface AgentViewerClientOptions {
  baseUrl: string;
  token?: string;
  source?: string;
}

export interface ViewerEventInput {
  id?: string;
  type: string;
  timestamp?: number;
  source?: string;
  target?: string;
  taskId?: string;
  summary: string;
  agentId?: string;
  payload: Record<string, unknown>;
}

export class AgentViewerClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly source: string;

  constructor(options: AgentViewerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.source = options.source ?? 'external-runtime';
  }

  async emit(input: ViewerEventInput): Promise<void> {
    const event = {
      schemaVersion: '1.0',
      id: input.id ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: input.type,
      timestamp: input.timestamp ?? Date.now(),
      source: input.source ?? this.source,
      target: input.target,
      taskId: input.taskId,
      agentId: input.agentId,
      severity: 'normal',
      summary: input.summary,
      payload: input.payload,
    };

    const response = await fetch(`${this.baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      throw new Error(`Agent Viewer rejected event: ${response.status} ${await response.text()}`);
    }
  }

  async registerAgent(agent: {
    id: string;
    name: string;
    roleTitle?: string;
    provider?: string;
    model?: string;
    managerId?: string;
  }): Promise<void> {
    await this.emit({
      type: 'agent.registered',
      source: `agent:${agent.id}`,
      agentId: agent.id,
      summary: `Registered ${agent.name}`,
      payload: agent,
    });
  }

  async status(agentId: string, status: string, options: { workspace?: string; statusText?: string } = {}): Promise<void> {
    await this.emit({
      type: 'agent.status.changed',
      source: `agent:${agentId}`,
      agentId,
      summary: `${agentId} → ${status}`,
      payload: { status, ...options },
    });
  }

  async message(agentId: string, text: string, targetAgentName?: string): Promise<void> {
    await this.emit({
      type: 'message.sent',
      source: `agent:${agentId}`,
      agentId,
      summary: `${agentId} sent a visible message`,
      payload: { text, targetAgentName },
    });
  }

  async llmUsage(agentId: string, usage: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    cost?: number;
    costSource?: 'provider-reported' | 'estimated' | 'unknown';
    latencyMs?: number;
    requestId?: string;
  }): Promise<void> {
    await this.emit({
      type: 'llm.usage',
      source: `agent:${agentId}`,
      agentId,
      summary: `${usage.provider}/${usage.model} usage reported`,
      payload: usage,
    });
  }

  async requestMeeting(args: {
    meetingId: string;
    initiatorId: string;
    participantIds: string[];
    title: string;
    topic: string;
    taskId?: string;
  }): Promise<void> {
    await this.emit({
      type: 'meeting.requested',
      source: `agent:${args.initiatorId}`,
      taskId: args.taskId,
      summary: args.title,
      payload: args,
    });
  }
}
