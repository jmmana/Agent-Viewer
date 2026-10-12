import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { CrewStage } from '../../src/crew/CrewStage';
import { defaultCrewPreferences } from '../../src/crew/crewPreferences';
import { CREW_LAMPS_BY_ROOM } from '../../src/crew/crewLamps';

describe('Crew lamp controls #149', () => {
  it('cycles a single lamp through auto, on and off from its accessible button', () => {
    const onChange = vi.fn();
    const preferences = defaultCrewPreferences();
    const { getByTestId, rerender } = render(<CrewStage agents={[]} selectedRoomId="ceo"
      preferences={preferences} onPreferencesChange={onChange} persistCamera={false} />);
    const lampId = CREW_LAMPS_BY_ROOM.ceo.find(lamp => lamp.kind === 'desk')!.id;
    const button = getByTestId(`crew-lamp-${lampId}`);
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith({ ...preferences, lampsByRoom: { ceo: { [lampId]: 'on' } } });
    const afterFirstClick = { ...preferences, lampsByRoom: { ceo: { [lampId]: 'on' as const } } };
    rerender(<CrewStage agents={[]} selectedRoomId="ceo" preferences={afterFirstClick}
      onPreferencesChange={onChange} persistCamera={false} />);
    fireEvent.click(getByTestId(`crew-lamp-${lampId}`));
    expect(onChange).toHaveBeenLastCalledWith({ ...afterFirstClick, lampsByRoom: { ceo: { [lampId]: 'off' } } });
  });

  it('never changes another office when toggling a lamp, and never touches legacy state', () => {
    const onChange = vi.fn();
    const preferences = { ...defaultCrewPreferences(), lampsByRoom: { development: { 'dev-desk-1-lamp': 'on' as const } } };
    const { getByTestId } = render(<CrewStage agents={[]} selectedRoomId="ceo"
      preferences={preferences} onPreferencesChange={onChange} persistCamera={false} />);
    const lampId = CREW_LAMPS_BY_ROOM.ceo.find(lamp => lamp.kind === 'desk')!.id;
    fireEvent.click(getByTestId(`crew-lamp-${lampId}`));
    expect(onChange).toHaveBeenCalledWith({ ...preferences,
      lampsByRoom: { development: { 'dev-desk-1-lamp': 'on' }, ceo: { [lampId]: 'on' } } });
  });

  it('sets every lamp in the active office from the global control, leaving an empty room sensible', () => {
    const onChange = vi.fn();
    const preferences = defaultCrewPreferences();
    const { getByTestId, container } = render(<CrewStage agents={[]} selectedRoomId="ceo"
      preferences={preferences} onPreferencesChange={onChange} persistCamera={false} />);
    fireEvent.click(getByTestId('crew-lamps-all-on'));
    const expected = Object.fromEntries(CREW_LAMPS_BY_ROOM.ceo.map(lamp => [lamp.id, 'on']));
    expect(onChange).toHaveBeenCalledWith({ ...preferences, lampsByRoom: { ceo: expected } });
    expect(container.textContent).toContain('Agentes en esta oficina: 0');
  });
});
