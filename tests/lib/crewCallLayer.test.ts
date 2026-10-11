import { describe, expect, it } from 'vitest';
import { crewCallPulseValue, drawCrewCallOverlay } from '../../src/crew/crewCallLayer';

function recordingCtx() {
  const arcs: unknown[][] = [];
  const drawnImages: unknown[][] = [];
  const strokeStyles: string[] = [];
  const alphas: number[] = [];
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key) {
      if (key === 'arc') return (...args: unknown[]) => arcs.push(args);
      if (key === 'drawImage') return (...args: unknown[]) => drawnImages.push(args);
      if (key === 'save' || key === 'restore' || key === 'beginPath' || key === 'fill' || key === 'stroke') return () => {};
      return () => {};
    },
    set(_target, key, value) {
      if (key === 'strokeStyle') strokeStyles.push(value as string);
      if (key === 'globalAlpha') alphas.push(value as number);
      return true;
    },
  });
  return { ctx, arcs, drawnImages, strokeStyles, alphas };
}

describe('Capa de superposición de llamada Crew (#145)', () => {
  it('no dibuja nada cuando la opacidad llega a 0 (fin del desvanecido)', () => {
    const { ctx, arcs, drawnImages } = recordingCtx();
    drawCrewCallOverlay(ctx, { x: 0, y: 0 }, false, { phase: 'ending', pulseT: 0, opacity: 0 });
    expect(arcs).toHaveLength(0);
    expect(drawnImages).toHaveLength(0);
  });

  it('en fase ringing dibuja dos anillos pulsantes con la opacidad combinada', () => {
    const { ctx, arcs, alphas } = recordingCtx();
    drawCrewCallOverlay(ctx, { x: 10, y: 20 }, false, { phase: 'ringing', pulseT: 0.25, opacity: 1 });
    // Dos anillos (offset 0 y 0.5) más el icono de respaldo (un círculo adicional): al menos 2 arcos de anillo.
    expect(arcs.length).toBeGreaterThanOrEqual(2);
    expect(alphas.some(alpha => alpha < 1 && alpha > 0)).toBe(true);
  });

  it('fuera de ringing dibuja un único anillo estático', () => {
    const { ctx, arcs } = recordingCtx();
    drawCrewCallOverlay(ctx, { x: 0, y: 0 }, false, { phase: 'talking', pulseT: 0, opacity: 1 });
    // Un arco del anillo estático + un arco del glifo de respaldo (círculo de fondo).
    expect(arcs.length).toBe(2);
  });

  it('usa el icono real si se provee, sin dibujar el glifo de respaldo', () => {
    const { ctx, drawnImages } = recordingCtx();
    const icon = {} as HTMLImageElement;
    drawCrewCallOverlay(ctx, { x: 0, y: 0 }, false, { phase: 'talking', pulseT: 0, opacity: 1, icon });
    expect(drawnImages).toHaveLength(1);
    expect(drawnImages[0][0]).toBe(icon);
  });

  it('sin icono, dibuja un glifo de respaldo vectorial (nunca desaparece el aviso)', () => {
    const { ctx, drawnImages, arcs } = recordingCtx();
    drawCrewCallOverlay(ctx, { x: 0, y: 0 }, false, { phase: 'talking', pulseT: 0, opacity: 1 });
    expect(drawnImages).toHaveLength(0);
    // El glifo de respaldo agrega un arco de círculo además del anillo.
    expect(arcs.length).toBe(2);
  });

  it('se ancla más arriba cuando ya se dibujó un sprite, para quedar sobre la cabeza', () => {
    const withSprite = recordingCtx();
    drawCrewCallOverlay(withSprite.ctx, { x: 5, y: 100 }, true, { phase: 'talking', pulseT: 0, opacity: 1 });
    const withoutSprite = recordingCtx();
    drawCrewCallOverlay(withoutSprite.ctx, { x: 5, y: 100 }, false, { phase: 'talking', pulseT: 0, opacity: 1 });
    const anchorY = (arcs: unknown[][]) => (arcs[0] as number[])[1];
    expect(anchorY(withSprite.arcs)).toBeLessThan(anchorY(withoutSprite.arcs));
  });
});

describe('crewCallPulseValue: reloj de pulso puro', () => {
  it('cicla entre 0 y 1 cada periodMs, sin depender de Date.now()', () => {
    expect(crewCallPulseValue(0, 900)).toBe(0);
    expect(crewCallPulseValue(450, 900)).toBeCloseTo(0.5);
    expect(crewCallPulseValue(900, 900)).toBe(0);
    expect(crewCallPulseValue(1350, 900)).toBeCloseTo(0.5);
  });

  it('nunca lanza con entradas degeneradas', () => {
    expect(crewCallPulseValue(-10)).toBe(0);
    expect(crewCallPulseValue(NaN)).toBe(0);
    expect(crewCallPulseValue(10, 0)).toBe(0);
  });
});
