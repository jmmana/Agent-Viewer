import { describe, expect, it } from 'vitest';
import {
  advanceCrewCallTimeline,
  crewCallElapsedMs,
  crewCallOpacity,
  crewCallPhase,
  CREW_CALL_ENDING_MS,
  CREW_CALL_RING_MS,
  dismissCrewCall,
  formatCrewCallElapsed,
  type CrewCallTimelineState,
} from '../../src/crew/crewCallTimeline';

const agent = (id: string, status: string) => ({ id, status: status as never });

describe('Línea de tiempo local de llamada Crew (#145)', () => {
  it('sin ningún agente en PHONE_CALL, no crea ningún registro', () => {
    const state = advanceCrewCallTimeline({}, [agent('a', 'CODING'), agent('b', 'IDLE')], 1000);
    expect(state).toEqual({});
  });

  it('un agente real en PHONE_CALL crea un registro activo con startedAt = ahora', () => {
    const state = advanceCrewCallTimeline({}, [agent('ceo', 'PHONE_CALL')], 1000);
    expect(state.ceo).toEqual({ agentId: 'ceo', startedAt: 1000, endedAt: null, dismissed: false });
  });

  it('seguir en PHONE_CALL conserva el mismo registro (no reinicia startedAt en cada avance)', () => {
    let state: CrewCallTimelineState = advanceCrewCallTimeline({}, [agent('ceo', 'PHONE_CALL')], 1000);
    state = advanceCrewCallTimeline(state, [agent('ceo', 'PHONE_CALL')], 5000);
    expect(state.ceo.startedAt).toBe(1000);
    expect(state.ceo.endedAt).toBeNull();
  });

  it('dejar de reportar PHONE_CALL marca endedAt pero conserva el registro durante el desvanecido', () => {
    let state: CrewCallTimelineState = advanceCrewCallTimeline({}, [agent('ceo', 'PHONE_CALL')], 1000);
    state = advanceCrewCallTimeline(state, [agent('ceo', 'IDLE')], 1200);
    expect(state.ceo.endedAt).toBe(1200);
    // Dentro de la ventana de desvanecido, el registro sigue presente.
    state = advanceCrewCallTimeline(state, [agent('ceo', 'IDLE')], 1200 + CREW_CALL_ENDING_MS - 1);
    expect(state.ceo).toBeDefined();
    // Pasada la ventana, se purga.
    state = advanceCrewCallTimeline(state, [agent('ceo', 'IDLE')], 1200 + CREW_CALL_ENDING_MS + 1);
    expect(state.ceo).toBeUndefined();
  });

  it('una llamada nueva tras una anterior terminada empieza de nuevo, no visible como dismissed', () => {
    let state: CrewCallTimelineState = advanceCrewCallTimeline({}, [agent('ceo', 'PHONE_CALL')], 0);
    state = dismissCrewCall(state, 'ceo');
    expect(state.ceo.dismissed).toBe(true);
    state = advanceCrewCallTimeline(state, [agent('ceo', 'IDLE')], 100);
    state = advanceCrewCallTimeline(state, [agent('ceo', 'IDLE')], 100 + CREW_CALL_ENDING_MS + 1);
    expect(state.ceo).toBeUndefined();
    state = advanceCrewCallTimeline(state, [agent('ceo', 'PHONE_CALL')], 2000);
    expect(state.ceo).toEqual({ agentId: 'ceo', startedAt: 2000, endedAt: null, dismissed: false });
  });

  it('un agente que desaparece por completo del snapshot (reinicio DEMO/LIVE) se purga de inmediato, sin desvanecido', () => {
    let state: CrewCallTimelineState = advanceCrewCallTimeline({}, [agent('ceo', 'PHONE_CALL')], 0);
    state = advanceCrewCallTimeline(state, [], 10);
    expect(state).toEqual({});
  });

  it('dismissCrewCall oculta localmente sin tocar otros registros ni inventar que terminó la llamada', () => {
    const state = advanceCrewCallTimeline({}, [agent('a', 'PHONE_CALL'), agent('b', 'PHONE_CALL')], 0);
    const dismissed = dismissCrewCall(state, 'a');
    expect(dismissed.a.dismissed).toBe(true);
    expect(dismissed.a.endedAt).toBeNull();
    expect(dismissed.b.dismissed).toBe(false);
    // Es un no-op si ya estaba descartado o no existe.
    expect(dismissCrewCall(dismissed, 'a')).toBe(dismissed);
    expect(dismissCrewCall(dismissed, 'no-existe')).toBe(dismissed);
  });

  it('crewCallPhase pasa de ringing a talking tras CREW_CALL_RING_MS, y a ending tras colgar', () => {
    const record = { startedAt: 1000, endedAt: null as number | null };
    expect(crewCallPhase(record, 1000)).toBe('ringing');
    expect(crewCallPhase(record, 1000 + CREW_CALL_RING_MS - 1)).toBe('ringing');
    expect(crewCallPhase(record, 1000 + CREW_CALL_RING_MS)).toBe('talking');
    expect(crewCallPhase({ ...record, endedAt: 2000 }, 2000)).toBe('ending');
  });

  it('reducedMotion salta directo a talking, nunca pasa por ringing', () => {
    const record = { startedAt: 1000, endedAt: null as number | null };
    expect(crewCallPhase(record, 1000, true)).toBe('talking');
  });

  it('crewCallElapsedMs congela el cronómetro en el instante de colgar', () => {
    const active = { startedAt: 1000, endedAt: null as number | null };
    expect(crewCallElapsedMs(active, 4000)).toBe(3000);
    const ended = { startedAt: 1000, endedAt: 4000 };
    expect(crewCallElapsedMs(ended, 9000)).toBe(3000);
  });

  it('crewCallOpacity es 1 mientras está activa y desvanece a 0 durante CREW_CALL_ENDING_MS', () => {
    expect(crewCallOpacity({ endedAt: null }, 1000)).toBe(1);
    expect(crewCallOpacity({ endedAt: 1000 }, 1000)).toBe(1);
    expect(crewCallOpacity({ endedAt: 1000 }, 1000 + CREW_CALL_ENDING_MS / 2)).toBeCloseTo(0.5);
    expect(crewCallOpacity({ endedAt: 1000 }, 1000 + CREW_CALL_ENDING_MS * 2)).toBe(0);
  });

  it('formatCrewCallElapsed da mm:ss sin depender de locale', () => {
    expect(formatCrewCallElapsed(0)).toBe('0:00');
    expect(formatCrewCallElapsed(5000)).toBe('0:05');
    expect(formatCrewCallElapsed(65000)).toBe('1:05');
    expect(formatCrewCallElapsed(-50)).toBe('0:00');
  });
});
