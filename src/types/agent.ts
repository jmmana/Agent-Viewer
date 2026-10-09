/**
 * Universal Agent Event Schema & Core Types for Agent Viewer
 */

import type { MessageKind } from '../integrations/canonicalTypes';
import type { UsageTally } from '../integrations/usageTally';

export type { MessageKind };

export type AgentRole =
  | 'boss'
  | 'tech_lead'
  | 'research_lead'
  | 'backend_engineer'
  | 'frontend_engineer'
  | 'qa_engineer'
  | 'security_analyst'
  | 'custom';

export type AgentStatus =
  | 'OFFLINE'
  | 'IDLE'
  | 'AVAILABLE'
  | 'THINKING'
  | 'READING'
  | 'RESEARCHING'
  | 'CODING'
  | 'WRITING'
  | 'TESTING'
  | 'USING_TOOL'
  | 'WAITING'
  | 'WAITING_APPROVAL'
  | 'BLOCKED'
  | 'DELEGATING'
  | 'PHONE_CALL'
  | 'WALKING'
  | 'IN_MEETING'
  | 'COFFEE_BREAK'
  | 'CHATTING'
  | 'REVIEWING'
  | 'DELIVERING'
  | 'DONE'
  | 'ERROR';

export type WorkspaceZone =
  | 'boss_office'
  | 'leads_area'
  | 'development'
  | 'qa_lab'
  | 'research_area'
  | 'server_room'
  | 'meeting_room'
  | 'meeting_room_b'
  | 'overflow_floor'
  | 'break_room';

export type AgentMood =
  | 'neutral'
  | 'happy'
  | 'amused'
  | 'excited'
  | 'surprised'
  | 'focused'
  | 'annoyed'
  | 'frustrated'
  | 'tired';

export type SocialTopic =
  | 'jokes'
  | 'sports'
  | 'technology'
  | 'entertainment'
  | 'current_events'
  | 'office_banter';

export interface SocialActivity {
  id: string;
  participantIds: string[];
  topic: SocialTopic;
  simulated: true;
  locale: string;
  startedAt: number;
  endsAt?: number;
}

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  roleTitle: string;
  team: 'leadership' | 'engineering' | 'research' | 'quality' | 'operations' | 'other';
  managerId: string | null;
  provider: string;
  model: string;
  status: AgentStatus;
  statusText: string;
  currentTaskId: string | null;
  currentTool: string | null;
  workspace: WorkspaceZone;
  /** Where the agent returns after a meeting. Set by `agent.registered` when the runtime sends a workspace. */
  homeWorkspace?: WorkspaceZone;
  floor?: number;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  isWalking: boolean;
  travelStartedAt?: number;
  travelDurationMs?: number;
  facing: 'SE' | 'SW' | 'NE' | 'NW';
  avatarColor: string;
  clothingColor: string;
  hairColor: string;
  accessory: 'glasses' | 'hoodie' | 'tie' | 'badge' | 'headphones' | 'none';
  tokensInput: number;
  tokensOutput: number;
  cachedTokens: number;
  reasoningTokens: number;
  cost: number;
  /** Filled only by the demo app. The embedded component never fills it; pass usage through the `usage` prop. */
  usage?: UsageTally;
  startedAt: number;
  mood?: AgentMood;
  socialActivityId?: string | null;
  presentationActivity?: 'coffee_break' | 'chatting' | 'walking_to_break' | null;
  ambientBubble?: {
    text: string;
    targetAgentName?: string;
    expiresAt: number;
  } | null;
  speechBubble: {
    text: string;
    targetAgentName?: string;
    expiresAt: number;
    /** What the message does (proposal, objection, decision...). Comes from the event, never invented. */
    kind?: MessageKind;
  } | null;
}

export type TaskStatus = 'PENDING' | 'ASSIGNED' | 'IN_PROGRESS' | 'BLOCKED' | 'REVIEW' | 'COMPLETED' | 'FAILED';

export interface Task {
  id: string;
  title: string;
  description: string;
  initiatorId: string;
  assignedAgentId: string;
  collaboratorIds: string[];
  status: TaskStatus;
  progress: number; // 0 to 100
  createdAt: number;
  completedAt?: number;
  tokensTotal: number;
  costTotal: number;
  toolsUsed: string[];
  artifacts: Artifact[];
  blockerReason?: string;
  /** Filled only by the demo app. The embedded component never fills it. */
  usage?: UsageTally;
}

export interface Artifact {
  id: string;
  name: string;
  type: 'code' | 'report' | 'pr' | 'test_run' | 'schema' | 'architecture';
  summary: string;
  timestamp: number;
  authorId: string;
}

export interface Meeting {
  id: string;
  title: string;
  topic: string;
  taskId?: string;
  initiatorId: string;
  participants: string[];
  status: 'SCHEDULED' | 'ACTIVE' | 'CONCLUDED';
  startedAt: number;
  endedAt?: number;
  tokensAccumulated: number;
  costAccumulated: number;
  agenda: string[];
  decisions: string[];
  tasksCreated: string[];
  roomId?: string;
  messages: MeetingMessage[];
}

export interface MeetingMessage {
  id: string;
  senderId: string;
  text: string;
  timestamp: number;
  type: MessageKind;
}

export interface ToolCall {
  id: string;
  agentId: string;
  tool: string;
  category: 'code' | 'web' | 'test' | 'infra' | 'db' | 'fs';
  inputSummary: string;
  outputSummary?: string;
  status: 'running' | 'success' | 'failed';
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
}

export type EventType =
  | 'agent.registered'
  | 'agent.updated'
  | 'agent.status.changed'
  | 'agent.message.sent'
  | 'task.created'
  | 'task.assigned'
  | 'task.started'
  | 'task.progress'
  | 'task.blocked'
  | 'task.completed'
  | 'task.failed'
  | 'message.sent'
  | 'agent.phone_call.started'
  | 'agent.phone_call.ended'
  | 'meeting.requested'
  | 'meeting.room.reserved'
  | 'meeting.started'
  | 'meeting.message'
  | 'meeting.decision'
  | 'meeting.ended'
  | 'meeting.cancelled'
  | 'social.started'
  | 'social.message'
  | 'social.ended'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'llm.usage'
  | 'llm.failed'
  | 'runtime.connected'
  | 'runtime.disconnected'
  | 'runtime.heartbeat'
  | 'approval.requested'
  | 'approval.approved'
  | 'artifact.created';

export interface ViewerEvent {
  schemaVersion?: string;
  id: string;
  type: EventType;
  timestamp: number;
  source: string;
  runtimeId?: string;
  sessionId?: string;
  agentId?: string;
  target?: string;
  taskId?: string;
  severity: 'low' | 'normal' | 'high' | 'critical';
  summary: string;
  payload: Record<string, any>;
}

export interface PricingConfig {
  provider: string;
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedPerMillion: number;
}
