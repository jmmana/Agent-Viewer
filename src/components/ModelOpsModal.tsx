import React, { useState, useEffect, useMemo } from 'react';
import type { Agent, ViewerEvent } from '../types/agent';
import {
  aggregateModelUsage,
  compactTokens,
  getProviderMeta,
  ProviderUsageAggregate,
  ModelUsageAggregate,
  MODEL_CATALOG,
  calculateModelCost,
  InferenceLogItem,
  SimulatedTokenBurst,
} from '../engine/modelOps';
import {
  X,
  Cpu,
  Zap,
  Server,
  Terminal,
  Activity,
  DollarSign,
  Layers,
  Sparkles,
  TrendingUp,
  RefreshCw,
  Sliders,
  Filter,
  Users,
  Eye,
  CheckCircle2,
  Clock,
  Radio,
  Play,
  ArrowUpRight,
  ShieldCheck,
  Search,
  BarChart3,
  Database,
  Gauge,
  SlidersHorizontal,
  Flame,
  ArrowRight,
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
}

export const ModelOpsModal: React.FC<ModelOpsModalProps> = ({
  isOpen,
  onClose,
  agents,
  onFocusAgent,
  onSimulateTokenBurst,
  onChangeAgentModel,
  initialProviderFilter = null,
  events = [],
}) => {
  const [selectedProvider, setSelectedProvider] = useState<string>('all');
  const [activeTab, setActiveTab] = useState<'matrix' | 'simulator' | 'agents' | 'feed'>('matrix');
  const [sortBy, setSortBy] = useState<'tokens' | 'cost' | 'output' | 'input'>('tokens');
  const [searchQuery, setSearchQuery] = useState('');
  
  // Simulator State
  const [selectedSimulatorModel, setSelectedSimulatorModel] = useState<string>('gpt-4o');
  const [simInputTokens, setSimInputTokens] = useState<number>(1800);
  const [simOutputTokens, setSimOutputTokens] = useState<number>(450);
  const [simCacheHitRatio, setSimCacheHitRatio] = useState<number>(0.35); // 35% cache
  const [lastBurstSuccess, setLastBurstSuccess] = useState<string | null>(null);

  // Local live inference feed
  const [liveInferenceFeed, setLiveInferenceFeed] = useState<InferenceLogItem[]>([
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
      promptSnippet: 'POST /v1/chat/completions - Fastify GraphQL gateway schema refactor',
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
      promptSnippet: 'POST /v1/messages - React Canvas 2.5D visual depth renderer',
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
      promptSnippet: 'POST /models/gemini-2.5-pro:generateContent - Cross-attention index',
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
    const newLogItem: InferenceLogItem = {
      id: `inf-${Date.now()}`,
      timestamp: Date.now(),
      provider: providerName,
      model: modelName,
      agentName: targetAgent ? targetAgent.name : 'Simulador Operador',
      inputTokens: inTokens,
      outputTokens: outTokens,
      cachedTokens: cacheTokens,
      cost,
      latencyMs,
      status: cacheTokens > inTokens * 0.5 ? 'CACHED' : '200 OK',
      promptSnippet: `POST /inference/v1/dispatch - [${modelName}] execution burst`,
    };

    setLiveInferenceFeed((prev) => [newLogItem, ...prev.slice(0, 24)]);
    setLastBurstSuccess(`¡Inferencia inyectada en ${providerName} · ${modelName}! +${(inTokens + outTokens).toLocaleString()} tokens ($${cost.toFixed(4)})`);
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

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 md:p-6 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="relative w-full max-w-6xl max-h-[94vh] bg-slate-900 border border-cyan-500/40 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-slate-100">
        
        {/* HEADER BAR */}
        <div className="px-6 py-4 border-b border-slate-800 bg-gradient-to-r from-slate-950 via-slate-900 to-cyan-950/50 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-xl bg-cyan-950/90 border border-cyan-500/50 flex items-center justify-center text-cyan-400 shadow-lg shadow-cyan-950/60">
              <Server className="w-6 h-6 animate-pulse" />
            </div>

            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-lg font-bold text-white tracking-tight flex items-center gap-2">
                  <span>Model Ops & Token Operations Center</span>
                </h2>
                <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                  <Radio className="w-3 h-3 text-emerald-400 animate-pulse" />
                  <span>4 Nodos Activos</span>
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Consumo interactivo en tiempo real de tokens, inferencias y costos por proveedor y modelo
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              title="Cerrar modal (ESC)"
              className="p-2 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white border border-slate-700/60 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* TOP SUMMARY STATS STRIP */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 px-6 py-3.5 bg-slate-950/70 border-b border-slate-800 shrink-0 text-xs">
          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
            <span className="text-slate-400 text-[11px] block font-medium flex items-center gap-1">
              <Database className="w-3 h-3 text-cyan-400" />
              <span>Tokens Totales</span>
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold font-mono text-cyan-400">
                {compactTokens(totalOfficeTokens)}
              </span>
              <span className="text-[10px] text-slate-500 font-mono">
                ({totalOfficeTokens.toLocaleString()})
              </span>
            </div>
          </div>

          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
            <span className="text-slate-400 text-[11px] block font-medium flex items-center gap-1">
              <DollarSign className="w-3 h-3 text-emerald-400" />
              <span>Gasto Estimado</span>
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold font-mono text-emerald-400">
                ${totalOfficeCost.toFixed(4)}
              </span>
              <span className="text-[10px] text-slate-500 font-mono">USD</span>
            </div>
          </div>

          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
            <span className="text-slate-400 text-[11px] block font-medium flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-purple-400" />
              <span>Entrada / Salida</span>
            </span>
            <div className="flex items-center gap-2 font-mono text-[11px] mt-1">
              <span className="text-sky-400" title="Tokens Entrada">{compactTokens(totalInputTokens)} in</span>
              <span className="text-slate-600">/</span>
              <span className="text-emerald-400" title="Tokens Salida">{compactTokens(totalOutputTokens)} out</span>
            </div>
          </div>

          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
            <span className="text-slate-400 text-[11px] block font-medium flex items-center gap-1">
              <Flame className="w-3 h-3 text-amber-400" />
              <span>Caché / Razonamiento</span>
            </span>
            <div className="flex items-center gap-2 font-mono text-[11px] mt-1">
              <span className="text-purple-400" title="Tokens en Caché">{compactTokens(totalCachedTokens)}</span>
              <span className="text-slate-600">/</span>
              <span className="text-amber-400" title="Razonamiento CoT">{compactTokens(totalReasoningTokens)}</span>
            </div>
          </div>

          <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1 col-span-2 sm:col-span-1">
            <span className="text-slate-400 text-[11px] block font-medium flex items-center gap-1">
              <Gauge className="w-3 h-3 text-cyan-400" />
              <span>Proveedores / Modelos</span>
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-xl font-bold font-mono text-white">
                {providerData.length}
              </span>
              <span className="text-[11px] text-slate-400">
                proveedores ({allModels.length} modelos)
              </span>
            </div>
          </div>
        </div>

        {/* INTERACTIVE NAVIGATION TABS */}
        <div className="px-6 py-2.5 bg-slate-950 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
          <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800">
            <button
              onClick={() => setActiveTab('matrix')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${
                activeTab === 'matrix'
                  ? 'bg-cyan-500 text-white font-bold shadow-md shadow-cyan-500/20'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              <span>Consumo por Proveedor y Modelo</span>
            </button>

            <button
              onClick={() => setActiveTab('simulator')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${
                activeTab === 'simulator'
                  ? 'bg-cyan-500 text-white font-bold shadow-md shadow-cyan-500/20'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Simulador de Tráfico LLM</span>
            </button>

            <button
              onClick={() => setActiveTab('agents')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${
                activeTab === 'agents'
                  ? 'bg-cyan-500 text-white font-bold shadow-md shadow-cyan-500/20'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              <span>Asignación a Agentes ({agents.length})</span>
            </button>

            <button
              onClick={() => setActiveTab('feed')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${
                activeTab === 'feed'
                  ? 'bg-cyan-500 text-white font-bold shadow-md shadow-cyan-500/20'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Feed de Inferencia en Vivo</span>
            </button>
          </div>

          {/* Quick simulator shortcut button */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleTriggerBurst('gpt-4o', 'OpenAI', 1500, 400)}
              className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold text-xs flex items-center gap-1.5 shadow-md shadow-emerald-950 transition-colors"
            >
              <Flame className="w-3.5 h-3.5 fill-current" />
              <span>Inyectar Petición Rápida (+1.9K t)</span>
            </button>
          </div>
        </div>

        {/* NOTIFICATION OF LAST BURST */}
        {lastBurstSuccess && (
          <div className="mx-6 mt-3 p-3 rounded-xl bg-emerald-950/70 border border-emerald-500/40 text-emerald-300 flex items-center justify-between gap-3 animate-in fade-in slide-in-from-top-1 duration-200">
            <div className="flex items-center gap-2 font-medium text-xs">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{lastBurstSuccess}</span>
            </div>
            <span className="text-[10px] text-emerald-400 font-mono">Actualizado en el mapa y telemetría</span>
          </div>
        )}

        {/* MAIN SCROLLABLE CONTENT */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 text-xs">

          {/* ============================================================== */}
          {/* TAB 1: CONSUMPTION BY PROVIDER & MODEL MATRIX                  */}
          {/* ============================================================== */}
          {activeTab === 'matrix' && (
            <div className="space-y-6">
              {/* FILTERS & SEARCH ROW */}
              <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-slate-950/80 border border-slate-800">
                {/* Provider Filter Tabs */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-slate-400 font-medium mr-1 flex items-center gap-1">
                    <Filter className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Proveedor:</span>
                  </span>

                  <button
                    onClick={() => setSelectedProvider('all')}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
                      selectedProvider === 'all'
                        ? 'bg-cyan-500 text-white font-bold shadow-md shadow-cyan-500/20'
                        : 'bg-slate-900 hover:bg-slate-800 text-slate-300'
                    }`}
                  >
                    Todos ({providerData.length})
                  </button>

                  {providerData.map((prov) => {
                    const meta = getProviderMeta(prov.provider);
                    const isSelected = selectedProvider.toLowerCase() === prov.provider.toLowerCase();
                    return (
                      <button
                        key={prov.provider}
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
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      placeholder="Buscar modelo o proveedor..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="bg-slate-900 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500 w-48 font-mono"
                    />
                  </div>

                  <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
                    <span className="text-[10px] text-slate-400 px-1.5 font-medium">Ordenar:</span>
                    <button
                      onClick={() => setSortBy('tokens')}
                      className={`px-2 py-1 rounded text-[11px] ${
                        sortBy === 'tokens' ? 'bg-cyan-500/20 text-cyan-300 font-bold' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Tokens
                    </button>
                    <button
                      onClick={() => setSortBy('cost')}
                      className={`px-2 py-1 rounded text-[11px] ${
                        sortBy === 'cost' ? 'bg-emerald-500/20 text-emerald-300 font-bold' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Costo ($)
                    </button>
                    <button
                      onClick={() => setSortBy('output')}
                      className={`px-2 py-1 rounded text-[11px] ${
                        sortBy === 'output' ? 'bg-purple-500/20 text-purple-300 font-bold' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Salida
                    </button>
                  </div>
                </div>
              </div>

              {/* 1. PROVIDER OVERVIEW CARDS */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Layers className="w-4 h-4 text-cyan-400" />
                    <span>Consumo Agregado por Proveedor</span>
                  </h3>
                  <span className="text-slate-400 text-[11px]">
                    {displayedProviders.length} proveedores monitorizados
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
                        />

                        <div className="space-y-2 pt-1">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2">
                                <span
                                  className="w-2.5 h-2.5 rounded-full shrink-0"
                                  style={{ backgroundColor: meta.color }}
                                />
                                <h4 className="text-sm font-bold text-white">{provider.provider}</h4>
                              </div>
                              <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1">{meta.description}</p>
                            </div>
                            <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-slate-800 text-slate-300">
                              {provider.models.length} modelos
                            </span>
                          </div>

                          {/* Share Progress Bar */}
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-[11px]">
                              <span className="text-slate-400">Cuota de Oficina:</span>
                              <span className="font-mono font-bold text-white">
                                {provider.percentageShare.toFixed(1)}%
                              </span>
                            </div>
                            <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
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
                              <span className="text-slate-500 block text-[10px]">TOKENS TOTALES</span>
                              <span className="font-bold text-white">
                                {compactTokens(provider.totalTokens)}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-500 block text-[10px]">COSTO USD</span>
                              <span className="font-bold text-emerald-400">
                                ${provider.cost.toFixed(4)}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-500 block text-[10px]">IN / OUT</span>
                              <span className="text-slate-300">
                                {compactTokens(provider.inputTokens)} / {compactTokens(provider.outputTokens)}
                              </span>
                            </div>
                            <div>
                              <span className="text-slate-500 block text-[10px]">AGENTES</span>
                              <span className="text-cyan-400 font-semibold">
                                {provider.activeAgents} activos
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Card Footer Actions */}
                        <div className="flex items-center justify-between pt-2 border-t border-slate-900">
                          <button
                            onClick={() => setSelectedProvider(isSelected ? 'all' : provider.provider)}
                            className="text-[11px] text-cyan-400 hover:text-cyan-300 font-medium flex items-center gap-1 transition-colors"
                          >
                            <span>{isSelected ? 'Ver todos' : 'Filtrar'}</span>
                            <ArrowUpRight className="w-3 h-3" />
                          </button>

                          {provider.models[0] && (
                            <button
                              onClick={() => handleTriggerBurst(provider.models[0].model, provider.provider, 1200, 350)}
                              title={`Inyectar petición rápida en ${provider.models[0].model}`}
                              className="px-2 py-1 rounded-lg bg-cyan-950 hover:bg-cyan-900 text-cyan-300 border border-cyan-800/60 text-[10px] font-semibold flex items-center gap-1 transition-colors"
                            >
                              <Zap className="w-3 h-3" />
                              <span>Petición Rápida</span>
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
                      <Cpu className="w-4 h-4 text-emerald-400" />
                      <span>Matriz Detallada de Consumo por Modelo</span>
                    </h3>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Visualización comparativa de consumo de tokens, entradas/salidas, caché y tarifas de inferencia
                    </p>
                  </div>

                  <span className="text-slate-400 text-[11px] font-mono">
                    Mostrando {displayedModels.length} modelo(s)
                  </span>
                </div>

                <div className="space-y-3">
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
                                  Contexto: {spec.contextWindow}
                                </span>
                                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-slate-800 text-slate-400">
                                  Latencia: ~{spec.latencyMs}ms
                                </span>
                              </div>
                              <span className="text-[11px] text-slate-400 block mt-0.5">
                                {spec.description}
                              </span>
                            </div>
                          </div>

                          {/* Quick Actions */}
                          <div className="flex items-center gap-2 self-end sm:self-center">
                            <button
                              onClick={() => {
                                setSelectedSimulatorModel(model.model);
                                setActiveTab('simulator');
                              }}
                              className="px-2.5 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-medium flex items-center gap-1 border border-slate-800 transition-colors"
                            >
                              <Sliders className="w-3.5 h-3.5 text-cyan-400" />
                              <span>Configurar Simulación</span>
                            </button>

                            <button
                              onClick={() => handleTriggerBurst(model.model, model.provider)}
                              className="px-3 py-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-md shadow-cyan-950"
                            >
                              <Zap className="w-3.5 h-3.5" />
                              <span>Simular Inferencia</span>
                            </button>
                          </div>
                        </div>

                        {/* Relative Consumption Bar */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between text-[11px] font-mono">
                            <span className="text-slate-400">Volumen relativo en oficina:</span>
                            <span className="text-white font-bold">
                              {model.totalTokens.toLocaleString()} tokens ({model.percentageShare.toFixed(1)}%)
                            </span>
                          </div>
                          <div className="w-full h-2.5 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
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
                            <span className="text-slate-500 block text-[10px]">TOTAL TOKENS</span>
                            <span className="font-bold text-white text-xs">
                              {compactTokens(model.totalTokens)}
                            </span>
                            <span className="text-[10px] text-slate-500 block">
                              ({model.totalTokens.toLocaleString()})
                            </span>
                          </div>

                          <div>
                            <span className="text-slate-500 block text-[10px]">ENTRADA (PROMPT)</span>
                            <span className="text-sky-300 font-semibold">
                              {compactTokens(model.inputTokens)}
                            </span>
                            <span className="text-[10px] text-slate-500 block">
                              ${spec.inputPer1M.toFixed(2)}/1M
                            </span>
                          </div>

                          <div>
                            <span className="text-slate-500 block text-[10px]">SALIDA (COMPLETION)</span>
                            <span className="text-emerald-300 font-semibold">
                              {compactTokens(model.outputTokens)}
                            </span>
                            <span className="text-[10px] text-slate-500 block">
                              ${spec.outputPer1M.toFixed(2)}/1M
                            </span>
                          </div>

                          <div>
                            <span className="text-slate-500 block text-[10px]">CACHÉ DE CONTEXTO</span>
                            <span className="text-purple-300 font-semibold">
                              {compactTokens(model.cachedTokens)}
                            </span>
                            <span className="text-[10px] text-slate-500 block">
                              ${spec.cachePer1M.toFixed(2)}/1M
                            </span>
                          </div>

                          <div>
                            <span className="text-slate-500 block text-[10px]">RAZONAMIENTO (COT)</span>
                            <span className="text-amber-300 font-semibold">
                              {compactTokens(model.reasoningTokens)}
                            </span>
                            <span className="text-[10px] text-slate-500 block">pensamiento</span>
                          </div>

                          <div>
                            <span className="text-slate-500 block text-[10px]">COSTO ESTIMADO</span>
                            <span className="font-bold text-emerald-400 text-xs">
                              ${model.cost.toFixed(4)}
                            </span>
                            <span className="text-[10px] text-slate-500 block">USD</span>
                          </div>
                        </div>

                        {/* Agents using this model */}
                        <div className="flex items-center justify-between pt-1 flex-wrap gap-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-slate-400 text-[11px] font-medium flex items-center gap-1">
                              <Users className="w-3 h-3 text-slate-400" />
                              <span>Agentes Asignados ({assignedAgents.length}):</span>
                            </span>

                            {assignedAgents.length > 0 ? (
                              assignedAgents.map((ag) => (
                                <button
                                  key={ag.id}
                                  onClick={() => {
                                    onFocusAgent(ag);
                                    onClose();
                                  }}
                                  title={`Centrar cámara en ${ag.name} en la oficina`}
                                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[11px] text-slate-200 transition-colors"
                                >
                                  <span
                                    className="w-2 h-2 rounded-full"
                                    style={{ backgroundColor: ag.clothingColor }}
                                  />
                                  <span className="font-medium">{ag.name}</span>
                                  <span className="text-[10px] text-slate-500">({ag.roleTitle.split(' ')[0]})</span>
                                </button>
                              ))
                            ) : (
                              <span className="text-slate-500 text-[11px] italic">
                                Disponible en el clúster sin agentes asignados en este momento
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
                    <Zap className="w-5 h-5 text-cyan-400" />
                    <span>Consola de Simulación de Inferencia y Carga LLM</span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    Genera peticiones sintéticas en tiempo real a cualquiera de los modelos de IA del clúster.
                    Podrás observar cómo se actualiza la telemetría al instante, parpadean los racks de servidores
                    en la sala Model Ops y se calculan los costos y cuotas de caché.
                  </p>
                </div>

                {/* Preset Payloads */}
                <div className="space-y-2">
                  <span className="text-xs text-slate-300 font-medium block">1. Carga Predefinida:</span>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <button
                      onClick={() => applyPresetPayload('chat')}
                      className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-cyan-500/50 text-left transition-colors"
                    >
                      <span className="text-white font-bold block text-xs">Consulta Rápida</span>
                      <span className="text-[11px] text-slate-400 block mt-0.5">450 in / 180 out</span>
                      <span className="text-[10px] text-cyan-400 font-mono mt-1 block">~630 tokens</span>
                    </button>

                    <button
                      onClick={() => applyPresetPayload('code')}
                      className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-cyan-500/50 text-left transition-colors"
                    >
                      <span className="text-white font-bold block text-xs">Generación de Código</span>
                      <span className="text-[11px] text-slate-400 block mt-0.5">2.4K in / 850 out</span>
                      <span className="text-[10px] text-cyan-400 font-mono mt-1 block">~3.25K tokens (35% caché)</span>
                    </button>

                    <button
                      onClick={() => applyPresetPayload('rag')}
                      className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-cyan-500/50 text-left transition-colors"
                    >
                      <span className="text-white font-bold block text-xs">Análisis RAG Documental</span>
                      <span className="text-[11px] text-slate-400 block mt-0.5">9.8K in / 1.4K out</span>
                      <span className="text-[10px] text-cyan-400 font-mono mt-1 block">~11.2K tokens (55% caché)</span>
                    </button>

                    <button
                      onClick={() => applyPresetPayload('batch')}
                      className="p-3 rounded-xl bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-cyan-500/50 text-left transition-colors"
                    >
                      <span className="text-white font-bold block text-xs">Procesamiento Masivo</span>
                      <span className="text-[11px] text-slate-400 block mt-0.5">32K in / 4.8K out</span>
                      <span className="text-[10px] text-cyan-400 font-mono mt-1 block">~36.8K tokens (70% caché)</span>
                    </button>
                  </div>
                </div>

                {/* Custom Parameters Form */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 p-4 rounded-xl bg-slate-900/80 border border-slate-800">
                  {/* Model Selector */}
                  <div>
                    <label className="text-[11px] text-slate-300 font-medium block mb-1.5">
                      Modelo LLM Destino:
                    </label>
                    <select
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
                          Tarifa: ${spec.inputPer1M}/1M in · ${spec.outputPer1M}/1M out
                        </p>
                      );
                    })()}
                  </div>

                  {/* Input Tokens Slider */}
                  <div>
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="text-slate-300 font-medium">Tokens de Entrada (Prompt):</span>
                      <span className="text-sky-300 font-mono font-bold">{simInputTokens.toLocaleString()} t</span>
                    </div>
                    <input
                      type="range"
                      min={100}
                      max={40000}
                      step={100}
                      value={simInputTokens}
                      onChange={(e) => setSimInputTokens(Number(e.target.value))}
                      className="w-full accent-cyan-500"
                    />
                    <div className="flex justify-between text-[9px] text-slate-500 font-mono">
                      <span>100</span>
                      <span>10K</span>
                      <span>25K</span>
                      <span>40K</span>
                    </div>
                  </div>

                  {/* Output Tokens Slider */}
                  <div>
                    <div className="flex items-center justify-between text-[11px] mb-1">
                      <span className="text-slate-300 font-medium">Tokens de Salida (Completion):</span>
                      <span className="text-emerald-300 font-mono font-bold">{simOutputTokens.toLocaleString()} t</span>
                    </div>
                    <input
                      type="range"
                      min={50}
                      max={8000}
                      step={50}
                      value={simOutputTokens}
                      onChange={(e) => setSimOutputTokens(Number(e.target.value))}
                      className="w-full accent-emerald-500"
                    />
                    <div className="flex justify-between text-[9px] text-slate-500 font-mono">
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
                  const spec = MODEL_CATALOG[selectedSimulatorModel] || MODEL_CATALOG['gpt-4o'];
                  const cachedTokens = Math.round(simInputTokens * simCacheHitRatio);
                  const estimatedCost = calculateModelCost(selectedSimulatorModel, simInputTokens, simOutputTokens, cachedTokens);
                  const totalTokensInBurst = simInputTokens + simOutputTokens;

                  return (
                    <div className="p-4 rounded-xl bg-slate-900 border border-cyan-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <span className="text-xs text-slate-400 font-medium block">Resumen de Inyección:</span>
                        <div className="flex items-center gap-3 font-mono text-xs flex-wrap">
                          <span className="text-white font-bold">{totalTokensInBurst.toLocaleString()} tokens totales</span>
                          <span className="text-slate-600">·</span>
                          <span className="text-sky-400">{simInputTokens.toLocaleString()} in</span>
                          <span className="text-slate-600">·</span>
                          <span className="text-emerald-400">{simOutputTokens.toLocaleString()} out</span>
                          <span className="text-slate-600">·</span>
                          <span className="text-purple-400">{cachedTokens.toLocaleString()} en caché</span>
                          <span className="text-slate-600">·</span>
                          <span className="text-emerald-300 font-bold">${estimatedCost.toFixed(5)} USD</span>
                        </div>
                      </div>

                      <button
                        onClick={() => handleTriggerBurst(targetModelObj.model, targetModelObj.provider)}
                        className="px-6 py-2.5 bg-gradient-to-r from-cyan-600 via-sky-600 to-indigo-600 hover:from-cyan-500 hover:to-indigo-500 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-xl shadow-cyan-950 transition-all active:scale-95 shrink-0"
                      >
                        <Play className="w-4 h-4 fill-current" />
                        <span>Disparar Inferencia en Vivo</span>
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
                  <Users className="w-4 h-4 text-cyan-400" />
                  <span>Reasignación Interactiva de Modelos a Agentes</span>
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Cambia el modelo o proveedor asignado a cada agente en tiempo real. Sus futuras inferencias se contabilizarán en el nodo correspondiente.
                </p>
              </div>

              <div className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-900 border-b border-slate-800 text-[11px] text-slate-400 font-mono">
                    <tr>
                      <th className="px-4 py-3">AGENTE</th>
                      <th className="px-4 py-3">ROL</th>
                      <th className="px-4 py-3">PROVEEDOR ACTUAL</th>
                      <th className="px-4 py-3">MODELO ASIGNADO</th>
                      <th className="px-4 py-3">TOKENS ACUMULADOS</th>
                      <th className="px-4 py-3 text-right">ACCIÓN</th>
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
                              />
                              <span className="font-bold text-white">{agent.name}</span>
                            </div>
                          </td>

                          <td className="px-4 py-3 text-slate-400">
                            {agent.roleTitle}
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
                            <span className="text-slate-500 ml-1">(${agent.cost.toFixed(3)})</span>
                          </td>

                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => {
                                onFocusAgent(agent);
                                onClose();
                              }}
                              className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-sky-400 hover:text-white border border-slate-800 text-[11px] font-medium transition-colors"
                            >
                              Centrar Cámara
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
                    <Activity className="w-4 h-4 text-cyan-400" />
                    <span>Registro de Inferencia en Tiempo Real</span>
                  </h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Stream cronológico de peticiones, tokens in/out, latencias y códigos de estado
                  </p>
                </div>

                <button
                  onClick={() => handleTriggerBurst('claude-3-5-sonnet', 'Anthropic', 2100, 600)}
                  className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-cyan-300 border border-cyan-800/60 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Emitir Petición</span>
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
                        />
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-bold text-white">{item.model}</span>
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${meta.badgeBg} ${meta.badgeBorder} ${meta.accent}`}>
                              {item.provider}
                            </span>
                            <span className="text-slate-400 font-sans text-[11px]">
                              por <strong className="text-slate-200">{item.agentName}</strong>
                            </span>
                            <span className="text-[10px] text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30">
                              {item.status}
                            </span>
                          </div>
                          <span className="text-[11px] text-slate-500 mt-0.5 block line-clamp-1">
                            {item.promptSnippet}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 text-[11px] self-end sm:self-center shrink-0">
                        <div>
                          <span className="text-slate-500 block text-[9px]">TOKENS</span>
                          <span className="text-sky-300 font-semibold">{item.inputTokens} in</span>
                          <span className="text-slate-600"> / </span>
                          <span className="text-emerald-300 font-semibold">{item.outputTokens} out</span>
                        </div>
                        <div>
                          <span className="text-slate-500 block text-[9px]">LATENCIA</span>
                          <span className="text-amber-300 font-semibold">{item.latencyMs}ms</span>
                        </div>
                        <div>
                          <span className="text-slate-500 block text-[9px]">COSTO</span>
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
            <span className="font-mono text-[11px] text-cyan-400 font-bold">Tip:</span>
            <span>Haz clic directamente sobre los racks de servidores o la pantalla NOC en la sala Model Ops de la oficina para abrir este panel.</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition-colors border border-slate-700/60"
            >
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
