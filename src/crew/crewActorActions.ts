import type { Agent } from '../types/agent';
import type { CrewRoomDefinition } from './crewModel';
import type { CrewPresenceMarker } from './crewPresence';
import { crewRoomForWorkspace } from './crewEvents';

export type CrewActionId = 'turn' | 'sit' | 'stand' | 'typing';
export type CrewObservedAgent = Pick<Agent, 'id' | 'workspace' | 'role' | 'status' | 'x' | 'y' | 'targetX' | 'targetY' | 'isWalking' | 'facing'>;
export interface CrewWorkstation { deskId: string; chairId: string; x: number; y: number; facing: Agent['facing'] }
export interface CrewActorAction {
  id: string;
  observed: CrewObservedAgent;
  facing: Agent['facing'];
  seated: boolean;
  turnFrom?: Agent['facing'];
  clip: CrewActionId | null;
  startedAt: number;
  workstation?: CrewWorkstation;
}
export const CREW_ACTION_DURATION_MS = 800;

/** Dirección dominante de un vector real en los ejes locales del dominio. */
export function crewFacingFromDelta(dx: number, dy: number): Agent['facing'] | undefined {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < .001) return undefined;
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'SE' : 'NW') : (dy > 0 ? 'SW' : 'NE');
}

/** Desplazamiento observado primero; objetivo del tránsito después; orientación reportada al final. */
export function crewObservedFacing(agent: CrewObservedAgent, previous?: CrewObservedAgent): Agent['facing'] {
  if (agent.isWalking) {
    const moved = previous?.workspace === agent.workspace
      ? crewFacingFromDelta(agent.x - previous.x, agent.y - previous.y) : undefined;
    const target = crewFacingFromDelta(agent.targetX - agent.x, agent.targetY - agent.y);
    if (moved || target) return (moved ?? target)!;
  }
  return agent.facing;
}

/** Reserva de presentación local, sin trasladar coordenadas ni muebles del dominio. */
export function crewWorkstations(room: CrewRoomDefinition): CrewWorkstation[] {
  const chairs = room.furniture.filter(item => item.type === 'chair');
  const used = new Set<string>();
  return room.furniture.filter(item => item.type === 'desk').flatMap(desk => {
    const chair = chairs.filter(item => !used.has(item.id)).sort((a, b) =>
      Math.hypot(a.x - desk.x, a.y - desk.y) - Math.hypot(b.x - desk.x, b.y - desk.y))[0];
    if (!chair) return [];
    used.add(chair.id);
    return [{ deskId: desk.id, chairId: chair.id, x: chair.x, y: chair.y,
      facing: crewFacingFromDelta(desk.x - chair.x, desk.y - chair.y) ?? 'NE' }];
  });
}

/** Estados laborales existentes; THINKING/READING/USING_TOOL nunca implican teclear. */
export function crewReportsTyping(agent: CrewObservedAgent): boolean {
  return !agent.isWalking && (agent.status === 'CODING' || agent.status === 'WRITING');
}

/** Reductor puro de presentación: el snapshot y su cámara permanecen intactos. */
export function updateCrewActorActions(agents: readonly CrewObservedAgent[], room: CrewRoomDefinition,
  previous: readonly CrewActorAction[], now: number): CrewActorAction[] {
  const stations = crewWorkstations(room);
  const used = new Set<string>();
  const result: CrewActorAction[] = [];
  for (const agent of agents.filter(item => item.role === 'boss' && crewRoomForWorkspace(item.workspace) === room.id).slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const before = previous.find(item => item.id === agent.id && item.observed.workspace === agent.workspace);
    let workstation = before?.workstation;
    if (workstation && used.has(workstation.chairId)) workstation = undefined;
    if (crewReportsTyping(agent) && !workstation) workstation = stations.find(item => !used.has(item.chairId));
    const seated = crewReportsTyping(agent) && !!workstation;
    const unchanged = before && agent.x === before.observed.x && agent.y === before.observed.y
      && agent.targetX === before.observed.targetX && agent.targetY === before.observed.targetY
      && agent.facing === before.observed.facing && agent.isWalking === before.observed.isWalking;
    const facing = seated ? workstation!.facing : agent.isWalking && unchanged ? before.facing : crewObservedFacing(agent, before?.observed);
    let turnFrom = before?.turnFrom;
    let clip = before?.clip ?? null, startedAt = before?.startedAt ?? now;
    if (seated !== !!before?.seated) { clip = seated ? 'sit' : 'stand'; startedAt = now; turnFrom = undefined; }
    else if (!seated && clip !== 'stand' && before && facing !== before.facing && !agent.isWalking) { clip = 'turn'; startedAt = now; turnFrom = before.facing; }
    else if (!before && seated) { clip = 'sit'; startedAt = now; }
    if (clip === 'sit' && now - startedAt >= CREW_ACTION_DURATION_MS) { clip = 'typing'; startedAt += CREW_ACTION_DURATION_MS; }
    if ((clip === 'stand' || clip === 'turn') && now - startedAt >= CREW_ACTION_DURATION_MS) clip = null;
    if (agent.isWalking) { clip = null; turnFrom = undefined; }
    if (!seated && clip !== 'stand') workstation = undefined;
    if (workstation) used.add(workstation.chairId);
    result.push({ id: agent.id, observed: { ...agent }, facing: clip === 'stand' && workstation ? workstation.facing : facing, seated, clip, startedAt, turnFrom, ...(workstation ? { workstation } : {}) });
  }
  return result;
}

export function crewActionMarkers(markers: readonly CrewPresenceMarker[], actions: readonly CrewActorAction[]): CrewPresenceMarker[] {
  return markers.map(marker => {
    const action = actions.find(item => item.id === marker.id);
    return action ? { ...marker, facing: action.facing, ...(action.workstation ? { x: action.workstation.x, y: action.workstation.y } : {}) } : marker;
  });
}
