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
/**
 * Una puerta es un lado de un enlace entre dos salas (`CREW_ROOM_EDGES`). `edgeId`
 * referencia el enlace compartido; el estado abierto/cerrado vive solo ahí
 * (`crewRoutes.ts`), nunca duplicado por lado, para que ambos lados de la misma
 * puerta física concuerden siempre.
 */
export interface CrewDoor { id: string; wall: 'south'; offset: number; width: number; connectsTo: string | null; edgeId: string | null }
export interface CrewRoomDefinition extends CrewRoomLayout {
  type: CrewRoomType;
  /** Capacidad de representación local, no límite de agentes del dominio. */
  capacity: number;
  doors: readonly CrewDoor[];
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

/**
 * Árbol de expansión (10 enlaces para 11 salas): cada enlace es una puerta física
 * compartida por dos salas. `crewRoutes.ts` es la única fuente del estado
 * abierto/cerrado de cada enlace; aquí solo se describe la topología fija del
 * edificio. No se usa la grilla antigua ni `OFFICE_ROOMS`.
 */
export interface CrewRoomEdge { id: string; roomA: string; roomB: string }
export const CREW_ROOM_EDGES: readonly CrewRoomEdge[] = [
  { id: 'e-reception-ceo', roomA: 'reception', roomB: 'ceo' },
  { id: 'e-reception-finance', roomA: 'reception', roomB: 'finance' },
  { id: 'e-reception-lounge', roomA: 'reception', roomB: 'lounge' },
  { id: 'e-lounge-coffee', roomA: 'lounge', roomB: 'coffee' },
  { id: 'e-coffee-meeting', roomA: 'coffee', roomB: 'meeting' },
  { id: 'e-meeting-development', roomA: 'meeting', roomB: 'development' },
  { id: 'e-development-planning', roomA: 'development', roomB: 'planning' },
  { id: 'e-development-research', roomA: 'development', roomB: 'research' },
  { id: 'e-research-qa', roomA: 'research', roomB: 'qa' },
  { id: 'e-qa-infrastructure', roomA: 'qa', roomB: 'infrastructure' },
] as const;

/**
 * Posición de cada puerta sobre la pared sur de su sala. El primer enlace de
 * cada sala conserva el umbral original (offset .75) para no mover la cámara,
 * los enlaces adicionales de las salas con más de un vecino usan offsets
 * propios, verificados contra el mobiliario existente de esa sala.
 */
const ROOM_DOOR_OFFSETS: Readonly<Record<string, number>> = {
  ceo: .75, finance: .75, planning: .75, infrastructure: .75,
  lounge: .75, coffee: .75, meeting: .75, research: .75, qa: .75, reception: .75,
  development: .75,
};
const ROOM_EXTRA_DOOR_OFFSETS: Readonly<Record<string, number>> = {
  'lounge:e-lounge-coffee': 6.5,
  'coffee:e-coffee-meeting': 10.25,
  'meeting:e-meeting-development': 13.25,
  'research:e-research-qa': 11.25,
  'qa:e-qa-infrastructure': 12.25,
  'development:e-development-planning': 7.5,
  'development:e-development-research': 14.25,
  'reception:e-reception-finance': 6,
  'reception:e-reception-lounge': 11.25,
};

function roomEdges(roomId: string): readonly CrewRoomEdge[] {
  return CREW_ROOM_EDGES.filter(edge => edge.roomA === roomId || edge.roomB === roomId);
}
function otherRoom(edge: CrewRoomEdge, roomId: string): string {
  return edge.roomA === roomId ? edge.roomB : edge.roomA;
}

export const CREW_ROOMS: readonly CrewRoomDefinition[] = CREW_ROOM_LAYOUTS.map(layout => {
  const edges = roomEdges(layout.id);
  const doors: CrewDoor[] = edges.map((edge, index) => {
    const neighbor = otherRoom(edge, layout.id);
    const isPrimary = index === 0;
    const offset = isPrimary ? ROOM_DOOR_OFFSETS[layout.id]
      : ROOM_EXTRA_DOOR_OFFSETS[`${layout.id}:${edge.id}`];
    return {
      id: isPrimary ? `${layout.id}-entry` : `${layout.id}-door-${neighbor}`,
      wall: 'south', offset, width: 1, connectsTo: neighbor, edgeId: edge.id,
    };
  });
  const room: CrewRoomDefinition = {
    ...layout, type: ROOM_TYPES[layout.id], capacity: 0,
    doors,
    arrivalPoints: doors.map(door => ({
      id: door.id.endsWith('-entry') ? `${layout.id}-arrival` : `${layout.id}-arrival-${door.connectsTo}`,
      doorId: door.id, x: door.offset, y: layout.depth - .75,
    })),
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
