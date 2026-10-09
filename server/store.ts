import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { CanonicalEvent } from '../src/integrations/canonicalContract';

let _DatabaseSync: any = null;
function getDatabaseSync(): any {
  if (!_DatabaseSync) {
    const req = createRequire(import.meta.url);
    const sqliteMod = req('node:sqlite');
    _DatabaseSync = sqliteMod.DatabaseSync;
  }
  return _DatabaseSync;
}

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
  tokensInput: number;
  tokensOutput: number;
  cachedTokens: number;
  reasoningTokens: number;
  cost: number | null;
  lastSeenAt: number;
}

export type AgentProfileInput = { id: string } & Partial<
  Pick<AgentRecord, 'name' | 'roleTitle' | 'role' | 'provider' | 'model' | 'status' | 'statusText' | 'workspace'>
>;

export interface ViewerSnapshot {
  schemaVersion: '1.0';
  timestamp: number;
  lastEventId: string | null;
  runtimes: RuntimeRecord[];
  sessions: SessionRecord[];
  agents: AgentRecord[];
  activeTasks: any[];
  activeMeetings: any[];
  totalTokens: {
    input: number;
    output: number;
    cached: number;
    reasoning: number;
  };
  totalCost: number;
  eventsCount: number;
  events: CanonicalEvent[];
}

export interface ListEventsOptions {
  limit?: number;
  since?: number;
  afterId?: string;
  runtimeId?: string;
  sessionId?: string;
  agentId?: string;
  type?: string;
}

export interface EventStore {
  append(event: CanonicalEvent): Promise<{ accepted: boolean; duplicate: boolean }>;
  appendBatch(events: CanonicalEvent[]): Promise<{ accepted: number; duplicates: number; acceptedEvents: CanonicalEvent[] }>;
  exists(eventId: string): Promise<boolean>;
  list(options?: ListEventsOptions): Promise<CanonicalEvent[]>;
  snapshot(): Promise<ViewerSnapshot>;

  upsertRuntime(runtime: Partial<RuntimeRecord> & { id: string }): Promise<RuntimeRecord>;
  listRuntimes(): Promise<RuntimeRecord[]>;

  upsertSession(session: Partial<SessionRecord> & { id: string }): Promise<SessionRecord>;
  listSessions(): Promise<SessionRecord[]>;
  getSession(sessionId: string): Promise<SessionRecord | null>;

  upsertAgent(agent: AgentProfileInput): Promise<AgentRecord>;
  getAgent(agentId: string): Promise<AgentRecord | null>;
  listAgents(): Promise<AgentRecord[]>;

  close(): Promise<void>;
}

// -------------------------------------------------------------
// In-Memory Event Store
// -------------------------------------------------------------
export class MemoryEventStore implements EventStore {
  private events: CanonicalEvent[] = [];
  private eventIds = new Set<string>();
  private runtimes = new Map<string, RuntimeRecord>();
  private sessions = new Map<string, SessionRecord>();
  private agents = new Map<string, AgentRecord>();
  private tasks = new Map<string, any>();
  private meetings = new Map<string, any>();
  private totalTokens = { input: 0, output: 0, cached: 0, reasoning: 0 };
  private totalCost = 0;
  private maxEvents: number;

  constructor(maxEvents = 10000) {
    this.maxEvents = maxEvents;
  }

  async append(event: CanonicalEvent): Promise<{ accepted: boolean; duplicate: boolean }> {
    if (this.eventIds.has(event.id)) {
      return { accepted: true, duplicate: true };
    }

    this.eventIds.add(event.id);
    this.events.unshift(event);
    if (this.events.length > this.maxEvents) {
      const removed = this.events.pop();
      if (removed) this.eventIds.delete(removed.id);
    }

    this.processEventSideEffects(event);
    return { accepted: true, duplicate: false };
  }

  async appendBatch(events: CanonicalEvent[]): Promise<{ accepted: number; duplicates: number; acceptedEvents: CanonicalEvent[] }> {
    let accepted = 0;
    let duplicates = 0;
    const acceptedEvents: CanonicalEvent[] = [];

    for (const event of events) {
      if (this.eventIds.has(event.id)) {
        duplicates++;
      } else {
        this.eventIds.add(event.id);
        this.events.unshift(event);
        accepted++;
        acceptedEvents.push(event);
        this.processEventSideEffects(event);
      }
    }

    while (this.events.length > this.maxEvents) {
      const removed = this.events.pop();
      if (removed) this.eventIds.delete(removed.id);
    }

    return { accepted, duplicates, acceptedEvents };
  }

  async exists(eventId: string): Promise<boolean> {
    return this.eventIds.has(eventId);
  }

  async list(options: ListEventsOptions = {}): Promise<CanonicalEvent[]> {
    let result = [...this.events];

    if (options.runtimeId) {
      result = result.filter((e) => e.runtimeId === options.runtimeId);
    }
    if (options.sessionId) {
      result = result.filter((e) => e.sessionId === options.sessionId);
    }
    if (options.agentId) {
      result = result.filter((e) => e.agentId === options.agentId);
    }
    if (options.type) {
      result = result.filter((e) => e.type === options.type);
    }
    if (options.since !== undefined) {
      result = result.filter((e) => e.timestamp >= options.since!);
    }
    if (options.afterId) {
      const index = result.findIndex((e) => e.id === options.afterId);
      if (index >= 0) {
        result = result.slice(0, index);
      }
    }

    const limit = options.limit && options.limit > 0 ? options.limit : 100;
    return result.slice(0, limit);
  }

  async snapshot(): Promise<ViewerSnapshot> {
    return {
      schemaVersion: '1.0',
      timestamp: Date.now(),
      lastEventId: this.events[0]?.id ?? null,
      runtimes: Array.from(this.runtimes.values()),
      sessions: Array.from(this.sessions.values()),
      agents: Array.from(this.agents.values()),
      activeTasks: Array.from(this.tasks.values()).filter((t) => t.status !== 'COMPLETED' && t.status !== 'FAILED'),
      activeMeetings: Array.from(this.meetings.values()).filter((m) => m.status !== 'CONCLUDED'),
      totalTokens: { ...this.totalTokens },
      totalCost: this.totalCost,
      eventsCount: this.events.length,
      events: this.events.slice(0, 100),
    };
  }

  async upsertRuntime(runtime: Partial<RuntimeRecord> & { id: string }): Promise<RuntimeRecord> {
    const existing = this.runtimes.get(runtime.id);
    const updated: RuntimeRecord = {
      id: runtime.id,
      name: runtime.name ?? existing?.name ?? runtime.id,
      framework: runtime.framework ?? existing?.framework ?? 'custom',
      version: runtime.version ?? existing?.version,
      metadata: runtime.metadata ?? existing?.metadata ?? {},
      status: runtime.status ?? existing?.status ?? 'active',
      firstSeenAt: existing?.firstSeenAt ?? Date.now(),
      lastSeenAt: Date.now(),
      eventsCount: existing?.eventsCount ?? 0,
    };
    this.runtimes.set(runtime.id, updated);
    return updated;
  }

  async listRuntimes(): Promise<RuntimeRecord[]> {
    return Array.from(this.runtimes.values());
  }

  async upsertSession(session: Partial<SessionRecord> & { id: string }): Promise<SessionRecord> {
    const existing = this.sessions.get(session.id);
    const updated: SessionRecord = {
      id: session.id,
      runtimeId: session.runtimeId ?? existing?.runtimeId,
      name: session.name ?? existing?.name ?? session.id,
      createdAt: existing?.createdAt ?? Date.now(),
      lastActiveAt: Date.now(),
      status: session.status ?? existing?.status ?? 'active',
      eventsCount: existing?.eventsCount ?? 0,
    };
    this.sessions.set(session.id, updated);
    return updated;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return Array.from(this.sessions.values());
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async upsertAgent(agent: AgentProfileInput): Promise<AgentRecord> {
    const existing = this.agents.get(agent.id);
    const updated: AgentRecord = {
      id: agent.id,
      name: agent.name ?? existing?.name ?? agent.id,
      roleTitle: agent.roleTitle ?? existing?.roleTitle ?? 'AI Agent',
      role: agent.role ?? existing?.role ?? 'custom',
      provider: agent.provider ?? existing?.provider ?? 'Custom',
      model: agent.model ?? existing?.model ?? 'Custom',
      status: agent.status ?? existing?.status ?? 'IDLE',
      statusText: agent.statusText ?? existing?.statusText ?? 'Active',
      workspace: agent.workspace ?? existing?.workspace ?? 'development',
      tokensInput: existing ? existing.tokensInput : 0,
      tokensOutput: existing ? existing.tokensOutput : 0,
      cachedTokens: existing ? existing.cachedTokens : 0,
      reasoningTokens: existing ? existing.reasoningTokens : 0,
      cost: existing ? existing.cost : 0,
      lastSeenAt: Date.now(),
    };
    this.agents.set(agent.id, updated);
    return updated;
  }

  async getAgent(agentId: string): Promise<AgentRecord | null> {
    return this.agents.get(agentId) ?? null;
  }

  async listAgents(): Promise<AgentRecord[]> {
    return Array.from(this.agents.values());
  }

  async close(): Promise<void> {
    // In-memory does not require cleanup
  }

  private processEventSideEffects(event: CanonicalEvent): void {
    const now = event.timestamp || Date.now();

    // Runtimes side effect
    if (event.runtimeId) {
      const rt = this.runtimes.get(event.runtimeId);
      if (rt) {
        rt.lastSeenAt = Math.max(rt.lastSeenAt, now);
        rt.eventsCount++;
      } else {
        this.runtimes.set(event.runtimeId, {
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
      const ses = this.sessions.get(event.sessionId);
      if (ses) {
        ses.lastActiveAt = Math.max(ses.lastActiveAt, now);
        ses.eventsCount++;
      } else {
        this.sessions.set(event.sessionId, {
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
    const agentId = event.agentId || (event.source.startsWith('agent:') ? event.source.replace(/^agent:/, '') : undefined);
    if (agentId && agentId !== 'external-runtime' && agentId !== 'system' && !agentId.startsWith('runtime:')) {
      let ag = this.agents.get(agentId);
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
          tokensInput: 0,
          tokensOutput: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          cost: 0,
          lastSeenAt: now,
        };
        this.agents.set(agentId, ag);
      }

      ag.lastSeenAt = Math.max(ag.lastSeenAt, now);

      if (event.type === 'agent.registered' || event.type === 'agent.updated') {
        if (typeof event.payload?.name === 'string') ag.name = event.payload.name;
        if (typeof event.payload?.roleTitle === 'string') ag.roleTitle = event.payload.roleTitle;
        if (typeof event.payload?.provider === 'string') ag.provider = event.payload.provider;
        if (typeof event.payload?.model === 'string') ag.model = event.payload.model;
        if (typeof event.payload?.workspace === 'string') ag.workspace = event.payload.workspace;
        if (event.type === 'agent.updated' && typeof event.payload?.statusText === 'string') {
          ag.statusText = event.payload.statusText;
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
        const inTok = Number(event.payload?.inputTokens ?? 0);
        const outTok = Number(event.payload?.outputTokens ?? 0);
        const cacheTok = Number(event.payload?.cachedTokens ?? 0);
        const reasonTok = Number(event.payload?.reasoningTokens ?? 0);
        const cost = typeof event.payload?.cost === 'number' ? event.payload.cost : 0;

        ag.tokensInput += inTok;
        ag.tokensOutput += outTok;
        ag.cachedTokens += cacheTok;
        ag.reasoningTokens += reasonTok;
        ag.cost = (ag.cost ?? 0) + cost;

        if (typeof event.payload?.provider === 'string') ag.provider = event.payload.provider;
        if (typeof event.payload?.model === 'string') ag.model = event.payload.model;

        this.totalTokens.input += inTok;
        this.totalTokens.output += outTok;
        this.totalTokens.cached += cacheTok;
        this.totalTokens.reasoning += reasonTok;
        this.totalCost += cost;
      }
    }

    // Task side effect
    if (event.taskId || event.type.startsWith('task.')) {
      const taskId = event.taskId || event.payload?.taskId || event.payload?.id;
      if (taskId) {
        const task = this.tasks.get(taskId) || {
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
        this.tasks.set(taskId, task);
      }
    }

    // Meeting side effect
    if (event.type.startsWith('meeting.')) {
      const meetingId = event.payload?.meetingId || event.id;
      const meeting = this.meetings.get(meetingId) || {
        id: meetingId,
        title: event.payload?.title || event.summary,
        status: 'ACTIVE',
        participants: event.payload?.participantIds || [],
      };
      if (event.type === 'meeting.ended' || event.type === 'meeting.cancelled') {
        meeting.status = 'CONCLUDED';
      }
      this.meetings.set(meetingId, meeting);
    }
  }
}

// -------------------------------------------------------------
// SQLite Event Store (using Node 22 node:sqlite)
// -------------------------------------------------------------
export class SQLiteEventStore implements EventStore {
  private db: any;
  private memoryFallback: MemoryEventStore;
  private filePath: string;

  constructor(filePath = './data/agent-viewer.db') {
    this.filePath = filePath;
    const dir = path.dirname(filePath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const DBSync = getDatabaseSync();
    this.db = new DBSync(filePath);
    this.memoryFallback = new MemoryEventStore();
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        runtime_id TEXT,
        session_id TEXT,
        agent_id TEXT,
        task_id TEXT,
        severity TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_runtime ON events(runtime_id);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

      CREATE TABLE IF NOT EXISTS runtimes (
        id TEXT PRIMARY KEY,
        name TEXT,
        framework TEXT,
        version TEXT,
        metadata TEXT,
        status TEXT,
        first_seen_at INTEGER,
        last_seen_at INTEGER,
        events_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        runtime_id TEXT,
        name TEXT,
        created_at INTEGER,
        last_active_at INTEGER,
        status TEXT,
        events_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role_title TEXT,
        role TEXT,
        provider TEXT,
        model TEXT,
        status TEXT,
        status_text TEXT,
        workspace TEXT,
        tokens_input INTEGER DEFAULT 0,
        tokens_output INTEGER DEFAULT 0,
        cached_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        last_seen_at INTEGER
      );
    `);

    // Migration: databases created before 0.2.0 have no event_json column. Their rows stay readable
    // through the legacy column mapping in rowToEvent; new rows store the full canonical event.
    const columns = this.db.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'event_json')) {
      this.db.exec('ALTER TABLE events ADD COLUMN event_json TEXT');
    }
  }

  private insertEvent(insertStmt: any, event: CanonicalEvent): void {
    insertStmt.run(
      event.id,
      event.type,
      event.timestamp,
      event.runtimeId ?? null,
      event.sessionId ?? null,
      event.agentId ?? null,
      event.taskId ?? null,
      event.severity,
      event.summary,
      JSON.stringify(event.payload),
      JSON.stringify(event),
      Date.now()
    );
  }

  private prepareInsert(): any {
    return this.db.prepare(`
      INSERT INTO events (id, type, timestamp, runtime_id, session_id, agent_id, task_id, severity, summary, payload, event_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  private rowToEvent(r: any): CanonicalEvent {
    if (typeof r.event_json === 'string' && r.event_json.length > 0) {
      try {
        return JSON.parse(r.event_json) as CanonicalEvent;
      } catch {
        // Fall back to the column mapping below
      }
    }

    // Rows written before event_json existed: rebuild the event from the indexed columns.
    return {
      schemaVersion: '1.0' as const,
      id: r.id,
      type: r.type,
      timestamp: Number(r.timestamp),
      runtimeId: r.runtime_id ?? undefined,
      sessionId: r.session_id ?? undefined,
      source: r.agent_id ? `agent:${r.agent_id}` : (r.runtime_id ? `runtime:${r.runtime_id}` : 'external'),
      agentId: r.agent_id ?? undefined,
      taskId: r.task_id ?? undefined,
      severity: r.severity,
      summary: r.summary,
      payload: JSON.parse(r.payload || '{}'),
    };
  }

  async append(event: CanonicalEvent): Promise<{ accepted: boolean; duplicate: boolean }> {
    const checkStmt = this.db.prepare('SELECT id FROM events WHERE id = ?');
    const existing = checkStmt.get(event.id);
    if (existing) {
      return { accepted: true, duplicate: true };
    }

    this.insertEvent(this.prepareInsert(), event);

    await this.memoryFallback.append(event);
    return { accepted: true, duplicate: false };
  }

  async appendBatch(events: CanonicalEvent[]): Promise<{ accepted: number; duplicates: number; acceptedEvents: CanonicalEvent[] }> {
    let accepted = 0;
    let duplicates = 0;
    const acceptedEvents: CanonicalEvent[] = [];

    const checkStmt = this.db.prepare('SELECT id FROM events WHERE id = ?');
    const insertStmt = this.prepareInsert();

    for (const event of events) {
      const existing = checkStmt.get(event.id);
      if (existing) {
        duplicates++;
      } else {
        this.insertEvent(insertStmt, event);
        accepted++;
        acceptedEvents.push(event);
      }
    }

    await this.memoryFallback.appendBatch(acceptedEvents);
    return { accepted, duplicates, acceptedEvents };
  }

  async exists(eventId: string): Promise<boolean> {
    const stmt = this.db.prepare('SELECT id FROM events WHERE id = ?');
    return !!stmt.get(eventId);
  }

  async list(options: ListEventsOptions = {}): Promise<CanonicalEvent[]> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (options.runtimeId) {
      conditions.push('runtime_id = ?');
      params.push(options.runtimeId);
    }
    if (options.sessionId) {
      conditions.push('session_id = ?');
      params.push(options.sessionId);
    }
    if (options.agentId) {
      conditions.push('agent_id = ?');
      params.push(options.agentId);
    }
    if (options.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }
    if (options.since !== undefined) {
      conditions.push('timestamp >= ?');
      params.push(options.since);
    }
    if (options.afterId) {
      // Same semantics as the memory store: only events stored after the cursor event.
      // An unknown cursor applies no filter. rowid grows with insertion order.
      const cursor = this.db.prepare('SELECT rowid AS seq FROM events WHERE id = ?').get(options.afterId) as
        | { seq: number }
        | undefined;
      if (cursor) {
        conditions.push('rowid > ?');
        params.push(cursor.seq);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit && options.limit > 0 ? options.limit : 100;
    params.push(limit);

    const sql = `SELECT * FROM events ${whereClause} ORDER BY timestamp DESC, created_at DESC, rowid DESC LIMIT ?`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map((r) => this.rowToEvent(r));
  }

  async snapshot(): Promise<ViewerSnapshot> {
    return this.memoryFallback.snapshot();
  }

  async upsertRuntime(runtime: Partial<RuntimeRecord> & { id: string }): Promise<RuntimeRecord> {
    return this.memoryFallback.upsertRuntime(runtime);
  }

  async listRuntimes(): Promise<RuntimeRecord[]> {
    return this.memoryFallback.listRuntimes();
  }

  async upsertSession(session: Partial<SessionRecord> & { id: string }): Promise<SessionRecord> {
    return this.memoryFallback.upsertSession(session);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.memoryFallback.listSessions();
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.memoryFallback.getSession(sessionId);
  }

  async upsertAgent(agent: AgentProfileInput): Promise<AgentRecord> {
    return this.memoryFallback.upsertAgent(agent);
  }

  async getAgent(agentId: string): Promise<AgentRecord | null> {
    return this.memoryFallback.getAgent(agentId);
  }

  async listAgents(): Promise<AgentRecord[]> {
    return this.memoryFallback.listAgents();
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // Ignore if already closed
    }
  }
}

/**
 * Factory for creating the active EventStore based on configuration.
 */
export function createEventStore(): EventStore {
  const storageType = (process.env.AGENT_VIEWER_STORAGE || 'memory').toLowerCase();
  if (storageType === 'sqlite') {
    const dbPath = process.env.AGENT_VIEWER_SQLITE_PATH || './data/agent-viewer.db';
    return new SQLiteEventStore(dbPath);
  }
  return new MemoryEventStore();
}
