import type { CrewView } from './crewModel';
import type { CrewAnimationFrame } from './crewAnimation';
import { CREW_CEO_SPRITE, type CrewSpriteImages } from './crewSprites';

/**
 * Capa de sprites: dibuja la pose o el fotograma de parpadeo de un actor en un punto
 * ya proyectado. No decide posición, orden de profundidad ni insignia de presencia;
 * eso vive en el orquestador (`renderCrewRoom`) y en `crewHudLayer`.
 */
export interface CrewSpriteBlink { image: HTMLImageElement; frame: CrewAnimationFrame }

/** Dibuja el sprite de un actor si hay imagen para su orientación; indica si dibujó algo. */
export function drawCrewSprite(ctx: CanvasRenderingContext2D, point: { x: number; y: number },
  direction: CrewView | null, sprites: CrewSpriteImages, blink?: CrewSpriteBlink): boolean {
  const sprite = direction ? sprites[direction] : undefined;
  if (!sprite) return false;
  const spec = CREW_CEO_SPRITE;
  const height = spec.displayHeight, width = height * spec.width / spec.height;
  if (blink && direction === 'front') {
    const frame = blink.frame, scale = height / frame.height;
    ctx.drawImage(blink.image, frame.x, frame.y, frame.width, frame.height,
      point.x - frame.anchor.x * scale, point.y - frame.anchor.y * scale, frame.width * scale, height);
  } else {
    ctx.drawImage(sprite, point.x - width * spec.anchor.x, point.y - height * spec.anchor.y, width, height);
  }
  return true;
}
