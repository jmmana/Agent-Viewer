/**
 * Agents tab (issue #79). `ledger` mode: one row per agent and model actually called, from
 * `GET /api/v1/usage/rollup?groupBy=agent,model`; the model is something observed, not assigned, so there is no
 * `<select>` here. `simulated` mode keeps the pre-ledger behavior: agent-level counters and the interactive
 * model reassignment the demo has always offered.
 */
import React from 'react';
import type { Agent } from '../../types/agent';
import { t, type Locale, type TranslationKey } from '../../i18n';
import { compactTokens } from '../../engine/modelOps';
import { localizeDemoText } from '../../content/demoScript';
import { ledgerProviderStyle } from '../../engine/providerAlias';
import type { QueryState } from './useModelOpsLedger';
import type { RollupResponse } from '../../integrations/ledgerClient';
import { UsageEmptyState } from './UsageEmptyState';
import { formatCostEntries, formatTokenMetric, unknownCostLabel } from './usageFormat';

type MessageParams = Record<string, string | number>;

export interface AgentsTabProps {
  mode: 'ledger' | 'simulated';
  locale: Locale;
  agents: Agent[];
  onFocusAgent: (agent: Agent) => void;
  onClose: () => void;
  onRetry: () => void;
  // ledger mode
  agentRollup: QueryState<RollupResponse>;
  // simulated mode
  allModels: Array<{ provider: string; model: string }>;
  onChangeAgentModel?: (agentId: string, newProvider: string, newModel: string) => void;
  isLiveMode?: boolean;
}

export const AgentsTab: React.FC<AgentsTabProps> = ({
  mode,
  locale,
  agents,
  onFocusAgent,
  onClose,
  onRetry,
  agentRollup,
  allModels,
  onChangeAgentModel,
  isLiveMode = false,
}) => {
  const tr = (key: TranslationKey, params?: MessageParams) => t(locale, key, params);

  if (mode === 'ledger') {
    if (agentRollup.status === 'loading' || agentRollup.status === 'idle') return <UsageEmptyState kind="loading" locale={locale} />;
    if (agentRollup.status === 'unavailable') return <UsageEmptyState kind="unavailable" locale={locale} />;
    if (agentRollup.status === 'unauthorized') return <UsageEmptyState kind="unauthorized" locale={locale} />;
    if (agentRollup.status === 'error') return <UsageEmptyState kind="error" locale={locale} errorMessage={agentRollup.message} onRetry={onRetry} />;

    const rows = agentRollup.data.groups;
    const rowsByAgentId = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.key.agent ?? '';
      rowsByAgentId.set(key, [...(rowsByAgentId.get(key) ?? []), row]);
    }

    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-bold text-white">{tr('ops.agents.ledger.heading')}</h3>
          <p className="text-[11px] text-slate-400 mt-0.5">{tr('ops.agents.ledger.subtitle')}</p>
        </div>

        <div className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900 border-b border-slate-800 text-[11px] text-slate-400 font-mono">
              <tr>
                <th scope="col" className="px-4 py-3">{tr('ops.agents.col.agent')}</th>
                <th scope="col" className="px-4 py-3">{tr('ops.agents.col.provider')}</th>
                <th scope="col" className="px-4 py-3">{tr('ops.agents.col.model')}</th>
                <th scope="col" className="px-4 py-3">{tr('ops.agents.col.calls')}</th>
                <th scope="col" className="px-4 py-3">{tr('ops.agents.col.failedCalls')}</th>
                <th scope="col" className="px-4 py-3">{tr('ops.agents.col.tokens')}</th>
                <th scope="col" className="px-4 py-3">{tr('ops.agents.col.cost')}</th>
                <th scope="col" className="px-4 py-3 text-right">{tr('ops.agents.col.action')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {rows.map((row) => {
                const agentId = row.key.agent;
                const officeAgent = agentId ? agents.find((candidate) => candidate.id === agentId) : undefined;
                const providerLabel = row.key.provider ?? tr('ops.value.na');
                const modelLabel = row.key.model ?? tr('ops.value.na');
                const style = ledgerProviderStyle(providerLabel);
                const costEntries = formatCostEntries(row.cost.entries, locale);
                const unknownCost = unknownCostLabel(row.cost.unknownCostCalls, locale);
                const inputMetric = formatTokenMetric(row.tokens.input, row.calls.total, locale);
                const outputMetric = formatTokenMetric(row.tokens.output, row.calls.total, locale);

                return (
                  <tr key={`${agentId ?? 'unattributed'}::${modelLabel}`} className="hover:bg-slate-900/50 transition-colors">
                    <td className="px-4 py-3">
                      {officeAgent ? (
                        <div className="flex items-center gap-2.5">
                          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: officeAgent.clothingColor }} aria-hidden="true" />
                          <span className="font-bold text-white">{officeAgent.name}</span>
                        </div>
                      ) : agentId ? (
                        <span className="font-mono text-slate-300">{agentId}</span>
                      ) : (
                        <span className="italic text-slate-400">{tr('ops.agents.unattributed')}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${style.badgeBg} ${style.badgeBorder} ${style.accent}`}>{providerLabel}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-200">{modelLabel}</td>
                    <td className="px-4 py-3 font-mono">{row.calls.total.toLocaleString(locale)}</td>
                    <td className="px-4 py-3 font-mono text-red-400">{row.calls.failed.toLocaleString(locale)}</td>
                    <td className="px-4 py-3 font-mono text-[11px]" title={inputMetric.title ?? outputMetric.title}>
                      {inputMetric.text} / {outputMetric.text}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-emerald-400">
                      {costEntries.length === 0 ? tr('ops.value.na') : costEntries.map((entry) => entry.text).join(' / ')}
                      {unknownCost && <span className="block text-[10px] text-slate-500">{unknownCost}</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {officeAgent && (
                        <button
                          type="button"
                          onClick={() => {
                            onFocusAgent(officeAgent);
                            onClose();
                          }}
                          className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-sky-400 hover:text-white border border-slate-800 text-[11px] font-medium transition-colors"
                        >
                          {tr('ops.agents.focus')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {agents
                .filter((agent) => !rowsByAgentId.has(agent.id))
                .map((agent) => (
                  <tr key={agent.id} className="hover:bg-slate-900/50 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: agent.clothingColor }} aria-hidden="true" />
                        <span className="font-bold text-white">{agent.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-slate-500 italic" colSpan={5}>{tr('ops.agents.noUsage')}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => {
                          onFocusAgent(agent);
                          onClose();
                        }}
                        className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-sky-400 hover:text-white border border-slate-800 text-[11px] font-medium transition-colors"
                      >
                        {tr('ops.agents.focus')}
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ---- simulated mode: unchanged pre-ledger behavior (agent-level counters, interactive reassignment) ----
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-bold text-white">{tr('ops.agents.heading')}</h3>
        <p className="text-[11px] text-slate-400 mt-0.5">{tr('ops.agents.subtitle')}</p>
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
              const style = ledgerProviderStyle(agent.provider);
              const totalTokens = agent.tokensInput + agent.tokensOutput;
              return (
                <tr key={agent.id} className="hover:bg-slate-900/50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: agent.clothingColor }} aria-hidden="true" />
                      <span className="font-bold text-white">{agent.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-400">{localizeDemoText(agent.roleTitle, locale)}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${style.badgeBg} ${style.badgeBorder} ${style.accent}`}>{agent.provider}</span>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      aria-label={tr('ops.agents.modelSelect', { name: agent.name })}
                      value={`${agent.provider}::${agent.model}`}
                      disabled={isLiveMode}
                      title={isLiveMode ? tr('ops.agents.readOnlyLive') : undefined}
                      onChange={(event) => {
                        if (isLiveMode) return;
                        const [newProvider, newModel] = event.target.value.split('::');
                        onChangeAgentModel?.(agent.id, newProvider, newModel);
                      }}
                      className="bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1 text-xs text-white font-mono focus:outline-none focus:border-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {allModels.map((item) => (
                        <option key={`${item.provider}::${item.model}`} value={`${item.provider}::${item.model}`}>
                          {item.provider} · {item.model}
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
  );
};
