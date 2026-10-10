import type { CrewRoomDefinition } from './crewModel';

/**
 * Capa de iluminación del renderer Crew 2.5D: centraliza los tonos planos que
 * simulan una luz cenital fija sobre piso, paredes, puertas y props. No hay fuentes
 * de luz dinámicas, sombras proyectadas ni ciclo día/noche; es una paleta compartida
 * para que escena y props queden sombreadas de forma consistente y se pueda testear
 * por separado de la geometría que la consume.
 */
export const CREW_BACKGROUND_COLOR = '#142339';

export const CREW_FLOOR_GRID_STYLE = { stroke: 'rgba(71,85,105,.26)', lineWidth: .65 } as const;

/** Tono de las dos paredes traseras visibles; las frontales se omiten (cutaway). */
export const CREW_WALL_SHADES = {
  /** Pared a lo largo del eje X (ancho de la sala). */
  xWall: '#90a5b4',
  /** Pared a lo largo del eje Y (profundidad de la sala). */
  yWall: '#607c95',
} as const;

export const CREW_DOOR_COLOR = { fill: '#263b4d', stroke: '#e2e8f0' } as const;

export type CrewPropType = 'desk' | 'chair' | 'plant' | 'screen';
export interface CrewFaceShade { top: string; side: string; front: string }

/** Sombreado por tipo de mueble: una cara superior, una lateral y una frontal. */
export const CREW_PROP_SHADES: Readonly<Record<CrewPropType, CrewFaceShade>> = {
  desk: { top: '#b98050', side: '#62462f', front: '#8c603e' },
  chair: { top: '#7f9cc2', side: '#2c4969', front: '#496a92' },
  plant: { top: '#39b878', side: '#1c754a', front: '#2d925d' },
  screen: { top: '#4bb8d7', side: '#1c3548', front: '#214b64' },
};

/** Tono de piso por sala: Dirección recibe un acabado cálido distinto del resto. */
export function crewFloorColor(room: Pick<CrewRoomDefinition, 'id'>): string {
  return room.id === 'ceo' ? '#d9c6a9' : '#b3bdc7';
}

/** Color de la insignia de presencia según el estado reportado por el dominio. */
export function crewPresenceBadgeColor(status: string): string {
  return status === 'ERROR' || status === 'BLOCKED' ? '#b91c1c' : '#1d4ed8';
}
