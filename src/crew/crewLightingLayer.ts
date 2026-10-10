import type { CrewRoomDefinition } from './crewModel';

/**
 * Capa de iluminación del renderer Crew 2.5D: centraliza los tonos planos que
 * simulan una luz cenital fija sobre piso, paredes, puertas y props. No hay fuentes
 * de luz dinámicas, sombras proyectadas ni ciclo día/noche; es una paleta compartida
 * para que escena y props queden sombreadas de forma consistente y se pueda testear
 * por separado de la geometría que la consume.
 */
export const CREW_BACKGROUND_COLOR = '#142339';
/** Fondo del tema de alto contraste (#157): mismo negro que `CREW_HIGH_CONTRAST_THEME.background`. */
export const CREW_BACKGROUND_COLOR_HIGH_CONTRAST = '#000000';
/** Trazo compartido del tema de alto contraste (#157): mismo blanco que `CREW_HIGH_CONTRAST_THEME.text`. */
export const CREW_STROKE_HIGH_CONTRAST = '#ffffff';

export const CREW_FLOOR_GRID_STYLE = { stroke: 'rgba(71,85,105,.26)', lineWidth: .65 } as const;
export const CREW_FLOOR_GRID_STYLE_HIGH_CONTRAST = { stroke: 'rgba(255,255,255,.55)', lineWidth: 1 } as const;

/** Tono de las dos paredes traseras visibles; las frontales se omiten (cutaway). */
export const CREW_WALL_SHADES = {
  /** Pared a lo largo del eje X (ancho de la sala). */
  xWall: '#90a5b4',
  /** Pared a lo largo del eje Y (profundidad de la sala). */
  yWall: '#607c95',
} as const;

/** Paredes del tema de alto contraste (#157): mayor relación de contraste sobre fondo negro. */
export const CREW_WALL_SHADES_HIGH_CONTRAST = {
  xWall: '#3a3a3a',
  yWall: '#232323',
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

/** Sombreado de alto contraste por tipo de mueble (#157): relación de contraste mayor sobre fondo negro. */
export const CREW_PROP_SHADES_HIGH_CONTRAST: Readonly<Record<CrewPropType, CrewFaceShade>> = {
  desk: { top: '#ffd400', side: '#8a7200', front: '#c9a700' },
  chair: { top: '#00e5ff', side: '#006270', front: '#00a3b8' },
  plant: { top: '#7cff6b', side: '#2f8a24', front: '#4fc43e' },
  screen: { top: '#ffffff', side: '#8f8f8f', front: '#c6c6c6' },
};

/** Sombreado de muebles según la preferencia de alto contraste (#157). */
export function crewPropShades(highContrast: boolean): Readonly<Record<CrewPropType, CrewFaceShade>> {
  return highContrast ? CREW_PROP_SHADES_HIGH_CONTRAST : CREW_PROP_SHADES;
}

/** Tono de las paredes según la preferencia de alto contraste (#157). */
export function crewWallShades(highContrast: boolean): { xWall: string; yWall: string } {
  return highContrast ? CREW_WALL_SHADES_HIGH_CONTRAST : CREW_WALL_SHADES;
}

/** Tono de piso por sala: Dirección recibe un acabado cálido distinto del resto; alto contraste (#157) usa un gris neutro para las once salas. */
export function crewFloorColor(room: Pick<CrewRoomDefinition, 'id'>, highContrast = false): string {
  if (highContrast) return '#5a5a5a';
  return room.id === 'ceo' ? '#d9c6a9' : '#b3bdc7';
}

/** Color de la insignia de presencia según el estado reportado por el dominio. */
export function crewPresenceBadgeColor(status: string): string {
  return status === 'ERROR' || status === 'BLOCKED' ? '#b91c1c' : '#1d4ed8';
}
