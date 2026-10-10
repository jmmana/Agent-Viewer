export const CREW_PREFERENCES_STORAGE_KEY = 'agent-viewer-crew-preferences-v1';

export type CrewHudSize = 'compact' | 'standard' | 'large';
export type CrewAccessibilityPreset = 'none' | 'screenReader' | 'lowVision';

const CREW_HUD_SIZES: readonly CrewHudSize[] = ['compact', 'standard', 'large'];
const CREW_ACCESSIBILITY_PRESETS: readonly CrewAccessibilityPreset[] = ['none', 'screenReader', 'lowVision'];

export interface CrewPreferences {
  version: 1;
  reducedMotion: boolean;
  /**
   * Preferencia de audio propia de Crew (#157), separada del interruptor global
   * de sonido de Caricatura/TopBar (`agent-viewer-sound-preference-v1`). Hoy no
   * existe ningún motor de audio Crew: estos campos quedan como wiring en espera
   * de que el issue #150 agregue sonido real y los lea.
   */
  muted: boolean;
  volume: number;
  highContrast: boolean;
  /** Controla si los anuncios de cambios de sala/cámara se muestran como subtítulos visibles. */
  subtitles: boolean;
  hudSize: CrewHudSize;
  accessibilityPreset: CrewAccessibilityPreset;
}

/** El sistema conserva prioridad: false no anula prefers-reduced-motion. */
export function defaultCrewPreferences(): CrewPreferences {
  return {
    version: 1,
    reducedMotion: false,
    // zero-audio-default: silenciado por defecto porque aún no existe audio real en Crew (#150).
    muted: true,
    volume: 0.6,
    highContrast: false,
    subtitles: true,
    hudSize: 'standard',
    accessibilityPreset: 'none',
  };
}

function clampVolume(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(1, Math.max(0, parsed));
}

export function validateCrewPreferences(value: unknown): CrewPreferences {
  const fallback = defaultCrewPreferences();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return fallback;
  return {
    version: 1,
    reducedMotion: record.reducedMotion === true,
    muted: record.muted === undefined ? fallback.muted : record.muted === true,
    volume: clampVolume(record.volume, fallback.volume),
    highContrast: record.highContrast === true,
    subtitles: record.subtitles === undefined ? fallback.subtitles : record.subtitles === true,
    hudSize: CREW_HUD_SIZES.includes(record.hudSize as CrewHudSize) ? (record.hudSize as CrewHudSize) : fallback.hudSize,
    accessibilityPreset: CREW_ACCESSIBILITY_PRESETS.includes(record.accessibilityPreset as CrewAccessibilityPreset)
      ? (record.accessibilityPreset as CrewAccessibilityPreset)
      : fallback.accessibilityPreset,
  };
}

/**
 * Aplica de forma atómica una combinación de preferencias pensada para quien usa
 * lector de pantalla o tiene baja visión. No sustituye la configuración real del
 * sistema operativo ni del lector de pantalla; es un atajo dentro de Crew.
 */
export function applyCrewAccessibilityPreset(
  preferences: CrewPreferences,
  preset: CrewAccessibilityPreset,
): CrewPreferences {
  if (preset === 'screenReader') {
    return { ...preferences, accessibilityPreset: preset, subtitles: true, reducedMotion: true, hudSize: 'large' };
  }
  if (preset === 'lowVision') {
    return { ...preferences, accessibilityPreset: preset, highContrast: true, hudSize: 'large', subtitles: true };
  }
  return { ...preferences, accessibilityPreset: 'none' };
}

/** Escala relativa de fuente/espaciado del HUD de controles Crew. */
export const CREW_HUD_SCALE: Readonly<Record<CrewHudSize, number>> = {
  compact: 0.85,
  standard: 1,
  large: 1.35,
};

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
