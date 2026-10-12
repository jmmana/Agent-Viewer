import { describe, expect, it } from 'vitest';
import { defaultCrewCamera } from '../../src/crew/crewCamera';
import { CREW_ROOMS, CREW_VIEWS, crewProject } from '../../src/crew/crewModel';
import { crewFitScale, crewGeometryBounds, crewIsoPoint } from '../../src/crew/renderCrewRoom';
import { constrainCrewPan, focusCrewFurniture, focusCrewPoint } from '../../src/crew/crewViewport';

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

  // #156: focusCrewPoint es la misma funcion pura que centra agentes (botón "Enfocar a
  // <agente>" en CrewStage.tsx) y, via focusCrewFurniture, escritorios/monitores. No hay
  // una funcion separada "de actor": ambos casos resuelven un punto del mundo y comparten
  // este unico camino de centrado, por eso se prueba directamente aqui con un punto
  // arbitrario (equivalente a la posicion de un agente) en vez de un id de mobiliario.
  it('centra un agente (focusCrewPoint) con la misma proyeccion del renderer que el mobiliario', () => {
    const room = CREW_ROOMS[0], viewport = { width: 1200, height: 800 }, target = { x: 7, y: 6 };
    for (const view of CREW_VIEWS) {
      const camera = focusCrewPoint({ ...defaultCrewCamera(), view }, room, target, viewport);
      const projected = crewProject(target.x, target.y, room, view);
      const point = crewIsoPoint(projected.x, projected.y);
      const bounds = crewGeometryBounds(room, view);
      const scale = crewFitScale(room, view, viewport.width, viewport.height) * camera.zoom;
      expect((point.x - bounds.centerX) * scale + camera.pan.x).toBeCloseTo(0);
      expect((point.y - bounds.centerY) * scale + camera.pan.y).toBeCloseTo(0);
    }
  });

  it('enfocar dos veces el mismo punto es idempotente (objetivo ya centrado y zoom ya en el minimo de foco, no-op)', () => {
    const room = CREW_ROOMS[0], viewport = { width: 1200, height: 800 };
    const once = focusCrewPoint(defaultCrewCamera(), room, { x: 7, y: 1 }, viewport);
    const twice = focusCrewPoint(once, room, { x: 7, y: 1 }, viewport);
    expect(twice).toEqual(once);
  });

  it('un objetivo muy fuera de la sala no deja el paneo fuera del viewport (se recorta, no se desborda)', () => {
    const room = CREW_ROOMS[0], viewport = { width: 320, height: 480 };
    const farTarget = { x: room.width * 50, y: room.depth * 50 };
    const camera = focusCrewPoint(defaultCrewCamera(), room, farTarget, viewport);
    expect(Math.abs(camera.pan.x)).toBeLessThanOrEqual(Math.max(0, viewport.width / 2 - 32));
    expect(Math.abs(camera.pan.y)).toBeLessThanOrEqual(Math.max(0, viewport.height / 2 - 32));
    // constrainCrewPan ya se aplicó dentro de focusCrewPoint: volver a aplicarlo no cambia nada.
    expect(constrainCrewPan(camera, viewport)).toEqual(camera);
  });

  it('el foco respeta los límites globales de zoom (nunca excede 3, nunca baja de .5, exige al menos 1.5)', () => {
    const room = CREW_ROOMS[0], viewport = { width: 1200, height: 800 }, target = { x: 1, y: 1 };
    const fromMax = focusCrewPoint({ view: 'front', zoom: 3, pan: { x: 0, y: 0 } }, room, target, viewport);
    expect(fromMax.zoom).toBe(3);
    const fromDefault = focusCrewPoint(defaultCrewCamera(), room, target, viewport);
    expect(fromDefault.zoom).toBe(1.5);
    expect(fromDefault.zoom).toBeLessThanOrEqual(3);
    expect(fromDefault.zoom).toBeGreaterThanOrEqual(.5);
  });
});
