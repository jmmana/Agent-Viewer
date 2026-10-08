import type {
  Agent,
  AgentStatus,
  Meeting,
  SocialActivity,
  ViewerEvent,
  WorkspaceZone,
} from '../types/agent';
import { socialPack, type SocialLocale } from '../content/socialPacks';
import { livingOfficeText } from '../content/livingOfficeMessages';

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

/**
 * How the office reacts to meeting requests.
 * - `narrate`: the office writes its own short lines ("Meet me in the room") on top of the real events.
 * - `overflowFloor`: when every visible room is busy, the meeting moves to the hidden second floor.
 * Embedded professional views turn both off: only what the events say is shown.
 */
export interface MeetingOptions {
  now?: number;
  narrate?: boolean;
  overflowFloor?: boolean;
  /** BCP 47 locale of the texts the office writes (room labels, status texts, bubbles). Defaults to English. */
  locale?: string;
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
  now = Date.now(),
): ViewerEvent {
  return {
    id: `evt-${type}-${now}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    timestamp: now,
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

export function routeAgent(agent: Agent, workspace: WorkspaceZone, now = Date.now()): void {
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
    agent.travelStartedAt = now;
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
  options: MeetingOptions = {},
): RoomReservation | null {
  const now = options.now ?? Date.now();
  const locale = options.locale;
  const occupied = new Set(
    state.roomReservations
      .filter((reservation) => reservation.floor === 1)
      .map((reservation) => reservation.roomId),
  );

  const visibleRoom = MEETING_ROOM_POLICIES
    .filter((candidate) => candidate.capacity >= participantIds.length && !occupied.has(candidate.id))
    .sort((a, b) => a.priority - b.priority)[0];

  if (!visibleRoom && options.overflowFloor === false) return null;

  const reservation: RoomReservation = visibleRoom
    ? {
        roomId: visibleRoom.id,
        roomLabel: livingOfficeText(locale, `room.${visibleRoom.id}`),
        floor: 1,
        meetingId,
        participantIds,
        reservedAt: now,
        status: 'RESERVED',
      }
    : (() => {
        const roomId = nextOverflowRoomId(state);
        const number = Number(roomId.split('_').pop());
        return {
          roomId,
          roomLabel: livingOfficeText(locale, 'room.overflow', { number: String(number).padStart(2, '0') }),
          floor: 2 as const,
          meetingId,
          participantIds,
          reservedAt: now,
          status: 'RESERVED' as const,
        };
      })();

  state.roomReservations.push(reservation);
  state.events.unshift(
    event(
      'meeting.room.reserved',
      'system',
      livingOfficeText(locale, 'event.roomReserved', { room: reservation.roomLabel, meeting: meetingId }),
      {
        meetingId,
        roomId: reservation.roomId,
        roomLabel: reservation.roomLabel,
        floor: reservation.floor,
        participantIds,
      },
      undefined,
      now,
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
  options: MeetingOptions = {},
): Meeting {
  const now = options.now ?? Date.now();
  const narrate = options.narrate ?? true;
  const locale = options.locale;
  const reservation = reserveMeetingRoom(state, args.id, args.participantIds, options);

  // Whoever is called to a meeting leaves any simulated small talk at once.
  for (const agentId of args.participantIds) {
    const agent = state.agents.find((item) => item.id === agentId);
    if (agent) clearAmbientLife(state, agent);
  }

  if (!reservation) {
    // Every visible room is busy and there is no overflow floor: the participants meet where they are.
    const meeting: Meeting = {
      id: args.id,
      title: args.title,
      topic: args.topic,
      taskId: args.taskId,
      initiatorId: args.initiatorId,
      participants: args.participantIds,
      status: 'ACTIVE',
      startedAt: now,
      tokensAccumulated: 0,
      costAccumulated: 0,
      agenda: [],
      decisions: [],
      tasksCreated: [],
      messages: [],
    };
    state.meetings.unshift(meeting);
    state.activeMeetingId = meeting.id;
    for (const agentId of args.participantIds) {
      const agent = state.agents.find((item) => item.id === agentId);
      if (!agent) continue;
      agent.status = 'IN_MEETING';
      agent.statusText = '';
    }
    return meeting;
  }

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
      livingOfficeText(locale, 'event.meetingRequested', { title: args.title }),
      {
        meetingId: args.id,
        participantIds: args.participantIds,
        roomId: reservation.roomId,
        roomLabel: reservation.roomLabel,
        floor: reservation.floor,
      },
      undefined,
      now,
    ),
  );

  const visibleRoom = MEETING_ROOM_POLICIES.find((item) => item.id === reservation.roomId);
  for (const [index, agentId] of args.participantIds.entries()) {
    const agent = state.agents.find((item) => item.id === agentId);
    if (!agent) continue;

    // Remember where an agent without a home desk was, so it walks back there after the meeting.
    if (!agent.homeWorkspace && agent.role === 'custom' && agent.workspace !== 'overflow_floor') {
      agent.homeWorkspace = agent.workspace;
    }

    if (!narrate) {
      // Only the real event speaks: the participant just walks to the room.
      agent.status = 'WALKING';
      agent.statusText = '';
    } else {
    agent.status = 'PHONE_CALL';
    agent.statusText = livingOfficeText(locale, reservation.floor === 2 ? 'status.callUpstairs' : 'status.callRoom', {
      room: reservation.roomLabel,
    });
    agent.speechBubble = {
      text: livingOfficeText(
        locale,
        index === 0
          ? reservation.floor === 2 ? 'bubble.initiatorUpstairs' : 'bubble.initiatorRoom'
          : reservation.floor === 2 ? 'bubble.guestUpstairs' : 'bubble.guestRoom',
      ),
      targetAgentName: index === 0
        ? state.agents.find((item) => item.id === args.participantIds[1])?.name
        : state.agents.find((item) => item.id === args.initiatorId)?.name,
      expiresAt: now + 3200,
    };
    }

    state.events.unshift(
      event(
        'agent.phone_call.started',
        args.initiatorId,
        livingOfficeText(locale, 'event.phoneCall', { name: agent.name }),
        {
          meetingId: args.id,
          roomId: reservation.roomId,
          roomLabel: reservation.roomLabel,
          floor: reservation.floor,
        },
        agent.id,
        now,
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
    agent.travelStartedAt = now;
    agent.travelDurationMs = 2200 + index * 250;
  }

  return meeting;
}

export function activateMeetingWhenArrived(
  state: LivingOfficeState,
  meetingId: string,
  now = Date.now(),
  locale?: string,
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
  meeting.startedAt = now;
  reservation.status = 'ACTIVE';
  state.activeMeetingId = meeting.id;

  for (const id of meeting.participants) {
    const agent = state.agents.find((item) => item.id === id);
    if (!agent) continue;
    agent.status = 'IN_MEETING';
    agent.statusText = livingOfficeText(locale, 'status.inMeeting', { title: meeting.title });
    clearAmbientLife(state, agent);
  }

  state.events.unshift(
    event(
      'meeting.started',
      meeting.initiatorId,
      livingOfficeText(locale, 'event.meetingStarted', { title: meeting.title }),
      {
        meetingId,
        roomId: reservation.roomId,
        roomLabel: reservation.roomLabel,
        floor: reservation.floor,
        participants: meeting.participants,
      },
      undefined,
      now,
    ),
  );
  return true;
}

export function endMeeting(state: LivingOfficeState, meetingId: string, now = Date.now(), locale?: string): void {
  const meeting = state.meetings.find((item) => item.id === meetingId);
  const reservation = state.roomReservations.find((item) => item.meetingId === meetingId);
  if (!meeting) return;

  meeting.status = 'CONCLUDED';
  meeting.endedAt = now;
  state.activeMeetingId = state.activeMeetingId === meetingId ? null : state.activeMeetingId;
  state.roomReservations = state.roomReservations.filter((item) => item.meetingId !== meetingId);

  for (const id of meeting.participants) {
    const agent = state.agents.find((item) => item.id === id);
    if (!agent) continue;
    agent.floor = 1;
    agent.status = 'IDLE';
    agent.statusText = livingOfficeText(
      locale,
      reservation?.floor === 2 ? 'status.returnedFromSecretFloor' : 'status.availableAfterMeeting',
    );
    routeAgent(agent, agent.homeWorkspace ?? homeWorkspace(agent), now);
  }

  state.events.unshift(
    event(
      'meeting.ended',
      meeting.initiatorId,
      livingOfficeText(locale, 'event.meetingEnded', { title: meeting.title }),
      {
        meetingId,
        roomId: reservation?.roomId,
        floor: reservation?.floor,
      },
      undefined,
      now,
    ),
  );
}

export function advanceLivingOffice(state: LivingOfficeState, now: number, locale?: string): void {
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
          agent.statusText = livingOfficeText(locale, 'status.enteredSecretRoom', { room: reservation.roomLabel });
        }
      } else if (agent.status === 'PHONE_CALL') {
        agent.status = 'WALKING';
        agent.statusText = livingOfficeText(locale, 'status.arrived');
      }
    }
  }

  for (const meeting of state.meetings) {
    if (meeting.status === 'SCHEDULED') {
      activateMeetingWhenArrived(state, meeting.id, now, locale);
    }
  }

  // Status changes can come from anywhere (demo script, events, operator): busy agents drop small talk at once.
  for (const agent of state.agents) {
    if (isBusyForAmbientLife(state, agent)) clearAmbientLife(state, agent);
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

/** Ambient memory belongs to each office state, so two offices on the same page never mix. */
interface AmbientMemory {
  idleSince: Map<string, number>;
  lastSocialAt: number;
  /** Exchange used by each running conversation, by activity id. */
  exchangeByActivity: Map<string, string>;
  /** Exchanges used lately, newest last, so the same lines do not come back right away. */
  recentExchanges: string[];
}

const ambientMemory = new WeakMap<LivingOfficeState, AmbientMemory>();

function ambientMemoryFor(state: LivingOfficeState): AmbientMemory {
  let memory = ambientMemory.get(state);
  if (!memory) {
    memory = { idleSince: new Map(), lastSocialAt: 0, exchangeByActivity: new Map(), recentExchanges: [] };
    ambientMemory.set(state, memory);
  }
  return memory;
}

/** True when the agent takes part in a meeting that is scheduled (people walking to it) or running. */
export function isInMeeting(state: Pick<LivingOfficeState, 'meetings' | 'roomReservations'>, agentId: string): boolean {
  return (
    state.meetings.some(
      (meeting) => (meeting.status === 'SCHEDULED' || meeting.status === 'ACTIVE') && meeting.participants.includes(agentId),
    ) || state.roomReservations.some((reservation) => reservation.participantIds.includes(agentId))
  );
}

/**
 * Simulated social life only uses agents with nothing to do: idle on the main floor, without a current task and
 * outside any meeting (in it, called to it or walking to it).
 */
export function isBusyForAmbientLife(state: LivingOfficeState, agent: Agent): boolean {
  return (
    (agent.floor ?? 1) !== 1 ||
    agent.status !== 'IDLE' ||
    Boolean(agent.currentTaskId) ||
    isInMeeting(state, agent.id)
  );
}

/**
 * Removes every trace of simulated small talk from an agent: bubble, conversation, coffee seat and mood. A
 * conversation needs two people, so the partner stops talking too (it stays at the coffee bar) and nobody keeps
 * talking to someone who already left.
 */
export function clearAmbientLife(state: LivingOfficeState, agent: Agent): void {
  const activityId = agent.socialActivityId;
  if (activityId) {
    for (const partner of state.agents) {
      if (partner.id === agent.id || partner.socialActivityId !== activityId) continue;
      partner.socialActivityId = null;
      partner.ambientBubble = null;
      if (partner.presentationActivity === 'chatting') partner.presentationActivity = 'coffee_break';
      partner.mood = 'neutral';
    }
    state.socialActivities = state.socialActivities.filter((activity) => activity.id !== activityId);
  }
  if (agent.ambientBubble) agent.ambientBubble = null;
  if (agent.socialActivityId) agent.socialActivityId = null;
  if (agent.presentationActivity) {
    agent.presentationActivity = null;
    agent.mood = 'neutral';
  }
  if (state.coffeeSeatAssignments?.some((item) => item.agentId === agent.id)) releaseCoffeeSeat(state, agent.id);
}

function exchangeId(locale: SocialLocale, index: number): string {
  return `${locale}:${index}`;
}

export function applyAmbientLife(
  state: LivingOfficeState,
  now: number,
  locale: SocialLocale,
  options: AmbientOptions,
): void {
  if (!options.enabled) return;
  const memory = ambientMemoryFor(state);
  const idleSince = memory.idleSince;

  const idleAgents: Agent[] = [];
  for (const agent of state.agents) {
    if (isBusyForAmbientLife(state, agent)) {
      idleSince.delete(agent.id);
      clearAmbientLife(state, agent);
    } else {
      if (!idleSince.has(agent.id)) idleSince.set(agent.id, now);
      idleAgents.push(agent);
    }
  }

  for (const agent of idleAgents) {
    const since = idleSince.get(agent.id) ?? now;
    if (!agent.presentationActivity && now - since >= options.idleGraceMs) {
      agent.presentationActivity = 'coffee_break';
      agent.mood = 'neutral';
      moveAgentToCoffeeSeat(state, agent);
    }
  }

  // Forget the exchanges of conversations that already ended.
  const running = new Set(state.socialActivities.map((activity) => activity.id));
  for (const activityId of [...memory.exchangeByActivity.keys()]) {
    if (!running.has(activityId)) memory.exchangeByActivity.delete(activityId);
  }

  if (now - memory.lastSocialAt < options.minIntervalMs) return;

  // An agent already in a conversation is not pulled into a second one.
  const socialCandidates = idleAgents.filter((agent) => !agent.socialActivityId);
  if (socialCandidates.length < 2) return;

  const participants = socialCandidates.slice(0, 2);
  const pack = socialPack(locale)
    .map((exchange, index) => ({ exchange, id: exchangeId(locale, index) }))
    .filter(({ exchange }) => options.politicsEnabled || exchange.topic !== 'politics');
  if (!pack.length) return;

  // Two conversations at the same time never share an exchange, and recent ones wait their turn.
  const inUse = new Set(memory.exchangeByActivity.values());
  const recent = new Set(memory.recentExchanges);
  const seed = Math.abs(Math.floor(now / Math.max(options.minIntervalMs, 1))) % pack.length;
  const ordered = [...pack.slice(seed), ...pack.slice(0, seed)];
  const picked =
    ordered.find((item) => !inUse.has(item.id) && !recent.has(item.id)) ??
    ordered.find((item) => !inUse.has(item.id));
  if (!picked) return;
  const exchange = picked.exchange;
  const activityId = `social-${now}`;

  memory.exchangeByActivity.set(activityId, picked.id);
  memory.recentExchanges = [...memory.recentExchanges.filter((id) => id !== picked.id), picked.id].slice(
    -Math.max(1, Math.floor(pack.length / 2)),
  );

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
      livingOfficeText(locale, 'event.socialStarted', { topic: livingOfficeText(locale, `topic.${exchange.topic}`) }),
      {
        activityId,
        participantIds: participants.map((agent) => agent.id),
        topic: exchange.topic,
        simulated: true,
        locale,
      },
      participants[1].id,
      now,
    ),
  );
  memory.lastSocialAt = now;
}

export function activeOverflowReservations(
  state: Pick<LivingOfficeState, 'roomReservations'>,
): RoomReservation[] {
  return state.roomReservations.filter((reservation) => reservation.floor === 2);
}

export function isOverflowMeetingRoom(roomId: string): boolean {
  return isOverflowRoom(roomId);
}
