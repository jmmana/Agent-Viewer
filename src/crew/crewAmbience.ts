import { CREW_ROOMS } from './crewModel';

export const CREW_AMBIENCES = ['dawn', 'day', 'sunset', 'night'] as const;
export type CrewAmbience = typeof CREW_AMBIENCES[number];
export type CrewAmbienceMode = CrewAmbience | 'auto';
export type CrewAmbienceByRoom = Partial<Record<string, CrewAmbienceMode>>;

export const CREW_AMBIENCE_LABELS = {
  es: { auto: 'Auto (hora local)', dawn: 'Amanecer', day: 'Día', sunset: 'Atardecer', night: 'Noche' },
  en: { auto: 'Auto (local time)', dawn: 'Dawn', day: 'Day', sunset: 'Sunset', night: 'Night' },
} as const;

/** Decorative local clock, never event/replay time or a geolocation lookup. */
export function resolveCrewAmbience(mode: CrewAmbienceMode, localHour: number): CrewAmbience {
  if (mode !== 'auto') return mode;
  if (localHour >= 5 && localHour < 8) return 'dawn';
  if (localHour >= 8 && localHour < 17) return 'day';
  if (localHour >= 17 && localHour < 20) return 'sunset';
  return 'night';
}

export function validateCrewAmbienceByRoom(value: unknown): CrewAmbienceByRoom {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return Object.fromEntries(CREW_ROOMS.flatMap(({ id }) => {
    const mode = record[id];
    return mode === 'auto' || CREW_AMBIENCES.includes(mode as CrewAmbience) ? [[id, mode as CrewAmbienceMode]] : [];
  }));
}

/** Original code-native palette; no external assets or physical lighting engine. */
export const CREW_AMBIENCE_PALETTES = {
  dawn: { background: '#29384f', xWall: '#c1a79f', yWall: '#8f899e', floor: '#c7b8ad', sky: '#f2b8a0', skyline: '#7f7892', glass: '#fbe3c0', shadow: 'rgba(84,62,86,.14)', screen: '#8ed2dd' },
  day: { background: '#142339', xWall: '#90a5b4', yWall: '#607c95', floor: '#b3bdc7', sky: '#a1d7ed', skyline: '#5e8ea5', glass: '#effaff', shadow: 'rgba(34,66,84,.12)', screen: '#4bb8d7' },
  sunset: { background: '#392d43', xWall: '#c49a83', yWall: '#927580', floor: '#c1a58e', sky: '#efaa81', skyline: '#78617e', glass: '#ffdfac', shadow: 'rgba(76,45,74,.18)', screen: '#74b4c6' },
  night: { background: '#101b30', xWall: '#62758e', yWall: '#45566f', floor: '#8291a5', sky: '#1f355b', skyline: '#102440', glass: '#bbd7f1', shadow: 'rgba(12,25,49,.22)', screen: '#699cad' },
} as const;
