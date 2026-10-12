import { describe, expect, it } from 'vitest';
import { CREW_ROOMS, crewRoom } from '../../src/crew/crewModel';
import { buildCrewWalkGraph } from '../../src/crew/crewRoutes';
import { crewPathAvoidsFurniture } from '../../src/crew/crewAgentNavigation';
import {
  CREW_WALK_SPEED, buildCrewWalkSegment, crewWalkFacing, crewWalkIsDone, crewWalkPosition, crewWalkTotalDistance,
  nearestCrewWalkNode,
} from '../../src/crew/crewAgentWalk';

const room = crewRoom('development')!;
const walk = buildCrewWalkGraph(room);

describe('Crew agent walk motion (#129)', () => {
  it('builds no segment for the same point or two points with no walkable route', () => {
    const point = walk.nodes[0];
    expect(buildCrewWalkSegment(room, point, point, 0)).toBeNull();
    expect(buildCrewWalkSegment(room, point, { x: -50, y: -50 }, 0)).toBeNull();
  });

  it('interpolates along the real path, staying clear of furniture at every sampled instant', () => {
    const from = walk.nodes[0], to = walk.nodes[walk.nodes.length - 1];
    const segment = buildCrewWalkSegment(room, from, to, 0)!;
    expect(segment).not.toBeNull();
    expect(crewWalkPosition(segment, 0)).toEqual(from);
    const total = crewWalkTotalDistance(segment);
    const durationMs = total / CREW_WALK_SPEED * 1000;
    for (const fraction of [0, .1, .25, .5, .75, .9, 1]) {
      const point = crewWalkPosition(segment, fraction * durationMs);
      expect(crewPathAvoidsFurniture(room, [point])).toBe(true);
    }
    expect(crewWalkPosition(segment, durationMs)).toEqual(to);
    expect(crewWalkIsDone(segment, durationMs - 1)).toBe(false);
    expect(crewWalkIsDone(segment, durationMs)).toBe(true);
    expect(crewWalkIsDone(segment, durationMs + 10_000)).toBe(true);
    // Never walks backwards in time: a now before startedAt behaves like the very start.
    expect(crewWalkPosition(segment, -500)).toEqual(from);
  });

  it('never reports a position past the final node once the walk is done', () => {
    const from = walk.nodes[0], to = walk.nodes[walk.nodes.length - 1];
    const segment = buildCrewWalkSegment(room, from, to, 1_000)!;
    const farFuture = crewWalkPosition(segment, 1_000 + 10 * crewWalkTotalDistance(segment) / CREW_WALK_SPEED * 1000);
    expect(farFuture).toEqual(to);
  });

  it('derives facing from the sub-segment currently being walked, matching a real cardinal step', () => {
    const [from, to] = (() => {
      for (let i = 0; i < walk.nodes.length; i++) {
        for (const j of walk.neighbors[i]) {
          if (walk.nodes[j].x === walk.nodes[i].x + 1 && walk.nodes[j].y === walk.nodes[i].y) return [walk.nodes[i], walk.nodes[j]];
        }
      }
      throw new Error('fixture room has no eastward step to exercise');
    })();
    const segment = buildCrewWalkSegment(room, from, to, 0)!;
    expect(crewWalkFacing(segment, 0)).toBe('SE');
    expect(crewWalkFacing(segment, crewWalkTotalDistance(segment) / CREW_WALK_SPEED * 1000)).toBeUndefined();
  });

  it('finds the nearest walk-graph node to an arbitrary mid-flight point, for replanning', () => {
    const node = walk.nodes[3];
    expect(nearestCrewWalkNode(room, { x: node.x + .1, y: node.y - .05 })).toEqual(node);
    const empty = { ...room, furniture: Array.from({ length: 400 }, (_, i) => ({ id: `blocker-${i}`, type: 'desk' as const, x: 0, y: 0 })) };
    expect(nearestCrewWalkNode(empty, { x: 1, y: 1 })).not.toBeNull();
  });

  it('builds an independent, furniture-avoiding segment for every room and every agent in a crowd of 50, with no exceptions', () => {
    for (const current of CREW_ROOMS) {
      const graph = buildCrewWalkGraph(current);
      if (graph.nodes.length < 2) continue;
      for (let i = 0; i < 50; i++) {
        const from = graph.nodes[i % graph.nodes.length];
        const to = graph.nodes[(i * 7 + 1) % graph.nodes.length];
        const segment = buildCrewWalkSegment(current, from, to, 0);
        if (!segment) continue; // same point this iteration; not every index pair differs.
        expect(crewPathAvoidsFurniture(current, segment.path)).toBe(true);
      }
    }
  });
});
