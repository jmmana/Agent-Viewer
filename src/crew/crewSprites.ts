import { CREW_VIEWS, type CrewView } from './crewModel';
import type { CrewPresenceMarker } from './crewPresence';

// Piloto CEO: cuatro orientaciones originales. Otros roles conservan su marcador.
const sources = {
  front: () => import('./sprites/ceo-front'),
  right: () => import('./sprites/ceo-right'),
  back: () => import('./sprites/ceo-back'),
  left: () => import('./sprites/ceo-left'),
};
export const CREW_CEO_SPRITE = { width: 256, height: 352, anchor: { x: .5, y: .9375 }, displayHeight: 76 } as const;

export type CrewSpriteImages = Partial<Record<CrewView, HTMLImageElement>>;
const FACINGS = ['SE','SW','NW','NE'] as const;
// +Y se proyecta hacia la izquierda de pantalla; -Y, hacia la derecha.
const SPRITE_FACINGS: readonly CrewView[] = ['front','left','back','right'];

/** Rota la dirección del dominio en los mismos ejes locales que crewProject. */
export function crewSpriteView(marker: Pick<CrewPresenceMarker, 'role'|'facing'>, view: CrewView): CrewView | null {
  if (marker.role !== 'boss') return null;
  const facing = FACINGS.indexOf(marker.facing === undefined ? 'SE' : marker.facing);
  const camera = CREW_VIEWS.indexOf(view);
  return facing < 0 || camera < 0 ? null : SPRITE_FACINGS[(facing + camera) % 4];
}

/** Carga solo la vista solicitada; la cancelación impide callbacks después de salir. */
export function loadCrewSprite(view: CrewView, ready: (image: HTMLImageElement) => void,
  failed: () => void, loadUrl = async (direction: CrewView) => (await sources[direction]()).default,
  createImage = () => new Image()): () => void {
  return loadCrewImage(() => loadUrl(view), CREW_CEO_SPRITE, ready, failed, createImage);
}

export function loadCrewImage(loadUrl: () => Promise<string>, size: {width:number;height:number},
  ready: (image: HTMLImageElement) => void, failed: () => void, createImage = () => new Image()): () => void {
  let disposed = false;
  let image: HTMLImageElement | undefined;
  void loadUrl().then(url => {
    if (disposed) return;
    image = createImage();
    image.onload = () => {
      if (disposed) return;
      if (image!.naturalWidth === size.width && image!.naturalHeight === size.height) ready(image!);
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
