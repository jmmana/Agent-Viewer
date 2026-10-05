import type { Agent, ViewerEvent } from '../types/agent';

export interface ModelUsageAggregate {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  percentageShare: number;
  agentIds: string[];
}

export interface ProviderMetadata {
  name: string;
  color: string;
  badgeBg: string;
  badgeBorder: string;
  accent: string;
  glow: string;
  description: string;
}

export const PROVIDER_METADATA: Record<string, ProviderMetadata> = {
  'OpenAI': {
    name: 'OpenAI',
    color: '#10a37f',
    badgeBg: 'bg-emerald-500/10',
    badgeBorder: 'border-emerald-500/30',
    accent: 'text-emerald-400',
    glow: 'rgba(16, 163, 127, 0.4)',
    description: 'GPT-4o, GPT-4 Turbo, o1 Reasoning engine',
  },
  'Anthropic': {
    name: 'Anthropic',
    color: '#d97706',
    badgeBg: 'bg-amber-500/10',
    badgeBorder: 'border-amber-500/30',
    accent: 'text-amber-400',
    glow: 'rgba(217, 119, 6, 0.4)',
    description: 'Claude 3.5 Sonnet, Claude 3 Opus, Haiku',
  },
  'Google Gemini': {
    name: 'Google Gemini',
    color: '#2563eb',
    badgeBg: 'bg-sky-500/10',
    badgeBorder: 'border-sky-500/30',
    accent: 'text-sky-400',
    glow: 'rgba(37, 99, 235, 0.4)',
    description: 'Gemini 2.5 Pro, Gemini 2.5 Flash, Multimodal 2M context',
  },
  'Local (Ollama)': {
    name: 'Local (Ollama)',
    color: '#a855f7',
    badgeBg: 'bg-purple-500/10',
    badgeBorder: 'border-purple-500/30',
    accent: 'text-purple-400',
    glow: 'rgba(168, 85, 247, 0.4)',
    description: 'Local on-premise execution (Llama 3.3, DeepSeek R1)',
  },
};

export function getProviderMeta(provider: string): ProviderMetadata {
  return PROVIDER_METADATA[provider] ?? {
    name: provider,
    color: '#38bdf8',
    badgeBg: 'bg-cyan-500/10',
    badgeBorder: 'border-cyan-500/30',
    accent: 'text-cyan-400',
    glow: 'rgba(56, 189, 248, 0.4)',
    description: 'External LLM Provider endpoint',
  };
}

export interface ProviderUsageAggregate {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  activeAgents: number;
  percentageShare: number;
  models: ModelUsageAggregate[];
}

export function aggregateModelUsage(agents: Agent[]): ProviderUsageAggregate[] {
  const models = new Map<string, ModelUsageAggregate>();
  let officeTotalTokens = 0;

  for (const agent of agents) {
    const key = `${agent.provider}::${agent.model}`;
    const agentTokens = agent.tokensInput + agent.tokensOutput;
    officeTotalTokens += agentTokens;

    const current = models.get(key) ?? {
      provider: agent.provider,
      model: agent.model,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      cost: 0,
      percentageShare: 0,
      agentIds: [],
    };

    current.inputTokens += agent.tokensInput;
    current.outputTokens += agent.tokensOutput;
    current.cachedTokens += agent.cachedTokens;
    current.reasoningTokens += agent.reasoningTokens;
    current.totalTokens += agentTokens;
    current.cost += agent.cost;
    if (!current.agentIds.includes(agent.id)) current.agentIds.push(agent.id);
    models.set(key, current);
  }

  // Calculate model percentage share
  for (const model of models.values()) {
    model.percentageShare = officeTotalTokens > 0 ? (model.totalTokens / officeTotalTokens) * 100 : 0;
  }

  const providers = new Map<string, ProviderUsageAggregate>();
  for (const model of models.values()) {
    const provider = providers.get(model.provider) ?? {
      provider: model.provider,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      cost: 0,
      activeAgents: 0,
      percentageShare: 0,
      models: [],
    };

    provider.inputTokens += model.inputTokens;
    provider.outputTokens += model.outputTokens;
    provider.cachedTokens += model.cachedTokens;
    provider.reasoningTokens += model.reasoningTokens;
    provider.totalTokens += model.totalTokens;
    provider.cost += model.cost;
    provider.activeAgents += model.agentIds.length;
    provider.models.push(model);
    providers.set(model.provider, provider);
  }

  return [...providers.values()]
    .map((provider) => ({
      ...provider,
      percentageShare: officeTotalTokens > 0 ? (provider.totalTokens / officeTotalTokens) * 100 : 0,
      models: provider.models.sort((a, b) => b.totalTokens - a.totalTokens),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export interface ModelSpec {
  id: string;
  name: string;
  provider: string;
  contextWindow: string;
  inputPer1M: number;
  outputPer1M: number;
  cachePer1M: number;
  type: 'general' | 'reasoning' | 'fast' | 'local';
  description: string;
  latencyMs: number;
}

export const MODEL_CATALOG: Record<string, ModelSpec> = {
  'gpt-4o': {
    id: 'gpt-4o',
    name: 'GPT-4o (Omni)',
    provider: 'OpenAI',
    contextWindow: '128K',
    inputPer1M: 2.50,
    outputPer1M: 10.00,
    cachePer1M: 1.25,
    type: 'general',
    description: 'Flagship multimodal model with high speed and precision',
    latencyMs: 650,
  },
  'o1-mini': {
    id: 'o1-mini',
    name: 'o1-mini (Reasoning)',
    provider: 'OpenAI',
    contextWindow: '128K',
    inputPer1M: 3.00,
    outputPer1M: 12.00,
    cachePer1M: 1.50,
    type: 'reasoning',
    description: 'Advanced chain-of-thought reasoning for logic and math',
    latencyMs: 1400,
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'OpenAI',
    contextWindow: '128K',
    inputPer1M: 0.15,
    outputPer1M: 0.60,
    cachePer1M: 0.075,
    type: 'fast',
    description: 'Ultra-fast, cost-effective inference for high throughput',
    latencyMs: 320,
  },
  'claude-3-5-sonnet': {
    id: 'claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    contextWindow: '200K',
    inputPer1M: 3.00,
    outputPer1M: 15.00,
    cachePer1M: 0.30,
    type: 'general',
    description: 'Premier coding, architectural reasoning and artifact generation',
    latencyMs: 780,
  },
  'claude-3-5-haiku': {
    id: 'claude-3-5-haiku',
    name: 'Claude 3.5 Haiku',
    provider: 'Anthropic',
    contextWindow: '200K',
    inputPer1M: 0.80,
    outputPer1M: 4.00,
    cachePer1M: 0.08,
    type: 'fast',
    description: 'Sub-second response time for triage, QA and test generation',
    latencyMs: 290,
  },
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'Google Gemini',
    contextWindow: '2M',
    inputPer1M: 1.25,
    outputPer1M: 5.00,
    cachePer1M: 0.31,
    type: 'general',
    description: 'Massive 2M context window with native multimodal and code synthesis',
    latencyMs: 720,
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'Google Gemini',
    contextWindow: '1M',
    inputPer1M: 0.075,
    outputPer1M: 0.30,
    cachePer1M: 0.019,
    type: 'fast',
    description: 'Breakthrough speed with million-token context at fraction of cost',
    latencyMs: 240,
  },
  'llama-3.3-70b': {
    id: 'llama-3.3-70b',
    name: 'Llama 3.3 70B (Ollama)',
    provider: 'Local (Ollama)',
    contextWindow: '128K',
    inputPer1M: 0.00,
    outputPer1M: 0.00,
    cachePer1M: 0.00,
    type: 'local',
    description: 'Zero-cloud airgapped local execution on on-premise hardware',
    latencyMs: 510,
  },
  'deepseek-r1-distill': {
    id: 'deepseek-r1-distill',
    name: 'DeepSeek R1 Distill',
    provider: 'Local (Ollama)',
    contextWindow: '64K',
    inputPer1M: 0.00,
    outputPer1M: 0.00,
    cachePer1M: 0.00,
    type: 'reasoning',
    description: 'Open-weights reasoning engine executed locally without cloud egress',
    latencyMs: 890,
  },
};

export function calculateModelCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0
): number {
  const spec = MODEL_CATALOG[modelId] || MODEL_CATALOG['gpt-4o'];
  const regularInput = Math.max(0, inputTokens - cachedTokens);
  const cost =
    (regularInput / 1_000_000) * spec.inputPer1M +
    (cachedTokens / 1_000_000) * spec.cachePer1M +
    (outputTokens / 1_000_000) * spec.outputPer1M;
  return Number(cost.toFixed(6));
}

export interface InferenceLogItem {
  id: string;
  timestamp: number;
  provider: string;
  model: string;
  agentName: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
  latencyMs: number;
  status: '200 OK' | 'CACHED' | 'STREAMING';
  promptSnippet: string;
}

export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

export interface SimulatedTokenBurst {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  cost: number;
  latencyMs: number;
  timestamp: number;
}
