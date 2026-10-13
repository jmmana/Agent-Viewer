import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CrewStage } from '../../src/crew/CrewStage';
import { readCrewCharacterAppearanceStore } from '../../src/crew/crewCharacterStore';
import { CREW_HAIRSTYLE_OPTIONS } from '../../src/crew/crewCharacterCatalog';
import type { Agent } from '../../src/types/agent';

const agent = (id: string, role: Agent['role']): Agent => ({
  id, name: `Fixture ${id}`, role, status: 'CODING', workspace: 'boss_office', x: 0, y: 0, targetX: 0, targetY: 0,
} as Agent);

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('Character editor reachable from the agent list (#127)', () => {
  it('shows one collapsible appearance panel per visible agent, collapsed by default', () => {
    const agents = [agent('agent-1', 'boss'), agent('agent-2', 'qa_engineer')];
    render(<CrewStage agents={agents} locale="en" selectedRoomId="ceo" persistCamera={false} />);
    const panelOne = screen.getByTestId('crew-character-panel-agent-1');
    const panelTwo = screen.getByTestId('crew-character-panel-agent-2');
    expect(panelOne.tagName).toBe('DETAILS');
    expect((panelOne as HTMLDetailsElement).open).toBe(false);
    expect((panelTwo as HTMLDetailsElement).open).toBe(false);
  });

  it('persists a change to one agent, isolated from another, through the real CrewStage tree', () => {
    const agents = [agent('agent-1', 'boss'), agent('agent-2', 'qa_engineer')];
    render(<CrewStage agents={agents} locale="en" selectedRoomId="ceo" persistCamera={false} />);
    const panelOne = screen.getByTestId('crew-character-panel-agent-1');
    fireEvent.click(within(panelOne).getByText('Customize appearance: Fixture agent-1'));
    const hairstyleSelect = within(panelOne).getByRole('combobox', { name: 'Hairstyle' });
    fireEvent.change(hairstyleSelect, { target: { value: CREW_HAIRSTYLE_OPTIONS[2].id } });

    const store = readCrewCharacterAppearanceStore();
    expect(store.byAgentId['agent-1'].hairstyleId).toBe(CREW_HAIRSTYLE_OPTIONS[2].id);
    expect(store.byAgentId['agent-2']).toBeUndefined();
  });

  it('never touches the agent walking position, status, or any other domain field', () => {
    const agents = [agent('agent-1', 'boss')];
    const before = JSON.stringify(agents);
    render(<CrewStage agents={agents} locale="en" selectedRoomId="ceo" persistCamera={false} />);
    const panel = screen.getByTestId('crew-character-panel-agent-1');
    fireEvent.click(within(panel).getByText('Customize appearance: Fixture agent-1'));
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Clothing' }), { target: { value: within(panel).getByRole('combobox', { name: 'Clothing' }).querySelectorAll('option')[2].getAttribute('value') } });
    expect(JSON.stringify(agents)).toBe(before);
  });
});
