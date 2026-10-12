import { admitCrewAlert, crewAlertKindFromAgentStatus, type CrewAlertCooldownState, type CrewAlertInstance, type CrewAlertKind } from './crewAlertBridge';
import type { Agent } from '../types/agent';

/**
 * Cablea el puente de datos puro de alertas (#153, `crewAlertBridge.ts`) al snapshot real
 * de agentes de `CrewStage`, con el mismo patrón funcional e inyección de reloj que
 * `crewCallTimeline.ts` (#145): sin `Date.now()` interno, determinista (misma entrada +
 * mismo `state` + mismo `now` siempre produce el mismo resultado, requisito del issue
 * "replay produce el mismo orden") y con estabilidad referencial para que un valor por
 * defecto literal `agents = []` nunca dispare un bucle de renderización.
 *
 * Derivación deliberadamente acotada: `CrewStage` solo recibe `agents`/`tasks`/`meetings`
 * (el mismo snapshot de solo lectura de #155), nunca un flujo de eventos crudo, así que
 * esta capa de wiring únicamente puede usar `crewAlertKindFromAgentStatus` (ya cubre
 * `waiting`, `tool.running`, `blocked`, `error`, `approval.requested`, `task.done` desde
 * el campo real `Agent.status`). `approval.approved`, `approval.rejected`, `connectivity`
 * e `incident` quedan sin derivar aquí a propósito: `crewAlertKindFromEventType` exige un
 * `EventType` real que este componente no recibe, y `approval.rejected`/`incident` ni
 * siquiera tienen hoy un `EventType` real en `types/agent.ts` (hallazgo ya documentado en
 * `docs/crew/IMPLEMENTATION-STATUS.md` para #153). Quedan disponibles para que un host que
 * sí reciba el evento real los emita directo con `crewAlertInstance`/`admitCrewAlert`.
 *
 * Las alertas se admiten en una TRANSICIÓN de estado, no en cada tic: un agente que
 * permanece `BLOCKED` muchos segundos no vuelve a admitirse en cada renderización, solo
 * la primera vez que pasa a `blocked` (sujeto al cooldown/dedupe real de
 * `admitCrewAlert`), y permanece visible exactamente su `duration` del catálogo, aunque
 * el status siga igual después. Esto mantiene el aviso como una notificación breve
 * ("animaciones breves sin flash ni saturación", issue #153) en vez de una insignia de
 * estado persistente; el status literal del agente ya se muestra aparte como texto en
 * `CrewStage.tsx`.
 */

export interface CrewAlertActiveRecord {
  instance: CrewAlertInstance;
  /** Instante (ms, reloj inyectado) en que esta alerta se admitió y empezó a mostrarse. */
  shownAt: number;
}

export type CrewAlertActiveState = Readonly<Record<string, CrewAlertActiveRecord>>;

export interface CrewAlertTimelineState {
  cooldown: CrewAlertCooldownState;
  /** Alerta activa por `agentId`; un agente ausente del snapshot se purga de inmediato. */
  active: CrewAlertActiveState;
  /** Último `CrewAlertKind` derivado por agente, para detectar transiciones reales. */
  lastKind: Readonly<Record<string, CrewAlertKind | null>>;
}

export const EMPTY_CREW_ALERT_TIMELINE: CrewAlertTimelineState = { cooldown: {}, active: {}, lastKind: {} };

type AlertAgent = Pick<Agent, 'id' | 'status'>;

/**
 * Avanza el estado a partir del snapshot real de agentes y la hora actual (inyectada).
 * Un agente ausente del snapshot (reinicio DEMO/LIVE, cambio de fuente) se purga de
 * inmediato, igual que `advanceCrewCallTimeline`: no hay marcador al que anclar su aviso.
 */
export function advanceCrewAlertTimeline(
  state: CrewAlertTimelineState,
  agents: readonly AlertAgent[],
  now: number,
): CrewAlertTimelineState {
  let cooldown = state.cooldown;
  const active: Record<string, CrewAlertActiveRecord> = {};
  const lastKind: Record<string, CrewAlertKind | null> = {};
  for (const agent of agents) {
    const kind = crewAlertKindFromAgentStatus(agent.status);
    const previousKind = state.lastKind[agent.id] ?? null;
    lastKind[agent.id] = kind;
    const existing = state.active[agent.id];
    if (kind && kind !== previousKind) {
      const admission = admitCrewAlert(cooldown, { agentId: agent.id, kind }, now);
      cooldown = admission.state;
      if (admission.admitted) {
        active[agent.id] = { instance: admission.admitted, shownAt: now };
        continue;
      }
    }
    if (existing && now - existing.shownAt < existing.instance.duration) {
      active[agent.id] = existing;
    }
  }
  const activeKeys = Object.keys(active);
  const stateActiveKeys = Object.keys(state.active);
  const sameActive = activeKeys.length === stateActiveKeys.length
    && activeKeys.every(key => active[key] === state.active[key]);
  const lastKindKeys = Object.keys(lastKind);
  const stateLastKindKeys = Object.keys(state.lastKind);
  const sameLastKind = lastKindKeys.length === stateLastKindKeys.length
    && lastKindKeys.every(key => lastKind[key] === state.lastKind[key]);
  if (cooldown === state.cooldown && sameActive && sameLastKind) return state;
  return { cooldown, active, lastKind };
}

/** Breve desvanecido de entrada; el de salida es un poco mas largo para no cortar en seco. */
const CREW_ALERT_FADE_IN_MS = 180;
const CREW_ALERT_FADE_OUT_MS = 420;

/**
 * Opacidad 0..1 pura según el tiempo transcurrido desde que se admitió la alerta
 * (`shownAt`). Sin reloj interno ni temporizador propio, igual que `crewCallOpacity`.
 * Con movimiento reducido no hay transición: la alerta aparece a opacidad completa y
 * desaparece de golpe al cumplirse `duration`, nunca un desvanecido ni un pulso
 * ("prefers-reduced-motion debe desactivar la animación y conservar el estado visible
 * como texto", issue #153); el texto equivalente vive en `CrewStage.tsx` sin depender de
 * esta opacidad.
 */
export function crewAlertOpacity(elapsedMs: number, duration: number, reducedMotion = false): number {
  const clamped = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  if (duration <= 0 || clamped >= duration) return 0;
  if (reducedMotion) return 1;
  if (clamped < CREW_ALERT_FADE_IN_MS) return clamped / CREW_ALERT_FADE_IN_MS;
  const remaining = duration - clamped;
  if (remaining < CREW_ALERT_FADE_OUT_MS) return Math.max(0, remaining / CREW_ALERT_FADE_OUT_MS);
  return 1;
}
