import { describe, expect, it } from 'vitest';
import { CrewGestures } from '../../src/crew/crewGestures';
import { defaultCrewCamera } from '../../src/crew/crewCamera';

describe('Gestos de cámara Crew', () => {
  it('combina pinch y desplazamiento conservando el punto bajo el centro de los dedos', () => {
    const gestures = new CrewGestures();
    gestures.start(1, { x: 20, y: 30 });
    gestures.start(2, { x: 120, y: 30 });
    const camera = gestures.move(2, { x: 220, y: 30 })!(defaultCrewCamera());
    expect(camera.zoom).toBe(2);
    expect(camera.pan).toEqual({ x: -20, y: -30 });
    expect((120 - camera.pan.x) / camera.zoom).toBe(70);
    expect((30 - camera.pan.y) / camera.zoom).toBe(30);
  });
  it('continúa con un dedo sin salto después de cancelar el otro', () => {
    const gestures = new CrewGestures();
    gestures.start(1, { x: 0, y: 0 });
    gestures.start(2, { x: 100, y: 0 });
    let camera = gestures.move(2, { x: 200, y: 0 })!(defaultCrewCamera());
    gestures.end(1);
    const previous = camera;
    camera = gestures.move(2, { x: 210, y: 15 })!(camera);
    expect(camera.zoom).toBe(previous.zoom);
    expect(camera.pan).toEqual({ x: previous.pan.x + 10, y: previous.pan.y + 15 });
    expect(gestures.move(1, { x: 50, y: 50 })).toBeNull();
  });
  it('ignora movimientos ajenos y limpia los gestos al cambiar de sala', () => {
    const gestures = new CrewGestures();
    expect(gestures.move(1, { x: 1, y: 1 })).toBeNull();
    gestures.start(1, { x: 0, y: 0 });
    gestures.clear();
    expect(gestures.move(1, { x: 1, y: 1 })).toBeNull();
  });
  it('tolera dedos coincidentes y limita el zoom sin dividir por cero', () => {
    const gestures = new CrewGestures();
    gestures.start(1, { x: 0, y: 0 });
    gestures.start(2, { x: 0, y: 0 });
    let camera = gestures.move(2, { x: 100, y: 0 })!(defaultCrewCamera());
    expect(camera.zoom).toBe(1);
    camera = gestures.move(2, { x: 10000, y: 0 })!(camera);
    expect(camera.zoom).toBe(3);
    expect(Number.isFinite(camera.pan.x)).toBe(true);
    camera = gestures.move(2, { x: 0, y: 0 })!(camera);
    expect(camera.zoom).toBe(.5);
  });
});
