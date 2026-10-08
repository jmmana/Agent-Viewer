import React, { useState, useEffect, useId } from 'react';
import { Agent, AgentStatus, PricingConfig, Task, ViewerEvent } from '../types/agent';
import { OFFICE_ROOMS } from '../engine/officeModel';
import { APP_MESSAGES, t, type Locale, type TranslationKey } from '../i18n';
import { localizeDemoText } from '../content/demoScript';
import {
  X,
  Copy,
  Check,
  Terminal,
  Clock,
  CheckCircle2,
  MessageSquare,
  Cpu,
  Send,
  ChevronLeft,
  ChevronRight,
  CheckSquare,
  Briefcase,
  Sliders,
  MapPin,
  Compass,
  Zap,
  FolderGit2,
} from 'lucide-react';

interface AgentDetailModalProps {
  isOpen: boolean;
  agent: Agent | null;
  allAgents: Agent[];
  tasks: Task[];
  events: ViewerEvent[];
  pricing: PricingConfig[];
  locale: Locale;
  onClose: () => void;
  onSelectAgent: (agentId: string) => void;
  onFocusAgent: (agent: Agent) => void;
  onSendMessage: (agentId: string, message: string) => void;
  onUpdateStatus: (agentId: string, status: AgentStatus) => void;
  onOpenNewTaskForAgent?: (agent: Agent) => void;
}

type DetailTab = 'overview' | 'tasks' | 'metrics' | 'logs' | 'console';

/** Quick orders offered in the console tab: button label key and the prompt actually sent. */
const QUICK_PROMPTS: ReadonlyArray<{ icon: string; label: TranslationKey; prompt: TranslationKey }> = [
  { icon: '📑', label: 'agentDetail.quick.report', prompt: 'agentDetail.quick.reportPrompt' },
  { icon: '🧪', label: 'agentDetail.quick.coverage', prompt: 'agentDetail.quick.coveragePrompt' },
  { icon: '👔', label: 'agentDetail.quick.review', prompt: 'agentDetail.quick.reviewPrompt' },
  { icon: '⚡', label: 'agentDetail.quick.optimize', prompt: 'agentDetail.quick.optimizePrompt' },
];

const MANUAL_STATUSES: AgentStatus[] = ['IDLE', 'CODING', 'REVIEWING', 'IN_MEETING', 'WAITING_APPROVAL', 'BLOCKED'];

/** Returns the translated room name when the room id has a catalog entry, otherwise the given fallback. */
function roomLabel(locale: Locale, roomId: string, fallback: string): string {
  const key = `rooms.${roomId}`;
  return key in APP_MESSAGES.en ? t(locale, key as TranslationKey) : fallback;
}

export const AgentDetailModal: React.FC<AgentDetailModalProps> = ({
  isOpen,
  agent,
  allAgents,
  tasks,
  events,
  locale,
  onClose,
  onSelectAgent,
  onFocusAgent,
  onSendMessage,
  onUpdateStatus,
  onOpenNewTaskForAgent,
}) => {
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [copiedId, setCopiedId] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const titleId = useId();

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

  const intlLocale = locale === 'es' ? 'es-ES' : 'en-US';
  const statusLabel = (status: AgentStatus) => t(locale, `status.${status}` as TranslationKey);
  const firstName = agent.name.split(' ')[0];

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
  const currentRoomName = roomLabel(locale, currentRoom.id, currentRoom.name);

  // Manager & subordinates
  const manager = allAgents.find((a) => a.id === agent.managerId);
  const subordinates = allAgents.filter((a) => a.managerId === agent.id);

  // Tasks associated
  const activeTask = tasks.find((task) => task.id === agent.currentTaskId || task.assignedAgentId === agent.id) || null;
  const agentTasks = tasks.filter(
    (task) => task.assignedAgentId === agent.id || task.collaboratorIds.includes(agent.id)
  );
  const completedTasks = agentTasks.filter((task) => task.status === 'COMPLETED');

  // Artifacts produced
  const agentArtifacts = tasks
    .flatMap((task) => task.artifacts || [])
    .filter((art) => art.authorId === agent.id);

  // Agent specific events
  const agentEvents = events.filter((ev) => ev.source === agent.id || ev.target === agent.id);

  // Total tokens and cost calculations
  const totalTokens = agent.tokensInput + agent.tokensOutput + (agent.cachedTokens || 0) + (agent.reasoningTokens || 0);
  const sessionMinutes = Math.max(1, Math.floor((Date.now() - agent.startedAt) / 60000));
  const tokensPerMinute = Math.round(totalTokens / sessionMinutes);

  const teamName = t(locale, `agentPanels.team.${agent.team}` as TranslationKey);

  const handleCopyId = () => {
    navigator.clipboard.writeText(agent.id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  const handleSendPrompt = (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptText.trim()) return;
    onSendMessage(agent.id, promptText.trim());
    setStatusMessage(t(locale, 'agentDetail.sent', { name: agent.name }));
    setPromptText('');
    setTimeout(() => setStatusMessage(null), 3500);
  };

  const handleQuickPrompt = (text: string) => {
    onSendMessage(agent.id, text);
    setStatusMessage(t(locale, 'agentDetail.quickSent', { text }));
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

  const tabClass = (tab: DetailTab) =>
    `py-3 px-4 border-b-2 transition-colors flex items-center gap-2 shrink-0 ${
      activeTab === tab
        ? 'border-sky-500 text-sky-400 font-semibold'
        : 'border-transparent text-slate-400 hover:text-slate-200'
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-4xl max-h-[92vh] bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl flex flex-col overflow-hidden text-slate-100"
      >
        {/* HEADER BAR */}
        <div className="px-6 py-5 border-b border-slate-800/80 bg-slate-900/90 flex flex-col md:flex-row md:items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-4">
            {/* Agent Avatar Icon */}
            <div
              aria-hidden="true"
              className="w-14 h-14 rounded-2xl flex items-center justify-center font-bold text-white shadow-xl relative border-2 border-slate-700/60 shrink-0 text-xl"
              style={{ backgroundColor: agent.clothingColor }}
            >
              <span>{agent.name.charAt(0)}</span>
              <span className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-slate-900 ${statusStyle.dot}`} />
            </div>

            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h2 id={titleId} className="text-xl font-bold text-white tracking-tight">
                  {agent.name}
                </h2>

                <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider border ${statusStyle.badge}`}>
                  {statusLabel(agent.status)}
                </span>

                <button
                  type="button"
                  onClick={handleCopyId}
                  title={t(locale, copiedId ? 'agentDetail.idCopied' : 'agentDetail.copyId')}
                  aria-label={t(locale, copiedId ? 'agentDetail.idCopied' : 'agentDetail.copyIdLabel', { id: agent.id })}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-[11px] font-mono transition-colors"
                >
                  {copiedId ? (
                    <Check className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                  ) : (
                    <Copy className="w-3 h-3" aria-hidden="true" />
                  )}
                  <span>{agent.id}</span>
                </button>
              </div>

              <div className="flex items-center gap-2 mt-1 text-xs text-slate-400 flex-wrap">
                <span className="text-sky-400 font-medium">{localizeDemoText(agent.roleTitle, locale)}</span>
                <span aria-hidden="true">•</span>
                <span className="text-slate-300">{t(locale, 'agentDetail.teamLabel', { team: teamName })}</span>
                <span aria-hidden="true">•</span>
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
                type="button"
                onClick={() => onSelectAgent(prevAgent.id)}
                title={t(locale, 'agentDetail.previousAgent', { name: prevAgent.name })}
                aria-label={t(locale, 'agentDetail.previousAgent', { name: prevAgent.name })}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">{t(locale, 'agentDetail.previous')}</span>
              </button>
              <div className="w-px h-4 bg-slate-700" aria-hidden="true" />
              <button
                type="button"
                onClick={() => onSelectAgent(nextAgent.id)}
                title={t(locale, 'agentDetail.nextAgent', { name: nextAgent.name })}
                aria-label={t(locale, 'agentDetail.nextAgent', { name: nextAgent.name })}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
              >
                <span className="hidden sm:inline">{t(locale, 'agentDetail.next')}</span>
                <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>

            {/* Focus on Canvas */}
            <button
              type="button"
              onClick={() => {
                onFocusAgent(agent);
                onClose();
              }}
              title={t(locale, 'agentDetail.focusTitle')}
              aria-label={t(locale, 'agentDetail.focusTitle')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/30 text-xs font-medium transition-colors"
            >
              <Compass className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">{t(locale, 'agentDetail.focus')}</span>
            </button>

            {/* Close [X] */}
            <button
              type="button"
              onClick={onClose}
              title={t(locale, 'agentDetail.closeTitle')}
              aria-label={t(locale, 'agentDetail.closeTitle')}
              className="p-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white border border-slate-700/60 transition-colors ml-1"
            >
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* SUBHEADER: LIVE STATUS BANNER */}
        <div className="px-6 py-3 bg-slate-950/60 border-b border-slate-800/60 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-slate-300">
              <span className="text-slate-400 font-medium">{t(locale, 'agentDetail.activity')}</span>
              <span className="font-semibold text-white bg-slate-800/60 px-2 py-0.5 rounded border border-slate-700/40">
                {agent.statusText
                  ? localizeDemoText(agent.statusText, locale)
                  : t(locale, 'agentPanels.stationedFallback')}
              </span>
            </div>

            {agent.currentTool && (
              <div className="flex items-center gap-1.5 text-indigo-300 bg-indigo-950/40 px-2 py-0.5 rounded border border-indigo-800/40 font-mono text-[11px]">
                <Terminal className="w-3.5 h-3.5 text-indigo-400" aria-hidden="true" />
                <span>{agent.currentTool}</span>
              </div>
            )}

            {agent.speechBubble && (
              <div
                className="flex items-center gap-1.5 text-amber-300 bg-amber-950/30 px-2 py-0.5 rounded border border-amber-800/40 italic"
                title={t(locale, 'agentDetail.speech')}
              >
                <MessageSquare className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
                <span>&ldquo;{localizeDemoText(agent.speechBubble.text, locale)}&rdquo;</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 text-slate-400">
            <MapPin className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
            <span className="text-slate-300 font-medium">{currentRoomName}</span>
            <span className="font-mono text-slate-400 text-[11px]">
              ({agent.x}, {agent.y})
            </span>
          </div>
        </div>

        {/* NAVIGATION TABS */}
        <div
          role="group"
          aria-label={t(locale, 'agentDetail.tabsLabel')}
          className="flex items-center px-6 border-b border-slate-800 bg-slate-900/40 overflow-x-auto text-xs font-medium"
        >
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            aria-pressed={activeTab === 'overview'}
            className={tabClass('overview')}
          >
            <Sliders className="w-4 h-4" aria-hidden="true" />
            <span>{t(locale, 'agentDetail.tab.overview')}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('tasks')}
            aria-pressed={activeTab === 'tasks'}
            className={tabClass('tasks')}
          >
            <CheckSquare className="w-4 h-4" aria-hidden="true" />
            <span>{t(locale, 'agentDetail.tab.tasks', { count: agentArtifacts.length })}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('metrics')}
            aria-pressed={activeTab === 'metrics'}
            className={tabClass('metrics')}
          >
            <Cpu className="w-4 h-4" aria-hidden="true" />
            <span>{t(locale, 'agentDetail.tab.metrics')}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('logs')}
            aria-pressed={activeTab === 'logs'}
            className={tabClass('logs')}
          >
            <Clock className="w-4 h-4" aria-hidden="true" />
            <span>{t(locale, 'agentDetail.tab.logs', { count: agentEvents.length })}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('console')}
            aria-pressed={activeTab === 'console'}
            className={tabClass('console')}
          >
            <Terminal className="w-4 h-4" aria-hidden="true" />
            <span>{t(locale, 'agentDetail.tab.console')}</span>
          </button>
        </div>

        {/* TAB CONTENT AREA */}
        <div className="flex-1 overflow-y-auto p-6 text-xs space-y-6">
          {/* TAB 1: OVERVIEW */}
          {activeTab === 'overview' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Profile Card */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-4">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Briefcase className="w-4 h-4 text-sky-400" aria-hidden="true" />
                  {t(locale, 'agentDetail.profileHeading')}
                </h3>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">{t(locale, 'agentDetail.mainRole')}</span>
                    <span className="font-semibold text-slate-200">{localizeDemoText(agent.roleTitle, locale)}</span>
                  </div>

                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">{t(locale, 'agentDetail.department')}</span>
                    <span className="font-semibold text-slate-200">{teamName}</span>
                  </div>

                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">{t(locale, 'agentDetail.reportsTo')}</span>
                    <span className="font-semibold text-slate-200">
                      {manager ? manager.name : t(locale, 'agentDetail.boardOfDirectors')}
                    </span>
                  </div>

                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">{t(locale, 'agentDetail.supervises')}</span>
                    <span className="font-semibold text-slate-200">
                      {subordinates.length > 0
                        ? t(locale, 'agentDetail.subordinates', {
                            count: subordinates.length,
                            names: subordinates.map((s) => s.name.split(' ')[0]).join(', '),
                          })
                        : t(locale, 'agentDetail.autonomous')}
                    </span>
                  </div>
                </div>

                <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800/80 space-y-2">
                  <span className="text-slate-400 font-semibold block text-[11px]">
                    {t(locale, 'agentDetail.officeLocation')}
                  </span>
                  <div className="flex items-center justify-between text-slate-300">
                    <span>{t(locale, 'agentDetail.zone', { zone: currentRoomName })}</span>
                    <span className="font-mono bg-slate-800 px-2 py-0.5 rounded text-[11px]">
                      {t(locale, 'agentDetail.tile', { x: agent.x, y: agent.y })}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-400 text-[11px]">
                    <span>
                      {t(locale, 'agentDetail.facing', {
                        direction: t(locale, `agentPanels.facing.${agent.facing}` as TranslationKey),
                      })}
                    </span>
                    <span>
                      {t(locale, 'agentDetail.mode', {
                        mode: t(locale, agent.isWalking ? 'agentDetail.modeWalking' : 'agentDetail.modeStationed'),
                      })}
                    </span>
                  </div>
                </div>
              </div>

              {/* LLM & Inference Specs Card */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-4">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                  {t(locale, 'agentDetail.inferenceHeading')}
                </h3>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">{t(locale, 'agentDetail.provider')}</span>
                    <span className="font-semibold text-slate-200">{agent.provider}</span>
                  </div>

                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">{t(locale, 'agentDetail.activeModel')}</span>
                    <span className="font-mono font-semibold text-sky-400">{agent.model}</span>
                  </div>

                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">{t(locale, 'agentDetail.contextWindow')}</span>
                    <span className="font-semibold text-slate-200">{t(locale, 'agentDetail.contextWindowValue')}</span>
                  </div>

                  <div className="bg-slate-900/80 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">{t(locale, 'agentDetail.baseTemperature')}</span>
                    <span className="font-semibold text-slate-200">{t(locale, 'agentDetail.baseTemperatureValue')}</span>
                  </div>
                </div>

                {/* Quick Status Setter */}
                <div className="space-y-2 pt-2 border-t border-slate-800/60">
                  <span className="text-slate-400 font-semibold block text-[11px]">
                    {t(locale, 'agentDetail.changeStatus')}
                  </span>
                  <div className="grid grid-cols-3 gap-1.5">
                    {MANUAL_STATUSES.map((st) => (
                      <button
                        type="button"
                        key={st}
                        onClick={() => onUpdateStatus(agent.id, st)}
                        aria-pressed={agent.status === st}
                        className={`px-2 py-1.5 rounded-lg text-[10px] font-medium transition-colors ${
                          agent.status === st
                            ? 'bg-sky-700 text-white font-bold shadow'
                            : 'bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800'
                        }`}
                      >
                        {statusLabel(st)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: TASK & ARTIFACTS */}
          {activeTab === 'tasks' && (
            <div className="space-y-6">
              {/* Active Task Banner */}
              {activeTask ? (
                <div className="bg-slate-950 p-5 rounded-xl border border-slate-800 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider bg-sky-500/20 text-sky-300 border border-sky-500/30">
                        {t(locale, `agentPanels.taskStatus.${activeTask.status}` as TranslationKey)}
                      </span>
                      <span className="text-slate-400 font-mono text-xs">{activeTask.id}</span>
                    </div>

                    <div className="flex items-center gap-2 text-slate-300 font-semibold">
                      <span>{t(locale, 'agentDetail.progress')}</span>
                      <span className="text-sky-400 font-mono">{activeTask.progress}%</span>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-base font-bold text-white">{localizeDemoText(activeTask.title, locale)}</h4>
                    <p className="text-slate-300 mt-1 leading-relaxed text-xs">
                      {localizeDemoText(activeTask.description, locale)}
                    </p>
                  </div>

                  {/* Progress Bar */}
                  <div
                    role="progressbar"
                    aria-label={t(locale, 'agentDetail.progressLabel')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={activeTask.progress}
                    className="w-full bg-slate-800 h-2.5 rounded-full overflow-hidden"
                  >
                    <div
                      className="bg-gradient-to-r from-sky-500 to-indigo-500 h-full transition-all duration-300"
                      style={{ width: `${activeTask.progress}%` }}
                    />
                  </div>

                  {/* Tools used */}
                  {activeTask.toolsUsed && activeTask.toolsUsed.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-slate-400 text-[11px]">{t(locale, 'agentDetail.tools')}</span>
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
                  <CheckCircle2 className="w-8 h-8 text-slate-400 mx-auto" aria-hidden="true" />
                  <p className="text-slate-300 font-medium">{t(locale, 'agentDetail.noActiveTask')}</p>
                  <p className="text-slate-400 text-xs">{t(locale, 'agentDetail.noActiveTaskHint')}</p>
                  {onOpenNewTaskForAgent && (
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onOpenNewTaskForAgent(agent);
                      }}
                      className="px-4 py-2 bg-sky-700 hover:bg-sky-800 text-white font-medium rounded-xl text-xs transition-colors shadow-lg"
                    >
                      {t(locale, 'agentDetail.assignTask', { name: firstName })}
                    </button>
                  )}
                </div>
              )}

              {/* Artifacts Produced */}
              <div className="space-y-3">
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <FolderGit2 className="w-4 h-4 text-amber-400" aria-hidden="true" />
                  {t(locale, 'agentDetail.artifactsHeading', { count: agentArtifacts.length })}
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
                            {t(locale, `agentPanels.artifactType.${art.type}` as TranslationKey)}
                          </span>
                        </div>
                        <p className="text-slate-400 text-xs leading-relaxed">{localizeDemoText(art.summary, locale)}</p>
                        <div className="text-[10px] text-slate-400">
                          {new Date(art.timestamp).toLocaleTimeString(intlLocale)}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="bg-slate-950/60 p-4 rounded-xl border border-slate-800/80 text-slate-400 text-center">
                    {t(locale, 'agentDetail.noArtifacts')}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: METRICS & USAGE */}
          {activeTab === 'metrics' && (
            <div className="space-y-6">
              {/* 4 Stat Cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-1">
                  <span className="text-slate-400 text-[11px] block">{t(locale, 'agentDetail.inputTokens')}</span>
                  <span className="text-lg font-bold text-white font-mono">
                    {agent.tokensInput.toLocaleString(intlLocale)}
                  </span>
                  <span className="text-[10px] text-slate-400 block">{t(locale, 'agentDetail.inputTokensHint')}</span>
                </div>

                <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-1">
                  <span className="text-slate-400 text-[11px] block">{t(locale, 'agentDetail.outputTokens')}</span>
                  <span className="text-lg font-bold text-sky-400 font-mono">
                    {agent.tokensOutput.toLocaleString(intlLocale)}
                  </span>
                  <span className="text-[10px] text-slate-400 block">{t(locale, 'agentDetail.outputTokensHint')}</span>
                </div>

                <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-1">
                  <span className="text-slate-400 text-[11px] block">{t(locale, 'agentDetail.reasoningTokens')}</span>
                  <span className="text-lg font-bold text-purple-400 font-mono">
                    {(agent.reasoningTokens || 0).toLocaleString(intlLocale)}
                  </span>
                  <span className="text-[10px] text-slate-400 block">{t(locale, 'agentDetail.reasoningTokensHint')}</span>
                </div>

                <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 space-y-1">
                  <span className="text-slate-400 text-[11px] block">{t(locale, 'agentDetail.accumulatedCost')}</span>
                  <span className="text-lg font-bold text-emerald-400 font-mono">
                    ${agent.cost.toFixed(4)}
                  </span>
                  <span className="text-[10px] text-slate-400 block">{t(locale, 'agentDetail.accumulatedCostHint')}</span>
                </div>
              </div>

              {/* Efficiency & Speed */}
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <Zap className="w-4 h-4 text-amber-400" aria-hidden="true" />
                  {t(locale, 'agentDetail.performanceHeading')}
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">{t(locale, 'agentDetail.activeTime')}</span>
                    <span className="font-semibold text-slate-200 text-sm">
                      {t(locale, 'agentDetail.minutes', { minutes: sessionMinutes })}
                    </span>
                  </div>

                  <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">{t(locale, 'agentDetail.averageSpeed')}</span>
                    <span className="font-semibold text-slate-200 text-sm">
                      {t(locale, 'agentDetail.tokensPerMinute', { value: tokensPerMinute.toLocaleString(intlLocale) })}
                    </span>
                  </div>

                  <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800/80">
                    <span className="text-slate-400 block text-[11px]">{t(locale, 'agentDetail.completedTasks')}</span>
                    <span className="font-semibold text-slate-200 text-sm">
                      {t(locale, 'agentDetail.completedOf', { done: completedTasks.length, total: agentTasks.length })}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: ACTIVITY LOG */}
          {activeTab === 'logs' && (
            <div className="space-y-4">
              <h4 className="text-sm font-bold text-white flex items-center gap-2">
                <Clock className="w-4 h-4 text-sky-400" aria-hidden="true" />
                {t(locale, 'agentDetail.eventsHeading', { count: agentEvents.length })}
              </h4>

              {agentEvents.length > 0 ? (
                <div className="space-y-2">
                  {agentEvents.map((ev) => (
                    <div
                      key={ev.id}
                      className="bg-slate-950 p-3 rounded-xl border border-slate-800 flex items-start gap-3"
                    >
                      <div className="mt-0.5">
                        <Terminal className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
                      </div>
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-slate-200">{localizeDemoText(ev.summary, locale)}</span>
                          <span className="text-[10px] text-slate-400 font-mono">
                            {new Date(ev.timestamp).toLocaleTimeString(intlLocale)}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-slate-400 font-mono">
                          <span className="bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800">
                            {ev.type}
                          </span>
                          {ev.target && <span>{t(locale, 'agentDetail.eventTarget', { target: ev.target })}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="bg-slate-950/60 p-6 rounded-xl border border-slate-800 text-center text-slate-400">
                  {t(locale, 'agentDetail.noEvents')}
                </div>
              )}
            </div>
          )}

          {/* TAB 5: INTERACTIVE CONSOLE */}
          {activeTab === 'console' && (
            <div className="space-y-4">
              <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-4">
                <h4 className="text-sm font-bold text-white flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-indigo-400" aria-hidden="true" />
                  {t(locale, 'agentDetail.consoleHeading')}
                </h4>

                <p className="text-slate-400 text-xs">{t(locale, 'agentDetail.consoleIntro', { name: agent.name })}</p>

                {/* Quick Presets */}
                <div className="space-y-1.5">
                  <span className="text-[11px] text-slate-400 font-medium">{t(locale, 'agentDetail.quickOrders')}</span>
                  <div className="flex flex-wrap gap-2">
                    {QUICK_PROMPTS.map((quick) => (
                      <button
                        type="button"
                        key={quick.label}
                        onClick={() => handleQuickPrompt(t(locale, quick.prompt))}
                        className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 hover:text-white transition-colors text-[11px]"
                      >
                        <span aria-hidden="true">{quick.icon}</span> {t(locale, quick.label)}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Custom Input Form */}
                <form onSubmit={handleSendPrompt} className="space-y-3 pt-2">
                  <textarea
                    aria-label={t(locale, 'agentDetail.promptLabel', { name: agent.name })}
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    placeholder={t(locale, 'agentDetail.promptPlaceholder', { name: agent.name })}
                    rows={3}
                    className="w-full bg-slate-900 border border-slate-800 rounded-xl p-3 text-slate-100 placeholder-slate-400 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 text-xs resize-none"
                  />

                  <div className="flex items-center justify-between">
                    <div role="status" aria-live="polite">
                      {statusMessage ? (
                        <span className="text-emerald-400 font-medium flex items-center gap-1.5 animate-in fade-in">
                          <Check className="w-3.5 h-3.5" aria-hidden="true" />
                          {statusMessage}
                        </span>
                      ) : (
                        <span className="text-slate-400 text-[11px]">{t(locale, 'agentDetail.sendHint')}</span>
                      )}
                    </div>

                    <button
                      type="submit"
                      disabled={!promptText.trim()}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:pointer-events-none text-white font-medium rounded-xl text-xs flex items-center gap-1.5 transition-colors shadow"
                    >
                      <Send className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{t(locale, 'agentDetail.send')}</span>
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
            <span className="font-mono text-[11px]">{t(locale, 'agentDetail.tip')}</span>
            <span>{t(locale, 'agentDetail.tipText')}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium transition-colors border border-slate-700/60"
            >
              {t(locale, 'agentDetail.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
