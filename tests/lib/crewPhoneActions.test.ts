import { expect, it } from 'vitest';
import { updateCrewActorActions } from '../../src/crew/crewActorActions';
import { CREW_ROOMS } from '../../src/crew/crewModel';
import { crewActionClip } from '../../src/crew/crewActionRegistry';
import { buildOfficeSnapshot } from '../../src/lib/officeStore';
const room = CREW_ROOMS[0];
const base = Object.freeze({ ...buildOfficeSnapshot([], { now: 0, agents: [{ id: 'ceo', name: 'CEO', workspace: 'boss_office' }] }).agents[0], role: 'boss' as const, status: 'IDLE' as const, facing: 'SE' as const, isWalking: false });
const caller = Object.freeze({ ...base, status: 'PHONE_CALL' as const });
it('coge una vez, habla mientras sigue el estado y cuelga antes de reposo', () => {
  const pickup = updateCrewActorActions([caller], room, [], 0);
  expect(pickup[0]).toMatchObject({ clip: 'call-pickup', startedAt: 0 });
  const talking = updateCrewActorActions([caller], room, pickup, 800);
  expect(talking[0]).toMatchObject({ clip: 'call', startedAt: 800 });
  expect(updateCrewActorActions([caller], room, talking, 8000)[0].startedAt).toBe(800);
  const hangup = updateCrewActorActions([base], room, talking, 8100);
  expect(hangup[0]).toMatchObject({ clip: 'call-hangup', startedAt: 8100 });
  expect(updateCrewActorActions([base], room, hangup, 8899)[0].clip).toBe('call-hangup');
  const idle = updateCrewActorActions([base], room, hangup, 8900);
  expect(idle[0].clip).toBe(null);
  expect(updateCrewActorActions([base], room, idle, 9000)[0].clip).toBe(null);
  expect(caller.status).toBe('PHONE_CALL');
});
it('interrumpe al caminar, cambiar tarea/sala o desaparecer sin ordenar colgar', () => {
  const pickup = updateCrewActorActions([caller], room, [], 0);
  expect(updateCrewActorActions([{ ...caller, isWalking: true }], room, pickup, 100)[0].clip).toBe(null);
  expect(updateCrewActorActions([{ ...base, status: 'BLOCKED' }], room, pickup, 100)[0].clip).toBe(null);
  expect(updateCrewActorActions([{ ...base, status: 'REVIEWING' }], room, pickup, 100)[0].clip).toBe('review');
  expect(updateCrewActorActions([{ ...caller, workspace: 'development' }], room, pickup, 100)).toEqual([]);
  expect(updateCrewActorActions([], room, pickup, 100)).toEqual([]);
  expect(updateCrewActorActions([{ ...caller, role: 'backend_engineer' }], room, [], 0)).toEqual([]);
  const hangup = updateCrewActorActions([base], room, pickup, 100);
  expect(updateCrewActorActions([caller], room, hangup, 200)[0]).toMatchObject({ clip: 'call-pickup', startedAt: 200 });
});
it('termina levantarse antes de coger y no asigna la llamada al segundo CEO', () => {
  const typing = updateCrewActorActions([{ ...base, status: 'CODING' }], room, [], 0);
  const standing = updateCrewActorActions([caller], room, typing, 1000);
  expect(standing[0].clip).toBe('stand');
  const pickup = updateCrewActorActions([caller, { ...base, id: 'second' }], room, standing, 1800);
  expect(pickup[0].clip).toBe('call-pickup');
  expect(pickup[1].clip).toBe(null);
});
it('colgar invierte cuadros reales sin reflejar ni cambiar anclajes', () => {
  for (const facing of ['front', 'right', 'back', 'left'] as const) {
    const pickup = crewActionClip('call-pickup', facing);
    const hangup = crewActionClip('call-hangup', facing);
    expect(hangup.frames).toEqual([...pickup.frames].reverse());
    expect(hangup.loop).toBe(false);
    expect(crewActionClip('call', facing).loop).toBe(true);
  }
});
