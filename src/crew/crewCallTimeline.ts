import { crewInPhoneCall } from './crewEventBridge';
import type { Agent } from '../types/agent';

/**
 * Línea de tiempo local de llamada por agente (issue #145), derivada solo del campo
 * REAL `Agent.status === 'PHONE_CALL'` (`eventIngestion.ts` lo acepta desde un evento
 * real `agent.status.changed`, no es exclusivo de la simulación de Caricatura). Nunca
 * inventa cuándo empezó la llamada en el proveedor real: `startedAt` es el instante en
 * que ESTE Crew la detectó, y la UI lo rotula así para no hacerlo pasar por un dato real
 * de telefonía. El anillo/aviso visual que consume esto es un efecto visual, nunca una
 * prueba de conectividad real.
 *
 * Cambiar de sala en Crew NUNCA borra un registro activo: este módulo recibe siempre el
 * snapshot completo de agentes (no solo los de la sala visible), así que una llamada que
 * sigue reportando PHONE_CALL permanece en el estado aunque el agente no se esté
 * dibujando en este momento.
 */
export type CrewCallPhase = 'ringing' | 'talking' | 'ending';

/** Duración local del aviso de "timbrando" antes de pasar a "hablando". No es un evento real de descolgado. */
export const CREW_CALL_RING_MS = 1500;
/** Duración local del desvanecido tras colgar, antes de limpiar el registro. */
export const CREW_CALL_ENDING_MS = 700;

export interface CrewCallRecord {
  agentId: string;
  /** Instante (ms, reloj local) en que Crew observó por primera vez el status PHONE_CALL de este agente. */
  startedAt: number;
  /** Instante (ms) en que dejó de reportar PHONE_CALL, o `null` mientras sigue activa. */
  endedAt: number | null;
  /** El usuario descartó LOCALMENTE el aviso visual; la llamada real puede seguir activa. */
  dismissed: boolean;
}

export type CrewCallTimelineState = Readonly<Record<string, CrewCallRecord>>;

type CallAgent = Pick<Agent, 'id' | 'status'>;

/**
 * Avanza el estado a partir del snapshot real de agentes y la hora actual (inyectada,
 * nunca `Date.now()` interno, para que sea determinista en pruebas). Un agente ausente
 * del snapshot (reinicio DEMO/LIVE o cambio de fuente) se purga de inmediato: no hay
 * marcador al que anclar su aviso, así que no tiene sentido conservarlo ni con
 * desvanecido. Un agente presente que deja de reportar PHONE_CALL conserva su registro
 * solo durante `CREW_CALL_ENDING_MS`, para la fase `ending` del aviso visual.
 */
export function advanceCrewCallTimeline(
  state: CrewCallTimelineState,
  agents: readonly CallAgent[],
  now: number,
): CrewCallTimelineState {
  const next: Record<string, CrewCallRecord> = {};
  for (const agent of agents) {
    const existing = state[agent.id];
    if (crewInPhoneCall(agent)) {
      next[agent.id] = existing && existing.endedAt === null
        ? existing
        : { agentId: agent.id, startedAt: now, endedAt: null, dismissed: false };
    } else if (existing && existing.endedAt === null) {
      next[agent.id] = { ...existing, endedAt: now };
    } else if (existing && existing.endedAt !== null && now - existing.endedAt < CREW_CALL_ENDING_MS) {
      next[agent.id] = existing;
    }
  }
  return next;
}

/**
 * Oculta LOCALMENTE el aviso visual de una llamada, sin pretender terminarla: Crew no
 * tiene (ni inventa) un canal de acción real sobre un proveedor de telefonía. Si la
 * llamada sigue activa, el registro permanece `dismissed` hasta que termine; una llamada
 * nueva posterior siempre empieza visible de nuevo.
 */
export function dismissCrewCall(state: CrewCallTimelineState, agentId: string): CrewCallTimelineState {
  const record = state[agentId];
  if (!record || record.dismissed) return state;
  return { ...state, [agentId]: { ...record, dismissed: true } };
}

/** Fase local del aviso: nunca mezcla datos reales de timbrado, solo tiempo transcurrido desde la detección. */
export function crewCallPhase(record: Pick<CrewCallRecord, 'startedAt' | 'endedAt'>, now: number, reducedMotion = false): CrewCallPhase {
  if (record.endedAt !== null) return 'ending';
  if (!reducedMotion && now - record.startedAt < CREW_CALL_RING_MS) return 'ringing';
  return 'talking';
}

/** Congela el cronómetro en el instante de colgar: no sigue sumando tiempo tras `endedAt`. */
export function crewCallElapsedMs(record: Pick<CrewCallRecord, 'startedAt' | 'endedAt'>, now: number): number {
  const end = record.endedAt ?? now;
  return Math.max(0, end - record.startedAt);
}

/** Opacidad del aviso completo: 1 mientras está activo, desvanece a 0 durante `ending`. */
export function crewCallOpacity(record: Pick<CrewCallRecord, 'endedAt'>, now: number): number {
  if (record.endedAt === null) return 1;
  return Math.max(0, 1 - (now - record.endedAt) / CREW_CALL_ENDING_MS);
}

/** mm:ss. No es texto de UI a traducir: es una cifra, igual que el resto de contadores de Crew. */
export function formatCrewCallElapsed(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
