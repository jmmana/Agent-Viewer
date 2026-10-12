import { useEffect, useState } from 'react';
import { loadCrewAlertIcon } from './crewAlertIcon';
import type { CrewAlertIconName } from './crewAlertBridge';
import { crewSharedImageCache } from './crewAssetCache';

/**
 * Carga los 8 iconos del catálogo de alertas Crew (#153) una sola vez, compartidos por
 * toda la escena (no dependen de sala ni de agente, igual que `useCrewCallIcon` para la
 * llamada): varias alertas de distinto tipo pueden estar activas a la vez en agentes
 * distintos, así que a diferencia de `useCrewCallIcon` (un solo icono) aquí hacen falta
 * todos. Reutiliza `loadCrewAlertIcon`/`crewSharedImageCache` (#158, LRU de assets entre
 * salas) sin reimplementar la carga.
 *
 * Esta lista debe seguir coincidiendo con `CrewAlertIconName` (`crewAlertBridge.ts`); si
 * el catálogo agrega un icono nuevo algún día y se olvida aquí, esa alerta en particular
 * simplemente cae a su glifo de respaldo vectorial (`drawCrewAlertOverlay` ya lo cubre),
 * nunca revienta el render.
 */
const CREW_ALERT_ICON_NAMES = ['wifi', 'check', 'blocked', 'tool', 'thought', 'alert', 'sync', 'terminal'] as const satisfies readonly CrewAlertIconName[];

export function useCrewAlertIcons() {
  const [images, setImages] = useState<Partial<Record<CrewAlertIconName, HTMLImageElement>>>({});
  const [failed, setFailed] = useState<Partial<Record<CrewAlertIconName, boolean>>>({});
  useEffect(() => {
    setImages({});
    setFailed({});
    const cancels = CREW_ALERT_ICON_NAMES.map(name => loadCrewAlertIcon(
      name,
      image => setImages(prev => ({ ...prev, [name]: image })),
      () => setFailed(prev => ({ ...prev, [name]: true })),
      undefined,
      undefined,
      crewSharedImageCache,
    ));
    return () => { for (const cancel of cancels) cancel(); };
  }, []);
  return { images, failed };
}
