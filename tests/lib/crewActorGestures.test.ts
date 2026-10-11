import { expect, it } from 'vitest';
import { crewReportedGesture, updateCrewActorActions } from '../../src/crew/crewActorActions';
import { CREW_ROOMS } from '../../src/crew/crewModel';
import { buildOfficeSnapshot } from '../../src/lib/officeStore';
import type { AgentStatus } from '../../src/types/agent';
const room = CREW_ROOMS[0];
const base = Object.freeze({ ...buildOfficeSnapshot([], { now: 0, agents: [{ id: 'ceo', name: 'CEO', workspace: 'boss_office' }] }).agents[0], role: 'boss' as const, facing: 'SE' as const, isWalking: false });
it('selecciona solo estados explícitos y mantiene el reloj hasta cambiar de acción', () => {
  let actors = updateCrewActorActions([{ ...base, status: 'IDLE' }], room, [], 0);
  for (const [index, status] of (['THINKING', 'CHATTING', 'REVIEWING'] as const).entries()) {
    const agent = Object.freeze({ ...base, status });
    actors = updateCrewActorActions([agent], room, actors, (index + 1) * 1000);
    expect(actors[0].clip).toBe(['think', 'talk', 'review'][index]);
    expect(actors[0].startedAt).toBe((index + 1) * 1000);
    expect(actors[0].workstation).toBeUndefined();
    expect(updateCrewActorActions([agent], room, actors, (index + 1) * 1000 + 500)[0].startedAt).toBe(actors[0].startedAt);
  }
  for (const status of ['IDLE', 'READING', 'IN_MEETING', 'WAITING', 'USING_TOOL', 'OFFLINE'] as AgentStatus[]) {
    expect(crewReportedGesture({ ...base, status })).toBe(null);
    expect(updateCrewActorActions([{ ...base, status }], room, actors, 4000)[0].clip).toBe(null);
  }
  expect(updateCrewActorActions([{ ...base, status: 'THINKING', isWalking: true }], room, actors, 4000)[0].clip).toBe(null);
  expect(updateCrewActorActions([], room, actors, 4000)).toEqual([]);
});
it('termina stand/turn antes del gesto y respeta cancelación por sala', () => {
  const coding = { ...base, status: 'CODING' as const };
  const seated = updateCrewActorActions([coding], room, [], 0);
  const agent = { ...base, status: 'REVIEWING' as const };
  const standing = updateCrewActorActions([agent], room, seated, 1000);
  expect(standing[0].clip).toBe('stand');
  const review = updateCrewActorActions([agent], room, standing, 1800);
  expect(review[0]).toMatchObject({ clip: 'review', startedAt: 1800, seated: false });
  expect(review[0].workstation).toBeUndefined();
  const turned = { ...agent, facing: 'SW' as const };
  const turning = updateCrewActorActions([turned], room, review, 2000);
  expect(turning[0].clip).toBe('turn');
  expect(updateCrewActorActions([turned], room, turning, 2800)[0].clip).toBe('review');
  expect(updateCrewActorActions([{ ...agent, workspace: 'development' }], room, review, 3000)).toEqual([]);
});
