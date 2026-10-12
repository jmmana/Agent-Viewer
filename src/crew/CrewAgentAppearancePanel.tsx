import React from 'react';
import type { Agent } from '../types/agent';
import { CrewCharacterEditor } from './CrewCharacterEditor';
import { useCrewCharacterAppearance } from './useCrewCharacterAppearance';

/**
 * Reachable entry point for the #127 character editor: one collapsible panel
 * per agent, each with its own `useCrewCharacterAppearance` instance so a
 * change to one agent's appearance never touches another's (#171 pattern).
 * Collapsed by default, same reasoning as the accessibility/lights panels:
 * keeps the agent list usable on narrow viewports without always showing
 * six selects per agent.
 */
export function CrewAgentAppearancePanel({ agentId, functionalRole, name, isEs, idPrefix }: {
  agentId: string;
  functionalRole: Agent['role'];
  name: string;
  isEs: boolean;
  idPrefix: string;
}) {
  const { appearance, update, reset } = useCrewCharacterAppearance(agentId, functionalRole);
  return <details data-testid={`${idPrefix}-character-panel-${agentId}`}>
    <summary style={{ cursor: 'pointer' }}>
      {isEs ? `Personalizar apariencia: ${name}` : `Customize appearance: ${name}`}
    </summary>
    <CrewCharacterEditor agentId={agentId} functionalRole={functionalRole} appearance={appearance}
      onChange={update} onReset={reset} isEs={isEs} idPrefix={`${idPrefix}-${agentId}`} />
  </details>;
}
