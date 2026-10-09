import { describe, expect, it } from 'vitest';
import { CREW_ROOMS, crewRoom } from '../../src/crew/crewModel';
import {
  aabbContains, aabbFromCenter, aabbsOverlap, agentAABB, crewAgentCollides,
  doorAABB, overlappingFurniturePairs, pointInAABB, propAABB, roomBoundsAABB, roomFurnitureBoxes,
} from '../../src/crew/crewCollision';

describe('AABB collision over existing Crew room data', () => {
  it('builds a centered box from width and depth', () => {
    expect(aabbFromCenter(5, 3, 2, 4)).toEqual({ minX: 4, minY: 1, maxX: 6, maxY: 5 });
  });

  it('detects overlap and containment with simple boxes', () => {
    const a = aabbFromCenter(0, 0, 2, 2);
    const b = aabbFromCenter(1, 1, 2, 2);
    const far = aabbFromCenter(10, 10, 2, 2);
    expect(aabbsOverlap(a, b)).toBe(true);
    expect(aabbsOverlap(a, far)).toBe(false);
    expect(aabbContains(roomBoundsAABB(crewRoom('ceo')!), a)).toBe(false);
    expect(aabbContains(aabbFromCenter(0, 0, 100, 100), a)).toBe(true);
    expect(pointInAABB({ x: 0, y: 0 }, a)).toBe(true);
    expect(pointInAABB({ x: 5, y: 5 }, a)).toBe(false);
  });

  it('none of the eleven rooms ships overlapping furniture footprints', () => {
    for (const room of CREW_ROOMS) {
      expect(overlappingFurniturePairs(room)).toEqual([]);
    }
  });

  it('indexes every furniture box of a room by its id', () => {
    const room = crewRoom('ceo')!;
    const boxes = roomFurnitureBoxes(room);
    expect(boxes.size).toBe(room.furniture.length);
    expect(boxes.get('ceo-desk')).toEqual(propAABB(room.furniture[0]));
  });

  it('rejects an agent box that leaves the room bounds', () => {
    const room = crewRoom('ceo')!;
    expect(crewAgentCollides(room, { x: -1, y: 1 })).toBe(true);
    expect(crewAgentCollides(room, { x: room.width + 1, y: 1 })).toBe(true);
    expect(crewAgentCollides(room, { x: 1, y: room.depth + 1 })).toBe(true);
  });

  it('rejects an agent box overlapping a furniture footprint, for several rooms', () => {
    for (const id of ['ceo', 'development', 'qa', 'meeting', 'infrastructure']) {
      const room = crewRoom(id)!;
      const desk = room.furniture[0];
      expect(crewAgentCollides(room, { x: desk.x, y: desk.y })).toBe(true);
    }
  });

  it('accepts a free spot clear of every footprint', () => {
    const room = crewRoom('development')!;
    expect(crewAgentCollides(room, { x: room.width - 1, y: room.depth - 1 })).toBe(false);
  });

  it('lets an agent re-check its own current furniture anchor without self-colliding', () => {
    const room = crewRoom('ceo')!;
    const chair = room.furniture.find(item => item.type === 'chair')!;
    expect(crewAgentCollides(room, { x: chair.x, y: chair.y }, undefined, chair.id)).toBe(false);
  });

  it('builds a door threshold box flush with the south wall, for every door of every room', () => {
    for (const room of CREW_ROOMS) {
      for (const door of room.doors) {
        const box = doorAABB(room, door);
        expect(box.minY).toBe(room.depth);
        expect(box.maxY).toBe(room.depth);
        expect(box.maxX - box.minX).toBe(door.width);
      }
    }
  });

  it('represents an agent footprint as a box centered on its point', () => {
    const box = agentAABB({ x: 2, y: 2 }, 0.3);
    expect(box).toEqual({ minX: 1.7, minY: 1.7, maxX: 2.3, maxY: 2.3 });
  });
});
