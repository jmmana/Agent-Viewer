export { AgentOffice } from './AgentOffice';
export type { AgentOfficeProps } from './AgentOffice';

// Re-export core types needed by consumers
export type {
  Agent,
  AgentRole,
  AgentStatus,
  AgentMood,
  WorkspaceZone,
  ViewerEvent,
  Task,
  TaskStatus,
  Meeting,
} from '../types/agent';

export type {
  CanonicalEvent,
  CanonicalEventType,
  EventSeverity,
} from '../integrations/canonicalContract';

export {
  SCHEMA_VERSION,
  CANONICAL_EVENT_TYPES,
  validateCanonicalEvent,
  normalizeCanonicalEvent,
} from '../integrations/canonicalContract';

export { connectEventStream } from '../integrations/realtimeClient';
export type { RealtimeConnection, RealtimeStatus, RealtimeConnectionOptions } from '../integrations/realtimeClient';
