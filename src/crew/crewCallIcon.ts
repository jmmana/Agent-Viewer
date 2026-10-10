import { loadCrewImage } from './crewSprites';

/**
 * Icono de llamada del banco Crew (`assets/crew/bank/effects/call.svg`), usado por la
 * superposición de llamada (issue #145). Dimensiones reales del SVG (ver sus atributos
 * `width`/`height`): la validación de integridad de `loadCrewImage` rechaza cualquier
 * archivo que no coincida exactamente, igual que el resto de imágenes del banco.
 */
export const CREW_CALL_ICON_SIZE = { width: 40, height: 40 } as const;

/** Carga el icono de llamada; si falla, `drawCrewCallOverlay` dibuja un glifo de respaldo. */
export function loadCrewCallIcon(ready: (image: HTMLImageElement) => void, failed: () => void,
  loadUrl: () => Promise<string> = async () => (await import('./sprites/effect-call')).default,
  createImage = () => new Image()): () => void {
  return loadCrewImage(loadUrl, CREW_CALL_ICON_SIZE, ready, failed, createImage);
}
