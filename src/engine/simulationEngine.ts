import { Agent, Artifact, Meeting, Task, ViewerEvent } from '../types/agent';
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
  totalTokens: {
    input: number;
    output: number;
    cached: number;
    reasoning: number;
  };
  totalCost: number;
}

export function createInitialSimulationState(initialAgents: Agent[]): SimulationState {
  return {
    agents: JSON.parse(JSON.stringify(initialAgents)),
    tasks: [],
    meetings: [],
    events: [
      {
        id: 'evt-boot-1',
        type: 'agent.registered',
        timestamp: Date.now() - 3600000,
        source: 'system',
        severity: 'low',
        summary: 'All 7 organization agents registered and calibrated.',
        payload: { agentCount: 7 },
      },
    ],
    activeMeetingId: null,
    totalTokens: {
      input: 179300,
      output: 43300,
      cached: 93900,
      reasoning: 16800,
    },
    totalCost: 0.881,
  };
}

// 16-Step Canonical "Wow" Sequence (PRD Section 45, 109 & 115)
export const DEMO_STEPS: DemoStep[] = [
  {
    id: 0,
    durationMs: 3500,
    title: '1. Executive Goal Received',
    description: 'CEO / Boss receives requirement: "Architect and implement OAuth 2.0 PKCE Auth Server with Scoped Service Tokens".',
    execute: (s) => {
      const boss = s.agents.find((a) => a.id === 'boss');
      if (boss) {
        boss.status = 'THINKING';
        boss.statusText = 'Analyzing OAuth 2.0 PKCE specification';
        boss.speechBubble = {
          text: 'New priority: OAuth 2.0 PKCE auth service needed. Convening Leads.',
          expiresAt: Date.now() + 4000,
        };
      }
      const newTask: Task = {
        id: 'TASK-101',
        title: 'OAuth 2.0 PKCE Auth Server & Service Scopes',
        description: 'Design and implement RFC 7636 compliant authorization service with replay protection.',
        initiatorId: 'boss',
        assignedAgentId: 'tech-lead',
        collaboratorIds: ['tech-lead', 'research-lead', 'backend-agent', 'qa-agent'],
        status: 'ASSIGNED',
        progress: 5,
        createdAt: Date.now(),
        tokensTotal: 1200,
        costTotal: 0.008,
        toolsUsed: [],
        artifacts: [],
      };
      s.tasks.unshift(newTask);
      s.events.unshift({
        id: `evt-${Date.now()}-1`,
        type: 'task.created',
        timestamp: Date.now(),
        source: 'boss',
        target: 'tech-lead',
        taskId: newTask.id,
        severity: 'high',
        summary: 'TASK-101 created: OAuth 2.0 PKCE Auth Server & Service Scopes.',
        payload: { task: newTask },
      });
      playTaskStart();
    },
  },
  {
    id: 1,
    durationMs: 4000,
    title: '2. Boss Summons Leads to Meeting',
    description: 'Boss calls Tech Lead (Alex) and Research Lead (Maya) to Conference Room for architecture briefing.',
    execute: (s) => {
      const boss = s.agents.find((a) => a.id === 'boss');
      const techLead = s.agents.find((a) => a.id === 'tech-lead');
      const researchLead = s.agents.find((a) => a.id === 'research-lead');

      if (boss) {
        boss.targetX = 9;
        boss.targetY = 2;
        boss.isWalking = true;
        boss.status = 'DELEGATING';
      }
      if (techLead) {
        techLead.targetX = 10;
        techLead.targetY = 3;
        techLead.isWalking = true;
        techLead.status = 'IN_MEETING';
        techLead.speechBubble = {
          text: 'Joining conference room for auth blueprint review.',
          expiresAt: Date.now() + 3500,
        };
      }
      if (researchLead) {
        researchLead.targetX = 12;
        researchLead.targetY = 3;
        researchLead.isWalking = true;
        researchLead.status = 'IN_MEETING';
      }

      s.events.unshift({
        id: `evt-${Date.now()}-2`,
        type: 'message.sent',
        timestamp: Date.now(),
        source: 'boss',
        target: 'tech-lead',
        severity: 'normal',
        summary: 'Boss summoned Tech Lead & Research Lead to Conference Room.',
        payload: { agenda: 'OAuth 2.0 RFC 7636 security standards' },
      });
      playMessageBlip();
    },
  },
  {
    id: 2,
    durationMs: 5000,
    title: '3. Architecture Review in Conference Room',
    description: 'Presentation screen illuminates. Leads discuss token hashing and client isolation.',
    execute: (s) => {
      const boss = s.agents.find((a) => a.id === 'boss');
      const techLead = s.agents.find((a) => a.id === 'tech-lead');
      const researchLead = s.agents.find((a) => a.id === 'research-lead');

      if (boss) {
        boss.x = 9;
        boss.y = 2;
        boss.isWalking = false;
        boss.status = 'IN_MEETING';
      }
      if (techLead) {
        techLead.x = 10;
        techLead.y = 3;
        techLead.isWalking = false;
        techLead.speechBubble = {
          text: 'We should enforce S256 code challenge method and reject plain code verifier.',
          expiresAt: Date.now() + 4500,
        };
      }
      if (researchLead) {
        researchLead.x = 12;
        researchLead.y = 3;
        researchLead.isWalking = false;
      }

      const meeting: Meeting = {
        id: 'MEET-42',
        title: 'OAuth 2.0 PKCE Architecture Review',
        topic: 'RFC 7636 Enforcement & Scoped Service Grants',
        taskId: 'TASK-101',
        initiatorId: 'boss',
        participants: ['boss', 'tech-lead', 'research-lead'],
        status: 'ACTIVE',
        startedAt: Date.now(),
        tokensAccumulated: 8400,
        costAccumulated: 0.052,
        agenda: ['PKCE S256 vs Plain', 'Refresh Token Rotation', 'QA Strategy'],
        decisions: [
          'Mandate SHA-256 code challenge method strictly.',
          'Inject short-lived tokens (15m expiry) with single-use refresh token rotation.',
        ],
        tasksCreated: ['TASK-101-BACKEND', 'TASK-101-QA'],
        messages: [
          {
            id: 'm1',
            senderId: 'boss',
            text: 'Need an airtight OAuth service that resists token interception.',
            timestamp: Date.now() - 3000,
            type: 'statement',
          },
          {
            id: 'm2',
            senderId: 'tech-lead',
            text: 'We will enforce RFC 7636 S256 code challenges and strict nonce verification.',
            timestamp: Date.now() - 1500,
            type: 'proposal',
          },
          {
            id: 'm3',
            senderId: 'boss',
            text: 'Approved. Delegate execution to Elena and Zoe for full test coverage.',
            timestamp: Date.now(),
            type: 'decision',
          },
        ],
      };

      s.meetings.unshift(meeting);
      s.activeMeetingId = meeting.id;

      s.totalTokens.input += 7200;
      s.totalTokens.output += 1200;
      s.totalCost += 0.052;

      s.events.unshift({
        id: `evt-${Date.now()}-3`,
        type: 'meeting.started',
        timestamp: Date.now(),
        source: 'boss',
        severity: 'high',
        summary: 'Meeting started: "OAuth 2.0 PKCE Architecture Review".',
        payload: { meetingId: meeting.id, participants: meeting.participants },
      });
      playMeetingGong();
    },
  },
  {
    id: 3,
    durationMs: 4000,
    title: '4. Meeting Concluded & Consensus Recorded',
    description: 'Decisions committed to project registry. Leads return to desks to distribute workloads.',
    execute: (s) => {
      const activeMeet = s.meetings.find((m) => m.id === s.activeMeetingId);
      if (activeMeet) {
        activeMeet.status = 'CONCLUDED';
        activeMeet.endedAt = Date.now();
      }
      s.activeMeetingId = null;

      const boss = s.agents.find((a) => a.id === 'boss');
      const techLead = s.agents.find((a) => a.id === 'tech-lead');
      const researchLead = s.agents.find((a) => a.id === 'research-lead');

      if (boss) {
        boss.targetX = 3;
        boss.targetY = 3;
        boss.isWalking = true;
        boss.status = 'IDLE';
        boss.statusText = 'Awaiting implementation deliverable';
      }
      if (techLead) {
        techLead.targetX = 2;
        techLead.targetY = 9;
        techLead.isWalking = true;
        techLead.status = 'DELEGATING';
      }
      if (researchLead) {
        researchLead.targetX = 3;
        researchLead.targetY = 14; // Walks to Research reading table
        researchLead.isWalking = true;
        researchLead.status = 'RESEARCHING';
      }

      s.events.unshift({
        id: `evt-${Date.now()}-4`,
        type: 'meeting.ended',
        timestamp: Date.now(),
        source: 'boss',
        severity: 'normal',
        summary: 'Meeting concluded with 2 key architectural decisions.',
        payload: { decisionsCount: 2 },
      });
    },
  },
  {
    id: 4,
    durationMs: 4500,
    title: '5. Research Lead Deep-Dives in Library',
    description: 'Dr. Maya Chen reaches Research table. Executes web search & RFC document analysis tools.',
    execute: (s) => {
      const researchLead = s.agents.find((a) => a.id === 'research-lead');
      if (researchLead) {
        researchLead.x = 3;
        researchLead.y = 14;
        researchLead.isWalking = false;
        researchLead.status = 'USING_TOOL';
        researchLead.currentTool = 'web.search(rfc7636_pkce)';
        researchLead.statusText = 'Querying RFC 7636 security specifications';
        researchLead.tokensInput += 4500;
        researchLead.tokensOutput += 950;
        researchLead.cost += 0.021;
        researchLead.speechBubble = {
          text: 'Tool web.search returned 14 security caveats for PKCE replay attacks.',
          expiresAt: Date.now() + 4000,
        };
      }

      s.totalTokens.input += 4500;
      s.totalTokens.output += 950;
      s.totalCost += 0.021;

      s.events.unshift({
        id: `evt-${Date.now()}-5`,
        type: 'tool.started',
        timestamp: Date.now(),
        source: 'research-lead',
        severity: 'normal',
        summary: 'Tool web.search executed by Dr. Maya Chen.',
        payload: { tool: 'web.search', query: 'RFC 7636 PKCE S256 vulnerability list' },
      });
      playMessageBlip();
    },
  },
  {
    id: 5,
    durationMs: 4000,
    title: '6. Tech Lead Delegates Implementation to Elena',
    description: 'Alex sends message to Backend Analyst (Elena Rostova): "Implement AuthController & PKCE verifier".',
    execute: (s) => {
      const techLead = s.agents.find((a) => a.id === 'tech-lead');
      const backend = s.agents.find((a) => a.id === 'backend-agent');

      if (techLead) {
        techLead.x = 2;
        techLead.y = 9;
        techLead.isWalking = false;
        techLead.status = 'REVIEWING';
        techLead.speechBubble = {
          text: 'Elena: please implement the AuthController with S256 code challenge validation.',
          targetAgentName: 'Elena Rostova',
          expiresAt: Date.now() + 3800,
        };
      }
      if (backend) {
        backend.status = 'THINKING';
        backend.statusText = 'Ingesting task requirements and scaffolding API';
        backend.speechBubble = {
          text: 'Understood Alex. Scaffolding crypto hash verification and token issue routes.',
          expiresAt: Date.now() + 3800,
        };
      }

      const task = s.tasks.find((t) => t.id === 'TASK-101');
      if (task) {
        task.status = 'IN_PROGRESS';
        task.progress = 25;
      }

      s.events.unshift({
        id: `evt-${Date.now()}-6`,
        type: 'task.assigned',
        timestamp: Date.now(),
        source: 'tech-lead',
        target: 'backend-agent',
        taskId: 'TASK-101',
        severity: 'normal',
        summary: 'Tech Lead assigned core PKCE coding to Elena Rostova.',
        payload: { component: 'AuthController.ts' },
      });
    },
  },
  {
    id: 6,
    durationMs: 5000,
    title: '7. Elena Writes Code at Development Desk',
    description: 'Elena switches to CODING. Monitors pulse with live code syntax. Tool "filesystem.write" invoked.',
    execute: (s) => {
      const backend = s.agents.find((a) => a.id === 'backend-agent');
      if (backend) {
        backend.status = 'CODING';
        backend.currentTool = 'fs.write(AuthController.ts)';
        backend.statusText = 'Writing SHA-256 verifier & token exchange handler';
        backend.tokensInput += 9400;
        backend.tokensOutput += 2800;
        backend.cachedTokens += 6200;
        backend.cost += 0.051;
        backend.speechBubble = {
          text: 'Emitted 180 lines of TypeScript with crypto-subtle SHA-256 verification.',
          expiresAt: Date.now() + 4500,
        };
      }

      s.totalTokens.input += 9400;
      s.totalTokens.output += 2800;
      s.totalCost += 0.051;

      const task = s.tasks.find((t) => t.id === 'TASK-101');
      if (task) {
        task.progress = 55;
        task.toolsUsed.push('fs.write', 'git.commit');
        task.artifacts.push({
          id: 'art-1',
          name: 'AuthController.ts & pkce.ts',
          type: 'code',
          summary: 'Full RFC 7636 token endpoint implementation with cryptographic challenge verifier.',
          timestamp: Date.now(),
          authorId: 'backend-agent',
        });
      }

      s.events.unshift({
        id: `evt-${Date.now()}-7`,
        type: 'artifact.created',
        timestamp: Date.now(),
        source: 'backend-agent',
        taskId: 'TASK-101',
        severity: 'normal',
        summary: 'Elena generated artifact: AuthController.ts & pkce.ts.',
        payload: { linesOfCode: 180, testCoverage: 'pending' },
      });
      playMessageBlip();
    },
  },
  {
    id: 7,
    durationMs: 4500,
    title: '8. Zoe Receives Code for QA Validation',
    description: 'Zoe Vance (QA Lead) prepares end-to-end integration and security test suite in QA Lab.',
    execute: (s) => {
      const qa = s.agents.find((a) => a.id === 'qa-agent');
      if (qa) {
        qa.status = 'TESTING';
        qa.currentTool = 'test.run(integration_auth_spec)';
        qa.statusText = 'Executing 24 security test cases & fuzzing nonce';
        qa.tokensInput += 6100;
        qa.tokensOutput += 1400;
        qa.cost += 0.018;
        qa.speechBubble = {
          text: 'Running regression fuzz suite on authorization code exchange endpoint...',
          expiresAt: Date.now() + 4000,
        };
      }

      s.totalTokens.input += 6100;
      s.totalTokens.output += 1400;
      s.totalCost += 0.018;

      s.events.unshift({
        id: `evt-${Date.now()}-8`,
        type: 'tool.started',
        timestamp: Date.now(),
        source: 'qa-agent',
        severity: 'normal',
        summary: 'Tool test.run started by Zoe Vance in QA Lab.',
        payload: { suite: 'auth_pkce_fuzz_test.py', assertions: 24 },
      });
    },
  },
  {
    id: 8,
    durationMs: 4500,
    title: '9. Critical Security Flaw Detected!',
    description: 'QA detects potential token replay attack: Nonce is not validated against session cache!',
    execute: (s) => {
      const qa = s.agents.find((a) => a.id === 'qa-agent');
      if (qa) {
        qa.status = 'BLOCKED';
        qa.statusText = 'Vulnerability detected: Token replay flaw';
        qa.speechBubble = {
          text: 'CRITICAL: Authorization code reused without single-use invalidation!',
          expiresAt: Date.now() + 4200,
        };
      }

      const task = s.tasks.find((t) => t.id === 'TASK-101');
      if (task) {
        task.status = 'BLOCKED';
        task.blockerReason = 'Replay vulnerability: Authorization code not purged upon first token exchange.';
      }

      s.events.unshift({
        id: `evt-${Date.now()}-9`,
        type: 'task.blocked',
        timestamp: Date.now(),
        source: 'qa-agent',
        taskId: 'TASK-101',
        severity: 'critical',
        summary: 'SECURITY ALERT: Code replay vulnerability detected by QA Agent Zoe Vance.',
        payload: { errorType: 'CWE-294', vulnerability: 'Code Replay Flaw' },
      });
      playAlert();
    },
  },
  {
    id: 9,
    durationMs: 4000,
    title: '10. Zoe Walks to Elena to Escalate Bug',
    description: 'Zoe walks directly to Elena’s desk with detailed test reproduction trace.',
    execute: (s) => {
      const qa = s.agents.find((a) => a.id === 'qa-agent');
      const backend = s.agents.find((a) => a.id === 'backend-agent');

      if (qa) {
        qa.targetX = 9;
        qa.targetY = 10;
        qa.isWalking = true;
        qa.status = 'DELEGATING';
        qa.speechBubble = {
          text: 'Elena, code exchange can be replayed twice within 60s window. Needs atomic purge.',
          targetAgentName: 'Elena Rostova',
          expiresAt: Date.now() + 3800,
        };
      }
      if (backend) {
        backend.status = 'REVIEWING';
        backend.statusText = 'Inspecting QA trace for atomic invalidation';
      }

      s.events.unshift({
        id: `evt-${Date.now()}-10`,
        type: 'message.sent',
        timestamp: Date.now(),
        source: 'qa-agent',
        target: 'backend-agent',
        severity: 'high',
        summary: 'Zoe walked to Elena’s desk with reproduction trace for replay vulnerability.',
        payload: { target: 'Elena Rostova' },
      });
      playMessageBlip();
    },
  },
  {
    id: 10,
    durationMs: 4500,
    title: '11. Elena Implements Atomic Code Invalidation',
    description: 'Elena updates Redis cache lock & guarantees one-time authorization code consumption.',
    execute: (s) => {
      const backend = s.agents.find((a) => a.id === 'backend-agent');
      const qa = s.agents.find((a) => a.id === 'qa-agent');

      if (backend) {
        backend.status = 'CODING';
        backend.currentTool = 'fs.write(redis_atomic_lock.ts)';
        backend.statusText = 'Adding atomic Redis GETDEL on auth code';
        backend.tokensInput += 4200;
        backend.tokensOutput += 1200;
        backend.cost += 0.022;
        backend.speechBubble = {
          text: 'Patched: Using atomic Redis GETDEL command. Token replay is mathematically impossible now.',
          expiresAt: Date.now() + 4000,
        };
      }
      if (qa) {
        qa.targetX = 20;
        qa.targetY = 10; // Return to QA Lab
        qa.isWalking = true;
      }

      s.totalTokens.input += 4200;
      s.totalTokens.output += 1200;
      s.totalCost += 0.022;

      s.events.unshift({
        id: `evt-${Date.now()}-11`,
        type: 'tool.completed',
        timestamp: Date.now(),
        source: 'backend-agent',
        taskId: 'TASK-101',
        severity: 'normal',
        summary: 'Elena resolved vulnerability with atomic Redis GETDEL token lock.',
        payload: { fix: 'atomic_getdel_lock' },
      });
    },
  },
  {
    id: 11,
    durationMs: 4000,
    title: '12. Zoe Reruns Tests — All 24 Passed!',
    description: 'QA Lab screen flashes green: 24/24 integration tests pass, fuzzing clean, latency 18ms.',
    execute: (s) => {
      const qa = s.agents.find((a) => a.id === 'qa-agent');
      if (qa) {
        qa.x = 20;
        qa.y = 10;
        qa.isWalking = false;
        qa.status = 'DONE';
        qa.statusText = '24/24 tests passed (0 vulnerabilities)';
        qa.speechBubble = {
          text: 'PASSED: 24/24 tests green! Code exchange strictly single-use.',
          expiresAt: Date.now() + 3800,
        };
      }

      const task = s.tasks.find((t) => t.id === 'TASK-101');
      if (task) {
        task.status = 'REVIEW';
        task.progress = 90;
        task.artifacts.push({
          id: 'art-2',
          name: 'QA_Security_Audit_Report.json',
          type: 'test_run',
          summary: '24 security tests passing with zero replay leaks.',
          timestamp: Date.now(),
          authorId: 'qa-agent',
        });
      }

      s.events.unshift({
        id: `evt-${Date.now()}-12`,
        type: 'tool.completed',
        timestamp: Date.now(),
        source: 'qa-agent',
        taskId: 'TASK-101',
        severity: 'high',
        summary: 'QA Suite passed: 24/24 test assertions verified.',
        payload: { passRate: '100%', vulnerabilities: 0 },
      });
      playTaskComplete();
    },
  },
  {
    id: 12,
    durationMs: 4000,
    title: '13. Elena Delivers PR to Tech Lead',
    description: 'Elena walks to Alex’s desk and hands over Pull Request #142 ready for merge.',
    execute: (s) => {
      const backend = s.agents.find((a) => a.id === 'backend-agent');
      const techLead = s.agents.find((a) => a.id === 'tech-lead');

      if (backend) {
        backend.targetX = 3;
        backend.targetY = 9; // Near Tech Lead desk
        backend.isWalking = true;
        backend.status = 'DELIVERING';
        backend.speechBubble = {
          text: 'Alex, Pull Request #142 is ready. S256 PKCE verified and signed by Zoe.',
          expiresAt: Date.now() + 3800,
        };
      }
      if (techLead) {
        techLead.status = 'REVIEWING';
        techLead.statusText = 'Reviewing PR #142 diff and QA signatures';
      }

      s.events.unshift({
        id: `evt-${Date.now()}-13`,
        type: 'approval.requested',
        timestamp: Date.now(),
        source: 'backend-agent',
        target: 'tech-lead',
        taskId: 'TASK-101',
        severity: 'normal',
        summary: 'PR #142 submitted to Tech Lead for architectural signoff.',
        payload: { prNumber: 142 },
      });
      playMessageBlip();
    },
  },
  {
    id: 13,
    durationMs: 4000,
    title: '14. Tech Lead Approves & Delivers to Boss',
    description: 'Alex approves PR #142 and walks into Boss Office to present final delivery.',
    execute: (s) => {
      const backend = s.agents.find((a) => a.id === 'backend-agent');
      const techLead = s.agents.find((a) => a.id === 'tech-lead');

      if (backend) {
        backend.targetX = 8;
        backend.targetY = 10; // Returns to dev desk
        backend.isWalking = true;
        backend.status = 'IDLE';
      }
      if (techLead) {
        techLead.targetX = 4;
        techLead.targetY = 3; // Enters Boss Office
        techLead.isWalking = true;
        techLead.status = 'DELIVERING';
        techLead.speechBubble = {
          text: 'Director, OAuth 2.0 PKCE auth service is deployed and passed all security audits.',
          expiresAt: Date.now() + 3800,
        };
      }

      s.events.unshift({
        id: `evt-${Date.now()}-14`,
        type: 'approval.approved',
        timestamp: Date.now(),
        source: 'tech-lead',
        target: 'boss',
        taskId: 'TASK-101',
        severity: 'high',
        summary: 'Tech Lead approved PR #142 and presented deliverable to Director.',
        payload: { target: 'Director' },
      });
    },
  },
  {
    id: 14,
    durationMs: 4500,
    title: '15. Boss Signs Off — Mission Accomplished!',
    description: 'Boss reviews metrics: 0 vulnerabilities, 34.6K tokens consumed ($0.23). Task complete!',
    execute: (s) => {
      const boss = s.agents.find((a) => a.id === 'boss');
      const techLead = s.agents.find((a) => a.id === 'tech-lead');

      if (boss) {
        boss.status = 'DONE';
        boss.statusText = 'TASK-101 Approved and merged to production';
        boss.speechBubble = {
          text: 'Outstanding work team! Deployed to production cluster.',
          expiresAt: Date.now() + 4500,
        };
      }
      if (techLead) {
        techLead.targetX = 2;
        techLead.targetY = 9; // Return to Lead desk
        techLead.isWalking = true;
        techLead.status = 'DONE';
      }

      const task = s.tasks.find((t) => t.id === 'TASK-101');
      if (task) {
        task.status = 'COMPLETED';
        task.progress = 100;
        task.completedAt = Date.now();
        task.tokensTotal = 34600;
        task.costTotal = 0.232;
        task.artifacts.push({
          id: 'art-3',
          name: 'Production Release v1.4.0',
          type: 'architecture',
          summary: 'Signed release manifest with PKCE RFC 7636 security compliance cert.',
          timestamp: Date.now(),
          authorId: 'boss',
        });
      }

      s.events.unshift({
        id: `evt-${Date.now()}-15`,
        type: 'task.completed',
        timestamp: Date.now(),
        source: 'boss',
        taskId: 'TASK-101',
        severity: 'high',
        summary: 'TASK-101 marked COMPLETED by Boss. 0 errors, 100% test coverage.',
        payload: { totalTokens: 34600, totalCost: 0.232 },
      });
      playTaskComplete();
    },
  },
  {
    id: 15,
    durationMs: 4000,
    title: '16. Organization Returns to Idle Readiness',
    description: 'Agents return to designated pods. Office monitors reflect updated KPIs.',
    execute: (s) => {
      s.agents.forEach((agent) => {
        if (!agent.isWalking) {
          agent.status = 'IDLE';
          agent.statusText = 'Ready for next prompt or assignment';
          agent.currentTool = null;
        }
      });
      s.events.unshift({
        id: `evt-${Date.now()}-16`,
        type: 'agent.status.changed',
        timestamp: Date.now(),
        source: 'system',
        severity: 'low',
        summary: 'All agents ready in standby mode.',
        payload: { readyCount: 7 },
      });
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
