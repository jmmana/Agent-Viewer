import type { Agent, Meeting, SocialActivity, Task, ViewerEvent } from '../types/agent';
import type { RoomReservation } from './livingOfficeEngine';
import type { UsageTally } from '../integrations/usageTally';
import { emptyUsageTally } from '../integrations/usageTally';

/**
 * Everything the office knows at one point in time. Built only from events; it never imports the demo
 * script, the sound effects or browser storage, so it is safe to use inside an embedded component.
 */
export interface SimulationState {
  agents: Agent[];
  tasks: Task[];
  meetings: Meeting[];
  events: ViewerEvent[];
  activeMeetingId: string | null;
  roomReservations: RoomReservation[];
  socialActivities: SocialActivity[];
  coffeeSeatAssignments: Array<{ seatId: string; agentId: string }>;
  totalTokens: {
    input: number;
    output: number;
    cached: number;
    reasoning: number;
  };
  totalCost: number;
  usage: UsageTally;
}

/**
 * Creates a clean, empty state for real live multi-agent streaming mode.
 * Contains 0 seeded agents, 0 synthetic tokens, 0 synthetic cost.
 */
export function createLiveSimulationState(): SimulationState {
  return {
    agents: [],
    tasks: [],
    meetings: [],
    events: [],
    activeMeetingId: null,
    roomReservations: [],
    socialActivities: [],
    coffeeSeatAssignments: [],
    totalTokens: {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
    },
    totalCost: 0,
    usage: emptyUsageTally(),
  };
}
