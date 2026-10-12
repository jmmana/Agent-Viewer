import { useEffect, useMemo, useState } from 'react';
import type { CrewView } from './crewModel';
import { loadCrewSprite } from './crewSprites';
import { crewSharedImageCache } from './crewAssetCache';

/**
 * La imagen pertenece a la escena montada; ya no se decodifica de cero en cada
 * montaje (issue #158, "LRU de assets entre salas"): `loadCrewSprite` reutiliza la
 * caché compartida `crewSharedImageCache` por clave de vista, acotada a un máximo de
 * entradas, así que volver a una sala ya visitada no repite la decodificación.
 * `phoneCall` (issue #145) solo tiene efecto sobre la vista `front`: sustituye la pose
 * de pie por `ceo-phone-front` (sosteniendo el teléfono) mientras el agente reporta
 * `PHONE_CALL` real. Esta opción estática se conserva por compatibilidad; CrewStage
 * usa poses neutrales compartidas y los clips de llamada de useCrewActions por actor.
 */
export function useCrewSprite(view: CrewView | null, phoneCall = false) {
  const [loaded, setLoaded] = useState<{view: CrewView; image: HTMLImageElement} | null>(null);
  const [failedView, setFailedView] = useState<CrewView | null>(null);
  useEffect(() => {
    setLoaded(null);
    setFailedView(null);
    if (!view) return;
    const phoneFront = view === 'front' && phoneCall;
    const loadUrl = phoneFront
      ? async () => (await import('./sprites/ceo-phone-front')).default
      : undefined;
    const cacheKey = phoneFront ? 'sprite:front:phone' : `sprite:${view}`;
    return loadCrewSprite(view, image => setLoaded({view, image}), () => setFailedView(view), loadUrl,
      undefined, crewSharedImageCache, cacheKey);
  }, [view, phoneCall]);
  return { image: loaded?.view === view ? loaded.image : undefined, failed: view !== null && failedView === view };
}

/**
 * Cada orientación requerida se carga una sola vez por escena, aunque varios agentes la
 * compartan. `frontPhoneCall` (#145) solo afecta la carga de `front`: ver `useCrewSprite`.
 */
export function useCrewSprites(views: readonly CrewView[], frontPhoneCall = false) {
  const front = useCrewSprite(views.includes('front') ? 'front' : null, frontPhoneCall);
  const right = useCrewSprite(views.includes('right') ? 'right' : null);
  const back = useCrewSprite(views.includes('back') ? 'back' : null);
  const left = useCrewSprite(views.includes('left') ? 'left' : null);
  const images = useMemo(() => ({front:front.image,right:right.image,back:back.image,left:left.image}),
    [front.image,right.image,back.image,left.image]);
  return {images,failed:front.failed || right.failed || back.failed || left.failed};
}
