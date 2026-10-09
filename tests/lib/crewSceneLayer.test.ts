import { describe, expect, it } from 'vitest';
import { CREW_ROOMS } from '../../src/crew/crewModel';
import { crewIsoPoint, CREW_WALL_HEIGHT } from '../../src/crew/renderCrewRoom';
import { drawCrewBackground, drawCrewDoors, drawCrewFloorGrid, drawCrewRoomShell } from '../../src/crew/crewSceneLayer';

function recordingCtx() {
  const fills: string[] = [];
  const rects: unknown[][] = [];
  const strokes = { count: 0 };
  let currentFill = '';
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_target, key) {
      if (key === 'fillRect') return (...args: unknown[]) => rects.push(args);
      if (key === 'fill') return () => fills.push(currentFill);
      if (key === 'stroke') return () => { strokes.count += 1; };
      return () => {};
    },
    set(_target, key, value) { if (key === 'fillStyle') currentFill = value as string; return true; },
  });
  return { ctx, fills, rects, strokes };
}

const geometry = { isoPoint: crewIsoPoint, wallHeight: CREW_WALL_HEIGHT };

describe('Crew scene layer (estructura de la sala)', () => {
  it('pinta el fondo de cámara con un único fillRect, sin tocar la geometría de la sala', () => {
    const { ctx, rects } = recordingCtx();
    drawCrewBackground(ctx, 900, 600);
    expect(rects).toEqual([[0, 0, 900, 600]]);
  });

  it('dibuja dos paredes y un piso, con el piso de Dirección distinto del resto', () => {
    const [ceo, development] = CREW_ROOMS;
    const ceoShell = recordingCtx();
    drawCrewRoomShell(ceoShell.ctx, ceo, ceo.width, ceo.depth, geometry);
    expect(ceoShell.fills).toHaveLength(3);
    const devShell = recordingCtx();
    drawCrewRoomShell(devShell.ctx, development, development.width, development.depth, geometry);
    expect(devShell.fills).toHaveLength(3);
    expect(ceoShell.fills[2]).not.toBe(devShell.fills[2]);
    expect(ceoShell.fills[0]).toBe(devShell.fills[0]);
    expect(ceoShell.fills[1]).toBe(devShell.fills[1]);
  });

  it('traza una línea de cuadrícula por cada unidad de ancho y de profundidad', () => {
    const room = CREW_ROOMS[0];
    const { ctx, strokes } = recordingCtx();
    drawCrewFloorGrid(ctx, room.width, room.depth, geometry);
    expect(strokes.count).toBe(room.width + 1 + room.depth + 1);
  });

  it('reproyecta el umbral de la puerta local al cambiar de cámara, sin usar el mapa global', () => {
    const room = CREW_ROOMS[0];
    let path: unknown[][] = [];
    let fill = '';
    const doors: unknown[][][] = [];
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get(_target, key) {
        if (key === 'beginPath') return () => { path = []; };
        if (key === 'moveTo' || key === 'lineTo') return (...args: unknown[]) => path.push(args);
        if (key === 'fill') return () => { if (fill === '#263b4d') doors.push([...path]); };
        return () => {};
      },
      set(_target, key, value) { if (key === 'fillStyle') fill = value as string; return true; },
    });
    for (const view of ['front', 'right'] as const) drawCrewDoors(ctx, room, view, geometry);
    expect(doors).toHaveLength(2);
    expect(doors[0][0]).toEqual(Object.values(crewIsoPoint(.25, 8)));
    expect(doors[1][0]).toEqual(Object.values(crewIsoPoint(0, .25)));
    expect(doors[0]).not.toEqual(doors[1]);
  });

  it('una sala sin puertas no dibuja ningún umbral', () => {
    const room = { ...CREW_ROOMS[0], doors: [] };
    const { ctx, fills } = recordingCtx();
    drawCrewDoors(ctx, room, 'front', geometry);
    expect(fills).toHaveLength(0);
  });
});
