/**
 * Every text of the simulated demo scenario (the UiPath RPA banking automation), in English and Spanish.
 *
 * The demo script in `src/engine/simulationEngine.ts` reads its step titles, speech bubbles, status texts,
 * tasks, artifacts, meetings and event summaries from here, so the demo plays in the language of the app.
 * The `agent.*` keys localize the 10 demo agents of `INITIAL_AGENTS`, whose built-in values are the Spanish
 * ones. Placeholders use `{name}` and are replaced by `formatMessage`. Person names are never translated.
 */
import type { Locale } from '../i18n';
import { formatMessage, type OfficeMessageParams } from './officeMessages';

const EN = {
  // Demo agents (ids of INITIAL_AGENTS)
  'agent.boss.roleTitle': 'UiPath RPA Lead',
  'agent.boss.statusText': 'Overseeing RPA requirements and client delivery',
  'agent.sales-lead.roleTitle': 'Sales and Accounts Lead',
  'agent.sales-lead.statusText': 'Managing quotes and client relationships',
  'agent.tech-lead.roleTitle': 'UiPath Development Architect',
  'agent.tech-lead.statusText': 'REFramework and UiPath Orchestrator architecture',
  'agent.research-lead.roleTitle': 'Business Analysis (BA) Lead',
  'agent.research-lead.statusText': 'Analyzing process specifications and the PDD',
  'agent.backend-agent.roleTitle': 'RPA Developer 1',
  'agent.backend-agent.statusText': 'REFramework and Dispatcher specialist',
  'agent.frontend-agent.roleTitle': 'RPA Developer 2',
  'agent.frontend-agent.statusText': 'Banking web automation and selectors',
  'agent.security-agent.roleTitle': 'RPA Developer 3',
  'agent.security-agent.statusText': 'UiPath Document Understanding and OCR',
  'agent.ba-analyst-1.roleTitle': 'Business Analyst 1 (Processes)',
  'agent.ba-analyst-1.statusText': 'Mapping as-is banking flows',
  'agent.ba-analyst-2.roleTitle': 'Business Analyst 2 (PDD and Requirements)',
  'agent.ba-analyst-2.statusText': 'Drafting the PDD and BPMN diagrams',
  'agent.qa-agent.roleTitle': 'Business Analyst 3 (Criteria and QA)',
  'agent.qa-agent.statusText': 'Test matrix and acceptance criteria',

  // Initial state
  'init.event': 'UiPath RPA and BA automation team ready at the office.',

  // Step 1
  'step.0.title': '1. Client inputs received (video, 2 PDFs, Word file, 2 bank websites)',
  'step.0.description':
    'Valeria (Sales) and Carlos (RPA Lead) receive the banking request in the Director Suite: 1 video, 2 statement PDFs, 1 Word file and 2 bank websites.',
  'step.0.sales.statusText': 'Presenting the client request',
  'step.0.sales.bubble': 'The client sent a video, 2 PDFs, a Word file and 2 bank websites to automate reconciliation!',
  'step.0.boss.statusText': 'Planning an end-to-end UiPath RPA solution',
  'step.0.boss.bubble': 'Got it. Calling an immediate kickoff with Architecture and Business Analysis.',
  'step.0.task.title': 'End-to-End UiPath Banking Automation',
  'step.0.task.description':
    'Build a complete RPA solution: PDD, SDD, estimate, BPMN, architecture, quote, Gantt chart, summary and an interactive HTML presentation.',
  'step.0.event': 'TASK-RPA-BANK received: video, 2 PDFs, Word file and 2 bank websites to automate reconciliation.',

  // Step 2
  'step.1.title': '2. Scope kickoff in Meeting Room A',
  'step.1.description':
    'Carlos (RPA Lead), Alex (Architect) and Dr. Maya (BA Lead) meet in Meeting Room A to coordinate the deliverables.',
  'step.1.techLead.bubble': 'Reviewing the video and the bank websites. We will design a Dispatcher and a Performer in REFramework.',
  'step.1.meeting.title': 'Banking RPA Solution Kickoff',
  'step.1.meeting.topic': 'Deliverables breakdown: PDD, SDD, estimate, BPMN and quote',
  'step.1.meeting.agenda.0': 'Video review',
  'step.1.meeting.agenda.1': 'Extraction of the 2 PDFs',
  'step.1.meeting.agenda.2': 'REFramework structure',
  'step.1.meeting.decision.0': 'BA will produce the PDD in the Research Library',
  'step.1.meeting.decision.1': 'Architecture will define the SDD in Meeting Room B',
  'step.1.event': 'Kickoff started in Meeting Room A: defining the RPA deliverables plan.',

  // Step 3
  'step.2.title': '3. Research Library: document extraction and PDD',
  'step.2.description':
    'Dr. Maya, Sofía and Andrés analyze the video, the 2 PDFs and the Word file in the Research Library and compile the Process Definition Document.',
  'step.2.ba1.bubble': 'Extracted 28 key fields from the Word file and the bank PDFs. PDD v1.0 is ready.',
  'step.2.artifact.pdd.name': 'PDD - Process Definition Document v1.0',
  'step.2.artifact.pdd.summary': 'Formal definition of the banking process with business rules and OCR fields.',
  'step.2.event': 'PDD (Process Definition Document) generated successfully in the Research Library.',

  // Step 4
  'step.3.title': '4. Architecture area: BPMN diagrams and effort estimate',
  'step.3.description':
    'In the Architecture area the team models the as-is and to-be flow diagrams and estimates the effort in story points.',
  'step.3.ba2.bubble': 'BPMN diagrams ready: 3 happy paths and 8 banking business exceptions.',
  'step.3.artifact.bpmn.name': 'BPMN As-Is and To-Be Flow Diagrams',
  'step.3.artifact.bpmn.summary': 'Detailed BPMN 2.0 map of the banking processes, including error branches.',
  'step.3.artifact.estimate.name': 'Effort Estimate and Sizing',
  'step.3.artifact.estimate.summary': 'Complexity matrix: 42 user stories, 85 story points over 3 sprints.',
  'step.3.event': 'BPMN diagrams and effort estimate completed in the Architecture area.',

  // Step 5
  'step.4.title': '5. Meeting Room B (War Room): UiPath architecture and SDD',
  'step.4.description':
    'Alex (Architect) and the 3 RPA developers meet in Meeting Room B to define the REFramework and the SDD.',
  'step.4.techLead.bubble': 'SDD approved: Dispatcher-Performer architecture with transactional queues and REFramework.',
  'step.4.artifact.sdd.name': 'SDD - Solution Design Document (UiPath REFramework)',
  'step.4.artifact.sdd.summary': 'Technical design of the UiPath solution: Dispatcher, Performer, queues and exception handling.',
  'step.4.artifact.architecture.name': 'UiPath REFramework Technical Architecture',
  'step.4.artifact.architecture.summary': 'Integration blueprint with Azure Key Vault, Orchestrator and the bank websites.',
  'step.4.event': 'SDD and UiPath architecture approved in Meeting Room B.',
  'step.4.meeting.title': 'UiPath Architecture and SDD Review',
  'step.4.meeting.topic': 'Dispatcher-Performer design, transactional queues and REFramework',

  // Step 6
  'step.5.title': '6. Engineering: building in UiPath Studio',
  'step.5.description':
    'Lucas, Kenji and Mateo build the XAML workflows that automate both bank websites and the REFramework.',
  'step.5.dev1.bubble': 'Fuzzy selectors and web navigation ready for both banks (Santander and Chile).',
  'step.5.event': 'UiPath Studio: Dispatcher and Performer implemented for the 2 banking platforms.',

  // Step 7
  'step.6.title': '7. QA Lab: stress tests and banking certification',
  'step.6.description': 'Zoe Vance (QA) and Mateo Silva run 1,000 simulated transactions in the QA Lab without errors.',
  'step.6.qa.bubble': '1,000 transactions tested: 0 system exceptions, 100% banking success.',
  'step.6.artifact.qa.name': 'Banking QA Test Matrix and Certification',
  'step.6.artifact.qa.summary': 'Certification of 1,000 transactions: 0 failures, tolerance to network outages and automatic retries.',
  'step.6.event': 'Banking QA certification passed: 1,000 transactions validated in the QA Lab.',

  // Step 8
  'step.7.title': '8. Model Ops room: UiPath Orchestrator and telemetry',
  'step.7.description':
    'Alex and Lucas set up the UiPath Orchestrator cluster in the Model Ops room and provision 4 unattended robots.',
  'step.7.techLead.bubble': 'UiPath Orchestrator configured: 4 unattended robots ready in high availability.',
  'step.7.artifact.orchestrator.name': 'Orchestrator Topology and Robot Provisioning',
  'step.7.artifact.orchestrator.summary': 'Setup of 4 unattended robots, transactional queues and a 4-hour SLA.',
  'step.7.event': 'UiPath Orchestrator provisioned with 4 unattended robots in the Model Ops room.',

  // Step 9
  'step.8.title': '9. Espresso bar and Team Lounge: sync coffee break',
  'step.8.description':
    'The team gathers at the espresso bar and the Team Lounge for a break while Sales consolidates the commercial proposal.',
  'step.8.ba1.bubble': 'Great coordination! The PDD and the SDD are ready for the quote.',
  'step.8.event': 'The team syncs at the espresso bar and the Team Lounge during the technical break.',

  // Step 10
  'step.9.title': '10. Secret floor (floor 2): commercial quote and Gantt chart',
  'step.9.description':
    'Valeria (Sales), Carlos (RPA Lead) and Dr. Maya go up to the secret floor 2 to work out the quote and the Gantt chart.',
  'step.9.sales.bubble': 'Quote closed: $48.5K USD with ROI in 4 months and a 6-week Gantt chart.',
  'step.9.artifact.quote.name': 'Commercial Quote and ROI Analysis',
  'step.9.artifact.quote.summary': 'Investment: $48,500 USD. Estimated annual savings: $165,000 USD (340% ROI in 6 months).',
  'step.9.artifact.gantt.name': 'Gantt Chart - Implementation Schedule (6 Weeks)',
  'step.9.artifact.gantt.summary': 'Detailed schedule with Sprints 1, 2 and 3, banking UAT and go-live.',
  'step.9.event': 'Commercial quote and Gantt chart completed on the secret second floor.',
  'step.9.meeting.title': 'Commercial Quote and Gantt Chart',
  'step.9.meeting.topic': 'Investment, ROI and the 6-week implementation schedule',

  // Step 11
  'step.10.title': '11. Director Suite: executive summary and HTML presentation',
  'step.10.description':
    'The leadership team compiles the executive summary and builds the interactive HTML presentation that brings everything together.',
  'step.10.boss.bubble': 'Compiling the interactive HTML presentation with every deliverable for the client.',
  'step.10.artifact.summary.name': 'Executive Summary of the Banking RPA Solution',
  'step.10.artifact.summary.summary': 'Management one-pager summarizing scope, business benefits, security and ROI.',
  'step.10.artifact.deck.name': 'Interactive HTML Executive Presentation',
  'step.10.artifact.deck.summary': 'Responsive interactive HTML deck with the PDD, SDD, BPMN diagrams, Gantt chart and quote.',
  'step.10.event': 'Interactive HTML presentation and executive summary compiled in the Director Suite.',

  // Step 12
  'step.11.title': '12. Grand finale: the complete proposal is delivered',
  'step.11.description': 'Every agent returns to their desk. The task reaches 100% with all 9 artifacts delivered.',
  'step.11.boss.bubble': 'Delivery complete! PDD, SDD, BPMN, architecture, quote, Gantt chart and HTML are ready.',
  'step.11.event': 'TASK-RPA-BANK completed successfully: 9 deliverables generated in 25.5 seconds.',

  // Custom task launched from the demo app
  'custom.boss.bubble': 'Dispatching {taskId}: "{title}" to {agent}.',
  'custom.agent.statusText': 'Executing {taskId}: {title}',
  'custom.agent.bubble': 'Received assignment: {title}. Starting execution now.',
  'custom.event': 'Task {taskId} initiated: "{title}" assigned to {agent}.',
} as const satisfies Record<string, string>;

export type DemoScriptKey = keyof typeof EN;
export type DemoScriptTexts = Record<DemoScriptKey, string>;

const ES: DemoScriptTexts = {
  'agent.boss.roleTitle': 'Líder / Jefe de RPA UiPath',
  'agent.boss.statusText': 'Supervisando requerimientos RPA y entrega a cliente',
  'agent.sales-lead.roleTitle': 'Líder Comercial y Ventas',
  'agent.sales-lead.statusText': 'Gestionando cotizaciones y relación con clientes',
  'agent.tech-lead.roleTitle': 'Arquitecto de Desarrollo UiPath',
  'agent.tech-lead.statusText': 'Arquitectura REFramework y UiPath Orchestrator',
  'agent.research-lead.roleTitle': 'Líder de Business Analysis (BA)',
  'agent.research-lead.statusText': 'Analizando especificaciones de procesos y PDD',
  'agent.backend-agent.roleTitle': 'Analista de Desarrollo RPA 1',
  'agent.backend-agent.statusText': 'Especialista REFramework & Dispatcher',
  'agent.frontend-agent.roleTitle': 'Analista de Desarrollo RPA 2',
  'agent.frontend-agent.statusText': 'Automatización Web Bancaria & Selectores',
  'agent.security-agent.roleTitle': 'Analista de Desarrollo RPA 3',
  'agent.security-agent.statusText': 'UiPath Document Understanding & OCR',
  'agent.ba-analyst-1.roleTitle': 'Analista BA 1 (Procesos)',
  'agent.ba-analyst-1.statusText': 'Mapeo de flujos As-Is bancarios',
  'agent.ba-analyst-2.roleTitle': 'Analista BA 2 (PDD & Requerimientos)',
  'agent.ba-analyst-2.statusText': 'Elaboración PDD y diagramas BPMN',
  'agent.qa-agent.roleTitle': 'Analista BA 3 (Criterios & QA)',
  'agent.qa-agent.statusText': 'Matriz de pruebas y criterios de aceptación',

  'init.event': 'Equipo de Automatización RPA UiPath & BA listo en oficinas.',

  'step.0.title': '1. Recepción de Insumos del Cliente (Video, 2 PDFs, Word, 2 Webs Bancarias)',
  'step.0.description':
    'Valeria (Ventas) y Carlos (Jefe RPA) reciben en Dirección el requerimiento bancario: 1 Video, 2 PDFs de extractos, 1 Word y 2 webs de bancos.',
  'step.0.sales.statusText': 'Presentando requerimiento del cliente',
  'step.0.sales.bubble': '¡Cliente envió Video, 2 PDFs, Word y 2 webs bancarias para automatizar conciliación!',
  'step.0.boss.statusText': 'Planificando solución RPA UiPath end-to-end',
  'step.0.boss.bubble': 'Recibido. Convocando kickoff inmediato con Arquitectura y Business Analysis.',
  'step.0.task.title': 'Automatización Bancaria UiPath End-to-End',
  'step.0.task.description':
    'Construir solución RPA completa: PDD, SDD, Estimación, BPMN, Arquitectura, Cotización, Gantt, Resumen y Presentación HTML interactiva.',
  'step.0.event': 'TASK-RPA-BANK recibida: Video, 2 PDFs, Word y 2 webs de bancos para automatizar conciliación.',

  'step.1.title': '2. Kickoff de alcance en la Sala de reunión A',
  'step.1.description':
    'Carlos (Jefe RPA), Alex (Arquitecto) y Dra. Maya (Líder BA) se reúnen en la Sala de reunión A para coordinar entregables.',
  'step.1.techLead.bubble': 'Revisando video y webs de bancos. Diseñaremos Dispatcher y Performer en REFramework.',
  'step.1.meeting.title': 'Kickoff Solución RPA Bancaria',
  'step.1.meeting.topic': 'Desglose de entregables: PDD, SDD, Estimación, BPMN y Cotización',
  'step.1.meeting.agenda.0': 'Revisión Video',
  'step.1.meeting.agenda.1': 'Extracción 2 PDFs',
  'step.1.meeting.agenda.2': 'Estructura REFramework',
  'step.1.meeting.decision.0': 'BA generará el PDD en la Biblioteca I+D',
  'step.1.meeting.decision.1': 'Arquitectura definirá el SDD en la Sala de reunión B',
  'step.1.event': 'Kickoff iniciado en la Sala de reunión A: definición del plan de entregables RPA.',

  'step.2.title': '3. Biblioteca I+D: extracción documental y creación del PDD',
  'step.2.description':
    'Dra. Maya, Sofía y Andrés analizan el Video, los 2 PDFs y el Word en la Biblioteca I+D y compilan el Process Definition Document.',
  'step.2.ba1.bubble': 'Extraídos 28 campos clave del Word y PDFs bancarios. PDD v1.0 listo.',
  'step.2.artifact.pdd.name': 'PDD - Documento de Definición del Proceso v1.0',
  'step.2.artifact.pdd.summary': 'Documento formal de definición de proceso bancario con reglas de negocio y campos OCR.',
  'step.2.event': 'PDD (Process Definition Document) generado con éxito en la Biblioteca I+D.',

  'step.3.title': '4. Arquitectura: diagramas BPMN y estimación de esfuerzo',
  'step.3.description':
    'En el área de Arquitectura se modelan los diagramas de flujo As-Is / To-Be y se calcula la estimación de esfuerzo en story points.',
  'step.3.ba2.bubble': 'Diagramas BPMN listos: 3 caminos felices y 8 excepciones de negocio bancarias.',
  'step.3.artifact.bpmn.name': 'Diagramas de Flujo BPMN As-Is & To-Be',
  'step.3.artifact.bpmn.summary': 'Mapeo detallado de procesos bancarios en estándar BPMN 2.0 con bifurcaciones de error.',
  'step.3.artifact.estimate.name': 'Estimación de Esfuerzo & Sizing',
  'step.3.artifact.estimate.summary': 'Matriz de complejidad: 42 historias de usuario, 85 Story Points en 3 Sprints.',
  'step.3.event': 'Diagramas BPMN y Estimación de Esfuerzo completados en el área de Arquitectura.',

  'step.4.title': '5. Sala de reunión B (War Room): arquitectura UiPath y SDD',
  'step.4.description':
    'Alex (Arquitecto) y los 3 analistas de desarrollo RPA se reúnen en la Sala de reunión B para definir REFramework y el SDD.',
  'step.4.techLead.bubble': 'SDD aprobado: Arquitectura Dispatcher-Performer con colas transaccionales y REFramework.',
  'step.4.artifact.sdd.name': 'SDD - Documento de Diseño de la Solución (UiPath REFramework)',
  'step.4.artifact.sdd.summary': 'Diseño técnico de la solución UiPath: Dispatcher, Performer, Queues y manejo de excepciones.',
  'step.4.artifact.architecture.name': 'Arquitectura Técnica UiPath REFramework',
  'step.4.artifact.architecture.summary': 'Blueprint de integración con Azure Key Vault, Orchestrator y webs bancarias.',
  'step.4.event': 'SDD y Arquitectura UiPath aprobados en la Sala de reunión B.',
  'step.4.meeting.title': 'Revisión de Arquitectura UiPath y SDD',
  'step.4.meeting.topic': 'Diseño Dispatcher-Performer, colas transaccionales y REFramework',

  'step.5.title': '6. Ingeniería: desarrollo en UiPath Studio',
  'step.5.description':
    'Lucas, Kenji y Mateo desarrollan los workflows XAML automatizando ambas páginas web bancarias y el REFramework.',
  'step.5.dev1.bubble': 'Selectores Fuzzy y navegación web listos en ambos bancos (Santander & Chile).',
  'step.5.event': 'UiPath Studio: Dispatcher y Performer implementados para las 2 plataformas bancarias.',

  'step.6.title': '7. Lab QA: pruebas de estrés y certificación bancaria',
  'step.6.description': 'Zoe Vance (QA) y Mateo Silva ejecutan en el Lab QA 1,000 transacciones simuladas sin errores.',
  'step.6.qa.bubble': '1,000 transacciones probadas: 0 excepciones de sistema, 100% de éxito bancario.',
  'step.6.artifact.qa.name': 'Matriz de Pruebas & Certificación QA Bancaria',
  'step.6.artifact.qa.summary':
    'Certificación de 1,000 transacciones: 0 fallos, tolerancia a caídas de red y reintentos automáticos.',
  'step.6.event': 'Certificación QA Bancaria exitosa: 1,000 transacciones validadas en el Lab QA.',

  'step.7.title': '8. Sala Model Ops: UiPath Orchestrator y telemetría',
  'step.7.description':
    'Alex y Lucas configuran en la sala Model Ops el clúster de UiPath Orchestrator y aprovisionan 4 Robots Unattended.',
  'step.7.techLead.bubble': 'UiPath Orchestrator configurado: 4 Robots Unattended listos en alta disponibilidad.',
  'step.7.artifact.orchestrator.name': 'Topología Orchestrator & Provisioning de Robots',
  'step.7.artifact.orchestrator.summary': 'Configuración de 4 Robots Unattended, Colas Transaccionales y SLA de 4 horas.',
  'step.7.event': 'UiPath Orchestrator aprovisionado con 4 Robots Unattended en la sala Model Ops.',

  'step.8.title': '9. Café y Sala del equipo: pausa de sincronización',
  'step.8.description':
    'El equipo se reúne en el café y la Sala del equipo para un receso mientras Ventas consolida la propuesta económica.',
  'step.8.ba1.bubble': '¡Excelente coordinación! El PDD y el SDD están listos para la cotización.',
  'step.8.event': 'Equipo sincroniza en el café y la Sala del equipo durante el descanso técnico.',

  'step.9.title': '10. Piso secreto (piso 2): cotización económica y Carta Gantt',
  'step.9.description':
    'Valeria (Ventas), Carlos (Jefe RPA) y Dra. Maya suben al piso secreto 2 para calcular la cotización y la Carta Gantt.',
  'step.9.sales.bubble': 'Cotización cerrada: $48.5K USD con ROI en 4 meses y Carta Gantt de 6 semanas.',
  'step.9.artifact.quote.name': 'Cotización Económica & Análisis de ROI',
  'step.9.artifact.quote.summary':
    'Inversión: $48,500 USD. Ahorro anual estimado: $165,000 USD (ROI de 340% en 6 meses).',
  'step.9.artifact.gantt.name': 'Carta Gantt - Cronograma de Implementación (6 Semanas)',
  'step.9.artifact.gantt.summary': 'Cronograma detallado con fases de Sprint 1, 2, 3, UAT bancario y pase a producción.',
  'step.9.event': 'Cotización Económica y Carta Gantt completadas en el piso secreto 2.',
  'step.9.meeting.title': 'Cotización Económica y Carta Gantt',
  'step.9.meeting.topic': 'Inversión, ROI y cronograma de implementación de 6 semanas',

  'step.10.title': '11. Dirección: resumen ejecutivo y presentación HTML',
  'step.10.description':
    'El equipo directivo compila el Resumen Ejecutivo y genera la Presentación Interactiva en HTML consolidando todo.',
  'step.10.boss.bubble': 'Compilando la presentación interactiva HTML con todos los entregables para el cliente.',
  'step.10.artifact.summary.name': 'Resumen Ejecutivo de la Solución RPA Bancaria',
  'step.10.artifact.summary.summary': 'One-pager gerencial resumiendo alcance, beneficios de negocio, seguridad y ROI.',
  'step.10.artifact.deck.name': 'Presentación Ejecutiva Interactiva HTML',
  'step.10.artifact.deck.summary': 'Deck interactivo en HTML responsive con PDD, SDD, diagramas BPMN, Gantt y cotización.',
  'step.10.event': 'Presentación Interactiva HTML y Resumen Ejecutivo compilados en Dirección.',

  'step.11.title': '12. Gran Cierre: Entrega Exitosa de la Propuesta Completa',
  'step.11.description':
    'Todos los agentes regresan a sus puestos. La tarea se completa al 100% con los 9 artefactos entregados.',
  'step.11.boss.bubble': '¡Entrega completada! PDD, SDD, BPMN, Arquitectura, Cotización, Gantt y HTML listos.',
  'step.11.event': 'TASK-RPA-BANK completada con éxito: 9 entregables generados en 25.5 segundos.',

  'custom.boss.bubble': 'Asignando {taskId}: "{title}" a {agent}.',
  'custom.agent.statusText': 'Ejecutando {taskId}: {title}',
  'custom.agent.bubble': 'Asignación recibida: {title}. Comienzo la ejecución ahora.',
  'custom.event': 'Tarea {taskId} iniciada: "{title}" asignada a {agent}.',
};

/** Demo scenario texts by locale. Both catalogs have exactly the same keys. */
export const DEMO_SCRIPT: Record<Locale, DemoScriptTexts> = { en: EN, es: ES };

export const DEMO_SCRIPT_KEYS = Object.keys(EN) as DemoScriptKey[];

/** Returns one demo text in the given locale, with its `{placeholders}` filled from `params`. */
export function demoText(locale: Locale, key: DemoScriptKey, params?: OfficeMessageParams): string {
  return formatMessage(DEMO_SCRIPT[locale][key], params);
}

const DEMO_TEXT_LOOKUP: ReadonlyMap<string, DemoScriptKey> = (() => {
  const lookup = new Map<string, DemoScriptKey>();
  for (const key of DEMO_SCRIPT_KEYS) {
    if (EN[key].includes('{')) continue;
    lookup.set(EN[key], key);
    lookup.set(ES[key], key);
  }
  return lookup;
})();

/**
 * Shows a stored demo text in the current locale.
 *
 * The simulation keeps plain strings in its state (agents, tasks, events, meetings), written in the locale that
 * was active when each step ran or in the Spanish defaults of `INITIAL_AGENTS`. When `text` is exactly one of the
 * built-in demo texts, in any language, this returns the same text in `locale`; anything else (real events, user
 * input, templates with parameters) is returned unchanged.
 */
export function localizeDemoText(text: string, locale: Locale): string {
  const key = DEMO_TEXT_LOOKUP.get(text);
  return key ? DEMO_SCRIPT[locale][key] : text;
}
