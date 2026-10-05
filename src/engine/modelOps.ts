import type { Agent } from '../types/agent';

export interface ModelUsageAggregate {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  agentIds: string[];
}

export interface ProviderUsageAggregate {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  cost: number;
  activeAgents: number;
  models: ModelUsageAggregate[];
}

export function aggregateModelUsage(agents: Agent[]): ProviderUsageAggregate[] {
  const models = new Map<string, ModelUsageAggregate>();

  for (const agent of agents) {
    const key = `${agent.provider}::${agent.model}`;
    const current = models.get(key) ?? {
      provider: agent.provider,
      model: agent.model,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      cost: 0,
      agentIds: [],
    };

    current.inputTokens += agent.tokensInput;
    current.outputTokens += agent.tokensOutput;
    current.cachedTokens += agent.cachedTokens;
    current.reasoningTokens += agent.reasoningTokens;
    current.totalTokens += agent.tokensInput + agent.tokensOutput;
    current.cost += agent.cost;
    if (!current.agentIds.includes(agent.id)) current.agentIds.push(agent.id);
    models.set(key, current);
  }

  const providers = new Map<string, ProviderUsageAggregate>();
  for (const model of models.values()) {
    const provider = providers.get(model.provider) ?? {
      provider: model.provider,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      cost: 0,
      activeAgents: 0,
      models: [],
    };

    provider.inputTokens += model.inputTokens;
    provider.outputTokens += model.outputTokens;
    provider.cachedTokens += model.cachedTokens;
    provider.totalTokens += model.totalTokens;
    provider.cost += model.cost;
    provider.activeAgents += model.agentIds.length;
    provider.models.push(model);
    providers.set(model.provider, provider);
  }

  return [...providers.values()]
    .map((provider) => ({
      ...provider,
      models: provider.models.sort((a, b) => b.totalTokens - a.totalTokens),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}
