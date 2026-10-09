import { CREW_ROOMS, type VisualMode } from './crewModel';

export const CREW_NAVIGATION_STORAGE_KEY = 'agent-viewer-crew-navigation-v1';
export interface CrewNavigation {
  version: 1;
  selectedMode: VisualMode;
  selectedRoomId: string;
}

export function defaultCrewNavigation(): CrewNavigation {
  return { version: 1, selectedMode: 'cartoon', selectedRoomId: CREW_ROOMS[0].id };
}

/** Recupera solo preferencias conocidas; nunca contiene eventos ni telemetría. */
export function parseCrewNavigation(serialized: string | null): CrewNavigation {
  const fallback = defaultCrewNavigation();
  if (!serialized || serialized.length > 4096) return fallback;
  try {
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    const record = value as Record<string, unknown>;
    if (record.version !== 1) return fallback;
    return {
      version: 1,
      selectedMode: record.selectedMode === 'crew' ? 'crew' : 'cartoon',
      selectedRoomId: CREW_ROOMS.some(room => room.id === record.selectedRoomId)
        ? record.selectedRoomId as string : fallback.selectedRoomId,
    };
  } catch { return fallback; }
}

export function readCrewNavigation(): CrewNavigation {
  try { return parseCrewNavigation(window.localStorage.getItem(CREW_NAVIGATION_STORAGE_KEY)); }
  catch { return defaultCrewNavigation(); }
}

export function saveCrewNavigation(navigation: CrewNavigation): void {
  try { window.localStorage.setItem(CREW_NAVIGATION_STORAGE_KEY, JSON.stringify(navigation)); }
  catch { /* La navegación sigue funcionando si el navegador bloquea el almacenamiento. */ }
}

export interface CrewEntry {
  navigation: CrewNavigation;
  missingRoom: boolean;
}

/** El enlace explícito prevalece sobre preferencias locales, sin alterar LIVE/DEMO. */
export function resolveCrewEntry(saved: CrewNavigation, search: string): CrewEntry {
  const params = new URLSearchParams(search);
  const requestedMode = params.get('visualMode');
  const requestedRoom = params.get('crewRoom');
  const knownRoom = requestedRoom !== null && CREW_ROOMS.some(room => room.id === requestedRoom);
  return {
    navigation: {
      ...saved,
      selectedMode: requestedMode === 'cartoon' ? 'cartoon'
        : requestedMode === 'crew' || requestedRoom !== null ? 'crew' : saved.selectedMode,
      selectedRoomId: requestedRoom === null ? saved.selectedRoomId
        : knownRoom ? requestedRoom : CREW_ROOMS[0].id,
    },
    missingRoom: requestedRoom !== null && !knownRoom,
  };
}

export function readCrewEntry(): CrewEntry {
  const saved = readCrewNavigation();
  return resolveCrewEntry(saved, typeof window === 'undefined' ? '' : window.location.search);
}

/** Enlace local sin parámetros de credenciales, datos de sesión ni contenido de agentes. */
export function crewRoomLink(href: string, roomId: string): string {
  const url = new URL(href);
  const params = new URLSearchParams();
  if (url.searchParams.get('mode') === 'live') params.set('mode', 'live');
  params.set('visualMode', 'crew');
  params.set('crewRoom', CREW_ROOMS.some(room => room.id === roomId) ? roomId : CREW_ROOMS[0].id);
  return `${url.pathname}?${params}`;
}

/** Actualiza solo enlaces Crew ya activos; conserva el resto de la URL. */
export function replaceCrewLink(navigation: CrewNavigation): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has('visualMode') && !url.searchParams.has('crewRoom')) return;
  url.searchParams.set('visualMode', navigation.selectedMode);
  url.searchParams.set('crewRoom', navigation.selectedRoomId);
  try { window.history.replaceState(window.history.state, '', url); }
  catch { /* Un host que bloquea History API conserva la navegación en memoria. */ }
}
