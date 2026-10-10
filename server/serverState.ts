/**
 * The reducer and state shared by live ingestion and the SQLite startup rebuild (issue #52, on top of the
 * call-by-call usage reducer of `usageAggregates.ts`). `applyEvent` is deterministic: it reads only `state` and
 * `event`, never the clock or anything random, so replaying the same events twice produces the same state
 * (see `tests/sqlite-rebuild.test.mjs`).
 *
 * `MemoryEventStore` and `SQLiteEventStore` (`server/store.ts`) both hold one `ServerState` and apply every
 * accepted event to it through `applyEvent`. The SQLite store additionally replays the stored event log through
 * the same function at startup, so the state after a restart is identical to the state before it.
 */
import type { CanonicalEvent } from '../src/integrations/canonicalContract';
import {
  createUsageReducer,
  resolveEventAgentId,
  type LegacyUsageFields,
  type UsageReducer,
} from './usageAggregates';

export interface RuntimeRecord {
  id: string;
  name?: string;
  framework?: string;
  version?: string;
  metadata?: Record<string, any>;
  status: 'active' | 'idle' | 'disconnected';
  firstSeenAt: number;
  lastSeenAt: number;
  eventsCount: number;
}

export interface SessionRecord {
  id: string;
  runtimeId?: string;
  name?: string;
  createdAt: number;
  lastActiveAt: number;
  status: 'active' | 'completed' | 'archived';
  eventsCount: number;
}

export interface AgentRecord {
  id: string;
  name: string;
  roleTitle?: string;
  role?: string;
  provider?: string;
  model?: string;
  status: string;
  statusText?: string;
  workspace?: string;
  /** @deprecated Use the usage summary. Sum of reported input tokens only; a lower bound when some call did not report them. */
  tokensInput: number;
  /** @deprecated Use the usage summary. Sum of reported output tokens only; a lower bound when some call did not report them. */
  tokensOutput: number;
  /** @deprecated Use the usage summary. Sum of reported cache-read tokens only; a lower bound when some call did not report them. */
  cachedTokens: number;
  /** @deprecated Use the usage summary. Sum of reported reasoning tokens only; a lower bound when some call did not report them. */
  reasoningTokens: number;
  /**
   * @deprecated Use the usage summary (`byAgent[].byCurrency`). Null unless every successful call of the agent
   * reported a cost in one single currency with one single costSource, and null for an agent without calls.
   */
  cost: number | null;
  lastSeenAt: number;
}

/** Usage figures of `AgentRecord`. They are projected from the usage reducer and never stored or written directly. */
export type LegacyUsageKeys = 'tokensInput' | 'tokensOutput' | 'cachedTokens' | 'reasoningTokens' | 'cost';

/** What the state keeps for an agent: its profile and status, never usage figures. */
export type StoredAgent = Omit<AgentRecord, LegacyUsageKeys>;

/** Input of the deprecated direct-write helpers: profile fields only. Usage figures only come from `llm.usage` events. */
export type AgentProfileInput = { id: string } & Partial<
  Pick<AgentRecord, 'name' | 'roleTitle' | 'role' | 'provider' | 'model' | 'status' | 'statusText' | 'workspace'>
>;

/** All derived server state: agents, runtimes, sessions, tasks, meetings and the usage reducer. */
export interface ServerState {
  runtimes: Map<string, RuntimeRecord>;
  sessions: Map<string, SessionRecord>;
  agents: Map<string, StoredAgent>;
  tasks: Map<string, any>;
  meetings: Map<string, any>;
  /** The only place that turns usage events into figures. Fed once per accepted event, never decremented. */
  usage: UsageReducer;
}

export function createServerState(): ServerState {
  return {
    runtimes: new Map(),
    sessions: new Map(),
    agents: new Map(),
    tasks: new Map(),
    meetings: new Map(),
    usage: createUsageReducer(),
  };
}

function toLegacyKeys(fields: LegacyUsageFields): Pick<AgentRecord, LegacyUsageKeys> {
  return {
    tokensInput: fields.tokens.input,
    tokensOutput: fields.tokens.output,
    cachedTokens: fields.tokens.cached,
    reasoningTokens: fields.tokens.reasoning,
    cost: fields.cost,
  };
}

/** Public view of a stored agent: its profile plus the deprecated usage fields projected from the reducer. */
export function toAgentRecord(state: ServerState, agent: StoredAgent): AgentRecord {
  return { ...agent, ...toLegacyKeys(state.usage.legacyAgent(agent.id)) };
}

/**
 * Applies one accepted event's side effects to `state`. Deterministic: it reads `event.timestamp`, never
 * `Date.now()`, and nothing random, so the live path and a replay from storage reach the same state.
 *
 * `skipUsage` (issue #70): set by a caller that already knows this acceptance did not produce a new usage ledger
 * row, because the id-based dedup an event store normally relies on cannot see past a retention purge. Once
 * events are purged independently of the ledger (issue #70), a resent event id with a still-recognized
 * `(provider, requestId)` key in the ledger is accepted again at the storage level (there is nothing left to
 * recognize it by there) but must not add its tokens and cost a second time here. Every other side effect
 * (runtimes, sessions, tasks, meetings, agent profile fields) still applies normally: only the usage figures are
 * the ones a double application would corrupt.
 */
export function applyEvent(state: ServerState, event: CanonicalEvent, options?: { skipUsage?: boolean }): void {
  const now = event.timestamp;

  // Usage figures: every accepted llm.usage and llm.failed event, with or without an agent.
  if (!options?.skipUsage) state.usage.apply(event);

  // Runtimes side effect. `runtime.connected` always sets the record's fields (issue #52), whether the runtime
  // is new or was auto-created earlier by an unrelated event; any other event with a runtimeId only bumps
  // `lastSeenAt` / `eventsCount` and auto-creates a runtime with `framework: 'external'` when none exists yet.
  if (event.runtimeId) {
    const rt = state.runtimes.get(event.runtimeId);
    if (event.type === 'runtime.connected') {
      const name = typeof event.payload?.name === 'string' ? event.payload.name : (rt?.name ?? event.runtimeId);
      const framework = typeof event.payload?.framework === 'string' ? event.payload.framework : (rt?.framework ?? 'external');
      const version = typeof event.payload?.version === 'string' ? event.payload.version : rt?.version;
      const metadata =
        event.payload?.metadata && typeof event.payload.metadata === 'object' ? event.payload.metadata : (rt?.metadata ?? {});
      state.runtimes.set(event.runtimeId, {
        id: event.runtimeId,
        name,
        framework,
        version,
        metadata,
        status: 'active',
        firstSeenAt: rt?.firstSeenAt ?? now,
        lastSeenAt: now,
        eventsCount: (rt?.eventsCount ?? 0) + 1,
      });
    } else if (rt) {
      rt.lastSeenAt = Math.max(rt.lastSeenAt, now);
      rt.eventsCount++;
    } else {
      state.runtimes.set(event.runtimeId, {
        id: event.runtimeId,
        name: event.runtimeId,
        framework: typeof event.payload?.framework === 'string' ? event.payload.framework : 'external',
        status: 'active',
        firstSeenAt: now,
        lastSeenAt: now,
        eventsCount: 1,
      });
    }
  }

  // Sessions side effect
  if (event.sessionId) {
    const ses = state.sessions.get(event.sessionId);
    if (ses) {
      ses.lastActiveAt = Math.max(ses.lastActiveAt, now);
      ses.eventsCount++;
    } else {
      state.sessions.set(event.sessionId, {
        id: event.sessionId,
        runtimeId: event.runtimeId,
        name: event.sessionId,
        createdAt: now,
        lastActiveAt: now,
        status: 'active',
        eventsCount: 1,
      });
    }
  }

  // Agent side effect & auto-registration
  const agentId = resolveEventAgentId(event);
  if (agentId !== null) {
    let ag = state.agents.get(agentId);
    if (!ag) {
      ag = {
        id: agentId,
        name: typeof event.payload?.name === 'string' ? event.payload.name : agentId,
        roleTitle: typeof event.payload?.roleTitle === 'string' ? event.payload.roleTitle : 'AI Agent',
        role: 'custom',
        provider: typeof event.payload?.provider === 'string' ? event.payload.provider : 'External',
        model: typeof event.payload?.model === 'string' ? event.payload.model : 'model',
        status: 'IDLE',
        statusText: 'Registered',
        workspace: 'development',
        lastSeenAt: now,
      };
      state.agents.set(agentId, ag);
    }

    ag.lastSeenAt = Math.max(ag.lastSeenAt, now);

    if (event.type === 'agent.registered' || event.type === 'agent.updated') {
      if (typeof event.payload?.name === 'string') ag.name = event.payload.name;
      if (typeof event.payload?.roleTitle === 'string') ag.roleTitle = event.payload.roleTitle;
      if (typeof event.payload?.role === 'string') ag.role = event.payload.role;
      if (typeof event.payload?.provider === 'string') ag.provider = event.payload.provider;
      if (typeof event.payload?.model === 'string') ag.model = event.payload.model;
      if (typeof event.payload?.workspace === 'string') ag.workspace = event.payload.workspace;
      if (event.type === 'agent.updated' && typeof event.payload?.statusText === 'string') {
        ag.statusText = event.payload.statusText;
      }
      // Only `agent.registered` carries an initial status: a later rename or profile edit (`agent.updated`)
      // never changes it, the same way `PATCH /api/v1/agents/:id` only changes status through its own event.
      if (event.type === 'agent.registered') {
        if (typeof event.payload?.status === 'string') ag.status = event.payload.status.toUpperCase();
        if (typeof event.payload?.statusText === 'string') ag.statusText = event.payload.statusText;
      }
    } else if (event.type === 'agent.status.changed') {
      if (typeof event.payload?.status === 'string') ag.status = event.payload.status.toUpperCase();
      if (typeof event.payload?.statusText === 'string') ag.statusText = event.payload.statusText;
      if (typeof event.payload?.workspace === 'string') ag.workspace = event.payload.workspace;
    } else if (event.type === 'tool.started') {
      ag.status = 'USING_TOOL';
      ag.statusText = `Using ${event.payload?.tool ?? 'tool'}`;
    } else if (event.type === 'tool.completed') {
      ag.status = 'IDLE';
      ag.statusText = 'Tool finished';
    } else if (event.type === 'tool.failed') {
      ag.status = 'ERROR';
      ag.statusText = 'Tool failed';
    } else if (event.type === 'llm.usage') {
      // Display only: the office shows the model the agent uses now. No usage figure ever reads these fields.
      if (typeof event.payload?.provider === 'string') ag.provider = event.payload.provider;
      if (typeof event.payload?.model === 'string') ag.model = event.payload.model;
    }
  }

  // Task side effect
  if (event.taskId || event.type.startsWith('task.')) {
    const taskId = event.taskId || event.payload?.taskId || event.payload?.id;
    if (taskId) {
      const task = state.tasks.get(taskId) || {
        id: taskId,
        title: event.payload?.title || event.summary,
        status: 'PENDING',
        assignedAgentId: event.payload?.assignedAgentId || event.agentId,
        progress: 0,
      };
      if (event.type === 'task.progress') {
        task.status = 'IN_PROGRESS';
        if (typeof event.payload?.progress === 'number') task.progress = event.payload.progress;
      } else if (event.type === 'task.completed') {
        task.status = 'COMPLETED';
        task.progress = 100;
      } else if (event.type === 'task.failed') {
        task.status = 'FAILED';
      } else if (event.type === 'task.blocked') {
        task.status = 'BLOCKED';
      }
      state.tasks.set(taskId, task);
    }
  }

  // Meeting side effect
  if (event.type.startsWith('meeting.')) {
    const meetingId = event.payload?.meetingId || event.id;
    const meeting = state.meetings.get(meetingId) || {
      id: meetingId,
      title: event.payload?.title || event.summary,
      status: 'ACTIVE',
      participants: event.payload?.participantIds || [],
    };
    if (event.type === 'meeting.ended' || event.type === 'meeting.cancelled') {
      meeting.status = 'CONCLUDED';
    }
    state.meetings.set(meetingId, meeting);
  }
}

/**
 * Deprecated direct-write affordance kept on `EventStore` for existing callers and tests. It bypasses the event
 * log entirely: nothing in `src/` or `server/index.ts` calls it any more (issue #52 moved `POST /agents` and
 * `PATCH /agents/:id` to event sourcing), and on `SQLiteEventStore` a call made this way does not survive a
 * restart, because the startup rebuild only replays stored events.
 */
export function upsertAgentProfile(state: ServerState, input: AgentProfileInput): AgentRecord {
  const existing = state.agents.get(input.id);
  const updated: StoredAgent = {
    id: input.id,
    name: input.name ?? existing?.name ?? input.id,
    roleTitle: input.roleTitle ?? existing?.roleTitle ?? 'AI Agent',
    role: input.role ?? existing?.role ?? 'custom',
    provider: input.provider ?? existing?.provider ?? 'Custom',
    model: input.model ?? existing?.model ?? 'Custom',
    status: input.status ?? existing?.status ?? 'IDLE',
    statusText: input.statusText ?? existing?.statusText ?? 'Active',
    workspace: input.workspace ?? existing?.workspace ?? 'development',
    lastSeenAt: Date.now(),
  };
  state.agents.set(input.id, updated);
  return toAgentRecord(state, updated);
}

/** Deprecated direct-write affordance, see `upsertAgentProfile`. */
export function upsertRuntimeDirect(state: ServerState, input: Partial<RuntimeRecord> & { id: string }): RuntimeRecord {
  const existing = state.runtimes.get(input.id);
  const updated: RuntimeRecord = {
    id: input.id,
    name: input.name ?? existing?.name ?? input.id,
    framework: input.framework ?? existing?.framework ?? 'custom',
    version: input.version ?? existing?.version,
    metadata: input.metadata ?? existing?.metadata ?? {},
    status: input.status ?? existing?.status ?? 'active',
    firstSeenAt: existing?.firstSeenAt ?? Date.now(),
    lastSeenAt: Date.now(),
    eventsCount: existing?.eventsCount ?? 0,
  };
  state.runtimes.set(input.id, updated);
  return updated;
}

/** Deprecated direct-write affordance, see `upsertAgentProfile`. */
export function upsertSessionDirect(state: ServerState, input: Partial<SessionRecord> & { id: string }): SessionRecord {
  const existing = state.sessions.get(input.id);
  const updated: SessionRecord = {
    id: input.id,
    runtimeId: input.runtimeId ?? existing?.runtimeId,
    name: input.name ?? existing?.name ?? input.id,
    createdAt: existing?.createdAt ?? Date.now(),
    lastActiveAt: Date.now(),
    status: input.status ?? existing?.status ?? 'active',
    eventsCount: existing?.eventsCount ?? 0,
  };
  state.sessions.set(input.id, updated);
  return updated;
}
