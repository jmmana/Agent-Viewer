import { describe, expect, it } from 'vitest';
import { defaultCrewCamera, parseCrewCameraStore, validateCrewCamera, zoomCrewCameraAt } from '../../src/crew/crewCamera';

describe('Crew camera preferences', () => {
  it('starts from a neutral isolated camera', () => {
    expect(defaultCrewCamera()).toEqual({ view: 'front', zoom: 1, pan: { x: 0, y: 0 } });
  });
  it('accepts valid state per registered room, discarding arbitrary room IDs', () => {
    const parsed = parseCrewCameraStore(JSON.stringify({
      ceo: { view: 'right', zoom: 2.3, pan: { x: 20, y: -40 } },
      development: { view: 'back', zoom: 1.2, pan: { x: 2, y: 4 } },
      phantom: { view: 'left', zoom: 3, pan: { x: 0, y: 0 } },
    }));
    expect(Object.keys(parsed)).toEqual(['ceo', 'development']);
    expect(parsed.ceo.zoom).toBe(2.3);
    expect(parsed.development.view).toBe('back');
  });
  it('zooms around a cursor without shifting its world point and clamps zoom', () => {
    const initial = { view: 'front' as const, zoom: 1, pan: { x: 0, y: 0 } };
    const zoomed = zoomCrewCameraAt(initial, 2, { x: 100, y: 40 });
    expect(zoomed.zoom).toBe(2);
    expect(zoomed.pan).toEqual({ x: -100, y: -40 });
    expect(zoomCrewCameraAt(zoomed, 1, { x: 100, y: 40 })).toEqual(initial);
    expect(zoomCrewCameraAt(initial, 50, { x: 0, y: 0 }).zoom).toBe(3);
    expect(zoomCrewCameraAt(initial, 0, { x: 0, y: 0 }).zoom).toBe(.5);
  });
  it('rejects invalid versions, corrupt JSON, NaN/non-finite and unsafe input sizes', () => {
    expect(parseCrewCameraStore('{invalid')).toEqual({});
    expect(parseCrewCameraStore('x'.repeat(10001))).toEqual({});
    expect(validateCrewCamera({ view: 'orbit', zoom: 2, pan: { x: 0, y: 0 } })).toBeNull();
    expect(validateCrewCamera({ view: 'front', zoom: 100, pan: { x: 0, y: 0 } })).toBeNull();
    expect(validateCrewCamera({ view: 'front', zoom: 1, pan: { x: 100000, y: 0 } })).toBeNull();
  });
});
