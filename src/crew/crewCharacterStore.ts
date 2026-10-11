import type { AgentRole } from '../types/agent';
import {
  type CrewCharacterAppearance,
  defaultCrewCharacterAppearance,
  isFullyValidCrewCharacterAppearance,
  validateCrewCharacterAppearance,
} from './crewCharacterCatalog';

/**
 * Misma política de persistencia de #171 (ver `crewPreferences.ts` y
 * `crewNavigation.ts`): clave propia, versionada, validación defensiva de
 * cada lectura y nunca confía en el contenido crudo de `localStorage`. Se
 * guarda por `agentId` estable, nunca por nombre (issue #127).
 */
export const CREW_CHARACTER_STORAGE_KEY = 'agent-viewer-crew-character-appearance-v1';

/** Tope generoso para un mapa de muchos agentes; las preferencias simples de #171 usan 4096 para un solo objeto. */
const MAX_SERIALIZED_LENGTH = 65_536;
const MAX_AGENTS = 2000;

export interface CrewCharacterAppearanceStore {
  version: 1;
  byAgentId: Record<string, CrewCharacterAppearance>;
}

export function defaultCrewCharacterAppearanceStore(): CrewCharacterAppearanceStore {
  return { version: 1, byAgentId: {} };
}

/** Filtra cada entrada de forma independiente: una entrada corrupta nunca invalida las demás. */
export function validateCrewCharacterAppearanceStore(value: unknown): CrewCharacterAppearanceStore {
  const fallback = defaultCrewCharacterAppearanceStore();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return fallback;
  const byAgentId = record.byAgentId;
  if (!byAgentId || typeof byAgentId !== 'object' || Array.isArray(byAgentId)) return fallback;
  const out: Record<string, CrewCharacterAppearance> = {};
  let count = 0;
  for (const [agentId, entry] of Object.entries(byAgentId as Record<string, unknown>)) {
    if (count >= MAX_AGENTS) break;
    if (typeof agentId !== 'string' || !agentId) continue;
    if (!isFullyValidCrewCharacterAppearance(entry)) continue;
    out[agentId] = entry;
    count++;
  }
  return { version: 1, byAgentId: out };
}

export function readCrewCharacterAppearanceStore(): CrewCharacterAppearanceStore {
  try {
    const serialized = window.localStorage.getItem(CREW_CHARACTER_STORAGE_KEY);
    if (!serialized || serialized.length > MAX_SERIALIZED_LENGTH) return defaultCrewCharacterAppearanceStore();
    return validateCrewCharacterAppearanceStore(JSON.parse(serialized));
  } catch {
    return defaultCrewCharacterAppearanceStore();
  }
}

export function saveCrewCharacterAppearanceStore(store: CrewCharacterAppearanceStore): void {
  try {
    const serialized = JSON.stringify(validateCrewCharacterAppearanceStore(store));
    if (serialized.length > MAX_SERIALIZED_LENGTH) return;
    window.localStorage.setItem(CREW_CHARACTER_STORAGE_KEY, serialized);
  } catch {
    /* Almacenamiento bloqueado: la apariencia sigue disponible en memoria para esta sesión. */
  }
}

/** Un agentId sin entrada guardada recibe el valor por defecto de su rol funcional, sin crear una entrada fantasma. */
export function getCrewCharacterAppearance(
  store: CrewCharacterAppearanceStore,
  agentId: string,
  functionalRole: AgentRole,
): CrewCharacterAppearance {
  const entry = store.byAgentId[agentId];
  return entry ? validateCrewCharacterAppearance(entry, functionalRole) : defaultCrewCharacterAppearance(functionalRole);
}

/** Operación pura e inmutable: nunca muta el store recibido ni afecta otras entradas. */
export function setCrewCharacterAppearance(
  store: CrewCharacterAppearanceStore,
  agentId: string,
  appearance: CrewCharacterAppearance,
): CrewCharacterAppearanceStore {
  return { version: 1, byAgentId: { ...store.byAgentId, [agentId]: validateCrewCharacterAppearance(appearance) } };
}

/** Elimina solo la entrada de ese agente; el resto del mapa queda intacto. */
export function resetCrewCharacterAppearance(store: CrewCharacterAppearanceStore, agentId: string): CrewCharacterAppearanceStore {
  if (!(agentId in store.byAgentId)) return store;
  const byAgentId = { ...store.byAgentId };
  delete byAgentId[agentId];
  return { version: 1, byAgentId };
}
