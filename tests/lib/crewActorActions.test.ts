import { describe, expect, it } from 'vitest';
import { crewFacingFromDelta, crewObservedFacing, updateCrewActorActions, crewActionMarkers } from '../../src/crew/crewActorActions';
import { CREW_ROOMS } from '../../src/crew/crewModel';
import { crewActionClip, crewTurnClip, CREW_ACTION_CLIPS } from '../../src/crew/crewActionRegistry';
import { validateCrewClip, crewClipSample } from '../../src/crew/crewAnimation';
import { crewSpriteView } from '../../src/crew/crewSprites';
import { buildOfficeSnapshot } from '../../src/lib/officeStore';
const room = CREW_ROOMS[0];
const base = Object.freeze({ ...buildOfficeSnapshot([], { now: 0, agents: [{ id: 'ceo', name: 'CEO', workspace: 'boss_office' }] }).agents[0], role: 'boss' as const, status: 'IDLE' as const, facing: 'SE' as const, isWalking: false, x: 0, y: 0, targetX: 0, targetY: 0 });
describe('acciones CEO desde snapshots', () => {
  it('prioriza desplazamiento observado, luego destino de tránsito y orientación reportada', () => {
    const moving = { ...base, isWalking: true, x: -2, targetY: 5 };
    expect(crewObservedFacing(moving, base)).toBe('NW');
    expect(crewObservedFacing({ ...base, isWalking: true, targetY: -3 })).toBe('NE');
    expect(crewObservedFacing({ ...base, targetY: -3 })).toBe('SE');
    expect(crewFacingFromDelta(NaN, 0)).toBeUndefined();
    expect(crewFacingFromDelta(0, 0)).toBeUndefined();
    const first = updateCrewActorActions([moving], room, updateCrewActorActions([base], room, [], 0), 20);
    expect(updateCrewActorActions([moving], room, first, 40)[0].facing).toBe('NW');
  });
  it('sienta ante escritorio real, teclea, se levanta y cancela al caminar', () => {
    const coding = Object.freeze({ ...base, status: 'CODING' as const });
    const seated = updateCrewActorActions([coding], room, [], 0);
    expect(seated[0]).toMatchObject({ clip: 'sit', facing: 'NE', seated: true, workstation: { chairId: 'ceo-chair' } });
    const typing = updateCrewActorActions([coding], room, seated, 800);
    expect(typing[0].clip).toBe('typing');
    const stand = updateCrewActorActions([base], room, typing, 1100);
    expect(stand[0]).toMatchObject({ clip: 'stand', facing: 'NE', seated: false });
    expect(updateCrewActorActions([base], room, stand, 1900)[0].clip).toBe(null);
    expect(updateCrewActorActions([{ ...base, isWalking: true }], room, typing, 1100)[0]).toMatchObject({ clip: null });
    expect(base.status).toBe('IDLE'); expect(coding.status).toBe('CODING');
  });
  it('no inventa typing para otros estados/roles/salas ni comparte silla', () => {
    expect(updateCrewActorActions([{ ...base, status: 'THINKING' }], room, [], 0)[0].clip).toBe(null);
    expect(updateCrewActorActions([{ ...base, workspace: 'development' }], room, [], 0)).toEqual([]);
    expect(updateCrewActorActions([{ ...base, role: 'backend_engineer' }], room, [], 0)).toEqual([]);
    const actors = updateCrewActorActions([{ ...base, status: 'CODING' }, { ...base, id: 'other', status: 'WRITING' }], room, [], 0);
    expect(actors.filter(actor => actor.seated)).toHaveLength(1);
  });
  it('conserva múltiples orientaciones por actor y giros desde su origen', () => {
    const previous = updateCrewActorActions([base], room, [], 0);
    const next = updateCrewActorActions([{ ...base, facing: 'NW' }, { ...base, id: 'b', facing: 'SW' }], room, previous, 100);
    expect(next.find(actor => actor.id === base.id)).toMatchObject({ turnFrom: 'SE', facing: 'NW', clip: 'turn' });
    const markers = crewActionMarkers(next.map((actor, i) => ({ id: actor.id, name: actor.id, status: 'IDLE', number: i, x: 1, y: 1, role: 'boss' })), next);
    expect(new Set(markers.map(marker => crewSpriteView(marker, 'front'))).size).toBe(2);
  });
});
describe('atlas originales de escritorio', () => {
  it('declara 16 clips y 64 cuadros RGBA medidos con cuatro orientaciones', () => {
    expect(CREW_ACTION_CLIPS).toHaveLength(16);
    for (const clip of CREW_ACTION_CLIPS) {
      expect(validateCrewClip(clip)).toBe(true); expect(clip.frames).toHaveLength(4);
      expect(clip.loop).toBe(clip.clip === 'typing'); expect(clip.status).toBe('prototype');
      expect(crewClipSample(clip, 250, true)).toEqual({ index: 0, nextInMs: null });
    }
  });
  it('gira en ambos sentidos y encadena 180 grados sin espejado', () => {
    const forward = crewTurnClip('front', 'right');
    const reverse = crewTurnClip('right', 'front');
    expect(reverse.frames.map(frame => frame.x)).toEqual([...forward.frames].reverse().map(frame => frame.x));
    expect(crewTurnClip('front', 'back').frames).toHaveLength(8);
    expect(crewClipSample(crewActionClip('sit', 'front'), 800).nextInMs).toBe(null);
    expect(crewClipSample(crewActionClip('typing', 'left'), 650).index).toBe(0);
  });
});
