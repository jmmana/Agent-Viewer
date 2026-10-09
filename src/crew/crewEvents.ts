import type { Agent, Meeting } from '../types/agent';

/**
 * Read-only room-to-agent bridge. It does not create agent events or alter
 * tasks, token counts or presence. Unknown workspaces remain unplaced.
 */
export function crewRoomForWorkspace(workspace: string): string | null {
  switch (workspace) {
    case 'boss_office': return 'ceo';
    case 'development': return 'development';
    case 'leads_area': return 'planning';
    case 'research_area': return 'research';
    case 'qa_lab': return 'qa';
    case 'server_room': return 'infrastructure';
    case 'meeting_room':
    case 'meeting_room_b': return 'meeting';
    case 'break_room': return 'lounge';
    default: return null; // no authorized spatial mapping: never invent a destination.
  }
}
export function crewAgentsInRoom<T extends Pick<Agent, 'id' | 'workspace' | 'status' | 'name'>>(
  agents: readonly T[], roomId: string,
): readonly T[] {
  return agents.filter(agent => crewRoomForWorkspace(agent.workspace) === roomId);
}

export interface CrewRoomActivity {
  agents: number;
  withTask: number;
  /** Reuniones ACTIVAS con al menos un participante presente en la sala. */
  activeMeetings: number;
}

/** Resumen de solo lectura de lo que los datos dicen de la sala; sin datos devuelve ceros, nunca valores inventados. */
export function crewRoomActivity(
  agents: readonly Pick<Agent, 'id' | 'workspace' | 'status' | 'name' | 'currentTaskId'>[],
  meetings: readonly Pick<Meeting, 'status' | 'participants'>[],
  roomId: string,
): CrewRoomActivity {
  const present = crewAgentsInRoom(agents, roomId);
  const ids = new Set(present.map(agent => agent.id));
  return {
    agents: present.length,
    withTask: present.filter(agent => agent.currentTaskId).length,
    activeMeetings: meetings.filter(m => m.status === 'ACTIVE' && m.participants.some(id => ids.has(id))).length,
  };
}
