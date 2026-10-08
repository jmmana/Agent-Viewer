import React, { useId, useState } from 'react';
import { Agent } from '../types/agent';
import type { Locale } from '../i18n';
import { t, type TranslationKey } from '../i18n';
import { localizeDemoText } from '../content/demoScript';
import { X, Sparkles, Send, ShieldCheck, Database, BookOpen, CheckSquare } from 'lucide-react';

interface NewTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  agents: Agent[];
  locale: Locale;
  onSubmitTask: (
    title: string,
    description: string,
    assignedRole: 'backend_engineer' | 'frontend_engineer' | 'research_lead' | 'qa_engineer' | 'security_analyst'
  ) => void;
}

type AssignableRole = 'backend_engineer' | 'frontend_engineer' | 'research_lead' | 'qa_engineer' | 'security_analyst';

const ASSIGNABLE_ROLES: AssignableRole[] = ['backend_engineer', 'research_lead', 'frontend_engineer', 'qa_engineer', 'security_analyst'];

const PRESET_TASKS = [
  { id: 'security', role: 'security_analyst' as const, icon: ShieldCheck },
  { id: 'database', role: 'backend_engineer' as const, icon: Database },
  { id: 'rag', role: 'research_lead' as const, icon: BookOpen },
  { id: 'e2e', role: 'qa_engineer' as const, icon: CheckSquare },
] as const;

type PresetId = (typeof PRESET_TASKS)[number]['id'];

const presetTitle = (locale: Locale, id: PresetId) => t(locale, `newTask.preset.${id}.title` as TranslationKey);
const presetDescription = (locale: Locale, id: PresetId) => t(locale, `newTask.preset.${id}.description` as TranslationKey);

export const NewTaskModal: React.FC<NewTaskModalProps> = ({
  isOpen,
  onClose,
  agents,
  locale,
  onSubmitTask,
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignedRole, setAssignedRole] = useState<AssignableRole>('backend_engineer');
  const titleId = useId();
  const objectiveId = useId();
  const descriptionId = useId();
  const assignId = useId();

  if (!isOpen) return null;

  // The options name the agents that really hold each role in the current office.
  const roleOption = (role: AssignableRole) => {
    const agent = agents.find((item) => item.role === role);
    const roleName = t(locale, `newTask.roleFallback.${role}` as TranslationKey);
    if (!agent) return roleName;
    return t(locale, 'newTask.agentOption', {
      name: agent.name,
      role: agent.roleTitle ? localizeDemoText(agent.roleTitle, locale) : roleName,
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmitTask(title.trim(), description.trim() || t(locale, 'newTask.defaultDescription'), assignedRole);
    setTitle('');
    setDescription('');
    onClose();
  };

  const handleSelectPreset = (preset: (typeof PRESET_TASKS)[number]) => {
    setTitle(presetTitle(locale, preset.id));
    setDescription(presetDescription(locale, preset.id));
    setAssignedRole(preset.role);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-slate-100"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-indigo-600/20 text-indigo-400 border border-indigo-500/20">
              <Sparkles className="w-4 h-4" aria-hidden="true" />
            </div>
            <div>
              <h2 id={titleId} className="text-sm font-bold text-white">{t(locale, 'newTask.title')}</h2>
              <p className="text-xs text-slate-400">{t(locale, 'newTask.subtitle')}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t(locale, 'common.closeDialog')}
            title={t(locale, 'common.close')}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Presets Quick Picker */}
        <div className="p-6 border-b border-slate-800 bg-slate-950/40 space-y-3">
          <span className="text-[11px] font-semibold uppercase text-slate-400 tracking-wide block">
            {t(locale, 'newTask.templates')}
          </span>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {PRESET_TASKS.map((preset) => {
              const Icon = preset.icon;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => handleSelectPreset(preset)}
                  className="flex items-start gap-2.5 p-2.5 text-left rounded-lg bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-indigo-500/40 text-xs transition-colors group"
                >
                  <Icon className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" aria-hidden="true" />
                  <div>
                    <span className="font-semibold text-slate-200 group-hover:text-white block">
                      {presetTitle(locale, preset.id)}
                    </span>
                    <span className="text-[11px] text-slate-400 line-clamp-1">
                      {presetDescription(locale, preset.id)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Task Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={objectiveId} className="text-xs font-medium text-slate-300 block">{t(locale, 'newTask.objective')}</label>
            <input
              id={objectiveId}
              type="text"
              required
              placeholder={t(locale, 'newTask.objectivePlaceholder')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={descriptionId} className="text-xs font-medium text-slate-300 block">{t(locale, 'newTask.description')}</label>
            <textarea
              id={descriptionId}
              rows={3}
              placeholder={t(locale, 'newTask.descriptionPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500 resize-none"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor={assignId} className="text-xs font-medium text-slate-300 block">{t(locale, 'newTask.assign')}</label>
            <select
              id={assignId}
              value={assignedRole}
              onChange={(e) => setAssignedRole(e.target.value as AssignableRole)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              {ASSIGNABLE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {roleOption(role)}
                </option>
              ))}
            </select>
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white rounded-lg transition-colors"
            >
              {t(locale, 'newTask.cancel')}
            </button>
            <button
              type="submit"
              disabled={!title.trim()}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:pointer-events-none rounded-lg transition-colors shadow-sm"
            >
              <Send className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{t(locale, 'newTask.dispatch')}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
