import type { Agent, AgentStatus, ViewerEvent, WorkspaceZone, Task } from '../types/agent';
import type { SimulationState } from '../engine/simulationEngine';
import { endMeeting, requestMeeting, routeAgent } from '../engine/livingOfficeEngine';
import {
  type CanonicalEvent,
  validateCanonicalEvent,
  normalizeCanonicalEvent,
  EVENT_TYPE_ALIASES,
} from './canonicalContract';

const STATUS_VALUES = new Set<AgentStatus>([
  'OFFLINE', 'IDLE', 'AVAILABLE', 'THINKING', 'READING', 'RESEARCHING', 'CODING', 'WRITING', 'TESTING',
  'USING_TOOL', 'WAITING', 'WAITING_APPROVAL', 'BLOCKED', 'DELEGATING', 'PHONE_CALL', 'WALKING',
  'IN_MEETING', 'COFFEE_BREAK', 'CHATTING', 'REVIEWING', 'DELIVERING', 'DONE', 'ERROR',
]);

export interface ExternalEventEnvelope extends ViewerEvent {
  schemaVersion?: string;
  agentId?: string;
}

export function validateExternalEvent(value: unknown): value is ExternalEventEnvelope {
  const result = validateCanonicalEvent(value);
  if (result.success) return true;
  // Fallback check for minimal raw event
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === 'string' &&
    event.id.length > 0 &&
    typeof event.type === 'string' &&
    typeof event.timestamp === 'number' &&
    typeof event.source === 'string' &&
    typeof event.summary === 'string' &&
    !!event.payload &&
    typeof event.payload === 'object'
  );
}

/**
 * Creates default agent profile for an unregistered agent.
 */
function createDefaultAgent(id: string, name?: string, roleTitle?: string): Agent {
  const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const colors = ['#38bdf8', '#818cf8', '#34d399', '#f472b6', '#fbbf24', '#a78bfa'];
  const avatarColor = colors[hash % colors.length];

  return {
    id,
    name: name || id,
    role: 'custom',
    roleTitle: roleTitle || 'AI Agent',
    team: 'other',
    managerId: null,
    provider: 'External',
    model: 'external-model',
    status: 'IDLE',
    statusText: 'Active',
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
    startedAt: Date.now(),
    speechBubble: null,
    mood: 'neutral',
    socialActivityId: null,
  };
}

export function applyExternalEvent(state: SimulationState, rawIncoming: ExternalEventEnvelope | CanonicalEvent): void {
  const incoming = normalizeCanonicalEvent(rawIncoming);

  // Check idempotency against existing events in state
  if (state.events.some((event) => event.id === incoming.id)) return;

  const agentId = incoming.agentId ?? incoming.source.replace(/^agent:/, '');
  let agent = state.agents.find((item) => item.id === agentId);
  const payload = incoming.payload ?? {};

  // Requirement 12: Auto-registration.
  // If an event mentions an agent that does not yet exist, auto-register it!
  if (!agent && agentId && agentId !== 'external-runtime' && agentId !== 'system' && !incoming.source.startsWith('runtime:')) {
    const newAgent = createDefaultAgent(
      agentId,
      typeof payload.name === 'string' ? payload.name : agentId,
      typeof payload.roleTitle === 'string' ? payload.roleTitle : undefined
    );
    state.agents.push(newAgent);
    agent = newAgent;
  }

  const resolvedType: string = (EVENT_TYPE_ALIASES[incoming.type] ?? incoming.type);

  switch (resolvedType) {
    case 'agent.registered': {
      const id = incoming.agentId ?? incoming.source.replace(/^agent:/, '');
      const existing = state.agents.find((item) => item.id === id);
      if (!existing) {
        state.agents.push(createDefaultAgent(
          id,
          typeof payload.name === 'string' ? payload.name : id,
          typeof payload.roleTitle === 'string' ? payload.roleTitle : 'External Agent'
        ));
      } else {
        if (typeof payload.name === 'string') existing.name = payload.name;
        if (typeof payload.roleTitle === 'string') existing.roleTitle = payload.roleTitle;
        if (typeof payload.provider === 'string') existing.provider = payload.provider;
        if (typeof payload.model === 'string') existing.model = payload.model;
      }
      break;
    }

    case 'agent.updated': {
      if (agent) {
        if (typeof payload.name === 'string') agent.name = payload.name;
        if (typeof payload.roleTitle === 'string') agent.roleTitle = payload.roleTitle;
        if (typeof payload.provider === 'string') agent.provider = payload.provider;
        if (typeof payload.model === 'string') agent.model = payload.model;
        if (typeof payload.statusText === 'string') agent.statusText = payload.statusText;
        if (typeof payload.workspace === 'string') routeAgent(agent, payload.workspace as WorkspaceZone);
      }
      break;
    }

    case 'agent.status.changed': {
      const rawStatus = (payload.status ?? '').toString().toUpperCase();
      if (agent && STATUS_VALUES.has(rawStatus as AgentStatus)) {
        agent.status = rawStatus as AgentStatus;
        agent.statusText = typeof payload.statusText === 'string' ? payload.statusText : incoming.summary;
        if (typeof payload.workspace === 'string') {
          routeAgent(agent, payload.workspace as WorkspaceZone);
        }
      }
      break;
    }

    case 'agent.message.sent':
    case 'message.sent': {
      if (agent && typeof payload.text === 'string') {
        agent.speechBubble = {
          text: payload.text,
          targetAgentName: typeof payload.targetAgentName === 'string' ? payload.targetAgentName : undefined,
          expiresAt: Date.now() + 6500,
        };
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
        agent.statusText = 'Task completed';
      }
      break;
    }

    case 'task.failed': {
      const taskId = payload.taskId ?? incoming.taskId;
      const targetTask = state.tasks.find((t) => t.id === taskId);
      if (targetTask) {
        targetTask.status = 'FAILED';
        targetTask.blockerReason = typeof payload.error === 'string' ? payload.error : 'Execution failed';
      }
      if (agent && agent.currentTaskId === taskId) {
        agent.status = 'ERROR';
        agent.statusText = 'Task failed';
      }
      break;
    }

    case 'task.blocked': {
      const taskId = payload.taskId ?? incoming.taskId;
      const targetTask = state.tasks.find((t) => t.id === taskId);
      if (targetTask) {
        targetTask.status = 'BLOCKED';
        targetTask.blockerReason = typeof payload.reason === 'string' ? payload.reason : 'Waiting on dependency';
      }
      if (agent) {
        agent.status = 'BLOCKED';
        agent.statusText = typeof payload.reason === 'string' ? payload.reason : 'Blocked';
      }
      break;
    }

    case 'tool.started': {
      if (agent) {
        agent.status = 'USING_TOOL';
        agent.currentTool = typeof payload.tool === 'string' ? payload.tool : 'tool';
        agent.statusText = typeof payload.inputSummary === 'string'
          ? `Tool: ${agent.currentTool} (${payload.inputSummary})`
          : `Using ${agent.currentTool}`;
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
          ? `Tool finished: ${payload.outputSummary}`
          : 'Tool execution finished';
      }
      break;
    }

    case 'tool.failed': {
      if (agent) {
        agent.currentTool = null;
        agent.status = 'ERROR';
        agent.statusText = typeof payload.error === 'string' ? `Tool failed: ${payload.error}` : 'Tool execution failed';
      }
      break;
    }

    case 'llm.usage': {
      if (agent) {
        const input = Number(payload.inputTokens ?? 0);
        const output = Number(payload.outputTokens ?? 0);
        const cached = Number(payload.cachedTokens ?? 0);
        const reasoning = Number(payload.reasoningTokens ?? 0);
        const cost = typeof payload.cost === 'number' && Number.isFinite(payload.cost) ? payload.cost : 0;

        if (typeof payload.provider === 'string') agent.provider = payload.provider;
        if (typeof payload.model === 'string') agent.model = payload.model;

        agent.tokensInput += Number.isFinite(input) ? input : 0;
        agent.tokensOutput += Number.isFinite(output) ? output : 0;
        agent.cachedTokens += Number.isFinite(cached) ? cached : 0;
        agent.reasoningTokens += Number.isFinite(reasoning) ? reasoning : 0;
        agent.cost += cost;

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
      }
      break;
    }

    case 'meeting.requested': {
      const participants = Array.isArray(payload.participantIds)
        ? payload.participantIds.filter((id): id is string => typeof id === 'string')
        : [];
      if (participants.length > 0) {
        requestMeeting(state, {
          id: typeof payload.meetingId === 'string' ? payload.meetingId : `meeting-${incoming.id}`,
          title: typeof payload.title === 'string' ? payload.title : 'Agent collaboration',
          topic: typeof payload.topic === 'string' ? payload.topic : incoming.summary,
          initiatorId: incoming.source.replace(/^agent:/, ''),
          participantIds: participants,
          taskId: incoming.taskId,
        });
      }
      break;
    }

    case 'meeting.ended':
    case 'meeting.cancelled': {
      if (typeof payload.meetingId === 'string') endMeeting(state, payload.meetingId);
      break;
    }
  }

  // Prepend canonical event to state event history (max 5000 items in browser state)
  state.events.unshift(incoming as ViewerEvent);
  if (state.events.length > 5000) {
    state.events.length = 5000;
  }
}
