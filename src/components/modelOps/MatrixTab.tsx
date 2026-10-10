/**
 * Matrix tab (issue #79): mode switch between the ledger-backed view (`LedgerMatrixView`, real data from
 * `GET /api/v1/usage/rollup`) and the pre-ledger simulated view (demo agent counters, catalog prices), shown only
 * when the portal has no API base at all (`simulated` mode). The simulated view carries the "Simulated demo data"
 * banner and no longer offers the "Simulate"/"Configure" shortcuts: simulation lives only in the Simulator tab.
 */
import React, { useMemo, useState } from 'react';
import type { Agent } from '../../types/agent';
import { t, type Locale, type TranslationKey } from '../../i18n';
import { aggregateModelUsage, compactTokens, getModelSpec, getProviderMeta, MODEL_CATALOG } from '../../engine/modelOps';
import type { ModelOpsMode, QueryState, TimeRangeOption } from './useModelOpsLedger';
import type { RollupResponse } from '../../integrations/ledgerClient';
import { LedgerMatrixView } from './LedgerMatrixView';
import { ArrowUpRight, Cpu, Filter, Layers, Search, Users } from 'lucide-react';

type MessageParams = Record<string, string | number>;

const PROVIDER_DESC_KEYS: Record<string, TranslationKey> = {
  OpenAI: 'ops.provider.desc.openai',
  Anthropic: 'ops.provider.desc.anthropic',
  'Google Gemini': 'ops.provider.desc.gemini',
  'Local (Ollama)': 'ops.provider.desc.ollama',
};

const MODEL_DESC_KEYS: Record<string, TranslationKey> = {
  'gpt-4o': 'ops.model.desc.gpt-4o',
  'o1-mini': 'ops.model.desc.o1-mini',
  'gpt-4o-mini': 'ops.model.desc.gpt-4o-mini',
  'claude-3-5-sonnet': 'ops.model.desc.claude-3-5-sonnet',
  'claude-3-5-haiku': 'ops.model.desc.claude-3-5-haiku',
  'gemini-2.5-pro': 'ops.model.desc.gemini-2.5-pro',
  'gemini-2.5-flash': 'ops.model.desc.gemini-2.5-flash',
  'llama-3.3-70b': 'ops.model.desc.llama-3.3-70b',
  'deepseek-r1-distill': 'ops.model.desc.deepseek-r1-distill',
};

export interface MatrixTabProps {
  mode: ModelOpsMode;
  locale: Locale;
  agents: Agent[];
  onFocusAgent: (agent: Agent) => void;
  onClose: () => void;
  initialProviderFilter?: string | null;
  modelRollup: QueryState<RollupResponse>;
  providerRollup: QueryState<RollupResponse>;
  timeRange: TimeRangeOption;
  onTimeRangeChange: (range: TimeRangeOption) => void;
  onRetry: () => void;
  apiBase?: string;
}

export const MatrixTab: React.FC<MatrixTabProps> = (props) => {
  if (props.mode === 'ledger') {
    return (
      <LedgerMatrixView
        locale={props.locale}
        modelRollup={props.modelRollup}
        providerRollup={props.providerRollup}
        timeRange={props.timeRange}
        onTimeRangeChange={props.onTimeRangeChange}
        onRetry={props.onRetry}
        apiBase={props.apiBase ?? ''}
        agents={props.agents}
        onFocusAgent={props.onFocusAgent}
        onClose={props.onClose}
        initialProviderFilter={props.initialProviderFilter}
      />
    );
  }
  return (
    <SimulatedMatrixView
      locale={props.locale}
      agents={props.agents}
      onFocusAgent={props.onFocusAgent}
      onClose={props.onClose}
      initialProviderFilter={props.initialProviderFilter}
    />
  );
};

const SimulatedMatrixView: React.FC<{
  locale: Locale;
  agents: Agent[];
  onFocusAgent: (agent: Agent) => void;
  onClose: () => void;
  initialProviderFilter?: string | null;
}> = ({ locale, agents, onFocusAgent, onClose, initialProviderFilter = null }) => {
  const tr = (key: TranslationKey, params?: MessageParams) => t(locale, key, params);
  const [selectedProvider, setSelectedProvider] = useState<string>(initialProviderFilter ?? 'all');
  const [sortBy, setSortBy] = useState<'tokens' | 'cost' | 'output' | 'input'>('tokens');
  const [searchQuery, setSearchQuery] = useState('');

  const providerData = useMemo(() => aggregateModelUsage(agents), [agents]);

  const displayedProviders = useMemo(
    () => (selectedProvider === 'all' ? providerData : providerData.filter((p) => p.provider.toLowerCase() === selectedProvider.toLowerCase())),
    [providerData, selectedProvider]
  );

  const displayedModels = useMemo(() => {
    const list = displayedProviders.flatMap((p) => p.models);
    const filtered = searchQuery.trim()
      ? list.filter((m) => m.model.toLowerCase().includes(searchQuery.toLowerCase()) || m.provider.toLowerCase().includes(searchQuery.toLowerCase()))
      : list;
    return [...filtered].sort((a, b) => {
      if (sortBy === 'cost') return b.cost - a.cost;
      if (sortBy === 'output') return b.outputTokens - a.outputTokens;
      if (sortBy === 'input') return b.inputTokens - a.inputTokens;
      return b.totalTokens - a.totalTokens;
    });
  }, [displayedProviders, searchQuery, sortBy]);

  const maxModelTokens = Math.max(...displayedModels.map((m) => m.totalTokens), 1);
  const providerDescription = (provider: string) => tr(PROVIDER_DESC_KEYS[provider] ?? 'ops.provider.desc.external');
  const modelDescription = (modelId: string, fallback: string) => {
    const key = MODEL_DESC_KEYS[modelId];
    return key ? tr(key) : fallback;
  };

  return (
    <div className="space-y-6">
      <div role="status" className="flex items-center gap-2 p-3 rounded-xl bg-amber-950/30 border border-amber-500/30 text-amber-200 text-[11px]">
        <span>{tr('ops.banner.simulatedData')}</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-slate-950/80 border border-slate-800">
        <div role="group" aria-label={tr('ops.filter.providerGroup')} className="flex items-center gap-1.5 flex-wrap">
          <span className="text-slate-400 font-medium mr-1 flex items-center gap-1">
            <Filter className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
            <span>{tr('ops.filter.provider')}</span>
          </span>
          <button
            type="button"
            aria-pressed={selectedProvider === 'all'}
            onClick={() => setSelectedProvider('all')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${selectedProvider === 'all' ? 'bg-cyan-700 text-white font-bold' : 'bg-slate-900 hover:bg-slate-800 text-slate-300'}`}
          >
            {tr('ops.filter.all', { count: providerData.length })}
          </button>
          {providerData.map((prov) => {
            const meta = getProviderMeta(prov.provider);
            const isSelected = selectedProvider.toLowerCase() === prov.provider.toLowerCase();
            return (
              <button
                key={prov.provider}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setSelectedProvider(prov.provider)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-colors border ${isSelected ? 'bg-slate-800 text-white font-bold border-cyan-400' : 'bg-slate-900/70 hover:bg-slate-800 text-slate-300 border-slate-800'}`}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: meta.color }} aria-hidden="true" />
                <span>{prov.provider}</span>
                <span className="text-[10px] text-slate-400 font-mono">({compactTokens(prov.totalTokens)})</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              type="text"
              aria-label={tr('ops.search.label')}
              placeholder={tr('ops.search.placeholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-slate-900 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 w-48 font-mono"
            />
          </div>
          <div role="group" aria-labelledby="av-modelops-sort-label" className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
            <span id="av-modelops-sort-label" className="text-[10px] text-slate-400 px-1.5 font-medium">{tr('ops.sort.label')}</span>
            <button type="button" aria-pressed={sortBy === 'tokens'} onClick={() => setSortBy('tokens')} className={`px-2 py-1 rounded text-[11px] ${sortBy === 'tokens' ? 'bg-cyan-500/20 text-cyan-300 font-bold' : 'text-slate-400 hover:text-white'}`}>{tr('ops.sort.tokens')}</button>
            <button type="button" aria-pressed={sortBy === 'cost'} onClick={() => setSortBy('cost')} className={`px-2 py-1 rounded text-[11px] ${sortBy === 'cost' ? 'bg-emerald-500/20 text-emerald-300 font-bold' : 'text-slate-400 hover:text-white'}`}>{tr('ops.sort.cost')}</button>
            <button type="button" aria-pressed={sortBy === 'output'} onClick={() => setSortBy('output')} className={`px-2 py-1 rounded text-[11px] ${sortBy === 'output' ? 'bg-purple-500/20 text-purple-300 font-bold' : 'text-slate-400 hover:text-white'}`}>{tr('ops.sort.output')}</button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Layers className="w-4 h-4 text-cyan-400" aria-hidden="true" />
            <span>{tr('ops.providers.heading')}</span>
          </h3>
          <span className="text-slate-400 text-[11px]">{tr('ops.providers.monitored', { count: displayedProviders.length })}</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {displayedProviders.map((provider) => {
            const meta = getProviderMeta(provider.provider);
            const isSelected = selectedProvider.toLowerCase() === provider.provider.toLowerCase();
            return (
              <div key={provider.provider} className={`bg-slate-950 p-4 rounded-xl border transition-all space-y-3 relative overflow-hidden ${isSelected ? 'border-cyan-500/60' : 'border-slate-800 hover:border-slate-700'}`}>
                <div className="absolute top-0 left-0 right-0 h-1" style={{ backgroundColor: meta.color }} aria-hidden="true" />
                <div className="space-y-2 pt-1">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: meta.color }} aria-hidden="true" />
                        <h4 className="text-sm font-bold text-white">{provider.provider}</h4>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">{providerDescription(provider.provider)}</p>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-slate-800 text-slate-300">{tr('ops.provider.modelsCount', { count: provider.models.length })}</span>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-400">{tr('ops.provider.share')}</span>
                      <span className="font-mono font-bold text-white">{provider.percentageShare.toFixed(1)}%</span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800" aria-hidden="true">
                      <div className="h-full transition-all duration-500" style={{ width: `${Math.max(provider.percentageShare, 5)}%`, backgroundColor: meta.color }} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[11px] font-mono bg-slate-900/60 p-2.5 rounded-lg border border-slate-800/80">
                    <div><span className="text-slate-400 block text-[10px]">{tr('ops.metric.totalTokens')}</span><span className="font-bold text-white">{compactTokens(provider.totalTokens)}</span></div>
                    <div><span className="text-slate-400 block text-[10px]">{tr('ops.metric.costUsd')}</span><span className="font-bold text-emerald-400">${provider.cost.toFixed(4)}</span></div>
                    <div><span className="text-slate-400 block text-[10px]">{tr('ops.metric.inOut')}</span><span className="text-slate-300">{compactTokens(provider.inputTokens)} / {compactTokens(provider.outputTokens)}</span></div>
                    <div><span className="text-slate-400 block text-[10px]">{tr('ops.metric.agents')}</span><span className="text-cyan-400 font-semibold">{tr('ops.provider.activeAgents', { count: provider.activeAgents })}</span></div>
                  </div>
                </div>
                <div className="flex items-center justify-between pt-2 border-t border-slate-900">
                  <button type="button" onClick={() => setSelectedProvider(isSelected ? 'all' : provider.provider)} className="text-[11px] text-cyan-400 hover:text-cyan-300 font-medium flex items-center gap-1 transition-colors">
                    <span>{isSelected ? tr('ops.provider.showAll') : tr('ops.provider.filter')}</span>
                    <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-4 pt-2">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Cpu className="w-4 h-4 text-emerald-400" aria-hidden="true" />
              <span>{tr('ops.models.heading')}</span>
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5">{tr('ops.models.subtitle')}</p>
          </div>
          <span className="text-slate-400 text-[11px] font-mono">{tr('ops.models.showing', { count: displayedModels.length })}</span>
        </div>

        <div className="space-y-3">
          {displayedModels.length === 0 && (
            <p className="text-slate-400 text-[11px] italic p-4 rounded-xl bg-slate-950 border border-slate-800">{tr('ops.models.empty')}</p>
          )}
          {displayedModels.map((model) => {
            const meta = getProviderMeta(model.provider);
            const spec = getModelSpec(model.model);
            const assignedAgents = agents.filter((a) => a.provider === model.provider && a.model === model.model);
            const relativePercent = Math.max(4, (model.totalTokens / maxModelTokens) * 100);
            return (
              <div key={`${model.provider}-${model.model}`} className="bg-slate-950 p-4 rounded-xl border border-slate-800 hover:border-slate-700 transition-all space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ backgroundColor: meta.color }} aria-hidden="true" />
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-white font-mono">{spec?.name || model.model}</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${meta.badgeBg} ${meta.badgeBorder} ${meta.accent}`}>{model.provider}</span>
                        {spec && (
                          <>
                            <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-slate-800 text-slate-400">{tr('ops.models.context', { value: spec.contextWindow })}</span>
                            <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-slate-800 text-slate-400">{tr('ops.models.latency', { ms: spec.latencyMs })}</span>
                          </>
                        )}
                      </div>
                      <span className="text-[11px] text-slate-400 block mt-0.5">{spec ? modelDescription(spec.id, spec.description) : tr('ops.models.notInCatalog')}</span>
                    </div>
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="flex items-center justify-between text-[11px] font-mono">
                    <span className="text-slate-400">{tr('ops.models.relativeVolume')}</span>
                    <span className="text-white font-bold">{tr('ops.models.volumeValue', { tokens: model.totalTokens.toLocaleString(), share: model.percentageShare.toFixed(1) })}</span>
                  </div>
                  <div className="w-full h-2.5 rounded-full bg-slate-900 overflow-hidden border border-slate-800" aria-hidden="true">
                    <div className="h-full transition-all duration-500 rounded-full" style={{ width: `${relativePercent}%`, backgroundColor: meta.color }} />
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 font-mono text-[11px] bg-slate-900/80 p-3 rounded-lg border border-slate-800/80">
                  <div><span className="text-slate-400 block text-[10px]">{tr('ops.metric.totalTokens')}</span><span className="font-bold text-white text-xs">{compactTokens(model.totalTokens)}</span></div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">{tr('ops.metric.input')}</span>
                    <span className="text-sky-300 font-semibold">{compactTokens(model.inputTokens)}</span>
                    <span className="text-[10px] text-slate-400 block">{spec ? `$${spec.inputPer1M.toFixed(2)}/1M` : tr('ops.value.unknown')}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">{tr('ops.metric.output')}</span>
                    <span className="text-emerald-300 font-semibold">{compactTokens(model.outputTokens)}</span>
                    <span className="text-[10px] text-slate-400 block">{spec ? `$${spec.outputPer1M.toFixed(2)}/1M` : tr('ops.value.unknown')}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">{tr('ops.metric.cache')}</span>
                    <span className="text-purple-300 font-semibold">{compactTokens(model.cachedTokens)}</span>
                    <span className="text-[10px] text-slate-400 block">{spec ? `$${spec.cachePer1M.toFixed(2)}/1M` : tr('ops.value.unknown')}</span>
                  </div>
                  <div><span className="text-slate-400 block text-[10px]">{tr('ops.metric.reasoning')}</span><span className="text-amber-300 font-semibold">{compactTokens(model.reasoningTokens)}</span></div>
                  <div><span className="text-slate-400 block text-[10px]">{tr('ops.metric.estimatedCost')}</span><span className="font-bold text-emerald-400 text-xs">${model.cost.toFixed(4)}</span></div>
                </div>

                <div className="flex items-center justify-between pt-1 flex-wrap gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-slate-400 text-[11px] font-medium flex items-center gap-1">
                      <Users className="w-3 h-3 text-slate-400" aria-hidden="true" />
                      <span>{tr('ops.models.assignedAgents', { count: assignedAgents.length })}</span>
                    </span>
                    {assignedAgents.length > 0 ? (
                      assignedAgents.map((ag) => (
                        <button
                          key={ag.id}
                          type="button"
                          onClick={() => {
                            onFocusAgent(ag);
                            onClose();
                          }}
                          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[11px] text-slate-200 transition-colors"
                        >
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: ag.clothingColor }} aria-hidden="true" />
                          <span className="font-medium">{ag.name}</span>
                        </button>
                      ))
                    ) : (
                      <span className="text-slate-400 text-[11px] italic">{tr('ops.models.noAgents')}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/** Catalog of selectable simulator models, kept here (not `allModels`) because MODEL_CATALOG is the demo
 * catalog, independent of which models the office or the ledger happen to report. */
export const SIMULATOR_CATALOG_MODELS = Object.values(MODEL_CATALOG);
