import type { CrewView } from './crewModel';
import type { CrewPoint } from './crewRenderPrimitives';
import type { CrewSpriteBlink } from './crewSpriteLayer';
import { drawCrewSprite } from './crewSpriteLayer';
import type { CrewSpriteImages } from './crewSprites';

/** Puntos medidos del original RGBA; son contactos de presentación, no coordenadas del dominio. */
export const CREW_WORKSTATION = {
  width: 1024, height: 1536,
  views: {
    front: { y: 0, height: 405, keyboard: { x: 329, y: 114 }, deskFoot: 377, seat: { x: 817, y: 240 }, chairFoot: 393, hands: { x: 0, y: -20 }, hips: { x: 0, y: -13 } },
    right: { y: 405, height: 356, keyboard: { x: 224, y: 74 }, deskFoot: 336, seat: { x: 843, y: 190 }, chairFoot: 343, hands: { x: 5, y: -22 }, hips: { x: -6, y: -13 } },
    back: { y: 761, height: 354, keyboard: { x: 321, y: 86 }, deskFoot: 329, seat: { x: 821, y: 205 }, chairFoot: 344, hands: { x: 0, y: -22 }, hips: { x: 0, y: -13 } },
    left: { y: 1115, height: 421, keyboard: { x: 473, y: 75 }, deskFoot: 343, seat: { x: 786, y: 192 }, chairFoot: 362, hands: { x: -4, y: -22 }, hips: { x: 6, y: -13 } },
  },
} as const;

/** El teclado permanece fijo mientras alternan las manos; nunca sigue el cuadro individual. */
export function crewWorkstationPlacement(view: CrewView) {
  const spec = CREW_WORKSTATION.views[view];
  const deskScale = -spec.hands.y / (spec.deskFoot - spec.keyboard.y);
  const chairScale = -spec.hips.y / (spec.chairFoot - spec.seat.y);
  return { spec, deskScale, chairScale,
    desk: { x: spec.hands.x - spec.keyboard.x * deskScale, y: spec.hands.y - spec.keyboard.y * deskScale },
    chair: { x: spec.hips.x - (spec.seat.x - 640) * chairScale, y: spec.hips.y - spec.seat.y * chairScale } };
}

/** Puesto compuesto por capas del original, con oclusión explícita según la orientación del actor. */
export function drawCrewWorkstation(ctx: CanvasRenderingContext2D, point: CrewPoint, view: CrewView,
  image: HTMLImageElement, sprites: CrewSpriteImages, action: CrewSpriteBlink): void {
  const p = crewWorkstationPlacement(view), spec = p.spec;
  const desk = () => ctx.drawImage(image, 0, spec.y, 640, spec.height,
    point.x + p.desk.x, point.y + p.desk.y, 640 * p.deskScale, spec.height * p.deskScale);
  const chair = () => ctx.drawImage(image, 640, spec.y, 384, spec.height,
    point.x + p.chair.x, point.y + p.chair.y, 384 * p.chairScale, spec.height * p.chairScale);
  const actor = () => drawCrewSprite(ctx, point, view, sprites, undefined, undefined, action);
  if (view === 'back') { desk(); actor(); chair(); }
  else if (view === 'front') {
    chair(); actor(); desk();
    // Recupera manos y parte superior sobre el teclado, sin pintar piernas sobre el faldón.
    ctx.save(); ctx.beginPath(); ctx.rect(point.x - 60, point.y - 100, 120, 100 + spec.hands.y + 3); ctx.clip();
    actor(); ctx.restore();
  } else { chair(); desk(); actor(); }
}
