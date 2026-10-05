import React, { useState } from 'react';
import { Agent, AgentStatus, ViewerEvent } from '../types/agent';
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
} from 'lucide-react';

interface AgentInspectorProps {
  agent: Agent;
  onClose: () => void;
  onFocusAgent: (agent: Agent) => void;
  onSendMessage: (agentId: string, message: string) => void;
  onUpdateStatus: (agentId: string, status: AgentStatus) => void;
  onOpenDetailModal?: (agentId: string) => void;
  events: ViewerEvent[];
}

export const AgentInspector: React.FC<AgentInspectorProps> = ({
  agent,
  onClose,
  onFocusAgent,
  onSendMessage,
  onUpdateStatus,
  onOpenDetailModal,
  events,
}) => {
  const [instructionText, setInstructionText] = useState('');

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
    <aside className="w-96 h-full bg-slate-900 border-l border-slate-800 flex flex-col z-20 shrink-0 text-slate-100 shadow-2xl overflow-hidden animate-in slide-in-from-right duration-200">
      {/* Inspector Header */}
      <div
        onDoubleClick={() => onOpenDetailModal && onOpenDetailModal(agent.id)}
        title="Doble clic para ver expediente completo en modal"
        className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/60 cursor-pointer select-none"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
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
            <p className="text-xs text-slate-400 font-medium truncate">{agent.roleTitle}</p>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {onOpenDetailModal && (
            <button
              onClick={() => onOpenDetailModal(agent.id)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-sky-300 hover:bg-slate-800 transition-colors"
              title="Abrir expediente completo en modal"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            title="Cerrar panel lateral"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Inspector Scroll Area */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
        {/* Status & Current Focus */}
        <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-slate-400 font-medium">Current Status</span>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-sky-400 animate-pulse" />
              <span className="font-semibold text-sky-400 uppercase tracking-wide">
                {agent.status}
              </span>
            </div>
          </div>

          <p className="text-slate-300 bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80 leading-relaxed">
            {agent.statusText || 'Stationed at assigned pod'}
          </p>

          {agent.currentTool && (
            <div className="flex items-center gap-2 text-indigo-300 bg-indigo-950/40 p-2 rounded border border-indigo-800/40 font-mono text-[11px]">
              <Terminal className="w-3.5 h-3.5 shrink-0 text-indigo-400" />
              <span className="truncate">{agent.currentTool}</span>
            </div>
          )}
        </div>

        {/* AI Model & Provider Details */}
        <div className="space-y-2">
          <h3 className="text-slate-400 font-medium">Model Configuration</h3>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-500 block">Provider</span>
              <span className="font-semibold text-slate-200">{agent.provider}</span>
            </div>
            <div className="bg-slate-950 p-2.5 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-500 block">Engine / Model</span>
              <span className="font-semibold text-slate-200 truncate block font-mono text-[11px]">
                {agent.model}
              </span>
            </div>
          </div>
        </div>

        {/* Token Observability & Cost Metrics (Tabular numerals) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-slate-400 font-medium">Session Telemetry</h3>
            <span className="text-slate-500 font-mono text-[11px] tabular-nums flex items-center gap-1">
              <Clock className="w-3 h-3" /> {sessionMinutes}m active
            </span>
          </div>

          <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2.5">
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="p-2 rounded bg-slate-900 border border-slate-800/80">
                <span className="text-[10px] text-slate-400 block">Total Tokens</span>
                <span className="text-base font-bold text-sky-400 font-mono tabular-nums">
                  {totalTokens.toLocaleString()}
                </span>
              </div>
              <div className="p-2 rounded bg-slate-900 border border-slate-800/80">
                <span className="text-[10px] text-slate-400 block">Estimated Cost</span>
                <span className="text-base font-bold text-emerald-400 font-mono tabular-nums">
                  ${agent.cost.toFixed(3)}
                </span>
              </div>
            </div>

            <div className="space-y-1.5 pt-1 text-[11px] text-slate-400 font-mono tabular-nums">
              <div className="flex justify-between">
                <span>Input Tokens:</span>
                <span className="text-slate-200">{agent.tokensInput.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span>Output Tokens:</span>
                <span className="text-slate-200">{agent.tokensOutput.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span>Cached Tokens:</span>
                <span className="text-slate-400">{agent.cachedTokens.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span>Reasoning Tokens:</span>
                <span className="text-purple-300">{agent.reasoningTokens.toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Operator Controls (PRD Section 85) */}
        <div className="space-y-2">
          <h3 className="text-slate-400 font-medium">Operator Controls</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onFocusAgent(agent)}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition-colors"
            >
              <Eye className="w-3.5 h-3.5 text-sky-400" />
              <span>Focus Camera</span>
            </button>

            <select
              value={agent.status}
              onChange={(e) => onUpdateStatus(agent.id, e.target.value as AgentStatus)}
              className="py-2 px-2.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-xs font-medium focus:outline-none"
            >
              <option value="IDLE">Set IDLE</option>
              <option value="CODING">Set CODING</option>
              <option value="TESTING">Set TESTING</option>
              <option value="BLOCKED">Set BLOCKED</option>
              <option value="DONE">Set DONE</option>
            </select>
          </div>
        </div>

        {/* Recent Events for this Agent */}
        <div className="space-y-2">
          <h3 className="text-slate-400 font-medium">Recent Activity</h3>
          <div className="space-y-1.5">
            {agentEvents.length === 0 ? (
              <p className="text-slate-500 italic p-2">No recent events recorded.</p>
            ) : (
              agentEvents.map((ev) => (
                <div
                  key={ev.id}
                  className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/80 text-[11px] space-y-1"
                >
                  <div className="flex items-center justify-between text-slate-500 font-mono text-[10px]">
                    <span className="uppercase">{ev.type}</span>
                    <span>{new Date(ev.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <p className="text-slate-300 font-sans leading-relaxed">{ev.summary}</p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Send Direct Instruction Form */}
      <form onSubmit={handleSend} className="p-3 border-t border-slate-800 bg-slate-950">
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder={`Instruct ${agent.name.split(' ')[0]}...`}
            value={instructionText}
            onChange={(e) => setInstructionText(e.target.value)}
            className="flex-1 bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
          />
          <button
            type="submit"
            disabled={!instructionText.trim()}
            className="p-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:pointer-events-none text-white rounded-lg transition-colors"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </form>
    </aside>
  );
};
