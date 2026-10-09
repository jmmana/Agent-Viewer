import type { AgentStatus } from '../src/types/agent.ts';

/** Statuses the office understands, the same list the server accepts on `PATCH /api/v1/agents/:id`. */
export const AGENT_STATUSES = [
  'OFFLINE', 'IDLE', 'AVAILABLE', 'THINKING', 'READING', 'RESEARCHING', 'CODING', 'WRITING', 'TESTING',
  'USING_TOOL', 'WAITING', 'WAITING_APPROVAL', 'BLOCKED', 'DELEGATING', 'PHONE_CALL', 'WALKING',
  'IN_MEETING', 'COFFEE_BREAK', 'CHATTING', 'REVIEWING', 'DELIVERING', 'DONE', 'ERROR',
] as const satisfies readonly AgentStatus[];

/** Everyday words accepted by `agent-viewer send --status`, mapped to an office status. */
export const STATUS_ALIASES: Readonly<Record<string, AgentStatus>> = {
  WORKING: 'THINKING',
  BUSY: 'THINKING',
  READY: 'AVAILABLE',
  WAITING_FOR_USER: 'WAITING',
  APPROVAL: 'WAITING_APPROVAL',
  FINISHED: 'DONE',
  COMPLETE: 'DONE',
  COMPLETED: 'DONE',
  FAILED: 'ERROR',
  STOPPED: 'OFFLINE',
};

const STATUS_SET: ReadonlySet<string> = new Set(AGENT_STATUSES);

/**
 * Turns user input such as `working`, `coding` or `waiting-approval` into an office status.
 * Returns `undefined` when the word is not a status or a known alias.
 */
export function normalizeStatus(input: string): AgentStatus | undefined {
  const key = input.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (STATUS_SET.has(key)) return key as AgentStatus;
  return STATUS_ALIASES[key];
}
