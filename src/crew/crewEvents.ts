import type { Agent } from '../types/agent';

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
