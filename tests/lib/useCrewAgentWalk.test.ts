import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useCrewAgentWalk } from '../../src/crew/useCrewAgentWalk';
import { crewRoom } from '../../src/crew/crewModel';
import { buildCrewWalkGraph } from '../../src/crew/crewRoutes';
import type { CrewPresenceMarker } from '../../src/crew/crewPresence';

const room = crewRoom('development')!;
const walk = buildCrewWalkGraph(room);

function marker(id: string, point: { x: number; y: number }, isWalking: boolean): CrewPresenceMarker {
  return { id, name: id, status: 'CODING', number: 1, x: point.x, y: point.y, ...(isWalking ? { isWalking: true } : {}) };
}

describe('useCrewAgentWalk (#129)', () => {
  let now = 0;
  beforeEach(() => { now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now); });
  afterEach(() => vi.restoreAllMocks());

  it('renders a resting marker exactly as given, never animating it', () => {
    const rest = walk.nodes[0];
    const { result } = renderHook(({ markers }) => useCrewAgentWalk(room, markers, false), {
      initialProps: { markers: [marker('a', rest, false)] },
    });
    expect(result.current[0]).toEqual(marker('a', rest, false));
  });

  it('never invents a starting point for an agent first seen walking', () => {
    const point = walk.nodes[1];
    const { result } = renderHook(({ markers }) => useCrewAgentWalk(room, markers, false), {
      initialProps: { markers: [marker('a', point, true)] },
    });
    expect(result.current[0].x).toBe(point.x);
    expect(result.current[0].y).toBe(point.y);
  });

  it('animates from the last resting point toward a new target, reaching exactly that target', () => {
    const from = walk.nodes[0], to = walk.nodes[walk.nodes.length - 1];
    const { result, rerender } = renderHook(({ markers }) => useCrewAgentWalk(room, markers, false), {
      initialProps: { markers: [marker('a', from, false)] as readonly CrewPresenceMarker[] },
    });
    now = 1_000;
    rerender({ markers: [marker('a', to, true)] });
    const mid = result.current[0];
    expect(mid.x !== to.x || mid.y !== to.y).toBe(true); // mid-flight: never teleported to the target instantly
    now = 1_000 + 60_000; // far more than any room crossing needs at CREW_WALK_SPEED
    rerender({ markers: [marker('a', to, true)] });
    expect(result.current[0].x).toBe(to.x);
    expect(result.current[0].y).toBe(to.y);
  });

  it('snaps immediately under reduced motion, never animating', () => {
    const from = walk.nodes[0], to = walk.nodes[walk.nodes.length - 1];
    const { result, rerender } = renderHook(({ markers }) => useCrewAgentWalk(room, markers, true), {
      initialProps: { markers: [marker('a', from, false)] as readonly CrewPresenceMarker[] },
    });
    now = 10;
    rerender({ markers: [marker('a', to, true)] });
    expect(result.current[0].x).toBe(to.x);
    expect(result.current[0].y).toBe(to.y);
  });

  it('cancels a mid-flight walk the instant the domain reports arrival, never keeps animating', () => {
    const from = walk.nodes[0], to = walk.nodes[walk.nodes.length - 1];
    const { result, rerender } = renderHook(({ markers }) => useCrewAgentWalk(room, markers, false), {
      initialProps: { markers: [marker('a', from, false)] as readonly CrewPresenceMarker[] },
    });
    now = 1_000;
    rerender({ markers: [marker('a', to, true)] });
    expect(result.current[0].x !== to.x || result.current[0].y !== to.y).toBe(true);
    now = 1_100;
    rerender({ markers: [marker('a', to, false)] });
    expect(result.current[0]).toEqual(marker('a', to, false));
  });

  it('clears all walk state on a room switch, never leaking motion into the new room', () => {
    const otherRoom = crewRoom('ceo')!;
    const from = walk.nodes[0], to = walk.nodes[walk.nodes.length - 1];
    const { result, rerender } = renderHook(({ room: r, markers }) => useCrewAgentWalk(r, markers, false), {
      initialProps: { room, markers: [marker('a', from, false)] as readonly CrewPresenceMarker[] },
    });
    now = 1_000;
    rerender({ room, markers: [marker('a', to, true)] });
    rerender({ room: otherRoom, markers: [] });
    rerender({ room, markers: [marker('a', from, false)] });
    expect(result.current[0]).toEqual(marker('a', from, false));
  });

  it('drops walk state for an agent that is no longer present, without touching the others', () => {
    const point = walk.nodes[2];
    const { result, rerender } = renderHook(({ markers }) => useCrewAgentWalk(room, markers, false), {
      initialProps: { markers: [marker('a', point, false), marker('b', point, false)] as readonly CrewPresenceMarker[] },
    });
    rerender({ markers: [marker('b', point, false)] });
    expect(result.current).toHaveLength(1);
    expect(result.current[0].id).toBe('b');
  });

  it('handles a crowd of 50 simultaneously walking agents without throwing or losing anyone', () => {
    const agents = Array.from({ length: 50 }, (_, i) => marker(`agent-${i}`, walk.nodes[i % walk.nodes.length], false));
    const { result, rerender } = renderHook(({ markers }) => useCrewAgentWalk(room, markers, false), { initialProps: { markers: agents } });
    now = 500;
    const walking = agents.map((item, i) => marker(item.id, walk.nodes[(i * 3 + 1) % walk.nodes.length], true));
    expect(() => rerender({ markers: walking })).not.toThrow();
    expect(result.current).toHaveLength(50);
  });
});
