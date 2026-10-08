import { Agent, Artifact, Meeting, SocialActivity, Task, ViewerEvent } from '../types/agent';
import { INITIAL_AGENTS } from './officeModel';
import type { RoomReservation } from './livingOfficeEngine';
import {
  playAlert,
  playMeetingGong,
  playMessageBlip,
  playTaskComplete,
  playTaskStart,
} from './soundEffects';

export interface DemoStep {
  id: number;
  durationMs: number;
  title: string;
  description: string;
  execute: (state: SimulationState) => void;
}

export interface SimulationState {
  agents: Agent[];
  tasks: Task[];
  meetings: Meeting[];
  events: ViewerEvent[];
  activeMeetingId: string | null;
  roomReservations: RoomReservation[];
  socialActivities: SocialActivity[];
  coffeeSeatAssignments: Array<{ seatId: string; agentId: string }>;
  totalTokens: {
    input: number;
    output: number;
    cached: number;
    reasoning: number;
  };
  totalCost: number;
}

export function createInitialSimulationState(agents: Agent[] = INITIAL_AGENTS): SimulationState {
  return {
    agents: agents.map((a) => ({ ...a })),
    tasks: [],
    meetings: [],
    events: [
      {
        id: 'evt-init',
        type: 'agent.status.changed',
        timestamp: Date.now() - 1000 * 60 * 10,
        source: 'system',
        severity: 'low',
        summary: 'Equipo de Automatización RPA UiPath & BA listo en oficinas.',
        payload: { agentCount: agents.length },
      },
    ],
    activeMeetingId: null,
    roomReservations: [],
    socialActivities: [],
    coffeeSeatAssignments: [],
    totalTokens: {
      input: 179300,
      output: 43300,
      cached: 93900,
      reasoning: 16800,
    },
    totalCost: 0.881,
  };
}

/**
 * Creates a clean, empty state for real live multi-agent streaming mode.
 * Contains 0 seeded agents, 0 synthetic tokens, 0 synthetic cost.
 */
export function createLiveSimulationState(): SimulationState {
  return {
    agents: [],
    tasks: [],
    meetings: [],
    events: [],
    activeMeetingId: null,
    roomReservations: [],
    socialActivities: [],
    coffeeSeatAssignments: [],
    totalTokens: {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
    },
    totalCost: 0,
  };
}

// 12-Step UiPath RPA & BA Banking Automation Scenario (Total: 25.5s)
export const DEMO_STEPS: DemoStep[] = [
  {
    id: 0,
    durationMs: 2100,
    title: '1. Recepción de Insumos del Cliente (Video, 2 PDFs, Word, 2 Webs Bancarias)',
    description: 'Valeria (Ventas) y Carlos (Jefe RPA) reciben en Boss Office el requerimiento bancario: 1 Video, 2 PDFs de extractos, 1 Word y 2 webs de bancos.',
    execute: (s) => {
      const boss = s.agents.find((a) => a.id === 'boss');
      const sales = s.agents.find((a) => a.id === 'sales-lead');

      if (sales) {
        sales.status = 'CHATTING';
        sales.statusText = 'Presentando requerimiento del cliente';
        sales.speechBubble = {
          text: '¡Cliente envió Video, 2 PDFs, Word y 2 webs bancarias para automatizar conciliación!',
          expiresAt: Date.now() + 2500,
        };
      }
      if (boss) {
        boss.status = 'THINKING';
        boss.statusText = 'Planificando solución RPA UiPath end-to-end';
        boss.speechBubble = {
          text: 'Recibido. Convocando kickoff inmediato con Arquitectura y Business Analysis.',
          expiresAt: Date.now() + 2500,
        };
      }

      const newTask: Task = {
        id: 'TASK-RPA-BANK',
        title: 'Automatización Bancaria UiPath End-to-End',
        description: 'Construir solución RPA completa: PDD, SDD, Estimación, BPMN, Arquitectura, Cotización, Gantt, Resumen y Presentación HTML interactiva.',
        initiatorId: 'sales-lead',
        assignedAgentId: 'boss',
        collaboratorIds: ['boss', 'tech-lead', 'research-lead', 'backend-agent', 'frontend-agent', 'security-agent', 'ba-analyst-1', 'ba-analyst-2', 'qa-agent', 'sales-lead'],
        status: 'ASSIGNED',
        progress: 5,
        createdAt: Date.now(),
        tokensTotal: 3400,
        costTotal: 0.018,
        toolsUsed: ['client.intake(video_2pdfs_word_2web)'],
        artifacts: [],
      };
      s.tasks.unshift(newTask);
      s.events.unshift({
        id: `evt-${Date.now()}-0`,
        type: 'task.created',
        timestamp: Date.now(),
        source: 'agent:sales-lead',
        target: 'boss',
        taskId: newTask.id,
        severity: 'high',
        summary: 'TASK-RPA-BANK recibida: Video, 2 PDFs, Word y 2 webs de bancos para automatizar conciliación.',
        payload: { task: newTask },
      });
      playTaskStart();
    },
  },
  {
    id: 1,
    durationMs: 2200,
    title: '2. Kickoff de Alcance en Meeting Room A',
    description: 'Carlos (Jefe RPA), Alex (Arquitecto) y Dra. Maya (Líder BA) se reúnen en Meeting Room A para coordinar entregables.',
    execute: (s) => {
      const boss = s.agents.find((a) => a.id === 'boss');
      const techLead = s.agents.find((a) => a.id === 'tech-lead');
      const baLead = s.agents.find((a) => a.id === 'research-lead');

      if (boss) {
        boss.targetX = 10;
        boss.targetY = 3;
        boss.isWalking = true;
        boss.workspace = 'meeting_room';
        boss.status = 'IN_MEETING';
      }
      if (techLead) {
        techLead.targetX = 12;
        techLead.targetY = 3;
        techLead.isWalking = true;
        techLead.workspace = 'meeting_room';
        techLead.status = 'IN_MEETING';
        techLead.speechBubble = {
          text: 'Revisando video y webs de bancos. Diseñaremos Dispatcher y Performer en REFramework.',
          expiresAt: Date.now() + 2500,
        };
      }
      if (baLead) {
        baLead.targetX = 14;
        baLead.targetY = 3;
        baLead.isWalking = true;
        baLead.workspace = 'meeting_room';
        baLead.status = 'IN_MEETING';
      }

      const meeting: Meeting = {
        id: 'MEET-KICKOFF',
        title: 'Kickoff Solución RPA Bancaria',
        topic: 'Desglose de entregables: PDD, SDD, Estimación, BPMN y Cotización',
        taskId: 'TASK-RPA-BANK',
        initiatorId: 'boss',
        participants: ['boss', 'tech-lead', 'research-lead'],
        status: 'ACTIVE',
        roomId: 'meeting_room',
        startedAt: Date.now(),
        tokensAccumulated: 8900,
        costAccumulated: 0.048,
        agenda: ['Revisión Video', 'Extracción 2 PDFs', 'Estructura REFramework'],
        decisions: ['BA generará PDD en Library', 'Arquitectura definirá SDD en Meeting Room B'],
        tasksCreated: ['SUB-PDD', 'SUB-SDD'],
        messages: [],
      };
      s.meetings.unshift(meeting);
      s.activeMeetingId = meeting.id;

      s.events.unshift({
        id: `evt-${Date.now()}-1`,
        type: 'meeting.started',
        timestamp: Date.now(),
        source: 'agent:boss',
        taskId: 'TASK-RPA-BANK',
        severity: 'normal',
        summary: 'Kickoff iniciado en Meeting Room A: Definición de plan de entregables RPA.',
        payload: { meetingId: meeting.id, roomId: 'meeting_room' },
      });
      playMeetingGong();
    },
  },
  {
    id: 2,
    durationMs: 2100,
    title: '3. Research Library: Extracción Documental & Creación del PDD',
    description: 'Dra. Maya, Sofía y Andrés analizan el Video, los 2 PDFs y el Word en la Library y compilan el Process Definition Document.',
    execute: (s) => {
      const baLead = s.agents.find((a) => a.id === 'research-lead');
      const ba1 = s.agents.find((a) => a.id === 'ba-analyst-1');
      const ba2 = s.agents.find((a) => a.id === 'ba-analyst-2');

      if (baLead) {
        baLead.targetX = 3;
        baLead.targetY = 14;
        baLead.isWalking = true;
        baLead.workspace = 'research_area';
        baLead.status = 'RESEARCHING';
        baLead.currentTool = 'uipath.document_understanding';
      }
      if (ba1) {
        ba1.status = 'RESEARCHING';
        ba1.currentTool = 'ocr.pdf_extractor(2_banco_pdfs)';
        ba1.speechBubble = {
          text: 'Extraídos 28 campos clave del Word y PDFs bancarios. PDD v1.0 listo.',
          expiresAt: Date.now() + 2500,
        };
      }
      if (ba2) {
        ba2.status = 'WRITING';
        ba2.currentTool = 'doc.compiler(PDD_Process_Definition)';
      }

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.progress = 20;
        task.artifacts.push({
          id: 'art-pdd',
          name: 'PDD - Process Definition Document v1.0',
          type: 'report',
          summary: 'Documento formal de definición de proceso bancario con reglas de negocio y campos OCR.',
          timestamp: Date.now(),
          authorId: 'ba-analyst-1',
        });
      }

      s.events.unshift({
        id: `evt-${Date.now()}-2`,
        type: 'artifact.created',
        timestamp: Date.now(),
        source: 'agent:ba-analyst-1',
        taskId: 'TASK-RPA-BANK',
        severity: 'high',
        summary: 'PDD (Process Definition Document) generado con éxito en Research Library.',
        payload: { artifactId: 'art-pdd', pages: 34 },
      });
      playMessageBlip();
    },
  },
  {
    id: 3,
    durationMs: 2000,
    title: '4. Leads Studio: Diagramas BPMN & Estimación de Esfuerzo',
    description: 'En Leads Area se modelan los diagramas de flujo As-Is / To-Be y se calcula la estimación de esfuerzo en story points.',
    execute: (s) => {
      const techLead = s.agents.find((a) => a.id === 'tech-lead');
      const ba2 = s.agents.find((a) => a.id === 'ba-analyst-2');

      if (techLead) {
        techLead.targetX = 2;
        techLead.targetY = 9;
        techLead.isWalking = true;
        techLead.workspace = 'leads_area';
        techLead.status = 'WRITING';
        techLead.currentTool = 'estimation.sizing_matrix';
      }
      if (ba2) {
        ba2.targetX = 4;
        ba2.targetY = 9;
        ba2.isWalking = true;
        ba2.workspace = 'leads_area';
        ba2.status = 'CODING';
        ba2.currentTool = 'bpmn.modeler(as_is_to_be)';
        ba2.speechBubble = {
          text: 'Diagramas BPMN listos: 3 caminos felices y 8 excepciones de negocio bancarias.',
          expiresAt: Date.now() + 2500,
        };
      }

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.progress = 35;
        task.artifacts.push({
          id: 'art-bpmn',
          name: 'Diagramas de Flujo BPMN As-Is & To-Be',
          type: 'architecture',
          summary: 'Mapeo detallado de procesos bancarios en estándar BPMN 2.0 con bifurcaciones de error.',
          timestamp: Date.now(),
          authorId: 'ba-analyst-2',
        });
        task.artifacts.push({
          id: 'art-estimacion',
          name: 'Estimación de Esfuerzo & Sizing',
          type: 'report',
          summary: 'Matriz de complejidad: 42 historias de usuario, 85 Story Points en 3 Sprints.',
          timestamp: Date.now(),
          authorId: 'tech-lead',
        });
      }

      s.events.unshift({
        id: `evt-${Date.now()}-3`,
        type: 'task.progress',
        timestamp: Date.now(),
        source: 'agent:tech-lead',
        taskId: 'TASK-RPA-BANK',
        severity: 'normal',
        summary: 'Diagramas BPMN y Estimación de Esfuerzo completados en Leads Studio.',
        payload: { progress: 35, storyPoints: 85 },
      });
      playMessageBlip();
    },
  },
  {
    id: 4,
    durationMs: 2100,
    title: '5. Meeting Room B (War Room): Arquitectura UiPath & SDD',
    description: 'Alex (Arquitecto) y los 3 analistas de desarrollo RPA se reúnen en Meeting Room B para definir REFramework y el SDD.',
    execute: (s) => {
      const techLead = s.agents.find((a) => a.id === 'tech-lead');
      const dev1 = s.agents.find((a) => a.id === 'backend-agent');
      const dev2 = s.agents.find((a) => a.id === 'frontend-agent');
      const dev3 = s.agents.find((a) => a.id === 'security-agent');

      if (techLead) {
        techLead.targetX = 19;
        techLead.targetY = 3;
        techLead.isWalking = true;
        techLead.workspace = 'meeting_room_b';
        techLead.status = 'IN_MEETING';
        techLead.speechBubble = {
          text: 'SDD aprobado: Arquitectura Dispatcher-Performer con colas transaccionales y REFramework.',
          expiresAt: Date.now() + 2500,
        };
      }
      if (dev1) {
        dev1.targetX = 20;
        dev1.targetY = 2;
        dev1.isWalking = true;
        dev1.workspace = 'meeting_room_b';
        dev1.status = 'IN_MEETING';
      }
      if (dev2) {
        dev2.targetX = 21;
        dev2.targetY = 3;
        dev2.isWalking = true;
        dev2.workspace = 'meeting_room_b';
        dev2.status = 'IN_MEETING';
      }
      if (dev3) {
        dev3.targetX = 22;
        dev3.targetY = 2;
        dev3.isWalking = true;
        dev3.workspace = 'meeting_room_b';
        dev3.status = 'IN_MEETING';
      }

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.progress = 50;
        task.artifacts.push({
          id: 'art-sdd',
          name: 'SDD - Solution Design Document (UiPath REFramework)',
          type: 'architecture',
          summary: 'Diseño técnico de la solución UiPath: Dispatcher, Performer, Queues y manejo de excepciones.',
          timestamp: Date.now(),
          authorId: 'tech-lead',
        });
        task.artifacts.push({
          id: 'art-arquitectura',
          name: 'Arquitectura Técnica UiPath REFramework',
          type: 'architecture',
          summary: 'Blueprint de integración con Azure Key Vault, Orchestrator y webs bancarias.',
          timestamp: Date.now(),
          authorId: 'tech-lead',
        });
      }

      s.events.unshift({
        id: `evt-${Date.now()}-4`,
        type: 'meeting.decision',
        timestamp: Date.now(),
        source: 'agent:tech-lead',
        taskId: 'TASK-RPA-BANK',
        severity: 'high',
        summary: 'SDD y Arquitectura UiPath aprobados en Meeting Room B.',
        payload: { sddVersion: '1.0', framework: 'REFramework' },
      });
      playMeetingGong();
    },
  },
  {
    id: 5,
    durationMs: 2200,
    title: '6. Development Pods: Codificación en UiPath Studio',
    description: 'Lucas, Kenji y Mateo desarrollan los workflows XAML automatizando ambas páginas web bancarias y el REFramework.',
    execute: (s) => {
      const dev1 = s.agents.find((a) => a.id === 'backend-agent');
      const dev2 = s.agents.find((a) => a.id === 'frontend-agent');
      const dev3 = s.agents.find((a) => a.id === 'security-agent');

      if (dev1) {
        dev1.targetX = 8;
        dev1.targetY = 10;
        dev1.isWalking = true;
        dev1.workspace = 'development';
        dev1.status = 'CODING';
        dev1.currentTool = 'uipath.studio(dispatcher_web_navigation)';
        dev1.speechBubble = {
          text: 'Selectores Fuzzy y navegación web listos en ambos bancos (Santander & Chile).',
          expiresAt: Date.now() + 2500,
        };
      }
      if (dev2) {
        dev2.targetX = 12;
        dev2.targetY = 10;
        dev2.isWalking = true;
        dev2.workspace = 'development';
        dev2.status = 'CODING';
        dev2.currentTool = 'uipath.studio(performer_re_framework)';
      }
      if (dev3) {
        dev3.targetX = 16;
        dev3.targetY = 10;
        dev3.isWalking = true;
        dev3.workspace = 'development';
        dev3.status = 'CODING';
        dev3.currentTool = 'uipath.du(intelligent_form_extractor)';
      }

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.progress = 65;
        task.tokensTotal += 18500;
        task.costTotal += 0.092;
      }

      s.events.unshift({
        id: `evt-${Date.now()}-5`,
        type: 'tool.started',
        timestamp: Date.now(),
        source: 'agent:backend-agent',
        taskId: 'TASK-RPA-BANK',
        severity: 'normal',
        summary: 'UiPath Studio: Dispatcher y Performer implementados para las 2 plataformas bancarias.',
        payload: { modules: ['Dispatcher.xaml', 'Performer.xaml', 'ProcessTransaction.xaml'] },
      });
      playMessageBlip();
    },
  },
  {
    id: 6,
    durationMs: 2000,
    title: '7. QA Lab: Pruebas de Estrés y Certificación Bancaria',
    description: 'Zoe Vance (QA) y Mateo Silva ejecutan en el QA Lab 1,000 transacciones simuladas sin errores.',
    execute: (s) => {
      const qa = s.agents.find((a) => a.id === 'qa-agent');
      const dev3 = s.agents.find((a) => a.id === 'security-agent');

      if (qa) {
        qa.targetX = 20;
        qa.targetY = 10;
        qa.isWalking = false;
        qa.workspace = 'qa_lab';
        qa.status = 'TESTING';
        qa.currentTool = 'uipath.test_suite(regression_banking_1000_tx)';
        qa.speechBubble = {
          text: '1,000 transacciones probadas: 0 excepciones de sistema, 100% de éxito bancario.',
          expiresAt: Date.now() + 2500,
        };
      }
      if (dev3) {
        dev3.targetX = 22;
        dev3.targetY = 10;
        dev3.isWalking = true;
        dev3.workspace = 'qa_lab';
        dev3.status = 'TESTING';
        dev3.currentTool = 'security.scan(banking_tokens_compliance)';
      }

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.progress = 75;
        task.artifacts.push({
          id: 'art-qa',
          name: 'Matriz de Pruebas & Certificación QA Bancaria',
          type: 'test_run',
          summary: 'Certificación de 1,000 transacciones: 0 fallos, tolerancia a caídas de red y reintentos automáticos.',
          timestamp: Date.now(),
          authorId: 'qa-agent',
        });
      }

      s.events.unshift({
        id: `evt-${Date.now()}-6`,
        type: 'tool.completed',
        timestamp: Date.now(),
        source: 'agent:qa-agent',
        taskId: 'TASK-RPA-BANK',
        severity: 'high',
        summary: 'Certificación QA Bancaria exitosa: 1,000 transacciones validadas en QA Lab.',
        payload: { passed: 1000, failed: 0, coverage: '100%' },
      });
      playMessageBlip();
    },
  },
  {
    id: 7,
    durationMs: 2000,
    title: '8. Server Room / Model Ops: UiPath Orchestrator & Telemetría',
    description: 'Alex y Lucas configuran en Server Room el clúster de UiPath Orchestrator y aprovisionan 4 Robots Unattended.',
    execute: (s) => {
      const techLead = s.agents.find((a) => a.id === 'tech-lead');
      const dev1 = s.agents.find((a) => a.id === 'backend-agent');

      if (techLead) {
        techLead.targetX = 18;
        techLead.targetY = 7;
        techLead.isWalking = true;
        techLead.workspace = 'server_room';
        techLead.status = 'USING_TOOL';
        techLead.currentTool = 'orchestrator.deploy(unattended_robots_cluster)';
        techLead.speechBubble = {
          text: 'UiPath Orchestrator configurado: 4 Robots Unattended listos en alta disponibilidad.',
          expiresAt: Date.now() + 2500,
        };
      }
      if (dev1) {
        dev1.targetX = 19;
        dev1.targetY = 8;
        dev1.isWalking = true;
        dev1.workspace = 'server_room';
        dev1.status = 'USING_TOOL';
        dev1.currentTool = 'telemetry.sync(assets_vault)';
      }

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.progress = 80;
        task.artifacts.push({
          id: 'art-orchestrator',
          name: 'Topología Orchestrator & Provisioning de Robots',
          type: 'code',
          summary: 'Configuración de 4 Robots Unattended, Colas Transaccionales y SLA de 4 horas.',
          timestamp: Date.now(),
          authorId: 'tech-lead',
        });
      }

      s.events.unshift({
        id: `evt-${Date.now()}-7`,
        type: 'tool.completed',
        timestamp: Date.now(),
        source: 'agent:tech-lead',
        taskId: 'TASK-RPA-BANK',
        severity: 'normal',
        summary: 'UiPath Orchestrator aprovisionado con 4 Robots Unattended en Server Room.',
        payload: { robots: 4, cluster: 'High-Availability' },
      });
      playMessageBlip();
    },
  },
  {
    id: 8,
    durationMs: 2000,
    title: '9. Cafeteria & Team Lounge: Coffee Break de Sincronización',
    description: 'El equipo se reúne en la Cafetería y Team Lounge para un receso mientras Ventas consolida la propuesta económica.',
    execute: (s) => {
      const dev2 = s.agents.find((a) => a.id === 'frontend-agent');
      const ba1 = s.agents.find((a) => a.id === 'ba-analyst-1');
      const ba2 = s.agents.find((a) => a.id === 'ba-analyst-2');
      const dev1 = s.agents.find((a) => a.id === 'backend-agent');

      if (dev2) {
        dev2.targetX = 11;
        dev2.targetY = 14;
        dev2.isWalking = true;
        dev2.workspace = 'break_room';
        dev2.status = 'COFFEE_BREAK';
      }
      if (dev1) {
        dev1.targetX = 14;
        dev1.targetY = 14;
        dev1.isWalking = true;
        dev1.workspace = 'break_room';
        dev1.status = 'COFFEE_BREAK';
      }
      if (ba1) {
        ba1.targetX = 19;
        ba1.targetY = 14;
        ba1.isWalking = true;
        ba1.workspace = 'break_room';
        ba1.status = 'CHATTING';
        ba1.speechBubble = {
          text: '¡Excelente coordinación! El PDD y el SDD están listos para la cotización.',
          expiresAt: Date.now() + 2500,
        };
      }
      if (ba2) {
        ba2.targetX = 21;
        ba2.targetY = 14;
        ba2.isWalking = true;
        ba2.workspace = 'break_room';
        ba2.status = 'CHATTING';
      }

      s.events.unshift({
        id: `evt-${Date.now()}-8`,
        type: 'social.started',
        timestamp: Date.now(),
        source: 'system',
        severity: 'low',
        summary: 'Equipo sincroniza en Cafetería y Team Lounge durante el descanso técnico.',
        payload: { zone: 'break_room_and_lounge' },
      });
    },
  },
  {
    id: 9,
    durationMs: 2200,
    title: '10. Secret Floor (Piso 2): Cotización Económica & Carta Gantt',
    description: 'Valeria (Ventas), Carlos (Jefe RPA) y Dra. Maya suben al Piso 2 para calcular la cotización y la Carta Gantt.',
    execute: (s) => {
      const sales = s.agents.find((a) => a.id === 'sales-lead');
      const boss = s.agents.find((a) => a.id === 'boss');
      const baLead = s.agents.find((a) => a.id === 'research-lead');

      if (sales) {
        sales.floor = 2;
        sales.workspace = 'overflow_floor';
        sales.targetX = 10;
        sales.targetY = 8;
        sales.isWalking = true;
        sales.status = 'WRITING';
        sales.currentTool = 'pricing.calculator(roi_analysis)';
        sales.speechBubble = {
          text: 'Cotización cerrada: $48.5K USD con ROI en 4 meses y Carta Gantt de 6 semanas.',
          expiresAt: Date.now() + 2500,
        };
      }
      if (boss) {
        boss.floor = 2;
        boss.workspace = 'overflow_floor';
        boss.targetX = 12;
        boss.targetY = 8;
        boss.isWalking = true;
        boss.status = 'IN_MEETING';
      }
      if (baLead) {
        baLead.floor = 2;
        baLead.workspace = 'overflow_floor';
        baLead.targetX = 14;
        baLead.targetY = 8;
        baLead.isWalking = true;
        baLead.status = 'IN_MEETING';
        baLead.currentTool = 'gantt.timeline_builder';
      }

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.progress = 90;
        task.artifacts.push({
          id: 'art-cotizacion',
          name: 'Cotización Económica & Análisis de ROI',
          type: 'report',
          summary: 'Inversión: $48,500 USD. Ahorro anual estimado: $165,000 USD (ROI de 340% en 6 meses).',
          timestamp: Date.now(),
          authorId: 'sales-lead',
        });
        task.artifacts.push({
          id: 'art-gantt',
          name: 'Carta Gantt - Cronograma de Implementación (6 Semanas)',
          type: 'report',
          summary: 'Cronograma detallado con fases de Sprint 1, 2, 3, UAT bancario y pase a producción.',
          timestamp: Date.now(),
          authorId: 'research-lead',
        });
      }

      s.events.unshift({
        id: `evt-${Date.now()}-9`,
        type: 'task.progress',
        timestamp: Date.now(),
        source: 'agent:sales-lead',
        taskId: 'TASK-RPA-BANK',
        severity: 'high',
        summary: 'Cotización Económica y Carta Gantt completadas en el Segundo Piso (Overflow Floor).',
        payload: { cotizacionUSD: 48500, semanasGantt: 6 },
      });
      playMessageBlip();
    },
  },
  {
    id: 10,
    durationMs: 2200,
    title: '11. Boss Office: Resumen Ejecutivo y Presentación HTML',
    description: 'El equipo directivo compila el Resumen Ejecutivo y genera la Presentación Interactiva en HTML consolidando todo.',
    execute: (s) => {
      const boss = s.agents.find((a) => a.id === 'boss');
      const sales = s.agents.find((a) => a.id === 'sales-lead');
      const techLead = s.agents.find((a) => a.id === 'tech-lead');
      const baLead = s.agents.find((a) => a.id === 'research-lead');

      if (boss) {
        boss.floor = 1;
        boss.targetX = 3;
        boss.targetY = 3;
        boss.isWalking = true;
        boss.workspace = 'boss_office';
        boss.status = 'WRITING';
        boss.currentTool = 'html.compiler(interactive_rpa_proposal_deck)';
        boss.speechBubble = {
          text: 'Compilando la presentación interactiva HTML con todos los entregables para el cliente.',
          expiresAt: Date.now() + 2500,
        };
      }
      if (sales) {
        sales.floor = 1;
        sales.targetX = 5;
        sales.targetY = 3;
        sales.isWalking = true;
        sales.workspace = 'boss_office';
        sales.status = 'AVAILABLE';
      }
      if (techLead) {
        techLead.targetX = 2;
        techLead.targetY = 9;
        techLead.isWalking = true;
        techLead.workspace = 'leads_area';
        techLead.status = 'REVIEWING';
      }
      if (baLead) {
        baLead.floor = 1;
        baLead.targetX = 4;
        baLead.targetY = 9;
        baLead.isWalking = true;
        baLead.workspace = 'leads_area';
        baLead.status = 'REVIEWING';
      }

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.progress = 98;
        task.artifacts.push({
          id: 'art-resumen',
          name: 'Resumen Ejecutivo de la Solución RPA Bancaria',
          type: 'report',
          summary: 'One-pager gerencial resumiendo alcance, beneficios de negocio, seguridad y ROI.',
          timestamp: Date.now(),
          authorId: 'boss',
        });
        task.artifacts.push({
          id: 'art-html-deck',
          name: 'Presentación Ejecutiva Interactiva HTML',
          type: 'code',
          summary: 'Deck interactivo en HTML responsive con PDD, SDD, diagramas BPMN, Gantt y cotización.',
          timestamp: Date.now(),
          authorId: 'boss',
        });
      }

      s.events.unshift({
        id: `evt-${Date.now()}-10`,
        type: 'artifact.created',
        timestamp: Date.now(),
        source: 'agent:boss',
        taskId: 'TASK-RPA-BANK',
        severity: 'high',
        summary: 'Presentación Interactiva HTML y Resumen Ejecutivo compilados en Boss Office.',
        payload: { artifacts: ['art-resumen', 'art-html-deck'] },
      });
      playMessageBlip();
    },
  },
  {
    id: 11,
    durationMs: 2200,
    title: '12. Gran Cierre: Entrega Exitosa de la Propuesta Completa',
    description: 'Todos los agentes regresan a sus puestos. La tarea se completa al 100% con los 9 artefactos entregados.',
    execute: (s) => {
      s.agents.forEach((agent) => {
        agent.floor = 1;
        agent.isWalking = false;
        agent.status = 'IDLE';
        agent.currentTool = null;
      });

      const boss = s.agents.find((a) => a.id === 'boss');
      if (boss) {
        boss.x = 3;
        boss.y = 3;
        boss.targetX = 3;
        boss.targetY = 3;
        boss.speechBubble = {
          text: '¡Entrega completada! PDD, SDD, BPMN, Arquitectura, Cotización, Gantt y HTML listos.',
          expiresAt: Date.now() + 3000,
        };
      }

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.status = 'COMPLETED';
        task.progress = 100;
        task.completedAt = Date.now();
        task.tokensTotal = 92400;
        task.costTotal = 0.582;
      }

      s.events.unshift({
        id: `evt-${Date.now()}-11`,
        type: 'task.completed',
        timestamp: Date.now(),
        source: 'agent:boss',
        taskId: 'TASK-RPA-BANK',
        severity: 'high',
        summary: 'TASK-RPA-BANK completada con éxito: 9 entregables generados en 25.5 segundos.',
        payload: {
          artifactsCount: 9,
          totalTokens: 92400,
          totalCost: 0.582,
          deliverables: ['PDD', 'SDD', 'Estimación', 'BPMN', 'Arquitectura UiPath', 'Cotización', 'Gantt', 'Resumen', 'Presentación HTML'],
        },
      });
      playTaskComplete();
    },
  },
];

// Helper to launch a custom prompt/task simulation
export function triggerCustomTaskSimulation(
  state: SimulationState,
  title: string,
  description: string,
  assignedRole: 'backend_engineer' | 'frontend_engineer' | 'research_lead' | 'qa_engineer' | 'security_analyst'
): Task {
  const targetAgent = state.agents.find((a) => a.role === assignedRole) || state.agents[3];
  const boss = state.agents.find((a) => a.id === 'boss');

  const taskId = `TASK-${Math.floor(100 + Math.random() * 900)}`;
  const newTask: Task = {
    id: taskId,
    title,
    description,
    initiatorId: 'boss',
    assignedAgentId: targetAgent.id,
    collaboratorIds: [targetAgent.id, 'tech-lead', 'qa-agent'],
    status: 'IN_PROGRESS',
    progress: 10,
    createdAt: Date.now(),
    tokensTotal: 4200,
    costTotal: 0.024,
    toolsUsed: ['fs.read', 'llm.completion'],
    artifacts: [],
  };

  state.tasks.unshift(newTask);

  if (boss) {
    boss.speechBubble = {
      text: `Dispatching ${taskId}: "${title}" to ${targetAgent.name}.`,
      expiresAt: Date.now() + 4000,
    };
  }

  targetAgent.status = 'CODING';
  targetAgent.statusText = `Executing ${taskId}: ${title}`;
  targetAgent.currentTaskId = taskId;
  targetAgent.tokensInput += 4200;
  targetAgent.tokensOutput += 850;
  targetAgent.cost += 0.024;
  targetAgent.speechBubble = {
    text: `Received assignment: ${title}. Starting execution now.`,
    expiresAt: Date.now() + 4000,
  };

  state.totalTokens.input += 4200;
  state.totalTokens.output += 850;
  state.totalCost += 0.024;

  state.events.unshift({
    id: `evt-custom-${Date.now()}`,
    type: 'task.assigned',
    timestamp: Date.now(),
    source: 'boss',
    target: targetAgent.id,
    taskId,
    severity: 'high',
    summary: `Task ${taskId} initiated: "${title}" assigned to ${targetAgent.name}.`,
    payload: { title, description },
  });

  playTaskStart();
  return newTask;
}
