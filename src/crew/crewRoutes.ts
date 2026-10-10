import { CREW_ROOM_EDGES, CREW_ROOMS, type CrewRoomDefinition, type CrewRoomEdge } from './crewModel';
import { crewPointIsFree, crewPresenceSlots, type CrewLocalPoint } from './crewSpatial';

/**
 * Cross-room connectivity and per-room walkable zones, built purely from the
 * existing `CrewRoomDefinition` catalog (doors, furniture, free presence
 * slots). No rendering, no art: this is the reusable data structure other
 * systems (such as the issue #129 navigation) can consume to move an agent
 * between zones or between rooms.
 */

export type CrewDoorStateValue = 'open' | 'locked';
/** Immutable map of edge id to its current state. Every edge starts open. */
export type CrewDoorStateMap = Readonly<Record<string, CrewDoorStateValue>>;

export function defaultCrewDoorStates(edges: readonly CrewRoomEdge[] = CREW_ROOM_EDGES): CrewDoorStateMap {
  const states: Record<string, CrewDoorStateValue> = {};
  for (const edge of edges) states[edge.id] = 'open';
  return states;
}

/** Pure update: returns a new map, never mutates the one it receives. */
export function setCrewDoorState(states: CrewDoorStateMap, edgeId: string, state: CrewDoorStateValue): CrewDoorStateMap {
  return { ...states, [edgeId]: state };
}

export function isCrewEdgeOpen(states: CrewDoorStateMap, edgeId: string): boolean {
  return states[edgeId] !== 'locked';
}

export interface CrewRoomGraphLink { doorId: string; edgeId: string; toRoomId: string }
/** Adjacency list keyed by room id, independent of door state. */
export type CrewRoomGraph = Readonly<Record<string, readonly CrewRoomGraphLink[]>>;

export function buildCrewRoomGraph(rooms: readonly CrewRoomDefinition[] = CREW_ROOMS): CrewRoomGraph {
  const graph: Record<string, CrewRoomGraphLink[]> = {};
  for (const room of rooms) {
    graph[room.id] = room.doors
      .filter((door): door is typeof door & { connectsTo: string; edgeId: string } =>
        door.connectsTo !== null && door.edgeId !== null)
      .map(door => ({ doorId: door.id, edgeId: door.edgeId, toRoomId: door.connectsTo }));
  }
  return graph;
}

export interface CrewRoomRoute { rooms: readonly string[]; doors: readonly string[] }

/**
 * Shortest path between two rooms by number of doors crossed, skipping any
 * edge currently locked in `doorStates`. Returns null when no open path
 * exists (locked doors can fully separate two rooms, as the issue asks).
 */
export function findCrewRoomRoute(
  graph: CrewRoomGraph, fromRoomId: string, toRoomId: string, doorStates: CrewDoorStateMap = defaultCrewDoorStates(),
): CrewRoomRoute | null {
  if (fromRoomId === toRoomId) return { rooms: [fromRoomId], doors: [] };
  if (!(fromRoomId in graph) || !(toRoomId in graph)) return null;
  const visited = new Set<string>([fromRoomId]);
  const queue: Array<{ roomId: string; rooms: string[]; doors: string[] }> = [{ roomId: fromRoomId, rooms: [fromRoomId], doors: [] }];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    for (const link of graph[current.roomId] ?? []) {
      if (!isCrewEdgeOpen(doorStates, link.edgeId) || visited.has(link.toRoomId)) continue;
      const nextRooms = [...current.rooms, link.toRoomId];
      const nextDoors = [...current.doors, link.doorId];
      if (link.toRoomId === toRoomId) return { rooms: nextRooms, doors: nextDoors };
      visited.add(link.toRoomId);
      queue.push({ roomId: link.toRoomId, rooms: nextRooms, doors: nextDoors });
    }
  }
  return null;
}

/** Every room reachable from `fromRoomId` with the given door states, fromRoomId included. */
export function reachableCrewRooms(
  graph: CrewRoomGraph, fromRoomId: string, doorStates: CrewDoorStateMap = defaultCrewDoorStates(),
): ReadonlySet<string> {
  const visited = new Set<string>([fromRoomId]);
  const queue = [fromRoomId];
  let head = 0;
  while (head < queue.length) {
    const roomId = queue[head++];
    for (const link of graph[roomId] ?? []) {
      if (!isCrewEdgeOpen(doorStates, link.edgeId) || visited.has(link.toRoomId)) continue;
      visited.add(link.toRoomId);
      queue.push(link.toRoomId);
    }
  }
  return visited;
}

/** Walkable zone: the free presence grid of a room plus 4-connected adjacency between cells. */
export interface CrewWalkGraph {
  nodes: readonly CrewLocalPoint[];
  /** Index of each node's directly reachable neighbours, by node index. */
  neighbors: ReadonlyArray<readonly number[]>;
}

function sameCell(a: CrewLocalPoint, b: CrewLocalPoint): boolean {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

/** A handful of points along a segment are clear of furniture: a cheap proxy for "the whole segment is walkable". */
function segmentIsFree(room: CrewRoomDefinition, from: CrewLocalPoint, to: CrewLocalPoint): boolean {
  for (const t of [0.25, 0.5, 0.75]) {
    if (!crewPointIsFree(room, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })) return false;
  }
  return true;
}

/**
 * Builds a navigable grid graph over a room's free presence slots (the same
 * floor grid `crewPresenceSlots` already derives from furniture collisions).
 * Two nodes are linked when they are one grid step apart on a single axis and
 * the straight segment between them stays clear of furniture. This is the
 * reusable "zonas navegables" structure other code (for example the #129
 * agent navigation) can run BFS/A* over without recomputing collisions.
 *
 * `crewPresenceSlots` also snaps the one grid cell nearest each door's
 * arrival point to its exact coordinate, so an arrival can land slightly off
 * the regular 1-unit grid. Any node left without a grid neighbour is instead
 * linked to its single nearest node with a clear line between them, so a
 * doorway is never an unreachable island on its own room's floor.
 */
export function buildCrewWalkGraph(room: CrewRoomDefinition): CrewWalkGraph {
  const nodes = crewPresenceSlots(room);
  const neighbors: number[][] = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
      const adjacentStep = (Math.abs(dx) < 1e-6 && Math.abs(dy - 1) < 1e-6)
        || (Math.abs(dy) < 1e-6 && Math.abs(dx - 1) < 1e-6);
      if (!adjacentStep || !segmentIsFree(room, nodes[i], nodes[j])) continue;
      neighbors[i].push(j);
      neighbors[j].push(i);
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    if (neighbors[i].length > 0) continue;
    let nearest = -1, nearestDistance = Infinity;
    for (let j = 0; j < nodes.length; j++) {
      if (j === i) continue;
      const distance = Math.hypot(nodes[j].x - nodes[i].x, nodes[j].y - nodes[i].y);
      if (distance < nearestDistance && segmentIsFree(room, nodes[i], nodes[j])) { nearest = j; nearestDistance = distance; }
    }
    if (nearest === -1) continue;
    neighbors[i].push(nearest);
    neighbors[nearest].push(i);
  }
  return { nodes, neighbors };
}

/** Breadth-first path between two points of a walk graph, in grid steps. Null when unreachable. */
export function findCrewWalkPath(graph: CrewWalkGraph, from: CrewLocalPoint, to: CrewLocalPoint): readonly CrewLocalPoint[] | null {
  const fromIndex = graph.nodes.findIndex(node => sameCell(node, from));
  const toIndex = graph.nodes.findIndex(node => sameCell(node, to));
  if (fromIndex === -1 || toIndex === -1) return null;
  if (fromIndex === toIndex) return [graph.nodes[fromIndex]];
  const previous = new Array<number>(graph.nodes.length).fill(-1);
  const visited = new Set<number>([fromIndex]);
  const queue = [fromIndex];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++];
    if (current === toIndex) break;
    for (const next of graph.neighbors[current]) {
      if (visited.has(next)) continue;
      visited.add(next);
      previous[next] = current;
      queue.push(next);
    }
  }
  if (!visited.has(toIndex)) return null;
  const path: CrewLocalPoint[] = [];
  for (let node = toIndex; node !== -1; node = previous[node]) {
    path.unshift(graph.nodes[node]);
    if (node === fromIndex) break;
  }
  return path;
}
