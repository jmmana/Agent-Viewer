import type { Agent } from '../types/agent';
import { crewFacingFromDelta } from './crewActorActions';
import { planCrewWalkWithinRoom } from './crewAgentNavigation';
import { buildCrewWalkGraph } from './crewRoutes';
import type { CrewRoomDefinition } from './crewModel';
import type { CrewLocalPoint } from './crewSpatial';

/**
 * Local-only walking motion for Crew (#129): an agent reported as walking moves
 * across its room's real walkable grid, avoiding the same furniture collisions
 * `crewPresenceSlots`/`crewPointIsFree` already enforce for resting positions,
 * instead of snapping between slots. Pure math; no rendering, no timers, no
 * domain writes. The domain's own x/y/targetX/targetY never change.
 */

/** Local units per second. Tuned so a typical room crossing takes a few seconds, not an instant jump or a crawl. */
export const CREW_WALK_SPEED = 2.4;

export interface CrewWalkSegment {
  readonly path: readonly CrewLocalPoint[];
  /** Cumulative distance in local units at each path node; same length as `path`, `cumulative[0] === 0`. */
  readonly cumulative: readonly number[];
  readonly startedAt: number;
}

function cumulativeDistances(path: readonly CrewLocalPoint[]): number[] {
  const cumulative = [0];
  for (let i = 1; i < path.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  }
  return cumulative;
}

/** Nearest walk-graph node to an arbitrary point, for replanning from a mid-flight position. Null for an empty graph. */
export function nearestCrewWalkNode(room: CrewRoomDefinition, point: CrewLocalPoint): CrewLocalPoint | null {
  const nodes = buildCrewWalkGraph(room).nodes;
  if (nodes.length === 0) return null;
  return nodes.reduce((best, node) =>
    Math.hypot(node.x - point.x, node.y - point.y) < Math.hypot(best.x - point.x, best.y - point.y) ? node : best);
}

/**
 * A real, furniture-avoiding segment from `from` to `to`, or `null` when they
 * are the same point or no walkable route connects them (honest fallback: the
 * caller snaps instead of inventing a path through a wall or a desk).
 */
export function buildCrewWalkSegment(room: CrewRoomDefinition, from: CrewLocalPoint, to: CrewLocalPoint, startedAt: number): CrewWalkSegment | null {
  if (from.x === to.x && from.y === to.y) return null;
  const path = planCrewWalkWithinRoom(room, from, to);
  if (!path || path.length < 2) return null;
  return { path, cumulative: cumulativeDistances(path), startedAt };
}

function elapsedDistance(segment: CrewWalkSegment, now: number): number {
  return Math.max(0, now - segment.startedAt) / 1000 * CREW_WALK_SPEED;
}

export function crewWalkTotalDistance(segment: CrewWalkSegment): number {
  return segment.cumulative[segment.cumulative.length - 1];
}

export function crewWalkIsDone(segment: CrewWalkSegment, now: number): boolean {
  return elapsedDistance(segment, now) >= crewWalkTotalDistance(segment);
}

/** Current interpolated point; clamps to the final node once the segment completes. */
export function crewWalkPosition(segment: CrewWalkSegment, now: number): CrewLocalPoint {
  const distance = elapsedDistance(segment, now);
  const total = crewWalkTotalDistance(segment);
  const last = segment.path[segment.path.length - 1];
  if (total <= 0 || distance >= total) return last;
  let i = 0;
  while (i < segment.cumulative.length - 2 && segment.cumulative[i + 1] < distance) i++;
  const segStart = segment.cumulative[i], segEnd = segment.cumulative[i + 1];
  const t = segEnd > segStart ? (distance - segStart) / (segEnd - segStart) : 1;
  const a = segment.path[i], b = segment.path[i + 1];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Direction of the sub-segment currently being walked; undefined once arrived (no more segment to face). */
export function crewWalkFacing(segment: CrewWalkSegment, now: number): Agent['facing'] | undefined {
  if (crewWalkIsDone(segment, now)) return undefined;
  const distance = elapsedDistance(segment, now);
  let i = 0;
  while (i < segment.cumulative.length - 2 && segment.cumulative[i + 1] < distance) i++;
  const a = segment.path[i], b = segment.path[i + 1];
  return crewFacingFromDelta(b.x - a.x, b.y - a.y);
}
