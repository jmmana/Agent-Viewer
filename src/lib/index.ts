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

// Event log parser and replay engine
export { parseEventLog, MAX_EVENT_LOG_SIZE_BYTES } from '../integrations/eventLogParser';
export type { EventLogParseResult, EventLogParseIssue } from '../integrations/eventLogParser';
export { SessionReplayPlayer } from '../integrations/replayEngine';
export type { ReplayOptions } from '../integrations/replayEngine';

// Video recording export
export { recordReplay, isRecordingSupported, getSupportedMimeType } from './recordReplay';
export type { RecordReplayOptions } from './recordReplay';
