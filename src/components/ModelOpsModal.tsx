import React, { useEffect, useMemo, useState, useRef } from 'react';
import type { Agent, ViewerEvent } from '../types/agent';
import {
  aggregateModelUsage,
  compactTokens,
  MODEL_CATALOG,
  calculateModelCost,
  generateSimulatedCallId,
  getModelSpec,
  type SimulatedCall,
  type SimulatedCallPreset,
} from '../engine/modelOps';
import { t, type Locale, type TranslationKey } from '../i18n';
import { useModelOpsLedger, type LedgerConnection } from './modelOps/useModelOpsLedger';
import { MatrixTab } from './modelOps/MatrixTab';
import { AgentsTab } from './modelOps/AgentsTab';
import { FeedTab } from './modelOps/FeedTab';
import { SimulatorTab } from './modelOps/SimulatorTab';
import {
  X,
  Server,
  Activity,
  Sparkles,
  Users,
  CheckCircle2,
  Radio,
  BarChart3,
  Zap,
  type LucideIcon,
} from 'lucide-react';

export interface ModelOpsModalProps {
  isOpen: boolean;
  onClose: () => void;
  agents: Agent[];
  onFocusAgent: (agent: Agent) => void;
  /** Records a what-if call from the simulator. Never mutates agent counters, totals or events. */
  onSimulateCall?: (call: SimulatedCall) => void;
  /** Calls recorded this session, newest first. Lives outside `SimulationState` (see `recordSimulatedCall`). */
  simulatedCalls?: SimulatedCall[];
  onChangeAgentModel?: (agentId: string, newProvider: string, newModel: string) => void;
  initialProviderFilter?: string | null;
  events?: ViewerEvent[];
  locale: Locale;
  /** The portal cannot invent usage or change a remote agent's model against a live server. */
  isLiveMode?: boolean;
  /** Present when the portal resolved an API base (issue #79: `resolveLiveConnection().apiBase`). `null`/absent
   * switches Matrix, Agents and Feed to `simulated` mode: the demo's own agent state, clearly labelled. */
  ledger?: LedgerConnection | null;
}

type MessageParams = Record<string, string | number>;

type ModelOpsTab = 'matrix' | 'simulator' | 'agents' | 'feed';

const TABS: readonly ModelOpsTab[] = ['matrix', 'simulator', 'agents', 'feed'];

const TITLE_ID = 'av-modelops-title';
const PANEL_ID = 'av-modelops-panel';
const tabId = (tab: ModelOpsTab) => `av-modelops-tab-${tab}`;

interface BurstNotice {
  provider: string;
  model: string;
  tokens: number;
  cost: number | null;
}

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

const SimulatedBadgeTag: React.FC<{ label: string }> = ({ label }) => (
  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/40 shrink-0">
    {label}
  </span>
);

function formatCost(value: number | null, tr: (key: TranslationKey, params?: MessageParams) => string): string {
  return value === null ? tr('ops.value.unknown') : `$${value.toFixed(4)}`;
}

export const ModelOpsModal: React.FC<ModelOpsModalProps> = ({
  isOpen,
  onClose,
  agents,
  onFocusAgent,
  onSimulateCall,
  simulatedCalls = [],
  onChangeAgentModel,
  initialProviderFilter = null,
  events = [],
  locale,
  isLiveMode = false,
  ledger = null,
}) => {
  const tr = (key: TranslationKey, params?: MessageParams) => t(locale, key, params);

  const [activeTab, setActiveTab] = useState<ModelOpsTab>('matrix');
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Simulator tab state. Model defaults to the first demo-catalog entry: the simulator only ever offers catalog
  // models (issue #79), never a model only observed on the real ledger, whose price this demo does not know.
  const [selectedSimulatorModel, setSelectedSimulatorModel] = useState<string>(Object.keys(MODEL_CATALOG)[0]);
  const [selectedPreset, setSelectedPreset] = useState<SimulatedCallPreset>('custom');
  const [simInputTokens, setSimInputTokens] = useState<number>(1800);
  const [simOutputTokens, setSimOutputTokens] = useState<number>(450);
  const [simCacheHitRatio] = useState<number>(0.35);
  const [lastBurstSuccess, setLastBurstSuccess] = useState<BurstNotice | null>(null);

  const ledgerState = useModelOpsLedger({ ledger, isOpen, events });
  const mode = ledgerState.mode;

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) closeButtonRef.current?.focus();
  }, [isOpen]);

  // Simulated-mode aggregates, used by the outer stats strip and the Agents tab's model selector. Never read in
  // `ledger` mode: see `@deprecated demo-only` on `aggregateModelUsage` (issue #79).
  const providerData = useMemo(() => aggregateModelUsage(agents), [agents]);
  const totalOfficeTokens = useMemo(() => providerData.reduce((acc, p) => acc + p.totalTokens, 0), [providerData]);
  const totalOfficeCost = useMemo(() => providerData.reduce((acc, p) => acc + p.cost, 0), [providerData]);
  const totalInputTokens = useMemo(() => providerData.reduce((acc, p) => acc + p.inputTokens, 0), [providerData]);
  const totalOutputTokens = useMemo(() => providerData.reduce((acc, p) => acc + p.outputTokens, 0), [providerData]);
  const totalCachedTokens = useMemo(() => providerData.reduce((acc, p) => acc + p.cachedTokens, 0), [providerData]);
  const totalReasoningTokens = useMemo(() => providerData.reduce((acc, p) => acc + p.reasoningTokens, 0), [providerData]);

  const allModels = useMemo(() => {
    const list: Array<{ provider: string; model: string }> = [];
    const seen = new Set<string>();
    for (const p of providerData) {
      for (const m of p.models) {
        const key = `${p.provider}::${m.model}`;
        if (!seen.has(key)) {
          seen.add(key);
          list.push({ provider: p.provider, model: m.model });
        }
      }
    }
    for (const [id, spec] of Object.entries(MODEL_CATALOG)) {
      const key = `${spec.provider}::${id}`;
      if (!seen.has(key)) {
        seen.add(key);
        list.push({ provider: spec.provider, model: id });
      }
    }
    return list;
  }, [providerData]);

  const ledgerAsOf = ledgerState.modelRollup.status === 'ready' ? ledgerState.modelRollup.data.asOf.generatedAt : null;

  const handleSimulate = (modelName: string, providerName: string, preset: SimulatedCallPreset, customIn?: number, customOut?: number) => {
    const spec = getModelSpec(modelName);
    const inTokens = customIn ?? simInputTokens;
    const outTokens = customOut ?? simOutputTokens;
    const cacheTokens = Math.round(inTokens * simCacheHitRatio);
    const cost = calculateModelCost(modelName, inTokens, outTokens, cacheTokens);
    const latencyMs = spec ? Math.round(spec.latencyMs * (0.85 + Math.random() * 0.35)) : null;

    const targetAgent =
      agents.find((a) => a.provider === providerName && a.model === modelName) ||
      agents.find((a) => a.provider === providerName) ||
      null;

    const call: SimulatedCall = {
      id: generateSimulatedCallId(),
      simulated: true,
      timestamp: Date.now(),
      provider: providerName,
      model: modelName,
      agentId: targetAgent ? targetAgent.id : null,
      preset,
      inputTokens: inTokens,
      outputTokens: outTokens,
      cachedTokens: cacheTokens,
      estimatedCost: cost,
      currency: cost === null ? null : 'USD',
      latencyMs,
    };

    // Never a network request, regardless of mode: the simulator is isolated from the server and from the real
    // tabs (issue #57, verified for `ledger` mode by `tests/lib/modelOpsSimulator.test.tsx`).
    onSimulateCall?.(call);
    setLastBurstSuccess({ provider: providerName, model: modelName, tokens: inTokens + outTokens, cost });
    setTimeout(() => setLastBurstSuccess(null), 3500);
  };

  const applyPresetPayload = (type: 'chat' | 'code' | 'rag' | 'batch') => {
    setSelectedPreset(type);
    if (type === 'chat') {
      setSimInputTokens(450);
      setSimOutputTokens(180);
    } else if (type === 'code') {
      setSimInputTokens(2400);
      setSimOutputTokens(850);
    } else if (type === 'rag') {
      setSimInputTokens(9800);
      setSimOutputTokens(1400);
    } else if (type === 'batch') {
      setSimInputTokens(32000);
      setSimOutputTokens(4800);
    }
  };

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
                {mode === 'ledger' ? (
                  <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                    <Radio className="w-3 h-3 text-emerald-400 animate-pulse" aria-hidden="true" />
                    <span>
                      {ledgerAsOf !== null
                        ? tr('ops.mode.ledgerStatus', { time: new Date(ledgerAsOf).toLocaleTimeString(locale) })
                        : tr('ops.empty.loading')}
                    </span>
                  </span>
                ) : (
                  <span className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/40">
                    <span>{tr('ops.mode.simulatedBadge')}</span>
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">{tr('ops.subtitle')}</p>
            </div>
          </div>

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

        {/* TOP SUMMARY STATS STRIP: simulated mode only. Ledger mode's own stats strip (from the rollup totals,
            never summed in the browser) lives inside the Matrix tab, since it is this view's own. */}
        {mode === 'simulated' && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 px-6 py-3.5 bg-slate-950/70 border-b border-slate-800 shrink-0 text-xs">
            <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
              <span className="text-slate-400 text-[11px] block font-medium">{tr('ops.stats.totalTokens')}</span>
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-bold font-mono text-cyan-400">{compactTokens(totalOfficeTokens)}</span>
                <span className="text-[10px] text-slate-400 font-mono">({totalOfficeTokens.toLocaleString()})</span>
              </div>
            </div>
            <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
              <span className="text-slate-400 text-[11px] block font-medium">{tr('ops.stats.estimatedSpend')}</span>
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-bold font-mono text-emerald-400">${totalOfficeCost.toFixed(4)}</span>
                <span className="text-[10px] text-slate-400 font-mono">{tr('ops.unit.usd')}</span>
              </div>
            </div>
            <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
              <span className="text-slate-400 text-[11px] block font-medium flex items-center gap-1">
                <Sparkles className="w-3 h-3 text-purple-400" aria-hidden="true" />
                <span>{tr('ops.stats.inputOutput')}</span>
              </span>
              <div className="flex items-center gap-2 font-mono text-[11px] mt-1">
                <span className="text-sky-400">{tr('ops.tokens.inValue', { value: compactTokens(totalInputTokens) })}</span>
                <span className="text-slate-400">/</span>
                <span className="text-emerald-400">{tr('ops.tokens.outValue', { value: compactTokens(totalOutputTokens) })}</span>
              </div>
            </div>
            <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
              <span className="text-slate-400 text-[11px] block font-medium">{tr('ops.stats.cacheReasoning')}</span>
              <div className="flex items-center gap-2 font-mono text-[11px] mt-1">
                <span className="text-purple-400">{compactTokens(totalCachedTokens)}</span>
                <span className="text-slate-400">/</span>
                <span className="text-amber-400">{compactTokens(totalReasoningTokens)}</span>
              </div>
            </div>
            <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1 col-span-2 sm:col-span-1">
              <span className="text-slate-400 text-[11px] block font-medium">{tr('ops.stats.providersModels')}</span>
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-bold font-mono text-white">{providerData.length}</span>
                <span className="text-[11px] text-slate-400">{tr('ops.stats.providersCount', { models: allModels.length })}</span>
              </div>
            </div>
          </div>
        )}

        {/* NAVIGATION TABS */}
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
                  className={`px-3 py-1.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${isActive ? 'bg-cyan-700 text-white font-bold shadow-md shadow-cyan-500/20' : 'text-slate-400 hover:text-white'}`}
                >
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>{tr(TAB_KEYS[tab], { count: agents.length })}</span>
                </button>
              );
            })}
          </div>
        </div>

        {lastBurstSuccess && (
          <div role="status" className="mx-6 mt-3 p-3 rounded-xl bg-emerald-950/70 border border-emerald-500/40 text-emerald-300 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 font-medium text-xs">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
              <SimulatedBadgeTag label={tr('ops.badge.simulated')} />
              <span>
                {tr('ops.toast.burst', {
                  provider: lastBurstSuccess.provider,
                  model: lastBurstSuccess.model,
                  tokens: lastBurstSuccess.tokens.toLocaleString(),
                  cost: formatCost(lastBurstSuccess.cost, tr),
                })}
              </span>
            </div>
          </div>
        )}

        {/* MAIN SCROLLABLE CONTENT */}
        <div id={PANEL_ID} role="tabpanel" aria-labelledby={tabId(activeTab)} tabIndex={0} className="flex-1 overflow-y-auto p-6 space-y-6 text-xs">
          {activeTab === 'matrix' && (
            <MatrixTab
              mode={mode}
              locale={locale}
              agents={agents}
              onFocusAgent={onFocusAgent}
              onClose={onClose}
              initialProviderFilter={initialProviderFilter}
              modelRollup={ledgerState.modelRollup}
              providerRollup={ledgerState.providerRollup}
              timeRange={ledgerState.timeRange}
              onTimeRangeChange={ledgerState.setTimeRange}
              onRetry={ledgerState.retry}
              apiBase={ledger?.baseUrl}
            />
          )}

          {activeTab === 'simulator' && (
            <SimulatorTab
              locale={locale}
              selectedModel={selectedSimulatorModel}
              onSelectedModelChange={setSelectedSimulatorModel}
              selectedPreset={selectedPreset}
              onApplyPreset={applyPresetPayload}
              inputTokens={simInputTokens}
              onInputTokensChange={setSimInputTokens}
              outputTokens={simOutputTokens}
              onOutputTokensChange={setSimOutputTokens}
              cacheHitRatio={simCacheHitRatio}
              onFire={handleSimulate}
            />
          )}

          {activeTab === 'agents' && (
            <AgentsTab
              mode={mode}
              locale={locale}
              agents={agents}
              onFocusAgent={onFocusAgent}
              onClose={onClose}
              onRetry={ledgerState.retry}
              agentRollup={ledgerState.agentRollup}
              allModels={allModels}
              onChangeAgentModel={onChangeAgentModel}
              isLiveMode={isLiveMode}
            />
          )}

          {activeTab === 'feed' && (
            <FeedTab
              mode={mode}
              locale={locale}
              agents={agents}
              onRetry={ledgerState.retry}
              feed={ledgerState.feed}
              feedFilters={ledgerState.feedFilters}
              onFeedFiltersChange={ledgerState.setFeedFilters}
              onLoadMore={ledgerState.loadMoreFeed}
              apiBase={ledger?.baseUrl}
              simulatedCalls={simulatedCalls}
              onEmitSimulated={() => handleSimulate('claude-3-5-sonnet', 'Anthropic', 'custom', 2100, 600)}
              isLiveMode={isLiveMode}
            />
          )}
        </div>

        {/* MODAL FOOTER */}
        <div className="px-6 py-3.5 bg-slate-950/90 border-t border-slate-800 flex items-center justify-between text-xs shrink-0">
          <div className="flex items-center gap-2 text-slate-400">
            <span className="font-mono text-[11px] text-cyan-400 font-bold">{tr('ops.footer.tip')}</span>
            <span>{tr('ops.footer.tipText')}</span>
          </div>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition-colors border border-slate-700/60">
            {tr('ops.footer.close')}
          </button>
        </div>
      </div>
    </div>
  );
};
