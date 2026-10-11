import type { AgentStatus } from '../types/agent';

/** Intención de clip Crew derivada solo del estado observado; no inventa actividad. */
export type CrewClipId = 'idle' | 'work' | 'phone' | 'walk' | 'meeting' | 'coffee' | 'talk' | 'alert' | 'offline';

export const CREW_STATUS_CLIP: Readonly<Record<AgentStatus, CrewClipId>> = {
  OFFLINE: 'offline', IDLE: 'idle', AVAILABLE: 'idle', THINKING: 'work', READING: 'work', RESEARCHING: 'work',
  CODING: 'work', WRITING: 'work', TESTING: 'work', USING_TOOL: 'work', WAITING: 'idle', WAITING_APPROVAL: 'idle',
  BLOCKED: 'alert', DELEGATING: 'talk', PHONE_CALL: 'phone', WALKING: 'walk', IN_MEETING: 'meeting',
  COFFEE_BREAK: 'coffee', CHATTING: 'talk', REVIEWING: 'work', DELIVERING: 'walk', DONE: 'idle', ERROR: 'alert',
};

/** Poses estáticas reales del banco (assets/crew/bank/characters/ceo). Ningún clip tiene cuadros animados aún. */
const STATIC_POSES: Readonly<Partial<Record<CrewClipId, string>>> = {
  idle: 'idle', work: 'work', phone: 'phone',
};

export interface CrewClipResolution {
  clip: CrewClipId;
  /** Pose estática disponible para el clip, o `idle` como sustituto honesto. */
  pose: string;
  /** Siempre false hasta que existan frames animados originales (#118/#128). */
  animated: false;
  /** true si el clip no tiene arte propio y se muestra la pose de reposo. */
  fallback: boolean;
}

export function crewClipForStatus(status: AgentStatus): CrewClipId {
  return CREW_STATUS_CLIP[status] ?? 'idle';
}

export function resolveCrewClip(status: AgentStatus): CrewClipResolution {
  const clip = crewClipForStatus(status);
  const pose = STATIC_POSES[clip];
  return { clip, pose: pose ?? 'idle', animated: false, fallback: pose === undefined };
}
