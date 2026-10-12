import { useEffect, useRef, useState } from 'react';
import type { CrewRoomDefinition } from './crewModel';
import type { CrewPresenceMarker } from './crewPresence';
import {
  buildCrewWalkSegment, crewWalkFacing, crewWalkIsDone, crewWalkPosition, nearestCrewWalkNode, type CrewWalkSegment,
} from './crewAgentWalk';
import type { CrewLocalPoint } from './crewSpatial';

interface CrewAgentWalkState {
  segment: CrewWalkSegment | null;
  to: CrewLocalPoint;
  restPoint: CrewLocalPoint;
}

/**
 * Presentation-only local motion for walking markers (#129): an agent the
 * domain reports as `isWalking` moves across the real walkable grid of its
 * room, avoiding furniture, instead of snapping between static presence
 * slots. Never touches the domain snapshot, never invents a starting point
 * for an agent first seen walking (it renders at its assigned slot until a
 * later change in destination gives a real "from"), and always resolves to
 * exactly the slot `projectCrewPresence` assigned once the walk completes.
 */
export function useCrewAgentWalk(room: CrewRoomDefinition, markers: readonly CrewPresenceMarker[], reducedMotion: boolean): readonly CrewPresenceMarker[] {
  const stateRef = useRef(new Map<string, CrewAgentWalkState>());
  const roomIdRef = useRef(room.id);
  const [reducedQuery, setReducedQuery] = useState(() => typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReducedQuery(media.matches);
    const visibility = () => setVisible(!document.hidden);
    media.addEventListener('change', motion);
    document.addEventListener('visibilitychange', visibility);
    return () => { media.removeEventListener('change', motion); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  const active = !reducedMotion && !reducedQuery && visible;

  if (roomIdRef.current !== room.id) { stateRef.current.clear(); roomIdRef.current = room.id; }
  const presentIds = new Set(markers.map(marker => marker.id));
  for (const id of Array.from(stateRef.current.keys())) if (!presentIds.has(id)) stateRef.current.delete(id);

  const anyWalking = active && markers.some(marker => marker.isWalking);
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!anyWalking) return;
    let frame = requestAnimationFrame(function tick() {
      forceTick(value => value + 1);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [anyWalking, room.id]);

  const now = performance.now();
  return markers.map(marker => {
    const target: CrewLocalPoint = { x: marker.x, y: marker.y };
    if (!marker.isWalking || !active) {
      stateRef.current.set(marker.id, { segment: null, to: target, restPoint: target });
      return marker;
    }
    const existing = stateRef.current.get(marker.id);
    if (!existing) {
      // First sighting while walking: no real prior position to animate from.
      stateRef.current.set(marker.id, { segment: null, to: target, restPoint: target });
      return marker;
    }
    const retargeted = existing.to.x !== target.x || existing.to.y !== target.y;
    if (retargeted) {
      const from = existing.segment ? (nearestCrewWalkNode(room, crewWalkPosition(existing.segment, now)) ?? existing.restPoint) : existing.restPoint;
      const segment = buildCrewWalkSegment(room, from, target, now);
      stateRef.current.set(marker.id, { segment, to: target, restPoint: existing.restPoint });
      if (!segment) return marker;
      const point = crewWalkPosition(segment, now);
      return { ...marker, x: point.x, y: point.y, facing: crewWalkFacing(segment, now) ?? marker.facing };
    }
    if (!existing.segment || crewWalkIsDone(existing.segment, now)) {
      stateRef.current.set(marker.id, { segment: null, to: target, restPoint: target });
      return marker;
    }
    const point = crewWalkPosition(existing.segment, now);
    return { ...marker, x: point.x, y: point.y, facing: crewWalkFacing(existing.segment, now) ?? marker.facing };
  });
}
