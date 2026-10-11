import type { Agent } from '../types/agent';
import { crewObservedFacing, type CrewObservedAgent } from './crewActorActions';

/**
 * Controlador exclusivo de Crew (#128): máquina de estados independiente, pura, sin
 * dependencia de `visualMotion.ts` (el motor viejo de Caricatura). Consume solo las
 * posiciones/facing que ya existen hoy en `crewActorActions.ts` (`crewObservedFacing`),
 * nunca coordenadas ni props de la grilla 24x16 ni `OFFICE_FURNITURE` antiguo.
 *
 * Los 16/17 estados del issue son exclusivos de este controlador; no reemplazan ni
 * reutilizan `CrewClipId` (`crewClips.ts`, 9 ids de presentación legados de #117/#118) ni
 * `CrewActionId` (`crewActorActions.ts`, 4 ids de transición de escritorio). Cuando #129
 * aporte navegación real entre salas, este módulo simplemente recibirá mejores datos de
 * movimiento (`x/y/targetX/targetY/isWalking`) por el mismo contrato; su lógica de
 * prioridades y transiciones no cambia.
 */
export type CrewControllerStateId =
  | 'idle' | 'walk' | 'turn' | 'sit' | 'stand' | 'type' | 'talk' | 'phone'
  | 'think' | 'review' | 'approve' | 'blocked' | 'completed' | 'coffee'
  | 'dance' | 'stretch' | 'meeting';

/** Ancla real de posición/orientación (estación de trabajo, nunca un punto inventado). */
export interface CrewControllerAnchor {
  x: number;
  y: number;
  facing: Agent['facing'];
}

export interface CrewControllerSnapshot extends CrewObservedAgent {
  /**
   * El actor ocupa físicamente su estación ahora mismo. Lo decide quien integre el
   * controlador (hoy la asignación de silla de `crewActorActions.ts`; mañana datos reales
   * de navegación de #129). Este módulo nunca inventa esta señal.
   */
  seated: boolean;
  /** Ancla real de la estación asignada. Solo tiene efecto cuando `seated` es true. */
  workstation?: CrewControllerAnchor;
  /**
   * Gesto de ambiente de baja prioridad (idle variado) que quien integra el controlador
   * decide mostrar cuando no hay ninguna actividad real. Este módulo solo decide si se
   * respeta o se cancela ante cualquier evento real; nunca lo genera por su cuenta.
   */
  ambientHint?: 'dance' | 'stretch';
}

export interface CrewControllerState {
  id: string;
  /** Snapshot bruto recibido, para que la próxima llamada pueda comparar movimiento real. */
  observed: CrewObservedAgent;
  state: CrewControllerStateId;
  facing: Agent['facing'];
  x: number;
  y: number;
  /** true para estados que se repiten mientras el dominio los sostenga (idle/walk/meeting/...). */
  loop: boolean;
  startedAt: number;
  /**
   * Disparador que originó la entrada al estado finito actual (el `status` real, o
   * `ambient:dance`/`ambient:stretch`). Evita repetir un gesto de un solo disparo mientras
   * el mismo disparador siga vigente tras asentarse en reposo.
   */
  trigger: string;
  seated: boolean;
  workstation?: CrewControllerAnchor;
  /** Solo presente durante un giro en curso (#118/#128), origen del giro. */
  turnFrom?: Agent['facing'];
}

/** Estados que se repiten mientras el dominio los sostenga. El resto son finitos (un solo disparo). */
export const CREW_CONTROLLER_LOOP_STATES: ReadonlySet<CrewControllerStateId> = new Set([
  'idle', 'walk', 'meeting', 'type', 'talk', 'phone', 'coffee', 'blocked',
]);

/** Duración de las transiciones presenciales (sit/stand/turn), igual a CREW_ACTION_DURATION_MS. */
export const CREW_CONTROLLER_TRANSITION_MS = 800;

const ONE_SHOT_DURATION_MS: Partial<Record<CrewControllerStateId, number>> = {
  think: 1200, approve: 1200, review: 1200, completed: 1500, dance: 2000, stretch: 1600,
};

export function crewControllerIsLoop(state: CrewControllerStateId): boolean {
  return CREW_CONTROLLER_LOOP_STATES.has(state);
}

export function crewControllerStateDurationMs(state: CrewControllerStateId): number {
  if (state === 'sit' || state === 'stand' || state === 'turn') return CREW_CONTROLLER_TRANSITION_MS;
  return ONE_SHOT_DURATION_MS[state] ?? 0;
}

/** Estado activo que pide el dominio para un status real, ignorando ambiente/transiciones. */
function domainActiveState(status: Agent['status'], seated: boolean): CrewControllerStateId {
  switch (status) {
    case 'BLOCKED': case 'ERROR': return 'blocked';
    case 'PHONE_CALL': return 'phone';
    case 'IN_MEETING': return 'meeting';
    case 'WAITING_APPROVAL': return 'approve';
    case 'REVIEWING': return 'review';
    case 'DONE': return 'completed';
    case 'DELEGATING': case 'CHATTING': return 'talk';
    case 'THINKING': case 'READING': case 'RESEARCHING': return 'think';
    // Teclear exige estar realmente en la estación; si aún no llegó, piensa mientras tanto
    // en vez de inventar que ya teclea en el aire.
    case 'CODING': case 'WRITING': case 'TESTING': case 'USING_TOOL': return seated ? 'type' : 'think';
    case 'COFFEE_BREAK': return 'coffee';
    case 'WALKING': case 'DELIVERING': return 'walk';
    default: return 'idle'; // OFFLINE, IDLE, AVAILABLE, WAITING
  }
}

/**
 * Estado objetivo puro a partir solo de campos reales del snapshot (status/isWalking/seated).
 * BLOCKED/ERROR son siempre urgentes, por encima incluso del movimiento.
 */
export function crewControllerTargetState(
  snapshot: Pick<CrewControllerSnapshot, 'status' | 'isWalking' | 'seated'>,
): CrewControllerStateId {
  if (snapshot.status === 'BLOCKED' || snapshot.status === 'ERROR') return 'blocked';
  if (snapshot.isWalking) return 'walk';
  return domainActiveState(snapshot.status, snapshot.seated);
}

function stepAgent(
  before: CrewControllerState | undefined,
  snapshot: CrewControllerSnapshot,
  now: number,
  reducedMotion: boolean,
): CrewControllerState {
  const facing = crewObservedFacing(snapshot, before?.observed);
  const target = crewControllerTargetState(snapshot);
  const seatedChanged = before ? before.seated !== snapshot.seated : snapshot.seated;
  const realEventPending = seatedChanged || target !== 'idle';
  const observed: CrewObservedAgent = { ...snapshot };

  /** Resuelve posición/orientación reales para `nextState`, sin interpolar nunca un punto intermedio. */
  function resolveAnchor(nextState: CrewControllerStateId): { x: number; y: number; facing: Agent['facing']; workstation?: CrewControllerAnchor } {
    // Durante 'stand' el actor sigue físicamente en la estación aunque `seated` ya sea false:
    // se conserva el ancla previa para no saltar a la coordenada cruda a mitad de la transición.
    const carried = nextState === 'stand' ? before?.workstation : undefined;
    const workstation = snapshot.seated ? snapshot.workstation : carried;
    if (workstation) return { x: workstation.x, y: workstation.y, facing: workstation.facing, workstation };
    return { x: snapshot.x, y: snapshot.y, facing };
  }

  function build(state: CrewControllerStateId, startedAt: number, trigger: string, extra?: Partial<CrewControllerState>): CrewControllerState {
    const anchor = resolveAnchor(state);
    return {
      id: snapshot.id, observed, state, x: anchor.x, y: anchor.y, facing: anchor.facing,
      loop: CREW_CONTROLLER_LOOP_STATES.has(state), startedAt, trigger, seated: snapshot.seated,
      ...(anchor.workstation ? { workstation: anchor.workstation } : {}),
      ...extra,
    };
  }

  /** Mantiene el mismo estado/reloj (antidedupe), solo refresca observado/posición/ocupación. */
  function hold(state: CrewControllerStateId): CrewControllerState {
    const anchor = resolveAnchor(state);
    const { workstation: _drop, ...rest } = before!;
    return {
      ...rest, observed, x: anchor.x, y: anchor.y, facing: anchor.facing, seated: snapshot.seated,
      ...(anchor.workstation ? { workstation: anchor.workstation } : {}),
    };
  }

  /** Resuelve el siguiente estado "natural" (sin transición de asiento/giro pendiente). */
  function enterNatural(): CrewControllerState {
    const effective = target === 'idle' && snapshot.ambientHint ? snapshot.ambientHint : target;
    const trigger = snapshot.ambientHint && effective === snapshot.ambientHint ? `ambient:${effective}` : snapshot.status;
    if (!CREW_CONTROLLER_LOOP_STATES.has(effective)) {
      // Gesto de un solo disparo: no lo repitas si el mismo disparador ya se asentó en reposo.
      if (before && before.state === 'idle' && before.trigger === trigger) return hold('idle');
      return build(effective, now, trigger);
    }
    if (before && before.state === effective) return hold(effective);
    return build(effective, now, snapshot.status);
  }

  // --- Movimiento reducido: resolución directa al frame final/still, sin transición intermedia.
  if (reducedMotion) {
    const effective = !realEventPending && snapshot.ambientHint ? snapshot.ambientHint : target;
    const trigger = snapshot.ambientHint && effective === snapshot.ambientHint ? `ambient:${effective}` : snapshot.status;
    return build(effective, now, trigger);
  }

  // --- Urgencia (BLOCKED/ERROR): gana siempre y cancela cualquier transición en curso de inmediato.
  if (target === 'blocked') {
    if (before?.state === 'blocked' && before.trigger === snapshot.status) return hold('blocked');
    return build('blocked', now, snapshot.status);
  }

  // --- Cambio de asiento: sit/stand tiene prioridad sobre cualquier estado activo normal.
  if (seatedChanged) return build(snapshot.seated ? 'sit' : 'stand', now, snapshot.status);

  // --- Transición finita en curso (sit/stand/turn o un gesto de un solo disparo, incluido ambiente).
  const inProgress = before !== undefined && !before.loop
    && now - before.startedAt < crewControllerStateDurationMs(before.state);
  const ambientActive = before !== undefined && (before.state === 'dance' || before.state === 'stretch');
  if (inProgress && !(ambientActive && realEventPending)) return hold(before!.state);

  // --- Transición de asiento/giro recién vencida: resolver al estado activo natural.
  if (before && !before.loop && (before.state === 'sit' || before.state === 'stand' || before.state === 'turn')) {
    return enterNatural();
  }

  // --- Gesto de un solo disparo (incluido ambiente) recién vencido o cancelado.
  if (before && !before.loop) {
    const upcoming = target === 'idle' && snapshot.ambientHint ? snapshot.ambientHint : target;
    const upcomingTrigger = snapshot.ambientHint && upcoming === snapshot.ambientHint ? `ambient:${upcoming}` : snapshot.status;
    // Mismo disparador que el gesto que acaba de terminar: se asienta en reposo, no lo repite.
    if (upcomingTrigger === before.trigger) return build('idle', now, before.trigger);
    return enterNatural();
  }

  // --- Giro en el lugar: sin transición pendiente, la orientación observada cambió.
  if (!snapshot.seated && !snapshot.isWalking && before && facing !== before.facing) {
    return build('turn', now, snapshot.status, { turnFrom: before.facing });
  }

  return enterNatural();
}

/**
 * Reductor puro: el snapshot y su cámara permanecen intactos, igual que
 * `updateCrewActorActions`. Determinista: la misma entrada (`previous`, `snapshots`, `now`,
 * `reducedMotion`) produce siempre la misma salida, requisito indispensable para que un
 * REPLAY sea reproducible cuadro a cuadro.
 */
export function crewControllerStep(
  previous: readonly CrewControllerState[],
  snapshots: readonly CrewControllerSnapshot[],
  now: number,
  reducedMotion = false,
): CrewControllerState[] {
  return snapshots.slice().sort((a, b) => a.id.localeCompare(b.id)).map(snapshot => {
    const before = previous.find(item => item.id === snapshot.id && item.observed.workspace === snapshot.workspace);
    return stepAgent(before, snapshot, now, reducedMotion);
  });
}
