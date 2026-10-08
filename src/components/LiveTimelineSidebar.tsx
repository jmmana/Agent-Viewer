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
import { t, type Locale, type TranslationKey } from '../i18n';
import { localizeDemoText } from '../content/demoScript';

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
  locale: Locale;
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
  locale,
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
        label: t(locale, 'sidebar.badge.critical'),
      };
    }
    if (ev.type.startsWith('tool.started') || ev.type.startsWith('tool.completed')) {
      return {
        bg: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
        icon: <Terminal className="w-3.5 h-3.5 text-sky-400" />,
        label: t(locale, 'sidebar.badge.tool'),
      };
    }
    if (ev.type.startsWith('task.completed')) {
      return {
        bg: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
        icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />,
        label: t(locale, 'sidebar.badge.completed'),
      };
    }
    if (ev.type.startsWith('task.blocked')) {
      return {
        bg: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
        icon: <AlertCircle className="w-3.5 h-3.5 text-rose-400" />,
        label: t(locale, 'sidebar.badge.blocked'),
      };
    }
    if (ev.type.startsWith('task')) {
      return {
        bg: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
        icon: <Layers className="w-3.5 h-3.5 text-indigo-400" />,
        label: t(locale, 'sidebar.badge.task'),
      };
    }
    if (ev.type.startsWith('meeting')) {
      return {
        bg: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
        icon: <Users className="w-3.5 h-3.5 text-purple-400" />,
        label: t(locale, 'sidebar.badge.meeting'),
      };
    }
    if (ev.type.startsWith('message')) {
      return {
        bg: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
        icon: <MessageSquare className="w-3.5 h-3.5 text-amber-400" />,
        label: t(locale, 'sidebar.badge.message'),
      };
    }
    return {
      bg: 'bg-slate-800 text-slate-300 border-slate-700',
      icon: <Radio className="w-3.5 h-3.5 text-slate-400" />,
      label: t(locale, 'sidebar.badge.event'),
    };
  };

  const formatRelativeTime = (timestamp: number) => {
    const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (diffSeconds < 10) return t(locale, 'time.justNow');
    if (diffSeconds < 60) return t(locale, 'time.secondsAgo', { count: diffSeconds });
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return t(locale, 'time.minutesAgo', { count: diffMinutes });
    const diffHours = Math.floor(diffMinutes / 60);
    return t(locale, 'time.hoursAgo', { count: diffHours });
  };

  const statusLabel = (status: AgentStatus) => t(locale, `status.${status}` as TranslationKey);

  if (!isOpen) {
    return null;
  }

  return (
    <aside aria-label={t(locale, 'sidebar.label')} className="absolute right-0 top-0 lg:relative w-[min(100%,24rem)] h-full bg-slate-900 border-l border-slate-800/90 flex flex-col z-20 shrink-0 text-slate-100 shadow-2xl overflow-hidden animate-in slide-in-from-right duration-200">
      {/* Sidebar Header with Mode Tabs & Hide Button */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/90 backdrop-blur-md">
        <div role="group" aria-label={t(locale, 'sidebar.views')} className="flex items-center gap-1 bg-slate-950/80 p-0.5 rounded-lg border border-slate-800">
          <button
            type="button"
            onClick={() => setActiveTab('timeline')}
            aria-pressed={activeTab === 'timeline'}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors ${
              activeTab === 'timeline'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Radio className="w-3.5 h-3.5 text-emerald-400 animate-pulse" aria-hidden="true" />
            <span>{t(locale, 'sidebar.liveTab')}</span>
          </button>

          {selectedAgent && (
            <button
              onClick={() => setActiveTab('inspector')}
              aria-pressed={activeTab === 'inspector'}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors ${
                activeTab === 'inspector'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <UserCheck className="w-3.5 h-3.5 text-sky-400" aria-hidden="true" />
              <span>{t(locale, 'sidebar.inspectorTab')}</span>
            </button>
          )}
        </div>

        {/* Hide / Collapse Sidebar Button */}
        <button
          onClick={onToggleOpen}
          title={t(locale, 'sidebar.hide')}
          aria-label={t(locale, 'sidebar.hide')}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 text-xs font-medium transition-colors"
        >
          <PanelRightClose className="w-4 h-4 text-slate-400" aria-hidden="true" />
          <span className="hidden sm:inline" aria-hidden="true">{t(locale, 'sidebar.hideShort')}</span>
        </button>
      </div>

      {/* VIEW 1: LIVE TIMELINE */}
      {activeTab === 'timeline' && (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Oficina Virtual Status Card (Moved from Canvas to Sidebar Header above Tasks) */}
          <div className="px-4 py-3 bg-slate-950/70 border-b border-slate-800/80 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
              <div>
                <span className="font-bold text-white text-xs block">{t(locale, 'sidebar.officeTitle')}</span>
                <span className="text-[11px] text-slate-400">
                  {t(locale, 'sidebar.officeSummary', { count: agents.length })}
                </span>
              </div>
            </div>

            {activeMeetingId ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                <Users className="w-3 h-3 text-emerald-400" aria-hidden="true" />
                <span>{t(locale, 'sidebar.meeting')}</span>
              </span>
            ) : (
              <span className="text-[10px] font-mono text-slate-300 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                {t(locale, 'sidebar.live')}
              </span>
            )}
          </div>

          {/* Active Task Banner */}
          {activeTask && (
            <div className="px-4 py-3 bg-indigo-950/30 border-b border-indigo-900/40">
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="font-semibold text-indigo-200 flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5 text-indigo-400" aria-hidden="true" />
                  <span>{activeTask.id}</span>
                </span>
                <span className="text-[11px] font-mono text-indigo-300 tabular-nums">
                  {activeTask.progress}%
                </span>
              </div>
              <p className="text-xs text-slate-200 font-medium line-clamp-1 mb-2">
                {localizeDemoText(activeTask.title, locale)}
              </p>
              <div
                role="progressbar"
                aria-label={t(locale, 'sidebar.taskProgress', { task: activeTask.id })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={activeTask.progress}
                className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden"
              >
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                  style={{ width: `${activeTask.progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Quick Category Filter Pills */}
          <div role="group" aria-labelledby="av-sidebar-filter-label" className="flex items-center gap-1 px-4 py-2 border-b border-slate-800/80 bg-slate-900/50 text-[11px] overflow-x-auto no-scrollbar">
            <span id="av-sidebar-filter-label" className="text-slate-400 font-medium mr-1 flex items-center gap-1 shrink-0">
              <Filter className="w-3 h-3 text-slate-400" aria-hidden="true" />
              {t(locale, 'sidebar.filterLabel')}
            </span>
            <button
              onClick={() => setFilterCategory('all')}
              aria-pressed={filterCategory === 'all'}
              className={`px-2.5 py-1 rounded-md font-medium shrink-0 transition-colors ${
                filterCategory === 'all'
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t(locale, 'sidebar.filterAll', { count: events.length })}
            </button>
            <button
              onClick={() => setFilterCategory('tasks')}
              aria-pressed={filterCategory === 'tasks'}
              className={`px-2.5 py-1 rounded-md font-medium shrink-0 transition-colors ${
                filterCategory === 'tasks'
                  ? 'bg-slate-800 text-indigo-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t(locale, 'timeline.tasks')}
            </button>
            <button
              onClick={() => setFilterCategory('tools')}
              aria-pressed={filterCategory === 'tools'}
              className={`px-2.5 py-1 rounded-md font-medium shrink-0 transition-colors ${
                filterCategory === 'tools'
                  ? 'bg-slate-800 text-sky-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t(locale, 'timeline.tools')}
            </button>
            <button
              onClick={() => setFilterCategory('messages')}
              aria-pressed={filterCategory === 'messages'}
              className={`px-2.5 py-1 rounded-md font-medium shrink-0 transition-colors ${
                filterCategory === 'messages'
                  ? 'bg-slate-800 text-amber-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t(locale, 'timeline.messages')}
            </button>
          </div>

          {/* Vertical Timeline Feed */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 relative">
            {filteredEvents.length === 0 ? (
              <div className="py-12 text-center text-slate-400 text-xs flex flex-col items-center gap-2">
                <Radio className="w-6 h-6 text-slate-400 animate-pulse" aria-hidden="true" />
                <span>{t(locale, 'sidebar.waiting')}</span>
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
                        aria-hidden="true"
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
                        title={t(locale, 'sidebar.cardHint')}
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
                                title={t(locale, 'sidebar.selectAgent', { name: sourceAgent.name })}
                                className="font-semibold text-xs text-white hover:text-sky-400 min-w-0 text-left transition-colors flex items-center gap-1"
                              >
                                <span className="shrink-0 max-w-[70%] truncate">{sourceAgent.name}</span>
                                <span className="min-w-0 text-[10px] text-slate-400 font-normal truncate">
                                  ({localizeDemoText(sourceAgent.roleTitle, locale)})
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
                            <span className="text-[10px] font-mono text-slate-400">
                              {formatRelativeTime(ev.timestamp)}
                            </span>
                          </div>
                        </div>

                        {/* Summary / Text */}
                        <p className="text-xs text-slate-200 leading-relaxed mb-2 font-normal">
                          {localizeDemoText(ev.summary, locale)}
                        </p>

                        {/* Payload / Tool Details Tag */}
                        {ev.payload?.tool && (
                          <div className="flex items-center gap-1.5 text-[10px] font-mono text-sky-300 bg-sky-950/50 px-2 py-1 rounded border border-sky-800/40">
                            <Terminal className="w-3 h-3 text-sky-400 shrink-0" aria-hidden="true" />
                            <span className="truncate">{ev.payload.tool}</span>
                          </div>
                        )}

                        {/* Focus Agent Quick Action on hover */}
                        {sourceAgent && (
                          <div className="mt-2 pt-2 border-t border-slate-900 flex items-center justify-between text-[11px] text-slate-400">
                            <span className="text-[10px] text-slate-400 font-mono">
                              {statusLabel(sourceAgent.status)}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                onSelectAgent(sourceAgent.id);
                                onFocusAgent(sourceAgent);
                              }}
                              aria-label={t(locale, 'sidebar.focusAgentInOffice', { name: sourceAgent.name })}
                              className="inline-flex items-center gap-1 text-[10px] text-slate-400 hover:text-sky-400 transition-colors"
                            >
                              <Eye className="w-3 h-3" aria-hidden="true" />
                              <span>{t(locale, 'sidebar.focusInOffice')}</span>
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
                <h2
                  onDoubleClick={() => onOpenAgentDetailModal && onOpenAgentDetailModal(selectedAgent.id)}
                  title={t(locale, 'sidebar.detailHint')}
                  className="font-bold text-white text-sm truncate cursor-pointer hover:text-sky-300 transition-colors"
                >
                  {selectedAgent.name}
                </h2>
                <div className="flex items-center gap-1">
                  {onOpenAgentDetailModal && (
                    <button
                      onClick={() => onOpenAgentDetailModal(selectedAgent.id)}
                      className="p-1 rounded text-slate-400 hover:text-sky-300 hover:bg-slate-800 transition-colors"
                      title={t(locale, 'sidebar.openProfile')}
                      aria-label={t(locale, 'sidebar.openProfile')}
                    >
                      <Maximize2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  )}
                  <button
                    onClick={() => onFocusAgent(selectedAgent)}
                    className="p-1 rounded text-slate-400 hover:text-sky-400 hover:bg-slate-800 transition-colors"
                    title={t(locale, 'sidebar.focusInOffice')}
                    aria-label={t(locale, 'sidebar.focusInOffice')}
                  >
                    <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <p className="text-xs text-sky-400 font-medium">{localizeDemoText(selectedAgent.roleTitle, locale)}</p>
              <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                {selectedAgent.provider} · {selectedAgent.model}
              </p>
            </div>
          </div>

          {/* Quick Metrics */}
          <div className="grid grid-cols-2 gap-2 p-4 border-b border-slate-800/80">
            <div className="bg-slate-950/70 p-2.5 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-semibold">
                {t(locale, 'sidebar.currentStatus')}
              </span>
              <span className="text-xs font-semibold text-emerald-400 mt-0.5 block truncate">
                {statusLabel(selectedAgent.status)}
              </span>
            </div>
            <div className="bg-slate-950/70 p-2.5 rounded-lg border border-slate-800">
              <span className="text-[10px] text-slate-400 uppercase tracking-wider block font-semibold">
                {t(locale, 'sidebar.cost')}
              </span>
              <span className="text-xs font-mono font-medium text-slate-200 mt-0.5 block truncate">
                ${selectedAgent.cost.toFixed(3)}
              </span>
            </div>
          </div>

          {/* Status Message */}
          <div className="px-4 py-3 border-b border-slate-800/80">
            <span className="text-[10px] text-slate-400 uppercase font-semibold block mb-1">
              {t(locale, 'sidebar.currentActivity')}
            </span>
            <p className="text-xs text-slate-300 italic bg-slate-950/50 p-2.5 rounded-lg border border-slate-800/60">
              "{localizeDemoText(selectedAgent.statusText, locale)}"
            </p>
          </div>

          {/* Send Instruction Input */}
          <div className="p-4 border-b border-slate-800/80">
            <label htmlFor="av-sidebar-instruction" className="text-[10px] text-slate-400 uppercase font-semibold block mb-1.5">
              {t(locale, 'sidebar.sendMessage')}
            </label>
            <form onSubmit={handleSendInstruction} className="flex gap-2">
              <input
                id="av-sidebar-instruction"
                type="text"
                value={instructionText}
                onChange={(e) => setInstructionText(e.target.value)}
                placeholder={t(locale, 'sidebar.messagePlaceholder')}
                className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-sky-500"
              />
              <button
                type="submit"
                disabled={!instructionText.trim()}
                aria-label={t(locale, 'sidebar.send')}
                title={t(locale, 'sidebar.send')}
                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors flex items-center justify-center"
              >
                <Send className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </form>
          </div>

          {/* Return to Timeline Button */}
          <div className="p-4">
            <button
              onClick={() => setActiveTab('timeline')}
              className="w-full py-2 px-3 rounded-lg border border-slate-800 hover:bg-slate-800 text-xs text-slate-300 hover:text-white transition-colors flex items-center justify-center gap-1.5"
            >
              <Radio className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              <span>{t(locale, 'sidebar.backToTimeline')}</span>
            </button>
          </div>
        </div>
      )}
    </aside>
  );
};
