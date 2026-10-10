/**
 * Presentation-only list of one agent's ledger calls, rendered inside `AgentDetailModal`'s metrics tab (issue
 * #78). Fed by `useAgentCalls`; this component does no fetching and no arithmetic, only formatting (through
 * `formatTokens` / `formatCost` / `formatCostSource` from `../../lib/usage`, the same functions the badges and
 * top-bar total use, so "unknown" always reads the same way across the portal).
 *
 * Never reads the raw `requestId` as trusted-safe free text: a value matching `REDACTION_MARKER_PATTERN` (the
 * server's own `[REDACTED:<rule>]` marker, issue #68) always renders as a distinct "redacted" chip regardless of
 * `maskSecrets`; otherwise `maskSecrets` only shortens the value shown, never hides it from the copy button.
 */
import React, { useMemo, useState } from 'react';
import { t, type Locale, type TranslationKey } from '../../i18n';
import { createOfficeTranslator } from '../../content/officeMessages';
import { formatCost, formatCostSource, formatTokens } from '../../lib/usage';
import { REDACTION_MARKER_PATTERN } from '../../integrations/redaction';
import type { CallRecord } from '../../integrations/ledgerClient';
import type { QueryState } from '../modelOps/useModelOpsLedger';
import { AlertCircle, Check, Copy, Loader2, Lock, ServerCrash } from 'lucide-react';

type MessageParams = Record<string, string | number>;

export interface AgentCallsTableProps {
  query: QueryState<null>;
  calls: CallRecord[];
  hasMore: boolean;
  atCap: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void;
  onRetry: () => void;
  maskSecrets: boolean;
  windowLabel: string;
  locale: Locale;
}

const RequestIdCell: React.FC<{ requestId: string | null; maskSecrets: boolean; tr: (key: TranslationKey, params?: MessageParams) => string }> = ({
  requestId,
  maskSecrets,
  tr,
}) => {
  const [copied, setCopied] = useState(false);

  if (requestId === null) {
    return <span className="text-slate-500">{tr('agentDetail.calls.unknown')}</span>;
  }

  if (REDACTION_MARKER_PATTERN.test(requestId)) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[10px] font-semibold uppercase">
        <Lock className="w-3 h-3" aria-hidden="true" />
        {tr('agentDetail.calls.redacted')}
      </span>
    );
  }

  const display = maskSecrets && requestId.length > 10 ? `${requestId.slice(0, 10)}…` : requestId;

  const handleCopy = () => {
    void navigator.clipboard.writeText(requestId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={tr(copied ? 'agentDetail.calls.requestIdCopied' : 'agentDetail.calls.copyRequestId')}
      aria-label={tr(copied ? 'agentDetail.calls.requestIdCopied' : 'agentDetail.calls.copyRequestId')}
      className="inline-flex items-center gap-1 text-slate-300 hover:text-sky-300 font-mono transition-colors"
    >
      <span className="truncate max-w-[9rem]">{display}</span>
      {copied ? <Check className="w-3 h-3 text-emerald-400 shrink-0" aria-hidden="true" /> : <Copy className="w-3 h-3 shrink-0" aria-hidden="true" />}
    </button>
  );
};

export const AgentCallsTable: React.FC<AgentCallsTableProps> = ({
  query,
  calls,
  hasMore,
  atCap,
  loadingMore,
  loadMoreError,
  onLoadMore,
  onRetry,
  maskSecrets,
  windowLabel,
  locale,
}) => {
  const tr = (key: TranslationKey, params?: MessageParams) => t(locale, key, params);
  const officeTranslate = useMemo(() => createOfficeTranslator({ locale }), [locale]);
  const intlLocale = locale === 'es' ? 'es-ES' : 'en-US';

  if (query.status === 'idle' || query.status === 'loading') {
    return (
      <div role="status" aria-busy="true" className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
        <div className="flex items-center gap-2 text-slate-400 text-[11px]">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" aria-hidden="true" />
          <span>{tr('agentDetail.calls.loading')}</span>
        </div>
        <div className="h-3 w-2/3 bg-slate-800 rounded animate-pulse" />
        <div className="h-3 w-1/2 bg-slate-800 rounded animate-pulse" />
      </div>
    );
  }

  if (query.status === 'unavailable') {
    return (
      <div role="status" className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 flex items-start gap-2 text-xs">
        <ServerCrash className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
        <span>{tr('agentDetail.calls.unavailable')}</span>
      </div>
    );
  }

  if (query.status === 'unauthorized') {
    return (
      <div role="status" className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-300 flex items-start gap-2 text-xs">
        <Lock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
        <span>{tr('agentDetail.calls.unauthorized')}</span>
      </div>
    );
  }

  if (query.status === 'error') {
    return (
      <div role="status" className="p-4 rounded-xl bg-slate-950 border border-red-900/60 text-slate-300 space-y-2 text-xs">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            {tr('agentDetail.calls.error')}
            {query.message ? `: ${query.message}` : ''}
          </span>
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium border border-slate-700/60 transition-colors"
        >
          {tr('agentDetail.calls.retry')}
        </button>
      </div>
    );
  }

  if (calls.length === 0) {
    return (
      <div role="status" className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-slate-400 text-center text-xs">
        {tr('agentDetail.calls.empty')}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h4 className="text-sm font-bold text-white">{tr('agentDetail.calls.heading', { window: windowLabel })}</h4>
        <span className="text-[11px] text-slate-400">{tr('agentDetail.calls.showingLoaded', { count: calls.length })}</span>
      </div>

      <div className="space-y-2">
        {calls.map((call) => {
          const failed = call.status !== 'ok';
          return (
            <div
              key={call.eventId}
              title={tr('agentDetail.calls.receivedAt', { time: new Date(call.receivedAt).toLocaleString(intlLocale) })}
              className={`p-3 rounded-xl bg-slate-950 border ${failed ? 'border-red-900/60' : 'border-slate-800'} space-y-2 text-[11px] font-mono`}
            >
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-slate-400">{new Date(call.occurredAt).toLocaleTimeString(intlLocale)}</span>
                  <span className="font-bold text-white font-sans">{call.model ?? tr('agentDetail.calls.unknown')}</span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase ${failed ? 'bg-red-500/10 text-red-300' : 'bg-emerald-500/10 text-emerald-300'}`}
                  >
                    {call.status}
                    {call.errorCode ? `: ${call.errorCode}` : ''}
                  </span>
                </div>
                <RequestIdCell requestId={call.requestId} maskSecrets={maskSecrets} tr={tr} />
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 text-[10px]">
                <div>
                  <span className="text-slate-500 block">{tr('agentDetail.calls.col.input')}</span>
                  <span className="text-sky-300 font-semibold">{formatTokens(call.tokens.input, locale, officeTranslate)}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">{tr('agentDetail.calls.col.output')}</span>
                  <span className="text-emerald-300 font-semibold">{formatTokens(call.tokens.output, locale, officeTranslate)}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">{tr('agentDetail.calls.col.cacheRead')}</span>
                  <span className="text-slate-300 font-semibold">{formatTokens(call.tokens.cacheRead, locale, officeTranslate)}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">{tr('agentDetail.calls.col.cacheWrite')}</span>
                  <span className="text-slate-300 font-semibold">{formatTokens(call.tokens.cacheWrite, locale, officeTranslate)}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">{tr('agentDetail.calls.col.reasoning')}</span>
                  <span className="text-purple-300 font-semibold">{formatTokens(call.tokens.reasoning, locale, officeTranslate)}</span>
                </div>
                <div>
                  <span className="text-slate-500 block">{tr('agentDetail.calls.col.latency')}</span>
                  <span className="text-amber-300 font-semibold">
                    {call.latencyMs === null ? tr('agentDetail.calls.unknown') : `${call.latencyMs}ms`}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">{tr('agentDetail.calls.col.cost')}</span>
                  <span className="text-emerald-400 font-bold">
                    {formatCost(call.cost, call.currency, locale, officeTranslate)}
                    {call.cost !== null && call.costSource !== 'provider-reported' ? (
                      <span className="ml-1 text-[9px] font-normal text-amber-300">
                        ({formatCostSource(call.costSource, officeTranslate)})
                      </span>
                    ) : null}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {loadMoreError && (
        <div role="status" className="p-3 rounded-xl bg-slate-950 border border-red-900/60 text-slate-300 text-xs flex items-center justify-between gap-3">
          <span>{loadMoreError}</span>
          <button
            type="button"
            onClick={onLoadMore}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-medium border border-slate-700/60 transition-colors shrink-0"
          >
            {tr('agentDetail.calls.retry')}
          </button>
        </div>
      )}

      {hasMore && !loadMoreError && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-cyan-300 border border-slate-800 text-xs font-semibold flex items-center gap-2 disabled:opacity-50"
          >
            {loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
            {loadingMore ? tr('agentDetail.calls.loadingMore') : tr('agentDetail.calls.loadMore')}
          </button>
        </div>
      )}

      {atCap && (
        <p className="text-[11px] text-slate-500 text-center">{tr('agentDetail.calls.cap')}</p>
      )}
    </div>
  );
};
