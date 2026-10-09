import React, { useState, useEffect, useMemo, useRef } from 'react';
import type { Agent, ViewerEvent } from '../types/agent';
import {
  aggregateModelUsage,
  compactTokens,
  getProviderMeta,
  MODEL_CATALOG,
  calculateModelCost,
  InferenceLogItem,
  SimulatedTokenBurst,
} from '../engine/modelOps';
import { t, type Locale, type TranslationKey } from '../i18n';
import { localizeDemoText } from '../content/demoScript';
import {
  X,
  Cpu,
  Zap,
  Server,
  Activity,
  DollarSign,
  Layers,
  Sparkles,
  Sliders,
  Filter,
  Users,
  CheckCircle2,
  Radio,
  Play,
  ArrowUpRight,
  Search,
  BarChart3,
  Database,
  Gauge,
  Flame,
  type LucideIcon,
} from 'lucide-react';

interface ModelOpsModalProps {
  isOpen: boolean;
  onClose: () => void;
  agents: Agent[];
  onFocusAgent: (agent: Agent) => void;
  onSimulateTokenBurst?: (burst: SimulatedTokenBurst) => void;
  onChangeAgentModel?: (agentId: string, newProvider: string, newModel: string) => void;
  initialProviderFilter?: string | null;
  events?: ViewerEvent[];
  locale: Locale;
}

type MessageParams = Record<string, string | number>;

type ModelOpsTab = 'matrix' | 'simulator' | 'agents' | 'feed';

const TABS: readonly ModelOpsTab[] = ['matrix', 'simulator', 'agents', 'feed'];

const TITLE_ID = 'av-modelops-title';
const PANEL_ID = 'av-modelops-panel';
const tabId = (tab: ModelOpsTab) => `av-modelops-tab-${tab}`;

/**
 * Feed entries keep the endpoint and a catalog key for the description, so the text follows the
 * current locale even for entries created before a language switch.
 */
type FeedItem = Omit<InferenceLogItem, 'promptSnippet' | 'agentName'> & {
  agentName: string | null;
  endpoint: string;
  snippetKey: TranslationKey;
  snippetParams?: MessageParams;
};

interface BurstNotice {
  provider: string;
  model: string;
  tokens: number;
  cost: number;
}

// Provider descriptions in the engine are English only; the modal shows the catalog text instead.
const PROVIDER_DESC_KEYS: Record<string, TranslationKey> = {
  OpenAI: 'ops.provider.desc.openai',
  Anthropic: 'ops.provider.desc.anthropic',
  'Google Gemini': 'ops.provider.desc.gemini',
  'Local (Ollama)': 'ops.provider.desc.ollama',
};

// Same for model descriptions, keyed by the model id of MODEL_CATALOG.
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

const STATUS_KEYS: Record<InferenceLogItem['status'], TranslationKey> = {
  '200 OK': 'ops.status.ok',
  CACHED: 'ops.status.cached',
  STREAMING: 'ops.status.streaming',
};

const TAB_KEYS: Record<ModelOpsTab, TranslationKey> = {
  matrix: 'ops.tab.matrix',
  simulator: 'ops.tab.simulator',
  agents: 'ops.tab.agents',
  feed: 'ops.tab.feed',
};

const TAB_ICONS: Record<ModelOpsTab, LucideIcon> = {
  matrix: BarChart3,
  simulator: Zap,
  agents: Users,
  feed: Activity,
};

export const ModelOpsModal: React.FC<ModelOpsModalProps> = ({
  isOpen,
  onClose,
  agents,
  onFocusAgent,
  onSimulateTokenBurst,
  onChangeAgentModel,
  initialProviderFilter = null,
  events = [],
  locale,
}) => {
  const tr = (key: TranslationKey, params?: MessageParams) => t(locale, key, params);

  const [selectedProvider, setSelectedProvider] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<ModelOpsTab>('matrix');
  const [sortBy, setSortBy] = useState<'tokens' | 'cost' | 'output' | 'input'>('tokens');
  const [searchQuery, setSearchQuery] = useState('');
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Simulator State
  const [selectedSimulatorModel, setSelectedSimulatorModel] = useState<string>('gpt-4o');
  const [simInputTokens, setSimInputTokens] = useState<number>(1800);
  const [simOutputTokens, setSimOutputTokens] = useState<number>(450);
  const [simCacheHitRatio, setSimCacheHitRatio] = useState<number>(0.35); // 35% cache
  const [lastBurstSuccess, setLastBurstSuccess] = useState<BurstNotice | null>(null);

  // Local live inference feed
  const [liveInferenceFeed, setLiveInferenceFeed] = useState<FeedItem[]>([
    {
      id: 'inf-init-1',
      timestamp: Date.now() - 1000 * 22,
      provider: 'OpenAI',
      model: 'gpt-4o',
      agentName: 'Elena Rostova',
      inputTokens: 3200,
      outputTokens: 780,
      cachedTokens: 1200,
      cost: 0.0173,
      latencyMs: 640,
      status: '200 OK',
      endpoint: 'POST /v1/chat/completions',
      snippetKey: 'ops.feed.snippet.gateway',
    },
    {
      id: 'inf-init-2',
      timestamp: Date.now() - 1000 * 48,
      provider: 'Anthropic',
      model: 'claude-3-5-sonnet',
      agentName: 'Kenji Sato',
      inputTokens: 4100,
      outputTokens: 1120,
      cachedTokens: 2400,
      cost: 0.0243,
      latencyMs: 820,
      status: '200 OK',
      endpoint: 'POST /v1/messages',
      snippetKey: 'ops.feed.snippet.renderer',
    },
    {
      id: 'inf-init-3',
      timestamp: Date.now() - 1000 * 95,
      provider: 'Google Gemini',
      model: 'gemini-2.5-pro',
      agentName: 'Dr. Maya Chen',
      inputTokens: 18500,
      outputTokens: 1450,
      cachedTokens: 12000,
      cost: 0.0341,
      latencyMs: 760,
      status: 'CACHED',
      endpoint: 'POST /models/gemini-2.5-pro:generateContent',
      snippetKey: 'ops.feed.snippet.crossAttention',
    },
  ]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Move keyboard focus into the dialog when it opens
  useEffect(() => {
    if (isOpen) closeButtonRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (initialProviderFilter) {
      setSelectedProvider(initialProviderFilter);
    }
  }, [initialProviderFilter]);

  // Aggregate providers and models from active agents
  const providerData = useMemo(() => aggregateModelUsage(agents), [agents]);

  const totalOfficeTokens = useMemo(() => {
    return providerData.reduce((acc, p) => acc + p.totalTokens, 0);
  }, [providerData]);

  const totalOfficeCost = useMemo(() => {
    return providerData.reduce((acc, p) => acc + p.cost, 0);
  }, [providerData]);

  const totalInputTokens = useMemo(() => {
    return providerData.reduce((acc, p) => acc + p.inputTokens, 0);
  }, [providerData]);

  const totalOutputTokens = useMemo(() => {
    return providerData.reduce((acc, p) => acc + p.outputTokens, 0);
  }, [providerData]);

  const totalCachedTokens = useMemo(() => {
    return providerData.reduce((acc, p) => acc + p.cachedTokens, 0);
  }, [providerData]);

  const totalReasoningTokens = useMemo(() => {
    return providerData.reduce((acc, p) => acc + p.reasoningTokens, 0);
  }, [providerData]);

  // All distinct models available from agents + catalog
  const allModels = useMemo(() => {
    const list: Array<{ provider: string; model: string }> = [];
    const seen = new Set<string>();

    // First, models currently attached to agents
    for (const p of providerData) {
      for (const m of p.models) {
        const key = `${p.provider}::${m.model}`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({ provider: p.provider, model: m.model });
        }
      }
    }

    // Add remaining models from MODEL_CATALOG so user can test and switch to any of them
    for (const [id, spec] of Object.entries(MODEL_CATALOG)) {
      const key = `${spec.provider}::${id}`;
      if (!seen.has(key)) {
        seen.add(key);
        list.push({ provider: spec.provider, model: id });
      }
    }

    return list;
  }, [providerData]);

  // Filtered providers
  const displayedProviders = useMemo(() => {
    if (selectedProvider === 'all') return providerData;
    return providerData.filter((p) => p.provider.toLowerCase() === selectedProvider.toLowerCase());
  }, [providerData, selectedProvider]);

  // Flattened and sorted models
  const displayedModels = useMemo(() => {
    const list = displayedProviders.flatMap((p) => p.models);

    // Filter by search query
    const filtered = searchQuery.trim()
      ? list.filter((m) =>
          m.model.toLowerCase().includes(searchQuery.toLowerCase()) ||
          m.provider.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : list;

    // Sort
    return [...filtered].sort((a, b) => {
      if (sortBy === 'cost') return b.cost - a.cost;
      if (sortBy === 'output') return b.outputTokens - a.outputTokens;
      if (sortBy === 'input') return b.inputTokens - a.inputTokens;
      return b.totalTokens - a.totalTokens;
    });
  }, [displayedProviders, searchQuery, sortBy]);

  // Top model tokens for relative progress bars
  const maxModelTokens = useMemo(() => {
    if (displayedModels.length === 0) return 1;
    return Math.max(...displayedModels.map((m) => m.totalTokens), 1);
  }, [displayedModels]);

  const providerDescription = (provider: string) =>
    tr(PROVIDER_DESC_KEYS[provider] ?? 'ops.provider.desc.external');

  const modelDescription = (modelId: string, fallback: string) => {
    const key = MODEL_DESC_KEYS[modelId];
    return key ? tr(key) : fallback;
  };

  // Trigger simulated token request burst
  const handleTriggerBurst = (modelName: string, providerName: string, customIn?: number, customOut?: number) => {
    const spec = MODEL_CATALOG[modelName] || MODEL_CATALOG['gpt-4o'];
    const inTokens = customIn ?? simInputTokens;
    const outTokens = customOut ?? simOutputTokens;
    const cacheTokens = Math.round(inTokens * simCacheHitRatio);
    const cost = calculateModelCost(modelName, inTokens, outTokens, cacheTokens);
    const latencyMs = Math.round(spec.latencyMs * (0.85 + Math.random() * 0.35));

    const burstPayload: SimulatedTokenBurst = {
      provider: providerName,
      model: modelName,
      inputTokens: inTokens,
      outputTokens: outTokens,
      cachedTokens: cacheTokens,
      cost,
      latencyMs,
      timestamp: Date.now(),
    };

    if (onSimulateTokenBurst) {
      onSimulateTokenBurst(burstPayload);
    }

    // Add to local live stream
    const targetAgent = agents.find((a) => a.provider === providerName && a.model === modelName) || agents[0];
    const newLogItem: FeedItem = {
      id: `inf-${Date.now()}`,
      timestamp: Date.now(),
      provider: providerName,
      model: modelName,
      // null means the simulator operator; its label is resolved at render time
      agentName: targetAgent ? targetAgent.name : null,
      inputTokens: inTokens,
      outputTokens: outTokens,
      cachedTokens: cacheTokens,
      cost,
      latencyMs,
      status: cacheTokens > inTokens * 0.5 ? 'CACHED' : '200 OK',
      endpoint: 'POST /inference/v1/dispatch',
      snippetKey: 'ops.feed.snippet.burst',
      snippetParams: { model: modelName },
    };

    setLiveInferenceFeed((prev) => [newLogItem, ...prev.slice(0, 24)]);
    setLastBurstSuccess({ provider: providerName, model: modelName, tokens: inTokens + outTokens, cost });
    setTimeout(() => setLastBurstSuccess(null), 3500);
  };

  // Quick preset payloads
  const applyPresetPayload = (type: 'chat' | 'code' | 'rag' | 'batch') => {
    if (type === 'chat') {
      setSimInputTokens(450);
      setSimOutputTokens(180);
      setSimCacheHitRatio(0.1);
    } else if (type === 'code') {
      setSimInputTokens(2400);
      setSimOutputTokens(850);
      setSimCacheHitRatio(0.35);
    } else if (type === 'rag') {
      setSimInputTokens(9800);
      setSimOutputTokens(1400);
      setSimCacheHitRatio(0.55);
    } else if (type === 'batch') {
      setSimInputTokens(32000);
      setSimOutputTokens(4800);
      setSimCacheHitRatio(0.70);
    }
  };

  // Arrow, Home and End keys move between tabs (WAI-ARIA tabs pattern)
  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.indexOf(activeTab);
    let next: ModelOpsTab | null = null;
    if (e.key === 'ArrowRight') next = TABS[(index + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') next = TABS[(index - 1 + TABS.length) % TABS.length];
    else if (e.key === 'Home') next = TABS[0];
    else if (e.key === 'End') next = TABS[TABS.length - 1];
    if (!next) return;
    e.preventDefault();
    setActiveTab(next);
    document.getElementById(tabId(next))?.focus();
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 md:p-6 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        className="relative w-full max-w-6xl max-h-[94vh] bg-slate-900 border border-cyan-500/40 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-slate-100"
      >

        {/* HEADER BAR */}
        <div className="px-6 py-4 border-b border-slate-800 bg-gradient-to-r from-slate-950 via-slate-900 to-cyan-950/50 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-xl bg-cyan-950/90 border border-cyan-500/50 flex items-center justify-center text-cyan-400 shadow-lg shadow-cyan-950/60">
              <Server className="w-6 h-6 animate-pulse" aria-hidden="true" />
            </div>

            <div>
              <div className="flex items-center gap-2.5">
                <h2 id={TITLE_ID} className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
                  <span>{tr('ops.title')}</span>
                </h2>
                <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                  <Radio className="w-3 h-3 text-emerald-400 animate-pulse" aria-hidden="true" />
                  <span>{tr('ops.header.activeNodes', { count: 4 })}</span>
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {tr('ops.subtitle')}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label={tr('ops.close.aria')}
              title={tr('ops.close.aria')}
              className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white border border-slate-700/60 transition-colors"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* TOP SUMMARY STATS STRIP */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 px-6 py-3.5 bg-slate-950/70 border-b border-slate-800 shrink-0 text-xs">
          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
            <span className="text-slate-400 text-[11px] block font-medium flex items-center gap-1">
              <Database className="w-3 h-3 text-cyan-400" aria-hidden="true" />
              <span>{tr('ops.stats.totalTokens')}</span>
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold font-mono text-cyan-400">
                {compactTokens(totalOfficeTokens)}
              </span>
              <span className="text-[10px] text-slate-400 font-mono">
                ({totalOfficeTokens.toLocaleString()})
              </span>
            </div>
          </div>

          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
            <span className="text-slate-400 text-[11px] block font-medium flex items-center gap-1">
              <DollarSign className="w-3 h-3 text-emerald-400" aria-hidden="true" />
              <span>{tr('ops.stats.estimatedSpend')}</span>
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold font-mono text-emerald-400">
                ${totalOfficeCost.toFixed(4)}
              </span>
              <span className="text-[10px] text-slate-400 font-mono">{tr('ops.unit.usd')}</span>
            </div>
          </div>

          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
            <span className="text-slate-400 text-[11px] block font-medium flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-purple-400" aria-hidden="true" />
              <span>{tr('ops.stats.inputOutput')}</span>
            </span>
            <div className="flex items-center gap-2 font-mono text-[11px] mt-1">
              <span className="text-sky-400" title={tr('ops.stats.inputTitle')}>
                {tr('ops.tokens.inValue', { value: compactTokens(totalInputTokens) })}
              </span>
              <span className="text-slate-400" aria-hidden="true">/</span>
              <span className="text-emerald-400" title={tr('ops.stats.outputTitle')}>
                {tr('ops.tokens.outValue', { value: compactTokens(totalOutputTokens) })}
              </span>
            </div>
          </div>

          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
            <span className="text-slate-400 text-[11px] block font-medium flex items-center gap-1">
              <Flame className="w-3 h-3 text-amber-400" aria-hidden="true" />
              <span>{tr('ops.stats.cacheReasoning')}</span>
            </span>
            <div className="flex items-center gap-2 font-mono text-[11px] mt-1">
              <span className="text-purple-400" title={tr('ops.stats.cachedTitle')}>{compactTokens(totalCachedTokens)}</span>
              <span className="text-slate-400" aria-hidden="true">/</span>
              <span className="text-amber-400" title={tr('ops.stats.reasoningTitle')}>{compactTokens(totalReasoningTokens)}</span>
            </div>
          </div>

          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1 col-span-2 sm:col-span-1">
            <span className="text-slate-400 text-[11px] block font-medium flex items-center gap-1">
              <Gauge className="w-3 h-3 text-cyan-400" aria-hidden="true" />
              <span>{tr('ops.stats.providersModels')}</span>
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold font-mono text-white">
                {providerData.length}
              </span>
              <span className="text-[11px] text-slate-400">
                {tr('ops.stats.providersCount', { models: allModels.length })}
              </span>
            </div>
          </div>
        </div>

        {/* INTERACTIVE NAVIGATION TABS */}
        <div className="px-6 py-2.5 bg-slate-950 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
          <div
            role="tablist"
            aria-label={tr('ops.tabs.label')}
            onKeyDown={handleTabKeyDown}
            className="flex items-center gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800"
          >
            {TABS.map((tab) => {
              const Icon = TAB_ICONS[tab];
              const isActive = activeTab === tab;
              return (
                <button
                  key={tab}
                  id={tabId(tab)}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={PANEL_ID}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${
                    isActive
                      ? 'bg-cyan-700 text-white font-bold shadow-md shadow-cyan-500/20'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{tr(TAB_KEYS[tab], { count: agents.length })}</span>
                </button>
              );
            })}
          </div>

          {/* Quick simulator shortcut button */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleTriggerBurst('gpt-4o', 'OpenAI', 1500, 400)}
              className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-emerald-700 to-teal-700 hover:from-emerald-600 hover:to-teal-600 text-white font-semibold text-xs flex items-center gap-1.5 shadow-md shadow-emerald-950 transition-colors"
            >
              <Flame className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
              <span>{tr('ops.quickBurst')}</span>
            </button>
          </div>
        </div>

        {/* NOTIFICATION OF LAST BURST */}
        {lastBurstSuccess && (
          <div
            role="status"
            className="mx-6 mt-3 p-3 rounded-xl bg-emerald-950/70 border border-emerald-500/40 text-emerald-300 flex items-center justify-between gap-3 animate-in fade-in slide-in-from-top-1 duration-200"
          >
            <div className="flex items-center gap-2 font-medium text-xs">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
              <span>
                {tr('ops.toast.burst', {
                  provider: lastBurstSuccess.provider,
                  model: lastBurstSuccess.model,
                  tokens: lastBurstSuccess.tokens.toLocaleString(),
                  cost: `$${lastBurstSuccess.cost.toFixed(4)}`,
                })}
              </span>
            </div>
            <span className="text-[10px] text-emerald-400 font-mono">{tr('ops.toast.updated')}</span>
          </div>
        )}

        {/* MAIN SCROLLABLE CONTENT */}
        <div
          id={PANEL_ID}
          role="tabpanel"
          aria-labelledby={tabId(activeTab)}
          tabIndex={0}
          className="flex-1 overflow-y-auto p-6 space-y-6 text-xs"
        >

          {/* ============================================================== */}
          {/* TAB 1: CONSUMPTION BY PROVIDER & MODEL MATRIX                  */}
          {/* ============================================================== */}
          {activeTab === 'matrix' && (
            <div className="space-y-6">
              {/* FILTERS & SEARCH ROW */}
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-slate-950/80 border border-slate-800">
                {/* Provider Filter Tabs */}
                <div
                  role="group"
                  aria-label={tr('ops.filter.providerGroup')}
                  className="flex items-center gap-1.5 flex-wrap"
                >
                  <span className="text-slate-400 font-medium mr-1 flex items-center gap-1">
                    <Filter className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
                    <span>{tr('ops.filter.provider')}</span>
                  </span>

                  <button
                    type="button"
                    aria-pressed={selectedProvider === 'all'}
                    onClick={() => setSelectedProvider('all')}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
                      selectedProvider === 'all'
                        ? 'bg-cyan-700 text-white font-bold shadow-md shadow-cyan-500/20'
                        : 'bg-slate-900 hover:bg-slate-800 text-slate-300'
                    }`}
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
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-colors border ${
                          isSelected
                            ? 'bg-slate-800 text-white font-bold border-cyan-400 shadow-sm'
                            : 'bg-slate-900/70 hover:bg-slate-800 text-slate-300 border-slate-800'
                        }`}
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: meta.color }}
                          aria-hidden="true"
                        />
                        <span>{prov.provider}</span>
                        <span className="text-[10px] text-slate-400 font-mono">
                          ({compactTokens(prov.totalTokens)})
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Sort and search */}
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

                  <div
                    role="group"
                    aria-labelledby="av-modelops-sort-label"
                    className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800"
                  >
                    <span id="av-modelops-sort-label" className="text-[10px] text-slate-400 px-1.5 font-medium">
                      {tr('ops.sort.label')}
                    </span>
                    <button
                      type="button"
                      aria-pressed={sortBy === 'tokens'}
                      onClick={() => setSortBy('tokens')}
                      className={`px-2 py-1 rounded text-[11px] ${
                        sortBy === 'tokens' ? 'bg-cyan-500/20 text-cyan-300 font-bold' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {tr('ops.sort.tokens')}
                    </button>
                    <button
                      type="button"
                      aria-pressed={sortBy === 'cost'}
                      onClick={() => setSortBy('cost')}
                      className={`px-2 py-1 rounded text-[11px] ${
                        sortBy === 'cost' ? 'bg-emerald-500/20 text-emerald-300 font-bold' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {tr('ops.sort.cost')}
                    </button>
                    <button
                      type="button"
                      aria-pressed={sortBy === 'output'}
                      onClick={() => setSortBy('output')}
                      className={`px-2 py-1 rounded text-[11px] ${
                        sortBy === 'output' ? 'bg-purple-500/20 text-purple-300 font-bold' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {tr('ops.sort.output')}
                    </button>
                  </div>
                </div>
              </div>

              {/* 1. PROVIDER OVERVIEW CARDS */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Layers className="w-4 h-4 text-cyan-400" aria-hidden="true" />
                    <span>{tr('ops.providers.heading')}</span>
                  </h3>
                  <span className="text-slate-400 text-[11px]">
                    {tr('ops.providers.monitored', { count: displayedProviders.length })}
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {displayedProviders.map((provider) => {
                    const meta = getProviderMeta(provider.provider);
                    const isSelected = selectedProvider.toLowerCase() === provider.provider.toLowerCase();

                    return (
                      <div
                        key={provider.provider}
                        className={`bg-slate-950 p-4 rounded-xl border transition-all duration-200 space-y-3 relative overflow-hidden flex flex-col justify-between ${
                          isSelected
                            ? 'border-cyan-500/60 shadow-lg shadow-cyan-950/40'
                            : 'border-slate-800 hover:border-slate-700'
                        }`}
                      >
                        <div
                          className="absolute top-0 left-0 right-0 h-1"
                          style={{ backgroundColor: meta.color }}
                          aria-hidden="true"
                        />

                        <div className="space-y-2 pt-1">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2">
                                <span
                                  className="w-2.5 h-2.5 rounded-full shrink-0"
                                  style={{ backgroundColor: meta.color }}
                                  aria-hidden="true"
                                />
                                <h4 className="text-sm font-bold text-white">{provider.provider}</h4>
                              </div>
                              <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">
                                {providerDescription(provider.provider)}
                              </p>
                            </div>
                            <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-slate-800 text-slate-300">
                              {tr('ops.provider.modelsCount', { count: provider.models.length })}
                            </span>
                          </div>

                          {/* Share Progress Bar */}
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-[11px]">
                              <span className="text-slate-400">{tr('ops.provider.share')}</span>
                              <span className="font-mono font-bold text-white">
                                {provider.percentageShare.toFixed(1)}%
                              </span>
                            </div>
                            <div
                              className="w-full h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800"
                              aria-hidden="true"
                            >
                              <div
                                className="h-full transition-all duration-500"
                                style={{
                                  width: `${Math.max(provider.percentageShare, 5)}%`,
                                  backgroundColor: meta.color,
                                }}
                              />
                            </div>
                          </div>

                          {/* Metric Grid */}
                          <div className="grid grid-cols-2 gap-2 text-[11px] font-mono bg-slate-900/60 p-2.5 rounded-lg border border-slate-800/80">
                            <div>
                              <span className="text-slate-400 block text-[10px]">{tr('ops.metric.totalTokens')}</span>
                              <span className="font-bold text-white">
                                {compactTokens(provider.totalTokens)}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400 block text-[10px]">{tr('ops.metric.costUsd')}</span>
                              <span className="font-bold text-emerald-400">
                                ${provider.cost.toFixed(4)}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400 block text-[10px]">{tr('ops.metric.inOut')}</span>
                              <span className="text-slate-300">
                                {compactTokens(provider.inputTokens)} / {compactTokens(provider.outputTokens)}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-400 block text-[10px]">{tr('ops.metric.agents')}</span>
                              <span className="text-cyan-400 font-semibold">
                                {tr('ops.provider.activeAgents', { count: provider.activeAgents })}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Card Footer Actions */}
                        <div className="flex items-center justify-between pt-2 border-t border-slate-900">
                          <button
                            type="button"
                            onClick={() => setSelectedProvider(isSelected ? 'all' : provider.provider)}
                            className="text-[11px] text-cyan-400 hover:text-cyan-300 font-medium flex items-center gap-1 transition-colors"
                          >
                            <span>{isSelected ? tr('ops.provider.showAll') : tr('ops.provider.filter')}</span>
                            <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                          </button>

                          {provider.models[0] && (
                            <button
                              type="button"
                              onClick={() => handleTriggerBurst(provider.models[0].model, provider.provider, 1200, 350)}
                              title={tr('ops.provider.quickBurstTitle', { model: provider.models[0].model })}
                              className="px-2 py-1 rounded-lg bg-cyan-950 hover:bg-cyan-900 text-cyan-300 border border-cyan-800/60 text-[10px] font-semibold flex items-center gap-1 transition-colors"
                            >
                              <Zap className="w-3 h-3" aria-hidden="true" />
                              <span>{tr('ops.provider.quickBurst')}</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 2. INTERACTIVE MODEL MATRIX & PROGRESS BARS */}
              <div className="space-y-4 pt-2">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                      <span>{tr('ops.models.heading')}</span>
                    </h3>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {tr('ops.models.subtitle')}
                    </p>
                  </div>

                  <span className="text-slate-400 text-[11px] font-mono">
                    {tr('ops.models.showing', { count: displayedModels.length })}
                  </span>
                </div>

                <div className="space-y-3">
                  {displayedModels.length === 0 && (
                    <p className="text-slate-400 text-[11px] italic p-4 rounded-xl bg-slate-950 border border-slate-800">
                      {tr('ops.models.empty')}
                    </p>
                  )}
                  {displayedModels.map((model) => {
                    const meta = getProviderMeta(model.provider);
                    const spec = MODEL_CATALOG[model.model] || MODEL_CATALOG['gpt-4o'];
                    const assignedAgents = agents.filter(
                      (a) => a.provider === model.provider && a.model === model.model
                    );
                    const relativePercent = Math.max(4, (model.totalTokens / maxModelTokens) * 100);

                    return (
                      <div
                        key={`${model.provider}-${model.model}`}
                        className="bg-slate-950 p-4 rounded-xl border border-slate-800 hover:border-slate-700 transition-all space-y-3"
                      >
                        {/* Header Row */}
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          <div className="flex items-center gap-3">
                            <span
                              className="w-3.5 h-3.5 rounded-full shrink-0"
                              style={{ backgroundColor: meta.color }}
                              aria-hidden="true"
                            />
                            <div>
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-bold text-white font-mono">
                                  {spec.name || model.model}
                                </span>
                                <span
                                  className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${meta.badgeBg} ${meta.badgeBorder} ${meta.accent}`}
                                >
                                  {model.provider}
                                </span>
                                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-slate-800 text-slate-400">
                                  {tr('ops.models.context', { value: spec.contextWindow })}
                                </span>
                                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-slate-800 text-slate-400">
                                  {tr('ops.models.latency', { ms: spec.latencyMs })}
                                </span>
                              </div>
                              <span className="text-[11px] text-slate-400 block mt-0.5">
                                {modelDescription(spec.id, spec.description)}
                              </span>
                            </div>
                          </div>

                          {/* Quick Actions */}
                          <div className="flex items-center gap-2 self-end sm:self-center">
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedSimulatorModel(model.model);
                                setActiveTab('simulator');
                              }}
                              className="px-2.5 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-medium flex items-center gap-1 border border-slate-800 transition-colors"
                            >
                              <Sliders className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
                              <span>{tr('ops.models.configure')}</span>
                            </button>

                            <button
                              type="button"
                              onClick={() => handleTriggerBurst(model.model, model.provider)}
                              className="px-3 py-1.5 rounded-xl bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-md shadow-cyan-950"
                            >
                              <Zap className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>{tr('ops.models.simulate')}</span>
                            </button>
                          </div>
                        </div>

                        {/* Relative Consumption Bar */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[11px] font-mono">
                            <span className="text-slate-400">{tr('ops.models.relativeVolume')}</span>
                            <span className="text-white font-bold">
                              {tr('ops.models.volumeValue', {
                                tokens: model.totalTokens.toLocaleString(),
                                share: model.percentageShare.toFixed(1),
                              })}
                            </span>
                          </div>
                          <div
                            className="w-full h-2.5 rounded-full bg-slate-900 overflow-hidden border border-slate-800"
                            aria-hidden="true"
                          >
                            <div
                              className="h-full transition-all duration-500 rounded-full"
                              style={{
                                width: `${relativePercent}%`,
                                backgroundColor: meta.color,
                              }}
                            />
                          </div>
                        </div>

                        {/* Detailed Metrics Grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 font-mono text-[11px] bg-slate-900/80 p-3 rounded-lg border border-slate-800/80">
                          <div>
                            <span className="text-slate-400 block text-[10px]">{tr('ops.metric.totalTokens')}</span>
                            <span className="font-bold text-white text-xs">
                              {compactTokens(model.totalTokens)}
                            </span>
                            <span className="text-[10px] text-slate-400 block">
                              ({model.totalTokens.toLocaleString()})
                            </span>
                          </div>

                          <div>
                            <span className="text-slate-400 block text-[10px]">{tr('ops.metric.input')}</span>
                            <span className="text-sky-300 font-semibold">
                              {compactTokens(model.inputTokens)}
                            </span>
                            <span className="text-[10px] text-slate-400 block">
                              ${spec.inputPer1M.toFixed(2)}/1M
                            </span>
                          </div>

                          <div>
                            <span className="text-slate-400 block text-[10px]">{tr('ops.metric.output')}</span>
                            <span className="text-emerald-300 font-semibold">
                              {compactTokens(model.outputTokens)}
                            </span>
                            <span className="text-[10px] text-slate-400 block">
                              ${spec.outputPer1M.toFixed(2)}/1M
                            </span>
                          </div>

                          <div>
                            <span className="text-slate-400 block text-[10px]">{tr('ops.metric.cache')}</span>
                            <span className="text-purple-300 font-semibold">
                              {compactTokens(model.cachedTokens)}
                            </span>
                            <span className="text-[10px] text-slate-400 block">
                              ${spec.cachePer1M.toFixed(2)}/1M
                            </span>
                          </div>

                          <div>
                            <span className="text-slate-400 block text-[10px]">{tr('ops.metric.reasoning')}</span>
                            <span className="text-amber-300 font-semibold">
                              {compactTokens(model.reasoningTokens)}
                            </span>
                            <span className="text-[10px] text-slate-400 block">{tr('ops.metric.reasoningHint')}</span>
                          </div>

                          <div>
                            <span className="text-slate-400 block text-[10px]">{tr('ops.metric.estimatedCost')}</span>
                            <span className="font-bold text-emerald-400 text-xs">
                              ${model.cost.toFixed(4)}
                            </span>
                            <span className="text-[10px] text-slate-400 block">{tr('ops.unit.usd')}</span>
                          </div>
                        </div>

                        {/* Agents using this model */}
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
                                  title={tr('ops.models.focusAgentTitle', { name: ag.name })}
                                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[11px] text-slate-200 transition-colors"
                                >
                                  <span
                                    className="w-2 h-2 rounded-full"
                                    style={{ backgroundColor: ag.clothingColor }}
                                    aria-hidden="true"
                                  />
                                  <span className="font-medium">{ag.name}</span>
                                  <span className="text-[10px] text-slate-400">
                                    ({localizeDemoText(ag.roleTitle, locale)})
                                  </span>
                                </button>
                              ))
                            ) : (
                              <span className="text-slate-400 text-[11px] italic">
                                {tr('ops.models.noAgents')}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 2: INTERACTIVE TRAFFIC & BURST SIMULATOR                  */}
          {/* ============================================================== */}
          {activeTab === 'simulator' && (
            <div className="space-y-6">
              <div className="bg-gradient-to-br from-slate-950 to-cyan-950/40 p-6 rounded-2xl border border-cyan-500/40 space-y-6">
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <Zap className="w-5 h-5 text-cyan-400" aria-hidden="true" />
                    <span>{tr('ops.sim.heading')}</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    {tr('ops.sim.intro')}
                  </p>
                </div>

                {/* Preset Payloads */}
                <div className="space-y-2">
                  <span id="av-modelops-presets-label" className="text-xs text-slate-300 font-medium block">
                    {tr('ops.sim.presets')}
                  </span>
                  <div
                    role="group"
                    aria-labelledby="av-modelops-presets-label"
                    className="grid grid-cols-2 sm:grid-cols-4 gap-3"
                  >
                    <button
                      type="button"
                      onClick={() => applyPresetPayload('chat')}
                      className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-cyan-500/50 text-left transition-colors"
                    >
                      <span className="text-white font-bold block text-xs">{tr('ops.sim.preset.chat')}</span>
                      <span className="text-[11px] text-slate-400 block mt-0.5">
                        {tr('ops.sim.presetSplit', { input: '450', output: '180' })}
                      </span>
                      <span className="text-[10px] text-cyan-400 font-mono mt-1 block">
                        {tr('ops.sim.presetTotal', { tokens: '630' })}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => applyPresetPayload('code')}
                      className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-cyan-500/50 text-left transition-colors"
                    >
                      <span className="text-white font-bold block text-xs">{tr('ops.sim.preset.code')}</span>
                      <span className="text-[11px] text-slate-400 block mt-0.5">
                        {tr('ops.sim.presetSplit', { input: '2.4K', output: '850' })}
                      </span>
                      <span className="text-[10px] text-cyan-400 font-mono mt-1 block">
                        {tr('ops.sim.presetTotalCache', { tokens: '3.25K', ratio: 35 })}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => applyPresetPayload('rag')}
                      className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-cyan-500/50 text-left transition-colors"
                    >
                      <span className="text-white font-bold block text-xs">{tr('ops.sim.preset.rag')}</span>
                      <span className="text-[11px] text-slate-400 block mt-0.5">
                        {tr('ops.sim.presetSplit', { input: '9.8K', output: '1.4K' })}
                      </span>
                      <span className="text-[10px] text-cyan-400 font-mono mt-1 block">
                        {tr('ops.sim.presetTotalCache', { tokens: '11.2K', ratio: 55 })}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => applyPresetPayload('batch')}
                      className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-cyan-500/50 text-left transition-colors"
                    >
                      <span className="text-white font-bold block text-xs">{tr('ops.sim.preset.batch')}</span>
                      <span className="text-[11px] text-slate-400 block mt-0.5">
                        {tr('ops.sim.presetSplit', { input: '32K', output: '4.8K' })}
                      </span>
                      <span className="text-[10px] text-cyan-400 font-mono mt-1 block">
                        {tr('ops.sim.presetTotalCache', { tokens: '36.8K', ratio: 70 })}
                      </span>
                    </button>
                  </div>
                </div>

                {/* Custom Parameters Form */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 p-4 rounded-xl bg-slate-900/80 border border-slate-800">
                  {/* Model Selector */}
                  <div>
                    <label
                      htmlFor="av-modelops-sim-model"
                      className="text-[11px] text-slate-300 font-medium block mb-1.5"
                    >
                      {tr('ops.sim.targetModel')}
                    </label>
                    <select
                      id="av-modelops-sim-model"
                      value={selectedSimulatorModel}
                      onChange={(e) => setSelectedSimulatorModel(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-cyan-500 font-mono"
                    >
                      {allModels.map((item) => (
                        <option key={`${item.provider}-${item.model}`} value={item.model}>
                          {item.provider} · {item.model}
                        </option>
                      ))}
                    </select>
                    {(() => {
                      const spec = MODEL_CATALOG[selectedSimulatorModel] || MODEL_CATALOG['gpt-4o'];
                      return (
                        <p className="text-[10px] text-slate-400 mt-1 font-mono">
                          {tr('ops.sim.rate', { input: spec.inputPer1M, output: spec.outputPer1M })}
                        </p>
                      );
                    })()}
                  </div>

                  {/* Input Tokens Slider */}
                  <div>
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <label htmlFor="av-modelops-sim-input" className="text-slate-300 font-medium">
                        {tr('ops.sim.inputTokens')}
                      </label>
                      <span className="text-sky-300 font-mono font-bold">{simInputTokens.toLocaleString()} t</span>
                    </div>
                    <input
                      id="av-modelops-sim-input"
                      type="range"
                      min={100}
                      max={40000}
                      step={100}
                      value={simInputTokens}
                      onChange={(e) => setSimInputTokens(Number(e.target.value))}
                      className="w-full accent-cyan-500"
                    />
                    <div className="flex justify-between text-[9px] text-slate-400 font-mono" aria-hidden="true">
                      <span>100</span>
                      <span>10K</span>
                      <span>25K</span>
                      <span>40K</span>
                    </div>
                  </div>

                  {/* Output Tokens Slider */}
                  <div>
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <label htmlFor="av-modelops-sim-output" className="text-slate-300 font-medium">
                        {tr('ops.sim.outputTokens')}
                      </label>
                      <span className="text-emerald-300 font-mono font-bold">{simOutputTokens.toLocaleString()} t</span>
                    </div>
                    <input
                      id="av-modelops-sim-output"
                      type="range"
                      min={50}
                      max={8000}
                      step={50}
                      value={simOutputTokens}
                      onChange={(e) => setSimOutputTokens(Number(e.target.value))}
                      className="w-full accent-emerald-500"
                    />
                    <div className="flex justify-between text-[9px] text-slate-400 font-mono" aria-hidden="true">
                      <span>50</span>
                      <span>2K</span>
                      <span>4K</span>
                      <span>8K</span>
                    </div>
                  </div>
                </div>

                {/* Live Cost & Impact Preview */}
                {(() => {
                  const targetModelObj = allModels.find((m) => m.model === selectedSimulatorModel) || allModels[0];
                  const cachedTokens = Math.round(simInputTokens * simCacheHitRatio);
                  const estimatedCost = calculateModelCost(selectedSimulatorModel, simInputTokens, simOutputTokens, cachedTokens);
                  const totalTokensInBurst = simInputTokens + simOutputTokens;

                  return (
                    <div className="p-4 rounded-xl bg-slate-900 border border-cyan-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <span className="text-xs text-slate-400 font-medium block">{tr('ops.sim.summary')}</span>
                        <div className="flex items-center gap-3 font-mono text-xs flex-wrap">
                          <span className="text-white font-bold">
                            {tr('ops.sim.totalTokens', { value: totalTokensInBurst.toLocaleString() })}
                          </span>
                          <span className="text-slate-400" aria-hidden="true">·</span>
                          <span className="text-sky-400">
                            {tr('ops.tokens.inValue', { value: simInputTokens.toLocaleString() })}
                          </span>
                          <span className="text-slate-400" aria-hidden="true">·</span>
                          <span className="text-emerald-400">
                            {tr('ops.tokens.outValue', { value: simOutputTokens.toLocaleString() })}
                          </span>
                          <span className="text-slate-400" aria-hidden="true">·</span>
                          <span className="text-purple-400">
                            {tr('ops.sim.cachedValue', { value: cachedTokens.toLocaleString() })}
                          </span>
                          <span className="text-slate-400" aria-hidden="true">·</span>
                          <span className="text-emerald-300 font-bold">
                            {tr('ops.sim.costValue', { value: estimatedCost.toFixed(5) })}
                          </span>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleTriggerBurst(targetModelObj.model, targetModelObj.provider)}
                        className="px-6 py-2.5 bg-gradient-to-r from-cyan-700 via-sky-700 to-indigo-600 hover:from-cyan-600 hover:to-indigo-500 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-xl shadow-cyan-950 transition-all active:scale-95 shrink-0"
                      >
                        <Play className="w-4 h-4 fill-current" aria-hidden="true" />
                        <span>{tr('ops.sim.fire')}</span>
                      </button>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 3: AGENT MODEL REASSIGNMENT                                */}
          {/* ============================================================== */}
          {activeTab === 'agents' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Users className="w-4 h-4 text-cyan-400" aria-hidden="true" />
                  <span>{tr('ops.agents.heading')}</span>
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  {tr('ops.agents.subtitle')}
                </p>
              </div>

              <div className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-900 border-b border-slate-800 text-[11px] text-slate-400 font-mono">
                    <tr>
                      <th scope="col" className="px-4 py-3">{tr('ops.agents.col.agent')}</th>
                      <th scope="col" className="px-4 py-3">{tr('ops.agents.col.role')}</th>
                      <th scope="col" className="px-4 py-3">{tr('ops.agents.col.provider')}</th>
                      <th scope="col" className="px-4 py-3">{tr('ops.agents.col.model')}</th>
                      <th scope="col" className="px-4 py-3">{tr('ops.agents.col.tokens')}</th>
                      <th scope="col" className="px-4 py-3 text-right">{tr('ops.agents.col.action')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80">
                    {agents.map((agent) => {
                      const meta = getProviderMeta(agent.provider);
                      const totalTokens = agent.tokensInput + agent.tokensOutput;

                      return (
                        <tr key={agent.id} className="hover:bg-slate-900/50 transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              <span
                                className="w-3 h-3 rounded-full shrink-0"
                                style={{ backgroundColor: agent.clothingColor }}
                                aria-hidden="true"
                              />
                              <span className="font-bold text-white">{agent.name}</span>
                            </div>
                          </td>

                          <td className="px-4 py-3 text-slate-400">
                            {localizeDemoText(agent.roleTitle, locale)}
                          </td>

                          <td className="px-4 py-3">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${meta.badgeBg} ${meta.badgeBorder} ${meta.accent}`}
                            >
                              {agent.provider}
                            </span>
                          </td>

                          <td className="px-4 py-3">
                            <select
                              aria-label={tr('ops.agents.modelSelect', { name: agent.name })}
                              value={`${agent.provider}::${agent.model}`}
                              onChange={(e) => {
                                const [newProv, newMod] = e.target.value.split('::');
                                if (onChangeAgentModel) {
                                  onChangeAgentModel(agent.id, newProv, newMod);
                                }
                              }}
                              className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1 text-xs text-white font-mono focus:outline-none focus:border-cyan-500"
                            >
                              {allModels.map((m) => (
                                <option key={`${m.provider}::${m.model}`} value={`${m.provider}::${m.model}`}>
                                  {m.provider} · {m.model}
                                </option>
                              ))}
                            </select>
                          </td>

                          <td className="px-4 py-3 font-mono text-[11px]">
                            <span className="text-white font-bold">{compactTokens(totalTokens)}</span>
                            <span className="text-slate-400 ml-1">(${agent.cost.toFixed(3)})</span>
                          </td>

                          <td className="px-4 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => {
                                onFocusAgent(agent);
                                onClose();
                              }}
                              aria-label={tr('ops.agents.focusAria', { name: agent.name })}
                              className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-sky-400 hover:text-white border border-slate-800 text-[11px] font-medium transition-colors"
                            >
                              {tr('ops.agents.focus')}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* TAB 4: LIVE INFERENCE STREAM FEED                              */}
          {/* ============================================================== */}
          {activeTab === 'feed' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Activity className="w-4 h-4 text-cyan-400" aria-hidden="true" />
                    <span>{tr('ops.feed.heading')}</span>
                  </h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    {tr('ops.feed.subtitle')}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => handleTriggerBurst('claude-3-5-sonnet', 'Anthropic', 2100, 600)}
                  className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-cyan-300 border border-cyan-800/60 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                >
                  <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
                  <span>{tr('ops.feed.emit')}</span>
                </button>
              </div>

              <div className="space-y-2">
                {liveInferenceFeed.map((item) => {
                  const meta = getProviderMeta(item.provider);
                  return (
                    <div
                      key={item.id}
                      className="p-3 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs font-mono transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: meta.color }}
                          aria-hidden="true"
                        />
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-white">{item.model}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${meta.badgeBg} ${meta.badgeBorder} ${meta.accent}`}>
                              {item.provider}
                            </span>
                            <span className="text-slate-400 font-sans text-[11px]">
                              {tr('ops.feed.by')}{' '}
                              <strong className="text-slate-200">{item.agentName ?? tr('ops.feed.operator')}</strong>
                            </span>
                            <span className="text-[10px] text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30">
                              {tr(STATUS_KEYS[item.status])}
                            </span>
                          </div>
                          <span className="text-[11px] text-slate-400 mt-0.5 block line-clamp-1">
                            {item.endpoint} - {tr(item.snippetKey, item.snippetParams)}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 text-[11px] self-end sm:self-center shrink-0">
                        <div>
                          <span className="text-slate-400 block text-[9px]">{tr('ops.feed.col.tokens')}</span>
                          <span className="text-sky-300 font-semibold">
                            {tr('ops.tokens.inValue', { value: item.inputTokens })}
                          </span>
                          <span className="text-slate-400" aria-hidden="true"> / </span>
                          <span className="text-emerald-300 font-semibold">
                            {tr('ops.tokens.outValue', { value: item.outputTokens })}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-400 block text-[9px]">{tr('ops.feed.col.latency')}</span>
                          <span className="text-amber-300 font-semibold">{item.latencyMs}ms</span>
                        </div>
                        <div>
                          <span className="text-slate-400 block text-[9px]">{tr('ops.feed.col.cost')}</span>
                          <span className="text-emerald-400 font-bold">${item.cost.toFixed(4)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

        </div>

        {/* MODAL FOOTER */}
        <div className="px-6 py-3.5 bg-slate-950/90 border-t border-slate-800 flex items-center justify-between text-xs shrink-0">
          <div className="flex items-center gap-2 text-slate-400">
            <span className="font-mono text-[11px] text-cyan-400 font-bold">{tr('ops.footer.tip')}</span>
            <span>{tr('ops.footer.tipText')}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition-colors border border-slate-700/60"
            >
              {tr('ops.footer.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
