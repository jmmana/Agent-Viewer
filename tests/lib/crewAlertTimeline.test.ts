import { describe, expect, it } from 'vitest';
import {
  advanceCrewAlertTimeline,
  crewAlertOpacity,
  EMPTY_CREW_ALERT_TIMELINE,
  type CrewAlertTimelineState,
} from '../../src/crew/crewAlertTimeline';
import { crewAlertDescriptor } from '../../src/crew/crewAlertBridge';

const agent = (id: string, status: string) => ({ id, status: status as never });

describe('Línea de tiempo local de alertas Crew (#153, wiring de crewAlertBridge)', () => {
  it('sin ningún agente en un status mapeado, no admite ninguna alerta', () => {
    const state = advanceCrewAlertTimeline(EMPTY_CREW_ALERT_TIMELINE, [agent('a', 'CODING'), agent('b', 'IDLE')], 1000);
    expect(state.active).toEqual({});
  });

  it('estabilidad referencial: un avance sin cambios reales nunca produce un objeto nuevo', () => {
    // Snapshot vacío: el valor por defecto literal `agents = []` de `CrewStage` crea un
    // arreglo nuevo en cada renderización, pero sin ningún agente real nada cambia, así
    // que debe devolver EXACTAMENTE la misma referencia de estado (mismo patrón que
    // `advanceCrewCallTimeline`, evita un bucle infinito de `useEffect`/`setState`).
    expect(advanceCrewAlertTimeline(EMPTY_CREW_ALERT_TIMELINE, [], 1000)).toBe(EMPTY_CREW_ALERT_TIMELINE);

    // Una vez que el estado ya refleja un agente con un status SIN alerta mapeada, repetir
    // ese mismo status en avances posteriores tampoco produce un objeto nuevo.
    const settled = advanceCrewAlertTimeline(EMPTY_CREW_ALERT_TIMELINE, [agent('a', 'CODING')], 1000);
    const again = advanceCrewAlertTimeline(settled, [agent('a', 'CODING')], 2000);
    expect(again).toBe(settled);
  });

  it('un agente que transiciona a un status mapeado admite una alerta nueva de inmediato', () => {
    const state = advanceCrewAlertTimeline(EMPTY_CREW_ALERT_TIMELINE, [agent('ceo', 'BLOCKED')], 1000);
    expect(state.active.ceo).toBeDefined();
    expect(state.active.ceo.instance.kind).toBe('blocked');
    expect(state.active.ceo.shownAt).toBe(1000);
  });

  it('un status sin alerta mapeada (p. ej. disponible o en reunión) nunca admite nada', () => {
    const state = advanceCrewAlertTimeline(EMPTY_CREW_ALERT_TIMELINE, [agent('ceo', 'AVAILABLE')], 1000);
    expect(state.active).toEqual({});
    expect(state.lastKind.ceo).toBeNull();
  });

  it('permanecer en el MISMO status (sin transición) no vuelve a admitir en cada avance', () => {
    let state: CrewAlertTimelineState = advanceCrewAlertTimeline(EMPTY_CREW_ALERT_TIMELINE, [agent('ceo', 'BLOCKED')], 0);
    const firstShownAt = state.active.ceo.shownAt;
    state = advanceCrewAlertTimeline(state, [agent('ceo', 'BLOCKED')], 1000);
    expect(state.active.ceo.shownAt).toBe(firstShownAt);
  });

  it('la alerta se retira del estado activo exactamente al cumplirse su `duration` del catálogo', () => {
    const duration = crewAlertDescriptor('blocked').duration;
    let state: CrewAlertTimelineState = advanceCrewAlertTimeline(EMPTY_CREW_ALERT_TIMELINE, [agent('ceo', 'BLOCKED')], 0);
    state = advanceCrewAlertTimeline(state, [agent('ceo', 'BLOCKED')], duration - 1);
    expect(state.active.ceo).toBeDefined();
    state = advanceCrewAlertTimeline(state, [agent('ceo', 'BLOCKED')], duration);
    expect(state.active.ceo).toBeUndefined();
  });

  it('un agente ausente del snapshot (reinicio DEMO/LIVE) se purga de inmediato, incluso con la alerta todavía dentro de su duration', () => {
    let state: CrewAlertTimelineState = advanceCrewAlertTimeline(EMPTY_CREW_ALERT_TIMELINE, [agent('ceo', 'BLOCKED')], 0);
    state = advanceCrewAlertTimeline(state, [], 10);
    expect(state.active).toEqual({});
  });

  it('una nueva transición al mismo kind dentro de la ventana de cooldown NO se admite (dedupe real)', () => {
    const cooldown = crewAlertDescriptor('blocked').cooldown;
    const duration = crewAlertDescriptor('blocked').duration;
    let state: CrewAlertTimelineState = advanceCrewAlertTimeline(EMPTY_CREW_ALERT_TIMELINE, [agent('ceo', 'BLOCKED')], 0);
    // La alerta se apaga sola tras `duration`, pero el status real sigue cambiando: primero
    // se aleja del kind (transición real) y luego regresa a él, todavía dentro del cooldown.
    state = advanceCrewAlertTimeline(state, [agent('ceo', 'AVAILABLE')], duration + 1);
    expect(state.active.ceo).toBeUndefined();
    state = advanceCrewAlertTimeline(state, [agent('ceo', 'BLOCKED')], duration + 2);
    expect(state.active.ceo).toBeUndefined(); // bloqueado por cooldown, todavía no expiró

    // Pasado el cooldown completo desde la primera admisión (t=0), una transición real
    // vuelve a admitirse.
    state = advanceCrewAlertTimeline(state, [agent('ceo', 'AVAILABLE')], cooldown + 1);
    state = advanceCrewAlertTimeline(state, [agent('ceo', 'BLOCKED')], cooldown + 2);
    expect(state.active.ceo).toBeDefined();
    expect(state.active.ceo.shownAt).toBe(cooldown + 2);
  });

  it('dos agentes distintos admiten alertas independientes al mismo tiempo', () => {
    const state = advanceCrewAlertTimeline(EMPTY_CREW_ALERT_TIMELINE,
      [agent('dev', 'BLOCKED'), agent('qa', 'WAITING_APPROVAL')], 500);
    expect(state.active.dev.instance.kind).toBe('blocked');
    expect(state.active.qa.instance.kind).toBe('approval.requested');
  });
});

describe('Opacidad pura de la alerta Crew (crewAlertOpacity, sin flash ni reloj interno)', () => {
  it('con movimiento normal, se desvanece de entrada y de salida dentro de `duration`', () => {
    expect(crewAlertOpacity(0, 1000)).toBe(0);
    expect(crewAlertOpacity(90, 1000)).toBeCloseTo(0.5, 1);
    expect(crewAlertOpacity(500, 1000)).toBe(1);
    expect(crewAlertOpacity(999, 1000)).toBeGreaterThan(0);
    expect(crewAlertOpacity(999, 1000)).toBeLessThan(1);
  });

  it('a partir de `duration`, la opacidad es 0 (la alerta ya terminó)', () => {
    expect(crewAlertOpacity(1000, 1000)).toBe(0);
    expect(crewAlertOpacity(5000, 1000)).toBe(0);
  });

  it('con movimiento reducido, no hay transición: opacidad completa durante toda `duration`, luego corta a 0', () => {
    expect(crewAlertOpacity(0, 1000, true)).toBe(1);
    expect(crewAlertOpacity(500, 1000, true)).toBe(1);
    expect(crewAlertOpacity(999, 1000, true)).toBe(1);
    expect(crewAlertOpacity(1000, 1000, true)).toBe(0);
  });

  it('entradas no finitas o negativas de tiempo transcurrido se tratan como cero, nunca revientan', () => {
    expect(crewAlertOpacity(Number.NaN, 1000)).toBe(0);
    expect(crewAlertOpacity(-50, 1000)).toBe(0);
    expect(crewAlertOpacity(10, 0)).toBe(0);
  });
});
