import { describe, expect, it } from 'vitest';
import {
  CREW_LAMPS_BY_ROOM, CREW_LAMP_MODES, crewLampIllumination, crewLampIsOn, crewLampVisible, crewRoomLamps,
  nextCrewLampMode, validateCrewLampsByRoom,
} from '../../src/crew/crewLamps';
import { validateCrewPreferences, defaultCrewPreferences } from '../../src/crew/crewPreferences';
import { CREW_ROOMS, CREW_VIEWS } from '../../src/crew/crewModel';

describe('Crew lamps #149', () => {
  it('derives one lamp per desk plus a ceiling fixture and four wall fixtures', () => {
    for (const room of CREW_ROOMS) {
      const lamps = crewRoomLamps(room);
      const desks = room.furniture.filter(item => item.type === 'desk').length;
      expect(lamps.filter(lamp => lamp.kind === 'desk' || lamp.kind === 'reception')).toHaveLength(desks);
      expect(lamps.filter(lamp => lamp.kind === 'ceiling')).toHaveLength(1);
      expect(lamps.filter(lamp => lamp.kind === 'wall')).toHaveLength(4);
      expect(new Set(lamps.map(lamp => lamp.id)).size).toBe(lamps.length);
      expect(CREW_LAMPS_BY_ROOM[room.id]).toEqual(lamps);
    }
  });

  it('is on when forced on, never on when forced off, and clock-driven only in auto', () => {
    expect(crewLampIsOn('on', 'day')).toBe(true);
    expect(crewLampIsOn('on', 'night')).toBe(true);
    expect(crewLampIsOn('off', 'night')).toBe(false);
    for (const ambience of ['dawn', 'day'] as const) expect(crewLampIsOn('auto', ambience)).toBe(false);
    for (const ambience of ['sunset', 'night'] as const) expect(crewLampIsOn('auto', ambience)).toBe(true);
    expect(crewLampIsOn(undefined, 'night')).toBe(true);
  });

  it('cycles manual modes in a fixed order without reading the clock', () => {
    expect(nextCrewLampMode('auto')).toBe('on');
    expect(nextCrewLampMode('on')).toBe('off');
    expect(nextCrewLampMode('off')).toBe('auto');
    expect(nextCrewLampMode(undefined)).toBe('on');
    expect(new Set(CREW_LAMP_MODES.map(mode => nextCrewLampMode(mode)))).toEqual(new Set(CREW_LAMP_MODES));
  });

  it('keeps only known rooms, lamp ids and modes', () => {
    const room = CREW_ROOMS[0];
    const lamp = CREW_LAMPS_BY_ROOM[room.id][0];
    expect(validateCrewLampsByRoom({
      [room.id]: { [lamp.id]: 'on', 'unknown-lamp': 'on', other: 42 },
      'unknown-room': { [lamp.id]: 'on' },
    })).toEqual({ [room.id]: { [lamp.id]: 'on' } });
    for (const value of [null, [], 'on', 42, undefined]) expect(validateCrewLampsByRoom(value)).toEqual({});
    expect(validateCrewLampsByRoom({ [room.id]: {} })).toEqual({});
  });

  it('round-trips through Crew preferences validation', () => {
    expect(validateCrewPreferences(defaultCrewPreferences())).toEqual(defaultCrewPreferences());
    const room = CREW_ROOMS[0];
    const lamp = CREW_LAMPS_BY_ROOM[room.id][0];
    const preferences = { ...defaultCrewPreferences(), lampsByRoom: { [room.id]: { [lamp.id]: 'on' as const } } };
    expect(validateCrewPreferences(JSON.parse(JSON.stringify(preferences)))).toEqual(preferences);
  });

  it('hides wall fixtures behind a cutaway wall but keeps desk, ceiling and reception fixtures visible', () => {
    for (const room of CREW_ROOMS) {
      for (const view of CREW_VIEWS) {
        const lamps = CREW_LAMPS_BY_ROOM[room.id];
        for (const lamp of lamps.filter(item => item.kind !== 'wall')) expect(crewLampVisible(lamp, room, view)).toBe(true);
        const wallLamps = lamps.filter(item => item.kind === 'wall');
        expect(wallLamps.filter(lamp => crewLampVisible(lamp, room, view)).length).toBeGreaterThan(0);
      }
    }
  });

  it('never illuminates past a lamp radius and ignores lamps that are off', () => {
    const room = CREW_ROOMS[0];
    const lamp = CREW_LAMPS_BY_ROOM[room.id][0];
    const near = crewLampIllumination({ x: lamp.x, y: lamp.y }, [lamp], { [lamp.id]: 'on' }, 'day');
    expect(near).toBeGreaterThan(0);
    const far = crewLampIllumination({ x: lamp.x + lamp.radius * 5, y: lamp.y + lamp.radius * 5 }, [lamp], { [lamp.id]: 'on' }, 'day');
    expect(far).toBe(0);
    expect(crewLampIllumination({ x: lamp.x, y: lamp.y }, [lamp], { [lamp.id]: 'off' }, 'night')).toBe(0);
    expect(crewLampIllumination({ x: lamp.x, y: lamp.y }, [lamp], {}, 'night')).toBeGreaterThan(0);
  });
});
