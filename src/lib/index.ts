// Embeddable office
export { AgentOffice } from './AgentOffice';
export type { AgentOfficeProps } from './AgentOffice';
export type { VisualMode, CrewView, CrewRoomDefinition } from '../crew/crewModel';
export type { CrewCamera, CrewCameraByRoom } from '../crew/crewCamera';

// Event-driven office model, usable without React (server, tests, exports)
export { OfficeStore, buildOfficeSnapshot } from './officeStore';
export type { AgentProfile, OfficeEventInput, OfficeMode, OfficeSnapshot, OfficeStoreOptions } from './officeStore';

// Replay helpers
export { useEventReplay } from './useEventReplay';
export type { EventReplay, EventReplayOptions } from './useEventReplay';
export { ReplayControls } from './ReplayControls';
export type { ReplayControlsProps } from './ReplayControls';

// Usage figures (display only)
export { formatUsage, formatTokens, formatCost, summarizeUsage } from './usage';
export type { OfficeUsage, UsageFigures, FormattedUsageItem } from './usage';

// Texts
export {
  OFFICE_MESSAGES,
  createOfficeTranslator,
  formatMessage,
  builtInMessages,
  isOfficeMessageKey,
} from '../content/officeMessages';
export type {
  OfficeMessageKey,
  OfficeMessages,
  OfficeMessageParams,
  OfficeTranslate,
  OfficeTranslatorOptions,
  HostTranslate,
} from '../content/officeMessages';

// Core types
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
  MeetingMessage,
} from '../types/agent';

// Canonical event contract V1
export {
  SCHEMA_VERSION,
  CANONICAL_EVENT_TYPES,
  EVENT_TYPE_ALIASES,
  MESSAGE_KINDS,
  isMessageKind,
  LLM_ERROR_KINDS,
  isLlmErrorKind,
  normalizeCanonicalEvent,
} from '../integrations/canonicalTypes';
export type {
  CanonicalEvent,
  CanonicalEventType,
  EventSeverity,
  MessageKind,
  LlmErrorKind,
  CanonicalEventInput,
  LegacyEventType,
  ValidationIssue,
  ValidationResult,
} from '../integrations/canonicalTypes';
export { validateCanonicalEvent } from '../integrations/canonicalContract';

// Realtime stream from an Agent Viewer server
export { connectEventStream } from '../integrations/realtimeClient';
export type { RealtimeConnection, RealtimeStatus, RealtimeConnectionOptions } from '../integrations/realtimeClient';

// Event log files (JSONL V1)
export { parseEventLog, MAX_EVENT_LOG_SIZE_BYTES } from '../integrations/eventLogParser';
export type { EventLogParseResult, EventLogParseIssue } from '../integrations/eventLogParser';

// Video export
export { recordReplay, computeReplaySchedule, isRecordingSupported, getSupportedMimeType } from './recordReplay';
export type { RecordReplayOptions, ReplaySchedule } from './recordReplay';
