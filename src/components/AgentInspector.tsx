import React, { useId, useMemo, useState } from 'react';
import { Agent, AgentStatus, ViewerEvent } from '../types/agent';
import { t, type Locale, type TranslationKey } from '../i18n';
import { localizeDemoText } from '../content/demoScript';
import type { LedgerConnection } from './modelOps/useModelOpsLedger';
import { ToolSpendTooltip } from './usage/ToolSpendTooltip';
import { createOfficeTranslator } from '../content/officeMessages';
import { formatCost, formatTokens, type UsageFigures } from '../lib/usage';
import {
  X,
  Send,
  Zap,
  Cpu,
  Clock,
  Terminal,
  MessageSquare,
  AlertTriangle,
  CheckCircle,
  Eye,
  CornerDownRight,
  Maximize2,
  List,
} from 'lucide-react';

interface AgentInspectorProps {
  agent: Agent;
  onClose: () => void;
  onFocusAgent: (agent: Agent) => void;
  onSendMessage: (agentId: string, message: string) => void;
  onUpdateStatus: (agentId: string, status: AgentStatus) => void;
  onOpenDetailModal?: (agentId: string, tab?: 'overview' | 'tasks' | 'metrics' | 'logs' | 'console') => void;
  events: ViewerEvent[];
  locale: Locale;
  /** `null` in demo mode: the tool chip's spend tooltip then renders nothing extra. */
  ledger: LedgerConnection | null;
  /** This agent's row from the usage ledger rollup (issue #78), `undefined` when the ledger has no row for it
   * (it recorded no calls in the current window). Read only while `ledgerReady` is `true`. */
  usageFigures?: UsageFigures;
  /** `true` once the ledger has ever answered: the telemetry block then reads `usageFigures` instead of this
   * agent's local accumulators, which keeps reading as today while the ledger is unavailable. */
  ledgerReady?: boolean;
  /** `true` when the last ledger refetch failed but earlier figures are kept: the telemetry block is then shown
   * dimmed with a note, instead of looking identical to a confirmed-fresh reading. */
  isStale?: boolean;
}

/** Statuses the operator can set from the inspector select (option values stay raw). */
const SETTABLE_STATUSES: AgentStatus[] = ['IDLE', 'CODING', 'TESTING', 'BLOCKED', 'DONE'];

export const AgentInspector: React.FC<AgentInspectorProps> = ({
  agent,
  onClose,
  onFocusAgent,
  onSendMessage,
  onUpdateStatus,
  onOpenDetailModal,
  events,
  locale,
  ledger,
  usageFigures,
  ledgerReady = false,
  isStale = false,
}) => {
  const [instructionText, setInstructionText] = useState('');
  const statusSelectId = useId();
  const instructionId = useId();
  const intlLocale = locale === 'es' ? 'es-ES' : 'en-US';
  const officeTranslate = useMemo(() => createOfficeTranslator({ locale }), [locale]);
  const statusLabel = (status: AgentStatus) => t(locale, `status.${status}` as TranslationKey);
  const firstName = agent.name.split(' ')[0];

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!instructionText.trim()) return;
    onSendMessage(agent.id, instructionText.trim());
    setInstructionText('');
  };

  const agentEvents = events.filter(
    (ev) => ev.source === agent.id || ev.target === agent.id
  ).slice(0, 10);

  const totalTokens = agent.tokensInput + agent.tokensOutput;
  const sessionMinutes = Math.floor((Date.now() - agent.startedAt) / 60000);

  return (
    <aside
      aria-label={t(locale, 'inspector.label', { name: agent.name })}
      className="w-96 h-full bg-slate-900 border-l border-slate-800 flex flex-col z-20 shrink-0 text-slate-100 shadow-2xl overflow-hidden animate-in slide-in-from-right duration-200">
      {/* Inspector Header */}
      <div
        onDoubleClick={() => onOpenDetailModal && onOpenDetailModal(agent.id)}
        title={t(locale, 'inspector.headerTitle')}
        className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/60 cursor-pointer select-none"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            aria-hidden="true"
            className="w-10 h-10 rounded-xl flex items-center justify-center font-bold text-white shadow-md relative shrink-0"
            style={{ backgroundColor: agent.clothingColor }}
          >
            <span className="text-sm font-sans">{agent.name.charAt(0)}</span>
            <span className="absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full border-2 border-slate-900 bg-emerald-500" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-white leading-tight truncate hover:text-sky-300 transition-colors">
              {agent.name}
            </h2>
            <p className="text-xs text-slate-400 font-medium truncate">{localizeDemoText(agent.roleTitle, locale)}</p>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {onOpenDetailModal && (
            <button
              type="button"
              onClick={() => onOpenDetailModal(agent.id)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-sky-300 hover:bg-slate-800 transition-colors"
              title={t(locale, 'inspector.openDetail')}
              aria-label={t(locale, 'inspector.openDetail')}
            >
              <Maximize2 className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            title={t(locale, 'inspector.close')}
            aria-label={t(locale, 'inspector.close')}
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Main Inspector Scroll Area */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
        {/* Status & Current Focus */}
        <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-slate-400 font-medium">{t(locale, 'inspector.currentStatus')}</span>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" aria-hidden="true" />
              <span className="font-semibold text-sky-400 uppercase tracking-wide">
                {statusLabel(agent.status)}
              </span>
            </div>
          </div>

          <p className="text-slate-300 bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80 leading-relaxed">
            {agent.statusText
              ? localizeDemoText(agent.statusText, locale)
              : t(locale, 'agentPanels.stationedFallback')}
          </p>

          {agent.currentTool && (
            <ToolSpendTooltip tool={agent.currentTool} agentId={agent.id} ledger={ledger} locale={locale}>
              <div className="flex items-center gap-2 text-indigo-300 bg-indigo-950/40 p-2 rounded border border-indigo-800/40 font-mono text-[11px]">
                <Terminal className="w-3.5 h-3.5 shrink-0 text-indigo-400" aria-hidden="true" />
                <span className="truncate">{agent.currentTool}</span>
              </div>
            </ToolSpendTooltip>
          )}
        </div>

        {/* AI Model & Provider Details */}
        <div className="space-y-2">
          <h3 className="text-slate-400 font-medium">{t(locale, 'inspector.modelConfig')}</h3>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-400 block">{t(locale, 'inspector.provider')}</span>
              <span className="font-semibold text-slate-200">{agent.provider}</span>
            </div>
            <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-400 block">{t(locale, 'inspector.engineModel')}</span>
              <span className="font-semibold text-slate-200 truncate block font-mono text-[11px]">
                {agent.model}
              </span>
            </div>
          </div>
        </div>

        {/* Token Observability & Cost Metrics (Tabular numerals) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-slate-400 font-medium flex items-center gap-1.5">
              {t(locale, 'inspector.telemetry')}
              {ledgerReady && isStale && (
                <span title={t(locale, 'inspector.stale')}>
                  <Clock className="w-3 h-3 text-amber-400" aria-hidden="true" />
                </span>
              )}
            </h3>
            <span className="text-slate-400 font-mono text-[11px] tabular-nums flex items-center gap-1">
              <Clock className="w-3 h-3" aria-hidden="true" /> {t(locale, 'inspector.activeMinutes', { minutes: sessionMinutes })}
            </span>
          </div>

          {ledgerReady && !usageFigures ? (
            <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 text-slate-400 text-center">
              {t(locale, 'inspector.noCallsInWindow')}
            </div>
          ) : (
            <div
              className={`bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2.5 ${ledgerReady && isStale ? 'opacity-60' : ''}`}
              title={ledgerReady && isStale ? t(locale, 'inspector.stale') : undefined}
            >
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="p-2 rounded bg-slate-900 border border-slate-800/80">
                  <span className="text-[10px] text-slate-400 block">{t(locale, 'inspector.totalTokens')}</span>
                  <span className="text-base font-bold text-sky-400 font-mono tabular-nums">
                    {ledgerReady
                      ? formatTokens(usageFigures?.totalTokens, intlLocale, officeTranslate)
                      : totalTokens.toLocaleString(intlLocale)}
                  </span>
                </div>
                <div className="p-2 rounded bg-slate-900 border border-slate-800/80">
                  <span className="text-[10px] text-slate-400 block">{t(locale, 'inspector.estimatedCost')}</span>
                  <span className="text-base font-bold text-emerald-400 font-mono tabular-nums">
                    {ledgerReady
                      ? formatCost(usageFigures?.cost, usageFigures?.currency, intlLocale, officeTranslate)
                      : `$${agent.cost.toFixed(3)}`}
                  </span>
                </div>
              </div>

              <div className="space-y-1.5 pt-1 text-[11px] text-slate-400 font-mono tabular-nums">
                <div className="flex justify-between">
                  <span>{t(locale, 'inspector.inputTokens')}</span>
                  <span className="text-slate-200">
                    {ledgerReady
                      ? formatTokens(usageFigures?.inputTokens, intlLocale, officeTranslate)
                      : agent.tokensInput.toLocaleString(intlLocale)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>{t(locale, 'inspector.outputTokens')}</span>
                  <span className="text-slate-200">
                    {ledgerReady
                      ? formatTokens(usageFigures?.outputTokens, intlLocale, officeTranslate)
                      : agent.tokensOutput.toLocaleString(intlLocale)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>{t(locale, 'inspector.cachedTokens')}</span>
                  <span className="text-slate-400">
                    {ledgerReady
                      ? formatTokens(usageFigures?.cacheReadTokens, intlLocale, officeTranslate)
                      : agent.cachedTokens.toLocaleString(intlLocale)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>{t(locale, 'inspector.reasoningTokens')}</span>
                  <span className="text-purple-300">
                    {ledgerReady
                      ? formatTokens(usageFigures?.reasoningTokens, intlLocale, officeTranslate)
                      : agent.reasoningTokens.toLocaleString(intlLocale)}
                  </span>
                </div>
              </div>
            </div>
          )}

          {onOpenDetailModal && (
            <button
              type="button"
              onClick={() => onOpenDetailModal(agent.id, 'metrics')}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition-colors"
            >
              <List className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              <span>{t(locale, 'inspector.viewCalls')}</span>
            </button>
          )}
        </div>

        {/* Operator Controls (PRD Section 85) */}
        <div className="space-y-2">
          <h3 className="text-slate-400 font-medium">{t(locale, 'inspector.operatorControls')}</h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onFocusAgent(agent)}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition-colors"
            >
              <Eye className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              <span>{t(locale, 'inspector.focusCamera')}</span>
            </button>

            <label htmlFor={statusSelectId} className="sr-only">
              {t(locale, 'inspector.statusSelect')}
            </label>
            <select
              id={statusSelectId}
              value={agent.status}
              onChange={(e) => onUpdateStatus(agent.id, e.target.value as AgentStatus)}
              className="py-2 px-2.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs font-medium focus:outline-none"
            >
              {SETTABLE_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {t(locale, 'inspector.setStatus', { status: statusLabel(st) })}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Recent Events for this Agent */}
        <div className="space-y-2">
          <h3 className="text-slate-400 font-medium">{t(locale, 'inspector.recentActivity')}</h3>
          <div className="space-y-1.5">
            {agentEvents.length === 0 ? (
              <p className="text-slate-400 italic p-2">{t(locale, 'inspector.noEvents')}</p>
            ) : (
              agentEvents.map((ev) => (
                <div
                  key={ev.id}
                  className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/80 text-[11px] space-y-1"
                >
                  <div className="flex items-center justify-between text-slate-400 font-mono text-[10px]">
                    <span className="uppercase">{ev.type}</span>
                    <span>{new Date(ev.timestamp).toLocaleTimeString(intlLocale)}</span>
                  </div>
                  <p className="text-slate-300 font-sans leading-relaxed">{localizeDemoText(ev.summary, locale)}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Send Direct Instruction Form */}
      <form onSubmit={handleSend} className="p-3 border-t border-slate-800 bg-slate-950">
        <div className="flex items-center gap-2">
          <label htmlFor={instructionId} className="sr-only">
            {t(locale, 'inspector.instructionLabel', { name: agent.name })}
          </label>
          <input
            id={instructionId}
            type="text"
            placeholder={t(locale, 'inspector.instructionPlaceholder', { name: firstName })}
            value={instructionText}
            onChange={(e) => setInstructionText(e.target.value)}
            className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-sky-500"
          />
          <button
            type="submit"
            disabled={!instructionText.trim()}
            aria-label={t(locale, 'inspector.send')}
            title={t(locale, 'inspector.send')}
            className="p-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:pointer-events-none text-white rounded-lg transition-colors"
          >
            <Send className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      </form>
    </aside>
  );
};
