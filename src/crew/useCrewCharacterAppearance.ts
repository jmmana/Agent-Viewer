import { useCallback, useState } from 'react';
import type { AgentRole } from '../types/agent';
import {
  type CrewCharacterAppearanceStore,
  getCrewCharacterAppearance,
  readCrewCharacterAppearanceStore,
  resetCrewCharacterAppearance,
  saveCrewCharacterAppearanceStore,
  setCrewCharacterAppearance,
} from './crewCharacterStore';
import type { CrewCharacterAppearance } from './crewCharacterCatalog';

/**
 * Apariencia Crew de un agente, persistida por `agentId` estable siguiendo la
 * política de instancia de #171: cada instancia del hook lee el
 * almacenamiento una vez al montar y escribe sus propios cambios, igual que
 * `crewPreferences.ts`; no sincroniza en vivo entre instancias.
 *
 * Nunca toca la posición del agente (`crewPresence.ts`) ni ningún
 * temporizador de animación (`useCrewBlink.ts` y similares): es puramente
 * cosmético y vive en su propio estado (issue #127).
 */
export function useCrewCharacterAppearance(agentId: string, functionalRole: AgentRole) {
  const [store, setStore] = useState<CrewCharacterAppearanceStore>(() => readCrewCharacterAppearanceStore());
  const appearance = getCrewCharacterAppearance(store, agentId, functionalRole);

  const update = useCallback((next: CrewCharacterAppearance) => {
    setStore(previous => {
      const updated = setCrewCharacterAppearance(previous, agentId, next);
      saveCrewCharacterAppearanceStore(updated);
      return updated;
    });
  }, [agentId]);

  const reset = useCallback(() => {
    setStore(previous => {
      const updated = resetCrewCharacterAppearance(previous, agentId);
      saveCrewCharacterAppearanceStore(updated);
      return updated;
    });
  }, [agentId]);

  return { appearance, update, reset };
}
