// Embeddable office
export { AgentOffice } from './AgentOffice';
export type { AgentOfficeProps } from './AgentOffice';
export type { VisualMode, CrewView, CrewRoomDefinition } from '../crew/crewModel';
export type { CrewCamera, CrewCameraByRoom } from '../crew/crewCamera';

export type { CrewPreferences } from '../crew/crewPreferences';
export { crewAgentActivity, crewActivityLine, crewViewerModeLabel } from '../crew/crewEventBridge';
export type { CrewAgentActivity, CrewViewerMode, CrewVisibility } from '../crew/crewEventBridge';

// Event-driven office model, usable without React (server, tests, exports)
export { OfficeStore, buildOfficeSnapshot } from './officeStore';
export type { AgentProfile, OfficeEventInput, OfficeMode, OfficeSnapshot, OfficeStoreOptions } from './officeStore';

// Replay helpers
export { useEventReplay } from './useEventReplay';
export type { EventReplay, EventReplayOptions } from './useEventReplay';
export { ReplayControls } from './ReplayControls';
export type { ReplayControlsProps } from './ReplayControls';

// Usage figures (display only)
export { formatUsage, formatTokens, formatCost, formatCostSource, formatUsageBadge, formatMeetingUsage, summarizeUsage } from './usage';
export type { OfficeUsage, UsageFigures, FormattedUsageItem, UsageBadge, UsageCostSource, MeetingUsage, MeetingUsageFigures } from './usage';

// Per-call detail panel (display only)
export type { AgentCallDetail, AgentCallDetails, AgentCallTokens, AgentCallStatus, AgentCallCostSource } from './callDetails';

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
export {
  validateCanonicalEvent,
  CORRELATION_ID_MAX_LENGTH,
  USAGE_TAGS_MAX,
  USAGE_TAG_MAX_LENGTH,
} from '../integrations/canonicalContract';
export type { UsageCorrelation, LlmUsagePayload, LlmFailedPayload } from '../integrations/canonicalContract';

// Usage tally (portal display only)
export type {
  UsageTally,
  TokenTally,
  CostBucket,
  CostSource,
} from '../integrations/usageTally';

// Realtime stream from an Agent Viewer server
export { connectEventStream } from '../integrations/realtimeClient';
export type {
  RealtimeConnection,
  RealtimeStatus,
  RealtimeConnectionOptions,
  RealtimeResync,
  RealtimeReplayed,
} from '../integrations/realtimeClient';

// Event log files (JSONL V1)
export { parseEventLog, MAX_EVENT_LOG_SIZE_BYTES } from '../integrations/eventLogParser';
export type { EventLogParseResult, EventLogParseIssue, EventLogIssueCode, EventLogOtlpSummary } from '../integrations/eventLogParser';

// Video export
export { recordReplay, computeReplaySchedule, isRecordingSupported, getSupportedMimeType } from './recordReplay';
export type { RecordReplayOptions, ReplaySchedule } from './recordReplay';
