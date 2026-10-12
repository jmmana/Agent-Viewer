import { crewProject, type CrewRoomDefinition } from './crewModel';
import { crewLampVisible, type CrewLamp } from './crewLamps';
import type { CrewCamera } from './crewCamera';
import { crewFitScale, crewGeometryBounds, crewIsoPoint } from './renderCrewRoom';
import { constrainCrewPan } from './crewViewport';

type Point = { x: number; y: number };
type Viewport = { width: number; height: number };

/** CSS pixel coordinates relative to the canvas top-left, independent of DPR. */
export function crewLampScreenPoint(lamp: CrewLamp, room: CrewRoomDefinition, camera: CrewCamera, viewport: Viewport): Point {
  const current = constrainCrewPan(camera, viewport);
  const p = crewProject(lamp.x, lamp.y, room, current.view);
  const point = crewIsoPoint(p.x, p.y, lamp.bulbZ);
  const bounds = crewGeometryBounds(room, current.view);
  const scale = crewFitScale(room, current.view, viewport.width, viewport.height) * current.zoom;
  return { x: viewport.width / 2 + current.pan.x + (point.x - bounds.centerX) * scale,
    y: viewport.height / 2 + current.pan.y + (point.y - bounds.centerY) * scale };
}

export function hitCrewLamp(point: Point, lamps: readonly CrewLamp[], room: CrewRoomDefinition,
  camera: CrewCamera, viewport: Viewport): CrewLamp | undefined {
  const radius = Math.max(12, 14 * crewFitScale(room, camera.view, viewport.width, viewport.height) * camera.zoom);
  return lamps.filter(lamp => crewLampVisible(lamp, room, camera.view)).map(lamp => {
    const p = crewLampScreenPoint(lamp, room, camera, viewport);
    return { lamp, p, distance: Math.hypot(point.x - p.x, point.y - p.y) };
  }).filter(({ p, distance }) => p.x >= 0 && p.x <= viewport.width && p.y >= 0 && p.y <= viewport.height && distance <= radius)
    .sort((a, b) => a.distance - b.distance)[0]?.lamp;
}

/** A drag, pinch, canceled pointer, or lost capture must never switch a light. */
export class CrewLampTap {
  private pointers = new Set<number>();
  private candidate: { id: number; start: Point } | null = null;
  start(id: number, point: Point): void {
    this.pointers.add(id);
    this.candidate = this.pointers.size === 1 ? { id, start: point } : null;
  }
  move(id: number, point: Point): void {
    if (this.candidate?.id === id && Math.hypot(point.x - this.candidate.start.x, point.y - this.candidate.start.y) > 5) this.candidate = null;
  }
  end(id: number, point: Point): boolean {
    this.move(id, point);
    const tap = this.candidate?.id === id;
    this.cancel(id);
    return tap;
  }
  cancel(id: number): void {
    this.pointers.delete(id);
    if (this.candidate?.id === id) this.candidate = null;
  }
  clear(): void { this.pointers.clear(); this.candidate = null; }
}
