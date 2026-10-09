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
