import type { Agent } from '../types/agent';

/**
 * Read-only room-to-agent bridge. It does not create agent events or alter
 * tasks, token counts or presence. Unknown workspaces remain unplaced.
 */
export function crewRoomForWorkspace(workspace: string): string | null {
  switch (workspace) {
    case 'boss_office': return 'ceo';
    case 'development': return 'development';
    default: return null; // room scene not built yet: never invent a destination.
  }
}
export function crewAgentsInRoom<T extends Pick<Agent, 'id' | 'workspace' | 'status' | 'name'>>(
  agents: readonly T[], roomId: string,
): readonly T[] {
  return agents.filter(agent => crewRoomForWorkspace(agent.workspace) === roomId);
}
