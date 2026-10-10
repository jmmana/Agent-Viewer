/**
 * Feed tab (issue #79). `ledger` mode: real calls from `GET /api/v1/usage/calls`, newest first, in server order,
 * paginated by cursor. No prompt text, no endpoint string, no fabricated entry. `simulated` mode keeps the
 * existing list of this session's simulator bursts (see `SimulatedCall`), each carrying a "Simulated" badge.
 */
import React from 'react';
import type { Agent } from '../../types/agent';
import { t, type Locale, type TranslationKey } from '../../i18n';
import { ledgerProviderStyle } from '../../engine/providerAlias';
import type { SimulatedCall } from '../../engine/modelOps';
import type { CallRecord } from '../../integrations/ledgerClient';
import type { FeedFilters, FeedState } from './useModelOpsLedger';
import { UsageEmptyState } from './UsageEmptyState';
import { formatCostEntries } from './usageFormat';
import { Loader2, Play } from 'lucide-react';

type MessageParams = Record<string, string | number>;

const SimulatedBadge: React.FC<{ label: string }> = ({ label }) => (
  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/40 shrink-0">
    {label}
  </span>
);

function formatCost(entry: CallRecord, locale: Locale, tr: (key: TranslationKey, params?: MessageParams) => string): string {
  if (entry.cost === null) return tr('ops.feed.ledger.costUnknown');
  const amount = entry.currency
    ? new Intl.NumberFormat(locale, { style: 'currency', currency: entry.currency, maximumFractionDigits: 6 }).format(entry.cost)
    : entry.cost.toFixed(6);
  return entry.costSource === 'provider-reported' ? amount : `${amount} (${tr(entry.costSource === 'estimated' ? 'ops.cost.source.estimated' : 'ops.cost.source.unknown')})`;
}

export interface FeedTabProps {
  mode: 'ledger' | 'simulated';
  locale: Locale;
  agents: Agent[];
  onRetry: () => void;
  // ledger mode
  feed: FeedState;
  feedFilters: FeedFilters;
  onFeedFiltersChange: (filters: FeedFilters) => void;
  onLoadMore: () => void;
  apiBase?: string;
  // simulated mode
  simulatedCalls: SimulatedCall[];
  onEmitSimulated?: () => void;
  isLiveMode?: boolean;
}

export const FeedTab: React.FC<FeedTabProps> = ({
  mode,
  locale,
  agents,
  onRetry,
  feed,
  feedFilters,
  onFeedFiltersChange,
  onLoadMore,
  apiBase,
  simulatedCalls,
  onEmitSimulated,
  isLiveMode = false,
}) => {
  const tr = (key: TranslationKey, params?: MessageParams) => t(locale, key, params);

  if (mode === 'ledger') {
    const models = [...new Set(feed.calls.map((call) => call.model).filter((value): value is string => value !== null))];

    if (feed.query.status === 'loading' || feed.query.status === 'idle') return <UsageEmptyState kind="loading" locale={locale} />;
    if (feed.query.status === 'unavailable') return <UsageEmptyState kind="unavailable" locale={locale} />;
    if (feed.query.status === 'unauthorized') return <UsageEmptyState kind="unauthorized" locale={locale} />;
    if (feed.query.status === 'error') return <UsageEmptyState kind="error" locale={locale} errorMessage={feed.query.message} onRetry={onRetry} />;

    if (feed.calls.length === 0) {
      const filtersActive = feedFilters.status !== 'all' || feedFilters.model !== null || feedFilters.agentId !== null;
      if (filtersActive) {
        return <UsageEmptyState kind="filtered" locale={locale} onClearFilters={() => onFeedFiltersChange({ status: 'all', model: null, agentId: null })} />;
      }
      return <UsageEmptyState kind="empty" locale={locale} apiBase={apiBase} />;
    }

    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h3 className="text-sm font-bold text-white">{tr('ops.feed.ledger.heading')}</h3>
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <label className="flex items-center gap-1.5 text-slate-400">
              {tr('ops.feed.ledger.filter.status')}
              <select
                value={feedFilters.status}
                onChange={(event) => onFeedFiltersChange({ ...feedFilters, status: event.target.value as 'all' | 'failed' })}
                className="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-white font-mono"
              >
                <option value="all">{tr('ops.feed.ledger.filter.statusAll')}</option>
                <option value="failed">{tr('ops.feed.ledger.filter.statusFailed')}</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-slate-400">
              {tr('ops.feed.ledger.filter.model')}
              <select
                value={feedFilters.model ?? ''}
                onChange={(event) => onFeedFiltersChange({ ...feedFilters, model: event.target.value || null })}
                className="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-white font-mono"
              >
                <option value="">{tr('ops.feed.ledger.filter.allModels')}</option>
                {models.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-slate-400">
              {tr('ops.feed.ledger.filter.agent')}
              <select
                value={feedFilters.agentId ?? ''}
                onChange={(event) => onFeedFiltersChange({ ...feedFilters, agentId: event.target.value || null })}
                className="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-white font-mono"
              >
                <option value="">{tr('ops.feed.ledger.filter.allAgents')}</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="space-y-2">
          {feed.calls.map((call) => {
            const style = ledgerProviderStyle(call.provider ?? '');
            const officeAgent = call.agentId ? agents.find((agent) => agent.id === call.agentId) : undefined;
            const title = tr('ops.feed.ledger.detailTitle', { eventId: call.eventId, sessionId: call.sessionId ?? '' });
            return (
              <div
                key={call.eventId}
                title={title}
                className={`p-3 rounded-xl bg-slate-950 border ${call.status === 'ok' ? 'border-slate-800' : 'border-red-900/60'} flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs font-mono`}
              >
                <div className="flex items-center gap-3">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: style.color }} aria-hidden="true" />
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-slate-400 text-[10px]">{new Date(call.receivedAt).toLocaleTimeString(locale)}</span>
                      <span className="font-bold text-white">{call.model ?? tr('ops.value.na')}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${style.badgeBg} ${style.badgeBorder} ${style.accent}`}>
                        {call.provider ?? tr('ops.value.na')}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase ${call.status === 'ok' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-red-500/10 text-red-300'}`}
                      >
                        {call.status}{call.errorCode ? `: ${call.errorCode}` : ''}
                      </span>
                      <span className="text-slate-400 font-sans text-[11px]">
                        {officeAgent?.name ?? call.agentId ?? tr('ops.feed.ledger.unattributed')}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-[11px] self-end sm:self-center shrink-0">
                  <div>
                    <span className="text-slate-400 block text-[9px]">{tr('ops.feed.ledger.col.tokens')}</span>
                    <span className="text-sky-300 font-semibold">{call.tokens.input ?? tr('ops.value.na')}</span>
                    <span className="text-slate-400"> / </span>
                    <span className="text-emerald-300 font-semibold">{call.tokens.output ?? tr('ops.value.na')}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[9px]">{tr('ops.feed.ledger.col.latency')}</span>
                    <span className="text-amber-300 font-semibold">{call.latencyMs === null ? tr('ops.value.na') : `${call.latencyMs}ms`}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block text-[9px]">{tr('ops.feed.ledger.col.cost')}</span>
                    <span className="text-emerald-400 font-bold">{formatCost(call, locale, tr)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {feed.hasMore && (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={feed.loadingMore}
              className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-cyan-300 border border-slate-800 text-xs font-semibold flex items-center gap-2 disabled:opacity-50"
            >
              {feed.loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
              {feed.loadingMore ? tr('ops.feed.ledger.loading') : tr('ops.feed.ledger.loadMore')}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ---- simulated mode: unchanged, this session's simulator bursts only ----
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-white">{tr('ops.feed.simulated.heading')}</h3>
        {!isLiveMode && onEmitSimulated && (
          <button
            type="button"
            onClick={onEmitSimulated}
            className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-cyan-300 border border-cyan-800/60 text-xs font-semibold flex items-center gap-1.5 transition-colors"
          >
            <Play className="w-3.5 h-3.5 fill-current" aria-hidden="true" />
            <span>{tr('ops.feed.emit')}</span>
          </button>
        )}
      </div>

      <div className="space-y-2">
        {simulatedCalls.length === 0 && (
          <p className="text-slate-400 text-[11px] italic p-4 rounded-xl bg-slate-950 border border-slate-800">{tr('ops.feed.simulated.empty')}</p>
        )}
        {simulatedCalls.map((call) => {
          const style = ledgerProviderStyle(call.provider);
          const callAgent = call.agentId ? agents.find((agent) => agent.id === call.agentId) : undefined;
          return (
            <div key={call.id} className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs font-mono">
              <div className="flex items-center gap-3">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: style.color }} aria-hidden="true" />
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-white">{call.model}</span>
                  <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold border ${style.badgeBg} ${style.badgeBorder} ${style.accent}`}>{call.provider}</span>
                  <span className="text-slate-400 font-sans text-[11px]">
                    {tr('ops.feed.by')} <strong className="text-slate-200">{callAgent?.name ?? tr('ops.feed.operator')}</strong>
                  </span>
                  <SimulatedBadge label={tr('ops.badge.simulated')} />
                </div>
              </div>
              <div className="flex items-center gap-4 text-[11px] self-end sm:self-center shrink-0">
                <div>
                  <span className="text-slate-400 block text-[9px]">{tr('ops.feed.col.tokens')}</span>
                  <span className="text-sky-300 font-semibold">{tr('ops.tokens.inValue', { value: call.inputTokens })}</span>
                  <span className="text-slate-400"> / </span>
                  <span className="text-emerald-300 font-semibold">{tr('ops.tokens.outValue', { value: call.outputTokens })}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[9px]">{tr('ops.feed.col.latency')}</span>
                  <span className="text-amber-300 font-semibold">{call.latencyMs === null ? tr('ops.value.unknown') : `${call.latencyMs}ms`}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[9px]">{tr('ops.feed.col.cost')}</span>
                  <span className="text-emerald-400 font-bold">{call.estimatedCost === null ? tr('ops.value.unknown') : `$${call.estimatedCost.toFixed(4)}`}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
