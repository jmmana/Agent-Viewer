import React, { useState, useMemo } from 'react';
import { Agent, ViewerEvent } from '../types/agent';
import { OfficeCanvas } from '../components/OfficeCanvas';
import { Locale } from '../i18n';
import type { CanonicalEvent } from '../integrations/canonicalContract';

export interface AgentOfficeProps {
  agents: Agent[];
  events?: CanonicalEvent[] | ViewerEvent[];
  locale?: Locale;
  messages?: Record<string, string>;
  t?: (key: string, params?: Record<string, any>) => string;
  theme?: 'dark' | 'light';
  mode?: 'live' | 'demo';
  showUsage?: boolean;
  onSelectAgent?: (agentId: string | null) => void;
  className?: string;
  activeMeetingId?: string | null;
}

/**
 * Reusable AgentOffice component for embedding in external applications like AQA.
 * Self-contained without external app shell dependencies.
 */
export const AgentOffice: React.FC<AgentOfficeProps> = ({
  agents,
  locale = 'en',
  theme = 'dark',
  mode = 'live',
  showUsage = true,
  onSelectAgent,
  className = '',
  activeMeetingId = null,
}) => {
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(null);

  const handleSelect = (agentId: string | null) => {
    setInternalSelectedId(agentId);
    if (onSelectAgent) {
      onSelectAgent(agentId);
    }
  };

  const totalTokens = useMemo(() => {
    return agents.reduce(
      (acc, agent) => ({
        input: acc.input + (agent.tokensInput || 0),
        output: acc.output + (agent.tokensOutput || 0),
        cost: acc.cost + (agent.cost || 0),
      }),
      { input: 0, output: 0, cost: 0 },
    );
  }, [agents]);

  return (
    <div className={`relative w-full h-full flex flex-col overflow-hidden select-none ${theme} ${className}`}>
      {/* Top telemetry pill if showUsage is enabled */}
      {showUsage && (
        <div className="absolute top-3 left-3 z-20 flex items-center gap-2 bg-slate-900/90 backdrop-blur-md px-3 py-1.5 rounded-xl border border-slate-800 shadow-lg text-xs font-mono">
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${mode === 'live' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
            <span className="text-slate-300 font-semibold">{mode === 'live' ? 'LIVE' : 'DEMO'}</span>
          </span>
          <span className="text-slate-600">|</span>
          <span className="text-slate-400">Agents:</span>
          <span className="text-slate-100 font-bold">{agents.length}</span>
          <span className="text-slate-600">|</span>
          <span className="text-slate-400">Tokens:</span>
          <span className="text-cyan-400 font-bold">{((totalTokens.input + totalTokens.output) / 1000).toFixed(1)}K</span>
          <span className="text-slate-600">|</span>
          <span className="text-emerald-400 font-bold">${totalTokens.cost.toFixed(3)}</span>
        </div>
      )}

      {/* Interactive Office Canvas */}
      <div className="flex-1 w-full h-full relative overflow-hidden">
        <OfficeCanvas
          agents={agents}
          selectedAgentId={internalSelectedId}
          onSelectAgent={handleSelect}
          activeMeetingId={activeMeetingId}
          theme={theme}
          locale={locale}
        />
      </div>
    </div>
  );
};
