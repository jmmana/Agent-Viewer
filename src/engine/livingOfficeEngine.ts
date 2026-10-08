import type {
  Agent,
  AgentStatus,
  Meeting,
  SocialActivity,
  ViewerEvent,
  WorkspaceZone,
} from '../types/agent';
import type { Locale } from '../i18n';
import { socialPack } from '../content/socialPacks';

export type VisibleMeetingRoomId = 'meeting_room' | 'meeting_room_b' | 'boss_office';
export type OverflowMeetingRoomId = `overflow_meeting_${number}`;
export type MeetingRoomId = VisibleMeetingRoomId | OverflowMeetingRoomId;

export interface RoomPolicy {
  id: VisibleMeetingRoomId;
  label: string;
  floor: 1;
  capacity: number;
  priority: number;
  fallback: boolean;
  seats: Array<{ x: number; y: number }>;
}

export interface RoomReservation {
  roomId: MeetingRoomId;
  roomLabel: string;
  floor: 1 | 2;
  meetingId: string;
  participantIds: string[];
  reservedAt: number;
  status: 'RESERVED' | 'ACTIVE';
}

export interface LivingOfficeState {
  agents: Agent[];
  meetings: Meeting[];
  events: ViewerEvent[];
  activeMeetingId: string | null;
  roomReservations: RoomReservation[];
  socialActivities: SocialActivity[];
  coffeeSeatAssignments: Array<{ seatId: string; agentId: string }>;
}

export interface CoffeeSeat {
  id: string;
  x: number;
  y: number;
  tableId: string;
}

export interface CoffeeSeatAssignment {
  seatId: string;
  agentId: string;
}

export const COFFEE_SEATS: CoffeeSeat[] = [
  // Table A (round cafe table)
  { id: 'coffee_a_1', tableId: 'coffee_a', x: 10.6, y: 13.2 },
  { id: 'coffee_a_2', tableId: 'coffee_a', x: 11.6, y: 12.7 },
  { id: 'coffee_a_3', tableId: 'coffee_a', x: 12.6, y: 13.2 },
  { id: 'coffee_a_4', tableId: 'coffee_a', x: 12.6, y: 14.3 },
  { id: 'coffee_a_5', tableId: 'coffee_a', x: 11.6, y: 14.8 },
  { id: 'coffee_a_6', tableId: 'coffee_a', x: 10.6, y: 14.3 },

  // Table B (round cafe table)
  { id: 'coffee_b_1', tableId: 'coffee_b', x: 14.2, y: 13.2 },
  { id: 'coffee_b_2', tableId: 'coffee_b', x: 15.2, y: 12.7 },
  { id: 'coffee_b_3', tableId: 'coffee_b', x: 16.2, y: 13.2 },
  { id: 'coffee_b_4', tableId: 'coffee_b', x: 16.2, y: 14.3 },
  { id: 'coffee_b_5', tableId: 'coffee_b', x: 15.2, y: 14.8 },
  { id: 'coffee_b_6', tableId: 'coffee_b', x: 14.2, y: 14.3 },

  // Standing / overflow bar
  { id: 'coffee_s_1', tableId: 'standing', x: 9.2, y: 14.2 },
  { id: 'coffee_s_2', tableId: 'standing', x: 17.4, y: 14.2 },
  { id: 'coffee_s_3', tableId: 'standing', x: 11.0, y: 15.5 },
  { id: 'coffee_s_4', tableId: 'standing', x: 15.8, y: 15.5 },
];

export const AGENT_DESK_ANCHORS: Record<string, { x: number; y: number; workspace: WorkspaceZone }> = {
  'boss': { x: 3, y: 3, workspace: 'boss_office' },
  'sales-lead': { x: 5, y: 3, workspace: 'boss_office' },
  'tech-lead': { x: 2, y: 9, workspace: 'leads_area' },
  'research-lead': { x: 4, y: 9, workspace: 'leads_area' },
  'backend-agent': { x: 8, y: 10, workspace: 'development' },
  'frontend-agent': { x: 12, y: 10, workspace: 'development' },
  'security-agent': { x: 16, y: 10, workspace: 'development' },
  'ba-analyst-1': { x: 2, y: 14, workspace: 'research_area' },
  'ba-analyst-2': { x: 5, y: 14, workspace: 'research_area' },
  'qa-agent': { x: 20, y: 10, workspace: 'qa_lab' },
};

export function getAssignedCoffeeSeat(
  state: Pick<LivingOfficeState, 'coffeeSeatAssignments'>,
  agentId: string,
): CoffeeSeat | null {
  if (!state.coffeeSeatAssignments) state.coffeeSeatAssignments = [];
  const assignment = state.coffeeSeatAssignments.find((item) => item.agentId === agentId);
  if (!assignment) return null;
  return COFFEE_SEATS.find((seat) => seat.id === assignment.seatId) ?? null;
}

export function releaseCoffeeSeat(
  state: Pick<LivingOfficeState, 'coffeeSeatAssignments'>,
  agentId: string,
): void {
  if (!state.coffeeSeatAssignments) {
    state.coffeeSeatAssignments = [];
    return;
  }
  state.coffeeSeatAssignments = state.coffeeSeatAssignments.filter(
    (item) => item.agentId !== agentId,
  );
}

export function assignCoffeeSeat(
  state: Pick<LivingOfficeState, 'coffeeSeatAssignments'>,
  agentId: string,
): CoffeeSeat | null {
  if (!state.coffeeSeatAssignments) state.coffeeSeatAssignments = [];
  const existing = getAssignedCoffeeSeat(state, agentId);
  if (existing) return existing;

  const used = new Set(state.coffeeSeatAssignments.map((item) => item.seatId));
  const freeSeat = COFFEE_SEATS.find((seat) => !used.has(seat.id));
  if (!freeSeat) return null;

  state.coffeeSeatAssignments.push({
    seatId: freeSeat.id,
    agentId,
  });

  return freeSeat;
}

export function moveAgentToCoffeeSeat(
  state: Pick<LivingOfficeState, 'coffeeSeatAssignments'>,
  agent: Agent,
): void {
  const seat = assignCoffeeSeat(state, agent.id);
  if (!seat) {
    // fallback to generic break room anchor
    routeAgent(agent, 'break_room');
    return;
  }

  agent.workspace = 'break_room';
  agent.floor = 1;
  agent.targetX = seat.x;
  agent.targetY = seat.y;
  agent.isWalking = Math.hypot(agent.x - seat.x, agent.y - seat.y) > 0.15;

  if (agent.isWalking) {
    agent.travelStartedAt = Date.now();
    agent.travelDurationMs = Math.max(
      900,
      Math.min(3500, Math.hypot(agent.x - seat.x, agent.y - seat.y) * 350),
    );
  }
}

export const MEETING_ROOM_POLICIES: RoomPolicy[] = [
  {
    id: 'meeting_room',
    label: 'Meeting Room A',
    floor: 1,
    capacity: 4,
    priority: 1,
    fallback: false,
    seats: [
      { x: 8.4, y: 2.1 },
      { x: 9.4, y: 2.1 },
      { x: 8.4, y: 3.1 },
      { x: 9.4, y: 3.1 },
    ],
  },
  {
    id: 'meeting_room_b',
    label: 'Meeting Room B',
    floor: 1,
    capacity: 4,
    priority: 2,
    fallback: false,
    seats: [
      { x: 13.4, y: 2.1 },
      { x: 14.4, y: 2.1 },
      { x: 13.4, y: 3.1 },
      { x: 14.4, y: 3.1 },
    ],
  },
  {
    id: 'boss_office',
    label: 'Director Suite',
    floor: 1,
    capacity: 4,
    priority: 3,
    fallback: true,
    seats: [
      { x: 1.4, y: 3.9 },
      { x: 2.4, y: 3.9 },
      { x: 3.4, y: 3.9 },
      { x: 4.4, y: 3.9 },
    ],
  },
];

const STATUS_DESTINATIONS: Partial<Record<AgentStatus, WorkspaceZone>> = {
  CODING: 'development',
  WRITING: 'development',
  USING_TOOL: 'development',
  TESTING: 'qa_lab',
  BLOCKED: 'qa_lab',
  RESEARCHING: 'research_area',
  READING: 'research_area',
  DELEGATING: 'leads_area',
  REVIEWING: 'leads_area',
  COFFEE_BREAK: 'break_room',
  CHATTING: 'break_room',
};

export const WORKSPACE_ANCHORS: Record<WorkspaceZone, { x: number; y: number }> = {
  boss_office: { x: 3, y: 3 },
  leads_area: { x: 3, y: 9 },
  development: { x: 11, y: 9 },
  qa_lab: { x: 20, y: 9 },
  research_area: { x: 4, y: 14 },
  server_room: { x: 20, y: 4 },
  meeting_room: { x: 9, y: 3 },
  meeting_room_b: { x: 14, y: 3 },
  overflow_floor: { x: 22.5, y: 14.4 },
  break_room: { x: 12, y: 14 },
};

function event(
  type: ViewerEvent['type'],
  source: string,
  summary: string,
  payload: Record<string, unknown>,
  target?: string,
): ViewerEvent {
  return {
    id: `evt-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    timestamp: Date.now(),
    source,
    target,
    severity: 'normal',
    summary,
    payload,
  };
}

function homeWorkspace(agent: Agent): WorkspaceZone {
  switch (agent.role) {
    case 'boss': return 'boss_office';
    case 'tech_lead': return 'leads_area';
    case 'research_lead': return 'research_area';
    case 'backend_engineer':
    case 'frontend_engineer':
    case 'security_analyst':
      return 'development';
    case 'qa_engineer':
      return 'qa_lab';
    default:
      return 'break_room';
  }
}

function isOverflowRoom(roomId: string): roomId is OverflowMeetingRoomId {
  return /^overflow_meeting_\d+$/.test(roomId);
}

function nextOverflowRoomId(state: LivingOfficeState): OverflowMeetingRoomId {
  const used = new Set(
    state.roomReservations
      .filter((reservation) => reservation.floor === 2)
      .map((reservation) => reservation.roomId),
  );
  let index = 1;
  while (used.has(`overflow_meeting_${index}` as MeetingRoomId)) index += 1;
  return `overflow_meeting_${index}`;
}

export function routeForStatus(agent: Agent, status: AgentStatus): WorkspaceZone {
  if (
    status === 'IN_MEETING' &&
    ['meeting_room', 'meeting_room_b', 'boss_office', 'overflow_floor'].includes(agent.workspace)
  ) {
    return agent.workspace;
  }
  return STATUS_DESTINATIONS[status] ?? agent.workspace;
}

export function routeAgent(agent: Agent, workspace: WorkspaceZone): void {
  const desk = AGENT_DESK_ANCHORS[agent.id];
  const anchor = (desk && desk.workspace === workspace)
    ? { x: desk.x, y: desk.y }
    : WORKSPACE_ANCHORS[workspace];

  agent.workspace = workspace;
  if (workspace !== 'overflow_floor') agent.floor = 1;
  agent.targetX = anchor.x;
  agent.targetY = anchor.y;
  agent.isWalking = Math.hypot(agent.x - anchor.x, agent.y - anchor.y) > 0.15;
  if (agent.isWalking) {
    agent.travelStartedAt = Date.now();
    agent.travelDurationMs = Math.max(
      900,
      Math.min(4500, Math.hypot(agent.x - anchor.x, agent.y - anchor.y) * 350),
    );
  }
}

export function reserveMeetingRoom(
  state: LivingOfficeState,
  meetingId: string,
  participantIds: string[],
): RoomReservation {
  const occupied = new Set(
    state.roomReservations
      .filter((reservation) => reservation.floor === 1)
      .map((reservation) => reservation.roomId),
  );

  const visibleRoom = MEETING_ROOM_POLICIES
    .filter((candidate) => candidate.capacity >= participantIds.length && !occupied.has(candidate.id))
    .sort((a, b) => a.priority - b.priority)[0];

  const reservation: RoomReservation = visibleRoom
    ? {
        roomId: visibleRoom.id,
        roomLabel: visibleRoom.label,
        floor: 1,
        meetingId,
        participantIds,
        reservedAt: Date.now(),
        status: 'RESERVED',
      }
    : (() => {
        const roomId = nextOverflowRoomId(state);
        const number = Number(roomId.split('_').pop());
        return {
          roomId,
          roomLabel: `Secret Room ${String(number).padStart(2, '0')}`,
          floor: 2 as const,
          meetingId,
          participantIds,
          reservedAt: Date.now(),
          status: 'RESERVED' as const,
        };
      })();

  state.roomReservations.push(reservation);
  state.events.unshift(
    event(
      'meeting.room.reserved',
      'system',
      `${reservation.roomLabel} reserved for ${meetingId}.`,
      {
        meetingId,
        roomId: reservation.roomId,
        roomLabel: reservation.roomLabel,
        floor: reservation.floor,
        participantIds,
      },
    ),
  );
  return reservation;
}

export function requestMeeting(
  state: LivingOfficeState,
  args: {
    id: string;
    title: string;
    topic: string;
    initiatorId: string;
    participantIds: string[];
    taskId?: string;
  },
): Meeting {
  const reservation = reserveMeetingRoom(state, args.id, args.participantIds);

  const meeting: Meeting = {
    id: args.id,
    title: args.title,
    topic: args.topic,
    taskId: args.taskId,
    initiatorId: args.initiatorId,
    participants: args.participantIds,
    status: 'SCHEDULED',
    startedAt: 0,
    tokensAccumulated: 0,
    costAccumulated: 0,
    agenda: [],
    decisions: [],
    tasksCreated: [],
    roomId: reservation.roomId,
    messages: [],
  };
  state.meetings.unshift(meeting);

  state.events.unshift(
    event(
      'meeting.requested',
      args.initiatorId,
      `${args.title} requested.`,
      {
        meetingId: args.id,
        participantIds: args.participantIds,
        roomId: reservation.roomId,
        roomLabel: reservation.roomLabel,
        floor: reservation.floor,
      },
    ),
  );

  const visibleRoom = MEETING_ROOM_POLICIES.find((item) => item.id === reservation.roomId);
  for (const [index, agentId] of args.participantIds.entries()) {
    const agent = state.agents.find((item) => item.id === agentId);
    if (!agent) continue;

    agent.status = 'PHONE_CALL';
    agent.statusText = reservation.floor === 2
      ? `Call received: meet upstairs in ${reservation.roomLabel}`
      : `Call received: meeting in ${reservation.roomLabel}`;
    agent.speechBubble = {
      text: index === 0
        ? reservation.floor === 2
          ? 'Visible rooms are full. Meet me upstairs through the secret door.'
          : 'We need to sync. Meet me in the room.'
        : reservation.floor === 2
          ? 'Got it. Heading to the secret floor.'
          : 'Got it. I am heading there.',
      targetAgentName: index === 0
        ? state.agents.find((item) => item.id === args.participantIds[1])?.name
        : state.agents.find((item) => item.id === args.initiatorId)?.name,
      expiresAt: Date.now() + 3200,
    };

    state.events.unshift(
      event(
        'agent.phone_call.started',
        args.initiatorId,
        `Phone call started with ${agent.name}.`,
        {
          meetingId: args.id,
          roomId: reservation.roomId,
          roomLabel: reservation.roomLabel,
          floor: reservation.floor,
        },
        agent.id,
      ),
    );

    if (reservation.floor === 2) {
      agent.workspace = 'overflow_floor';
      agent.floor = 1;
      const portal = WORKSPACE_ANCHORS.overflow_floor;
      agent.targetX = portal.x;
      agent.targetY = portal.y;
    } else {
      const seat = visibleRoom?.seats[index] ?? visibleRoom?.seats[visibleRoom.seats.length - 1];
      agent.workspace = reservation.roomId as WorkspaceZone;
      agent.floor = 1;
      agent.targetX = seat?.x ?? WORKSPACE_ANCHORS[agent.workspace].x;
      agent.targetY = seat?.y ?? WORKSPACE_ANCHORS[agent.workspace].y;
    }

    agent.isWalking = true;
    agent.travelStartedAt = Date.now();
    agent.travelDurationMs = 2200 + index * 250;
  }

  return meeting;
}

export function activateMeetingWhenArrived(
  state: LivingOfficeState,
  meetingId: string,
): boolean {
  const meeting = state.meetings.find((item) => item.id === meetingId);
  const reservation = state.roomReservations.find((item) => item.meetingId === meetingId);
  if (!meeting || !reservation || meeting.status !== 'SCHEDULED') return false;

  const allArrived = meeting.participants.every((id) => {
    const agent = state.agents.find((item) => item.id === id);
    return agent && !agent.isWalking && (agent.floor ?? 1) === reservation.floor;
  });
  if (!allArrived) return false;

  meeting.status = 'ACTIVE';
  meeting.startedAt = Date.now();
  reservation.status = 'ACTIVE';
  state.activeMeetingId = meeting.id;

  for (const id of meeting.participants) {
    const agent = state.agents.find((item) => item.id === id);
    if (!agent) continue;
    agent.status = 'IN_MEETING';
    agent.statusText = `In meeting: ${meeting.title}`;
  }

  state.events.unshift(
    event(
      'meeting.started',
      meeting.initiatorId,
      `Meeting started: ${meeting.title}.`,
      {
        meetingId,
        roomId: reservation.roomId,
        roomLabel: reservation.roomLabel,
        floor: reservation.floor,
        participants: meeting.participants,
      },
    ),
  );
  return true;
}

export function endMeeting(state: LivingOfficeState, meetingId: string): void {
  const meeting = state.meetings.find((item) => item.id === meetingId);
  const reservation = state.roomReservations.find((item) => item.meetingId === meetingId);
  if (!meeting) return;

  meeting.status = 'CONCLUDED';
  meeting.endedAt = Date.now();
  state.activeMeetingId = state.activeMeetingId === meetingId ? null : state.activeMeetingId;
  state.roomReservations = state.roomReservations.filter((item) => item.meetingId !== meetingId);

  for (const id of meeting.participants) {
    const agent = state.agents.find((item) => item.id === id);
    if (!agent) continue;
    agent.floor = 1;
    agent.status = 'IDLE';
    agent.statusText = reservation?.floor === 2
      ? 'Returned from secret collaboration floor'
      : 'Available after meeting';
    routeAgent(agent, homeWorkspace(agent));
  }

  state.events.unshift(
    event(
      'meeting.ended',
      meeting.initiatorId,
      `Meeting ended: ${meeting.title}.`,
      {
        meetingId,
        roomId: reservation?.roomId,
        floor: reservation?.floor,
      },
    ),
  );
}

export function advanceLivingOffice(state: LivingOfficeState, now: number): void {
  for (const agent of state.agents) {
    if (
      agent.isWalking &&
      typeof agent.travelStartedAt === 'number' &&
      typeof agent.travelDurationMs === 'number' &&
      now - agent.travelStartedAt >= agent.travelDurationMs
    ) {
      agent.x = agent.targetX;
      agent.y = agent.targetY;
      agent.isWalking = false;
      agent.travelStartedAt = undefined;
      agent.travelDurationMs = undefined;

      if (agent.workspace === 'overflow_floor') {
        const reservation = state.roomReservations.find(
          (item) => item.participantIds.includes(agent.id) && item.floor === 2,
        );
        if (reservation) {
          agent.floor = 2;
          agent.status = 'WALKING';
          agent.statusText = `Entered ${reservation.roomLabel} on secret floor`;
        }
      } else if (agent.status === 'PHONE_CALL') {
        agent.status = 'WALKING';
        agent.statusText = 'Arrived for scheduled collaboration';
      }
    }
  }

  for (const meeting of state.meetings) {
    if (meeting.status === 'SCHEDULED') {
      activateMeetingWhenArrived(state, meeting.id);
    }
  }

  for (const activity of state.socialActivities) {
    if (activity.endsAt && activity.endsAt <= now) {
      for (const agentId of activity.participantIds) {
        const agent = state.agents.find((item) => item.id === agentId);
        if (!agent || agent.socialActivityId !== activity.id) continue;
        agent.socialActivityId = null;
        agent.mood = 'neutral';
        if (agent.presentationActivity === 'chatting') {
          agent.presentationActivity = 'coffee_break';
          moveAgentToCoffeeSeat(state, agent);
        } else if (agent.presentationActivity === 'coffee_break') {
          agent.presentationActivity = null;
        }
        agent.ambientBubble = null;
      }
    }
  }
  state.socialActivities = state.socialActivities.filter(
    (activity) => !activity.endsAt || activity.endsAt > now,
  );
}

export interface AmbientOptions {
  enabled: boolean;
  politicsEnabled: boolean;
  idleGraceMs: number;
  minIntervalMs: number;
}

const idleSince = new Map<string, number>();
let lastSocialAt = 0;

export function applyAmbientLife(
  state: LivingOfficeState,
  now: number,
  locale: Locale,
  options: AmbientOptions,
): void {
  if (!options.enabled) return;

  const idleAgents = state.agents.filter(
    (agent) => (agent.floor ?? 1) === 1 && agent.status === 'IDLE' && !agent.currentTaskId,
  );

  for (const agent of state.agents) {
    if ((agent.floor ?? 1) === 1 && agent.status === 'IDLE' && !agent.currentTaskId) {
      if (!idleSince.has(agent.id)) idleSince.set(agent.id, now);
    } else {
      idleSince.delete(agent.id);
      if (agent.presentationActivity !== 'chatting' && agent.presentationActivity !== 'coffee_break') {
        agent.socialActivityId = null;
        releaseCoffeeSeat(state, agent.id);
      }
    }
  }

  for (const agent of idleAgents) {
    const since = idleSince.get(agent.id) ?? now;
    if (now - since >= options.idleGraceMs) {
      agent.presentationActivity = 'coffee_break';
      agent.mood = 'neutral';
      moveAgentToCoffeeSeat(state, agent);
    }
  }

  if (now - lastSocialAt < options.minIntervalMs) return;

  const socialCandidates = state.agents.filter(
    (agent) =>
      (agent.floor ?? 1) === 1 &&
      (agent.presentationActivity === 'coffee_break' || agent.status === 'IDLE') &&
      !agent.currentTaskId,
  );
  if (socialCandidates.length < 2) return;

  const participants = socialCandidates.slice(0, 2);
  const pack = socialPack(locale).filter(
    (exchange) => options.politicsEnabled || exchange.topic !== 'politics',
  );
  if (!pack.length) return;

  const seed = Math.abs(Math.floor(now / Math.max(options.minIntervalMs, 1))) % pack.length;
  const exchange = pack[seed];
  const activityId = `social-${now}`;

  state.socialActivities.unshift({
    id: activityId,
    participantIds: participants.map((agent) => agent.id),
    topic: exchange.topic === 'politics' ? 'current_events' : exchange.topic,
    simulated: true,
    locale,
    startedAt: now,
    endsAt: now + 10000,
  });

  participants.forEach((agent, index) => {
    agent.presentationActivity = 'chatting';
    agent.socialActivityId = activityId;
    agent.mood = exchange.lines[index].mood;
    moveAgentToCoffeeSeat(state, agent);
    agent.ambientBubble = {
      text: exchange.lines[index].text,
      targetAgentName: participants[(index + 1) % participants.length].name,
      expiresAt: now + 8500 + index * 1200,
    };
  });

  state.events.unshift(
    event(
      'social.started',
      participants[0].id,
      `Simulated ambient conversation started: ${exchange.topic}.`,
      {
        activityId,
        participantIds: participants.map((agent) => agent.id),
        topic: exchange.topic,
        simulated: true,
        locale,
      },
      participants[1].id,
    ),
  );
  lastSocialAt = now;
}

export function activeOverflowReservations(
  state: Pick<LivingOfficeState, 'roomReservations'>,
): RoomReservation[] {
  return state.roomReservations.filter((reservation) => reservation.floor === 2);
}

export function isOverflowMeetingRoom(roomId: string): boolean {
  return isOverflowRoom(roomId);
}
