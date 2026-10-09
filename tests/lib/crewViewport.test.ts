import { describe, expect, it } from 'vitest';
import { defaultCrewCamera } from '../../src/crew/crewCamera';
import { CREW_ROOMS, CREW_VIEWS, crewProject } from '../../src/crew/crewModel';
import { crewFitScale, crewGeometryBounds, crewIsoPoint } from '../../src/crew/renderCrewRoom';
import { constrainCrewPan, focusCrewFurniture } from '../../src/crew/crewViewport';

describe('Encuadre Crew', () => {
  it('mantiene un punto interior de la sala visible después de paneos extremos y resize', () => {
    for (const width of [320, 1920]) for (const height of [120, 1080]) {
      const camera = constrainCrewPan({ ...defaultCrewCamera(), pan: { x: 5000, y: -5000 } }, {width,height});
      expect(width / 2 + camera.pan.x).toBeLessThanOrEqual(width - 32);
      expect(height / 2 + camera.pan.y).toBeGreaterThanOrEqual(32);
      expect(constrainCrewPan(camera, {width,height})).toBe(camera);
    }
  });
  it('centra el escritorio CEO desde las cuatro vistas usando la proyección del renderer', () => {
    const room = CREW_ROOMS[0], item = room.furniture[0];
    const viewport = {width:1200,height:800};
    for (const view of CREW_VIEWS) {
      const camera = focusCrewFurniture({ ...defaultCrewCamera(), view }, room, item.id, viewport);
      const projected = crewProject(item.x,item.y,room,view);
      const point = crewIsoPoint(projected.x,projected.y);
      const bounds = crewGeometryBounds(room,view);
      const scale = crewFitScale(room,view,viewport.width,viewport.height) * camera.zoom;
      expect((point.x-bounds.centerX)*scale+camera.pan.x).toBeCloseTo(0);
      expect((point.y-bounds.centerY)*scale+camera.pan.y).toBeCloseTo(0);
      expect(camera.view).toBe(view);
    }
  });
  it('no enfoca un escritorio de otra sala ni modifica el layout', () => {
    const camera = defaultCrewCamera(), room = CREW_ROOMS[0];
    const saved = JSON.stringify(room);
    expect(focusCrewFurniture(camera,room,'dev-desk-1',{width:320,height:800})).toBe(camera);
    focusCrewFurniture(camera,room,'ceo-display',{width:320,height:800});
    expect(JSON.stringify(room)).toBe(saved);
  });
});
