import { describe, expect, it } from 'vitest';
import { crewIsoPoint } from '../../src/crew/renderCrewRoom';
import { drawCrewProp } from '../../src/crew/crewPropsLayer';
import { CREW_PROP_SHADES } from '../../src/crew/crewLightingLayer';

function recordingCtx() {
  const fills: string[] = [];
  let currentFill = '';
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key) {
      if (key === 'fill') return () => fills.push(currentFill);
      return () => {};
    },
    set(_target, key, value) { if (key === 'fillStyle') currentFill = value as string; return true; },
  });
  return { ctx, fills };
}

describe('Crew props layer (muebles 2.5D)', () => {
  it('dibuja exactamente tres caras por mueble, en orden frontal, lateral y superior', () => {
    const { ctx, fills } = recordingCtx();
    drawCrewProp(ctx, { type: 'desk' }, 5, 3, 'front', crewIsoPoint);
    expect(fills).toEqual([CREW_PROP_SHADES.desk.front, CREW_PROP_SHADES.desk.side, CREW_PROP_SHADES.desk.top]);
  });

  it('usa el sombreado propio de cada tipo de mueble', () => {
    for (const type of ['desk', 'chair', 'plant', 'screen'] as const) {
      const { ctx, fills } = recordingCtx();
      drawCrewProp(ctx, { type }, 2, 2, 'front', crewIsoPoint);
      expect(fills).toEqual([CREW_PROP_SHADES[type].front, CREW_PROP_SHADES[type].side, CREW_PROP_SHADES[type].top]);
    }
  });

  it('intercambia ancho y profundidad en vistas laterales, sin cambiar el sombreado', () => {
    const frontDraws: Array<[number, number][]> = [];
    const rightDraws: Array<[number, number][]> = [];
    function captureCtx(target: Array<[number, number][]>) {
      let path: [number, number][] = [];
      return new Proxy({} as CanvasRenderingContext2D, {
        get(_t, key) {
          if (key === 'beginPath') return () => { path = []; };
          if (key === 'moveTo' || key === 'lineTo') return (x: number, y: number) => path.push([x, y]);
          if (key === 'fill') return () => target.push([...path]);
          return () => {};
        },
        set() { return true; },
      });
    }
    drawCrewProp(captureCtx(frontDraws), { type: 'screen' }, 4, 4, 'front', crewIsoPoint);
    drawCrewProp(captureCtx(rightDraws), { type: 'screen' }, 4, 4, 'right', crewIsoPoint);
    expect(frontDraws).toHaveLength(3);
    expect(rightDraws).toHaveLength(3);
    expect(frontDraws[0]).not.toEqual(rightDraws[0]);
  });
});
