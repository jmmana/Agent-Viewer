/**
 * Matrix tab, `ledger` mode (issue #79): a thin, read-only view over `GET /api/v1/usage/rollup`
 * (`groupBy=provider,model` for the model cards and the stats strip's `totals`, `groupBy=provider` for the
 * provider cards). No catalog description, context window, latency or price per 1M; no figure is summed in the
 * browser; a `null` metric renders "n/a", a partially reported one carries a "partial" marker.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { Agent } from '../../types/agent';
import { t, type Locale, type TranslationKey } from '../../i18n';
import { compactTokens } from '../../engine/modelOps';
import { canonicalProviderKey, ledgerProviderStyle, providersMatch } from '../../engine/providerAlias';
import type { QueryState, TimeRangeOption } from './useModelOpsLedger';
import type { RollupGroup, RollupResponse } from '../../integrations/ledgerClient';
import { UsageEmptyState } from './UsageEmptyState';
import { distinctCostKeys, formatCostEntries, formatTokenMetric, tokenSortKey, unknownCostLabel } from './usageFormat';
import { ArrowUpRight, Filter, Search, Users } from 'lucide-react';

type MessageParams = Record<string, string | number>;
type SortBy = 'tokens' | 'cost' | 'output' | 'input';

export interface LedgerMatrixViewProps {
  locale: Locale;
  modelRollup: QueryState<RollupResponse>;
  providerRollup: QueryState<RollupResponse>;
  timeRange: TimeRangeOption;
  onTimeRangeChange: (range: TimeRangeOption) => void;
  onRetry: () => void;
  apiBase: string;
  agents: Agent[];
  onFocusAgent: (agent: Agent) => void;
  onClose: () => void;
  initialProviderFilter?: string | null;
}

const NEG_INF = Number.NEGATIVE_INFINITY;

function rowTokenSortValue(row: RollupGroup, sortBy: SortBy): number {
  if (sortBy === 'input') return tokenSortKey(row.tokens.input);
  if (sortBy === 'output') return tokenSortKey(row.tokens.output);
  if (sortBy === 'tokens') {
    const input = tokenSortKey(row.tokens.input);
    const output = tokenSortKey(row.tokens.output);
    return input === NEG_INF || output === NEG_INF ? NEG_INF : input + output;
  }
  return 0;
}

export const LedgerMatrixView: React.FC<LedgerMatrixViewProps> = ({
  locale,
  modelRollup,
  providerRollup,
  timeRange,
  onTimeRangeChange,
  onRetry,
  apiBase,
  agents,
  onFocusAgent,
  onClose,
  initialProviderFilter = null,
}) => {
  const tr = (key: TranslationKey, params?: MessageParams) => t(locale, key, params);

  const [selectedProvider, setSelectedProvider] = useState<'all' | string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('tokens');

  useEffect(() => {
    if (initialProviderFilter) setSelectedProvider(canonicalProviderKey(initialProviderFilter));
  }, [initialProviderFilter]);

  const loading = modelRollup.status === 'loading' || modelRollup.status === 'idle' || providerRollup.status === 'loading' || providerRollup.status === 'idle';
  const unavailable = modelRollup.status === 'unavailable' || providerRollup.status === 'unavailable';
  const unauthorized = modelRollup.status === 'unauthorized' || providerRollup.status === 'unauthorized';
  const erroredState = modelRollup.status === 'error' ? modelRollup : providerRollup.status === 'error' ? providerRollup : null;

  if (loading) return <UsageEmptyState kind="loading" locale={locale} />;
  if (unavailable) return <UsageEmptyState kind="unavailable" locale={locale} />;
  if (unauthorized) return <UsageEmptyState kind="unauthorized" locale={locale} />;
  if (erroredState && erroredState.status === 'error') {
    return <UsageEmptyState kind="error" locale={locale} errorMessage={erroredState.message} onRetry={onRetry} />;
  }
  if (modelRollup.status !== 'ready' || providerRollup.status !== 'ready') return null;

  const modelData = modelRollup.data;
  const providerData = providerRollup.data;
  const totals = modelData.totals;

  if (totals.calls.total === 0) {
    return <UsageEmptyState kind="empty" locale={locale} apiBase={apiBase} />;
  }

  const providerOptions = useMemoProviderOptions(providerData.groups);

  const filteredModels = modelData.groups.filter((group) => {
    if (selectedProvider !== 'all' && canonicalProviderKey(group.key.provider ?? '') !== selectedProvider) return false;
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    return (group.key.model ?? '').toLowerCase().includes(query) || (group.key.provider ?? '').toLowerCase().includes(query);
  });

  const costKeySet = distinctCostKeys(filteredModels.map((row) => row.cost.entries));
  const sortByCostDisabled = costKeySet.size > 1;
  const effectiveSortBy: SortBy = sortByCostDisabled && sortBy === 'cost' ? 'tokens' : sortBy;

  const sortedModels = [...filteredModels].sort((a, b) => rowTokenSortValue(b, effectiveSortBy) - rowTokenSortValue(a, effectiveSortBy));

  const showShareBar = effectiveSortBy === 'input' || effectiveSortBy === 'output';
  const shareTotal = showShareBar ? totals.tokens[effectiveSortBy].sum : null;

  const clearFilters = () => {
    setSelectedProvider('all');
    setSearchQuery('');
  };

  const costEntries = formatCostEntries(totals.cost.entries, locale);
  const unknownCost = unknownCostLabel(totals.cost.unknownCostCalls, locale);

  return (
    <div className="space-y-6">
      {/* STATS STRIP: from the totals row of the time range selected, never recomputed from filtered rows below */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <StatTile label={tr('ops.stats.calls')} value={totals.calls.total.toLocaleString(locale)} sub={`${totals.calls.failed.toLocaleString(locale)} ${tr('ops.stats.failedCalls').toLowerCase()}`} />
        <StatTile
          label={tr('ops.metric.input') + ' / ' + tr('ops.metric.output')}
          value={`${formatTokenMetric(totals.tokens.input, totals.calls.total, locale).text} / ${formatTokenMetric(totals.tokens.output, totals.calls.total, locale).text}`}
        />
        <StatTile
          label={tr('ops.stats.cacheReasoning')}
          value={`${formatTokenMetric(totals.tokens.cacheRead, totals.calls.total, locale).text} / ${formatTokenMetric(totals.tokens.reasoning, totals.calls.total, locale).text}`}
        />
        <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
          <span className="text-slate-400 text-[11px] block font-medium">{tr('ops.stats.reportedCost')}</span>
          <div className="flex flex-wrap items-baseline gap-1.5">
            {costEntries.length === 0 && <span className="text-slate-500 font-mono">{tr('ops.value.na')}</span>}
            {costEntries.map((entry, index) => (
              <span key={index} className="font-mono font-bold text-emerald-400">
                {entry.text}
                {entry.sourceLabel && <span className="text-[9px] text-amber-300 font-sans ml-1">({entry.sourceLabel})</span>}
              </span>
            ))}
          </div>
          {unknownCost && <span className="text-[10px] text-slate-500 block">{unknownCost}</span>}
        </div>
      </div>

      {/* FILTERS & TIME RANGE ROW */}
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
            {tr('ops.filter.all', { count: providerOptions.length })}
          </button>
          {providerOptions.map((option) => {
            const style = ledgerProviderStyle(option.label);
            const isSelected = selectedProvider === option.key;
            return (
              <button
                key={option.key}
                type="button"
                aria-pressed={isSelected}
                onClick={() => setSelectedProvider(option.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition-colors border ${isSelected ? 'bg-slate-800 text-white font-bold border-cyan-400' : 'bg-slate-900/70 hover:bg-slate-800 text-slate-300 border-slate-800'}`}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: style.color }} aria-hidden="true" />
                <span>{option.label}</span>
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
              onChange={(event) => setSearchQuery(event.target.value)}
              className="bg-slate-900 border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-cyan-500 w-48 font-mono"
            />
          </div>

          <div role="group" aria-labelledby="av-modelops-sort-label" className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
            <span id="av-modelops-sort-label" className="text-[10px] text-slate-400 px-1.5 font-medium">{tr('ops.sort.label')}</span>
            {(['tokens', 'cost', 'output', 'input'] as SortBy[]).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={effectiveSortBy === option}
                disabled={option === 'cost' && sortByCostDisabled}
                title={option === 'cost' && sortByCostDisabled ? tr('ops.sort.costDisabledTitle') : undefined}
                onClick={() => setSortBy(option)}
                className={`px-2 py-1 rounded text-[11px] disabled:opacity-40 disabled:cursor-not-allowed ${effectiveSortBy === option ? 'bg-cyan-500/20 text-cyan-300 font-bold' : 'text-slate-400 hover:text-white'}`}
              >
                {tr(option === 'tokens' ? 'ops.sort.tokens' : option === 'cost' ? 'ops.sort.cost' : option === 'output' ? 'ops.sort.output' : 'ops.filter.provider')}
              </button>
            ))}
          </div>

          <div role="group" aria-label={tr('ops.matrix.timeRange.label')} className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
            <span className="text-[10px] text-slate-400 px-1.5 font-medium">{tr('ops.matrix.timeRange.label')}</span>
            {(['all', '24h', '7d'] as TimeRangeOption[]).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={timeRange === option}
                onClick={() => onTimeRangeChange(option)}
                className={`px-2 py-1 rounded text-[11px] ${timeRange === option ? 'bg-cyan-500/20 text-cyan-300 font-bold' : 'text-slate-400 hover:text-white'}`}
              >
                {tr(option === 'all' ? 'ops.matrix.timeRange.all' : option === '24h' ? 'ops.matrix.timeRange.last24h' : 'ops.matrix.timeRange.last7d')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {modelData.truncated && (
        <p className="text-[11px] text-amber-300 bg-amber-950/30 border border-amber-500/30 rounded-lg px-3 py-2">
          {tr('ops.matrix.truncated', { count: modelData.groups.length })}
        </p>
      )}

      {/* PROVIDER CARDS */}
      <div className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {providerData.groups.map((group) => {
            const providerLabel = group.key.provider ?? tr('ops.value.na');
            const style = ledgerProviderStyle(providerLabel);
            const providerCost = formatCostEntries(group.cost.entries, locale);
            const providerUnknownCost = unknownCostLabel(group.cost.unknownCostCalls, locale);
            return (
              <div key={providerLabel} className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3 relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-1" style={{ backgroundColor: style.color }} aria-hidden="true" />
                <div className="flex items-center gap-2 pt-1">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: style.color }} aria-hidden="true" />
                  <h4 className="text-sm font-bold text-white font-mono">{providerLabel}</h4>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px] font-mono bg-slate-900/60 p-2.5 rounded-lg border border-slate-800/80">
                  <div>
                    <span className="text-slate-400 block text-[10px]">{tr('ops.matrix.col.calls')}</span>
                    <span className="font-bold text-white">{group.calls.total.toLocaleString(locale)}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">{tr('ops.matrix.col.failedCalls')}</span>
                    <span className="font-bold text-red-400">{group.calls.failed.toLocaleString(locale)}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">{tr('ops.metric.inOut')}</span>
                    <span className="text-slate-300">
                      {formatTokenMetric(group.tokens.input, group.calls.total, locale).text} / {formatTokenMetric(group.tokens.output, group.calls.total, locale).text}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[10px]">{tr('ops.matrix.col.cost')}</span>
                    <span className="text-emerald-400 font-semibold">
                      {providerCost.length === 0 ? tr('ops.value.na') : providerCost.map((e) => e.text).join(' / ')}
                    </span>
                  </div>
                </div>
                {providerUnknownCost && <span className="text-[10px] text-slate-500 block">{providerUnknownCost}</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* MODEL CARDS */}
      <div className="space-y-4 pt-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white">{tr('ops.models.heading')}</h3>
          <span className="text-slate-400 text-[11px] font-mono">{tr('ops.models.showing', { count: sortedModels.length })}</span>
        </div>

        {sortedModels.length === 0 ? (
          <UsageEmptyState kind="filtered" locale={locale} onClearFilters={clearFilters} />
        ) : (
          <div className="space-y-3">
            {sortedModels.map((group) => {
              const providerLabel = group.key.provider ?? tr('ops.value.na');
              const modelLabel = group.key.model ?? tr('ops.value.na');
              const style = ledgerProviderStyle(providerLabel);
              const costEntriesForModel = formatCostEntries(group.cost.entries, locale);
              const unknownCostForModel = unknownCostLabel(group.cost.unknownCostCalls, locale);
              const assignedAgents = agents.filter(
                (agent) => providersMatch(agent.provider, providerLabel) && agent.model === modelLabel
              );
              const shareValue = showShareBar && shareTotal !== null && shareTotal > 0
                ? ((group.tokens[effectiveSortBy as 'input' | 'output'].sum ?? 0) / shareTotal) * 100
                : null;

              return (
                <div key={`${providerLabel}::${modelLabel}`} className="bg-slate-950 p-4 rounded-xl border border-slate-800 hover:border-slate-700 transition-all space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ backgroundColor: style.color }} aria-hidden="true" />
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-bold text-white font-mono">{modelLabel}</span>
                          <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${style.badgeBg} ${style.badgeBorder} ${style.accent}`}>{providerLabel}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {shareValue !== null && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px] font-mono">
                        <span className="text-slate-400">{tr('ops.models.relativeVolume')}</span>
                        <span className="text-white font-bold">{shareValue.toFixed(1)}%</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800" aria-hidden="true">
                        <div className="h-full transition-all duration-500" style={{ width: `${Math.max(shareValue, 2)}%`, backgroundColor: style.color }} />
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 font-mono text-[11px] bg-slate-900/80 p-3 rounded-lg border border-slate-800/80">
                    <TokenCell label={tr('ops.matrix.col.calls')} value={group.calls.total.toLocaleString(locale)} />
                    <TokenCell label={tr('ops.matrix.col.failedCalls')} value={group.calls.failed.toLocaleString(locale)} tone="text-red-400" />
                    {(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const).map((kind) => {
                      const metric = formatTokenMetric(group.tokens[kind], group.calls.total, locale);
                      return (
                        <TokenCell
                          key={kind}
                          label={tr(
                            kind === 'input'
                              ? 'ops.matrix.col.input'
                              : kind === 'output'
                                ? 'ops.matrix.col.output'
                                : kind === 'cacheRead'
                                  ? 'ops.matrix.col.cacheRead'
                                  : kind === 'cacheWrite'
                                    ? 'ops.matrix.col.cacheWrite'
                                    : 'ops.matrix.col.reasoning'
                          )}
                          value={metric.text}
                          title={metric.title}
                          partial={metric.isPartial}
                        />
                      );
                    })}
                  </div>

                  <div className="flex items-center justify-between gap-2 flex-wrap text-[11px]">
                    <div className="flex items-center gap-2 flex-wrap font-mono">
                      <span className="text-slate-400 block text-[10px]">{tr('ops.matrix.col.cost')}</span>
                      {costEntriesForModel.length === 0 ? (
                        <span className="text-slate-500">{tr('ops.value.na')}</span>
                      ) : (
                        costEntriesForModel.map((entry, index) => (
                          <span key={index} className="font-bold text-emerald-400">
                            {entry.text}
                            {entry.sourceLabel && <span className="text-[9px] text-amber-300 font-sans ml-1">({entry.sourceLabel})</span>}
                          </span>
                        ))
                      )}
                      {unknownCostForModel && <span className="text-[10px] text-slate-500">{unknownCostForModel}</span>}
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-slate-400 flex items-center gap-1">
                        <Users className="w-3 h-3" aria-hidden="true" />
                        {tr('ops.models.assignedAgents', { count: assignedAgents.length })}
                      </span>
                      {assignedAgents.map((agent) => (
                        <button
                          key={agent.id}
                          type="button"
                          onClick={() => {
                            onFocusAgent(agent);
                            onClose();
                          }}
                          className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-200"
                        >
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: agent.clothingColor }} aria-hidden="true" />
                          <span>{agent.name}</span>
                          <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

function useMemoProviderOptions(groups: RollupGroup[]): Array<{ key: string; label: string }> {
  return useMemo(() => {
    const seen = new Map<string, string>();
    for (const group of groups) {
      const label = group.key.provider;
      if (!label) continue;
      const key = canonicalProviderKey(label);
      if (!seen.has(key)) seen.set(key, label);
    }
    return [...seen.entries()].map(([key, label]) => ({ key, label }));
  }, [groups]);
}

const StatTile: React.FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
  <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-1">
    <span className="text-slate-400 text-[11px] block font-medium">{label}</span>
    <div className="flex items-baseline gap-2">
      <span className="text-lg font-bold font-mono text-cyan-400">{value}</span>
    </div>
    {sub && <span className="text-[10px] text-slate-400 font-mono block">{sub}</span>}
  </div>
);

const TokenCell: React.FC<{ label: string; value: string; title?: string; tone?: string; partial?: boolean }> = ({
  label,
  value,
  title,
  tone,
  partial,
}) => (
  <div title={title}>
    <span className="text-slate-400 block text-[10px]">{label}</span>
    <span className={`font-bold text-xs ${tone ?? 'text-white'}`}>
      {value}
      {partial && <span className="ml-1 text-[9px] text-amber-300 font-sans align-top">*</span>}
    </span>
  </div>
);
