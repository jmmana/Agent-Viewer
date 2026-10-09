import { crewPresenceSlots } from './crewSpatial';

/** Crew is a presentation option, not an event/store mode. */
export type VisualMode = 'cartoon' | 'crew';
export type CrewView = 'front' | 'right' | 'back' | 'left';

interface CrewRoomLayout {
  id: string;
  label: { en: string; es: string };
  width: number;
  depth: number;
  furniture: readonly { id: string; type: 'desk' | 'chair' | 'plant' | 'screen'; x: number; y: number }[];
}

export type CrewRoomType = 'office' | 'workroom' | 'meeting' | 'social' | 'reception' | 'infrastructure';
export interface CrewRoomDefinition extends CrewRoomLayout {
  type: CrewRoomType;
  /** Capacidad de representación local, no límite de agentes del dominio. */
  capacity: number;
  doors: readonly { id: string; wall: 'south'; offset: number; width: number }[];
  arrivalPoints: readonly { id: string; doorId: string; x: number; y: number }[];
}

/** Deliberately independent local rooms, not slices of the legacy global office map. */
const CREW_ROOM_LAYOUTS: readonly CrewRoomLayout[] = [
  { id: 'ceo', label: { en: 'CEO Office', es: 'Dirección' }, width: 11, depth: 8,
    furniture: [
      { id: 'ceo-desk', type: 'desk', x: 5, y: 3 },
      { id: 'ceo-chair', type: 'chair', x: 5, y: 5 },
      { id: 'ceo-display', type: 'screen', x: 8, y: 2 },
      { id: 'ceo-plant', type: 'plant', x: 1, y: 2 },
    ] },
  { id: 'development', label: { en: 'Development', es: 'Desarrollo' }, width: 15, depth: 10,
    furniture: [
      { id: 'dev-desk-1', type: 'desk', x: 3, y: 4 },
      { id: 'dev-chair-1', type: 'chair', x: 3, y: 6 },
      { id: 'dev-desk-2', type: 'desk', x: 8, y: 4 },
      { id: 'dev-chair-2', type: 'chair', x: 8, y: 6 },
      { id: 'dev-display', type: 'screen', x: 12, y: 2 },
      { id: 'dev-plant', type: 'plant', x: 13, y: 8 },
    ] },
  // Distinct Crew-local prototype environments. These are NOT the final artwork.
  { id: 'planning', label: { en: 'Planning', es: 'Planificación' }, width: 13, depth: 9,
    furniture: [
      { id: 'plan-desk', type: 'desk', x: 4, y: 4 },
      { id: 'plan-chair', type: 'chair', x: 4, y: 6 },
      { id: 'plan-board', type: 'screen', x: 9, y: 2 },
      { id: 'plan-plant', type: 'plant', x: 11, y: 7 },
    ] },
  { id: 'research', label: { en: 'Research', es: 'Investigación' }, width: 12, depth: 9,
    furniture: [
      { id: 'research-desk', type: 'desk', x: 3, y: 4 },
      { id: 'research-chair', type: 'chair', x: 3, y: 6 },
      { id: 'research-display', type: 'screen', x: 8, y: 3 },
      { id: 'research-plant', type: 'plant', x: 10, y: 6 },
    ] },
  { id: 'qa', label: { en: 'QA & Review', es: 'Calidad y revisión' }, width: 13, depth: 9,
    furniture: [
      { id: 'qa-desk-a', type: 'desk', x: 3, y: 4 },
      { id: 'qa-chair-a', type: 'chair', x: 3, y: 6 },
      { id: 'qa-desk-b', type: 'desk', x: 8, y: 4 },
      { id: 'qa-monitor', type: 'screen', x: 10, y: 2 },
    ] },
  { id: 'finance', label: { en: 'Finance', es: 'Finanzas' }, width: 11, depth: 8,
    furniture: [
      { id: 'finance-desk', type: 'desk', x: 5, y: 3 },
      { id: 'finance-chair', type: 'chair', x: 5, y: 5 },
      { id: 'finance-screen', type: 'screen', x: 8, y: 2 },
      { id: 'finance-plant', type: 'plant', x: 2, y: 6 },
    ] },
  { id: 'meeting', label: { en: 'Meeting Room', es: 'Sala de reuniones' }, width: 14, depth: 10,
    furniture: [
      { id: 'meeting-table', type: 'desk', x: 7, y: 5 },
      { id: 'meeting-seat-a', type: 'chair', x: 5, y: 7 },
      { id: 'meeting-seat-b', type: 'chair', x: 9, y: 7 },
      { id: 'meeting-tv', type: 'screen', x: 7, y: 1 },
    ] },
  { id: 'infrastructure', label: { en: 'Infrastructure', es: 'Infraestructura' }, width: 13, depth: 10,
    furniture: [
      { id: 'infra-console-a', type: 'desk', x: 4, y: 5 },
      { id: 'infra-console-b', type: 'desk', x: 9, y: 5 },
      { id: 'infra-display-a', type: 'screen', x: 3, y: 2 },
      { id: 'infra-display-b', type: 'screen', x: 10, y: 2 },
    ] },
  { id: 'coffee', label: { en: 'Coffee Area', es: 'Cafetería' }, width: 11, depth: 8,
    furniture: [
      { id: 'coffee-counter', type: 'desk', x: 5, y: 2 },
      { id: 'coffee-stool', type: 'chair', x: 5, y: 4 },
      { id: 'coffee-plant', type: 'plant', x: 2, y: 6 },
    ] },
  { id: 'lounge', label: { en: 'Lounge', es: 'Sala de descanso' }, width: 13, depth: 9,
    furniture: [
      { id: 'lounge-sofa-a', type: 'chair', x: 4, y: 5 },
      { id: 'lounge-sofa-b', type: 'chair', x: 8, y: 5 },
      { id: 'lounge-tv', type: 'screen', x: 6, y: 2 },
      { id: 'lounge-plant', type: 'plant', x: 11, y: 7 },
    ] },
  { id: 'reception', label: { en: 'Reception', es: 'Recepción' }, width: 12, depth: 9,
    furniture: [
      { id: 'reception-counter', type: 'desk', x: 6, y: 3 },
      { id: 'reception-seat-a', type: 'chair', x: 4, y: 6 },
      { id: 'reception-seat-b', type: 'chair', x: 8, y: 6 },
      { id: 'reception-plant', type: 'plant', x: 10, y: 2 },
    ] },
] as const;

const ROOM_TYPES: Readonly<Record<string, CrewRoomType>> = {
  ceo: 'office', development: 'workroom', planning: 'workroom', research: 'workroom',
  qa: 'workroom', finance: 'office', meeting: 'meeting', infrastructure: 'infrastructure',
  coffee: 'social', lounge: 'social', reception: 'reception',
};

export const CREW_ROOMS: readonly CrewRoomDefinition[] = CREW_ROOM_LAYOUTS.map(layout => {
  const doorId = `${layout.id}-entry`;
  const room: CrewRoomDefinition = {
    ...layout, type: ROOM_TYPES[layout.id], capacity: 0,
    doors: [{ id: doorId, wall: 'south', offset: .75, width: 1 }],
    arrivalPoints: [{ id: `${layout.id}-arrival`, doorId, x: .75, y: layout.depth - .75 }],
  };
  return { ...room, capacity: crewPresenceSlots(room).length };
});

export const CREW_VIEWS: readonly CrewView[] = ['front', 'right', 'back', 'left'];

export function isVisualMode(value: unknown): value is VisualMode {
  return value === 'cartoon' || value === 'crew';
}

export function crewRoom(id: string): CrewRoomDefinition | undefined {
  return CREW_ROOMS.find(room => room.id === id);
}

/** Camera changes world orientation, not the domain agent coordinates. */
export function crewProject(x: number, y: number, room: CrewRoomDefinition, view: CrewView) {
  switch (view) {
    case 'front': return { x, y };
    case 'right': return { x: room.depth - y, y: x };
    case 'back': return { x: room.width - x, y: room.depth - y };
    case 'left': return { x: y, y: room.width - x };
  }
}
