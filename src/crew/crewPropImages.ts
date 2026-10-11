import { loadCrewImage } from './crewSprites';

/**
 * Piloto acotado de #115: imágenes reales del banco Crew para DOS muebles
 * prototipo (escritorio ejecutivo y planta de piso), usadas solo en la sala
 * Dirección. El resto de las once salas sigue dibujando el bloque 2.5D sin
 * imagen; esto no aprueba el arte (sigue `status: prototype` en el banco) ni
 * certifica las once salas ni las cuatro vistas por mueble.
 */
export type CrewPropImageId = 'desk-executive' | 'plant-floor';

const sources = {
  'desk-executive': () => import('./sprites/prop-desk-executive'),
  'plant-floor': () => import('./sprites/prop-plant-floor'),
};

/** Dimensiones reales del SVG migrado (coinciden con `assets/crew/asset-manifest.json`). */
export const CREW_PROP_IMAGE_SIZE: Readonly<Record<CrewPropImageId,
  { width: number; height: number; displayHeight: number; anchor: { x: number; y: number } }>> = {
  'desk-executive': { width: 168, height: 100, displayHeight: 34, anchor: { x: .5, y: .93 } },
  'plant-floor': { width: 72, height: 102, displayHeight: 34, anchor: { x: .5, y: .93 } },
};

/**
 * Mapea el `id` de un mueble de una sala a la imagen real del banco que debe
 * mostrar. Alcance acotado de #115: solo Dirección (escritorio y planta); un
 * mueble ausente de este mapa conserva el bloque 2.5D de siempre.
 */
export const CREW_ROOM_PROP_IMAGES: Readonly<Record<string, CrewPropImageId>> = {
  'ceo-desk': 'desk-executive',
  'ceo-plant': 'plant-floor',
};

/** Carga la imagen real de un mueble del banco; cancela si la sala cambia antes de resolver. */
export function loadCrewPropImage(id: CrewPropImageId, ready: (image: HTMLImageElement) => void,
  failed: () => void, loadUrl = async (propId: CrewPropImageId) => (await sources[propId]()).default,
  createImage = () => new Image()): () => void {
  return loadCrewImage(() => loadUrl(id), CREW_PROP_IMAGE_SIZE[id], ready, failed, createImage);
}
