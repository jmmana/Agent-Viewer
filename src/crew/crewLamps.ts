import type { CrewAmbience } from './crewAmbience';
import { CREW_ROOMS, crewProject, type CrewRoomDefinition, type CrewView } from './crewModel';
import { CREW_PROP_SIZE } from './crewSpatial';

export const CREW_LAMP_MODES = ['on', 'off', 'auto'] as const;
export type CrewLampMode = typeof CREW_LAMP_MODES[number];
export type CrewLampKind = 'desk' | 'ceiling' | 'wall' | 'reception';
export type CrewLampModes = Partial<Record<string, CrewLampMode>>;
export type CrewLampsByRoom = Partial<Record<string, CrewLampModes>>;
export interface CrewLamp {
  id: string;
  kind: CrewLampKind;
  x: number;
  y: number;
  /** Fixture base and bulb heights, in the same units as the Crew wall. */
  baseZ: number;
  bulbZ: number;
  radius: number;
  label: { es: string; en: string };
  deskId?: string;
}

/** Original procedural fixtures attached to room-local surfaces, not collision obstacles. */
export function crewRoomLamps(room: CrewRoomDefinition): readonly CrewLamp[] {
  const desks: CrewLamp[] = room.furniture.filter(item => item.type === 'desk').map((desk, index) => ({
    id: `${desk.id}-lamp`, kind: room.id === 'reception' ? 'reception' : 'desk',
    x: desk.x - .45, y: desk.y, baseZ: CREW_PROP_SIZE.desk.height, bulbZ: CREW_PROP_SIZE.desk.height + 17,
    radius: 1.8, deskId: desk.id,
    label: room.id === 'reception' ? { es: 'Lámpara de recepción', en: 'Reception lamp' }
      : { es: `Lámpara de escritorio ${index + 1}`, en: `Desk lamp ${index + 1}` },
  }));
  const walls: CrewLamp[] = [
    { x: room.width * .82, y: 0 }, { x: room.width, y: room.depth * .82 },
    { x: room.width * .82, y: room.depth }, { x: 0, y: room.depth * .82 },
  ].map((point, index) => ({
    id: `${room.id}-wall-lamp-${index + 1}`, kind: 'wall', ...point, baseZ: 42, bulbZ: 46, radius: 2,
    label: { es: `Aplique de pared ${index + 1}`, en: `Wall lamp ${index + 1}` },
  }));
  return [...desks, {
    id: `${room.id}-ceiling-lamp`, kind: 'ceiling', x: room.width / 2, y: room.depth / 2,
    baseZ: 64, bulbZ: 54, radius: Math.max(room.width, room.depth) * .65,
    label: { es: 'Lámpara de techo', en: 'Ceiling lamp' },
  }, ...walls];
}

// Bounded catalog shared by validation, UI, rendering and hit testing.
export const CREW_LAMPS_BY_ROOM: Readonly<Record<string, readonly CrewLamp[]>> = Object.fromEntries(
  CREW_ROOMS.map(room => [room.id, crewRoomLamps(room)]),
);

export function crewLampIsOn(mode: CrewLampMode = 'auto', ambience: CrewAmbience): boolean {
  return mode === 'on' || (mode === 'auto' && (ambience === 'sunset' || ambience === 'night'));
}

/** Manual three-state cycle driven by click or keyboard; never reads the clock itself. */
export function nextCrewLampMode(mode: CrewLampMode = 'auto'): CrewLampMode {
  return CREW_LAMP_MODES[(CREW_LAMP_MODES.indexOf(mode) + 1) % CREW_LAMP_MODES.length];
}

export function validateCrewLampsByRoom(value: unknown): CrewLampsByRoom {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: CrewLampsByRoom = {};
  for (const room of CREW_ROOMS) {
    const modes = (value as Record<string, unknown>)[room.id];
    if (!modes || typeof modes !== 'object' || Array.isArray(modes)) continue;
    const valid = Object.fromEntries(CREW_LAMPS_BY_ROOM[room.id].flatMap(lamp => {
      const mode = (modes as Record<string, unknown>)[lamp.id];
      return CREW_LAMP_MODES.includes(mode as CrewLampMode) ? [[lamp.id, mode as CrewLampMode]] : [];
    }));
    if (Object.keys(valid).length) result[room.id] = valid;
  }
  return result;
}

/** Cutaway walls hide fixtures, but their lights still illuminate the same physical room. */
export function crewLampVisible(lamp: CrewLamp, room: CrewRoomDefinition, view: CrewView): boolean {
  if (lamp.kind !== 'wall') return true;
  const p = crewProject(lamp.x, lamp.y, room, view);
  return p.x === 0 || p.y === 0;
}

/** Cheap deterministic local falloff; lighting never spills into another room. */
export function crewLampIllumination(point: { x: number; y: number }, lamps: readonly CrewLamp[], modes: CrewLampModes,
  ambience: CrewAmbience): number {
  return Math.min(1, lamps.reduce((sum, lamp) => {
    if (!crewLampIsOn(modes[lamp.id], ambience)) return sum;
    return sum + Math.max(0, 1 - Math.hypot(point.x - lamp.x, point.y - lamp.y) / lamp.radius);
  }, 0));
}
