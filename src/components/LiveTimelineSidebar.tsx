import React, { useState } from 'react';
import { Agent, AgentStatus, Task, ViewerEvent } from '../types/agent';
import {
  PanelRightClose,
  Radio,
  Layers,
  Terminal,
  MessageSquare,
  Users,
  AlertCircle,
  CheckCircle2,
  Zap,
  Clock,
  Eye,
  Send,
  UserCheck,
  ChevronRight,
  Filter,
  Sparkles,
  Maximize2,
} from 'lucide-react';
import { EventDetailModal } from './EventDetailModal';

interface LiveTimelineSidebarProps {
  isOpen: boolean;
  onToggleOpen: () => void;
  events: ViewerEvent[];
  agents: Agent[];
  tasks: Task[];
  activeMeetingId: string | null;
  selectedAgent: Agent | null;
  onSelectAgent: (agentId: string | null) => void;
  onFocusAgent: (agent: Agent) => void;
  onSendMessage: (agentId: string, message: string) => void;
  onUpdateStatus: (agentId: string, status: AgentStatus) => void;
  onOpenAgentDetailModal?: (agentId: string) => void;
  theme: 'dark' | 'light';
}

export const LiveTimelineSidebar: React.FC<LiveTimelineSidebarProps> = ({
  isOpen,
  onToggleOpen,
  events,
  agents,
  tasks,
  activeMeetingId,
  selectedAgent,
  onSelectAgent,
  onFocusAgent,
  onSendMessage,
  onUpdateStatus,
  onOpenAgentDetailModal,
  theme,
}) => {
  const [activeTab, setActiveTab] = useState<'timeline' | 'inspector'>('timeline');
  const [filterCategory, setFilterCategory] = useState<'all' | 'tasks' | 'tools' | 'messages'>('all');
  const [instructionText, setInstructionText] = useState('');

  // If selectedAgent changes, switch to inspector tab automatically
  React.useEffect(() => {
    if (selectedAgent) {
      setActiveTab('inspector');
    }
  }, [selectedAgent]);

  const handleSendInstruction = (e: React.FormEvent) => {
    e.preventDefault();
    if (!instructionText.trim() || !selectedAgent) return;
    onSendMessage(selectedAgent.id, instructionText.trim());
    setInstructionText('');
  };

  // Filter events
  const filteredEvents = events.filter((ev) => {
    if (filterCategory === 'tasks') return ev.type.startsWith('task') || ev.type.startsWith('artifact') || ev.type.startsWith('approval');
    if (filterCategory === 'tools') return ev.type.startsWith('tool');
    if (filterCategory === 'messages') return ev.type.startsWith('message') || ev.type.startsWith('meeting');
    return true;
  });

  const activeTask = tasks.find((t) => t.status !== 'COMPLETED') || tasks[0] || null;

  const getEventBadge = (ev: ViewerEvent) => {
    if (ev.severity === 'critical') {
      return {
        bg: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
        icon: <AlertCircle className="w-3.5 h-3.5 text-rose-400" />,
        label: 'Alerta Crítica',
      };
    }
    if (ev.type.startsWith('tool.started') || ev.type.startsWith('tool.completed')) {
      return {
        bg: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
        icon: <Terminal className="w-3.5 h-3.5 text-sky-400" />,
        label: 'Herramienta',
      };
    }
    if (ev.type.startsWith('task.completed')) {
      return {
        bg: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
        icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />,
        label: 'Completado',
      };
    }
    if (ev.type.startsWith('task.blocked')) {
      return {
        bg: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
        icon: <AlertCircle className="w-3.5 h-3.5 text-rose-400" />,
        label: 'Bloqueado',
      };
    }
    if (ev.type.startsWith('task')) {
      return {
        bg: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
        icon: <Layers className="w-3.5 h-3.5 text-indigo-400" />,
        label: 'Tarea',
      };
    }
    if (ev.type.startsWith('meeting')) {
      return {
        bg: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
        icon: <Users className="w-3.5 h-3.5 text-purple-400" />,
        label: 'Reunión',
      };
    }
    if (ev.type.startsWith('message')) {
      return {
        bg: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
        icon: <MessageSquare className="w-3.5 h-3.5 text-amber-400" />,
        label: 'Mensaje',
      };
    }
    return {
      bg: 'bg-slate-800 text-slate-300 border-slate-700',
      icon: <Radio className="w-3.5 h-3.5 text-slate-400" />,
      label: 'Evento',
    };
  };

  const formatRelativeTime = (timestamp: number) => {
    const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (diffSeconds < 10) return 'Justo ahora';
    if (diffSeconds < 60) return `Hace ${diffSeconds}s`;
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return `Hace ${diffMinutes}m`;
    const diffHours = Math.floor(diffMinutes / 60);
    return `Hace ${diffHours}h`;
  };

  if (!isOpen) {
    return null;
  }

  return (
    <aside className="absolute right-0 top-0 lg:relative w-[min(100%,24rem)] h-full bg-slate-900 border-l border-slate-800/90 flex flex-col z-20 shrink-0 text-slate-100 shadow-2xl overflow-hidden animate-in slide-in-from-right duration-200">
      {/* Sidebar Header with Mode Tabs & Hide Button */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/90 backdrop-blur-md">
        <div className="flex items-center gap-1 bg-slate-950/80 p-0.5 rounded-lg border border-slate-800">
          <button
            onClick={() => setActiveTab('timeline')}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors ${
              activeTab === 'timeline'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Radio className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
            <span>Actividad en Vivo</span>
          </button>

          {selectedAgent && (
            <button
              onClick={() => setActiveTab('inspector')}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                activeTab === 'inspector'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <UserCheck className="w-3.5 h-3.5 text-sky-400" />
              <span>Inspector</span>
            </button>
          )}
        </div>

        {/* Hide / Collapse Sidebar Button */}
        <button
          onClick={onToggleOpen}
          title="Ocultar barra lateral de actividad"
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 text-xs font-medium transition-colors"
        >
          <PanelRightClose className="w-4 h-4 text-slate-400" />
          <span className="hidden sm:inline">Ocultar</span>
        </button>
      </div>

      {/* VIEW 1: LIVE TIMELINE */}
      {activeTab === 'timeline' && (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Oficina Virtual Status Card (Moved from Canvas to Sidebar Header above Tasks) */}
          <div className="px-4 py-3 bg-slate-950/70 border-b border-slate-800/80 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
              <div>
                <span className="font-bold text-white text-xs block">Oficina Virtual</span>
                <span className="text-[11px] text-slate-400">
                  {agents.length} Agentes · Vista 2.5D
                </span>
              </div>
            </div>

            {activeMeetingId ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                <Users className="w-3 h-3 text-emerald-400" />
                <span>Reunión</span>
              </span>
            ) : (
              <span className="text-[10px] font-mono text-slate-500 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                En Vivo
              </span>
            )}
          </div>

          {/* Active Task Banner */}
          {activeTask && (
            <div className="px-4 py-3 bg-indigo-950/30 border-b border-indigo-900/40">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="font-semibold text-indigo-200 flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-indigo-400" />
                  <span>{activeTask.id}</span>
                </span>
                <span className="text-[11px] font-mono text-indigo-300 tabular-nums">
                  {activeTask.progress}%
                </span>
              </div>
              <p className="text-xs text-slate-200 font-medium line-clamp-1 mb-2">
                {activeTask.title}
              </p>
              <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                  style={{ width: `${activeTask.progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Quick Category Filter Pills */}
          <div className="flex items-center gap-1 px-4 py-2 border-b border-slate-800/80 bg-slate-900/50 text-[11px] overflow-x-auto no-scrollbar">
            <span className="text-slate-500 font-medium mr-1 flex items-center gap-1 shrink-0">
              <Filter className="w-3 h-3 text-slate-500" />
              Ver:
            </span>
            <button
              onClick={() => setFilterCategory('all')}
              className={`px-2.5 py-1 rounded-md font-medium shrink-0 transition-colors ${
                filterCategory === 'all'
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Todos ({events.length})
            </button>
            <button
              onClick={() => setFilterCategory('tasks')}
              className={`px-2.5 py-1 rounded-md font-medium shrink-0 transition-colors ${
                filterCategory === 'tasks'
                  ? 'bg-slate-800 text-indigo-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Tareas
            </button>
            <button
              onClick={() => setFilterCategory('tools')}
              className={`px-2.5 py-1 rounded-md font-medium shrink-0 transition-colors ${
                filterCategory === 'tools'
                  ? 'bg-slate-800 text-sky-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Tools
            </button>
            <button
              onClick={() => setFilterCategory('messages')}
              className={`px-2.5 py-1 rounded-md font-medium shrink-0 transition-colors ${
                filterCategory === 'messages'
                  ? 'bg-slate-800 text-amber-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Mensajes
            </button>
          </div>

          {/* Vertical Timeline Feed */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 relative">
            {filteredEvents.length === 0 ? (
              <div className="py-12 text-center text-slate-500 text-xs flex flex-col items-center gap-2">
                <Radio className="w-6 h-6 text-slate-600 animate-pulse" />
                <span>Esperando nuevos eventos de los agentes...</span>
              </div>
            ) : (
              <div className="relative border-l-2 border-slate-800/80 ml-2 space-y-4">
                {filteredEvents.map((ev) => {
                  const sourceAgent = agents.find((a) => a.id === ev.source);
                  const badge = getEventBadge(ev);

                  return (
                    <div key={ev.id} className="relative pl-5 group">
                      {/* Timeline Dot with Agent Color */}
                      <div
                        className="absolute -left-[9px] top-1.5 w-4 h-4 rounded-full border-2 border-slate-900 shadow-sm flex items-center justify-center transition-transform group-hover:scale-125"
                        style={{
                          backgroundColor: sourceAgent ? sourceAgent.avatarColor : '#64748b',
                        }}
                      >
                        <span className="w-1.5 h-1.5 rounded-full bg-white opacity-80" />
                      </div>

                      {/* Event Card */}
                      <div
                        onDoubleClick={() => sourceAgent && onOpenAgentDetailModal && onOpenAgentDetailModal(sourceAgent.id)}
                        title="Doble clic para abrir expediente completo del agente"
                        className="bg-slate-950/70 border border-slate-800/80 rounded-xl p-3 hover:border-slate-700 transition-colors shadow-sm cursor-pointer select-none"
                      >
                        {/* Header: Agent Name + Action Badge + Timestamp */}
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {sourceAgent && (
                              <button
                                onClick={() => {
                                  onSelectAgent(sourceAgent.id);
                                  onFocusAgent(sourceAgent);
                                }}
                                title={`Seleccionar y enfocar a ${sourceAgent.name}`}
                                className="font-semibold text-xs text-white hover:text-sky-400 truncate text-left transition-colors flex items-center gap-1"
                              >
                                <span>{sourceAgent.name.split(' ')[0]}</span>
                                <span className="text-[10px] text-slate-500 font-normal">
                                  ({sourceAgent.roleTitle.split(' ')[0]})
                                </span>
                              </button>
                            )}
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <span
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${badge.bg}`}
                            >
                              {badge.icon}
                              <span>{badge.label}</span>
                            </span>
                            <span className="text-[10px] font-mono text-slate-500">
                              {formatRelativeTime(ev.timestamp)}
                            </span>
                          </div>
                        </div>

                        {/* Summary / Text */}
                        <p className="text-xs text-slate-200 leading-relaxed mb-2 font-normal">
                          {ev.summary}
                        </p>

                        {/* Payload / Tool Details Tag */}
                        {ev.payload?.tool && (
                          <div className="flex items-center gap-1.5 text-[10px] font-mono text-sky-300 bg-sky-950/50 px-2 py-1 rounded border border-sky-800/40">
                            <Terminal className="w-3 h-3 text-sky-400 shrink-0" />
                            <span className="truncate">{ev.payload.tool}</span>
                          </div>
                        )}

                        {/* Focus Agent Quick Action on hover */}
                        {sourceAgent && (
                          <div className="mt-2 pt-2 border-t border-slate-900 flex items-center justify-between text-[11px] text-slate-400">
                            <span className="text-[10px] text-slate-500 font-mono">
                              {sourceAgent.status}
                            </span>
                            <button
                              onClick={() => {
                                onSelectAgent(sourceAgent.id);
                                onFocusAgent(sourceAgent);
                              }}
                              className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-sky-400 transition-colors"
                            >
                              <Eye className="w-3 h-3" />
                              <span>Enfocar en oficina</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* VIEW 2: AGENT INSPECTOR TAB */}
      {activeTab === 'inspector' && selectedAgent && (
        <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
          {/* Agent Header */}
          <div className="p-4 border-b border-slate-800/80 bg-slate-900/50 flex items-start gap-3">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center font-bold text-white shadow-md relative shrink-0"
              style={{ backgroundColor: selectedAgent.clothingColor }}
            >
              <span className="text-base font-sans">{selectedAgent.name.charAt(0)}</span>
              <span className="absolute -bottom-1 -right-1 w-3.5 h-3.5 rounded-full border-2 border-slate-900 bg-emerald-500" />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-1">
                <h3
                  onDoubleClick={() => onOpenAgentDetailModal && onOpenAgentDetailModal(selectedAgent.id)}
                  title="Doble clic para ver todo el detalle"
                  className="font-bold text-white text-sm truncate cursor-pointer hover:text-sky-300 transition-colors"
                >
                  {selectedAgent.name}
                </h3>
                <div className="flex items-center gap-1">
                  {onOpenAgentDetailModal && (
                    <button
                      onClick={() => onOpenAgentDetailModal(selectedAgent.id)}
                      className="p-1 rounded text-slate-400 hover:text-sky-300 hover:bg-slate-800 transition-colors"
                      title="Abrir expediente modal completo (Doble clic)"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => onFocusAgent(selectedAgent)}
                    className="p-1 rounded text-slate-400 hover:text-sky-400 hover:bg-slate-800 transition-colors"
                    title="Enfocar en oficina"
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <p className="text-xs text-sky-400 font-medium">{selectedAgent.roleTitle}</p>
              <p className="text-[11px] text-slate-500 font-mono mt-0.5">
                {selectedAgent.provider} · {selectedAgent.model}
              </p>
            </div>
          </div>

          {/* Quick Metrics */}
          <div className="grid grid-cols-2 gap-2 p-4 border-b border-slate-800/80">
            <div className="bg-slate-950/70 p-2.5 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-500 uppercase tracking-wider block font-semibold">
                Estado Actual
              </span>
              <span className="text-xs font-semibold text-emerald-400 mt-0.5 block truncate">
                {selectedAgent.status}
              </span>
            </div>
            <div className="bg-slate-950/70 p-2.5 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-500 uppercase tracking-wider block font-semibold">
                Tokens / Coste
              </span>
              <span className="text-xs font-mono font-medium text-slate-200 mt-0.5 block truncate">
                ${selectedAgent.cost.toFixed(3)}
              </span>
            </div>
          </div>

          {/* Status Message */}
          <div className="px-4 py-3 border-b border-slate-800/80">
            <span className="text-[10px] text-slate-500 uppercase font-semibold block mb-1">
              Actividad en Curso
            </span>
            <p className="text-xs text-slate-300 italic bg-slate-950/50 p-2.5 rounded-lg border border-slate-800/60">
              "{selectedAgent.statusText}"
            </p>
          </div>

          {/* Send Instruction Input */}
          <div className="p-4 border-b border-slate-800/80">
            <span className="text-[10px] text-slate-500 uppercase font-semibold block mb-1.5">
              Enviar Mensaje al Agente
            </span>
            <form onSubmit={handleSendInstruction} className="flex gap-2">
              <input
                type="text"
                value={instructionText}
                onChange={(e) => setInstructionText(e.target.value)}
                placeholder="Escribe instrucción o prompt..."
                className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
              />
              <button
                type="submit"
                disabled={!instructionText.trim()}
                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors flex items-center justify-center"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
            </form>
          </div>

          {/* Return to Timeline Button */}
          <div className="p-4">
            <button
              onClick={() => setActiveTab('timeline')}
              className="w-full py-2 px-3 rounded-lg border border-slate-800 hover:bg-slate-800 text-xs text-slate-300 hover:text-white transition-colors flex items-center justify-center gap-1.5"
            >
              <Radio className="w-3.5 h-3.5 text-emerald-400" />
              <span>Volver a la Línea de Tiempo</span>
            </button>
          </div>
        </div>
      )}
    </aside>
  );
};
