import { describe, expect, it } from 'vitest';
import {
  applyExternalEvent,
  DEFAULT_BUBBLE_MS,
  type ApplyEventOptions,
} from '../../src/integrations/eventIngestion';
import { createLiveSimulationState, type SimulationState } from '../../src/engine/officeState';
import { WORKSPACE_ANCHORS } from '../../src/engine/livingOfficeEngine';
import type { CanonicalEvent } from '../../src/lib/index';
import {
  T0,
  makeEvent,
  meetingMessage,
  meetingRequested,
  messageSent,
  registered,
  statusChanged,
} from './fixtures';

const NOW = 1_900_000_000_000;

/** The options the embedded office uses in professional mode. */
const PROFESSIONAL: ApplyEventOptions = { now: NOW, narrate: false, overflowFloor: false, trackUsage: false };

function apply(state: SimulationState, events: CanonicalEvent[], options: ApplyEventOptions = PROFESSIONAL) {
  for (const event of events) applyExternalEvent(state, event, options);
  return state;
}

function agentIn(state: SimulationState, id: string) {
  const found = state.agents.find((item) => item.id === id);
  if (!found) throw new Error(`Agent ${id} is not in the state`);
  return found;
}

/** Ana and Bruno at their desks with a scheduled meeting `m-1`. */
function officeWithMeeting(): SimulationState {
  return apply(createLiveSimulationState(), [
    registered('ana', 'Ana Rivas', { roleTitle: 'Planner', workspace: 'leads_area' }, { at: T0 }),
    registered('bruno', 'Bruno Díaz', { roleTitle: 'Engineer', workspace: 'development' }, { at: T0 + 10 }),
    meetingRequested('ana', 'm-1', ['ana', 'bruno'], { at: T0 + 20 }),
  ]);
}

describe('meeting.message', () => {
  it('gives the speaker a bubble with the message kind and appends it to the meeting', () => {
    const state = officeWithMeeting();
    const event = meetingMessage('bruno', 'm-1', 'The cache key leaks the tenant id.', 'objection', { at: T0 + 30 });
    apply(state, [event]);

    const bruno = agentIn(state, 'bruno');
    expect(bruno.speechBubble).toMatchObject({ text: 'The cache key leaks the tenant id.', kind: 'objection' });
    const meeting = state.meetings.find((item) => item.id === 'm-1')!;
    expect(meeting.messages).toEqual([
      { id: event.id, senderId: 'bruno', text: 'The cache key leaks the tenant id.', timestamp: T0 + 30, type: 'objection' },
    ]);
  });

  it('falls back to "statement" for an unknown type', () => {
    const state = officeWithMeeting();
    apply(state, [meetingMessage('ana', 'm-1', 'Let us move on.', 'monologue', { at: T0 + 30 })]);

    expect(agentIn(state, 'ana').speechBubble?.kind).toBe('statement');
    expect(state.meetings[0].messages[0].type).toBe('statement');
  });

  it('records decisions on the meeting', () => {
    const state = officeWithMeeting();
    apply(state, [meetingMessage('ana', 'm-1', 'We ship on Thursday.', 'decision', { at: T0 + 30 })]);
    expect(state.meetings[0].decisions).toEqual(['We ship on Thursday.']);
  });

  it('uses the active meeting when the message has no meetingId', () => {
    const state = officeWithMeeting();
    apply(state, [
      makeEvent('meeting.started', 'ana', { meetingId: 'm-1' }, { at: T0 + 30 }),
      makeEvent('meeting.message', 'bruno', { text: 'Agreed.', type: 'agreement' }, { at: T0 + 40 }),
    ]);
    expect(state.meetings[0].messages.map((message) => [message.senderId, message.type])).toEqual([['bruno', 'agreement']]);
  });
});

describe('agent.message.sent', () => {
  it('sets the bubble kind and the target name', () => {
    const state = officeWithMeeting();
    apply(state, [messageSent('ana', 'Split the job in two queues.', { kind: 'proposal', targetAgentId: 'bruno' }, { at: T0 + 30 })]);

    expect(agentIn(state, 'ana').speechBubble).toMatchObject({
      text: 'Split the job in two queues.',
      kind: 'proposal',
      targetAgentName: 'Bruno Díaz',
    });
  });

  it('leaves the kind empty when it is missing or unknown', () => {
    const state = officeWithMeeting();
    apply(state, [
      messageSent('ana', 'No kind here.', {}, { at: T0 + 30 }),
      messageSent('bruno', 'Odd kind here.', { kind: 'rant' }, { at: T0 + 40 }),
    ]);
    expect(agentIn(state, 'ana').speechBubble?.kind).toBeUndefined();
    expect(agentIn(state, 'bruno').speechBubble?.kind).toBeUndefined();
  });

  it('ignores a message without text', () => {
    const state = officeWithMeeting();
    apply(state, [makeEvent('agent.message.sent', 'ana', { kind: 'proposal' }, { at: T0 + 30 })]);
    expect(agentIn(state, 'ana').speechBubble).toBeNull();
  });
});

describe('meeting lifecycle', () => {
  it('marks the meeting ACTIVE and its participants IN_MEETING on meeting.started', () => {
    const state = officeWithMeeting();
    expect(state.meetings[0].status).toBe('SCHEDULED');

    apply(state, [makeEvent('meeting.started', 'ana', { meetingId: 'm-1' }, { at: T0 + 30 })]);

    expect(state.meetings[0]).toMatchObject({ status: 'ACTIVE', startedAt: NOW });
    expect(state.activeMeetingId).toBe('m-1');
    expect(agentIn(state, 'ana').status).toBe('IN_MEETING');
    expect(agentIn(state, 'bruno').status).toBe('IN_MEETING');
    expect(state.roomReservations.find((item) => item.meetingId === 'm-1')?.status).toBe('ACTIVE');
  });

  it('creates and starts a meeting it did not know about', () => {
    const state = apply(createLiveSimulationState(), [
      registered('ana', 'Ana Rivas', {}, { at: T0 }),
      registered('bruno', 'Bruno Díaz', {}, { at: T0 }),
      makeEvent('meeting.started', 'ana', { meetingId: 'm-9', participantIds: ['ana', 'bruno'] }, { at: T0 + 10 }),
    ]);
    expect(state.meetings.map((meeting) => [meeting.id, meeting.status])).toEqual([['m-9', 'ACTIVE']]);
    expect(state.agents.every((item) => item.status === 'IN_MEETING')).toBe(true);
    expect(state.agents.every((item) => item.speechBubble === null)).toBe(true);
  });

  it('frees the participants on meeting.ended', () => {
    const state = officeWithMeeting();
    apply(state, [
      makeEvent('meeting.started', 'ana', { meetingId: 'm-1' }, { at: T0 + 30 }),
      makeEvent('meeting.ended', 'ana', { meetingId: 'm-1' }, { at: T0 + 40 }),
    ]);

    expect(state.meetings[0]).toMatchObject({ status: 'CONCLUDED', endedAt: NOW });
    expect(state.activeMeetingId).toBeNull();
    expect(state.roomReservations).toEqual([]);
    const ana = agentIn(state, 'ana');
    const bruno = agentIn(state, 'bruno');
    expect([ana.status, bruno.status]).toEqual(['IDLE', 'IDLE']);
    // They head back to their own rooms.
    expect(ana.workspace).toBe('leads_area');
    expect(bruno.workspace).toBe('development');
    expect([ana.floor, bruno.floor]).toEqual([1, 1]);
  });

  it('frees the participants on meeting.cancelled', () => {
    const state = officeWithMeeting();
    apply(state, [makeEvent('meeting.cancelled', 'ana', { meetingId: 'm-1' }, { at: T0 + 30 })]);
    expect(state.meetings[0].status).toBe('CONCLUDED');
    expect(state.agents.map((item) => item.status)).toEqual(['IDLE', 'IDLE']);
  });
});

describe('agent.registered and workspaces', () => {
  it('spawns the agent at its workspace without walking', () => {
    const state = apply(createLiveSimulationState(), [
      registered('qa', 'Gina Lara', { roleTitle: 'Tester', workspace: 'qa_lab' }, { at: T0 }),
    ]);
    const qa = agentIn(state, 'qa');
    expect({ x: qa.x, y: qa.y }).toEqual(WORKSPACE_ANCHORS.qa_lab);
    expect({ x: qa.targetX, y: qa.targetY }).toEqual(WORKSPACE_ANCHORS.qa_lab);
    expect(qa.isWalking).toBe(false);
    expect(qa.workspace).toBe('qa_lab');
    expect(qa.homeWorkspace).toBe('qa_lab');
    expect(qa.name).toBe('Gina Lara');
    expect(qa.roleTitle).toBe('Tester');
  });

  it('walks an already known agent to the new workspace on agent.updated', () => {
    const state = apply(createLiveSimulationState(), [
      registered('qa', 'Gina Lara', { workspace: 'qa_lab' }, { at: T0 }),
      makeEvent('agent.updated', 'qa', { workspace: 'research_area' }, { at: T0 + 10 }),
    ]);
    const qa = agentIn(state, 'qa');
    expect(qa.workspace).toBe('research_area');
    expect(qa.isWalking).toBe(true);
    expect({ x: qa.targetX, y: qa.targetY }).toEqual(WORKSPACE_ANCHORS.research_area);
  });

  it.each(['rooftop_garden', 'toString', '__proto__', 'constructor', 42, null])(
    'ignores the invalid workspace %s without throwing',
    (workspace) => {
      const state = createLiveSimulationState();
      expect(() =>
        apply(state, [
          makeEvent('agent.registered', 'odd', { name: 'Odd Agent', workspace }, { at: T0 }),
          makeEvent('agent.status.changed', 'odd', { status: 'CODING', workspace }, { at: T0 + 10 }),
          makeEvent('agent.updated', 'odd', { workspace }, { at: T0 + 20 }),
        ]),
      ).not.toThrow();

      const odd = agentIn(state, 'odd');
      expect(odd.workspace).toBe('development');
      expect(odd.homeWorkspace).toBeUndefined();
      expect(odd.isWalking).toBe(false);
      expect(odd.status).toBe('CODING');
    },
  );

  it('ignores an unknown status', () => {
    const state = apply(createLiveSimulationState(), [
      registered('ana', 'Ana Rivas', {}, { at: T0 }),
      statusChanged('ana', 'DAYDREAMING', { at: T0 + 10 }),
    ]);
    expect(agentIn(state, 'ana').status).toBe('IDLE');
  });
});

describe('idempotency and clock', () => {
  it('applies an event id only once', () => {
    const state = officeWithMeeting();
    const message = meetingMessage('ana', 'm-1', 'Sent twice by a retry.', 'summary', { id: 'evt-dup', at: T0 + 30 });
    apply(state, [message, { ...message }, { ...message, payload: { ...message.payload, text: 'Changed on retry.' } }]);

    expect(state.meetings[0].messages.map((item) => item.text)).toEqual(['Sent twice by a retry.']);
    expect(state.events.filter((item) => item.id === 'evt-dup')).toHaveLength(1);
    expect(agentIn(state, 'ana').speechBubble?.text).toBe('Sent twice by a retry.');
  });

  it('sets the bubble expiry from the injected clock and bubbleMs', () => {
    const state = officeWithMeeting();
    apply(state, [messageSent('ana', 'Short bubble.', {}, { at: T0 + 30 })], { ...PROFESSIONAL, now: 5_000_000, bubbleMs: 4_000 });
    apply(state, [messageSent('bruno', 'Default bubble.', {}, { at: T0 + 40 })], { ...PROFESSIONAL, now: 7_000_000, bubbleMs: undefined });

    expect(agentIn(state, 'ana').speechBubble?.expiresAt).toBe(5_004_000);
    expect(agentIn(state, 'bruno').speechBubble?.expiresAt).toBe(7_000_000 + DEFAULT_BUBBLE_MS);
  });

  it('does not add usage to the agents when trackUsage is false', () => {
    const state = apply(createLiveSimulationState(), [
      registered('ana', 'Ana Rivas', {}, { at: T0 }),
      makeEvent('llm.usage', 'ana', { provider: 'OpenAI', model: 'gpt-x', inputTokens: 500, outputTokens: 50, cost: 0.3 }, { at: T0 + 10 }),
    ]);
    const ana = agentIn(state, 'ana');
    expect([ana.tokensInput, ana.tokensOutput, ana.cost]).toEqual([0, 0, 0]);
    expect(state.totalCost).toBe(0);
    expect(ana.model).toBe('gpt-x');
  });
});

describe('applyExternalEvent: agents named by a runtime', () => {
  it('registers an agent from an explicit agentId even when the source is a runtime', () => {
    const state = createLiveSimulationState();
    applyExternalEvent(state, {
      ...statusChanged('carla', 'THINKING', { at: T0 }),
      source: 'runtime:aqa',
    }, PROFESSIONAL);
    expect(agentIn(state, 'carla').status).toBe('THINKING');
  });

  it('does not invent an agent for the runtime itself', () => {
    const state = createLiveSimulationState();
    applyExternalEvent(state, {
      ...makeEvent('runtime.heartbeat', 'ignored', {}, { at: T0 }),
      agentId: undefined,
      source: 'runtime:aqa',
    }, PROFESSIONAL);
    expect(state.agents).toHaveLength(0);
  });
});

describe('applyExternalEvent: return after a meeting', () => {
  it('walks an agent without a home desk back to where it was before the meeting', () => {
    const state = apply(createLiveSimulationState(), [
      registered('ana', 'Ana Rivas', {}, { at: T0 }),
      registered('bruno', 'Bruno Díaz', {}, { at: T0 + 10 }),
      statusChanged('ana', 'IDLE', { at: T0 + 20 }),
    ]);
    const before = agentIn(state, 'ana').workspace;
    apply(state, [
      meetingRequested('ana', 'm-1', ['ana', 'bruno'], { at: T0 + 100 }),
      makeEvent('meeting.ended', 'ana', { meetingId: 'm-1' }, { at: T0 + 200 }),
    ]);
    expect(agentIn(state, 'ana').workspace).toBe(before);
    expect(agentIn(state, 'ana').workspace).not.toBe('break_room');
  });
});
