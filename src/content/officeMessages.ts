/**
 * Every text the office draws or shows, in English and Spanish.
 *
 * The embedded component, the canvas renderer and the demo app read their visible text from here, so a host
 * can translate or rename anything (rooms, statuses, roles, bubble headers) by passing its own messages.
 * Placeholders use `{name}` and are replaced by `formatMessage`.
 */

const EN = {
  'crew.walkFallback': 'Walk atlas unavailable; the original pose remains visible.',
  'crew.walkDemo': 'DEMO: synthetic read-only CEO transit snapshot.',
  'crew.walkPrototype': '2.5D PROTOTYPE: CEO walk frames follow reported transit in four directions; final art and physical paths are pending.',
  // Rooms
  'rooms.boss_office': 'DIRECTOR SUITE',
  'rooms.meeting_room': 'MEETING ROOM A',
  'rooms.meeting_room_b': 'MEETING ROOM B',
  'rooms.server_room': 'MODEL OPS',
  'rooms.leads_area': 'ARCHITECTURE',
  'rooms.development': 'ENGINEERING',
  'rooms.qa_lab': 'QA LAB',
  'rooms.research_area': 'RESEARCH LIBRARY',
  'rooms.break_room': 'ESPRESSO BAR',
  'rooms.lounge': 'TEAM LOUNGE',

  // Furniture labels drawn on the floor
  'furniture.f_boss_screen': 'Objectives Wall',
  'furniture.f_server_desk': 'Token Telemetry',
  'furniture.f_research_table': 'Study Table',
  'furniture.f_coffee_table_a': 'Table A',
  'furniture.f_coffee_table_b': 'Table B',
  'furniture.f_lounge_screen': 'Lounge Display',

  // Wall screens
  'screen.meetingActive': 'TEAM COORDINATION',
  'screen.meetingIdle': 'CONFERENCE READY',
  'screen.qa': 'TEST AUTOMATION',
  'screen.status': 'SYSTEM STATUS',
  'screen.tokenFlow': 'MODEL OPS · LIVE TOKEN FLOW',
  'screen.telemetry': 'MODEL OPS · LIVE TELEMETRY',
  'screen.open': 'OPEN',

  // Agent statuses
  'status.OFFLINE': 'Offline',
  'status.IDLE': 'Idle',
  'status.AVAILABLE': 'Available',
  'status.THINKING': 'Thinking',
  'status.READING': 'Reading',
  'status.RESEARCHING': 'Researching',
  'status.CODING': 'Coding',
  'status.WRITING': 'Writing',
  'status.TESTING': 'Testing',
  'status.USING_TOOL': 'Using a tool',
  'status.WAITING': 'Waiting',
  'status.WAITING_APPROVAL': 'Waiting for approval',
  'status.BLOCKED': 'Blocked',
  'status.DELEGATING': 'Delegating',
  'status.PHONE_CALL': 'On a call',
  'status.WALKING': 'Walking',
  'status.IN_MEETING': 'In a meeting',
  'status.COFFEE_BREAK': 'Coffee break',
  'status.CHATTING': 'Chatting',
  'status.REVIEWING': 'Reviewing',
  'status.DELIVERING': 'Delivering',
  'status.DONE': 'Done',
  'status.ERROR': 'Error',

  // Built-in roles of the demo team. Agents from events show their own role title instead.
  'role.boss': 'Director',
  'role.tech_lead': 'Tech lead',
  'role.research_lead': 'Research',
  'role.backend_engineer': 'Backend',
  'role.frontend_engineer': 'Frontend',
  'role.qa_engineer': 'QA',
  'role.security_analyst': 'Security',
  'role.custom': 'Agent',

  // Speech bubble headers
  'bubble.meeting': 'MEETING',
  'bubble.phone': 'CALL',
  'bubble.social': 'SOCIAL · SIMULATED',
  'bubble.activity': 'ACTIVITY',
  'kind.statement': 'SAYS',
  'kind.proposal': 'PROPOSES',
  'kind.question': 'ASKS',
  'kind.answer': 'ANSWERS',
  'kind.objection': 'OBJECTS',
  'kind.critique': 'CRITIQUES',
  'kind.agreement': 'AGREES',
  'kind.summary': 'SUMMARIZES',
  'kind.decision': 'DECIDES',

  // Canvas controls
  'canvas.aria': 'Animated agent office. The list of agents and their status is available as text.',
  'canvas.toolbar': 'Office view controls',
  'canvas.rotateLeft': 'Rotate office left',
  'canvas.rotateRight': 'Rotate office right',
  'canvas.fit': 'Fit full office',
  'canvas.zoomOut': 'Zoom out',
  'canvas.zoomIn': 'Zoom in',
  'canvas.zoomLevel': 'Zoom {percent}%',
  'canvas.showTimeline': 'Show activity timeline',
  'canvas.hideTimeline': 'Hide activity timeline',
  'canvas.modelOps': 'Model Ops console (tokens and telemetry)',

  // Model Ops room (demo app)
  'modelOps.rack.openai': 'OpenAI server node',
  'modelOps.rack.openaiDetail': 'Prompt and reasoning tokens',
  'modelOps.rack.anthropic': 'Anthropic server node',
  'modelOps.rack.anthropicDetail': 'Code and UI work',
  'modelOps.rack.gemini': 'Google Gemini server node',
  'modelOps.rack.geminiDetail': 'Long context work',
  'modelOps.rack.local': 'On-premise local rack',
  'modelOps.rack.localDetail': 'Local compute without cloud cost',
  'modelOps.noc': 'Model Ops central screen',
  'modelOps.nocDetail': 'Live view of the global token flow',
  'modelOps.workstation': 'Model Ops telemetry workstation',
  'modelOps.workstationDetail': 'Latency, cache and throughput monitoring',
  'modelOps.plaque': 'Central operations console',
  'modelOps.plaqueDetail': 'Open the interactive token usage panel',
  'modelOps.room': 'Model Ops and token center',
  'modelOps.roomDetail': 'LLM infrastructure and usage monitoring',
  'modelOps.open': 'Open Model Ops console',
  'modelOps.hint': 'Click to inspect token usage',

  // Embedded office
  'office.label': 'Agent office',
  'office.agentsHeading': 'Agents in the office',
  'office.agentLine': '{name}, {role}: {status}',
  'office.agentLineNoRole': '{name}: {status}',
  'office.empty': 'Waiting for agent activity',

  // Usage figures (only shown when the host allows it)
  'usage.title': 'Usage',
  'usage.tokens': 'Tokens',
  'usage.inputTokens': 'Input tokens',
  'usage.outputTokens': 'Output tokens',
  'usage.cacheRead': 'Cache read',
  'usage.cacheWrite': 'Cache write',
  'usage.cacheReadTokens': 'Cache read tokens',
  'usage.cacheWriteTokens': 'Cache write tokens',
  'usage.reasoningTokens': 'Reasoning tokens',
  'usage.cost': 'Cost',
  'usage.costSource': 'Cost source',
  'usage.costSource.providerReported': 'provider reported',
  'usage.costSource.estimated': 'estimated',
  'usage.failedCalls': 'Failed calls',
  'usage.badge.estimatedMark': 'est.',
  'usage.badge.failed': '{count} failed',
  'usage.badge.lessThan': '<{value}',
  'usage.unknown': 'unknown',
  'usage.partialTokens': '{value} (unknown in {count} of {calls} calls)',
  'usage.partialCost': '+ {count} calls with unknown cost',
  'usage.partialShort': '+ unknown',
  'usage.mixedCurrencies': 'mixed currencies',
  'usage.mixedSources': 'mixed sources',
  'usage.noCurrency': 'Currency not reported',
  'usage.estimatedShort': 'estimated',
  'usage.sourceUnknown': 'Source unknown',

  // Per-call detail panel (only shown when the host allows it, for the selected agent)
  'calls.title': 'Call details: {name}',
  'calls.close': 'Close call details',
  'calls.empty': 'No call details provided',
  'calls.provider': 'Provider',
  'calls.model': 'Model',
  'calls.status': 'Status',
  'calls.status.ok': 'OK',
  'calls.status.failed': 'Failed',
  'calls.status.rate_limited': 'Rate limited',
  'calls.latency': 'Latency',
  'calls.latencyValue': '{value} ms',
  'calls.requestId': 'Request id',

  // Replay controls
  'replay.label': 'Replay controls',
  'replay.play': 'Play',
  'replay.pause': 'Pause',
  'replay.reset': 'Back to start',
  'replay.position': 'Replay position',
  'replay.progress': '{percent}%',
  'replay.speed': 'Speed',
  'replay.speedValue': '{speed}x',

  // Video export
  'video.time': 'Time: {time}',
} as const satisfies Record<string, string>;

export type OfficeMessageKey = keyof typeof EN;
export type OfficeMessages = Record<OfficeMessageKey, string>;

const ES: OfficeMessages = {
  'crew.walkFallback': 'Atlas de caminar no disponible; se conserva la pose original.',
  'crew.walkDemo': 'DEMO: snapshot sintético de tránsito del CEO, de solo lectura.',
  'crew.walkPrototype': 'PROTOTIPO 2.5D: los cuadros de caminar del CEO siguen el tránsito reportado en cuatro direcciones; arte final y trayectorias físicas pendientes.',
  'rooms.boss_office': 'DIRECCIÓN',
  'rooms.meeting_room': 'SALA DE REUNIÓN A',
  'rooms.meeting_room_b': 'SALA DE REUNIÓN B',
  'rooms.server_room': 'MODEL OPS',
  'rooms.leads_area': 'ARQUITECTURA',
  'rooms.development': 'INGENIERÍA',
  'rooms.qa_lab': 'LAB QA',
  'rooms.research_area': 'BIBLIOTECA I+D',
  'rooms.break_room': 'CAFÉ ESPRESSO',
  'rooms.lounge': 'SALA DEL EQUIPO',

  'furniture.f_boss_screen': 'Muro de objetivos',
  'furniture.f_server_desk': 'Telemetría de tokens',
  'furniture.f_research_table': 'Mesa de estudio',
  'furniture.f_coffee_table_a': 'Mesa A',
  'furniture.f_coffee_table_b': 'Mesa B',
  'furniture.f_lounge_screen': 'Pantalla del salón',

  'screen.meetingActive': 'COORDINACIÓN',
  'screen.meetingIdle': 'SALA LISTA',
  'screen.qa': 'PRUEBAS AUTOMÁTICAS',
  'screen.status': 'ESTADO DEL SISTEMA',
  'screen.tokenFlow': 'MODEL OPS · FLUJO DE TOKENS',
  'screen.telemetry': 'MODEL OPS · TELEMETRÍA',
  'screen.open': 'ABRIR',

  'status.OFFLINE': 'Desconectado',
  'status.IDLE': 'En espera',
  'status.AVAILABLE': 'Disponible',
  'status.THINKING': 'Pensando',
  'status.READING': 'Leyendo',
  'status.RESEARCHING': 'Investigando',
  'status.CODING': 'Programando',
  'status.WRITING': 'Escribiendo',
  'status.TESTING': 'Probando',
  'status.USING_TOOL': 'Usando una herramienta',
  'status.WAITING': 'Esperando',
  'status.WAITING_APPROVAL': 'Esperando aprobación',
  'status.BLOCKED': 'Bloqueado',
  'status.DELEGATING': 'Delegando',
  'status.PHONE_CALL': 'En llamada',
  'status.WALKING': 'Caminando',
  'status.IN_MEETING': 'En reunión',
  'status.COFFEE_BREAK': 'Pausa para café',
  'status.CHATTING': 'Conversando',
  'status.REVIEWING': 'Revisando',
  'status.DELIVERING': 'Entregando',
  'status.DONE': 'Terminado',
  'status.ERROR': 'Error',

  'role.boss': 'Dirección',
  'role.tech_lead': 'Líder técnico',
  'role.research_lead': 'Investigación',
  'role.backend_engineer': 'Backend',
  'role.frontend_engineer': 'Frontend',
  'role.qa_engineer': 'QA',
  'role.security_analyst': 'Seguridad',
  'role.custom': 'Agente',

  'bubble.meeting': 'REUNIÓN',
  'bubble.phone': 'LLAMADA',
  'bubble.social': 'SOCIAL · SIMULADO',
  'bubble.activity': 'ACTIVIDAD',
  'kind.statement': 'DICE',
  'kind.proposal': 'PROPONE',
  'kind.question': 'PREGUNTA',
  'kind.answer': 'RESPONDE',
  'kind.objection': 'OBJETA',
  'kind.critique': 'CRITICA',
  'kind.agreement': 'DE ACUERDO',
  'kind.summary': 'RESUME',
  'kind.decision': 'DECIDE',

  'canvas.aria': 'Oficina animada de agentes. La lista de agentes y su estado está disponible como texto.',
  'canvas.toolbar': 'Controles de la vista',
  'canvas.rotateLeft': 'Girar oficina a la izquierda',
  'canvas.rotateRight': 'Girar oficina a la derecha',
  'canvas.fit': 'Ajustar oficina completa',
  'canvas.zoomOut': 'Alejar',
  'canvas.zoomIn': 'Acercar',
  'canvas.zoomLevel': 'Zoom {percent}%',
  'canvas.showTimeline': 'Mostrar actividad',
  'canvas.hideTimeline': 'Ocultar actividad',
  'canvas.modelOps': 'Consola Model Ops (tokens y telemetría)',

  'modelOps.rack.openai': 'Nodo servidor OpenAI',
  'modelOps.rack.openaiDetail': 'Tokens de prompts y razonamiento',
  'modelOps.rack.anthropic': 'Nodo servidor Anthropic',
  'modelOps.rack.anthropicDetail': 'Código e interfaz',
  'modelOps.rack.gemini': 'Nodo servidor Google Gemini',
  'modelOps.rack.geminiDetail': 'Trabajo con contexto largo',
  'modelOps.rack.local': 'Rack local on-premise',
  'modelOps.rack.localDetail': 'Cómputo local sin costo de nube',
  'modelOps.noc': 'Pantalla central Model Ops',
  'modelOps.nocDetail': 'Flujo global de tokens en vivo',
  'modelOps.workstation': 'Estación de telemetría Model Ops',
  'modelOps.workstationDetail': 'Monitoreo de latencia, caché y rendimiento',
  'modelOps.plaque': 'Consola central de operaciones',
  'modelOps.plaqueDetail': 'Abrir el panel interactivo de consumo de tokens',
  'modelOps.room': 'Sala Model Ops y centro de tokens',
  'modelOps.roomDetail': 'Infraestructura LLM y monitoreo de consumo',
  'modelOps.open': 'Abrir consola Model Ops',
  'modelOps.hint': 'Haz clic para revisar el consumo de tokens',

  'office.label': 'Oficina de agentes',
  'office.agentsHeading': 'Agentes en la oficina',
  'office.agentLine': '{name}, {role}: {status}',
  'office.agentLineNoRole': '{name}: {status}',
  'office.empty': 'Esperando actividad de los agentes',

  'usage.title': 'Consumo',
  'usage.tokens': 'Tokens',
  'usage.inputTokens': 'Tokens de entrada',
  'usage.outputTokens': 'Tokens de salida',
  'usage.cacheRead': 'Lectura de caché',
  'usage.cacheWrite': 'Escritura de caché',
  'usage.cacheReadTokens': 'Tokens de caché leídos',
  'usage.cacheWriteTokens': 'Tokens de caché escritos',
  'usage.reasoningTokens': 'Tokens de razonamiento',
  'usage.cost': 'Costo',
  'usage.costSource': 'Origen del costo',
  'usage.costSource.providerReported': 'informado por el proveedor',
  'usage.costSource.estimated': 'estimado',
  'usage.failedCalls': 'Llamadas fallidas',
  'usage.badge.estimatedMark': 'est.',
  'usage.badge.failed': '{count} fallidas',
  'usage.badge.lessThan': '<{value}',
  'usage.unknown': 'desconocido',
  'usage.partialTokens': '{value} (desconocido en {count} de {calls} llamadas)',
  'usage.partialCost': '+ {count} llamadas con costo desconocido',
  'usage.partialShort': '+ desconocido',
  'usage.mixedCurrencies': 'múltiples monedas',
  'usage.mixedSources': 'múltiples fuentes',
  'usage.noCurrency': 'Moneda no reportada',
  'usage.estimatedShort': 'estimado',
  'usage.sourceUnknown': 'Fuente desconocida',

  'calls.title': 'Detalle de llamadas: {name}',
  'calls.close': 'Cerrar el detalle de llamadas',
  'calls.empty': 'No se proporcionó detalle de llamadas',
  'calls.provider': 'Proveedor',
  'calls.model': 'Modelo',
  'calls.status': 'Estado',
  'calls.status.ok': 'Correcta',
  'calls.status.failed': 'Fallida',
  'calls.status.rate_limited': 'Limitada por frecuencia',
  'calls.latency': 'Latencia',
  'calls.latencyValue': '{value} ms',
  'calls.requestId': 'Id de solicitud',

  'replay.label': 'Controles de repetición',
  'replay.play': 'Reproducir',
  'replay.pause': 'Pausar',
  'replay.reset': 'Volver al inicio',
  'replay.position': 'Posición de la repetición',
  'replay.progress': '{percent}%',
  'replay.speed': 'Velocidad',
  'replay.speedValue': '{speed}x',

  'video.time': 'Hora: {time}',
};

/** Built-in catalogs. Hosts can pass any other language through `messages` or `t`. */
export const OFFICE_MESSAGES: { readonly en: OfficeMessages; readonly es: OfficeMessages } = { en: EN, es: ES };

export type OfficeMessageParams = Record<string, string | number>;

/** A translate function as hosts usually have one (i18next, FormatJS...). Return `undefined` or the key when missing. */
export type HostTranslate = (key: string, params?: OfficeMessageParams) => string | null | undefined;

export type OfficeTranslate = (key: OfficeMessageKey, params?: OfficeMessageParams) => string;

export interface OfficeTranslatorOptions {
  /** BCP 47 locale. Picks the built-in catalog by language (`es-CO` uses Spanish); anything else uses English. */
  locale?: string;
  /** Overrides for single keys. Missing keys fall back to the built-in catalog, then to English. */
  messages?: Partial<OfficeMessages>;
  /** Host translate function. Wins over `messages` when it returns a value different from the key. */
  t?: HostTranslate;
}

export function isOfficeMessageKey(key: string): key is OfficeMessageKey {
  return Object.prototype.hasOwnProperty.call(EN, key);
}

export function formatMessage(template: string, params?: OfficeMessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function builtInMessages(locale?: string): OfficeMessages {
  return locale?.toLowerCase().startsWith('es') ? ES : EN;
}

export function createOfficeTranslator(options: OfficeTranslatorOptions = {}): OfficeTranslate {
  const catalog = builtInMessages(options.locale);
  const { messages, t } = options;
  return (key, params) => {
    const fromHost = t?.(key, params);
    if (typeof fromHost === 'string' && fromHost.length > 0 && fromHost !== key) return fromHost;
    const template = messages?.[key] ?? catalog[key] ?? EN[key];
    return formatMessage(template, params);
  };
}
