/**
 * Texts written by the living office engine (room labels, status texts, narrated bubbles and event summaries),
 * in English and Spanish. The engine picks the catalog by language: `es-CO` uses Spanish, anything else
 * English. Placeholders use `{name}` and are replaced by `formatMessage`.
 */
import { formatMessage, type OfficeMessageParams } from './officeMessages';

const EN = {
  'room.meeting_room': 'Meeting Room A',
  'room.meeting_room_b': 'Meeting Room B',
  'room.boss_office': 'Director Suite',
  'room.overflow': 'Secret Room {number}',

  'status.callUpstairs': 'Call received: meet upstairs in {room}',
  'status.callRoom': 'Call received: meeting in {room}',
  'status.inMeeting': 'In meeting: {title}',
  'status.returnedFromSecretFloor': 'Returned from the secret collaboration floor',
  'status.availableAfterMeeting': 'Available after the meeting',
  'status.enteredSecretRoom': 'Entered {room} on the secret floor',
  'status.arrived': 'Arrived for the scheduled collaboration',
  'status.taskCompleted': 'Task completed',
  'status.taskFailed': 'Task failed',
  'status.blocked': 'Blocked',
  'status.toolWithInput': 'Tool: {tool} ({input})',
  'status.usingTool': 'Using {tool}',
  'status.toolFinishedWith': 'Tool finished: {output}',
  'status.toolFinished': 'Tool execution finished',
  'status.toolFailedWith': 'Tool failed: {error}',
  'status.toolFailed': 'Tool execution failed',
  'task.executionFailed': 'Execution failed',
  'task.waitingOnDependency': 'Waiting on a dependency',

  'bubble.initiatorUpstairs': 'Visible rooms are full. Meet me upstairs through the secret door.',
  'bubble.initiatorRoom': 'We need to sync. Meet me in the room.',
  'bubble.guestUpstairs': 'Got it. Heading to the secret floor.',
  'bubble.guestRoom': 'Got it. I am heading there.',

  'event.roomReserved': '{room} reserved for {meeting}.',
  'event.meetingRequested': 'Meeting requested: {title}.',
  'event.phoneCall': 'Phone call started with {name}.',
  'event.meetingStarted': 'Meeting started: {title}.',
  'event.meetingEnded': 'Meeting ended: {title}.',
  'event.socialStarted': 'Simulated ambient conversation started: {topic}.',

  'topic.jokes': 'jokes',
  'topic.sports': 'sports',
  'topic.technology': 'technology',
  'topic.entertainment': 'entertainment',
  'topic.current_events': 'current events',
  'topic.office_banter': 'office banter',
  'topic.politics': 'politics',
} as const satisfies Record<string, string>;

export type LivingOfficeMessageKey = keyof typeof EN;

const ES: Record<LivingOfficeMessageKey, string> = {
  'room.meeting_room': 'Sala de reunión A',
  'room.meeting_room_b': 'Sala de reunión B',
  'room.boss_office': 'Dirección',
  'room.overflow': 'Sala secreta {number}',

  'status.callUpstairs': 'Llamada recibida: reunión arriba en {room}',
  'status.callRoom': 'Llamada recibida: reunión en {room}',
  'status.inMeeting': 'En reunión: {title}',
  'status.returnedFromSecretFloor': 'De vuelta del piso secreto de colaboración',
  'status.availableAfterMeeting': 'Disponible después de la reunión',
  'status.enteredSecretRoom': 'Entró a {room} en el piso secreto',
  'status.arrived': 'Llegó a la colaboración programada',
  'status.taskCompleted': 'Tarea completada',
  'status.taskFailed': 'Tarea fallida',
  'status.blocked': 'Bloqueado',
  'status.toolWithInput': 'Herramienta: {tool} ({input})',
  'status.usingTool': 'Usando {tool}',
  'status.toolFinishedWith': 'Herramienta terminada: {output}',
  'status.toolFinished': 'La herramienta terminó',
  'status.toolFailedWith': 'La herramienta falló: {error}',
  'status.toolFailed': 'La herramienta falló',
  'task.executionFailed': 'La ejecución falló',
  'task.waitingOnDependency': 'Esperando una dependencia',

  'bubble.initiatorUpstairs': 'Las salas visibles están llenas. Nos vemos arriba, por la puerta secreta.',
  'bubble.initiatorRoom': 'Tenemos que sincronizarnos. Nos vemos en la sala.',
  'bubble.guestUpstairs': 'Entendido. Voy al piso secreto.',
  'bubble.guestRoom': 'Entendido. Voy para allá.',

  'event.roomReserved': '{room} reservada para {meeting}.',
  'event.meetingRequested': 'Reunión solicitada: {title}.',
  'event.phoneCall': 'Llamada iniciada con {name}.',
  'event.meetingStarted': 'Reunión iniciada: {title}.',
  'event.meetingEnded': 'Reunión terminada: {title}.',
  'event.socialStarted': 'Conversación ambiental simulada iniciada: {topic}.',

  'topic.jokes': 'chistes',
  'topic.sports': 'deportes',
  'topic.technology': 'tecnología',
  'topic.entertainment': 'entretenimiento',
  'topic.current_events': 'actualidad',
  'topic.office_banter': 'charla de oficina',
  'topic.politics': 'política',
};

/** Built-in catalogs, exported so tests can check that both languages have the same keys. */
export const LIVING_OFFICE_MESSAGES: { readonly en: Record<LivingOfficeMessageKey, string>; readonly es: Record<LivingOfficeMessageKey, string> } = {
  en: EN,
  es: ES,
};

/** Returns one living office text in the language of `locale` (BCP 47), with its placeholders filled. */
export function livingOfficeText(locale: string | undefined, key: LivingOfficeMessageKey, params?: OfficeMessageParams): string {
  const catalog = locale?.toLowerCase().startsWith('es') ? ES : EN;
  return formatMessage(catalog[key] ?? EN[key], params);
}
