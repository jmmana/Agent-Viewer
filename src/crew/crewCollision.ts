import type { CrewRoomDefinition } from './crewModel';
import { CREW_PRESENCE_RADIUS, CREW_PROP_SIZE, type CrewLocalPoint } from './crewSpatial';

/**
 * Pure axis-aligned bounding box collision over the Crew local data that
 * already exists (room size, furniture anchors). No new props, no art: this
 * only turns existing anchors and sizes into boxes other systems can test.
 */
export interface CrewAABB { minX: number; minY: number; maxX: number; maxY: number }

export function aabbFromCenter(x: number, y: number, width: number, depth: number): CrewAABB {
  return { minX: x - width / 2, minY: y - depth / 2, maxX: x + width / 2, maxY: y + depth / 2 };
}

/** Footprint of a furniture anchor, ignoring height (top-down collision plane). */
export function propAABB(item: CrewRoomDefinition['furniture'][number]): CrewAABB {
  const size = CREW_PROP_SIZE[item.type];
  return aabbFromCenter(item.x, item.y, size.width, size.depth);
}

/** Walkable floor of the room, before subtracting the presence radius margin used by agents. */
export function roomBoundsAABB(room: CrewRoomDefinition): CrewAABB {
  return { minX: 0, minY: 0, maxX: room.width, maxY: room.depth };
}

/** Disc-shaped agent footprint approximated as a square AABB for broad-phase checks. */
export function agentAABB(point: CrewLocalPoint, radius = CREW_PRESENCE_RADIUS): CrewAABB {
  return aabbFromCenter(point.x, point.y, radius * 2, radius * 2);
}

export function aabbsOverlap(a: CrewAABB, b: CrewAABB): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

export function aabbContains(outer: CrewAABB, inner: CrewAABB): boolean {
  return inner.minX >= outer.minX && inner.maxX <= outer.maxX
    && inner.minY >= outer.minY && inner.maxY <= outer.maxY;
}

export function pointInAABB(point: CrewLocalPoint, box: CrewAABB): boolean {
  return point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY;
}

/** All furniture boxes of a room, keyed by furniture id, for reuse by other systems. */
export function roomFurnitureBoxes(room: CrewRoomDefinition): ReadonlyMap<string, CrewAABB> {
  return new Map(room.furniture.map(item => [item.id, propAABB(item)]));
}

/**
 * True when an agent box at `point` collides with any furniture footprint or
 * leaves the room bounds. `excludeId` lets an agent re-check its own current
 * anchor without self-colliding while standing still.
 */
export function crewAgentCollides(
  room: CrewRoomDefinition, point: CrewLocalPoint, radius = CREW_PRESENCE_RADIUS, excludeFurnitureId?: string,
): boolean {
  const box = agentAABB(point, radius);
  if (!aabbContains(roomBoundsAABB(room), box)) return true;
  return room.furniture.some(item => item.id !== excludeFurnitureId && aabbsOverlap(box, propAABB(item)));
}

/**
 * Data-integrity check over the static catalog: two furniture footprints
 * overlapping would mean a broken room (an agent could never reach one of
 * them). Returns the offending id pairs, empty when the room is valid.
 */
export function overlappingFurniturePairs(room: CrewRoomDefinition): ReadonlyArray<readonly [string, string]> {
  const pairs: Array<readonly [string, string]> = [];
  const items = room.furniture;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (aabbsOverlap(propAABB(items[i]), propAABB(items[j]))) pairs.push([items[i].id, items[j].id]);
    }
  }
  return pairs;
}

/** Door threshold footprint on the south wall, for collision checks against the wall opening. */
export function doorAABB(room: CrewRoomDefinition, door: CrewRoomDefinition['doors'][number]): CrewAABB {
  return { minX: door.offset - door.width / 2, maxX: door.offset + door.width / 2, minY: room.depth, maxY: room.depth };
}
