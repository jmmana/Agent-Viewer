import React, { useState, useEffect, useMemo } from 'react';
import { Agent, AgentStatus, PricingConfig, Task, ViewerEvent } from '../types/agent';
import { OFFICE_ROOMS } from '../engine/officeModel';
import {
  X,
  Copy,
  Check,
  Terminal,
  Clock,
  Layers,
  AlertCircle,
  CheckCircle2,
  Users,
  MessageSquare,
  DollarSign,
  Cpu,
  Eye,
  Send,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  ShieldAlert,
  Code2,
  FileText,
  GitPullRequest,
  CheckSquare,
  Briefcase,
  Sliders,
  MapPin,
  Compass,
  Zap,
  CornerDownRight,
  RefreshCw,
  FolderGit2,
  Share2,
} from 'lucide-react';

interface AgentDetailModalProps {
  isOpen: boolean;
  agent: Agent | null;
  allAgents: Agent[];
  tasks: Task[];
  events: ViewerEvent[];
  pricing: PricingConfig[];
  onClose: () => void;
  onSelectAgent: (agentId: string) => void;
  onFocusAgent: (agent: Agent) => void;
  onSendMessage: (agentId: string, message: string) => void;
  onUpdateStatus: (agentId: string, status: AgentStatus) => void;
  onOpenNewTaskForAgent?: (agent: Agent) => void;
}

export const AgentDetailModal: React.FC<AgentDetailModalProps> = ({
  isOpen,
  agent,
  allAgents,
  tasks,
  events,
  pricing,
  onClose,
  onSelectAgent,
  onFocusAgent,
  onSendMessage,
  onUpdateStatus,
  onOpenNewTaskForAgent,
}) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'tasks' | 'metrics' | 'logs' | 'console'>('overview');
  const [copiedId, setCopiedId] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !agent) return null;

  // Find index and next/previous agent
  const currentIndex = allAgents.findIndex((a) => a.id === agent.id);
  const prevAgent = allAgents[(currentIndex - 1 + allAgents.length) % allAgents.length];
  const nextAgent = allAgents[(currentIndex + 1) % allAgents.length];

  // Room details
  const currentRoom = OFFICE_ROOMS.find(
    (r) =>
      agent.x >= r.gridX &&
      agent.x < r.gridX + r.width &&
      agent.y >= r.gridY &&
      agent.y < r.gridY + r.height
  ) || {
    id: agent.workspace,
    name: agent.workspace.replace(/_/g, ' ').toUpperCase(),
  };

  // Manager & subordinates
  const manager = allAgents.find((a) => a.id === agent.managerId);
  const subordinates = allAgents.filter((a) => a.managerId === agent.id);

  // Tasks associated
  const activeTask = tasks.find((t) => t.id === agent.currentTaskId || t.assignedAgentId === agent.id) || null;
  const agentTasks = tasks.filter(
    (t) => t.assignedAgentId === agent.id || t.collaboratorIds.includes(agent.id)
  );
  const completedTasks = agentTasks.filter((t) => t.status === 'COMPLETED');

  // Artifacts produced
  const agentArtifacts = tasks
    .flatMap((t) => t.artifacts || [])
    .filter((art) => art.authorId === agent.id);

  // Agent specific events
  const agentEvents = events.filter((ev) => ev.source === agent.id || ev.target === agent.id);

  // Total tokens and cost calculations
  const totalTokens = agent.tokensInput + agent.tokensOutput + (agent.cachedTokens || 0) + (agent.reasoningTokens || 0);
  const sessionMinutes = Math.max(1, Math.floor((Date.now() - agent.startedAt) / 60000));
  const tokensPerMinute = Math.round(totalTokens / sessionMinutes);

  const handleCopyId = () => {
    navigator.clipboard.writeText(agent.id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  const handleSendPrompt = (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptText.trim()) return;
    onSendMessage(agent.id, promptText.trim());
    setStatusMessage(`Instrucción enviada a ${agent.name}`);
    setPromptText('');
    setTimeout(() => setStatusMessage(null), 3500);
  };

  const handleQuickPrompt = (text: string) => {
    onSendMessage(agent.id, text);
    setStatusMessage(`Instrucción rápida enviada: "${text}"`);
    setTimeout(() => setStatusMessage(null), 3500);
  };

  const getStatusColor = (status: AgentStatus) => {
    switch (status) {
      case 'CODING':
      case 'TESTING':
      case 'WRITING':
      case 'RESEARCHING':
      case 'USING_TOOL':
        return {
          badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
          dot: 'bg-emerald-400 animate-pulse',
        };
      case 'IN_MEETING':
        return {
          badge: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
          dot: 'bg-purple-400 animate-pulse',
        };
      case 'THINKING':
      case 'WAITING_APPROVAL':
      case 'REVIEWING':
        return {
          badge: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
          dot: 'bg-amber-400 animate-pulse',
        };
      case 'BLOCKED':
      case 'ERROR':
        return {
          badge: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
          dot: 'bg-rose-400 animate-ping',
        };
      default:
        return {
          badge: 'bg-slate-700/40 text-slate-300 border-slate-700/60',
          dot: 'bg-slate-400',
        };
    }
  };

  const statusStyle = getStatusColor(agent.status);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-modal-title"
    >
      <div className="relative w-full max-w-4xl max-h-[92vh] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-slate-100">
        {/* HEADER BAR */}
        <div className="px-6 py-5 border-b border-slate-800/80 bg-slate-900/90 flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-4">
            {/* Agent Avatar Icon */}
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center font-bold text-white shadow-xl relative border-2 border-slate-700/60 shrink-0 text-xl"
              style={{ backgroundColor: agent.clothingColor }}
            >
              <span>{agent.name.charAt(0)}</span>
              <span className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-slate-900 ${statusStyle.dot}`} />
            </div>

            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h2 id="agent-modal-title" className="text-xl font-bold text-white tracking-tight">
                  {agent.name}
                </h2>

                <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider border ${statusStyle.badge}`}>
                  {agent.status}
                </span>

                <button
                  onClick={handleCopyId}
                  title="Copiar ID del agente"
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-[11px] font-mono transition-colors"
                >
                  {copiedId ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{agent.id}</span>
                </button>
              </div>

              <div className="flex items-center gap-2 mt-1 text-xs text-slate-400 flex-wrap">
                <span className="text-sky-400 font-medium">{agent.roleTitle}</span>
                <span>•</span>
                <span className="capitalize text-slate-300">Equipo {agent.team}</span>
                <span>•</span>
                <span className="font-mono text-slate-400 bg-slate-800/60 px-1.5 py-0.5 rounded">
                  {agent.provider} ({agent.model})
                </span>
              </div>
            </div>
          </div>

          {/* Quick Controls in Header */}
          <div className="flex items-center gap-2 self-end md:self-auto shrink-0">
            {/* Prev / Next Agent Buttons */}
            <div className="flex items-center bg-slate-800/80 rounded-xl p-0.5 border border-slate-700/60 text-xs">
              <button
                onClick={() => onSelectAgent(prevAgent.id)}
                title={`Anterior: ${prevAgent.name}`}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Anterior</span>
              </button>
              <div className="w-px h-4 bg-slate-700" />
              <button
                onClick={() => onSelectAgent(nextAgent.id)}
                title={`Siguiente: ${nextAgent.name}`}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
              >
                <span className="hidden sm:inline">Siguiente</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Focus on Canvas */}
            <button
              onClick={() => {
                onFocusAgent(agent);
                onClose();
              }}
              title="Centrar y enfocar en la oficina 2.5D"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/30 text-xs font-medium transition-colors"
            >
              <Compass className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Enfocar</span>
            </button>

            {/* Close [X] */}
            <button
              onClick={onClose}
              title="Cerrar modal (ESC)"
              className="p-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white border border-slate-700/60 transition-colors ml-1"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* SUBHEADER: LIVE STATUS BANNER */}
        <div className="px-6 py-3 bg-slate-950/60 border-b border-slate-800/60 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-slate-300">
              <span className="text-slate-400 font-medium">Actividad:</span>
              <span className="font-semibold text-white bg-slate-800/60 px-2 py-0.5 rounded border border-slate-700/40">
                {agent.statusText || 'En estación de trabajo asignada'}
              </span>
            </div>

            {agent.currentTool && (
              <div className="flex items-center gap-1.5 text-indigo-300 bg-indigo-950/40 px-2 py-0.5 rounded border border-indigo-800/40 font-mono text-[11px]">
                <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                <span>{agent.currentTool}</span>
              </div>
            )}

            {agent.speechBubble && (
              <div className="flex items-center gap-1.5 text-amber-300 bg-amber-950/30 px-2 py-0.5 rounded border border-amber-800/40 italic">
                <MessageSquare className="w-3.5 h-3.5 text-amber-400" />
                <span>&ldquo;{agent.speechBubble.text}&rdquo;</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 text-slate-400">
            <MapPin className="w-3.5 h-3.5 text-sky-400" />
            <span className="text-slate-300 font-medium">{currentRoom.name}</span>
            <span className="font-mono text-slate-500 text-[11px]">
              ({agent.x}, {agent.y})
            </span>
          </div>
        </div>

        {/* NAVIGATION TABS */}
        <div className="flex items-center px-6 border-b border-slate-800 bg-slate-900/40 overflow-x-auto text-xs font-medium">
          <button
            onClick={() => setActiveTab('overview')}
            className={`py-3 px-4 border-b-2 transition-colors flex items-center gap-2 shrink-0 ${
              activeTab === 'overview'
                ? 'border-sky-500 text-sky-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Sliders className="w-4 h-4" />
            <span>Visión General</span>
          </button>

          <button
            onClick={() => setActiveTab('tasks')}
            className={`py-3 px-4 border-b-2 transition-colors flex items-center gap-2 shrink-0 ${
              activeTab === 'tasks'
                ? 'border-sky-500 text-sky-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <CheckSquare className="w-4 h-4" />
            <span>Tarea & Artefactos ({agentArtifacts.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('metrics')}
            className={`py-3 px-4 border-b-2 transition-colors flex items-center gap-2 shrink-0 ${
              activeTab === 'metrics'
                ? 'border-sky-500 text-sky-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Cpu className="w-4 h-4" />
            <span>Métricas & Tokens</span>
          </button>

          <button
            onClick={() => setActiveTab('logs')}
            className={`py-3 px-4 border-b-2 transition-colors flex items-center gap-2 shrink-0 ${
              activeTab === 'logs'
                ? 'border-sky-500 text-sky-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Clock className="w-4 h-4" />
            <span>Registro de Actividad ({agentEvents.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('console')}
            className={`py-3 px-4 border-b-2 transition-colors flex items-center gap-2 shrink-0 ${
              activeTab === 'console'
                ? 'border-sky-500 text-sky-400 font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <Terminal className="w-4 h-4" />
            <span>Consola Interactiva</span>
          </button>
        </div>

        {/* TAB CONTENT AREA */}
        <div className="flex-1 overflow-y-auto p-6 text-xs space-y-6">
          {/* TAB 1: VISIÓN GENERAL */}
          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Profile Card */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-4">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Briefcase className="w-4 h-4 text-sky-400" />
                  Perfil & Estructura Organizacional
                </h3>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">Rol Principal</span>
                    <span className="font-semibold text-slate-200">{agent.roleTitle}</span>
                  </div>

                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">Departamento</span>
                    <span className="font-semibold text-slate-200 capitalize">{agent.team}</span>
                  </div>

                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">Reporta directamente a</span>
                    <span className="font-semibold text-slate-200">
                      {manager ? manager.name : 'Junta Directiva'}
                    </span>
                  </div>

                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">Supervisa</span>
                    <span className="font-semibold text-slate-200">
                      {subordinates.length > 0
                        ? `${subordinates.length} agentes (${subordinates.map((s) => s.name.split(' ')[0]).join(', ')})`
                        : 'Trabajo autónomo individual'}
                    </span>
                  </div>
                </div>

                <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800/80 space-y-2">
                  <span className="text-slate-400 font-semibold block text-[11px]">Ubicación en Oficina</span>
                  <div className="flex items-center justify-between text-slate-300">
                    <span>Zona: {currentRoom.name}</span>
                    <span className="font-mono bg-slate-800 px-2 py-0.5 rounded text-[11px]">
                      Tile ({agent.x}, {agent.y})
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-400 text-[11px]">
                    <span>Orientación: {agent.facing}</span>
                    <span>Modo: {agent.isWalking ? 'Desplazándose' : 'En estación de trabajo'}</span>
                  </div>
                </div>
              </div>

              {/* LLM & Inference Specs Card */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-4">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-emerald-400" />
                  Especificaciones de Inferencia LLM
                </h3>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">Proveedor</span>
                    <span className="font-semibold text-slate-200">{agent.provider}</span>
                  </div>

                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">Modelo Activo</span>
                    <span className="font-mono font-semibold text-sky-400">{agent.model}</span>
                  </div>

                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">Ventana de Contexto</span>
                    <span className="font-semibold text-slate-200">128k - 1M tokens</span>
                  </div>

                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">Temperatura Base</span>
                    <span className="font-semibold text-slate-200">0.2 (Precisión Técnica)</span>
                  </div>
                </div>

                {/* Quick Status Setter */}
                <div className="space-y-2 pt-2 border-t border-slate-800/60">
                  <span className="text-slate-400 font-semibold block text-[11px]">Cambiar Estado Manualmente</span>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(['IDLE', 'CODING', 'REVIEWING', 'IN_MEETING', 'WAITING_APPROVAL', 'BLOCKED'] as AgentStatus[]).map((st) => (
                      <button
                        key={st}
                        onClick={() => onUpdateStatus(agent.id, st)}
                        className={`px-2 py-1.5 rounded-lg text-[10px] font-medium transition-colors ${
                          agent.status === st
                            ? 'bg-sky-500 text-white font-bold shadow'
                            : 'bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800'
                        }`}
                      >
                        {st}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: TAREA & ARTEFACTOS */}
          {activeTab === 'tasks' && (
            <div className="space-y-6">
              {/* Active Task Banner */}
              {activeTask ? (
                <div className="bg-slate-950 p-5 rounded-xl border border-slate-800 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-sky-500/20 text-sky-300 border border-sky-500/30">
                        {activeTask.status}
                      </span>
                      <span className="text-slate-400 font-mono text-xs">{activeTask.id}</span>
                    </div>

                    <div className="flex items-center gap-2 text-slate-300 font-semibold">
                      <span>Progreso:</span>
                      <span className="text-sky-400 font-mono">{activeTask.progress}%</span>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-base font-bold text-white">{activeTask.title}</h4>
                    <p className="text-slate-300 mt-1 leading-relaxed text-xs">
                      {activeTask.description}
                    </p>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full bg-slate-800 h-2.5 rounded-full overflow-hidden">
                    <div
                      className="bg-gradient-to-r from-sky-500 to-indigo-500 h-full transition-all duration-300"
                      style={{ width: `${activeTask.progress}%` }}
                    />
                  </div>

                  {/* Tools used */}
                  {activeTask.toolsUsed && activeTask.toolsUsed.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-slate-400 text-[11px]">Herramientas:</span>
                      {activeTask.toolsUsed.map((tool) => (
                        <span
                          key={tool}
                          className="bg-slate-900 text-slate-300 px-2 py-0.5 rounded border border-slate-800 font-mono text-[11px]"
                        >
                          {tool}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="bg-slate-950 p-6 rounded-xl border border-slate-800 text-center space-y-3">
                  <CheckCircle2 className="w-8 h-8 text-slate-500 mx-auto" />
                  <p className="text-slate-300 font-medium">Este agente no tiene una tarea activa asignada en este momento.</p>
                  <p className="text-slate-500 text-xs">Puedes asignarle una nueva misión o despacharla desde el gestor de tareas.</p>
                  {onOpenNewTaskForAgent && (
                    <button
                      onClick={() => {
                        onClose();
                        onOpenNewTaskForAgent(agent);
                      }}
                      className="px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white font-medium rounded-xl text-xs transition-colors shadow-lg"
                    >
                      Asignar Nueva Tarea a {agent.name.split(' ')[0]}
                    </button>
                  )}
                </div>
              )}

              {/* Artifacts Produced */}
              <div className="space-y-3">
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <FolderGit2 className="w-4 h-4 text-amber-400" />
                  Artefactos & Entregables Producidos ({agentArtifacts.length})
                </h4>

                {agentArtifacts.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {agentArtifacts.map((art) => (
                      <div
                        key={art.id}
                        className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 hover:border-slate-700 transition-colors space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-slate-200 font-mono">{art.name}</span>
                          <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded bg-slate-800 text-slate-400">
                            {art.type}
                          </span>
                        </div>
                        <p className="text-slate-400 text-xs leading-relaxed">{art.summary}</p>
                        <div className="text-[10px] text-slate-500">
                          {new Date(art.timestamp).toLocaleTimeString('es-ES')}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800/80 text-slate-400 text-center">
                    Aún no ha generado artefactos en esta sesión de simulación.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: MÉTRICAS & CONSUMO */}
          {activeTab === 'metrics' && (
            <div className="space-y-6">
              {/* 4 Stat Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-1">
                  <span className="text-slate-400 text-[11px] block">Tokens Entrada</span>
                  <span className="text-lg font-bold text-white font-mono">
                    {agent.tokensInput.toLocaleString()}
                  </span>
                  <span className="text-[10px] text-slate-500 block">Prompts de contexto</span>
                </div>

                <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-1">
                  <span className="text-slate-400 text-[11px] block">Tokens Salida</span>
                  <span className="text-lg font-bold text-sky-400 font-mono">
                    {agent.tokensOutput.toLocaleString()}
                  </span>
                  <span className="text-[10px] text-slate-500 block">Generación de código/texto</span>
                </div>

                <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-1">
                  <span className="text-slate-400 text-[11px] block">Tokens Razonamiento</span>
                  <span className="text-lg font-bold text-purple-400 font-mono">
                    {(agent.reasoningTokens || 0).toLocaleString()}
                  </span>
                  <span className="text-[10px] text-slate-500 block">Pensamiento profundo</span>
                </div>

                <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-1">
                  <span className="text-slate-400 text-[11px] block">Costo Acumulado</span>
                  <span className="text-lg font-bold text-emerald-400 font-mono">
                    ${agent.cost.toFixed(4)}
                  </span>
                  <span className="text-[10px] text-slate-500 block">USD facturado</span>
                </div>
              </div>

              {/* Efficiency & Speed */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <Zap className="w-4 h-4 text-amber-400" />
                  Rendimiento & Velocidad Operativa
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">Tiempo Activo (Sesión)</span>
                    <span className="font-semibold text-slate-200 text-sm">{sessionMinutes} min</span>
                  </div>

                  <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">Velocidad Promedio</span>
                    <span className="font-semibold text-slate-200 text-sm">{tokensPerMinute} t/min</span>
                  </div>

                  <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">Tareas Completadas</span>
                    <span className="font-semibold text-slate-200 text-sm">
                      {completedTasks.length} de {agentTasks.length}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: LOGS & ACTIVIDAD */}
          {activeTab === 'logs' && (
            <div className="space-y-4">
              <h4 className="text-sm font-bold text-white flex items-center gap-2">
                <Clock className="w-4 h-4 text-sky-400" />
                Historial de Eventos Vinculados ({agentEvents.length})
              </h4>

              {agentEvents.length > 0 ? (
                <div className="space-y-2">
                  {agentEvents.map((ev) => (
                    <div
                      key={ev.id}
                      className="bg-slate-950 p-3 rounded-xl border border-slate-800 flex items-start gap-3"
                    >
                      <div className="mt-0.5">
                        <Terminal className="w-3.5 h-3.5 text-sky-400" />
                      </div>
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-slate-200">{ev.summary}</span>
                          <span className="text-[10px] text-slate-500 font-mono">
                            {new Date(ev.timestamp).toLocaleTimeString('es-ES')}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono">
                          <span className="bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
                            {ev.type}
                          </span>
                          {ev.target && <span>Destino: {ev.target}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="bg-slate-950/60 p-6 rounded-xl border border-slate-800 text-center text-slate-400">
                  No hay eventos registrados para este agente en la sesión actual.
                </div>
              )}
            </div>
          )}

          {/* TAB 5: CONSOLA INTERACTIVA */}
          {activeTab === 'console' && (
            <div className="space-y-4">
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-4">
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-indigo-400" />
                  Enviar Instrucción o Prompt Directo
                </h4>

                <p className="text-slate-400 text-xs">
                  Envía una orden inmediata a {agent.name}. Esta instrucción será procesada con prioridad por el motor de inferencia.
                </p>

                {/* Quick Presets */}
                <div className="space-y-1.5">
                  <span className="text-[11px] text-slate-400 font-medium">Órdenes Rápidas sugeridas:</span>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => handleQuickPrompt('Generar informe de estado actual y entregables')}
                      className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white transition-colors text-[11px]"
                    >
                      📑 Generar informe
                    </button>
                    <button
                      onClick={() => handleQuickPrompt('Ejecutar suite de pruebas y validar cobertura')}
                      className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white transition-colors text-[11px]"
                    >
                      🧪 Validar cobertura
                    </button>
                    <button
                      onClick={() => handleQuickPrompt('Sincronizar cambios y solicitar revisión al Director')}
                      className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white transition-colors text-[11px]"
                    >
                      👔 Solicitar revisión
                    </button>
                    <button
                      onClick={() => handleQuickPrompt('Optimizar consumo de tokens y pausar subprocesos')}
                      className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white transition-colors text-[11px]"
                    >
                      ⚡ Optimizar recursos
                    </button>
                  </div>
                </div>

                {/* Custom Input Form */}
                <form onSubmit={handleSendPrompt} className="space-y-3 pt-2">
                  <textarea
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    placeholder={`Escribe una instrucción directa para ${agent.name}...`}
                    rows={3}
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl p-3 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 text-xs resize-none"
                  />

                  <div className="flex items-center justify-between">
                    {statusMessage ? (
                      <span className="text-emerald-400 font-medium flex items-center gap-1.5 animate-in fade-in">
                        <Check className="w-3.5 h-3.5" />
                        {statusMessage}
                      </span>
                    ) : (
                      <span className="text-slate-500 text-[11px]">
                        Presiona Enviar para despachar la orden.
                      </span>
                    )}

                    <button
                      type="submit"
                      disabled={!promptText.trim()}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:pointer-events-none text-white font-medium rounded-xl text-xs flex items-center gap-1.5 transition-colors shadow"
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>Enviar Orden</span>
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>

        {/* MODAL FOOTER */}
        <div className="px-6 py-4 bg-slate-950/80 border-t border-slate-800/80 flex items-center justify-between text-xs shrink-0">
          <div className="flex items-center gap-2 text-slate-400">
            <span className="font-mono text-[11px]">Tip:</span>
            <span>Puedes hacer doble clic en cualquier agente en la oficina para abrir este modal directamente.</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition-colors border border-slate-700/60"
            >
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
