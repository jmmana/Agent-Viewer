import { describe, expect, it } from 'vitest';
import { defaultCrewCamera, parseCrewCameraStore, validateCrewCamera } from '../../src/crew/crewCamera';

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
  it('rejects invalid versions, corrupt JSON, NaN/non-finite and unsafe input sizes', () => {
    expect(parseCrewCameraStore('{invalid')).toEqual({});
    expect(parseCrewCameraStore('x'.repeat(10001))).toEqual({});
    expect(validateCrewCamera({ view: 'orbit', zoom: 2, pan: { x: 0, y: 0 } })).toBeNull();
    expect(validateCrewCamera({ view: 'front', zoom: 100, pan: { x: 0, y: 0 } })).toBeNull();
    expect(validateCrewCamera({ view: 'front', zoom: 1, pan: { x: 100000, y: 0 } })).toBeNull();
  });
});
