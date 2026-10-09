import { useEffect, useState } from 'react';
import type { CrewView } from './crewModel';
import { loadCrewSprite } from './crewSprites';

/** La imagen pertenece a la escena montada, sin caché global ni cambios de dominio. */
export function useCrewSprite(view: CrewView | null) {
  const [loaded, setLoaded] = useState<{view: CrewView; image: HTMLImageElement} | null>(null);
  const [failedView, setFailedView] = useState<CrewView | null>(null);
  useEffect(() => {
    setLoaded(null);
    setFailedView(null);
    if (!view) return;
    return loadCrewSprite(view, image => setLoaded({view, image}), () => setFailedView(view));
  }, [view]);
  return { image: loaded?.view === view ? loaded.image : undefined, failed: view !== null && failedView === view };
}
