import { zoomCrewCameraAt, type CrewCamera } from './crewCamera';

type Point = { x: number; y: number };

/** Punteros en píxeles CSS relativos al centro del viewport Crew. */
export class CrewGestures {
  private pointers = new Map<number, Point>();

  start(id: number, point: Point): void { this.pointers.set(id, point); }
  end(id: number): void { this.pointers.delete(id); }
  clear(): void { this.pointers.clear(); }

  move(id: number, point: Point): ((camera: CrewCamera) => CrewCamera) | null {
    if (!this.pointers.has(id)) return null;
    const before = [...this.pointers.values()].slice(0, 2);
    this.pointers.set(id, point);
    const after = [...this.pointers.values()].slice(0, 2);
    const center = (points: Point[]): Point => ({
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    });
    const previous = center(before), current = center(after);
    const distance = (points: Point[]) => Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
    const previousDistance = before.length === 2 ? distance(before) : 0;
    // Dedos coincidentes: solo trasladar hasta tener una distancia estable.
    const ratio = previousDistance > 1 ? distance(after) / previousDistance : 1;
    return camera => {
      const next = zoomCrewCameraAt(camera, camera.zoom * ratio, previous);
      return { ...next, pan: {
        x: next.pan.x + current.x - previous.x,
        y: next.pan.y + current.y - previous.y,
      } };
    };
  }
}
