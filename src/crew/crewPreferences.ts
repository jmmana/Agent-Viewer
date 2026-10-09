export const CREW_PREFERENCES_STORAGE_KEY = 'agent-viewer-crew-preferences-v1';
export interface CrewPreferences {
  version: 1;
  reducedMotion: boolean;
}

/** El sistema conserva prioridad: false no anula prefers-reduced-motion. */
export function defaultCrewPreferences(): CrewPreferences {
  return { version: 1, reducedMotion: false };
}

export function validateCrewPreferences(value: unknown): CrewPreferences {
  const fallback = defaultCrewPreferences();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return fallback;
  return { version: 1, reducedMotion: record.reducedMotion === true };
}

export function readCrewPreferences(): CrewPreferences {
  try {
    const serialized = window.localStorage.getItem(CREW_PREFERENCES_STORAGE_KEY);
    return !serialized || serialized.length > 4096 ? defaultCrewPreferences() : validateCrewPreferences(JSON.parse(serialized));
  } catch { return defaultCrewPreferences(); }
}

export function saveCrewPreferences(preferences: CrewPreferences): void {
  try { window.localStorage.setItem(CREW_PREFERENCES_STORAGE_KEY, JSON.stringify(validateCrewPreferences(preferences))); }
  catch { /* Almacenamiento bloqueado: las preferencias siguen disponibles en memoria. */ }
}
