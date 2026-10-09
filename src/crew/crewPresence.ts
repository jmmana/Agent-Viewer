import type { Agent } from '../types/agent';
import type { CrewRoomDefinition } from './crewModel';
import { crewAgentsInRoom } from './crewEvents';
import { crewPresenceSlots, type CrewLocalPoint } from './crewSpatial';

type PresenceAgent = Pick<Agent,'id'|'name'|'status'|'workspace'> & Partial<Pick<Agent,'role'|'facing'>>;
export interface CrewPresenceMarker extends CrewLocalPoint {
  id: string;
  name: string;
  status: Agent['status'];
  number: number;
  role?: Agent['role'];
  facing?: Agent['facing'];
}

/** Proyección determinista de un snapshot. No genera eventos ni simula desplazamientos. */
export function projectCrewPresence(agents: readonly PresenceAgent[], room: CrewRoomDefinition): {
  markers: CrewPresenceMarker[];
  unplaced: PresenceAgent[];
} {
  const present = crewAgentsInRoom(agents,room.id).slice().sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const slots = crewPresenceSlots(room);
  const occupied = new Set<number>();
  const markers: CrewPresenceMarker[] = [], unplaced: PresenceAgent[] = [];
  for (const agent of present) {
    if (occupied.size === slots.length) { unplaced.push(agent); continue; }
    let hash = 0;
    for (let i=0;i<agent.id.length;i++) hash = (Math.imul(hash,31)+agent.id.charCodeAt(i)) >>> 0;
    let index = hash % slots.length;
    while (occupied.has(index)) index = (index+1)%slots.length;
    occupied.add(index);
    markers.push({...slots[index], id:agent.id, name:agent.name,status:agent.status,...(agent.role ? {role:agent.role} : {}),...(agent.facing !== undefined ? {facing:agent.facing} : {}),number:markers.length+1});
  }
  return {markers,unplaced};
}
