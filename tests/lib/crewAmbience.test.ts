import { describe, expect, it } from 'vitest';
import { CREW_AMBIENCES, resolveCrewAmbience, validateCrewAmbienceByRoom } from '../../src/crew/crewAmbience';
import { validateCrewPreferences, defaultCrewPreferences } from '../../src/crew/crewPreferences';
import { drawCrewAmbience } from '../../src/crew/crewAmbienceLayer';
import { CREW_ROOMS, CREW_VIEWS } from '../../src/crew/crewModel';
import { crewIsoPoint } from '../../src/crew/renderCrewRoom';

describe('Crew room ambience #148', () => {
  it.each([[0, 'night'], [4, 'night'], [5, 'dawn'], [7, 'dawn'], [8, 'day'], [16, 'day'], [17, 'sunset'], [19, 'sunset'], [20, 'night'], [23, 'night']] as const)(
    'resolves automatic local hour %i to %s', (hour, expected) => expect(resolveCrewAmbience('auto', hour)).toBe(expected));
  it('manual mode is independent of the clock', () => {
    for (const mode of CREW_AMBIENCES) for (const hour of [0, 6, 12, 18]) expect(resolveCrewAmbience(mode, hour)).toBe(mode);
  });
  it('keeps only valid room overrides and preserves old preferences', () => {
    expect(validateCrewAmbienceByRoom({ ceo: 'night', development: 'day', qa: 'auto', finance: 'invalid', unknown: 'day' }))
      .toEqual({ ceo: 'night', development: 'day', qa: 'auto' });
    for (const value of [null, [], 'night', 42]) expect(validateCrewAmbienceByRoom(value)).toEqual({});
    expect(validateCrewPreferences(defaultCrewPreferences())).toEqual(defaultCrewPreferences());
    const preferences = { ...defaultCrewPreferences(), ambienceByRoom: { ceo: 'night', development: 'day' } };
    expect(validateCrewPreferences(JSON.parse(JSON.stringify(preferences)))).toEqual(preferences);
  });
  it('projects exactly two visible windows in every room/view, with no invalid geometry', () => {
    for (const room of CREW_ROOMS) for (const view of CREW_VIEWS) {
      let frameCount = 0;
      let fill = '';
      const ctx = new Proxy({} as CanvasRenderingContext2D, {
        get: (_target, key) => (...args: unknown[]) => {
          if (key === 'fill' && fill === '#1f355b') frameCount++;
          if (key === 'moveTo' || key === 'lineTo') expect(args.every(Number.isFinite)).toBe(true);
        },
        set: (_target, key, value) => { if (key === 'fillStyle') fill = value; return true; },
      });
      drawCrewAmbience(ctx, room, view, { isoPoint: crewIsoPoint, wallHeight: 64 }, 'night');
      expect(frameCount).toBe(2);
    }
  });
  it('high contrast removes light pools and uses the same palette in every phase', () => {
    const draw = (ambience: typeof CREW_AMBIENCES[number]) => {
      const colors: unknown[] = [];
      const ctx = new Proxy({} as CanvasRenderingContext2D, { get: () => () => {}, set: (_target, key, value) => {
        if (key === 'fillStyle') colors.push(value);
        if (key === 'globalAlpha') throw new Error('High contrast must not tint the floor');
        return true;
      } });
      drawCrewAmbience(ctx, CREW_ROOMS[0], 'front', { isoPoint: crewIsoPoint, wallHeight: 64 }, ambience, true);
      return new Set(colors);
    };
    expect(draw('day')).toEqual(draw('night'));
  });
});
