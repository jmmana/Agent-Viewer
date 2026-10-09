import { CREW_VIEWS, type CrewView } from './crewModel';
import type { CrewPresenceMarker } from './crewPresence';

// Piloto CEO: una pose estática por vista. Otros roles conservan su marcador.
const sources = {
  front: () => import('./sprites/ceo-front'),
  right: () => import('./sprites/ceo-right'),
  back: () => import('./sprites/ceo-back'),
  left: () => import('./sprites/ceo-left'),
};
export const CREW_CEO_SPRITE = { width: 256, height: 352, anchor: { x: .5, y: .9375 }, displayHeight: 76 } as const;

/**
 * Contrato de orientación: `facing` es la vista de cámara desde la que se ve el frente del actor
 * (por defecto `front`). Es un dato local de la sala, no de dominio; la cámara solo lo reorienta.
 */
export function crewRelativeView(facing: CrewView, view: CrewView): CrewView {
  return CREW_VIEWS[(CREW_VIEWS.indexOf(view) - CREW_VIEWS.indexOf(facing) + CREW_VIEWS.length) % CREW_VIEWS.length]!;
}

export function crewSpriteView(marker: Pick<CrewPresenceMarker, 'role'> & { facing?: CrewView }, view: CrewView): CrewView | null {
  return marker.role === 'boss' ? crewRelativeView(marker.facing ?? 'front', view) : null;
}

/** Carga solo la vista solicitada; la cancelación impide callbacks después de salir. */
export function loadCrewSprite(view: CrewView, ready: (image: HTMLImageElement) => void,
  failed: () => void, loadUrl = async (direction: CrewView) => (await sources[direction]()).default,
  createImage = () => new Image()): () => void {
  let disposed = false;
  let image: HTMLImageElement | undefined;
  void loadUrl(view).then(url => {
    if (disposed) return;
    image = createImage();
    image.onload = () => {
      if (disposed) return;
      if (image!.naturalWidth === CREW_CEO_SPRITE.width && image!.naturalHeight === CREW_CEO_SPRITE.height) ready(image!);
      else failed();
    };
    image.onerror = () => { if (!disposed) failed(); };
    image.src = url;
  }).catch(() => { if (!disposed) failed(); });
  return () => {
    disposed = true;
    if (image) { image.onload = null; image.onerror = null; image.removeAttribute('src'); }
  };
}
