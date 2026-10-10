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

/**
 * @deprecated demo-only. Attributes an agent's whole running totals to its *last reported* model, so an agent
 * that called two models during a session is counted entirely under the one it reported most recently. Issue
 * #79 moves the Matrix, Agents and Feed tabs of Model Ops to the server's usage-ledger rollup and calls read
 * APIs, which have one row per call instead. This function
 * stays exported, unchanged in behavior, for `simulated` Model Ops mode (no API base configured) and for the
 * in-office telemetry plaque (`canvasRenderer.ts`), which the office totals work (#55/#78) will migrate later.
 * `engine/modelOps.ts` is part of the embeddable library bundle (`dist-lib/engine/modelOps.js`, pulled in by
 * `canvasRenderer`), so this file never gains a ledger import or any new usage logic.
 */
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

/** The catalog spec for a model id, or `undefined` when the demo catalog does not know it. No fallback. */
export function getModelSpec(modelId: string): ModelSpec | undefined {
  return MODEL_CATALOG[modelId];
}

/**
 * Estimated cost of a call against the demo catalog, or `null` when the model is not in the catalog. A
 * model the catalog does not know has no price: it is never shown as GPT-4o's price.
 */
export function calculateModelCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0
): number | null {
  const spec = getModelSpec(modelId);
  if (!spec) return null;
  const regularInput = Math.max(0, inputTokens - cachedTokens);
  const cost =
    (regularInput / 1_000_000) * spec.inputPer1M +
    (cachedTokens / 1_000_000) * spec.cachePer1M +
    (outputTokens / 1_000_000) * spec.outputPer1M;
  return Number(cost.toFixed(6));
}

export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

/** A preset shape of the simulator / quick actions. */
export type SimulatedCallPreset = 'chat' | 'code' | 'rag' | 'batch' | 'custom';

/**
 * A what-if call from the Model Ops simulator. It never reaches `SimulationState`: not `agents[*].tokens*`
 * or `.cost`, not `totalTokens`/`totalCost`, not `events`. It exists only so the Simulated section of the
 * Feed tab and the simulator summary can show it, always tagged `simulated: true`.
 */
export interface SimulatedCall {
  id: string;
  /** Literal marker, like `SocialActivity.simulated`, so nothing ever mistakes it for real usage. */
  simulated: true;
  timestamp: number;
  provider: string;
  model: string;
  /** The agent whose speech bubble shows it; `null` when there is no matching agent (simulator operator). */
  agentId: string | null;
  preset: SimulatedCallPreset;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** `null` when the model is not in the demo catalog: an unknown model has no estimate. */
  estimatedCost: number | null;
  /** `null` exactly when `estimatedCost` is `null`. */
  currency: 'USD' | null;
  /** Demo catalog latency; `null` when the model is not in the catalog. */
  latencyMs: number | null;
}

export const SIMULATED_CALLS_LIMIT = 50;

/** Pure helper: prepends a call and caps the list at `SIMULATED_CALLS_LIMIT`. Never touches `SimulationState`. */
export function recordSimulatedCall(calls: SimulatedCall[], call: SimulatedCall): SimulatedCall[] {
  const entry: SimulatedCall = { ...call, simulated: true };
  return [entry, ...calls].slice(0, SIMULATED_CALLS_LIMIT);
}

/** Id for a simulated call: `crypto.randomUUID()` when the platform has it, a fallback otherwise. */
export function generateSimulatedCallId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `sim-${cryptoApi.randomUUID()}`;
  }
  return `sim-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
