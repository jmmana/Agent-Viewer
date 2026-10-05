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

export type MeetingRoomId = 'meeting_room' | 'meeting_room_b' | 'boss_office';

export interface RoomPolicy {
  id: MeetingRoomId;
  capacity: number;
  priority: number;
  fallback: boolean;
  seats: Array<{ x: number; y: number }>;
}

export interface RoomReservation {
  roomId: MeetingRoomId;
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
}

export const MEETING_ROOM_POLICIES: RoomPolicy[] = [
  {
    id: 'meeting_room',
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

export function routeForStatus(agent: Agent, status: AgentStatus): WorkspaceZone {
  if (status === 'IN_MEETING' && (agent.workspace === 'meeting_room' || agent.workspace === 'meeting_room_b' || agent.workspace === 'boss_office')) {
    return agent.workspace;
  }
  return STATUS_DESTINATIONS[status] ?? agent.workspace;
}

export function routeAgent(agent: Agent, workspace: WorkspaceZone): void {
  const anchor = WORKSPACE_ANCHORS[workspace];
  agent.workspace = workspace;
  agent.targetX = anchor.x;
  agent.targetY = anchor.y;
  agent.isWalking = Math.hypot(agent.x - anchor.x, agent.y - anchor.y) > 0.15;
}

export function reserveMeetingRoom(
  state: LivingOfficeState,
  meetingId: string,
  participantIds: string[],
): RoomReservation | null {
  const occupied = new Set(state.roomReservations.map((reservation) => reservation.roomId));
  const room = MEETING_ROOM_POLICIES
    .filter((candidate) => candidate.capacity >= participantIds.length && !occupied.has(candidate.id))
    .sort((a, b) => a.priority - b.priority)[0];

  if (!room) return null;

  const reservation: RoomReservation = {
    roomId: room.id,
    meetingId,
    participantIds,
    reservedAt: Date.now(),
    status: 'RESERVED',
  };

  state.roomReservations.push(reservation);
  state.events.unshift(
    event(
      'meeting.room.reserved',
      'system',
      `${room.id} reserved for ${meetingId}.`,
      { meetingId, roomId: room.id, participantIds },
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
): Meeting | null {
  const reservation = reserveMeetingRoom(state, args.id, args.participantIds);
  if (!reservation) {
    state.events.unshift(
      event(
        'meeting.cancelled',
        args.initiatorId,
        `No room available for ${args.title}.`,
        { meetingId: args.id, reason: 'no-room-available' },
      ),
    );
    return null;
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
      `${args.title} requested.`,
      { meetingId: args.id, participantIds: args.participantIds, roomId: reservation.roomId },
    ),
  );

  const room = MEETING_ROOM_POLICIES.find((item) => item.id === reservation.roomId)!;
  for (const [index, agentId] of args.participantIds.entries()) {
    const agent = state.agents.find((item) => item.id === agentId);
    if (!agent) continue;
    agent.status = 'PHONE_CALL';
    agent.statusText = `Call received: meeting in ${reservation.roomId}`;
    agent.speechBubble = {
      text: index === 0 ? 'We need to sync. Meet me in the room.' : 'Got it. I am heading there.',
      targetAgentName: index === 0
        ? state.agents.find((item) => item.id === args.participantIds[1])?.name
        : state.agents.find((item) => item.id === args.initiatorId)?.name,
      expiresAt: Date.now() + 2600,
    };
    state.events.unshift(
      event(
        'agent.phone_call.started',
        args.initiatorId,
        `Phone call started with ${agent.name}.`,
        { meetingId: args.id, roomId: reservation.roomId },
        agent.id,
      ),
    );
    const seat = room.seats[index] ?? room.seats[room.seats.length - 1];
    agent.workspace = reservation.roomId;
    agent.targetX = seat.x;
    agent.targetY = seat.y;
    agent.isWalking = true;
  }

  return meeting;
}

export function activateMeetingWhenArrived(state: LivingOfficeState, meetingId: string): boolean {
  const meeting = state.meetings.find((item) => item.id === meetingId);
  const reservation = state.roomReservations.find((item) => item.meetingId === meetingId);
  if (!meeting || !reservation || meeting.status !== 'SCHEDULED') return false;

  const allArrived = meeting.participants.every((id) => {
    const agent = state.agents.find((item) => item.id === id);
    return agent && !agent.isWalking;
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
      { meetingId, roomId: reservation.roomId, participants: meeting.participants },
    ),
  );
  return true;
}

export function endMeeting(state: LivingOfficeState, meetingId: string): void {
  const meeting = state.meetings.find((item) => item.id === meetingId);
  if (!meeting) return;
  meeting.status = 'CONCLUDED';
  meeting.endedAt = Date.now();
  state.activeMeetingId = state.activeMeetingId === meetingId ? null : state.activeMeetingId;
  state.roomReservations = state.roomReservations.filter((item) => item.meetingId !== meetingId);
  for (const id of meeting.participants) {
    const agent = state.agents.find((item) => item.id === id);
    if (!agent) continue;
    agent.status = 'IDLE';
    agent.statusText = 'Available after meeting';
    const destination = routeForStatus(agent, agent.status);
    routeAgent(agent, destination);
  }
  state.events.unshift(
    event('meeting.ended', meeting.initiatorId, `Meeting ended: ${meeting.title}.`, { meetingId }),
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

  const idleAgents = state.agents.filter((agent) => agent.status === 'IDLE' && !agent.currentTaskId);
  for (const agent of state.agents) {
    if (agent.status === 'IDLE' && !agent.currentTaskId) {
      if (!idleSince.has(agent.id)) idleSince.set(agent.id, now);
    } else {
      idleSince.delete(agent.id);
      if (agent.status !== 'CHATTING' && agent.status !== 'COFFEE_BREAK') {
        agent.socialActivityId = null;
      }
    }
  }

  for (const agent of idleAgents) {
    const since = idleSince.get(agent.id) ?? now;
    if (now - since >= options.idleGraceMs && agent.workspace !== 'break_room') {
      agent.status = 'COFFEE_BREAK';
      agent.statusText = 'Idle · grabbing coffee';
      agent.mood = 'neutral';
      routeAgent(agent, 'break_room');
    }
  }

  if (now - lastSocialAt < options.minIntervalMs) return;
  const socialCandidates = state.agents.filter(
    (agent) => (agent.status === 'COFFEE_BREAK' || agent.status === 'IDLE') && !agent.currentTaskId,
  );
  if (socialCandidates.length < 2) return;

  const participants = socialCandidates.slice(0, 2);
  const pack = socialPack(locale).filter((exchange) => options.politicsEnabled || exchange.topic !== 'politics');
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
    agent.status = 'CHATTING';
    agent.statusText = `Ambient chat · ${exchange.topic}`;
    agent.socialActivityId = activityId;
    agent.mood = exchange.lines[index].mood;
    routeAgent(agent, 'break_room');
    agent.speechBubble = {
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
