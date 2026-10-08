import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reserveMeetingRoom,
  requestMeeting,
  advanceLivingOffice,
  endMeeting,
  activeOverflowReservations,
} from '../src/engine/livingOfficeEngine.ts';
import { aggregateModelUsage } from '../src/engine/modelOps.ts';
import { t } from '../src/i18n.ts';

function agent(id, role = 'custom') {
  return {
    id,
    name: id,
    role,
    roleTitle: 'Agent',
    team: 'other',
    managerId: null,
    provider: 'OpenAI',
    model: 'gpt-test',
    status: 'IDLE',
    statusText: 'Idle',
    currentTaskId: null,
    currentTool: null,
    workspace: 'break_room',
    floor: 1,
    x: 12,
    y: 14,
    targetX: 12,
    targetY: 14,
    isWalking: false,
    facing: 'SE',
    avatarColor: '#000',
    clothingColor: '#111',
    hairColor: '#222',
    accessory: 'none',
    tokensInput: 0,
    tokensOutput: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    startedAt: Date.now(),
    speechBubble: null,
  };
}

function state(agentCount = 12) {
  return {
    agents: Array.from({ length: agentCount }, (_, i) => agent('a' + (i + 1))),
    meetings: [],
    events: [],
    activeMeetingId: null,
    roomReservations: [],
    socialActivities: [],
  };
}

test('meeting scheduler uses A, B, Director, then elastic secret-floor rooms', () => {
  const s = state(12);
  const r1 = reserveMeetingRoom(s, 'm1', ['a1', 'a2']);
  const r2 = reserveMeetingRoom(s, 'm2', ['a3', 'a4']);
  const r3 = reserveMeetingRoom(s, 'm3', ['a5', 'a6']);
  const r4 = reserveMeetingRoom(s, 'm4', ['a7', 'a8']);
  const r5 = reserveMeetingRoom(s, 'm5', ['a9', 'a10']);
  assert.equal(r1.roomId, 'meeting_room');
  assert.equal(r2.roomId, 'meeting_room_b');
  assert.equal(r3.roomId, 'boss_office');
  assert.equal(r4.floor, 2);
  assert.equal(r4.roomId, 'overflow_meeting_1');
  assert.equal(r5.roomId, 'overflow_meeting_2');
  assert.equal(activeOverflowReservations(s).length, 2);
});

test('overflow meeting routes agents through secret floor and activates after arrival', () => {
  const s = state(8);
  reserveMeetingRoom(s, 'busy-a', ['a1']);
  reserveMeetingRoom(s, 'busy-b', ['a2']);
  reserveMeetingRoom(s, 'busy-c', ['a3']);
  const meeting = requestMeeting(s, {
    id: 'overflow',
    title: 'Overflow sync',
    topic: 'Keep work moving',
    initiatorId: 'a4',
    participantIds: ['a4', 'a5'],
  });
  assert.equal(meeting.roomId, 'overflow_meeting_1');
  assert.equal(s.agents.find(a => a.id === 'a4').workspace, 'overflow_floor');
  const future = Date.now() + 10000;
  advanceLivingOffice(s, future);
  assert.equal(s.agents.find(a => a.id === 'a4').floor, 2);
  assert.equal(s.meetings.find(m => m.id === 'overflow').status, 'ACTIVE');
});

test('ending overflow meeting releases room and returns agents to main floor', () => {
  const s = state(8);
  reserveMeetingRoom(s, 'busy-a', ['a1']);
  reserveMeetingRoom(s, 'busy-b', ['a2']);
  reserveMeetingRoom(s, 'busy-c', ['a3']);
  requestMeeting(s, {
    id: 'overflow',
    title: 'Overflow sync',
    topic: 'Keep work moving',
    initiatorId: 'a4',
    participantIds: ['a4', 'a5'],
  });
  advanceLivingOffice(s, Date.now() + 10000);
  endMeeting(s, 'overflow');
  assert.equal(s.roomReservations.some(r => r.meetingId === 'overflow'), false);
  assert.equal(s.agents.find(a => a.id === 'a4').floor, 1);
});

test('model ops aggregates usage by provider and model', () => {
  const a = agent('a1');
  const b = agent('a2');
  a.tokensInput = 100;
  a.tokensOutput = 50;
  a.cost = 1;
  b.tokensInput = 200;
  b.tokensOutput = 25;
  b.cost = 2;
  const providers = aggregateModelUsage([a, b]);
  assert.equal(providers[0].provider, 'OpenAI');
  assert.equal(providers[0].totalTokens, 375);
  assert.equal(providers[0].cost, 3);
  assert.equal(providers[0].activeAgents, 2);
});

test('i18n has English and Spanish room labels', () => {
  assert.equal(t('en', 'rooms.meeting_room_b'), 'MEETING ROOM B');
  assert.equal(t('es', 'rooms.meeting_room_b'), 'SALA DE REUNIÓN B');
});

test('ambient life preserves authoritative agent.status as IDLE over 60 seconds of simulation', async () => {
  const { applyAmbientLife } = await import('../src/engine/livingOfficeEngine.ts');
  const s = state(4);
  for (const a of s.agents) {
    a.status = 'IDLE';
    a.currentTaskId = null;
    a.floor = 1;
  }

  const start = Date.now();
  // Simulate 60 seconds in steps of 2 seconds
  for (let sec = 0; sec <= 60; sec += 2) {
    applyAmbientLife(s, start + sec * 1000, 'en', {
      enabled: true,
      politicsEnabled: false,
      idleGraceMs: 5000,
      minIntervalMs: 10000,
    });
    advanceLivingOffice(s, start + sec * 1000);
  }

  // Authoritative work status must remain IDLE
  for (const a of s.agents) {
    assert.equal(a.status, 'IDLE');
  }
});

test('clean live mode starts with exactly 0 agents and 0 tokens', async () => {
  const { createLiveSimulationState } = await import('../src/engine/simulationEngine.ts');
  const liveState = createLiveSimulationState();

  assert.equal(liveState.agents.length, 0);
  assert.equal(liveState.totalTokens.input, 0);
  assert.equal(liveState.totalTokens.output, 0);
  assert.equal(liveState.totalTokens.cached, 0);
  assert.equal(liveState.totalTokens.reasoning, 0);
  assert.equal(liveState.totalCost, 0);
});
