import type { Agent, AgentRole, AgentStatus, MeetingMessage, ViewerEvent, WorkspaceZone, Task } from '../types/agent';
import type { SimulationState } from '../engine/officeState';
import { endMeeting, requestMeeting, routeAgent, WORKSPACE_ANCHORS } from '../engine/livingOfficeEngine';
import { livingOfficeText } from '../content/livingOfficeMessages';
import {
  type CanonicalEvent,
  type MessageKind,
  normalizeCanonicalEvent,
  EVENT_TYPE_ALIASES,
  isMessageKind,
} from './canonicalTypes';
import {
  emptyUsageTally,
  cloneUsageTally,
  addUsageCall,
  readUsageCall,
  type UsageTally,
} from './usageTally';

const STATUS_VALUES = new Set<AgentStatus>([
  'OFFLINE', 'IDLE', 'AVAILABLE', 'THINKING', 'READING', 'RESEARCHING', 'CODING', 'WRITING', 'TESTING',
  'USING_TOOL', 'WAITING', 'WAITING_APPROVAL', 'BLOCKED', 'DELEGATING', 'PHONE_CALL', 'WALKING',
  'IN_MEETING', 'COFFEE_BREAK', 'CHATTING', 'REVIEWING', 'DELIVERING', 'DONE', 'ERROR',
]);

const ROLE_VALUES = new Set<AgentRole>([
  'boss', 'tech_lead', 'research_lead', 'backend_engineer', 'frontend_engineer', 'qa_engineer', 'security_analyst', 'custom',
]);

const TEAM_VALUES = new Set<Agent['team']>(['leadership', 'engineering', 'research', 'quality', 'operations', 'other']);

/** Default time a speech bubble stays on screen. */
export const DEFAULT_BUBBLE_MS = 6500;

export interface ExternalEventEnvelope extends ViewerEvent {
  schemaVersion?: string;
  agentId?: string;
}

export interface ApplyEventOptions {
  /** Clock for bubbles and walking. Defaults to `Date.now()`; tests and replays pass their own. */
  now?: number;
  /** How long a speech bubble stays visible, in milliseconds. */
  bubbleMs?: number;
  /** Let the office add its own short lines when a meeting is requested (demo app only). */
  narrate?: boolean;
  /** Allow the hidden overflow floor when every visible meeting room is busy. */
  overflowFloor?: boolean;
  /** Accumulate tokens and reported costs from `llm.usage` into the state. */
  trackUsage?: boolean;
  /** BCP 47 locale of the texts the office writes itself (room labels, status texts). Defaults to English. */
  locale?: string;
}

function isWorkspace(value: unknown): value is WorkspaceZone {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WORKSPACE_ANCHORS, value);
}

function isAvatarColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value);
}

/**
 * Creates default agent profile for an unregistered agent. Exported so `snapshotRebuild.ts` (issue #54) can
 * seed an agent that the snapshot's usage lists but whose `agent.registered` event fell outside the snapshot's
 * 100 most recent events.
 */
export function createDefaultAgent(id: string, now: number, name?: string, roleTitle?: string): Agent {
  const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const colors = ['#38bdf8', '#818cf8', '#34d399', '#f472b6', '#fbbf24', '#a78bfa'];
  const avatarColor = colors[hash % colors.length];

  return {
    id,
    name: name || id,
    role: 'custom',
    roleTitle: roleTitle ?? '',
    team: 'other',
    managerId: null,
    provider: 'External',
    model: 'external-model',
    status: 'IDLE',
    statusText: '',
    currentTaskId: null,
    currentTool: null,
    workspace: 'development',
    x: 18,
    y: 12,
    targetX: 18,
    targetY: 12,
    isWalking: false,
    facing: 'SE',
    avatarColor,
    clothingColor: '#1e293b',
    hairColor: '#334155',
    accessory: 'none',
    tokensInput: 0,
    tokensOutput: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    startedAt: now,
    speechBubble: null,
    mood: 'neutral',
    socialActivityId: null,
  };
}

/** Applies the identity fields a runtime sends with `agent.registered` or `agent.updated`. */
function applyProfile(agent: Agent, payload: Record<string, any>, now: number, spawn: boolean): void {
  if (typeof payload.name === 'string' && payload.name) agent.name = payload.name;
  if (typeof payload.roleTitle === 'string') agent.roleTitle = payload.roleTitle;
  if (typeof payload.provider === 'string') agent.provider = payload.provider;
  if (typeof payload.model === 'string') agent.model = payload.model;
  if (typeof payload.statusText === 'string') agent.statusText = payload.statusText;
  if (ROLE_VALUES.has(payload.role)) agent.role = payload.role;
  if (TEAM_VALUES.has(payload.team)) agent.team = payload.team;
  if (isAvatarColor(payload.avatarColor)) agent.avatarColor = payload.avatarColor;
  if (typeof payload.managerId === 'string' || payload.managerId === null) agent.managerId = payload.managerId;
  const status = typeof payload.status === 'string' ? payload.status.toUpperCase() : '';
  if (STATUS_VALUES.has(status as AgentStatus)) agent.status = status as AgentStatus;

  if (isWorkspace(payload.workspace)) {
    agent.homeWorkspace = payload.workspace;
    if (spawn) {
      // A new agent appears at its own desk instead of walking in from a default spot.
      const anchor = WORKSPACE_ANCHORS[payload.workspace];
      agent.workspace = payload.workspace;
      agent.x = agent.targetX = anchor.x;
      agent.y = agent.targetY = anchor.y;
      agent.isWalking = false;
    } else {
      routeAgent(agent, payload.workspace, now);
    }
  }
}

function speak(
  state: SimulationState,
  agent: Agent,
  payload: Record<string, any>,
  now: number,
  bubbleMs: number,
  kind?: MessageKind,
): void {
  const targetById = typeof payload.targetAgentId === 'string'
    ? state.agents.find((item) => item.id === payload.targetAgentId)?.name
    : undefined;
  agent.speechBubble = {
    text: payload.text,
    targetAgentName: typeof payload.targetAgentName === 'string' ? payload.targetAgentName : targetById,
    expiresAt: now + bubbleMs,
    kind,
  };
}

export function applyExternalEvent(
  state: SimulationState,
  rawIncoming: ExternalEventEnvelope | CanonicalEvent,
  options: ApplyEventOptions = {},
): void {
  const incoming = normalizeCanonicalEvent(rawIncoming);
  const now = options.now ?? Date.now();
  const bubbleMs = options.bubbleMs ?? DEFAULT_BUBBLE_MS;
  const meetingOptions = {
    now,
    narrate: options.narrate ?? true,
    overflowFloor: options.overflowFloor ?? true,
    locale: options.locale,
  };

  // Check idempotency against existing events in state
  if (state.events.some((event) => event.id === incoming.id)) return;

  const agentId = incoming.agentId ?? incoming.source.replace(/^agent:/, '');
  let agent = state.agents.find((item) => item.id === agentId);
  const payload = incoming.payload ?? {};
  let created = false;

  // Requirement 12: Auto-registration.
  // If an event mentions an agent that does not yet exist, auto-register it!
  // An explicit agentId always names an agent; a bare `runtime:` source is the runtime itself, not an agent.
  const namesAnAgent = Boolean(incoming.agentId) || !incoming.source.startsWith('runtime:');
  if (!agent && agentId && agentId !== 'external-runtime' && agentId !== 'system' && namesAnAgent) {
    const newAgent = createDefaultAgent(
      agentId,
      now,
      typeof payload.name === 'string' ? payload.name : agentId,
      typeof payload.roleTitle === 'string' ? payload.roleTitle : undefined
    );
    state.agents.push(newAgent);
    agent = newAgent;
    created = true;
  }

  const resolvedType: string = (EVENT_TYPE_ALIASES[incoming.type] ?? incoming.type);

  switch (resolvedType) {
    case 'agent.registered': {
      const id = incoming.agentId ?? incoming.source.replace(/^agent:/, '');
      let registered = state.agents.find((item) => item.id === id);
      if (!registered) {
        registered = createDefaultAgent(id, now, typeof payload.name === 'string' ? payload.name : id);
        state.agents.push(registered);
        created = true;
      }
      applyProfile(registered, payload, now, created);
      break;
    }

    case 'agent.updated': {
      if (agent) applyProfile(agent, payload, now, created);
      break;
    }

    case 'agent.status.changed': {
      const rawStatus = (payload.status ?? '').toString().toUpperCase();
      if (agent && STATUS_VALUES.has(rawStatus as AgentStatus)) {
        agent.status = rawStatus as AgentStatus;
        agent.statusText = typeof payload.statusText === 'string' ? payload.statusText : incoming.summary;
        if (isWorkspace(payload.workspace)) {
          routeAgent(agent, payload.workspace, now);
        }
      }
      break;
    }

    case 'agent.message.sent':
    case 'message.sent': {
      if (agent && typeof payload.text === 'string') {
        speak(state, agent, payload, now, bubbleMs, isMessageKind(payload.kind) ? payload.kind : undefined);
      }
      break;
    }

    case 'task.created': {
      const taskId = payload.id ?? incoming.taskId ?? `task_${incoming.id}`;
      const existingTask = state.tasks.find((t) => t.id === taskId);
      if (!existingTask) {
        const newTask: Task = {
          id: taskId,
          title: typeof payload.title === 'string' ? payload.title : incoming.summary,
          description: typeof payload.description === 'string' ? payload.description : '',
          initiatorId: agentId || 'system',
          assignedAgentId: typeof payload.assignedAgentId === 'string' ? payload.assignedAgentId : (agentId || 'unassigned'),
          collaboratorIds: Array.isArray(payload.collaboratorIds) ? payload.collaboratorIds : [],
          status: 'PENDING',
          progress: 0,
          createdAt: incoming.timestamp,
          tokensTotal: 0,
          costTotal: 0,
          toolsUsed: [],
          artifacts: [],
        };
        state.tasks.unshift(newTask);
      }
      break;
    }

    case 'task.assigned': {
      const taskId = payload.taskId ?? incoming.taskId;
      const targetTask = state.tasks.find((t) => t.id === taskId);
      if (targetTask && typeof payload.assignedAgentId === 'string') {
        targetTask.assignedAgentId = payload.assignedAgentId;
        targetTask.status = 'ASSIGNED';
      }
      break;
    }

    case 'task.progress': {
      const taskId = payload.taskId ?? incoming.taskId;
      const targetTask = state.tasks.find((t) => t.id === taskId);
      if (targetTask) {
        targetTask.status = 'IN_PROGRESS';
        if (typeof payload.progress === 'number') targetTask.progress = payload.progress;
      }
      if (agent) {
        agent.currentTaskId = taskId || null;
      }
      break;
    }

    case 'task.completed': {
      const taskId = payload.taskId ?? incoming.taskId;
      const targetTask = state.tasks.find((t) => t.id === taskId);
      if (targetTask) {
        targetTask.status = 'COMPLETED';
        targetTask.progress = 100;
        targetTask.completedAt = incoming.timestamp;
      }
      if (agent && agent.currentTaskId === taskId) {
        agent.currentTaskId = null;
        agent.status = 'DONE';
        agent.statusText = livingOfficeText(options.locale, 'status.taskCompleted');
      }
      break;
    }

    case 'task.failed': {
      const taskId = payload.taskId ?? incoming.taskId;
      const targetTask = state.tasks.find((t) => t.id === taskId);
      if (targetTask) {
        targetTask.status = 'FAILED';
        targetTask.blockerReason = typeof payload.error === 'string' ? payload.error : livingOfficeText(options.locale, 'task.executionFailed');
      }
      if (agent && agent.currentTaskId === taskId) {
        agent.status = 'ERROR';
        agent.statusText = livingOfficeText(options.locale, 'status.taskFailed');
      }
      break;
    }

    case 'task.blocked': {
      const taskId = payload.taskId ?? incoming.taskId;
      const targetTask = state.tasks.find((t) => t.id === taskId);
      if (targetTask) {
        targetTask.status = 'BLOCKED';
        targetTask.blockerReason = typeof payload.reason === 'string' ? payload.reason : livingOfficeText(options.locale, 'task.waitingOnDependency');
      }
      if (agent) {
        agent.status = 'BLOCKED';
        agent.statusText = typeof payload.reason === 'string' ? payload.reason : livingOfficeText(options.locale, 'status.blocked');
      }
      break;
    }

    case 'tool.started': {
      if (agent) {
        agent.status = 'USING_TOOL';
        agent.currentTool = typeof payload.tool === 'string' ? payload.tool : 'tool';
        agent.statusText = typeof payload.inputSummary === 'string'
          ? livingOfficeText(options.locale, 'status.toolWithInput', { tool: agent.currentTool, input: payload.inputSummary })
          : livingOfficeText(options.locale, 'status.usingTool', { tool: agent.currentTool });
        if (incoming.taskId) {
          const task = state.tasks.find((t) => t.id === incoming.taskId);
          if (task && agent.currentTool && !task.toolsUsed.includes(agent.currentTool)) {
            task.toolsUsed.push(agent.currentTool);
          }
        }
      }
      break;
    }

    case 'tool.completed': {
      if (agent) {
        agent.currentTool = null;
        agent.status = 'IDLE';
        agent.statusText = typeof payload.outputSummary === 'string'
          ? livingOfficeText(options.locale, 'status.toolFinishedWith', { output: payload.outputSummary })
          : livingOfficeText(options.locale, 'status.toolFinished');
      }
      break;
    }

    case 'tool.failed': {
      if (agent) {
        agent.currentTool = null;
        agent.status = 'ERROR';
        agent.statusText = typeof payload.error === 'string'
          ? livingOfficeText(options.locale, 'status.toolFailedWith', { error: payload.error })
          : livingOfficeText(options.locale, 'status.toolFailed');
      }
      break;
    }

    case 'llm.usage': {
      if (agent) {
        if (typeof payload.provider === 'string') agent.provider = payload.provider;
        if (typeof payload.model === 'string') agent.model = payload.model;
      }
      if (options.trackUsage === false) break;

      // Read the usage call and add it to the state tally
      const call = readUsageCall(payload);
      addUsageCall(state.usage, call);

      // Add to agent tally if agent exists
      if (agent) {
        if (!agent.usage) {
          agent.usage = emptyUsageTally();
        }
        addUsageCall(agent.usage, call);
      }

      // Add to task tally if task is associated
      if (incoming.taskId) {
        const task = state.tasks.find((t) => t.id === incoming.taskId);
        if (task) {
          if (!task.usage) {
            task.usage = emptyUsageTally();
          }
          addUsageCall(task.usage, call);
        }
      }

      // Keep legacy fields updated for compatibility
      const input = Number(payload.inputTokens ?? 0);
      const output = Number(payload.outputTokens ?? 0);
      const cached = Number(payload.cachedTokens ?? 0);
      const reasoning = Number(payload.reasoningTokens ?? 0);
      const cost = typeof payload.cost === 'number' && Number.isFinite(payload.cost) ? payload.cost : 0;

      if (agent) {
        agent.tokensInput += Number.isFinite(input) ? input : 0;
        agent.tokensOutput += Number.isFinite(output) ? output : 0;
        agent.cachedTokens += Number.isFinite(cached) ? cached : 0;
        agent.reasoningTokens += Number.isFinite(reasoning) ? reasoning : 0;
        agent.cost += cost;
      }

      state.totalTokens.input += Number.isFinite(input) ? input : 0;
      state.totalTokens.output += Number.isFinite(output) ? output : 0;
      state.totalTokens.cached += Number.isFinite(cached) ? cached : 0;
      state.totalCost += cost;

      if (incoming.taskId) {
        const task = state.tasks.find((t) => t.id === incoming.taskId);
        if (task) {
          task.tokensTotal += (input + output);
          task.costTotal += cost;
        }
      }
      break;
    }

    case 'llm.failed': {
      // A failed attempt is often retried, so the runtime stays the source of truth for the status.
      // Tokens and cost from failed calls are never added here, even with trackUsage.
      if (agent) {
        if (typeof payload.provider === 'string') agent.provider = payload.provider;
        if (typeof payload.model === 'string') agent.model = payload.model;
      }
      break;
    }

    case 'meeting.requested': {
      const participants = Array.isArray(payload.participantIds)
        ? payload.participantIds.filter((id): id is string => typeof id === 'string')
        : [];
      const meetingId = typeof payload.meetingId === 'string' ? payload.meetingId : `meeting-${incoming.id}`;
      if (participants.length > 0 && !state.meetings.some((item) => item.id === meetingId)) {
        requestMeeting(state, {
          id: meetingId,
          title: typeof payload.title === 'string' ? payload.title : incoming.summary,
          topic: typeof payload.topic === 'string' ? payload.topic : incoming.summary,
          initiatorId: incoming.source.replace(/^agent:/, ''),
          participantIds: participants,
          taskId: incoming.taskId,
        }, meetingOptions);
      }
      break;
    }

    case 'meeting.started': {
      const meetingId = typeof payload.meetingId === 'string' ? payload.meetingId : undefined;
      const participants = Array.isArray(payload.participantIds)
        ? payload.participantIds.filter((id): id is string => typeof id === 'string')
        : [];
      let meeting = meetingId ? state.meetings.find((item) => item.id === meetingId) : undefined;
      if (!meeting && meetingId && participants.length > 0) {
        meeting = requestMeeting(state, {
          id: meetingId,
          title: typeof payload.title === 'string' ? payload.title : incoming.summary,
          topic: incoming.summary,
          initiatorId: incoming.source.replace(/^agent:/, ''),
          participantIds: participants,
          taskId: incoming.taskId,
        }, meetingOptions);
      }
      if (meeting && meeting.status === 'SCHEDULED') {
        // The runtime says the meeting started: it does not wait for everyone to finish walking.
        const startedId = meeting.id;
        meeting.status = 'ACTIVE';
        meeting.startedAt = now;
        const reservation = state.roomReservations.find((item) => item.meetingId === startedId);
        if (reservation) reservation.status = 'ACTIVE';
        state.activeMeetingId = meeting.id;
        for (const id of meeting.participants) {
          const participant = state.agents.find((item) => item.id === id);
          if (participant) participant.status = 'IN_MEETING';
        }
      }
      break;
    }

    case 'meeting.message': {
      if (agent && typeof payload.text === 'string') {
        const kind: MessageKind = isMessageKind(payload.type) ? payload.type : 'statement';
        speak(state, agent, payload, now, bubbleMs, kind);
        const meetingId = typeof payload.meetingId === 'string' ? payload.meetingId : state.activeMeetingId;
        const meeting = state.meetings.find((item) => item.id === meetingId);
        if (meeting) {
          const message: MeetingMessage = {
            id: incoming.id,
            senderId: agent.id,
            text: payload.text,
            timestamp: incoming.timestamp,
            type: kind,
          };
          meeting.messages.push(message);
          if (kind === 'decision') meeting.decisions.push(payload.text);
        }
      }
      break;
    }

    case 'meeting.ended':
    case 'meeting.cancelled': {
      if (typeof payload.meetingId === 'string') endMeeting(state, payload.meetingId, now, options.locale);
      break;
    }
  }

  // Prepend canonical event to state event history (max 5000 items in browser state)
  state.events.unshift(incoming as ViewerEvent);
  if (state.events.length > 5000) {
    state.events.length = 5000;
  }
}
