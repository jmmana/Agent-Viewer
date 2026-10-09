import { describe, expect, it } from 'vitest';
import { CREW_ROOM_EDGES, CREW_ROOMS } from '../../src/crew/crewModel';
import {
  buildCrewRoomGraph, buildCrewWalkGraph, defaultCrewDoorStates, findCrewRoomRoute,
  findCrewWalkPath, isCrewEdgeOpen, reachableCrewRooms, setCrewDoorState,
} from '../../src/crew/crewRoutes';

describe('functional doors connecting Crew rooms', () => {
  const graph = buildCrewRoomGraph();

  it('builds one edge endpoint per door that declares a neighbour', () => {
    const totalLinks = CREW_ROOMS.reduce((n, room) => n + room.doors.length, 0);
    const totalGraphLinks = Object.values(graph).reduce((n, links) => n + links.length, 0);
    expect(totalGraphLinks).toBe(totalLinks);
    expect(totalGraphLinks).toBe(CREW_ROOM_EDGES.length * 2);
  });

  it('every one of the eleven rooms can reach every other room with every door open', () => {
    const states = defaultCrewDoorStates();
    for (const room of CREW_ROOMS) {
      const reachable = reachableCrewRooms(graph, room.id, states);
      expect(reachable.size).toBe(CREW_ROOMS.length);
    }
  });

  it('finds a direct one-door route between two adjacent rooms', () => {
    const route = findCrewRoomRoute(graph, 'reception', 'ceo');
    expect(route).toEqual({ rooms: ['reception', 'ceo'], doors: ['reception-entry'] });
  });

  it('finds a multi-door route across the spanning tree', () => {
    const route = findCrewRoomRoute(graph, 'ceo', 'infrastructure');
    expect(route).not.toBeNull();
    expect(route!.rooms[0]).toBe('ceo');
    expect(route!.rooms[route!.rooms.length - 1]).toBe('infrastructure');
    expect(route!.rooms).toEqual(['ceo', 'reception', 'lounge', 'coffee', 'meeting', 'development', 'research', 'qa', 'infrastructure']);
    expect(route!.doors).toHaveLength(route!.rooms.length - 1);
  });

  it('a route to the same room needs no door', () => {
    expect(findCrewRoomRoute(graph, 'qa', 'qa')).toEqual({ rooms: ['qa'], doors: [] });
  });

  it('returns null for an unknown room id', () => {
    expect(findCrewRoomRoute(graph, 'qa', 'unknown')).toBeNull();
  });

  it('locking a door removes it from an otherwise open path, without mutating the previous map', () => {
    const open = defaultCrewDoorStates();
    const locked = setCrewDoorState(open, 'e-reception-ceo', 'locked');
    expect(isCrewEdgeOpen(open, 'e-reception-ceo')).toBe(true);
    expect(isCrewEdgeOpen(locked, 'e-reception-ceo')).toBe(false);
    expect(findCrewRoomRoute(graph, 'reception', 'ceo', locked)).toBeNull();
  });

  it('locking the only door into a leaf room disconnects it from the rest of the building', () => {
    const locked = setCrewDoorState(defaultCrewDoorStates(), 'e-qa-infrastructure', 'locked');
    expect(findCrewRoomRoute(graph, 'ceo', 'infrastructure', locked)).toBeNull();
    expect(reachableCrewRooms(graph, 'ceo', locked).has('infrastructure')).toBe(false);
    expect(reachableCrewRooms(graph, 'infrastructure', locked)).toEqual(new Set(['infrastructure']));
  });

  it('locking an internal door splits the building into exactly the two sides of that edge', () => {
    // The building is a spanning tree (10 edges for 11 rooms): every door is a
    // bridge, so locking one fully separates its two sides, with no detour.
    const locked = setCrewDoorState(defaultCrewDoorStates(), 'e-meeting-development', 'locked');
    expect(findCrewRoomRoute(graph, 'ceo', 'development', locked)).toBeNull();
    const fromCeo = reachableCrewRooms(graph, 'ceo', locked);
    const fromDevelopment = reachableCrewRooms(graph, 'development', locked);
    expect(fromCeo).toEqual(new Set(['ceo', 'reception', 'finance', 'lounge', 'coffee', 'meeting']));
    expect(fromDevelopment).toEqual(new Set(['development', 'planning', 'research', 'qa', 'infrastructure']));
    expect(fromCeo.size + fromDevelopment.size).toBe(CREW_ROOMS.length);
  });
});

describe('walkable zones reusable for navigation (issue #129)', () => {
  it('builds a connected grid graph for several of the eleven rooms', () => {
    for (const id of ['ceo', 'development', 'qa', 'meeting', 'infrastructure', 'reception']) {
      const room = CREW_ROOMS.find(r => r.id === id)!;
      const walk = buildCrewWalkGraph(room);
      expect(walk.nodes.length).toBe(room.capacity);
      expect(walk.neighbors).toHaveLength(walk.nodes.length);
      expect(walk.nodes.length).toBeGreaterThan(0);
      // Every free cell must have at least one neighbour: the floor is one connected zone.
      for (const neighbors of walk.neighbors) expect(neighbors.length).toBeGreaterThan(0);
    }
  });

  it('finds a walkable path between two far corners of a room, without crossing furniture', () => {
    const room = CREW_ROOMS.find(r => r.id === 'development')!;
    const walk = buildCrewWalkGraph(room);
    const from = walk.nodes[0];
    const to = walk.nodes[walk.nodes.length - 1];
    const path = findCrewWalkPath(walk, from, to);
    expect(path).not.toBeNull();
    expect(path![0]).toEqual(from);
    expect(path![path!.length - 1]).toEqual(to);
    // Every step is a short local hop (a one-unit grid step, or the single
    // nearest-node fallback link used for an off-grid doorway arrival), never
    // a jump across the room.
    for (let i = 1; i < path!.length; i++) {
      const distance = Math.hypot(path![i].x - path![i - 1].x, path![i].y - path![i - 1].y);
      expect(distance).toBeLessThanOrEqual(2.5);
    }
  });

  it('returns null when a requested point is not part of the walk graph', () => {
    const room = CREW_ROOMS.find(r => r.id === 'ceo')!;
    const walk = buildCrewWalkGraph(room);
    expect(findCrewWalkPath(walk, { x: -5, y: -5 }, walk.nodes[0])).toBeNull();
  });

  it('a path to the same cell is a single point', () => {
    const room = CREW_ROOMS.find(r => r.id === 'qa')!;
    const walk = buildCrewWalkGraph(room);
    expect(findCrewWalkPath(walk, walk.nodes[0], walk.nodes[0])).toEqual([walk.nodes[0]]);
  });
});
