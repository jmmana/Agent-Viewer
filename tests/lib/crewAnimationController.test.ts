import { describe, expect, it } from 'vitest';
import {
  crewControllerStep,
  crewControllerTargetState,
  crewControllerIsLoop,
  crewControllerStateDurationMs,
  CREW_CONTROLLER_LOOP_STATES,
  type CrewControllerSnapshot,
  type CrewControllerState,
} from '../../src/crew/crewAnimationController';
import { crewObservedFacing, crewWorkstations } from '../../src/crew/crewActorActions';
import { CREW_ROOMS } from '../../src/crew/crewModel';
import { buildOfficeSnapshot } from '../../src/lib/officeStore';

const room = CREW_ROOMS[0]; // ceo
const station = crewWorkstations(room)[0]; // ceo-desk / ceo-chair, anclaje real ya existente, no inventado aquí.

const baseAgent = buildOfficeSnapshot([], { now: 0, agents: [{ id: 'ceo', name: 'CEO', workspace: 'boss_office' }] }).agents[0];

/** Snapshot base reutilizable: cada prueba solo sobreescribe lo que le importa. */
const base: CrewControllerSnapshot = Object.freeze({
  ...baseAgent,
  role: 'boss' as const,
  status: 'IDLE' as const,
  facing: 'SE' as const,
  isWalking: false,
  x: 0, y: 0, targetX: 0, targetY: 0,
  seated: false,
});

function step(previous: readonly CrewControllerState[], snapshots: readonly CrewControllerSnapshot[], now: number, reducedMotion = false) {
  return crewControllerStep(previous, snapshots, now, reducedMotion);
}

describe('mapeo de estado objetivo (16 estados exclusivos de Crew)', () => {
  it('deriva cada estado solo de campos reales del snapshot, nunca inventados', () => {
    expect(crewControllerTargetState({ status: 'BLOCKED', isWalking: false, seated: false })).toBe('blocked');
    expect(crewControllerTargetState({ status: 'ERROR', isWalking: false, seated: true })).toBe('blocked');
    expect(crewControllerTargetState({ status: 'IDLE', isWalking: true, seated: false })).toBe('walk');
    expect(crewControllerTargetState({ status: 'PHONE_CALL', isWalking: false, seated: false })).toBe('phone');
    expect(crewControllerTargetState({ status: 'IN_MEETING', isWalking: false, seated: false })).toBe('meeting');
    expect(crewControllerTargetState({ status: 'WAITING_APPROVAL', isWalking: false, seated: false })).toBe('approve');
    expect(crewControllerTargetState({ status: 'REVIEWING', isWalking: false, seated: false })).toBe('review');
    expect(crewControllerTargetState({ status: 'DONE', isWalking: false, seated: false })).toBe('completed');
    expect(crewControllerTargetState({ status: 'DELEGATING', isWalking: false, seated: false })).toBe('talk');
    expect(crewControllerTargetState({ status: 'CHATTING', isWalking: false, seated: false })).toBe('talk');
    expect(crewControllerTargetState({ status: 'THINKING', isWalking: false, seated: false })).toBe('think');
    expect(crewControllerTargetState({ status: 'CODING', isWalking: false, seated: true })).toBe('type');
    expect(crewControllerTargetState({ status: 'CODING', isWalking: false, seated: false })).toBe('think');
    expect(crewControllerTargetState({ status: 'COFFEE_BREAK', isWalking: false, seated: false })).toBe('coffee');
    expect(crewControllerTargetState({ status: 'DELIVERING', isWalking: false, seated: false })).toBe('walk');
    expect(crewControllerTargetState({ status: 'AVAILABLE', isWalking: false, seated: false })).toBe('idle');
    expect(crewControllerTargetState({ status: 'OFFLINE', isWalking: false, seated: false })).toBe('idle');
  });
  it('clasifica correctamente qué estados son loop y cuáles finitos', () => {
    for (const loopState of ['idle', 'walk', 'meeting', 'type', 'talk', 'phone', 'coffee', 'blocked'] as const) {
      expect(crewControllerIsLoop(loopState)).toBe(true);
      expect(CREW_CONTROLLER_LOOP_STATES.has(loopState)).toBe(true);
    }
    for (const finiteState of ['turn', 'sit', 'stand', 'think', 'review', 'approve', 'completed', 'dance', 'stretch'] as const) {
      expect(crewControllerIsLoop(finiteState)).toBe(false);
      expect(crewControllerStateDurationMs(finiteState)).toBeGreaterThan(0);
    }
  });
});

describe('secuencia transitiva caminar -> sentarse -> teclear -> alarma -> levantarse', () => {
  it('termina siempre en una pose válida registrada, sin foot sliding', () => {
    // 1. Caminando hacia el escritorio real (loop).
    const walking: CrewControllerSnapshot = { ...base, status: 'AVAILABLE', isWalking: true, x: 0, y: 0, targetX: 5, targetY: 5, facing: 'SE' };
    const s1 = step([], [walking], 0);
    expect(s1[0]).toMatchObject({ state: 'walk', loop: true, x: 0, y: 0, seated: false });

    // 2. Llega y se sienta: CODING + seated, con el anclaje REAL de la estación (no inventado).
    const seatedCoding: CrewControllerSnapshot = {
      ...base, status: 'CODING', isWalking: false, x: 5, y: 5, targetX: 5, targetY: 5,
      facing: station.facing, seated: true, workstation: { x: station.x, y: station.y, facing: station.facing },
    };
    const s2 = step(s1, [seatedCoding], 500);
    expect(s2[0]).toMatchObject({ state: 'sit', loop: false, x: station.x, y: station.y, facing: station.facing, seated: true });

    // Snapshot repetido a mitad de la transición: anti-dedupe, no reinicia el reloj.
    const s2b = step(s2, [seatedCoding], 900);
    expect(s2b[0]).toMatchObject({ state: 'sit', startedAt: s2[0].startedAt, x: station.x, y: station.y });

    // 3. Termina de sentarse (>= 800ms) y empieza a teclear (loop), sin moverse del anclaje.
    const s3 = step(s2b, [seatedCoding], 1300);
    expect(s3[0]).toMatchObject({ state: 'type', loop: true, x: station.x, y: station.y, seated: true });

    // Sigue tecleando: el loop se repite, no reinicia.
    const s3b = step(s3, [seatedCoding], 1800);
    expect(s3b[0]).toMatchObject({ state: 'type', startedAt: s3[0].startedAt });

    // 4. Alarma: evento urgente BLOCKED interrumpe de inmediato el teclear, sin moverlo del escritorio.
    const blocked: CrewControllerSnapshot = { ...seatedCoding, status: 'BLOCKED' };
    const s4 = step(s3b, [blocked], 2000);
    expect(s4[0]).toMatchObject({ state: 'blocked', loop: true, x: station.x, y: station.y, seated: true });

    // La alarma persiste: se repite sin reiniciar (dedupe de un estado loop urgente).
    const s4b = step(s4, [blocked], 2500);
    expect(s4b[0]).toMatchObject({ state: 'blocked', startedAt: s4[0].startedAt });

    // 5. Pasa la alarma: deja de estar sentado (se levanta). Mientras dura 'stand', conserva el
    // anclaje de la estación (no salta a la coordenada cruda), evitando "foot sliding".
    const standingUp: CrewControllerSnapshot = {
      ...base, status: 'AVAILABLE', isWalking: false, x: 5, y: 5, targetX: 5, targetY: 5,
      facing: station.facing, seated: false,
    };
    const s5 = step(s4b, [standingUp], 3000);
    expect(s5[0]).toMatchObject({ state: 'stand', loop: false, x: station.x, y: station.y, seated: false });

    const s5b = step(s5, [standingUp], 3500);
    expect(s5b[0]).toMatchObject({ state: 'stand', startedAt: s5[0].startedAt, x: station.x, y: station.y });

    // 6. Termina de levantarse: ahora sí usa la posición cruda real del agente (su propio anclaje
    // registrado), nunca un punto intermedio inventado entre la silla y esa posición.
    const s6 = step(s5b, [standingUp], 3900);
    expect(s6[0]).toMatchObject({ state: 'idle', loop: true, x: standingUp.x, y: standingUp.y, seated: false });
    expect(s6[0].workstation).toBeUndefined();
  });
});

describe('cancelación de ambiente de baja prioridad', () => {
  it('un evento urgente cancela limpiamente un clip de ambiente en curso, sin estado colgado', () => {
    const idleSnapshot: CrewControllerSnapshot = { ...base, status: 'IDLE', ambientHint: 'stretch' };
    const s1 = step([], [idleSnapshot], 0);
    expect(s1[0]).toMatchObject({ state: 'stretch', loop: false, seated: false });

    const alarm: CrewControllerSnapshot = { ...base, status: 'BLOCKED' };
    const s2 = step(s1, [alarm], 200); // bien dentro de la duración de 'stretch'
    expect(s2[0]).toMatchObject({ state: 'blocked', loop: true, startedAt: 200 });
    expect(s2[0]).not.toHaveProperty('turnFrom');
  });

  it('un evento real no urgente también cancela un ambiente en curso, sin esperar a que termine', () => {
    const idleSnapshot: CrewControllerSnapshot = { ...base, status: 'IDLE', ambientHint: 'dance' };
    const s1 = step([], [idleSnapshot], 0);
    expect(s1[0]).toMatchObject({ state: 'dance', loop: false });

    const phoneRings: CrewControllerSnapshot = { ...base, status: 'PHONE_CALL' };
    const s2 = step(s1, [phoneRings], 300); // dentro de la duración del baile
    expect(s2[0]).toMatchObject({ state: 'phone', loop: true, startedAt: 300 });
  });

  it('sin evento real pendiente, el ambiente simplemente corre su curso y vuelve a reposo', () => {
    const idleSnapshot: CrewControllerSnapshot = { ...base, status: 'IDLE', ambientHint: 'dance' };
    const s1 = step([], [idleSnapshot], 0);
    const midway = step(s1, [idleSnapshot], 500); // sigue bailando, antidedupe
    expect(midway[0]).toMatchObject({ state: 'dance', startedAt: 0 });
    const finished = step(midway, [idleSnapshot], 2100); // ya pasó la duración de 'dance'
    expect(finished[0]).toMatchObject({ state: 'idle', loop: true });
  });
});

describe('loops vs estados finitos', () => {
  it('los estados loop (idle/walk/meeting) se repiten sin reiniciar su reloj', () => {
    const meeting: CrewControllerSnapshot = { ...base, status: 'IN_MEETING' };
    const s1 = step([], [meeting], 0);
    expect(s1[0]).toMatchObject({ state: 'meeting', loop: true, startedAt: 0 });
    const s2 = step(s1, [meeting], 10_000);
    expect(s2[0]).toMatchObject({ state: 'meeting', startedAt: 0 });

    const idleSnapshot: CrewControllerSnapshot = { ...base, status: 'IDLE' };
    const i1 = step([], [idleSnapshot], 0);
    expect(i1[0]).toMatchObject({ state: 'idle', loop: true });
    const i2 = step(i1, [idleSnapshot], 5000);
    expect(i2[0]).toMatchObject({ state: 'idle', startedAt: i1[0].startedAt });
  });

  it('los estados finitos (sit/think/approve) terminan en un estado de reposo válido tras N ms, nunca se quedan atascados', () => {
    const approving: CrewControllerSnapshot = { ...base, status: 'WAITING_APPROVAL' };
    const s1 = step([], [approving], 0);
    expect(s1[0]).toMatchObject({ state: 'approve', loop: false });
    const duration = crewControllerStateDurationMs('approve');

    const midway = step(s1, [approving], duration - 50);
    expect(midway[0]).toMatchObject({ state: 'approve', startedAt: 0 }); // sigue en curso, no reinicia

    const settled = step(midway, [approving], duration + 10);
    expect(settled[0]).toMatchObject({ state: 'idle', loop: true });

    // El mismo status que ya se resolvió a reposo no vuelve a disparar el gesto de inmediato.
    const stillSettled = step(settled, [approving], duration + 5000);
    expect(stillSettled[0]).toMatchObject({ state: 'idle', startedAt: settled[0].startedAt });

    const thinking: CrewControllerSnapshot = { ...base, status: 'THINKING' };
    const t1 = step([], [thinking], 0);
    expect(t1[0]).toMatchObject({ state: 'think', loop: false });
    const thinkDuration = crewControllerStateDurationMs('think');
    const t2 = step(t1, [thinking], thinkDuration + 10);
    expect(t2[0]).toMatchObject({ state: 'idle', loop: true });
  });
});

describe('preferencia de movimiento reducido', () => {
  it('devuelve directamente el frame final/still, sin trayectoria intermedia (mismo patrón que useCrewBlink)', () => {
    const seatedCoding: CrewControllerSnapshot = {
      ...base, status: 'CODING', isWalking: false, x: 5, y: 5, seated: true,
      workstation: { x: station.x, y: station.y, facing: station.facing },
    };
    const result = step([], [seatedCoding], 0, true);
    // Sin reduced motion habría pasado primero por 'sit'; con reduced motion va directo a 'type'.
    expect(result[0]).toMatchObject({ state: 'type', x: station.x, y: station.y });

    const walking: CrewControllerSnapshot = { ...base, status: 'AVAILABLE', isWalking: true, targetX: 3, targetY: 0 };
    const walkResult = step([], [walking], 0, true);
    expect(walkResult[0]).toMatchObject({ state: 'walk' });

    const ambient: CrewControllerSnapshot = { ...base, status: 'IDLE', ambientHint: 'dance' };
    const ambientResult = step([], [ambient], 0, true);
    // Un gesto ambiente nunca se antepone en reduced motion: no hay "trayectoria" que mostrar.
    expect(ambientResult[0]).toMatchObject({ state: 'dance' });
  });
});

describe('determinismo (necesario para que REPLAY sea reproducible)', () => {
  it('mismo snapshot de entrada y mismo timestamp producen el mismo clip/pose', () => {
    const snapshot: CrewControllerSnapshot = { ...base, status: 'CODING', isWalking: false, seated: true,
      workstation: { x: station.x, y: station.y, facing: station.facing } };
    const previous = step([], [{ ...base, status: 'AVAILABLE', isWalking: true, targetX: 5, targetY: 5 }], 0);
    const resultA = step(previous, [snapshot], 500);
    const resultB = step(previous, [snapshot], 500);
    expect(resultA).toEqual(resultB);
  });

  it('nunca inventa un gesto ambiente sin que se lo pidan explícitamente', () => {
    const idleSnapshot: CrewControllerSnapshot = { ...base, status: 'IDLE' };
    const s1 = step([], [idleSnapshot], 0);
    const s2 = step(s1, [idleSnapshot], 999_999); // mucho tiempo en reposo, sin ambientHint
    expect(s2[0]).toMatchObject({ state: 'idle' });
  });
});

describe('anti-dedupe explícito', () => {
  it('snapshots repetidos con el mismo estado no reinician a la mitad una transición finita en curso', () => {
    const turning1: CrewControllerSnapshot = { ...base, status: 'IDLE', facing: 'SE' };
    const s1 = step([], [turning1], 0);
    const turning2: CrewControllerSnapshot = { ...base, status: 'IDLE', facing: 'NW' };
    const s2 = step(s1, [turning2], 100);
    expect(s2[0]).toMatchObject({ state: 'turn', facing: 'NW', turnFrom: 'SE', startedAt: 100 });

    // El mismo snapshot ('NW') llega dos veces más mientras el giro sigue en curso: no reinicia.
    const s3 = step(s2, [turning2], 150);
    expect(s3[0]).toMatchObject({ state: 'turn', startedAt: 100, turnFrom: 'SE' });
    const s4 = step(s3, [turning2], 400);
    expect(s4[0]).toMatchObject({ state: 'turn', startedAt: 100 });
  });
});

describe('facing coherente con la cámara, reutilizando crewObservedFacing', () => {
  it('nunca produce un placeholder o espejo: coincide exactamente con crewObservedFacing', () => {
    const moving: CrewControllerSnapshot = { ...base, status: 'AVAILABLE', isWalking: true, x: -2, y: 0, targetX: 0, targetY: 5, facing: 'SE' };
    const expected = crewObservedFacing(moving, undefined);
    const result = step([], [moving], 0);
    expect(result[0].facing).toBe(expected);
  });

  it('mientras está sentado, usa el anclaje real de la silla (no el facing observado en bruto)', () => {
    const seatedCoding: CrewControllerSnapshot = {
      ...base, status: 'CODING', isWalking: false, facing: 'SW', seated: true,
      workstation: { x: station.x, y: station.y, facing: station.facing },
    };
    const result = step([], [seatedCoding], 0);
    expect(result[0].facing).toBe(station.facing);
  });
});
