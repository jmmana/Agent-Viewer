import React from 'react';
import { Meeting, Agent, ViewerEvent } from '../types/agent';
import type { Locale } from '../i18n';
import { t, type TranslationKey } from '../i18n';
import { localizeDemoText } from '../content/demoScript';
import {
  Users,
  Sparkles,
  Clock,
  CheckCircle2,
  MessageSquare,
  FileCheck,
  Zap,
} from 'lucide-react';
import type { LedgerConnection } from './modelOps/useModelOpsLedger';
import { useMeetingUsage } from './usage/useMeetingUsage';
import { appTranslate, meetingGroupTitle, spendRows, unknownSpendRows } from './usage/spendFormat';
import type { RollupGroup } from '../integrations/ledgerClient';

interface MeetingRoomModalProps {
  meetings: Meeting[];
  activeMeetingId: string | null;
  agents: Agent[];
  onSelectAgent: (agentId: string) => void;
  locale: Locale;
  events: ViewerEvent[];
  /** `null` means demo mode: the panel falls back to the simulated `tokensAccumulated`/`costAccumulated`. */
  ledger: LedgerConnection | null;
}

/** A meeting the table shows: either one of the portal's own meetings, or a server-only group with no portal
 * counterpart (never hidden), or the single `unattributed` bucket, last. */
interface SpendTableRow {
  key: string;
  title: string;
  startedAt: number | null;
  group: RollupGroup | undefined;
  unattributed?: boolean;
}

export const MeetingRoomModal: React.FC<MeetingRoomModalProps> = ({
  meetings,
  activeMeetingId,
  agents,
  onSelectAgent,
  locale,
  events,
  ledger,
}) => {
  const getAgentName = (id: string) => {
    const a = agents.find((ag) => ag.id === id);
    return a ? a.name : id;
  };

  const activeMeeting = meetings.find((m) => m.id === activeMeetingId) || meetings[0];
  const usage = useMeetingUsage({ ledger, isOpen: true, events });
  const translate = appTranslate(locale);

  const activeGroup = usage.status === 'ready'
    ? usage.data.groups.find((group) => group.key.meetingId === activeMeeting?.id)
    : undefined;
  const unattributedGroup = usage.status === 'ready'
    ? usage.data.groups.find((group) => group.attribution?.meeting === 'unattributed')
    : undefined;

  const spendTableRows: SpendTableRow[] = (() => {
    if (usage.status !== 'ready') return [];
    const byMeetingId = new Map(usage.data.groups.map((group) => [group.key.meetingId, group]));
    const portalIds = new Set(meetings.map((meeting) => meeting.id));
    const rows: SpendTableRow[] = meetings
      .slice()
      .sort((a, b) => {
        if (a.startedAt === 0 && b.startedAt !== 0) return 1;
        if (b.startedAt === 0 && a.startedAt !== 0) return -1;
        return b.startedAt - a.startedAt;
      })
      .map((meeting) => ({
        key: meeting.id,
        title: localizeDemoText(meeting.title, locale) || meeting.id,
        startedAt: meeting.startedAt,
        group: byMeetingId.get(meeting.id),
      }));
    for (const group of usage.data.groups) {
      const meetingId = group.key.meetingId;
      if (meetingId === null || portalIds.has(meetingId)) continue;
      rows.push({ key: meetingId, title: meetingGroupTitle(group) ?? meetingId, startedAt: null, group });
    }
    if (unattributedGroup) {
      rows.push({
        key: '__unattributed__',
        title: t(locale, 'meetings.spend.unattributedRow'),
        startedAt: null,
        group: unattributedGroup,
        unattributed: true,
      });
    }
    return rows;
  })();

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 text-slate-100 overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-white font-sans">{t(locale, 'meetings.title')}</h2>
            {activeMeeting && activeMeeting.status === 'ACTIVE' && (
              <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-950/80 text-emerald-400 border border-emerald-800/80 uppercase font-mono animate-pulse">
                {t(locale, 'meetings.live')}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400">
            {t(locale, 'meetings.subtitle')}
          </p>
        </div>
      </div>

      {!activeMeeting ? (
        <div className="text-center py-20 bg-slate-900/40 rounded-xl border border-slate-800 text-xs text-slate-400">
          {t(locale, 'meetings.empty')}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left 2 Cols: Meeting Topic, Discussion, Decisions */}
          <div className="lg:col-span-2 space-y-5">
            <div className="bg-slate-900 p-5 rounded-xl border border-slate-800 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-sky-400 font-semibold bg-sky-950/60 px-2 py-0.5 rounded border border-sky-800/40">
                  {activeMeeting.id}
                </span>
                <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
                  <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>
                    {t(locale, 'meetings.startedAt', { time: new Date(activeMeeting.startedAt).toLocaleTimeString(locale) })}
                  </span>
                </div>
              </div>

              <h3 className="text-base font-bold text-white">{localizeDemoText(activeMeeting.title, locale)}</h3>
              <p className="text-xs text-slate-300 leading-relaxed bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                {localizeDemoText(activeMeeting.topic, locale)}
              </p>

              {/* Agenda Items */}
              <div className="space-y-1.5 pt-2">
                <span className="text-[11px] font-semibold uppercase text-slate-400 tracking-wide block">
                  {t(locale, 'meetings.agenda')}
                </span>
                <div className="flex flex-wrap gap-2">
                  {activeMeeting.agenda.map((ag, i) => (
                    <span
                      key={i}
                      className="px-2.5 py-1 rounded bg-slate-950 border border-slate-800 text-xs text-slate-300 font-medium"
                    >
                      {t(locale, 'meetings.agendaItem', { index: i + 1, item: localizeDemoText(ag, locale) })}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Live Transcript / Dialogue */}
            <div className="bg-slate-900 p-5 rounded-xl border border-slate-800 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wide flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-sky-400" aria-hidden="true" />
                  {t(locale, 'meetings.transcript')}
                </h4>
                <span className="text-xs text-slate-400 font-mono">
                  {t(locale, 'meetings.exchanges', { count: activeMeeting.messages.length })}
                </span>
              </div>

              <div className="space-y-3">
                {activeMeeting.messages.map((msg) => {
                  const isDecision = msg.type === 'decision';
                  const isProposal = msg.type === 'proposal';

                  return (
                    <div
                      key={msg.id}
                      className={`p-3 rounded-lg border text-xs space-y-1.5 ${
                        isDecision
                          ? 'bg-emerald-950/40 border-emerald-800/60'
                          : isProposal
                          ? 'bg-indigo-950/40 border-indigo-800/60'
                          : 'bg-slate-950 border-slate-800'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => onSelectAgent(msg.senderId)}
                          className="font-bold text-sky-400 hover:underline"
                        >
                          {getAgentName(msg.senderId)}
                        </button>
                        <span className="text-[10px] font-mono uppercase text-slate-400">
                          {t(locale, `kind.${msg.type}` as TranslationKey)}
                        </span>
                      </div>
                      <p className="text-slate-200 leading-relaxed font-sans">{msg.text}</p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Decisions Reached */}
            {activeMeeting.decisions.length > 0 && (
              <div className="bg-slate-900 p-5 rounded-xl border border-slate-800 space-y-3">
                <h4 className="text-xs font-bold text-emerald-400 uppercase tracking-wide flex items-center gap-2">
                  <FileCheck className="w-4 h-4" aria-hidden="true" />
                  {t(locale, 'meetings.decisions')}
                </h4>
                <div className="space-y-2">
                  {activeMeeting.decisions.map((dec, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2.5 p-2.5 rounded-lg bg-slate-950 border border-emerald-900/40 text-xs text-slate-200"
                    >
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
                      <span>{localizeDemoText(dec, locale)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right Col: Telemetry & Attendees */}
          <div className="space-y-5">
            {/* Meeting Telemetry */}
            <div className="bg-slate-900 p-5 rounded-xl border border-slate-800 space-y-3 font-mono tabular-nums">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wide">
                  {t(locale, 'meetings.telemetry')}
                </h4>
                {!ledger && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-950/60 text-amber-400 border border-amber-800/60 uppercase">
                    {t(locale, 'meetings.spend.simulated')}
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {!ledger ? (
                  <>
                    <div className="flex justify-between text-xs py-1 border-b border-slate-800">
                      <span className="text-slate-400">{t(locale, 'meetings.tokens')}</span>
                      <span className="font-bold text-sky-400">
                        {activeMeeting.tokensAccumulated.toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs py-1 border-b border-slate-800">
                      <span className="text-slate-400">{t(locale, 'meetings.cost')}</span>
                      <span className="font-bold text-emerald-400">
                        ${activeMeeting.costAccumulated.toFixed(3)}
                      </span>
                    </div>
                  </>
                ) : usage.status === 'loading' || usage.status === 'idle' ? (
                  <p className="text-xs text-slate-400 py-1">{t(locale, 'meetings.spend.loading')}</p>
                ) : usage.status === 'ready' ? (
                  (activeGroup ? spendRows(activeGroup, locale, translate) : unknownSpendRows(locale)).map((row) => (
                    <div key={row.key} className="flex justify-between text-xs py-1 border-b border-slate-800 last:border-b-0">
                      <span className="text-slate-400">{row.label}</span>
                      <span className="font-bold text-sky-300">{row.value}</span>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-slate-400 py-1">{t(locale, 'meetings.spend.unavailable')}</p>
                )}
                <div className="flex justify-between text-xs py-1">
                  <span className="text-slate-400">{t(locale, 'meetings.tasksSpawned')}</span>
                  <span className="font-bold text-indigo-400">
                    {activeMeeting.tasksCreated.length}
                  </span>
                </div>
                {ledger && usage.status === 'ready' && (
                  <p className="text-[10px] text-slate-500 pt-1">
                    {t(locale, 'meetings.spend.asOf', { time: new Date(usage.data.asOf.generatedAt).toLocaleTimeString(locale) })}
                    {!usage.data.coverage.complete ? ` · ${t(locale, 'meetings.spend.incomplete')}` : ''}
                  </p>
                )}
              </div>
            </div>

            {/* Spend per meeting (issue #81): lists every portal meeting plus any server-only row, never changes
                the active meeting, no totals row. Ledger mode only: demo figures are per-meeting only. */}
            {ledger && usage.status === 'ready' && spendTableRows.length > 0 && (
              <div className="bg-slate-900 p-5 rounded-xl border border-slate-800 space-y-3">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wide">
                  {t(locale, 'meetings.spend.table')}
                </h4>
                <table className="w-full text-xs font-mono tabular-nums">
                  <thead>
                    <tr className="text-left text-slate-500 text-[10px] uppercase">
                      <th scope="col" className="font-semibold pb-1">{t(locale, 'meetings.spend.tableTitle')}</th>
                      <th scope="col" className="font-semibold pb-1 text-right">{t(locale, 'meetings.spend.tableTokens')}</th>
                      <th scope="col" className="font-semibold pb-1 text-right">{t(locale, 'meetings.spend.tableCost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spendTableRows.map((row) => {
                      const rows = row.group ? spendRows(row.group, locale, translate) : unknownSpendRows(locale);
                      const tokens = rows.find((item) => item.key === 'tokens.input')?.value ?? t(locale, 'usage.unknown');
                      const cost = rows.find((item) => item.key.startsWith('cost'))?.value ?? t(locale, 'usage.unknown');
                      return (
                        <tr key={row.key} className={`border-t border-slate-800 ${row.unattributed ? 'text-amber-300' : 'text-slate-200'}`}>
                          <td className="py-1 truncate max-w-[9rem]">{row.title}</td>
                          <td className="py-1 text-right">{tokens}</td>
                          <td className="py-1 text-right">{cost}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Seated Attendees */}
            <div className="bg-slate-900 p-5 rounded-xl border border-slate-800 space-y-3">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wide flex items-center gap-2">
                <Users className="w-4 h-4 text-indigo-400" aria-hidden="true" />
                {t(locale, 'meetings.attendees', { count: activeMeeting.participants.length })}
              </h4>
              <div className="space-y-2">
                {activeMeeting.participants.map((pid) => {
                  const ag = agents.find((a) => a.id === pid);
                  return (
                    <button
                      type="button"
                      key={pid}
                      onClick={() => onSelectAgent(pid)}
                      className="w-full flex items-center justify-between p-2.5 rounded-lg bg-slate-950 border border-slate-800 hover:border-slate-700 text-left transition-colors"
                    >
                      <div>
                        <span className="font-semibold text-xs text-white block">
                          {getAgentName(pid)}
                        </span>
                        <span className="text-[11px] text-slate-400">
                          {ag?.roleTitle ? localizeDemoText(ag.roleTitle, locale) : t(locale, 'meetings.participant')}
                        </span>
                      </div>
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
