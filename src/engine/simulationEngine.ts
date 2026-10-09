import { Agent, Meeting, Task, WorkspaceZone } from '../types/agent';
import { INITIAL_AGENTS } from './officeModel';
import type { SimulationState } from './officeState';
import { emptyUsageTally } from '../integrations/usageTally';
export { createLiveSimulationState, type SimulationState } from './officeState';
import { AGENT_DESK_ANCHORS, MEETING_ROOM_POLICIES, WORKSPACE_ANCHORS, routeAgent } from './livingOfficeEngine';
import { DEMO_SCRIPT, demoText, type DemoScriptKey } from '../content/demoScript';
import { livingOfficeText } from '../content/livingOfficeMessages';
import type { Locale } from '../i18n';
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

/** Built-in demo texts of one agent (`agent.<id>.roleTitle` and `agent.<id>.statusText`), when it has them. */
function demoAgentKey(agentId: string, field: 'roleTitle' | 'statusText'): DemoScriptKey | null {
  const key = `agent.${agentId}.${field}`;
  return Object.prototype.hasOwnProperty.call(DEMO_SCRIPT.en, key) ? (key as DemoScriptKey) : null;
}

/** Copies the agents and writes the role title and status text of the demo team in `locale`. */
export function localizeDemoAgents(agents: Agent[], locale: Locale): Agent[] {
  return agents.map((agent) => {
    const roleKey = demoAgentKey(agent.id, 'roleTitle');
    const statusKey = demoAgentKey(agent.id, 'statusText');
    return {
      ...agent,
      roleTitle: roleKey ? demoText(locale, roleKey) : agent.roleTitle,
      statusText: statusKey ? demoText(locale, statusKey) : agent.statusText,
    };
  });
}

export function createInitialSimulationState(agents: Agent[] = INITIAL_AGENTS, locale: Locale = 'en'): SimulationState {
  return {
    agents: localizeDemoAgents(agents, locale),
    tasks: [],
    meetings: [],
    events: [
      {
        id: 'evt-init',
        type: 'agent.status.changed',
        timestamp: Date.now() - 1000 * 60 * 10,
        source: 'system',
        severity: 'low',
        summary: demoText(locale, 'init.event'),
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
    usage: emptyUsageTally(),
  };
}

/** Sends an agent walking to a spot of the main floor; the living office engine completes the walk. */
function walkTo(agent: Agent, x: number, y: number, workspace: WorkspaceZone, now = Date.now()): void {
  agent.floor = 1;
  agent.workspace = workspace;
  agent.targetX = x;
  agent.targetY = y;
  const distance = Math.hypot(agent.x - x, agent.y - y);
  agent.isWalking = distance > 0.15;
  if (agent.isWalking) {
    agent.travelStartedAt = now;
    agent.travelDurationMs = Math.max(900, Math.min(4500, distance * 350));
  } else {
    agent.travelStartedAt = undefined;
    agent.travelDurationMs = undefined;
  }
}

/** Seats an agent in a visible meeting room, so "In a meeting" always matches where it is drawn. */
function seatInMeetingRoom(agent: Agent, roomId: 'meeting_room' | 'meeting_room_b', seatIndex: number): void {
  const room = MEETING_ROOM_POLICIES.find((policy) => policy.id === roomId);
  const seat = room?.seats[seatIndex % room.seats.length] ?? WORKSPACE_ANCHORS[roomId];
  walkTo(agent, seat.x, seat.y, roomId);
  agent.status = 'IN_MEETING';
}

/** Puts an agent on the secret second floor right away: the floor view shows it there. */
function moveToSecondFloor(agent: Agent, x: number, y: number): void {
  agent.floor = 2;
  agent.workspace = 'overflow_floor';
  agent.x = x;
  agent.y = y;
  agent.targetX = x;
  agent.targetY = y;
  agent.isWalking = false;
  agent.travelStartedAt = undefined;
  agent.travelDurationMs = undefined;
}

/** Brings an agent back from the second floor through the secret door and walks it to `x`, `y`. */
function returnToMainFloor(agent: Agent, x: number, y: number, workspace: WorkspaceZone): void {
  if ((agent.floor ?? 1) === 2) {
    const door = WORKSPACE_ANCHORS.overflow_floor;
    agent.x = door.x;
    agent.y = door.y;
  }
  walkTo(agent, x, y, workspace);
}

function concludeMeeting(s: SimulationState, meetingId: string): void {
  const meeting = s.meetings.find((item) => item.id === meetingId);
  if (meeting && meeting.status !== 'CONCLUDED') {
    meeting.status = 'CONCLUDED';
    meeting.endedAt = Date.now();
  }
  s.roomReservations = s.roomReservations.filter((reservation) => reservation.meetingId !== meetingId);
  if (s.activeMeetingId === meetingId) s.activeMeetingId = null;
}

/** Sends an agent back to its own desk. */
function backToDesk(agent: Agent, status: Agent['status']): void {
  const desk = AGENT_DESK_ANCHORS[agent.id];
  if (desk) returnToMainFloor(agent, desk.x, desk.y, desk.workspace);
  agent.status = status;
}

// 12-Step UiPath RPA & BA Banking Automation Scenario (Total: 25.5s)
/**
 * The demo script in the given language. Every text it writes (step titles, bubbles, status texts, tasks,
 * artifacts, meetings and event summaries) comes from `src/content/demoScript.ts`.
 */
export function createDemoSteps(locale: Locale = 'en'): DemoStep[] {
  const tx = (key: DemoScriptKey, params?: Record<string, string | number>) => demoText(locale, key, params);
  const find = (s: SimulationState, id: string) => s.agents.find((a) => a.id === id);
  const bubble = (key: DemoScriptKey, ms = 2500) => ({ text: tx(key), expiresAt: Date.now() + ms });

  return [
  {
    id: 0,
    durationMs: 2100,
    title: tx('step.0.title'),
    description: tx('step.0.description'),
    execute: (s) => {
      const boss = find(s, 'boss');
      const sales = find(s, 'sales-lead');

      if (sales) {
        sales.status = 'CHATTING';
        sales.statusText = tx('step.0.sales.statusText');
        sales.speechBubble = bubble('step.0.sales.bubble');
      }
      if (boss) {
        boss.status = 'THINKING';
        boss.statusText = tx('step.0.boss.statusText');
        boss.speechBubble = bubble('step.0.boss.bubble');
      }

      const newTask: Task = {
        id: 'TASK-RPA-BANK',
        title: tx('step.0.task.title'),
        description: tx('step.0.task.description'),
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
        summary: tx('step.0.event'),
        payload: { task: newTask },
      });
      playTaskStart();
    },
  },
  {
    id: 1,
    durationMs: 2200,
    title: tx('step.1.title'),
    description: tx('step.1.description'),
    execute: (s) => {
      const boss = find(s, 'boss');
      const techLead = find(s, 'tech-lead');
      const baLead = find(s, 'research-lead');

      // Everyone shown "In a meeting" sits in Meeting Room A.
      if (boss) seatInMeetingRoom(boss, 'meeting_room', 0);
      if (techLead) {
        seatInMeetingRoom(techLead, 'meeting_room', 1);
        techLead.speechBubble = bubble('step.1.techLead.bubble');
      }
      if (baLead) seatInMeetingRoom(baLead, 'meeting_room', 2);

      const meeting: Meeting = {
        id: 'MEET-KICKOFF',
        title: tx('step.1.meeting.title'),
        topic: tx('step.1.meeting.topic'),
        taskId: 'TASK-RPA-BANK',
        initiatorId: 'boss',
        participants: ['boss', 'tech-lead', 'research-lead'],
        status: 'ACTIVE',
        roomId: 'meeting_room',
        startedAt: Date.now(),
        tokensAccumulated: 8900,
        costAccumulated: 0.048,
        agenda: [tx('step.1.meeting.agenda.0'), tx('step.1.meeting.agenda.1'), tx('step.1.meeting.agenda.2')],
        decisions: [tx('step.1.meeting.decision.0'), tx('step.1.meeting.decision.1')],
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
        summary: tx('step.1.event'),
        payload: { meetingId: meeting.id, roomId: 'meeting_room' },
      });
      playMeetingGong();
    },
  },
  {
    id: 2,
    durationMs: 2100,
    title: tx('step.2.title'),
    description: tx('step.2.description'),
    execute: (s) => {
      const boss = find(s, 'boss');
      const techLead = find(s, 'tech-lead');
      const baLead = find(s, 'research-lead');
      const ba1 = find(s, 'ba-analyst-1');
      const ba2 = find(s, 'ba-analyst-2');

      // The kickoff is over: nobody stays "In a meeting" once the room empties.
      concludeMeeting(s, 'MEET-KICKOFF');
      if (boss) backToDesk(boss, 'DELEGATING');
      if (techLead) backToDesk(techLead, 'THINKING');

      if (baLead) {
        walkTo(baLead, 3, 14, 'research_area');
        baLead.status = 'RESEARCHING';
        baLead.currentTool = 'uipath.document_understanding';
      }
      if (ba1) {
        ba1.status = 'RESEARCHING';
        ba1.currentTool = 'ocr.pdf_extractor(2_banco_pdfs)';
        ba1.speechBubble = bubble('step.2.ba1.bubble');
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
          name: tx('step.2.artifact.pdd.name'),
          type: 'report',
          summary: tx('step.2.artifact.pdd.summary'),
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
        summary: tx('step.2.event'),
        payload: { artifactId: 'art-pdd', pages: 34 },
      });
      playMessageBlip();
    },
  },
  {
    id: 3,
    durationMs: 2000,
    title: tx('step.3.title'),
    description: tx('step.3.description'),
    execute: (s) => {
      const techLead = find(s, 'tech-lead');
      const ba2 = find(s, 'ba-analyst-2');

      if (techLead) {
        walkTo(techLead, 2, 9, 'leads_area');
        techLead.status = 'WRITING';
        techLead.currentTool = 'estimation.sizing_matrix';
      }
      if (ba2) {
        walkTo(ba2, 4, 10, 'leads_area');
        ba2.status = 'CODING';
        ba2.currentTool = 'bpmn.modeler(as_is_to_be)';
        ba2.speechBubble = bubble('step.3.ba2.bubble');
      }

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.progress = 35;
        task.artifacts.push({
          id: 'art-bpmn',
          name: tx('step.3.artifact.bpmn.name'),
          type: 'architecture',
          summary: tx('step.3.artifact.bpmn.summary'),
          timestamp: Date.now(),
          authorId: 'ba-analyst-2',
        });
        task.artifacts.push({
          id: 'art-estimacion',
          name: tx('step.3.artifact.estimate.name'),
          type: 'report',
          summary: tx('step.3.artifact.estimate.summary'),
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
        summary: tx('step.3.event'),
        payload: { progress: 35, storyPoints: 85 },
      });
      playMessageBlip();
    },
  },
  {
    id: 4,
    durationMs: 2100,
    title: tx('step.4.title'),
    description: tx('step.4.description'),
    execute: (s) => {
      const techLead = find(s, 'tech-lead');
      const devs = ['backend-agent', 'frontend-agent', 'security-agent'].map((id) => find(s, id));

      // The architecture review happens inside Meeting Room B, one seat per participant.
      if (techLead) {
        seatInMeetingRoom(techLead, 'meeting_room_b', 0);
        techLead.speechBubble = bubble('step.4.techLead.bubble');
      }
      devs.forEach((dev, index) => {
        if (dev) seatInMeetingRoom(dev, 'meeting_room_b', index + 1);
      });

      const meeting: Meeting = {
        id: 'MEET-SDD',
        title: tx('step.4.meeting.title'),
        topic: tx('step.4.meeting.topic'),
        taskId: 'TASK-RPA-BANK',
        initiatorId: 'tech-lead',
        participants: ['tech-lead', 'backend-agent', 'frontend-agent', 'security-agent'],
        status: 'ACTIVE',
        roomId: 'meeting_room_b',
        startedAt: Date.now(),
        tokensAccumulated: 12400,
        costAccumulated: 0.067,
        agenda: [],
        decisions: [tx('step.4.techLead.bubble')],
        tasksCreated: [],
        messages: [],
      };
      s.meetings.unshift(meeting);
      s.activeMeetingId = meeting.id;

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.progress = 50;
        task.artifacts.push({
          id: 'art-sdd',
          name: tx('step.4.artifact.sdd.name'),
          type: 'architecture',
          summary: tx('step.4.artifact.sdd.summary'),
          timestamp: Date.now(),
          authorId: 'tech-lead',
        });
        task.artifacts.push({
          id: 'art-arquitectura',
          name: tx('step.4.artifact.architecture.name'),
          type: 'architecture',
          summary: tx('step.4.artifact.architecture.summary'),
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
        summary: tx('step.4.event'),
        payload: { meetingId: meeting.id, sddVersion: '1.0', framework: 'REFramework' },
      });
      playMeetingGong();
    },
  },
  {
    id: 5,
    durationMs: 2200,
    title: tx('step.5.title'),
    description: tx('step.5.description'),
    execute: (s) => {
      const techLead = find(s, 'tech-lead');
      const dev1 = find(s, 'backend-agent');
      const dev2 = find(s, 'frontend-agent');
      const dev3 = find(s, 'security-agent');

      concludeMeeting(s, 'MEET-SDD');
      if (techLead) backToDesk(techLead, 'REVIEWING');

      if (dev1) {
        walkTo(dev1, 8, 10, 'development');
        dev1.status = 'CODING';
        dev1.currentTool = 'uipath.studio(dispatcher_web_navigation)';
        dev1.speechBubble = bubble('step.5.dev1.bubble');
      }
      if (dev2) {
        walkTo(dev2, 12, 10, 'development');
        dev2.status = 'CODING';
        dev2.currentTool = 'uipath.studio(performer_re_framework)';
      }
      if (dev3) {
        walkTo(dev3, 16, 10, 'development');
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
        summary: tx('step.5.event'),
        payload: { modules: ['Dispatcher.xaml', 'Performer.xaml', 'ProcessTransaction.xaml'] },
      });
      playMessageBlip();
    },
  },
  {
    id: 6,
    durationMs: 2000,
    title: tx('step.6.title'),
    description: tx('step.6.description'),
    execute: (s) => {
      const qa = find(s, 'qa-agent');
      const dev3 = find(s, 'security-agent');

      if (qa) {
        walkTo(qa, 20, 10, 'qa_lab');
        qa.status = 'TESTING';
        qa.currentTool = 'uipath.test_suite(regression_banking_1000_tx)';
        qa.speechBubble = bubble('step.6.qa.bubble');
      }
      if (dev3) {
        walkTo(dev3, 22, 10, 'qa_lab');
        dev3.status = 'TESTING';
        dev3.currentTool = 'security.scan(banking_tokens_compliance)';
      }

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.progress = 75;
        task.artifacts.push({
          id: 'art-qa',
          name: tx('step.6.artifact.qa.name'),
          type: 'test_run',
          summary: tx('step.6.artifact.qa.summary'),
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
        summary: tx('step.6.event'),
        payload: { passed: 1000, failed: 0, coverage: '100%' },
      });
      playMessageBlip();
    },
  },
  {
    id: 7,
    durationMs: 2000,
    title: tx('step.7.title'),
    description: tx('step.7.description'),
    execute: (s) => {
      const techLead = find(s, 'tech-lead');
      const dev1 = find(s, 'backend-agent');

      // Both work inside the Model Ops room (grid rows 0 to 5), not in the QA lab below it.
      if (techLead) {
        walkTo(techLead, 19, 4, 'server_room');
        techLead.status = 'USING_TOOL';
        techLead.currentTool = 'orchestrator.deploy(unattended_robots_cluster)';
        techLead.speechBubble = bubble('step.7.techLead.bubble');
      }
      if (dev1) {
        walkTo(dev1, 21, 4.5, 'server_room');
        dev1.status = 'USING_TOOL';
        dev1.currentTool = 'telemetry.sync(assets_vault)';
      }

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.progress = 80;
        task.artifacts.push({
          id: 'art-orchestrator',
          name: tx('step.7.artifact.orchestrator.name'),
          type: 'code',
          summary: tx('step.7.artifact.orchestrator.summary'),
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
        summary: tx('step.7.event'),
        payload: { robots: 4, cluster: 'High-Availability' },
      });
      playMessageBlip();
    },
  },
  {
    id: 8,
    durationMs: 2000,
    title: tx('step.8.title'),
    description: tx('step.8.description'),
    execute: (s) => {
      const dev2 = find(s, 'frontend-agent');
      const ba1 = find(s, 'ba-analyst-1');
      const ba2 = find(s, 'ba-analyst-2');
      const dev1 = find(s, 'backend-agent');

      if (dev2) {
        walkTo(dev2, 11, 14, 'break_room');
        dev2.status = 'COFFEE_BREAK';
      }
      if (dev1) {
        walkTo(dev1, 14, 14, 'break_room');
        dev1.status = 'COFFEE_BREAK';
      }
      if (ba1) {
        walkTo(ba1, 19, 14, 'break_room');
        ba1.status = 'CHATTING';
        ba1.speechBubble = bubble('step.8.ba1.bubble');
      }
      if (ba2) {
        walkTo(ba2, 21, 14, 'break_room');
        ba2.status = 'CHATTING';
      }

      s.events.unshift({
        id: `evt-${Date.now()}-8`,
        type: 'social.started',
        timestamp: Date.now(),
        source: 'system',
        severity: 'low',
        summary: tx('step.8.event'),
        payload: { zone: 'break_room_and_lounge' },
      });
    },
  },
  {
    id: 9,
    durationMs: 2200,
    title: tx('step.9.title'),
    description: tx('step.9.description'),
    execute: (s) => {
      const sales = find(s, 'sales-lead');
      const boss = find(s, 'boss');
      const baLead = find(s, 'research-lead');
      const meetingId = 'MEET-QUOTE';
      const participants = [sales, boss, baLead].filter((agent): agent is Agent => Boolean(agent));

      // The three work in a secret room of the second floor: the reservation makes that floor show them.
      participants.forEach((agent, index) => {
        moveToSecondFloor(agent, 10 + index * 2, 8);
        agent.status = 'IN_MEETING';
      });
      if (sales) {
        sales.currentTool = 'pricing.calculator(roi_analysis)';
        sales.speechBubble = bubble('step.9.sales.bubble');
      }
      if (baLead) baLead.currentTool = 'gantt.timeline_builder';

      const meeting: Meeting = {
        id: meetingId,
        title: tx('step.9.meeting.title'),
        topic: tx('step.9.meeting.topic'),
        taskId: 'TASK-RPA-BANK',
        initiatorId: 'sales-lead',
        participants: participants.map((agent) => agent.id),
        status: 'ACTIVE',
        roomId: 'overflow_meeting_1',
        startedAt: Date.now(),
        tokensAccumulated: 9600,
        costAccumulated: 0.051,
        agenda: [],
        decisions: [],
        tasksCreated: [],
        messages: [],
      };
      s.meetings.unshift(meeting);
      s.roomReservations = s.roomReservations.filter((reservation) => reservation.meetingId !== meetingId);
      s.roomReservations.push({
        roomId: 'overflow_meeting_1',
        roomLabel: livingOfficeText(locale, 'room.overflow', { number: '01' }),
        floor: 2,
        meetingId,
        participantIds: participants.map((agent) => agent.id),
        reservedAt: Date.now(),
        status: 'ACTIVE',
      });
      s.activeMeetingId = meetingId;

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.progress = 90;
        task.artifacts.push({
          id: 'art-cotizacion',
          name: tx('step.9.artifact.quote.name'),
          type: 'report',
          summary: tx('step.9.artifact.quote.summary'),
          timestamp: Date.now(),
          authorId: 'sales-lead',
        });
        task.artifacts.push({
          id: 'art-gantt',
          name: tx('step.9.artifact.gantt.name'),
          type: 'report',
          summary: tx('step.9.artifact.gantt.summary'),
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
        summary: tx('step.9.event'),
        payload: { meetingId, quoteUsd: 48500, ganttWeeks: 6 },
      });
      playMessageBlip();
    },
  },
  {
    id: 10,
    durationMs: 2200,
    title: tx('step.10.title'),
    description: tx('step.10.description'),
    execute: (s) => {
      const boss = find(s, 'boss');
      const sales = find(s, 'sales-lead');
      const techLead = find(s, 'tech-lead');
      const baLead = find(s, 'research-lead');

      concludeMeeting(s, 'MEET-QUOTE');

      if (boss) {
        returnToMainFloor(boss, 3, 3, 'boss_office');
        boss.status = 'WRITING';
        boss.currentTool = 'html.compiler(interactive_rpa_proposal_deck)';
        boss.speechBubble = bubble('step.10.boss.bubble');
      }
      if (sales) {
        returnToMainFloor(sales, 5, 3, 'boss_office');
        sales.status = 'AVAILABLE';
        sales.currentTool = null;
      }
      if (techLead) {
        walkTo(techLead, 2, 9, 'leads_area');
        techLead.status = 'REVIEWING';
      }
      if (baLead) {
        returnToMainFloor(baLead, 4, 9, 'leads_area');
        baLead.status = 'REVIEWING';
      }

      const task = s.tasks.find((t) => t.id === 'TASK-RPA-BANK');
      if (task) {
        task.progress = 98;
        task.artifacts.push({
          id: 'art-resumen',
          name: tx('step.10.artifact.summary.name'),
          type: 'report',
          summary: tx('step.10.artifact.summary.summary'),
          timestamp: Date.now(),
          authorId: 'boss',
        });
        task.artifacts.push({
          id: 'art-html-deck',
          name: tx('step.10.artifact.deck.name'),
          type: 'code',
          summary: tx('step.10.artifact.deck.summary'),
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
        summary: tx('step.10.event'),
        payload: { artifacts: ['art-resumen', 'art-html-deck'] },
      });
      playMessageBlip();
    },
  },
  {
    id: 11,
    durationMs: 2200,
    title: tx('step.11.title'),
    description: tx('step.11.description'),
    execute: (s) => {
      for (const meeting of s.meetings) {
        if (meeting.status === 'ACTIVE' || meeting.status === 'SCHEDULED') concludeMeeting(s, meeting.id);
      }
      s.agents.forEach((agent) => {
        agent.currentTool = null;
        const desk = AGENT_DESK_ANCHORS[agent.id];
        if (desk) {
          returnToMainFloor(agent, desk.x, desk.y, desk.workspace);
        } else {
          if ((agent.floor ?? 1) === 2) returnToMainFloor(agent, agent.x, agent.y, 'break_room');
          routeAgent(agent, agent.workspace === 'overflow_floor' ? 'break_room' : agent.workspace);
        }
        agent.status = 'IDLE';
      });

      const boss = find(s, 'boss');
      if (boss) boss.speechBubble = bubble('step.11.boss.bubble', 3000);

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
        summary: tx('step.11.event'),
        payload: {
          artifactsCount: 9,
          totalTokens: 92400,
          totalCost: 0.582,
          deliverables: ['art-pdd', 'art-sdd', 'art-estimacion', 'art-bpmn', 'art-arquitectura', 'art-cotizacion', 'art-gantt', 'art-resumen', 'art-html-deck'],
        },
      });
      playTaskComplete();
    },
  },
  ];
}

/** The demo script in English, kept for callers that do not pass a locale. */
export const DEMO_STEPS: DemoStep[] = createDemoSteps('en');

// Helper to launch a custom prompt/task simulation
export interface TriggerCustomTaskOptions {
  /**
   * Whether this task's simulated usage is added to the agent's counters and to the office totals.
   * `false` in live mode: the portal cannot invent usage for a task against a real agent, so the task is
   * still created but no token or cost figure is added anywhere.
   */
  countUsage?: boolean;
}

export function triggerCustomTaskSimulation(
  state: SimulationState,
  title: string,
  description: string,
  assignedRole: 'backend_engineer' | 'frontend_engineer' | 'research_lead' | 'qa_engineer' | 'security_analyst',
  locale: Locale = 'en',
  options: TriggerCustomTaskOptions = {},
): Task {
  const countUsage = options.countUsage ?? true;
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
      text: demoText(locale, 'custom.boss.bubble', { taskId, title, agent: targetAgent.name }),
      expiresAt: Date.now() + 4000,
    };
  }

  targetAgent.status = 'CODING';
  targetAgent.statusText = demoText(locale, 'custom.agent.statusText', { taskId, title });
  targetAgent.currentTaskId = taskId;
  if (countUsage) {
    targetAgent.tokensInput += 4200;
    targetAgent.tokensOutput += 850;
    targetAgent.cost += 0.024;
  }
  targetAgent.speechBubble = {
    text: demoText(locale, 'custom.agent.bubble', { title }),
    expiresAt: Date.now() + 4000,
  };

  if (countUsage) {
    state.totalTokens.input += 4200;
    state.totalTokens.output += 850;
    state.totalCost += 0.024;
  }

  state.events.unshift({
    id: `evt-custom-${Date.now()}`,
    type: 'task.assigned',
    timestamp: Date.now(),
    source: 'boss',
    target: targetAgent.id,
    taskId,
    severity: 'high',
    summary: demoText(locale, 'custom.event', { taskId, title, agent: targetAgent.name }),
    payload: { title, description },
  });

  playTaskStart();
  return newTask;
}
