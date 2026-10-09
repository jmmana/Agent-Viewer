import { useEffect, useMemo, useState } from 'react';
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

/** Cada orientación requerida se carga una sola vez por escena, aunque varios agentes la compartan. */
export function useCrewSprites(views: readonly CrewView[]) {
  const front = useCrewSprite(views.includes('front') ? 'front' : null);
  const right = useCrewSprite(views.includes('right') ? 'right' : null);
  const back = useCrewSprite(views.includes('back') ? 'back' : null);
  const left = useCrewSprite(views.includes('left') ? 'left' : null);
  const images = useMemo(() => ({front:front.image,right:right.image,back:back.image,left:left.image}),
    [front.image,right.image,back.image,left.image]);
  return {images,failed:front.failed || right.failed || back.failed || left.failed};
}
