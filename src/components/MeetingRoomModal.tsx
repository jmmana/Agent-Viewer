import React from 'react';
import { Meeting, Agent } from '../types/agent';
import {
  Users,
  Sparkles,
  Clock,
  CheckCircle2,
  MessageSquare,
  FileCheck,
  Zap,
} from 'lucide-react';

interface MeetingRoomModalProps {
  meetings: Meeting[];
  activeMeetingId: string | null;
  agents: Agent[];
  onSelectAgent: (agentId: string) => void;
}

export const MeetingRoomModal: React.FC<MeetingRoomModalProps> = ({
  meetings,
  activeMeetingId,
  agents,
  onSelectAgent,
}) => {
  const getAgentName = (id: string) => {
    const a = agents.find((ag) => ag.id === id);
    return a ? a.name : id;
  };

  const activeMeeting = meetings.find((m) => m.id === activeMeetingId) || meetings[0];

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 text-slate-100 overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-white font-sans">Conference Room & Collaboration</h2>
            {activeMeeting && activeMeeting.status === 'ACTIVE' && (
              <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-950/80 text-emerald-400 border border-emerald-800/80 uppercase font-mono animate-pulse">
                Live In Session
              </span>
            )}
          </div>
          <p className="text-xs text-slate-400">
            Multi-agent deliberation, architectural alignment, consensus building, and decisions.
          </p>
        </div>
      </div>

      {!activeMeeting ? (
        <div className="text-center py-20 bg-slate-900/40 rounded-xl border border-slate-800 text-xs text-slate-500">
          No meeting in progress. Start the demo sequence to see agents convene in the Conference Room.
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
                  <Clock className="w-3.5 h-3.5" />
                  <span>
                    Started {new Date(activeMeeting.startedAt).toLocaleTimeString()}
                  </span>
                </div>
              </div>

              <h3 className="text-base font-bold text-white">{activeMeeting.title}</h3>
              <p className="text-xs text-slate-300 leading-relaxed bg-slate-950 p-3 rounded-lg border border-slate-800/80">
                {activeMeeting.topic}
              </p>

              {/* Agenda Items */}
              <div className="space-y-1.5 pt-2">
                <span className="text-[11px] font-semibold uppercase text-slate-400 tracking-wide block">
                  Agenda Items
                </span>
                <div className="flex flex-wrap gap-2">
                  {activeMeeting.agenda.map((ag, i) => (
                    <span
                      key={i}
                      className="px-2.5 py-1 rounded bg-slate-950 border border-slate-800 text-xs text-slate-300 font-medium"
                    >
                      {i + 1}. {ag}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Live Transcript / Dialogue */}
            <div className="bg-slate-900 p-5 rounded-xl border border-slate-800 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wide flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-sky-400" />
                  Deliberation Transcript
                </h4>
                <span className="text-xs text-slate-500 font-mono">
                  {activeMeeting.messages.length} exchanges
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
                          onClick={() => onSelectAgent(msg.senderId)}
                          className="font-bold text-sky-400 hover:underline"
                        >
                          {getAgentName(msg.senderId)}
                        </button>
                        <span className="text-[10px] font-mono uppercase text-slate-500">
                          {msg.type}
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
                  <FileCheck className="w-4 h-4" />
                  Consensus & Decisions Recorded
                </h4>
                <div className="space-y-2">
                  {activeMeeting.decisions.map((dec, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2.5 p-2.5 rounded-lg bg-slate-950 border border-emerald-900/40 text-xs text-slate-200"
                    >
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      <span>{dec}</span>
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
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wide">
                Meeting Telemetry
              </h4>
              <div className="space-y-2">
                <div className="flex justify-between text-xs py-1 border-b border-slate-800">
                  <span className="text-slate-400">Tokens Burned</span>
                  <span className="font-bold text-sky-400">
                    {activeMeeting.tokensAccumulated.toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between text-xs py-1 border-b border-slate-800">
                  <span className="text-slate-400">Session Cost</span>
                  <span className="font-bold text-emerald-400">
                    ${activeMeeting.costAccumulated.toFixed(3)}
                  </span>
                </div>
                <div className="flex justify-between text-xs py-1">
                  <span className="text-slate-400">Tasks Spawned</span>
                  <span className="font-bold text-indigo-400">
                    {activeMeeting.tasksCreated.length}
                  </span>
                </div>
              </div>
            </div>

            {/* Seated Attendees */}
            <div className="bg-slate-900 p-5 rounded-xl border border-slate-800 space-y-3">
              <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wide flex items-center gap-2">
                <Users className="w-4 h-4 text-indigo-400" />
                Seated Attendees ({activeMeeting.participants.length})
              </h4>
              <div className="space-y-2">
                {activeMeeting.participants.map((pid) => {
                  const ag = agents.find((a) => a.id === pid);
                  return (
                    <button
                      key={pid}
                      onClick={() => onSelectAgent(pid)}
                      className="w-full flex items-center justify-between p-2.5 rounded-lg bg-slate-950 border border-slate-800 hover:border-slate-700 text-left transition-colors"
                    >
                      <div>
                        <span className="font-semibold text-xs text-white block">
                          {getAgentName(pid)}
                        </span>
                        <span className="text-[11px] text-slate-400">
                          {ag?.roleTitle || 'Participant'}
                        </span>
                      </div>
                      <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
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
