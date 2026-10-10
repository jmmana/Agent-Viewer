import type { Agent, Meeting, Task, TaskStatus } from '../types/agent';
import type { ViewerMode } from '../integrations/replayEngine';

/**
 * Puente de solo lectura entre el dominio (snapshot/eventos) y el estado visual de Crew (issue #155).
 * No crea eventos, no modifica el snapshot recibido y no calcula tokens ni costos: solo proyecta lo
 * que el dominio ya sabe hacia una forma que Crew puede mostrar sin inventar nada.
 */

/**
 * LIVE/DEMO/REPLAY es el mismo vocabulario que el resto de la aplicación (`ViewerMode`, en
 * `integrations/replayEngine.ts`). Crew nunca infiere este valor a partir de los datos: el host (la
 * aplicación de demostración o quien integre `AgentOffice`) debe indicarlo de forma explícita.
 */
export type CrewViewerMode = ViewerMode;

/**
 * `full`: pantalla del propio operador, puede ver el texto real de tareas y reuniones.
 * `minimized`: pantallas públicas o televisores de oficina (issue #155, "datos sensibles minimizados").
 * En este modo Crew nunca expone el título de la tarea ni el tema de la reunión, solo su categoría.
 */
export type CrewVisibility = 'full' | 'minimized';

export interface CrewAgentActivity {
  id: string;
  status: Agent['status'];
  /** Estado real de la tarea asignada, o `null` si el agente no tiene tarea actual. */
  taskStatus: TaskStatus | null;
  /** Título de la tarea. Siempre `null` en modo `minimized`, nunca inventado en modo `full`. */
  taskLabel: string | null;
  /** El agente participa en una reunión ACTIVA real del snapshot. */
  inMeeting: boolean;
  /** Tema/título de la reunión. Siempre `null` en modo `minimized`. */
  meetingLabel: string | null;
  /** Reflejo directo de `status === 'WAITING_APPROVAL'`, nunca una inferencia. */
  pendingApproval: boolean;
  /** El agente tiene una herramienta en curso (`currentTool`). Nunca expone el detalle de entrada/salida. */
  usingTool: boolean;
  /** Hubo uso de LLM acumulado. Valor booleano: Crew no formatea ni muestra tokens o costo. */
  hasUsage: boolean;
}

type ActivityAgent = Pick<Agent, 'id' | 'status' | 'currentTaskId' | 'currentTool' | 'tokensInput' | 'tokensOutput'>;

/**
 * Proyecta la actividad visual de un agente a partir del snapshot real de tareas y reuniones.
 * Determinista: la misma entrada produce siempre la misma salida, sin reloj ni aleatoriedad.
 */
export function crewAgentActivity(
  agent: ActivityAgent,
  tasks: readonly Task[],
  meetings: readonly Meeting[],
  visibility: CrewVisibility = 'full',
): CrewAgentActivity {
  const task = agent.currentTaskId ? tasks.find((item) => item.id === agent.currentTaskId) ?? null : null;
  // Solo se busca reunión si el estado del propio agente ya dice que está en una: nunca se asume
  // presencia en reunión a partir de la sala o de otra señal indirecta.
  const meeting = agent.status === 'IN_MEETING'
    ? meetings.find((item) => item.status === 'ACTIVE' && item.participants.includes(agent.id)) ?? null
    : null;

  return {
    id: agent.id,
    status: agent.status,
    taskStatus: task?.status ?? null,
    taskLabel: task && visibility === 'full' ? task.title : null,
    inMeeting: meeting !== null,
    meetingLabel: meeting && visibility === 'full' ? (meeting.topic || meeting.title) : null,
    pendingApproval: agent.status === 'WAITING_APPROVAL',
    usingTool: typeof agent.currentTool === 'string' && agent.currentTool.length > 0,
    hasUsage: (agent.tokensInput ?? 0) > 0 || (agent.tokensOutput ?? 0) > 0,
  };
}

const TASK_STATUS_LABEL: Record<TaskStatus, { es: string; en: string }> = {
  PENDING: { es: 'pendiente', en: 'pending' },
  ASSIGNED: { es: 'asignada', en: 'assigned' },
  IN_PROGRESS: { es: 'en curso', en: 'in progress' },
  BLOCKED: { es: 'bloqueada', en: 'blocked' },
  REVIEW: { es: 'en revisión', en: 'in review' },
  COMPLETED: { es: 'completada', en: 'completed' },
  FAILED: { es: 'fallida', en: 'failed' },
};

/**
 * Línea corta y bilingüe para mostrar junto al nombre del agente. Respeta la minimización ya aplicada
 * en `activity` (si `taskLabel`/`meetingLabel` son `null`, la línea usa solo la categoría, nunca el texto).
 */
export function crewActivityLine(activity: CrewAgentActivity, isEs: boolean): string {
  const parts: string[] = [];
  if (activity.pendingApproval) parts.push(isEs ? 'Espera aprobación' : 'Awaiting approval');
  if (activity.inMeeting) {
    parts.push(activity.meetingLabel
      ? (isEs ? `Reunión: ${activity.meetingLabel}` : `Meeting: ${activity.meetingLabel}`)
      : (isEs ? 'En reunión' : 'In meeting'));
  }
  if (activity.taskStatus) {
    const statusLabel = TASK_STATUS_LABEL[activity.taskStatus][isEs ? 'es' : 'en'];
    parts.push(activity.taskLabel
      ? (isEs ? `Tarea: ${activity.taskLabel} (${statusLabel})` : `Task: ${activity.taskLabel} (${statusLabel})`)
      : (isEs ? `Tarea ${statusLabel}` : `Task ${statusLabel}`));
  }
  if (activity.usingTool) parts.push(isEs ? 'Usando herramienta' : 'Using tool');
  return parts.join(' · ');
}

/**
 * Verdadero solo cuando el propio status real del agente (campo del dominio, nunca
 * inferido de la sala ni de ninguna otra señal) es `PHONE_CALL` (issue #145). Es el único
 * origen de verdad que usan la línea de tiempo local de llamada (`crewCallTimeline.ts`) y
 * la superposición visual de Crew: ninguna de las dos infiere una llamada de otra forma.
 */
export function crewInPhoneCall(agent: Pick<Agent, 'status'>): boolean {
  return agent.status === 'PHONE_CALL';
}

/** Rótulo corto para la insignia LIVE/DEMO/REPLAY que el host puede mostrar en Crew. */
export function crewViewerModeLabel(mode: CrewViewerMode, isEs: boolean): string {
  switch (mode) {
    case 'LIVE': return isEs ? 'EN VIVO' : 'LIVE';
    case 'DEMO': return 'DEMO';
    case 'REPLAY': return isEs ? 'REPRODUCCIÓN' : 'REPLAY';
  }
}
