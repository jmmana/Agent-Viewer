import { describe, expect, it, vi } from 'vitest';
import { crewWorkstationPlacement, drawCrewWorkstation } from '../../src/crew/crewWorkstationLayer';
import { crewActionClip } from '../../src/crew/crewActionRegistry';
import { CREW_VIEWS } from '../../src/crew/crewModel';

describe('contactos del puesto CEO', () => {
  it('mantiene teclado y asiento sobre contactos fijos sin desplazar el suelo', () => {
    for (const view of CREW_VIEWS) {
      const p = crewWorkstationPlacement(view);
      expect(p.desk.x + p.spec.keyboard.x * p.deskScale).toBeCloseTo(p.spec.hands.x);
      expect(p.desk.y + p.spec.keyboard.y * p.deskScale).toBeCloseTo(p.spec.hands.y);
      expect(p.desk.y + p.spec.deskFoot * p.deskScale).toBeCloseTo(0);
      expect(p.chair.y + p.spec.chairFoot * p.chairScale).toBeCloseTo(0);
      expect(p.chair.x + (p.spec.seat.x - 640) * p.chairScale).toBeCloseTo(p.spec.hips.x);
    }
  });
  it('usa recortes propios de cada vista y el orden de oclusión apropiado', () => {
    for (const view of CREW_VIEWS) {
      const ctx = { drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn() };
      const furniture = {} as HTMLImageElement, actor = {} as HTMLImageElement;
      const sprites = { [view]: actor };
      const action = { image: actor, frame: crewActionClip('typing', view).frames[0] };
      drawCrewWorkstation(ctx as unknown as CanvasRenderingContext2D, { x: 0, y: 0 }, view, furniture, sprites, action);
      const calls = ctx.drawImage.mock.calls;
      expect(calls.filter(call => call[0] === furniture)).toHaveLength(2);
      expect(calls.filter(call => call[0] === furniture).every(call => call[2] === crewWorkstationPlacement(view).spec.y)).toBe(true);
      expect(calls[0][1]).toBe(view === 'back' ? 0 : 640);
      expect(ctx.clip).toHaveBeenCalledTimes(view === 'front' ? 1 : 0);
      expect(ctx.save.mock.calls.length).toBe(ctx.restore.mock.calls.length);
    }
  });
  it('el mueble no tiembla al cambiar de cuadro de typing', () => {
    const positions: unknown[][] = [];
    for (const frame of crewActionClip('typing', 'right').frames) {
      const image = {} as HTMLImageElement, actor = {} as HTMLImageElement;
      const ctx = { drawImage: vi.fn() };
      drawCrewWorkstation(ctx as unknown as CanvasRenderingContext2D, { x: 20, y: 30 }, 'right', image, { right: actor }, { image: actor, frame });
      positions.push(ctx.drawImage.mock.calls.filter(call => call[0] === image).map(call => call.slice(1)));
    }
    expect(positions.every(value => JSON.stringify(value) === JSON.stringify(positions[0]))).toBe(true);
  });
});
