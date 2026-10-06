import React, { useState } from 'react';
import { ViewerEvent, Agent } from '../types/agent';
import type { Locale } from '../i18n';
import { t } from '../i18n';
import {
  Search,
  Filter,
  Download,
  AlertCircle,
  CheckCircle2,
  Terminal,
  MessageSquare,
  Users,
  Layers,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

interface ActivityTimelineProps {
  events: ViewerEvent[];
  agents: Agent[];
  onSelectAgent: (agentId: string) => void;
  locale: Locale;
}

export const ActivityTimeline: React.FC<ActivityTimelineProps> = ({
  events,
  agents,
  onSelectAgent,
  locale,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<'all' | 'task' | 'message' | 'meeting' | 'tool' | 'llm'>('all');
  const [selectedAgentFilter, setSelectedAgentFilter] = useState<string>('all');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  // Filter events
  const filteredEvents = events.filter((ev) => {
    // Category match
    if (selectedCategory !== 'all') {
      if (selectedCategory === 'task' && !ev.type.startsWith('task')) return false;
      if (selectedCategory === 'message' && !ev.type.startsWith('message')) return false;
      if (selectedCategory === 'meeting' && !ev.type.startsWith('meeting')) return false;
      if (selectedCategory === 'tool' && !ev.type.startsWith('tool')) return false;
      if (selectedCategory === 'llm' && !ev.type.startsWith('llm')) return false;
    }

    // Agent match
    if (selectedAgentFilter !== 'all') {
      if (ev.source !== selectedAgentFilter && ev.target !== selectedAgentFilter) {
        return false;
      }
    }

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        ev.summary.toLowerCase().includes(q) ||
        ev.type.toLowerCase().includes(q) ||
        (ev.taskId && ev.taskId.toLowerCase().includes(q))
      );
    }

    return true;
  });

  const handleExportJSON = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(events, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `agent_viewer_events_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const getEventIcon = (type: string, severity: string) => {
    if (severity === 'critical') return <AlertCircle className="w-4 h-4 text-rose-400" />;
    if (type.startsWith('task')) return <Layers className="w-4 h-4 text-indigo-400" />;
    if (type.startsWith('meeting')) return <Users className="w-4 h-4 text-emerald-400" />;
    if (type.startsWith('tool')) return <Terminal className="w-4 h-4 text-sky-400" />;
    if (type.startsWith('message')) return <MessageSquare className="w-4 h-4 text-amber-400" />;
    return <CheckCircle2 className="w-4 h-4 text-slate-400" />;
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 text-slate-100 overflow-hidden">
      {/* Top Controls & Filter Bar */}
      <div className="px-6 py-4 border-b border-slate-800 bg-slate-900/60 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <div className="relative w-full">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder={t(locale, 'timeline.search')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-sky-500"
            />
          </div>
        </div>

        {/* Category Filters (Interactive buttons, not pills) */}
        <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
          {[
            { id: 'all', label: t(locale, 'timeline.allEvents') },
            { id: 'task', label: t(locale, 'timeline.tasks') },
            { id: 'meeting', label: t(locale, 'timeline.meetings') },
            { id: 'tool', label: t(locale, 'timeline.tools') },
            { id: 'message', label: t(locale, 'timeline.messages') },
          ].map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id as any)}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors ${
                selectedCategory === cat.id
                  ? 'bg-slate-800 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>

        {/* Agent Filter & Export */}
        <div className="flex items-center gap-2">
          <select
            value={selectedAgentFilter}
            onChange={(e) => setSelectedAgentFilter(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none"
          >
            <option value="all">{t(locale, 'timeline.allAgents')}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>

          <button
            onClick={handleExportJSON}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors border border-slate-700/60"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{t(locale, 'timeline.export')}</span>
          </button>
        </div>
      </div>

      {/* Events Feed Container */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
        {filteredEvents.length === 0 ? (
          <div className="text-center py-16 text-slate-500 text-xs">
            {t(locale, 'timeline.empty')}
          </div>
        ) : (
          filteredEvents.map((ev) => {
            const isExpanded = expandedEventId === ev.id;
            return (
              <div
                key={ev.id}
                className={`bg-slate-900/80 hover:bg-slate-900 border rounded-xl p-3.5 transition-all ${
                  ev.severity === 'critical'
                    ? 'border-rose-900/60 shadow-sm shadow-rose-950/30'
                    : 'border-slate-800'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 p-1.5 rounded-lg bg-slate-950 border border-slate-800">
                      {getEventIcon(ev.type, ev.severity)}
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-semibold text-slate-200">{ev.summary}</span>
                        {ev.taskId && (
                          <span className="font-mono text-[11px] text-sky-400 bg-sky-950/60 px-1.5 py-0.5 rounded border border-sky-800/40">
                            {ev.taskId}
                          </span>
                        )}
                      </div>

                      {/* Clean metadata without pills */}
                      <div className="flex items-center gap-2 text-[11px] text-slate-500 font-mono tabular-nums">
                        <span>{new Date(ev.timestamp).toLocaleTimeString()}</span>
                        <span aria-hidden="true">·</span>
                        <span className="uppercase text-slate-400">{ev.type}</span>
                        <span aria-hidden="true">·</span>
                        <span>{t(locale, 'timeline.source')}: <button onClick={() => onSelectAgent(ev.source)} className="text-sky-400 hover:underline">{ev.source}</button></span>
                        {ev.target && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{t(locale, 'timeline.target')}: <button onClick={() => onSelectAgent(ev.target!)} className="text-indigo-400 hover:underline">{ev.target}</button></span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => setExpandedEventId(isExpanded ? null : ev.id)}
                    className="p-1 text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                </div>

                {/* Expanded Payload Inspector */}
                {isExpanded && ev.payload && Object.keys(ev.payload).length > 0 && (
                  <div className="mt-3 pt-3 border-t border-slate-800">
                    <span className="text-[10px] text-slate-500 uppercase font-mono block mb-1">
                      {t(locale, 'timeline.payload')}
                    </span>
                    <pre className="bg-slate-950 p-2.5 rounded-lg border border-slate-800/80 font-mono text-[11px] text-emerald-400 overflow-x-auto">
                      {JSON.stringify(ev.payload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
