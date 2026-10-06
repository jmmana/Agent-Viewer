import React from 'react';
import { Task, Agent } from '../types/agent';
import type { Locale } from '../i18n';
import { t } from '../i18n';
import {
  Layers,
  CheckCircle2,
  Clock,
  AlertTriangle,
  FileCode,
  FileText,
  GitPullRequest,
  Check,
  ArrowRight,
  Sparkles,
} from 'lucide-react';

interface TaskBoardProps {
  tasks: Task[];
  agents: Agent[];
  onSelectAgent: (agentId: string) => void;
  onOpenAgentDetail?: (agentId: string) => void;
  onOpenNewTask: () => void;
  locale: Locale;
}

export const TaskBoard: React.FC<TaskBoardProps> = ({
  tasks,
  agents,
  onSelectAgent,
  onOpenAgentDetail,
  onOpenNewTask,
  locale,
}) => {
  const getAgentName = (id: string) => {
    const a = agents.find((ag) => ag.id === id);
    return a ? a.name : id;
  };

  const getStatusColor = (status: Task['status']) => {
    switch (status) {
      case 'COMPLETED':
        return 'text-emerald-400 bg-emerald-950/60 border-emerald-800/60';
      case 'BLOCKED':
        return 'text-rose-400 bg-rose-950/60 border-rose-800/60';
      case 'IN_PROGRESS':
        return 'text-sky-400 bg-sky-950/60 border-sky-800/60';
      case 'REVIEW':
        return 'text-amber-400 bg-amber-950/60 border-amber-800/60';
      default:
        return 'text-slate-400 bg-slate-950/60 border-slate-800';
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 text-slate-100 overflow-y-auto p-6 space-y-6">
      {/* Header & Overview */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white font-sans">{t(locale, 'tasks.title')}</h2>
          <p className="text-xs text-slate-400">
            {t(locale, 'tasks.subtitle')}
          </p>
        </div>
        <button
          onClick={onOpenNewTask}
          className="px-3.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors shadow-sm"
        >
          + {t(locale, 'tasks.create')}
        </button>
      </div>

      {/* Visual Workflow DAG */}
      <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-800 space-y-3">
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
          {t(locale, 'tasks.dag')}
        </h3>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="bg-slate-950 px-3 py-2 rounded-lg border border-slate-800 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-indigo-400" />
            <span className="font-semibold text-white">Director</span>
            <span className="text-slate-500">Objective</span>
          </div>

          <ArrowRight className="w-4 h-4 text-slate-600" />

          <div className="bg-slate-950 px-3 py-2 rounded-lg border border-slate-800 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-sky-400" />
            <span className="font-semibold text-white">Tech & Research Leads</span>
            <span className="text-slate-500">Architecture & Specs</span>
          </div>

          <ArrowRight className="w-4 h-4 text-slate-600" />

          <div className="bg-slate-950 px-3 py-2 rounded-lg border border-slate-800 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            <span className="font-semibold text-white">Engineering Pod</span>
            <span className="text-slate-500">Code & Tools</span>
          </div>

          <ArrowRight className="w-4 h-4 text-slate-600" />

          <div className="bg-slate-950 px-3 py-2 rounded-lg border border-slate-800 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-purple-400" />
            <span className="font-semibold text-white">QA Lab</span>
            <span className="text-slate-500">Security & Tests</span>
          </div>

          <ArrowRight className="w-4 h-4 text-slate-600" />

          <div className="bg-slate-950 px-3 py-2 rounded-lg border border-emerald-800/80 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="font-semibold text-emerald-400">Release Verified</span>
          </div>
        </div>
      </div>

      {/* Task Cards List */}
      <div className="space-y-4">
        {tasks.length === 0 ? (
          <div className="text-center py-16 bg-slate-900/40 rounded-xl border border-slate-800 text-xs text-slate-500">
            {t(locale, 'tasks.empty')}
          </div>
        ) : (
          tasks.map((task) => (
            <div
              key={task.id}
              onDoubleClick={() => onOpenAgentDetail && onOpenAgentDetail(task.assignedAgentId)}
              title="Doble clic para ver expediente completo del agente asignado"
              className="bg-slate-900 p-5 rounded-xl border border-slate-800 space-y-4 hover:border-slate-700 transition-colors cursor-pointer select-none"
            >
              {/* Task Header */}
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2.5">
                    <span className="font-mono text-xs text-sky-400 bg-sky-950/80 px-2 py-0.5 rounded border border-sky-800/60 font-semibold">
                      {task.id}
                    </span>
                    <h3 className="text-base font-bold text-white">{task.title}</h3>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed max-w-2xl">
                    {task.description}
                  </p>
                </div>

                {/* Status Badge */}
                <span
                  className={`px-3 py-1 rounded-md text-xs font-semibold uppercase tracking-wider border font-mono ${getStatusColor(
                    task.status
                  )}`}
                >
                  {task.status}
                </span>
              </div>

              {/* Blocker alert if blocked */}
              {task.status === 'BLOCKED' && task.blockerReason && (
                <div className="flex items-start gap-2.5 p-3 rounded-lg bg-rose-950/50 border border-rose-900/60 text-xs text-rose-300">
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold block text-rose-200">Execution Blocked</span>
                    <p>{task.blockerReason}</p>
                  </div>
                </div>
              )}

              {/* Progress Bar */}
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono tabular-nums text-slate-400">
                  <span>{t(locale, 'tasks.progress')}</span>
                  <span className="text-slate-200 font-semibold">{task.progress}%</span>
                </div>
                <div className="w-full h-2 rounded-full bg-slate-950 overflow-hidden border border-slate-800">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      task.status === 'BLOCKED'
                        ? 'bg-rose-500'
                        : task.status === 'COMPLETED'
                        ? 'bg-emerald-500'
                        : 'bg-indigo-500'
                    }`}
                    style={{ width: `${task.progress}%` }}
                  />
                </div>
              </div>

              {/* Task Metadata & Telemetry Breakdown */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs bg-slate-950 p-3 rounded-lg border border-slate-800/80 font-mono tabular-nums">
                <div>
                  <span className="text-[10px] text-slate-500 block uppercase">{t(locale, 'tasks.assignedLead')}</span>
                  <button
                    onClick={() => {
                      onSelectAgent(task.assignedAgentId);
                      if (onOpenAgentDetail) onOpenAgentDetail(task.assignedAgentId);
                    }}
                    title="Clic para ver expediente completo"
                    className="font-medium text-sky-400 hover:text-sky-300 hover:underline"
                  >
                    {getAgentName(task.assignedAgentId)}
                  </button>
                </div>

                <div>
                  <span className="text-[10px] text-slate-500 block uppercase">{t(locale, 'tasks.tokens')}</span>
                  <span className="font-bold text-slate-200">
                    {task.tokensTotal.toLocaleString()}
                  </span>
                </div>

                <div>
                  <span className="text-[10px] text-slate-500 block uppercase">{t(locale, 'tasks.totalCost')}</span>
                  <span className="font-bold text-emerald-400">${task.costTotal.toFixed(3)}</span>
                </div>

                <div>
                  <span className="text-[10px] text-slate-500 block uppercase">{t(locale, 'tasks.collaborators')}</span>
                  <span className="text-slate-300">
                    {task.collaboratorIds.map((id) => getAgentName(id).split(' ')[0]).join(', ')}
                  </span>
                </div>
              </div>

              {/* Artifacts Created */}
              {task.artifacts.length > 0 && (
                <div className="space-y-2">
                  <span className="text-xs font-semibold text-slate-400 block uppercase tracking-wide">
                    {t(locale, 'tasks.deliverables')} ({task.artifacts.length})
                  </span>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {task.artifacts.map((art) => (
                      <div
                        key={art.id}
                        className="bg-slate-950 p-3 rounded-lg border border-slate-800 flex items-start gap-3"
                      >
                        <div className="p-2 rounded bg-indigo-950/60 border border-indigo-800/60 text-indigo-400">
                          {art.type === 'code' ? (
                            <FileCode className="w-4 h-4" />
                          ) : art.type === 'test_run' ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          ) : (
                            <FileText className="w-4 h-4 text-amber-400" />
                          )}
                        </div>
                        <div className="space-y-0.5 text-xs">
                          <span className="font-semibold text-slate-200 block">{art.name}</span>
                          <p className="text-slate-400 leading-snug text-[11px]">{art.summary}</p>
                          <span className="text-[10px] text-slate-500 font-mono">
                            Author: {getAgentName(art.authorId)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
