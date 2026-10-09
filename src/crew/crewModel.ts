/** Crew is a presentation option, not an event/store mode. */
export type VisualMode = 'cartoon' | 'crew';
export type CrewView = 'front' | 'right' | 'back' | 'left';

export interface CrewRoomDefinition {
  id: string;
  label: { en: string; es: string };
  width: number;
  depth: number;
  furniture: readonly { id: string; type: 'desk' | 'chair' | 'plant' | 'screen'; x: number; y: number }[];
}

/** Deliberately independent local rooms, not slices of the legacy global office map. */
export const CREW_ROOMS: readonly CrewRoomDefinition[] = [
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
] as const;

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
