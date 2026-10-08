import { describe, expect, it } from 'vitest';
import type { Agent } from '../../src/types/agent';
import {
  advanceLivingOffice,
  applyAmbientLife,
  requestMeeting,
  type AmbientOptions,
  type LivingOfficeState,
} from '../../src/engine/livingOfficeEngine';
import { socialPack } from '../../src/content/socialPacks';
import { createDemoSteps, createInitialSimulationState } from '../../src/engine/simulationEngine';
import { INITIAL_AGENTS, OFFICE_ROOMS } from '../../src/engine/officeModel';

const T0 = 1_900_000_000_000;
const OPTIONS: AmbientOptions = { enabled: true, politicsEnabled: false, idleGraceMs: 0, minIntervalMs: 1000 };

function makeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: `Agent ${id}`,
    role: 'custom',
    roleTitle: 'Agent',
    team: 'other',
    managerId: null,
    provider: 'OpenAI',
    model: 'gpt-test',
    status: 'IDLE',
    statusText: '',
    currentTaskId: null,
    currentTool: null,
    workspace: 'development',
    floor: 1,
    x: 11,
    y: 9,
    targetX: 11,
    targetY: 9,
    isWalking: false,
    facing: 'SE',
    avatarColor: '#000000',
    clothingColor: '#111111',
    hairColor: '#222222',
    accessory: 'none',
    tokensInput: 0,
    tokensOutput: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    startedAt: T0,
    speechBubble: null,
    ...overrides,
  };
}

function makeState(agents: Agent[]): LivingOfficeState {
  return {
    agents,
    meetings: [],
    events: [],
    activeMeetingId: null,
    roomReservations: [],
    socialActivities: [],
    coffeeSeatAssignments: [],
  };
}

function chatting(state: LivingOfficeState): string[] {
  return state.agents.filter((agent) => agent.socialActivityId).map((agent) => agent.id);
}

describe('simulated social life', () => {
  it('never picks agents in a meeting, walking to one or with a current task', () => {
    const state = makeState([
      makeAgent('in-meeting', { status: 'IN_MEETING' }),
      makeAgent('walking', { status: 'WALKING' }),
      makeAgent('called', { status: 'PHONE_CALL' }),
      makeAgent('busy', { currentTaskId: 'TASK-1' }),
      makeAgent('scheduled'),
      makeAgent('free-1'),
      makeAgent('free-2'),
    ]);
    // "scheduled" is still IDLE but is already expected in a meeting that has not started.
    state.meetings.push({
      id: 'm-1',
      title: 'Sync',
      topic: 'Sync',
      initiatorId: 'in-meeting',
      participants: ['in-meeting', 'scheduled'],
      status: 'SCHEDULED',
      startedAt: 0,
      tokensAccumulated: 0,
      costAccumulated: 0,
      agenda: [],
      decisions: [],
      tasksCreated: [],
      messages: [],
    });

    for (let step = 0; step < 6; step++) {
      applyAmbientLife(state, T0 + step * 1500, 'en', OPTIONS);
      for (const id of chatting(state)) expect(['free-1', 'free-2']).toContain(id);
      for (const agent of state.agents) {
        if (!agent.id.startsWith('free')) {
          expect(agent.ambientBubble ?? null).toBeNull();
          expect(agent.presentationActivity ?? null).toBeNull();
        }
      }
    }
    expect(chatting(state).sort()).toEqual(['free-1', 'free-2']);
  });

  it('clears ambient bubbles as soon as an agent is called to a meeting', () => {
    const state = makeState([makeAgent('a'), makeAgent('b'), makeAgent('c')]);
    applyAmbientLife(state, T0, 'en', OPTIONS);
    const talker = state.agents.find((agent) => agent.ambientBubble);
    expect(talker).toBeDefined();

    requestMeeting(state, { id: 'm-2', title: 'Review', topic: 'Review', initiatorId: 'c', participantIds: [talker!.id, 'c'] }, { now: T0 + 100 });
    expect(talker!.ambientBubble).toBeNull();
    expect(talker!.socialActivityId ?? null).toBeNull();
    expect(talker!.presentationActivity ?? null).toBeNull();
    expect(state.coffeeSeatAssignments.some((seat) => seat.agentId === talker!.id)).toBe(false);
  });

  it('ends the conversation for the partner too, so nobody talks to someone who left', () => {
    const state = makeState([makeAgent('a'), makeAgent('b')]);
    applyAmbientLife(state, T0, 'en', OPTIONS);
    const [first, second] = state.agents;
    expect(first.ambientBubble?.targetAgentName).toBe(second.name);

    requestMeeting(state, { id: 'm-3', title: 'Review', topic: 'Review', initiatorId: 'b', participantIds: ['b'] }, { now: T0 + 100 });
    expect(first.ambientBubble).toBeNull();
    expect(first.socialActivityId ?? null).toBeNull();
    expect(state.socialActivities).toHaveLength(0);
  });

  it('drops small talk when the status changes outside the engine (demo script, operator)', () => {
    const state = makeState([makeAgent('a'), makeAgent('b')]);
    applyAmbientLife(state, T0, 'en', OPTIONS);
    expect(state.agents.every((agent) => agent.ambientBubble)).toBe(true);

    state.agents[0].status = 'IN_MEETING';
    advanceLivingOffice(state, T0 + 200);
    expect(state.agents[0].ambientBubble).toBeNull();
    expect(state.agents[0].presentationActivity ?? null).toBeNull();
  });

  it('never runs two conversations with the same exchange at the same time', () => {
    const state = makeState(Array.from({ length: 8 }, (_, index) => makeAgent(`a${index}`)));
    const pack = socialPack('en');
    // Conversations last 10 s and a new one may start every second: up to four run together.
    for (let step = 0; step < 40; step++) {
      const now = T0 + step * 1000;
      advanceLivingOffice(state, now);
      applyAmbientLife(state, now, 'en', OPTIONS);
      const running = state.socialActivities.filter((activity) => !activity.endsAt || activity.endsAt > now);
      const firstLines = running.map((activity) => {
        const speaker = state.agents.find((agent) => agent.id === activity.participantIds[0]);
        return speaker?.ambientBubble?.text;
      }).filter(Boolean);
      expect(new Set(firstLines).size).toBe(firstLines.length);
      for (const line of firstLines) expect(pack.some((exchange) => exchange.lines[0].text === line)).toBe(true);
    }
    expect(state.socialActivities.length).toBeGreaterThan(1);
  });

  it('does not repeat the exchange that just ended', () => {
    const state = makeState([makeAgent('a'), makeAgent('b')]);
    const lines: string[] = [];
    for (let step = 0; step < 4; step++) {
      const now = T0 + step * 11_000;
      advanceLivingOffice(state, now);
      applyAmbientLife(state, now, 'es', OPTIONS);
      const line = state.agents[0].ambientBubble?.text;
      if (line) lines.push(line);
    }
    for (let i = 1; i < lines.length; i++) expect(lines[i]).not.toBe(lines[i - 1]);
  });
});

describe('demo script positions', () => {
  function roomAt(x: number, y: number): string | undefined {
    return OFFICE_ROOMS.find((room) => x >= room.gridX && x < room.gridX + room.width && y >= room.gridY && y < room.gridY + room.height)?.id;
  }

  it.each(['en', 'es'] as const)('only shows "In a meeting" for agents placed in a meeting room (%s)', (locale) => {
    const state = createInitialSimulationState(INITIAL_AGENTS, locale);
    for (const step of createDemoSteps(locale)) {
      step.execute(state);
      for (const agent of state.agents.filter((item) => item.status === 'IN_MEETING')) {
        if ((agent.floor ?? 1) === 2) {
          // On the secret floor the agent must be inside a reserved overflow room.
          expect(state.roomReservations.some((reservation) => reservation.floor === 2 && reservation.participantIds.includes(agent.id))).toBe(true);
        } else {
          expect(['meeting_room', 'meeting_room_b']).toContain(agent.workspace);
          expect(roomAt(agent.targetX, agent.targetY)).toBe(agent.workspace);
        }
      }
      // Every agent's destination is inside the room its workspace names (the lounge belongs to the break area).
      for (const agent of state.agents.filter((item) => (item.floor ?? 1) === 1)) {
        const room = roomAt(agent.targetX, agent.targetY);
        if (agent.workspace === 'break_room') expect(['break_room', 'lounge']).toContain(room);
        else expect(room).toBe(agent.workspace);
      }
    }
    // The finale ends every meeting and sends everyone back to the main floor.
    expect(state.activeMeetingId).toBeNull();
    expect(state.agents.every((agent) => (agent.floor ?? 1) === 1 && agent.status === 'IDLE')).toBe(true);
  });
});
