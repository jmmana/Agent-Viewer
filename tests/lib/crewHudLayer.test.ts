import { describe, expect, it } from 'vitest';
import { drawCrewPresenceBadge } from '../../src/crew/crewHudLayer';

function recordingCtx() {
  const ellipses: unknown[][] = [];
  const texts: unknown[][] = [];
  const fillStyles: string[] = [];
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key) {
      if (key === 'ellipse') return (...args: unknown[]) => ellipses.push(args);
      if (key === 'fillText') return (...args: unknown[]) => texts.push(args);
      return () => {};
    },
    set(_target, key, value) { if (key === 'fillStyle') fillStyles.push(value as string); return true; },
  });
  return { ctx, ellipses, texts, fillStyles };
}

describe('Crew HUD layer (insignia de presencia)', () => {
  it('dibuja el número del marcador centrado en la insignia', () => {
    const { ctx, texts } = recordingCtx();
    drawCrewPresenceBadge(ctx, { x: 10, y: 20 }, { status: 'IDLE', number: 3 }, false);
    expect(texts).toEqual([['3', 10, 20]]);
  });

  it('desplaza la insignia hacia abajo cuando ya se dibujó un sprite', () => {
    const { ctx, ellipses } = recordingCtx();
    drawCrewPresenceBadge(ctx, { x: 10, y: 20 }, { status: 'IDLE', number: 1 }, true);
    expect(ellipses[0][1]).toBe(29);
    const { ctx: ctxNoSprite, ellipses: withoutSprite } = recordingCtx();
    drawCrewPresenceBadge(ctxNoSprite, { x: 10, y: 20 }, { status: 'IDLE', number: 1 }, false);
    expect(withoutSprite[0][1]).toBe(20);
  });

  it('pinta la insignia en rojo cuando el agente está ERROR o BLOCKED, azul en otro caso', () => {
    const errorCtx = recordingCtx();
    drawCrewPresenceBadge(errorCtx.ctx, { x: 0, y: 0 }, { status: 'ERROR', number: 1 }, false);
    expect(errorCtx.fillStyles).toContain('#b91c1c');
    const idleCtx = recordingCtx();
    drawCrewPresenceBadge(idleCtx.ctx, { x: 0, y: 0 }, { status: 'IDLE', number: 1 }, false);
    expect(idleCtx.fillStyles).toContain('#1d4ed8');
  });
});
