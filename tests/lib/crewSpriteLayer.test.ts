import { describe, expect, it } from 'vitest';
import { drawCrewSprite } from '../../src/crew/crewSpriteLayer';

function recordingCtx() {
  const drawn: unknown[][] = [];
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key) {
      if (key === 'drawImage') return (...args: unknown[]) => drawn.push(args);
      return () => {};
    },
    set() { return true; },
  });
  return { ctx, drawn };
}

describe('Crew sprite layer (pose o parpadeo del actor)', () => {
  it('no dibuja nada y reporta false cuando no hay imagen para la orientación', () => {
    const { ctx, drawn } = recordingCtx();
    const drewSomething = drawCrewSprite(ctx, { x: 0, y: 0 }, 'front', {});
    expect(drewSomething).toBe(false);
    expect(drawn).toHaveLength(0);
  });

  it('no dibuja nada cuando no hay orientación resuelta', () => {
    const { ctx, drawn } = recordingCtx();
    const sprite = {} as HTMLImageElement;
    const drewSomething = drawCrewSprite(ctx, { x: 0, y: 0 }, null, { front: sprite });
    expect(drewSomething).toBe(false);
    expect(drawn).toHaveLength(0);
  });

  it('dibuja la pose estática cuando hay imagen y no hay parpadeo', () => {
    const { ctx, drawn } = recordingCtx();
    const sprite = {} as HTMLImageElement;
    const drewSomething = drawCrewSprite(ctx, { x: 10, y: 20 }, 'front', { front: sprite });
    expect(drewSomething).toBe(true);
    expect(drawn).toHaveLength(1);
    expect(drawn[0][0]).toBe(sprite);
    expect(drawn[0]).toHaveLength(5);
  });

  it('dibuja el fotograma de parpadeo solo cuando el rostro visible es "front"', () => {
    const front = {} as HTMLImageElement, back = {} as HTMLImageElement, atlas = {} as HTMLImageElement;
    const blink = { image: atlas, frame: { x: 0, y: 0, width: 535, height: 735, anchor: { x: 267.5, y: 678 }, durationMs: 100 } };
    const frontCtx = recordingCtx();
    drawCrewSprite(frontCtx.ctx, { x: 0, y: 0 }, 'front', { front, back }, blink);
    expect(frontCtx.drawn[0][0]).toBe(atlas);
    expect(frontCtx.drawn[0]).toHaveLength(9);

    const backCtx = recordingCtx();
    drawCrewSprite(backCtx.ctx, { x: 0, y: 0 }, 'back', { front, back }, blink);
    expect(backCtx.drawn[0][0]).toBe(back);
    expect(backCtx.drawn[0]).toHaveLength(5);
  });
});
