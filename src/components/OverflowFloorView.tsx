import React from 'react';
import { DoorOpen, Users, ArrowDownToLine, LockKeyhole } from 'lucide-react';
import type { Agent, Meeting } from '../types/agent';
import type { Locale } from '../i18n';
import { t, type TranslationKey } from '../i18n';
import { localizeDemoText } from '../content/demoScript';
import type { RoomReservation } from '../engine/livingOfficeEngine';

interface OverflowFloorViewProps {
  locale: Locale;
  reservations: RoomReservation[];
  meetings: Meeting[];
  agents: Agent[];
  onBack: () => void;
  onSelectAgent: (agentId: string) => void;
}

export const OverflowFloorView: React.FC<OverflowFloorViewProps> = ({
  locale,
  reservations,
  meetings,
  agents,
  onBack,
  onSelectAgent,
}) => {
  const floorReservations = reservations.filter((reservation) => reservation.floor === 2);

  return (
    <div className="flex-1 h-full overflow-y-auto bg-slate-950 text-slate-100 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2">
            <LockKeyhole className="w-4 h-4 text-violet-400" aria-hidden="true" />
            <h2 className="text-lg font-bold">{t(locale, 'floor.secret')}</h2>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {t(locale, 'floor.subtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs font-semibold"
        >
          <ArrowDownToLine className="w-4 h-4" aria-hidden="true" />
          {t(locale, 'floor.backMain')}
        </button>
      </div>

      {floorReservations.length === 0 ? (
        <div className="min-h-64 rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 flex flex-col items-center justify-center text-center p-8">
          <DoorOpen className="w-8 h-8 text-slate-400 mb-3" aria-hidden="true" />
          <p className="text-sm font-semibold text-slate-300">{t(locale, 'floor.empty')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {floorReservations.map((reservation) => {
            const meeting = meetings.find((item) => item.id === reservation.meetingId);
            const participants = reservation.participantIds
              .map((id) => agents.find((agent) => agent.id === id))
              .filter((agent): agent is Agent => Boolean(agent));

            return (
              <section
                key={reservation.roomId}
                className="rounded-2xl border border-violet-900/60 bg-slate-900 overflow-hidden"
              >
                <div className="px-4 py-3 border-b border-slate-800 bg-gradient-to-r from-violet-950/70 to-slate-900 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-bold text-violet-200">{reservation.roomLabel}</div>
                    <div className="text-[11px] text-slate-400 font-mono">{reservation.roomId}</div>
                  </div>
                  <span className="px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide bg-emerald-950 text-emerald-300 border border-emerald-900/60">
                    {t(locale, `floor.reservation.${reservation.status}` as TranslationKey)}
                  </span>
                </div>

                <div className="p-4 space-y-4">
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                    <div className="text-xs font-semibold text-slate-200">
                      {meeting?.title ? localizeDemoText(meeting.title, locale) : reservation.meetingId}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      {meeting?.topic ? localizeDemoText(meeting.topic, locale) : t(locale, 'floor.privateTopic')}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    {participants.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => onSelectAgent(agent.id)}
                        className="rounded-xl border border-slate-800 bg-slate-950 hover:border-violet-700 p-3 text-left transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="w-8 h-8 rounded-full border border-slate-700 shrink-0"
                            style={{ background: agent.avatarColor }}
                          />
                          <div className="min-w-0">
                            <div className="text-xs font-bold text-white truncate">{agent.name}</div>
                            <div className="text-[10px] text-slate-400 truncate">{localizeDemoText(agent.roleTitle, locale)}</div>
                          </div>
                        </div>
                        <div className="mt-2 text-[10px] font-mono text-violet-300">
                          {t(locale, `status.${agent.status}` as TranslationKey)}
                        </div>
                        {agent.speechBubble && (
                          <div className="mt-2 text-[11px] text-slate-300 rounded-lg bg-slate-900 border border-slate-800 p-2">
                            {localizeDemoText(agent.speechBubble.text, locale)}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-2 text-[11px] text-slate-400">
                    <Users className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{t(locale, 'floor.agentsUpstairs', { count: participants.length })}</span>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
};
