import React, { useState } from 'react';
import { Agent, AgentRole } from '../types/agent';
import { X, Sparkles, Send, ShieldCheck, Database, BookOpen, CheckSquare } from 'lucide-react';

interface NewTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  agents: Agent[];
  onSubmitTask: (
    title: string,
    description: string,
    assignedRole: 'backend_engineer' | 'frontend_engineer' | 'research_lead' | 'qa_engineer' | 'security_analyst'
  ) => void;
}

const PRESET_TASKS = [
  {
    title: 'Run Security Audit & Secret Leak Scanner',
    description: 'Scan codebase and git commit history for hardcoded tokens, OAuth credentials, and CVE alerts.',
    role: 'security_analyst' as const,
    icon: ShieldCheck,
  },
  {
    title: 'PostgreSQL Database Migration & Index Tuning',
    description: 'Draft DDL migration scripts, add compound indexes on query paths, and measure p99 latency.',
    role: 'backend_engineer' as const,
    icon: Database,
  },
  {
    title: 'RAG Vector Index Pipeline & Scientific Citation Ingest',
    description: 'Embed technical RFC documentation into vector knowledge store for instant sub-second retrieval.',
    role: 'research_lead' as const,
    icon: BookOpen,
  },
  {
    title: 'Automated Playwright E2E Visual Regression Suite',
    description: 'Execute automated headless browser tests across all desktop and mobile viewports.',
    role: 'qa_engineer' as const,
    icon: CheckSquare,
  },
];

export const NewTaskModal: React.FC<NewTaskModalProps> = ({
  isOpen,
  onClose,
  agents,
  onSubmitTask,
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignedRole, setAssignedRole] = useState<'backend_engineer' | 'frontend_engineer' | 'research_lead' | 'qa_engineer' | 'security_analyst'>('backend_engineer');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmitTask(title.trim(), description.trim() || 'Custom goal dispatched from console.', assignedRole);
    setTitle('');
    setDescription('');
    onClose();
  };

  const handleSelectPreset = (preset: typeof PRESET_TASKS[0]) => {
    setTitle(preset.title);
    setDescription(preset.description);
    setAssignedRole(preset.role);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-slate-100">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-indigo-600/20 text-indigo-400 border border-indigo-500/20">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Dispatch Custom Task</h3>
              <p className="text-xs text-slate-400">Instruct the multi-agent virtual organization</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Presets Quick Picker */}
        <div className="p-6 border-b border-slate-800 bg-slate-950/40 space-y-3">
          <span className="text-[11px] font-semibold uppercase text-slate-400 tracking-wide block">
            Quick Goal Templates
          </span>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {PRESET_TASKS.map((preset, idx) => {
              const Icon = preset.icon;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => handleSelectPreset(preset)}
                  className="flex items-start gap-2.5 p-2.5 text-left rounded-lg bg-slate-900 hover:bg-slate-850 border border-slate-800 hover:border-indigo-500/40 text-xs transition-colors group"
                >
                  <Icon className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold text-slate-200 group-hover:text-white block">
                      {preset.title}
                    </span>
                    <span className="text-[11px] text-slate-500 line-clamp-1">
                      {preset.description}
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
            <label className="text-xs font-medium text-slate-300 block">Task Objective / Title</label>
            <input
              type="text"
              required
              placeholder="e.g. Implement Webhook Dispatcher with Exponential Backoff"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300 block">Description & Acceptance Criteria</label>
            <textarea
              rows={3}
              placeholder="Outline specific technical deliverables, security constraints, and endpoints..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 resize-none"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-300 block">Assign Primary Lead Agent</label>
            <select
              value={assignedRole}
              onChange={(e) => setAssignedRole(e.target.value as any)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="backend_engineer">Elena Rostova — Backend Engineer (APIs, DB, Architecture)</option>
              <option value="research_lead">Dr. Maya Chen — Research Lead (RFCs, RAG, Web Search)</option>
              <option value="frontend_engineer">Kenji Sato — Frontend Engineer (UI, Canvas, React)</option>
              <option value="qa_engineer">Zoe Vance — QA & Test Automation (Tests, Regression, Fuzzing)</option>
              <option value="security_analyst">Marcus Brody — Security Analyst (Audits, Pentest, Secrets)</option>
            </select>
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim()}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:pointer-events-none rounded-lg transition-colors shadow-sm"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Dispatch to Organization</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
