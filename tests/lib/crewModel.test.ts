import { crewPointIsFree, crewPresenceSlots } from '../../src/crew/crewSpatial';
import { describe, expect, it } from 'vitest';
import { CREW_ROOMS, CREW_VIEWS, crewProject, crewRoom, isVisualMode } from '../../src/crew/crewModel';

describe('independent Crew room and mode contract', () => {
  it('does not confuse presentation with professional/showcase event modes', () => {
    expect(isVisualMode('cartoon')).toBe(true);
    expect(isVisualMode('crew')).toBe(true);
    expect(isVisualMode('professional')).toBe(false);
    expect(isVisualMode('showcase')).toBe(false);
  });
  it('defines two autonomous scenes, not a crop of the legacy layout', () => {
    expect(CREW_ROOMS.map(r => r.id)).toEqual(['ceo', 'development', 'planning', 'research', 'qa', 'finance', 'meeting', 'infrastructure', 'coffee', 'lounge', 'reception']);
    expect(crewRoom('ceo')?.furniture[0]?.id).toBe('ceo-desk');
    expect(crewRoom('development')?.furniture[0]?.id).toBe('dev-desk-1');
    expect(crewRoom('qa')?.furniture[0]?.id).toBe('qa-desk-a');
    expect(crewRoom('unknown')).toBeUndefined();
    expect(new Set(CREW_ROOMS.flatMap(r => r.furniture.map(f => f.id))).size)
      .toBe(CREW_ROOMS.reduce((n, r) => n + r.furniture.length, 0));
  });
  it('valida entradas y capacidad contra la geometría libre de las once salas', () => {
    for (const room of CREW_ROOMS) {
      expect(room.type).toBeTruthy();
      expect(room.capacity).toBe(crewPresenceSlots(room).length);
      expect(room.capacity).toBeGreaterThan(0);
      expect(room.doors.length).toBeGreaterThan(0);
      for (const door of room.doors) {
        expect(door.offset - door.width / 2).toBeGreaterThanOrEqual(0);
        expect(door.offset + door.width / 2).toBeLessThanOrEqual(room.width);
      }
      for (const arrival of room.arrivalPoints) {
        expect(room.doors.some(door => door.id === arrival.doorId)).toBe(true);
        expect(crewPointIsFree(room, arrival)).toBe(true);
      }
    }
  });
  it('maps original local actor coordinates through each of four camera orientations', () => {
    const room = CREW_ROOMS[0];
    expect(CREW_VIEWS).toEqual(['front', 'right', 'back', 'left']);
    expect(crewProject(2, 3, room, 'front')).toEqual({ x: 2, y: 3 });
    expect(crewProject(2, 3, room, 'right')).toEqual({ x: 5, y: 2 });
    expect(crewProject(2, 3, room, 'back')).toEqual({ x: 9, y: 5 });
    expect(crewProject(2, 3, room, 'left')).toEqual({ x: 3, y: 9 });
  });
});
