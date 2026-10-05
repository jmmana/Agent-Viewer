import type { Agent, AgentStatus, ViewerEvent, WorkspaceZone } from '../types/agent';
import type { SimulationState } from '../engine/simulationEngine';
import { endMeeting, requestMeeting, routeAgent } from '../engine/livingOfficeEngine';

const STATUS_VALUES = new Set<AgentStatus>([
  'OFFLINE','IDLE','AVAILABLE','THINKING','READING','RESEARCHING','CODING','WRITING','TESTING',
  'USING_TOOL','WAITING','WAITING_APPROVAL','BLOCKED','DELEGATING','PHONE_CALL','WALKING',
  'IN_MEETING','COFFEE_BREAK','CHATTING','REVIEWING','DELIVERING','DONE','ERROR',
]);

export interface ExternalEventEnvelope extends ViewerEvent {
  schemaVersion?: string;
  agentId?: string;
}

export function validateExternalEvent(value: unknown): value is ExternalEventEnvelope {
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

export function applyExternalEvent(state: SimulationState, incoming: ExternalEventEnvelope): void {
  if (state.events.some((event) => event.id === incoming.id)) return;

  const agentId = incoming.agentId ?? incoming.target ?? incoming.source.replace(/^agent:/, '');
  const agent = state.agents.find((item) => item.id === agentId);
  const payload = incoming.payload ?? {};

  switch (incoming.type) {
    case 'agent.status.changed': {
      const status = payload.status;
      if (agent && typeof status === 'string' && STATUS_VALUES.has(status as AgentStatus)) {
        agent.status = status as AgentStatus;
        agent.statusText = typeof payload.statusText === 'string' ? payload.statusText : status;
        if (typeof payload.workspace === 'string') {
          routeAgent(agent, payload.workspace as WorkspaceZone);
        }
      }
      break;
    }
    case 'message.sent': {
      if (agent && typeof payload.text === 'string') {
        agent.speechBubble = {
          text: payload.text,
          targetAgentName: typeof payload.targetAgentName === 'string' ? payload.targetAgentName : undefined,
          expiresAt: Date.now() + 6000,
        };
      }
      break;
    }
    case 'tool.started': {
      if (agent) {
        agent.status = 'USING_TOOL';
        agent.currentTool = typeof payload.tool === 'string' ? payload.tool : 'external tool';
        agent.statusText = `Using ${agent.currentTool}`;
      }
      break;
    }
    case 'tool.completed':
    case 'tool.failed': {
      if (agent) {
        agent.currentTool = null;
        agent.status = incoming.type === 'tool.failed' ? 'ERROR' : 'IDLE';
        agent.statusText = incoming.type === 'tool.failed' ? 'External tool failed' : 'Tool completed';
      }
      break;
    }
    case 'llm.usage': {
      if (agent) {
        const input = Number(payload.inputTokens ?? 0);
        const output = Number(payload.outputTokens ?? 0);
        const cached = Number(payload.cachedTokens ?? 0);
        const cost = typeof payload.cost === 'number' ? payload.cost : 0;
        if (typeof payload.provider === 'string') agent.provider = payload.provider as Agent['provider'];
        if (typeof payload.model === 'string') agent.model = payload.model;
        agent.tokensInput += Number.isFinite(input) ? input : 0;
        agent.tokensOutput += Number.isFinite(output) ? output : 0;
        agent.cachedTokens += Number.isFinite(cached) ? cached : 0;
        agent.cost += Number.isFinite(cost) ? cost : 0;
        state.totalTokens.input += Number.isFinite(input) ? input : 0;
        state.totalTokens.output += Number.isFinite(output) ? output : 0;
        state.totalTokens.cached += Number.isFinite(cached) ? cached : 0;
        state.totalCost += Number.isFinite(cost) ? cost : 0;
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
    case 'meeting.ended': {
      if (typeof payload.meetingId === 'string') endMeeting(state, payload.meetingId);
      break;
    }
  }

  state.events.unshift(incoming);
}
