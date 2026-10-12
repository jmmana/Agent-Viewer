import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { CrewStage } from '../../src/crew/CrewStage';
import { defaultCrewPreferences } from '../../src/crew/crewPreferences';

for (const viewerMode of ['LIVE', 'DEMO', 'REPLAY'] as const) {
  it(`changes visual ambience in an empty ${viewerMode} room without creating actors`, () => {
    const onChange = vi.fn();
    const preferences = { ...defaultCrewPreferences(), ambienceByRoom: { development: 'sunset' as const } };
    const { getByLabelText, container } = render(<CrewStage locale="es" agents={[]} viewerMode={viewerMode}
      selectedRoomId="ceo" preferences={preferences} onPreferencesChange={onChange} persistCamera={false} />);
    fireEvent.change(getByLabelText('Ambiente'), { target: { value: 'night' } });
    expect(onChange).toHaveBeenCalledWith({ ...preferences, ambienceByRoom: { development: 'sunset', ceo: 'night' } });
    expect(container.textContent).toContain('Agentes en esta oficina: 0');
    // Controlled preferences remain authoritative until the host supplies the update.
    expect(container.querySelector('canvas')?.getAttribute('data-crew-ambience')).toBe('day');
  });
}

describe('automatic clock lifecycle', () => {
  it('releases its interval and focus listener on unmount', () => {
    const interval = vi.spyOn(window, 'setInterval');
    const clear = vi.spyOn(window, 'clearInterval');
    const remove = vi.spyOn(window, 'removeEventListener');
    try {
      const { unmount } = render(<CrewStage agents={[]} persistCamera={false}
        preferences={{ ...defaultCrewPreferences(), ambienceByRoom: { ceo: 'auto' } }} />);
      const index = interval.mock.calls.findIndex(call => call[1] === 30_000);
      expect(index).toBeGreaterThanOrEqual(0);
      unmount();
      expect(clear).toHaveBeenCalledWith(interval.mock.results[index].value);
      expect(remove).toHaveBeenCalledWith('focus', expect.any(Function));
    } finally { vi.restoreAllMocks(); }
  });
});
