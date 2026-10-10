import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyExternalEvent,
  DEFAULT_BUBBLE_MS,
  type ApplyEventOptions,
} from '../../src/integrations/eventIngestion';
import { normalizeCanonicalEvent } from '../../src/integrations/canonicalTypes';
import { createLiveSimulationState, type SimulationState } from '../../src/engine/officeState';
import { WORKSPACE_ANCHORS } from '../../src/engine/livingOfficeEngine';
import type { CanonicalEvent } from '../../src/lib/index';
import {
  T0,
  llmFailed,
  llmUsage,
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

  it('never writes Meeting.tokensAccumulated/costAccumulated from llm.usage (issue #81 regression: the live ' +
    'portal must never read these as a usage figure; they stay 0 and are only ever seeded by the demo script)', () => {
    const state = officeWithMeeting();
    apply(state, [makeEvent('meeting.started', 'ana', { meetingId: 'm-1' }, { at: T0 + 30 })], {
      ...PROFESSIONAL,
      trackUsage: true,
    });
    apply(
      state,
      [llmUsage('ana', { inputTokens: 500, outputTokens: 200, cost: 0.01, meetingId: 'm-1' }, { at: T0 + 40 })],
      { ...PROFESSIONAL, trackUsage: true }
    );
    expect(state.meetings[0].tokensAccumulated).toBe(0);
    expect(state.meetings[0].costAccumulated).toBe(0);
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

describe('llm.failed', () => {
  /** A failed attempt that the provider still billed in part. */
  const billedFailure = {
    provider: 'Anthropic',
    model: 'claude-sonnet',
    errorKind: 'timeout',
    httpStatus: 504,
    inputTokens: 900,
    outputTokens: 30,
    cacheReadTokens: 400,
    cacheWriteTokens: 100,
    reasoningTokens: 10,
    cost: 0.5,
    costSource: 'provider-reported',
    currency: 'USD',
  };

  function counters(state: SimulationState, id: string) {
    const agent = agentIn(state, id);
    return {
      agent: [agent.tokensInput, agent.tokensOutput, agent.cachedTokens, agent.reasoningTokens, agent.cost],
      totals: { ...state.totalTokens },
      totalCost: state.totalCost,
      tasks: state.tasks.map((task) => [task.tokensTotal, task.costTotal]),
    };
  }

  it.each([
    ['trackUsage true', { ...PROFESSIONAL, trackUsage: true }],
    ['trackUsage false', PROFESSIONAL],
  ] as const)('updates provider and model and leaves status and counters alone with %s', (_label, options) => {
    const state = apply(createLiveSimulationState(), [
      registered('ana', 'Ana Rivas', {}, { at: T0 }),
      llmUsage('ana', { provider: 'OpenAI', model: 'gpt-x', inputTokens: 500, outputTokens: 50, cost: 0.3 }, { at: T0 + 10 }),
      statusChanged('ana', 'CODING', { at: T0 + 20 }),
    ], options);
    const before = counters(state, 'ana');
    const ana = agentIn(state, 'ana');
    const statusBefore = [ana.status, ana.statusText];

    apply(state, [
      llmFailed('ana', billedFailure, { at: T0 + 30 }),
      llmFailed('ana', { provider: 'Anthropic', model: 'claude-sonnet', errorKind: 'rate_limited' }, { at: T0 + 40 }),
    ], options);

    expect(ana.provider).toBe('Anthropic');
    expect(ana.model).toBe('claude-sonnet');
    expect([ana.status, ana.statusText]).toEqual(statusBefore);
    expect(ana.status).toBe('CODING');
    expect(counters(state, 'ana')).toEqual(before);
    expect(state.events.filter((event) => event.type === 'llm.failed')).toHaveLength(2);
  });

  it('keeps provider and model when the payload does not carry them as strings', () => {
    const state = apply(createLiveSimulationState(), [
      registered('ana', 'Ana Rivas', {}, { at: T0 }),
      llmUsage('ana', { provider: 'OpenAI', model: 'gpt-x', inputTokens: 5, outputTokens: 1 }, { at: T0 + 10 }),
      llmFailed('ana', { provider: 42, errorKind: 'unknown' }, { at: T0 + 20 }),
    ]);
    const ana = agentIn(state, 'ana');
    expect(ana.provider).toBe('OpenAI');
    expect(ana.model).toBe('gpt-x');
  });

  it('is kept as llm.failed and never rewritten to a status change', () => {
    const state = apply(createLiveSimulationState(), [
      registered('ana', 'Ana Rivas', {}, { at: T0 }),
      llmFailed('ana', { provider: 'Anthropic', model: 'claude-sonnet', errorKind: 'overloaded' }, { at: T0 + 10 }),
    ]);
    const stored = state.events.find((event) => event.type === 'llm.failed');
    expect(stored).toBeDefined();
    expect(state.events.some((event) => event.type === 'agent.status.changed')).toBe(false);
    expect(agentIn(state, 'ana').status).toBe('IDLE');
  });
});

describe('normalizeCanonicalEvent: generated ids', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses crypto.randomUUID when the platform has it', () => {
    const randomUUID = vi.fn(() => '0b9f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4');
    vi.stubGlobal('crypto', { randomUUID });
    const event = normalizeCanonicalEvent({ type: 'agent.status.changed', payload: { status: 'IDLE' } });
    expect(event.id).toBe('evt_0b9f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4');
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it('gives a UUID id with the real platform crypto', () => {
    const event = normalizeCanonicalEvent({ type: 'agent.status.changed' });
    expect(event.id).toMatch(/^evt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('falls back to the clock and Math.random when randomUUID is not available', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    for (const replacement of [undefined, {}]) {
      vi.stubGlobal('crypto', replacement);
      const event = normalizeCanonicalEvent({ type: 'agent.status.changed' });
      expect(event.id).toMatch(/^evt_1700000000000_[0-9a-z]{1,7}$/);
    }
  });

  it('keeps an id the caller gave', () => {
    const randomUUID = vi.fn(() => 'unused');
    vi.stubGlobal('crypto', { randomUUID });
    expect(normalizeCanonicalEvent({ id: 'evt_given', type: 'agent.status.changed' }).id).toBe('evt_given');
    expect(randomUUID).not.toHaveBeenCalled();
  });
});
