import { describe, expect, it } from 'vitest';
import { CREW_ROOMS } from '../../src/crew/crewModel';
import { crewGeometryBounds, crewIsoPoint, crewViewSize, renderCrewRoom } from '../../src/crew/renderCrewRoom';

describe('Crew native 2.5D renderer', () => {
  it('projects floor and wall height into separate axes', () => {
    expect(crewIsoPoint(2, 1)).toEqual({ x: 34, y: 54 });
    expect(crewIsoPoint(2, 1, 20)).toEqual({ x: 34, y: 34 });
  });
  it('keeps room-local dimensions and changes them for side views', () => {
    const [ceo, dev] = CREW_ROOMS;
    expect(crewViewSize(ceo, 'front')).toEqual({ width: 11, depth: 8 });
    expect(crewViewSize(ceo, 'right')).toEqual({ width: 8, depth: 11 });
    const bounds = crewGeometryBounds(dev, 'left');
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    expect(crewGeometryBounds(ceo, 'front')).not.toEqual(crewGeometryBounds(dev, 'front'));
  });
  it('draws exactly the selected room, without consulting legacy office', () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get(_target, key) {
        if (key === 'fillText') return (...args: unknown[]) => { calls.push(['text', ...args]); };
        if (key === 'fillRect') return (...args: unknown[]) => { calls.push(['rect', ...args]); };
        return () => {};
      },
      set() { return true; },
    });
    renderCrewRoom({ ctx, width: 900, height: 600, room: CREW_ROOMS[0],
      camera: { view: 'front', zoom: 1, pan: { x: 0, y: 0 } }, locale: 'es' });
    expect(calls.some(row => row[0]==='text' && String(row[1]).includes('PROTOTIPO'))).toBe(true);
    expect(calls.filter(row => row[0]==='rect')).toHaveLength(1);
  });
});
