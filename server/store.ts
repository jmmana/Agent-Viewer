import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { CanonicalEvent } from '../src/integrations/canonicalContract';
import { MIGRATIONS, runMigrations, type Migration, type MigrationResult } from './db/migrations';
import { eventFingerprint } from './eventFingerprint';
import { readPackageVersion } from './version';
import {
  extractUsageFingerprintFields,
  fingerprintFieldsMatch,
  normalizeProvider,
  normalizeRequestId,
  requestKeyFor,
  requestKeyString,
  type UsageFingerprintFields,
} from './requestKey';
import { type UsageSummary } from './usageAggregates';
import {
  applyEvent,
  createServerState,
  toAgentRecord,
  upsertAgentProfile,
  upsertRuntimeDirect,
  upsertSessionDirect,
  type AgentProfileInput,
  type AgentRecord,
  type RuntimeRecord,
  type ServerState,
  type SessionRecord,
} from './serverState';

export type {
  AgentProfileInput,
  AgentRecord,
  LegacyUsageKeys,
  RuntimeRecord,
  SessionRecord,
} from './serverState';

function sqliteBackupMode(value: string | undefined): 'auto' | 'off' {
  const backup = value ?? 'auto';
  if (backup !== 'auto' && backup !== 'off') {
    throw new Error(`Invalid AGENT_VIEWER_SQLITE_BACKUP value "${backup}"; use "auto" or "off".`);
  }
  return backup;
}

let _DatabaseSync: any = null;
function getDatabaseSync(): any {
  if (!_DatabaseSync) {
    const req = createRequire(import.meta.url);
    const sqliteMod = req('node:sqlite');
    _DatabaseSync = sqliteMod.DatabaseSync;
  }
  return _DatabaseSync;
}

/**
 * Retention and completeness state of one store, so a reader never mistakes a truncated event list or a capped
 * `eventsCount` for the full history (issue #53). `storage: 'memory'` carries a real `maxEvents`; `'sqlite'`
 * always reports `maxEvents: null` because the database keeps every row.
 */
export interface SnapshotRetention {
  /** Store backend that produced this snapshot. */
  storage: 'memory' | 'sqlite';
  /** Cap on events kept for listing and replay. `null` when the store keeps every event. */
  maxEvents: number | null;
  /** Events currently available to `GET /api/v1/events` and SSE replay. */
  retainedEvents: number;
  /** Events accepted since `totalsSince`, including dropped ones. Duplicates are never counted. */
  acceptedEvents: number;
  /** Accepted events no longer retained. `0` means the event list is complete since `totalsSince`. */
  droppedEvents: number;
  /** Server receive time (ms) of the oldest retained event when `droppedEvents > 0`; `null` when nothing was dropped. */
  since: number | null;
  /** Server time (ms) from which totals and per-agent figures are counted. */
  totalsSince: number;
}

export interface ViewerSnapshot {
  schemaVersion: '1.0';
  timestamp: number;
  lastEventId: string | null;
  runtimes: RuntimeRecord[];
  sessions: SessionRecord[];
  agents: AgentRecord[];
  activeTasks: any[];
  activeMeetings: any[];
  /** Canonical usage figures, aggregated call by call. Same object as `GET /api/v1/usage`. */
  usage: UsageSummary;
  /** Counts of request-id duplicate references (issue #48). Never includes a duplicate's tokens or cost. */
  usageDuplicates: UsageDuplicateStats;
  /** @deprecated Use usage.total.tokens. Sum of reported values only; a lower bound when unreportedCount > 0. */
  totalTokens: {
    input: number;
    output: number;
    cached: number;
    reasoning: number;
  };
  /** @deprecated Use usage.total.byCurrency. Null unless every call reported a cost in one single currency with one single costSource. */
  totalCost: number | null;
  /** Retained window size: capped in memory mode, the true row count in SQLite mode. See `retention` for the rest. */
  eventsCount: number;
  events: CanonicalEvent[];
  /** No silent loss, no double counting (issue #53): tells a reader whether the list above is complete. */
  retention: SnapshotRetention;
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

/**
 * What the store did with one event. The id is the idempotency key, and the content decides between a retry and a
 * collision: `accepted` (new id, stored), `duplicate` (same id, same fingerprint, nothing done) or `conflict`
 * (same id, different fingerprint: not stored, not aggregated, not broadcast, stored row unchanged).
 */
export type AppendOutcome = 'accepted' | 'duplicate' | 'conflict';

/**
 * Why an event was classified as a duplicate (issue #48): the same event id was seen before (`event_id`,
 * the only reason before this issue), or a new id reported the same `(provider, requestId)` as an already
 * stored call (`request_id`).
 */
export type DuplicateReason = 'event_id' | 'request_id';

/**
 * Monotonic insertion sequence used only for SSE reconnect replay (issue #54). SQLite: the existing `events.seq`
 * column (issue #52), already a durable per-row counter independent of `rowid`. Memory: a per-process counter
 * assigned alongside the retained window. Never reused, never renumbered, comparable only within one store
 * instance.
 */
export type EventSeq = number;

/** One stored original event paired with its insertion sequence. Never a duplicate reference. */
export interface StoredEvent {
  seq: EventSeq;
  event: CanonicalEvent;
}

export interface AppendResult {
  outcome: AppendOutcome;
  /** The id the figure is held under: the original event id for a duplicate, the event's own id otherwise. */
  id: string;
  /** Fingerprint of the received event. */
  fingerprint: string;
  /** Fingerprint of the stored event; set when outcome is 'conflict'. */
  storedFingerprint?: string;
  /** Kept for existing callers and tests: true only when outcome === 'duplicate'. */
  duplicate: boolean;
  /** Kept for existing callers: true for 'accepted' and 'duplicate', false for 'conflict'. */
  accepted: boolean;
  /**
   * Insertion sequence of the stored row, for SSE reconnect replay (issue #54). Set only when `outcome` is
   * 'accepted'; `null` for a duplicate or a conflict, since neither one is broadcast on the live stream.
   */
  seq: EventSeq | null;
  /** Set when outcome === 'duplicate'. */
  duplicateReason?: DuplicateReason;
  /** The id the client actually sent. Present only when it differs from `id`. */
  submittedId?: string;
  /** Only for a 'request_id' duplicate: whether its usage-relevant fields match the original's. */
  matchesOriginal?: boolean | null;
}

/**
 * An auditable reference to a second (or later) report of a provider call already counted under `duplicateOf`.
 * Stored with full content so nothing is lost for audit, but never added to a total, never broadcast and never
 * returned by `GET /api/v1/events`. See `GET /api/v1/usage/duplicates`.
 */
export interface DuplicateReference {
  /** Submitted event id of the duplicate. */
  id: string;
  /** Original event id: the one totals and the office still count. */
  duplicateOf: string;
  type: 'llm.usage' | 'llm.failed';
  /** Normalized (trimmed, lowercased). */
  provider: string;
  /** Trimmed as submitted. */
  requestId: string;
  /** Server receive time in ms. */
  receivedAt: number;
  /** Null for a row migrated from 0.2.x, whose legacy content was never compared under this rule. */
  matchesOriginal: boolean | null;
  /** Full event exactly as submitted. */
  event: CanonicalEvent;
}

export interface UsageDuplicateStats {
  /** Every stored duplicate reference. */
  count: number;
  /** `matchesOriginal === false`. */
  mismatched: number;
  /** `matchesOriginal === null` (rows migrated from 0.2.x). Never counted as matched or mismatched. */
  unverified: number;
}

export interface AppendBatchResult {
  accepted: number;
  duplicates: number;
  conflicts: number;
  /** Same order and length as the input. */
  results: AppendResult[];
  /** Only outcome === 'accepted', in input order. */
  acceptedEvents: CanonicalEvent[];
  /**
   * Same order and length as `acceptedEvents`: the seq of each one, for SSE reconnect replay (issue #54). `null`
   * only in the rare case where an accepted item's row was never actually written (not something either store
   * implementation here does; kept so an alternate implementation never has to lie about a seq that does not exist).
   */
  acceptedSeqs: Array<EventSeq | null>;
}

/** Per-process ingestion counters, reset on restart. Exposed by `GET /ready`. */
export interface IngestionCounters {
  /** Conflicting duplicates rejected since process start. */
  conflicts: number;
  /** SQLite rows with a NULL content_hash that matched by id only, so their content could not be compared. */
  legacyUnverifiedDuplicates: number;
}

interface AppendResultExtra {
  duplicateReason?: DuplicateReason;
  submittedId?: string;
  matchesOriginal?: boolean | null;
  /** Insertion sequence of the stored row (issue #54). Only ever passed for outcome 'accepted'. */
  seq?: EventSeq;
}

/**
 * Builds the outcome of one classification. A 'duplicate' with no explicit reason is an `event_id` duplicate
 * (the only kind before issue #48): the id itself was already stored with the same content. `submittedId` is
 * added only when it differs from `id`, so an ordinary id resend keeps its original shape.
 */
function appendResult(
  outcome: AppendOutcome,
  id: string,
  fingerprint: string,
  storedFingerprint?: string,
  extra?: AppendResultExtra
): AppendResult {
  const duplicateReason = outcome === 'duplicate' ? (extra?.duplicateReason ?? 'event_id') : undefined;
  return {
    outcome,
    id,
    fingerprint,
    ...(outcome === 'conflict' ? { storedFingerprint } : {}),
    duplicate: outcome === 'duplicate',
    accepted: outcome !== 'conflict',
    seq: extra?.seq ?? null,
    ...(duplicateReason ? { duplicateReason } : {}),
    ...(extra?.submittedId !== undefined && extra.submittedId !== id ? { submittedId: extra.submittedId } : {}),
    ...(extra?.matchesOriginal !== undefined ? { matchesOriginal: extra.matchesOriginal } : {}),
  };
}

/** One warn line per mismatched duplicate. Holds only ids, provider and a truncated request id, never payload text. */
function warnRequestKeyMismatch(originalId: string, duplicateId: string, provider: string, requestId: string): void {
  console.warn(
    `[agent-viewer] Request-id duplicate does not match its original: ${JSON.stringify({
      provider,
      requestId: requestId.slice(0, 80),
      originalId,
      duplicateId,
    })}`
  );
}

/** One warn line per rejected conflict. It names the event but never logs the payload, which can hold content. */
function warnConflict(event: CanonicalEvent, fingerprint: string, storedFingerprint: string): void {
  console.warn(
    `[agent-viewer] Rejected conflicting duplicate: ${JSON.stringify({
      id: event.id,
      type: event.type,
      source: event.source,
      agentId: event.agentId ?? null,
      fingerprint,
      storedFingerprint,
    })}`
  );
}

function summarizeBatch(results: AppendResult[], events: CanonicalEvent[]): AppendBatchResult {
  let accepted = 0;
  let duplicates = 0;
  let conflicts = 0;
  const acceptedEvents: CanonicalEvent[] = [];
  const acceptedSeqs: Array<EventSeq | null> = [];
  results.forEach((result, index) => {
    if (result.outcome === 'accepted') {
      accepted++;
      acceptedEvents.push(events[index]);
      acceptedSeqs.push(result.seq);
    } else if (result.outcome === 'duplicate') {
      duplicates++;
    } else {
      conflicts++;
    }
  });
  return { accepted, duplicates, conflicts, results, acceptedEvents, acceptedSeqs };
}

export interface EventStore {
  /** Stores a new event, or classifies a repeated id as a duplicate (same content) or a conflict (different content). */
  append(event: CanonicalEvent): Promise<AppendResult>;
  /** Same rules as `append`, item by item in input order, also against earlier items of the same batch. */
  appendBatch(events: CanonicalEvent[], options?: { atomic?: boolean; ignoreTimestamp?: boolean }): Promise<AppendBatchResult>;
  /** Conflicts rejected and legacy rows matched by id only, since process start. */
  ingestionCounters(): IngestionCounters;
  /** True for an original event id and for a duplicate reference's own id. */
  exists(eventId: string): Promise<boolean>;
  /** Never includes a duplicate reference: only originals and events with no request key. */
  list(options?: ListEventsOptions): Promise<CanonicalEvent[]>;

  /**
   * Seq of a stored original event, for SSE reconnect replay (issue #54). `null` when the id was never stored,
   * is a duplicate reference's own id, or (memory store only) was evicted from the retained window.
   */
  resolveCursor(eventId: string): Promise<EventSeq | null>;
  /** Seq of the newest stored original event, or `null` when the store holds no original event. */
  headSeq(): Promise<EventSeq | null>;
  /** Number of original events with `afterSeq < seq <= upToSeq`. */
  countBetween(afterSeq: EventSeq, upToSeq: EventSeq): Promise<number>;
  /** Up to `limit` original events with `afterSeq < seq <= upToSeq`, ascending by seq (oldest of the range first). */
  listBetween(afterSeq: EventSeq, upToSeq: EventSeq, limit: number): Promise<StoredEvent[]>;

  snapshot(): Promise<ViewerSnapshot>;
  /** Retention and completeness state (issue #53), without building a full snapshot. */
  retention(): Promise<SnapshotRetention>;
  getSchemaInfo?(): { schemaVersion: number; latestKnownSchemaVersion: number; appliedAt: number | null } | undefined;
  /** Usage aggregates of every accepted `llm.usage` and `llm.failed` event. */
  usageSummary(): Promise<UsageSummary>;

  /** The original event id already stored under this `(provider, requestId)` key, normalizing both arguments. */
  findByRequest(provider: string, requestId: string): Promise<{ id: string } | null>;
  /** Duplicate references only (never originals), newest `receivedAt` first, ties newest-inserted first. */
  listDuplicates(options?: {
    limit?: number;
    provider?: string;
    requestId?: string;
    duplicateOf?: string;
  }): Promise<DuplicateReference[]>;

  upsertRuntime(runtime: Partial<RuntimeRecord> & { id: string }): Promise<RuntimeRecord>;
  listRuntimes(): Promise<RuntimeRecord[]>;

  upsertSession(session: Partial<SessionRecord> & { id: string }): Promise<SessionRecord>;
  listSessions(): Promise<SessionRecord[]>;
  getSession(sessionId: string): Promise<SessionRecord | null>;

  /** Creates or updates an agent profile. Usage fields passed by a caller are ignored. */
  upsertAgent(agent: AgentProfileInput): Promise<AgentRecord>;
  getAgent(agentId: string): Promise<AgentRecord | null>;
  listAgents(): Promise<AgentRecord[]>;

  /**
   * Runs once: for `MemoryEventStore` resolves at once (there is nothing to replay); for `SQLiteEventStore`
   * replays every stored event through `applyEvent` in `seq` order (issue #52). Safe to call more than once;
   * later calls return the same promise. `server/index.ts` calls this right after `createEventStore()` without
   * awaiting it, so the server can start listening and report progress through `/ready` while it runs.
   */
  init(): Promise<void>;
  /** Current readiness, read by `GET /ready` and by the `requireReady` guard on routes that need derived state. */
  readiness(): StoreReadiness;

  close(): Promise<void>;
}

/** Progress of a `SQLiteEventStore` startup rebuild. `'idle'` only exists before `init()` has run at all. */
export type RebuildState = 'idle' | 'running' | 'done' | 'failed';

export interface RebuildProgress {
  state: RebuildState;
  /** `COUNT(*)` of the `events` table taken when the rebuild started. Informational: more rows can arrive while it runs. */
  totalEvents: number;
  /** Rows applied to state so far (an intentionally-skipped duplicate reference still counts as processed). */
  processedEvents: number;
  /** Rows that could not be parsed, or whose `applyEvent` step threw. Never applied. */
  skippedEvents: number;
  /** The first 20 ids of `skippedEvents`, for `/ready` and the log. */
  skippedEventIds: string[];
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  /** Only set when `state === 'failed'`. */
  error?: string;
}

export interface StoreReadiness {
  ready: boolean;
  storage: 'memory' | 'sqlite';
  rebuild: RebuildProgress;
}

export interface SQLiteStoreOptions {
  backup?: 'auto' | 'off';
  appVersion?: string;
  migrations?: readonly Migration[];
  /** Rows replayed per page of the startup rebuild. Default 2000, env `AGENT_VIEWER_REBUILD_PAGE_SIZE`. */
  rebuildPageSize?: number;
  /** Extra delay awaited after each page, for tests and diagnostics. Default 0, env `AGENT_VIEWER_REBUILD_PAGE_DELAY_MS`. */
  rebuildPageDelayMs?: number;
  /** Test hook: awaited after each page, after `rebuildPageDelayMs`. */
  yieldBetweenPages?: (progress: { processedEvents: number; totalEvents: number }) => Promise<void> | void;
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

// -------------------------------------------------------------
// In-Memory Event Store
// -------------------------------------------------------------
/** One retained event plus the server clock value at which it was accepted (issue #53). */
interface RetainedEntry {
  event: CanonicalEvent;
  receivedAt: number;
  /** Insertion sequence, for SSE reconnect replay (issue #54). Strictly increasing with every push. */
  seq: EventSeq;
}

/**
 * Append-only ring buffer for the retained event window (issue #53). The backing array grows lazily with `push`
 * until it reaches `capacity`, so it is never preallocated: a cap like `AGENT_VIEWER_MAX_EVENTS=1000000000` does
 * not allocate a proportional array at startup. `push` and eviction are O(1); `forEachNewestToOldest` lets a
 * caller stop early instead of copying the whole window.
 */
class RetainedWindow {
  private buf: RetainedEntry[] = [];
  private writeIndex = 0;

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.buf.length;
  }

  /** Appends one entry. Returns the evicted entry, or `null` when the window was not yet full. */
  push(entry: RetainedEntry): RetainedEntry | null {
    let evicted: RetainedEntry | null = null;
    if (this.buf.length < this.capacity) {
      this.buf.push(entry);
    } else {
      const slot = this.writeIndex % this.capacity;
      evicted = this.buf[slot];
      this.buf[slot] = entry;
    }
    this.writeIndex++;
    return evicted;
  }

  /** The oldest retained entry, or `undefined` when the window is empty. */
  oldest(): RetainedEntry | undefined {
    if (this.buf.length === 0) return undefined;
    const idx = this.buf.length < this.capacity ? 0 : this.writeIndex % this.capacity;
    return this.buf[idx];
  }

  /** The most recently pushed entry, or `undefined` when the window is empty. */
  newest(): RetainedEntry | undefined {
    if (this.buf.length === 0) return undefined;
    // writeIndex is always >= 1 here (something was pushed), so writeIndex - 1 is never negative.
    return this.buf[(this.writeIndex - 1) % this.capacity];
  }

  /**
   * Walks entries newest to oldest. `fn` returns `false` to stop early, so a caller with a small limit never
   * forces a copy of the whole window.
   */
  forEachNewestToOldest(fn: (entry: RetainedEntry) => boolean | void): void {
    const n = this.buf.length;
    if (n === 0) return;
    let idx = (this.writeIndex - 1) % this.capacity;
    for (let i = 0; i < n; i++) {
      const keepGoing = fn(this.buf[idx]);
      if (keepGoing === false) return;
      idx = (idx - 1 + this.capacity) % this.capacity;
    }
  }
}

export interface MemoryEventStoreOptions {
  /** Cap on the retained window. Default `10000`; must be an integer >= 1. */
  maxEvents?: number;
  /**
   * When `false`, an evicted event's id is forgotten from the dedup index. Default `true`: a long-running memory
   * mode server must never double count a retry of an evicted id.
   */
  rememberEvictedIds?: boolean;
  /** Server clock, injected so tests can pin `receivedAt`. Default `Date.now`. */
  now?: () => number;
}

const DEFAULT_MAX_EVENTS = 10000;
/** `knownIds.size` threshold at which a single one-time memory-cost warning is logged. */
const KNOWN_IDS_WARNING_THRESHOLD = 1_000_000;

export class MemoryEventStore implements EventStore {
  /** Retained window: what `list()`, `snapshot().events` and SSE replay can see. Eviction here never erases dedup state. */
  private window: RetainedWindow;
  /**
   * Id to fingerprint of every event accepted since the process started. Eviction from the retained window never
   * deletes an entry here (unless `rememberEvictedIds` is false), so a retry of an evicted id is still recognized
   * as a duplicate instead of being counted twice (issue #53).
   */
  private eventHashes = new Map<string, string>();
  /**
   * Id to insertion seq of every event currently in the retained window (issue #54), kept in lockstep with it:
   * eviction always removes the entry here, independent of `rememberEvictedIds` (which only governs dedup
   * memory). `resolveCursor` relies on this to turn an evicted id into an explicit resync instead of a reconnect
   * replayed from the wrong point.
   */
  private eventSeqs = new Map<string, EventSeq>();
  /** Next seq to assign (issue #54). Never reused or reset, even across eviction. */
  private nextSeq: EventSeq = 1;
  /**
   * Original event id (plus its usage-relevant fields, for the fingerprint comparison) seen so far for each
   * `(provider, requestId)` key. On purpose never evicted when the original falls off the retained window: a late
   * retry after eviction must still be recognized as a duplicate (issue #48, finalized by #53).
   */
  private requestIndex = new Map<string, { id: string; fields: UsageFingerprintFields }>();
  /**
   * Duplicate references, keyed by the duplicate's own submitted event id, insertion ordered and capped at
   * `maxEvents` like the event ring. Never pushed into the retained window, so `list()`, `snapshot().events` and
   * SSE replay never see them.
   */
  private duplicateRefs = new Map<string, DuplicateReference>();
  private counters: IngestionCounters = { conflicts: 0, legacyUnverifiedDuplicates: 0 };
  /** Agents, runtimes, sessions, tasks, meetings and usage: everything `applyEvent` (`serverState.ts`) owns. */
  private state: ServerState = createServerState();
  private maxEvents: number;
  private rememberEvictedIds: boolean;
  private now: () => number;
  /** Server time (ms) when the store was created. Totals cover events from here (issue #53). */
  private startedAt: number;
  private readonly createdAt = Date.now();
  /** Events accepted (not duplicates) since `startedAt`, including evicted ones. */
  private acceptedEvents = 0;
  /** Accepted events evicted from the retained window. */
  private droppedEvents = 0;
  private warnedKnownIdsSize = false;

  constructor(options?: number | MemoryEventStoreOptions) {
    const opts: MemoryEventStoreOptions = typeof options === 'number' ? { maxEvents: options } : (options ?? {});
    const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new Error(`MemoryEventStore maxEvents must be a positive integer, got ${maxEvents}`);
    }
    this.maxEvents = maxEvents;
    this.rememberEvictedIds = opts.rememberEvictedIds ?? true;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.window = new RetainedWindow(maxEvents);
  }

  /** Nothing to replay: a `MemoryEventStore` starts empty and is ready as soon as it is constructed. */
  async init(): Promise<void> {
    return;
  }

  readiness(): StoreReadiness {
    return {
      ready: true,
      storage: 'memory',
      rebuild: {
        state: 'done',
        totalEvents: 0,
        processedEvents: 0,
        skippedEvents: 0,
        skippedEventIds: [],
        startedAt: this.createdAt,
        finishedAt: this.createdAt,
        durationMs: 0,
      },
    };
  }

  /**
   * Classifies one event and stores it when it is new. Synchronous on purpose: nothing can run between a lookup
   * and an insert, so concurrent requests cannot interleave. Checks, in order: the event id against a stored
   * original, the event id against a stored duplicate reference (issue #48: its own id is remembered too, so
   * resending it still resolves to the original), and finally the request key for `llm.usage` / `llm.failed`.
   */
  private classifyAndApply(event: CanonicalEvent, ignoreTimestamp = false): AppendResult {
    const fingerprint = eventFingerprint(event, ignoreTimestamp);

    const storedFingerprint = this.eventHashes.get(event.id);
    if (storedFingerprint !== undefined) {
      if (storedFingerprint === fingerprint) return appendResult('duplicate', event.id, fingerprint);
      this.counters.conflicts++;
      warnConflict(event, fingerprint, storedFingerprint);
      return appendResult('conflict', event.id, fingerprint, storedFingerprint);
    }

    const existingRef = this.duplicateRefs.get(event.id);
    if (existingRef) {
      const refFingerprint = eventFingerprint(existingRef.event, ignoreTimestamp);
      if (refFingerprint === fingerprint) {
        return appendResult('duplicate', existingRef.duplicateOf, fingerprint, undefined, { submittedId: event.id });
      }
      this.counters.conflicts++;
      warnConflict(event, fingerprint, refFingerprint);
      return appendResult('conflict', event.id, fingerprint, refFingerprint);
    }

    const requestKey = requestKeyFor(event);
    if (requestKey) {
      const original = this.requestIndex.get(requestKey.key);
      if (original) {
        const fields = extractUsageFingerprintFields(event);
        const matchesOriginal = fingerprintFieldsMatch(original.fields, fields);
        if (!matchesOriginal) warnRequestKeyMismatch(original.id, event.id, requestKey.provider, requestKey.requestId);
        const ref: DuplicateReference = {
          id: event.id,
          duplicateOf: original.id,
          type: event.type as 'llm.usage' | 'llm.failed',
          provider: requestKey.provider,
          requestId: requestKey.requestId,
          receivedAt: Date.now(),
          matchesOriginal,
          event,
        };
        this.duplicateRefs.set(event.id, ref);
        this.evictDuplicateOverflow();
        return appendResult('duplicate', original.id, fingerprint, undefined, {
          duplicateReason: 'request_id',
          submittedId: event.id,
          matchesOriginal,
        });
      }
    }

    this.eventHashes.set(event.id, fingerprint);
    this.acceptedEvents++;
    const receivedAt = this.now();
    const seq = this.nextSeq++;
    this.eventSeqs.set(event.id, seq);
    const evicted = this.window.push({ event, receivedAt, seq });
    if (evicted) {
      this.droppedEvents++;
      this.eventSeqs.delete(evicted.event.id);
      // Eviction never forgets a dedup id, except when `rememberEvictedIds` is false (not used by the default
      // constructor; kept for a future store that delegates its dedup authority elsewhere).
      if (!this.rememberEvictedIds) this.eventHashes.delete(evicted.event.id);
    }
    this.maybeWarnKnownIdsSize();
    this.processEventSideEffects(event);
    if (requestKey) {
      this.requestIndex.set(requestKey.key, { id: event.id, fields: extractUsageFingerprintFields(event) });
    }
    return appendResult('accepted', event.id, fingerprint, undefined, { seq });
  }

  /** One warning, the first time the dedup index crosses the documented memory-cost threshold. */
  private maybeWarnKnownIdsSize(): void {
    if (this.warnedKnownIdsSize || this.eventHashes.size < KNOWN_IDS_WARNING_THRESHOLD) return;
    this.warnedKnownIdsSize = true;
    console.warn(
      `[agent-viewer] memory store has seen ${KNOWN_IDS_WARNING_THRESHOLD} event ids; use AGENT_VIEWER_STORAGE=sqlite for long-running servers.`
    );
  }

  /** Mirrors the retained window's eviction for duplicate references. A resend of a dropped reference's id is simply a new request_id duplicate again. */
  private evictDuplicateOverflow(): void {
    while (this.duplicateRefs.size > this.maxEvents) {
      const oldestKey = this.duplicateRefs.keys().next().value;
      if (oldestKey === undefined) break;
      this.duplicateRefs.delete(oldestKey);
    }
  }

  async append(event: CanonicalEvent): Promise<AppendResult> {
    return this.classifyAndApply(event);
  }

  async appendBatch(events: CanonicalEvent[], options?: { atomic?: boolean; ignoreTimestamp?: boolean }): Promise<AppendBatchResult> {
    const atomic = options?.atomic ?? false;
    const ignoreTimestamp = options?.ignoreTimestamp ?? false;

    if (atomic) {
      // Check all conflicts before inserting any
      for (const event of events) {
        const fingerprint = eventFingerprint(event, ignoreTimestamp);
        const storedFingerprint = this.eventHashes.get(event.id);
        if (storedFingerprint !== undefined && storedFingerprint !== fingerprint) {
          // Conflict found: reject the entire batch
          const results = events.map((e) => {
            const fp = eventFingerprint(e, ignoreTimestamp);
            const stored = this.eventHashes.get(e.id);
            if (stored === undefined) {
              return appendResult('accepted', e.id, fp);
            }
            if (stored === fp) {
              return appendResult('duplicate', e.id, fp);
            }
            this.counters.conflicts++;
            return appendResult('conflict', e.id, fp, stored);
          });
          return summarizeBatch(results, events);
        }
      }
      // All checks passed, now insert. Each item evicts through the ring as it is pushed, in order, so a batch
      // larger than maxEvents still retains exactly the newest maxEvents events (issue #53).
      const results = events.map((event) => this.classifyAndApply(event, ignoreTimestamp));
      return summarizeBatch(results, events);
    } else {
      const results = events.map((event) => this.classifyAndApply(event, ignoreTimestamp));
      return summarizeBatch(results, events);
    }
  }

  ingestionCounters(): IngestionCounters {
    return { ...this.counters };
  }

  async exists(eventId: string): Promise<boolean> {
    return this.eventHashes.has(eventId) || this.duplicateRefs.has(eventId);
  }

  async findByRequest(provider: string, requestId: string): Promise<{ id: string } | null> {
    const found = this.requestIndex.get(requestKeyString(provider, requestId));
    return found ? { id: found.id } : null;
  }

  async listDuplicates(
    options: { limit?: number; provider?: string; requestId?: string; duplicateOf?: string } = {}
  ): Promise<DuplicateReference[]> {
    // Insertion order is oldest first; reverse once so ties after the stable sort below stay newest-inserted first.
    let refs = Array.from(this.duplicateRefs.values()).reverse();
    if (options.provider) {
      const provider = normalizeProvider(options.provider);
      refs = refs.filter((ref) => ref.provider === provider);
    }
    if (options.requestId) {
      const requestId = normalizeRequestId(options.requestId);
      refs = refs.filter((ref) => ref.requestId === requestId);
    }
    if (options.duplicateOf) {
      refs = refs.filter((ref) => ref.duplicateOf === options.duplicateOf);
    }
    refs.sort((a, b) => b.receivedAt - a.receivedAt);
    const limit = options.limit && options.limit > 0 ? options.limit : 100;
    return refs.slice(0, limit);
  }

  private usageDuplicateStats(): UsageDuplicateStats {
    let mismatched = 0;
    let unverified = 0;
    for (const ref of this.duplicateRefs.values()) {
      if (ref.matchesOriginal === false) mismatched++;
      else if (ref.matchesOriginal === null) unverified++;
    }
    return { count: this.duplicateRefs.size, mismatched, unverified };
  }

  /**
   * Same ordering and filter semantics as the previous array implementation (newest first; `runtimeId`,
   * `sessionId`, `agentId`, `type`, `since` filter on `event.timestamp`; `afterId` is exclusive and applied after
   * the other filters; an `afterId` not found, or filtered out, applies no cut; default limit 100). Walks the
   * ring newest to oldest and stops as soon as `limit` entries are collected, instead of copying the whole
   * window per call (issue #53).
   */
  async list(options: ListEventsOptions = {}): Promise<CanonicalEvent[]> {
    const limit = options.limit && options.limit > 0 ? options.limit : 100;
    const matches = (event: CanonicalEvent): boolean => {
      if (options.runtimeId && event.runtimeId !== options.runtimeId) return false;
      if (options.sessionId && event.sessionId !== options.sessionId) return false;
      if (options.agentId && event.agentId !== options.agentId) return false;
      if (options.type && event.type !== options.type) return false;
      if (options.since !== undefined && event.timestamp < options.since) return false;
      return true;
    };

    const result: CanonicalEvent[] = [];
    this.window.forEachNewestToOldest(({ event }) => {
      if (!matches(event)) return true;
      // Mirrors `result.slice(0, index)` on the equivalent array implementation: everything from the cursor
      // onward (older, in this walk order) is excluded, whether or not `limit` was reached yet.
      if (options.afterId && event.id === options.afterId) return false;
      result.push(event);
      return result.length < limit;
    });
    return result;
  }

  /** The newest `limit` retained events, with no filter. Used by `snapshot().events`. */
  private topEvents(limit: number): CanonicalEvent[] {
    const result: CanonicalEvent[] = [];
    this.window.forEachNewestToOldest(({ event }) => {
      result.push(event);
      return result.length < limit;
    });
    return result;
  }

  /** `null` for an id never stored, or (issue #54) one evicted from the retained window since. */
  async resolveCursor(eventId: string): Promise<EventSeq | null> {
    return this.eventSeqs.get(eventId) ?? null;
  }

  /** The seq of the newest retained entry, or `null` when the window is empty (issue #54). */
  async headSeq(): Promise<EventSeq | null> {
    return this.window.newest()?.seq ?? null;
  }

  /**
   * Walks the ring newest to oldest (issue #54), same traversal `list()` uses: skips entries newer than
   * `upToSeq` (a live event accepted after the caller captured its head), then collects while `seq > afterSeq`,
   * stopping as soon as it reaches the cursor. `fn` sees entries in that same newest-to-oldest order.
   */
  private walkBetween(afterSeq: EventSeq, upToSeq: EventSeq, fn: (entry: RetainedEntry) => void): void {
    if (upToSeq <= afterSeq) return;
    this.window.forEachNewestToOldest((entry) => {
      if (entry.seq > upToSeq) return true;
      if (entry.seq <= afterSeq) return false;
      fn(entry);
      return true;
    });
  }

  async countBetween(afterSeq: EventSeq, upToSeq: EventSeq): Promise<number> {
    let count = 0;
    this.walkBetween(afterSeq, upToSeq, () => count++);
    return count;
  }

  async listBetween(afterSeq: EventSeq, upToSeq: EventSeq, limit: number): Promise<StoredEvent[]> {
    if (limit <= 0) return [];
    const collected: StoredEvent[] = [];
    this.walkBetween(afterSeq, upToSeq, (entry) => collected.push({ seq: entry.seq, event: entry.event }));
    // Collected newest to oldest; ascending (oldest of the range first) is a single reverse away.
    collected.reverse();
    return collected.slice(0, limit);
  }

  async retention(): Promise<SnapshotRetention> {
    return {
      storage: 'memory',
      maxEvents: this.maxEvents,
      retainedEvents: this.window.size,
      acceptedEvents: this.acceptedEvents,
      droppedEvents: this.droppedEvents,
      since: this.droppedEvents > 0 ? (this.window.oldest()?.receivedAt ?? null) : null,
      totalsSince: this.startedAt,
    };
  }

  async snapshot(): Promise<ViewerSnapshot> {
    const legacy = this.state.usage.legacyTotals();
    return {
      schemaVersion: '1.0',
      timestamp: Date.now(),
      lastEventId: this.window.newest()?.event.id ?? null,
      runtimes: Array.from(this.state.runtimes.values()),
      sessions: Array.from(this.state.sessions.values()),
      agents: Array.from(this.state.agents.values(), (agent) => toAgentRecord(this.state, agent)),
      activeTasks: Array.from(this.state.tasks.values()).filter((t) => t.status !== 'COMPLETED' && t.status !== 'FAILED'),
      activeMeetings: Array.from(this.state.meetings.values()).filter((m) => m.status !== 'CONCLUDED'),
      usage: this.state.usage.summary(),
      usageDuplicates: this.usageDuplicateStats(),
      totalTokens: legacy.tokens,
      totalCost: legacy.cost,
      eventsCount: this.window.size,
      events: this.topEvents(100),
      retention: await this.retention(),
    };
  }

  async usageSummary(): Promise<UsageSummary> {
    return this.state.usage.summary();
  }

  async upsertRuntime(runtime: Partial<RuntimeRecord> & { id: string }): Promise<RuntimeRecord> {
    return upsertRuntimeDirect(this.state, runtime);
  }

  async listRuntimes(): Promise<RuntimeRecord[]> {
    return Array.from(this.state.runtimes.values());
  }

  async upsertSession(session: Partial<SessionRecord> & { id: string }): Promise<SessionRecord> {
    return upsertSessionDirect(this.state, session);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return Array.from(this.state.sessions.values());
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.state.sessions.get(sessionId) ?? null;
  }

  async upsertAgent(agent: AgentProfileInput): Promise<AgentRecord> {
    return upsertAgentProfile(this.state, agent);
  }

  async getAgent(agentId: string): Promise<AgentRecord | null> {
    const agent = this.state.agents.get(agentId);
    return agent ? toAgentRecord(this.state, agent) : null;
  }

  async listAgents(): Promise<AgentRecord[]> {
    return Array.from(this.state.agents.values(), (agent) => toAgentRecord(this.state, agent));
  }

  async close(): Promise<void> {
    // In-memory does not require cleanup
  }

  /** Applies one accepted event's side effects. The reducer itself lives in `serverState.ts` (issue #52), shared
   * with `SQLiteEventStore` so the live path and a rebuild from storage reach the same state. */
  private processEventSideEffects(event: CanonicalEvent): void {
    applyEvent(this.state, event);
  }
}

// -------------------------------------------------------------
// SQLite Event Store (using Node 22 node:sqlite)
// -------------------------------------------------------------
/** Only one warn line per process for rows whose content cannot be compared. */
let warnedLegacyUnverified = false;

function isUniqueIdViolation(error: unknown): boolean {
  const err = error as { errcode?: number; message?: string } | null;
  // SQLITE_CONSTRAINT_PRIMARYKEY (1555) or SQLITE_CONSTRAINT_UNIQUE (2067) on events.id.
  return err?.errcode === 1555 || /UNIQUE constraint failed: events\.id/.test(err?.message ?? '');
}

/**
 * True for a violation of `idx_events_request_key`, the partial unique index on `(request_provider, request_id)`
 * added by issue #48. Matched on the column names in the message, never on `events.id`, so a primary key
 * violation is never mistaken for a request-key race.
 */
function isUniqueRequestKeyViolation(error: unknown): boolean {
  const err = error as { errcode?: number; message?: string } | null;
  return err?.errcode === 2067 && /UNIQUE constraint failed: events\.request_provider, events\.request_id/.test(err?.message ?? '');
}

/** What a SQLite classification decided, before the side effects (counters, logs) that wait for the commit. */
interface PendingOutcome {
  result: AppendResult;
  event: CanonicalEvent;
  legacyUnverified: boolean;
  /** Set when a request-id duplicate's fields do not match its original, so one warning is logged after commit. */
  requestKeyMismatch?: { originalId: string; duplicateId: string; provider: string; requestId: string };
}

const DEFAULT_REBUILD_PAGE_SIZE = 2000;

function envInt(value: string | undefined, fallback: number): number {
  const parsed = value !== undefined ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

const consoleLogger = { info: console.log, warn: console.warn, error: console.error };

export class SQLiteEventStore implements EventStore {
  private db: any;
  private counters: IngestionCounters = { conflicts: 0, legacyUnverifiedDuplicates: 0 };
  readonly migration: MigrationResult;
  private migrations: readonly Migration[];

  /** All derived state (agents, runtimes, sessions, tasks, meetings, usage). Owned directly: issue #52 removed
   * the `MemoryEventStore` fallback this store used to forward every accepted event to. */
  private readonly state: ServerState = createServerState();
  /** `seq` to give the next inserted row. Seeded from `MAX(seq)` after migrations run. */
  private nextSeq = 1;
  /** Count of stored rows with `duplicate_of IS NULL`, kept so `snapshot().eventsCount` never scans the table. */
  private eventsCountCache = 0;
  /**
   * Server receive time of the oldest stored event; `null` only until the first event is ever accepted by this
   * database (issue #53). Set from the real stored `created_at` of that first row, never from a fresh `Date.now()`
   * taken before anything existed, so this value is bit-for-bit identical before and after a restart
   * (`tests/sqlite-restart.test.mjs`). Since the startup rebuild makes `this.state` cover every stored row, this
   * is also when the totals it holds start covering, and that start point never moves as new events arrive.
   */
  private totalsSinceCache: number | null = null;
  private readonly rebuildOptions: {
    pageSize: number;
    pageDelayMs: number;
    yieldBetweenPages?: (progress: { processedEvents: number; totalEvents: number }) => Promise<void> | void;
    logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  };
  private rebuild: RebuildProgress = {
    state: 'idle',
    totalEvents: 0,
    processedEvents: 0,
    skippedEvents: 0,
    skippedEventIds: [],
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  };
  /** Memoized so `init()` is safe to call more than once (`server/index.ts` and the constructor both call it). */
  private initPromise: Promise<void> | null = null;
  /** Set by `close()`. The rebuild loop checks it before every SQL statement after an `await`, so a close mid-rebuild never throws on a closed connection. */
  private closed = false;

  constructor(filePath = './data/agent-viewer.db', options: SQLiteStoreOptions = {}) {
    const backup = sqliteBackupMode(options.backup ?? process.env.AGENT_VIEWER_SQLITE_BACKUP);

    const dir = path.dirname(filePath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.rebuildOptions = {
      pageSize: options.rebuildPageSize ?? envInt(process.env.AGENT_VIEWER_REBUILD_PAGE_SIZE, DEFAULT_REBUILD_PAGE_SIZE),
      pageDelayMs: options.rebuildPageDelayMs ?? envInt(process.env.AGENT_VIEWER_REBUILD_PAGE_DELAY_MS, 0),
      yieldBetweenPages: options.yieldBetweenPages,
      logger: options.logger ?? consoleLogger,
    };

    const DBSync = getDatabaseSync();
    this.db = new DBSync(filePath);
    this.migrations = options.migrations ?? MIGRATIONS;
    try {
      this.migration = runMigrations(this.db, {
        appVersion: options.appVersion ?? readPackageVersion(),
        filePath,
        backup,
        migrations: this.migrations,
      });
      if (this.migration.applied.length > 0) {
        const { fromVersion, toVersion, backupPath } = this.migration;
        const appliedNames = this.migration.applied.map(({ name }) => name).join(', ');
        console.log(
          `[agent-viewer] SQLite schema migrated from v${fromVersion} to v${toVersion} (${appliedNames}).${backupPath ? ` Backup: ${backupPath}` : ''}`
        );
      }
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Ignore close errors while preserving the migration error.
      }
      throw error;
    }

    this.backfillNullSeq();
    const maxSeqRow = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM events').get() as { maxSeq: number };
    this.nextSeq = maxSeqRow.maxSeq + 1;
    const countRow = this.db.prepare('SELECT COUNT(*) AS count FROM events WHERE duplicate_of IS NULL').get() as { count: number };
    this.eventsCountCache = countRow.count;
    const earliestRow = this.db.prepare('SELECT MIN(created_at) AS earliest FROM events WHERE duplicate_of IS NULL').get() as {
      earliest: number | null;
    };
    if (earliestRow.earliest !== null) this.totalsSinceCache = earliestRow.earliest;

    // Kicked off here (not only from `server/index.ts`) so a store built directly, as many tests do, never needs
    // an explicit `init()` call: for a file with no backlog beyond one page, every row is applied synchronously
    // below, before this constructor returns (see `init()`).
    this.initPromise = this.init();
  }

  /**
   * Assigns `seq` to any row still missing it: normally none (migration 4 backfills from `rowid` once), except
   * when an older server appended rows to a file already migrated by a newer one. Ordered by `rowid`, which is
   * still meaningful for these specific rows (nothing else writes seq-less rows after migration 4 exists).
   */
  private backfillNullSeq(): void {
    const nullRows = this.db.prepare('SELECT rowid AS rid FROM events WHERE seq IS NULL ORDER BY rowid').all() as Array<{ rid: number }>;
    if (nullRows.length === 0) return;
    const maxSeqRow = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM events').get() as { maxSeq: number };
    const update = this.db.prepare('UPDATE events SET seq = ? WHERE rowid = ?');
    let next = maxSeqRow.maxSeq + 1;
    for (const { rid } of nullRows) update.run(next++, rid);
  }

  /**
   * Replays every stored event through `applyEvent`, in `seq` order, rebuilding `this.state` from scratch.
   * Pages through the table so `/health` and `/ready` keep answering while it runs; yields after every non-empty
   * page (`rebuildPageDelayMs`, then the `yieldBetweenPages` test hook, then one `setImmediate`). A file with no
   * backlog beyond one page never reaches any of those `await`s, so this resolves synchronously in that case:
   * `readiness().ready` is already `true` by the time the constructor returns.
   */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    return this.runRebuild();
  }

  private async runRebuild(): Promise<void> {
    const startedAt = Date.now();
    const totalRow = this.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number };
    this.rebuild = {
      state: 'running',
      totalEvents: totalRow.count,
      processedEvents: 0,
      skippedEvents: 0,
      skippedEventIds: [],
      startedAt,
      finishedAt: null,
      durationMs: null,
    };
    this.rebuildOptions.logger.info(`[agent-viewer] Rebuilding state from SQLite: ${totalRow.count} events`);

    try {
      const pageStmt = this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?');
      let lastSeq = 0;
      while (true) {
        if (this.closed) return;
        const rows = pageStmt.all(lastSeq, this.rebuildOptions.pageSize) as any[];
        if (rows.length === 0) break;
        for (const row of rows) {
          lastSeq = row.seq;
          this.applyStoredRow(row);
        }
        if (this.rebuildOptions.pageDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.rebuildOptions.pageDelayMs));
        }
        if (this.rebuildOptions.yieldBetweenPages) {
          await this.rebuildOptions.yieldBetweenPages({
            processedEvents: this.rebuild.processedEvents,
            totalEvents: this.rebuild.totalEvents,
          });
        }
        await new Promise((resolve) => setImmediate(resolve));
      }

      const finishedAt = Date.now();
      this.rebuild = { ...this.rebuild, state: 'done', finishedAt, durationMs: finishedAt - startedAt };
      const agents = this.state.agents.size;
      const sessions = this.state.sessions.size;
      const runtimes = this.state.runtimes.size;
      const tasks = this.state.tasks.size;
      const meetings = this.state.meetings.size;
      this.rebuildOptions.logger.info(
        `[agent-viewer] State rebuilt from SQLite in ${this.rebuild.durationMs} ms: ${this.rebuild.processedEvents} events, ` +
          `${agents} agents, ${sessions} sessions, ${runtimes} runtimes, ${tasks} tasks, ${meetings} meetings, ${this.rebuild.skippedEvents} skipped`
      );
    } catch (error) {
      const finishedAt = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      this.rebuild = { ...this.rebuild, state: 'failed', finishedAt, durationMs: finishedAt - startedAt, error: message };
      this.rebuildOptions.logger.error(`[agent-viewer] State rebuild from SQLite failed: ${message}`);
    }
  }

  /** One row of the rebuild: a duplicate reference is counted as processed but never applied, matching the live
   * path (only an 'accepted' outcome ever reaches `applyEvent`). A row that cannot be parsed, or whose
   * `applyEvent` throws, is skipped and logged; the rest of the rebuild continues. */
  private applyStoredRow(row: any): void {
    let event: CanonicalEvent;
    try {
      event = this.rowToEvent(row);
      if (typeof event?.id !== 'string' || typeof event?.type !== 'string' || typeof event?.timestamp !== 'number') {
        throw new Error('parsed event is missing a string id, a string type or a numeric timestamp');
      }
    } catch (error) {
      this.recordSkippedRow(row.id, error);
      return;
    }

    if (row.duplicate_of) {
      this.rebuild.processedEvents++;
      return;
    }

    try {
      applyEvent(this.state, event);
      this.rebuild.processedEvents++;
    } catch (error) {
      this.recordSkippedRow(row.id, error);
    }
  }

  private recordSkippedRow(id: string, error: unknown): void {
    this.rebuild.skippedEvents++;
    if (this.rebuild.skippedEventIds.length < 20) this.rebuild.skippedEventIds.push(id);
    const message = error instanceof Error ? error.message : String(error);
    this.rebuildOptions.logger.warn(`[agent-viewer] Skipped unreadable event during rebuild: ${JSON.stringify({ id, reason: message })}`);
  }

  readiness(): StoreReadiness {
    return { ready: this.rebuild.state === 'done', storage: 'sqlite', rebuild: { ...this.rebuild, skippedEventIds: [...this.rebuild.skippedEventIds] } };
  }

  getSchemaInfo(): { schemaVersion: number; latestKnownSchemaVersion: number; appliedAt: number | null } {
    const row = this.db
      .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1')
      .get() as { version: number; applied_at: number } | undefined;
    return {
      schemaVersion: row?.version ?? 0,
      latestKnownSchemaVersion: this.migrations.at(-1)?.version ?? 0,
      appliedAt: row?.applied_at ?? null,
    };
  }

  /** Inserts the row and returns the `seq` it was given (issue #54): the same durable counter #52 already uses
   * to order the startup rebuild, reused here as the cursor SSE reconnect replay pages against. */
  private insertEvent(
    insertStmt: any,
    event: CanonicalEvent,
    fingerprint: string,
    requestKey: { provider: string; requestId: string } | null,
    duplicateOf: string | null,
    matchesOriginal: boolean | null
  ): EventSeq {
    const seq = this.nextSeq++;
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
      Date.now(),
      fingerprint,
      requestKey ? requestKey.provider : null,
      requestKey ? requestKey.requestId : null,
      duplicateOf,
      matchesOriginal === null ? null : matchesOriginal ? 1 : 0,
      seq
    );
    return seq;
  }

  private prepareInsert(): any {
    return this.db.prepare(`
      INSERT INTO events (
        id, type, timestamp, runtime_id, session_id, agent_id, task_id, severity, summary, payload, event_json,
        created_at, content_hash, request_provider, request_id, duplicate_of, matches_original, seq
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  private prepareLookup(): any {
    return this.db.prepare('SELECT content_hash, duplicate_of FROM events WHERE id = ?');
  }

  /**
   * The original event id already stored under this `(provider, requestId)` key, with the usage-relevant fields
   * needed for the fingerprint comparison. Kept as its own small method so a test can override it, for example to
   * force the UNIQUE-constraint race path deterministically (`node:sqlite` is synchronous, so two instances in
   * one process cannot truly interleave).
   */
  private lookupRequestKey(provider: string, requestId: string): { id: string; fields: UsageFingerprintFields } | null {
    const row = this.db
      .prepare('SELECT id, type, payload FROM events WHERE request_provider = ? AND request_id = ? AND duplicate_of IS NULL LIMIT 1')
      .get(provider, requestId) as { id: string; type: string; payload: string } | undefined;
    if (!row) return null;
    const payload = JSON.parse(row.payload || '{}');
    return { id: row.id, fields: extractUsageFingerprintFields({ type: row.type, payload } as CanonicalEvent) };
  }

  /** Decides the outcome for an id that is already stored. A NULL hash cannot be compared: duplicate, never conflict. */
  private classifyStored(
    event: CanonicalEvent,
    fingerprint: string,
    row: { content_hash: string | null; duplicate_of: string | null }
  ): PendingOutcome {
    const stored = row.content_hash;
    // A row whose own id is itself a duplicate reference resolves to its original; resending its id is still an
    // event_id duplicate (its own content is remembered too), it just points one hop further.
    const originalId = row.duplicate_of ?? event.id;
    const submittedId = row.duplicate_of ? event.id : undefined;
    if (stored === null || stored === undefined) {
      return { result: appendResult('duplicate', originalId, fingerprint, undefined, { submittedId }), event, legacyUnverified: true };
    }
    if (stored === fingerprint) {
      return { result: appendResult('duplicate', originalId, fingerprint, undefined, { submittedId }), event, legacyUnverified: false };
    }
    return { result: appendResult('conflict', event.id, fingerprint, stored), event, legacyUnverified: false };
  }

  /**
   * Looks up the id and inserts the event when it is new, with no await in between. Processing order: the event
   * id against a stored row (original or duplicate reference), then the request key for `llm.usage` /
   * `llm.failed` (issue #48). The PRIMARY KEY and the request-key unique index both stay as backstops: if the
   * insert still hits either UNIQUE violation (for example when two processes share one file), the row is read
   * again and classified instead of surfacing an error.
   */
  private classifyAndInsert(lookupStmt: any, insertStmt: any, event: CanonicalEvent, ignoreTimestamp = false): PendingOutcome {
    const fingerprint = eventFingerprint(event, ignoreTimestamp);
    const existing = lookupStmt.get(event.id) as { content_hash: string | null; duplicate_of: string | null } | undefined;
    if (existing) return this.classifyStored(event, fingerprint, existing);

    const requestKey = requestKeyFor(event);
    const original = requestKey ? this.lookupRequestKey(requestKey.provider, requestKey.requestId) : null;
    if (requestKey && original) {
      const matchesOriginal = fingerprintFieldsMatch(original.fields, extractUsageFingerprintFields(event));
      try {
        this.insertEvent(insertStmt, event, fingerprint, requestKey, original.id, matchesOriginal);
      } catch (error) {
        if (!isUniqueIdViolation(error)) throw error;
        const raced = lookupStmt.get(event.id) as { content_hash: string | null; duplicate_of: string | null } | undefined;
        if (!raced) throw error;
        return this.classifyStored(event, fingerprint, raced);
      }
      return {
        result: appendResult('duplicate', original.id, fingerprint, undefined, {
          duplicateReason: 'request_id',
          submittedId: event.id,
          matchesOriginal,
        }),
        event,
        legacyUnverified: false,
        requestKeyMismatch: matchesOriginal
          ? undefined
          : { originalId: original.id, duplicateId: event.id, provider: requestKey.provider, requestId: requestKey.requestId },
      };
    }

    let seq: EventSeq;
    try {
      seq = this.insertEvent(insertStmt, event, fingerprint, requestKey, null, null);
    } catch (error) {
      if (requestKey && isUniqueRequestKeyViolation(error)) {
        // Lost a race with another writer that claimed this request key first. Defensive only: several processes
        // sharing one SQLite file is not officially supported (issue #48, out of scope). The process that lost
        // the race never forwards the event to the memory fallback: only `append`/`appendBatch` do that, and
        // only for an 'accepted' outcome.
        const raced = this.lookupRequestKey(requestKey.provider, requestKey.requestId);
        if (raced) {
          const matchesOriginal = fingerprintFieldsMatch(raced.fields, extractUsageFingerprintFields(event));
          this.insertEvent(insertStmt, event, fingerprint, requestKey, raced.id, matchesOriginal);
          return {
            result: appendResult('duplicate', raced.id, fingerprint, undefined, {
              duplicateReason: 'request_id',
              submittedId: event.id,
              matchesOriginal,
            }),
            event,
            legacyUnverified: false,
            requestKeyMismatch: matchesOriginal
              ? undefined
              : { originalId: raced.id, duplicateId: event.id, provider: requestKey.provider, requestId: requestKey.requestId },
          };
        }
      }
      if (!isUniqueIdViolation(error)) throw error;
      const raced = lookupStmt.get(event.id) as { content_hash: string | null; duplicate_of: string | null } | undefined;
      if (!raced) throw error;
      return this.classifyStored(event, fingerprint, raced);
    }
    return { result: appendResult('accepted', event.id, fingerprint, undefined, { seq }), event, legacyUnverified: false };
  }

  /** Counters and log lines, applied only once the outcome is final (after the commit for a batch). */
  private recordOutcome(pending: PendingOutcome): void {
    const { result, event } = pending;
    if (result.outcome === 'conflict') {
      this.counters.conflicts++;
      warnConflict(event, result.fingerprint, result.storedFingerprint ?? '');
    } else if (pending.legacyUnverified) {
      this.counters.legacyUnverifiedDuplicates++;
      if (!warnedLegacyUnverified) {
        warnedLegacyUnverified = true;
        console.warn(
          `[agent-viewer] Event ${JSON.stringify(event.id)} matched a stored row without content_hash (written before 0.2.0 or with unreadable event_json). Its content cannot be compared, so it is treated as a duplicate. Further cases are only counted in /ready (ingestion.legacyUnverifiedDuplicates).`
        );
      }
    }
    if (pending.requestKeyMismatch) {
      const { originalId, duplicateId, provider, requestId } = pending.requestKeyMismatch;
      warnRequestKeyMismatch(originalId, duplicateId, provider, requestId);
    }
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

  async append(event: CanonicalEvent): Promise<AppendResult> {
    const pending = this.classifyAndInsert(this.prepareLookup(), this.prepareInsert(), event);
    this.recordOutcome(pending);
    if (pending.result.outcome === 'accepted') {
      this.eventsCountCache++;
      this.ensureTotalsSinceCache();
      // While a startup rebuild is running (or failed), the event is persisted only: the rebuild loop (or a
      // restart) is the one that applies it, so it is never applied twice (issue #52).
      if (this.rebuild.state === 'done') applyEvent(this.state, event);
    }
    return pending.result;
  }

  /**
   * All or nothing at the storage level: the batch runs inside BEGIN IMMEDIATE ... COMMIT and rolls back on any
   * error. Rows inserted earlier in the batch are visible to later items, so repeats inside one batch are classified
   * like repeats across requests. Memory side effects run after the commit, with the accepted events only.
   * When atomic is true and a conflict is found, the entire batch is rejected without inserting any events.
   */
  async appendBatch(events: CanonicalEvent[], options?: { atomic?: boolean; ignoreTimestamp?: boolean }): Promise<AppendBatchResult> {
    const atomic = options?.atomic ?? false;
    const ignoreTimestamp = options?.ignoreTimestamp ?? false;

    const lookupStmt = this.prepareLookup();
    const insertStmt = this.prepareInsert();
    const pending: PendingOutcome[] = [];

    // If atomic, check for conflicts first without inserting
    if (atomic) {
      for (const event of events) {
        const row = lookupStmt.get(event.id) as { fingerprint: string } | undefined;
        const fingerprint = eventFingerprint(event, ignoreTimestamp);

        if (row && row.fingerprint !== fingerprint) {
          // Conflict found: return the batch without inserting anything
          const results = events.map(e => {
            const fp = eventFingerprint(e, ignoreTimestamp);
            const r = lookupStmt.get(e.id) as { fingerprint: string } | undefined;
            if (!r) {
              return appendResult('accepted', e.id, fp);
            }
            if (r.fingerprint === fp) {
              return appendResult('duplicate', e.id, fp);
            }
            this.counters.conflicts++;
            return appendResult('conflict', e.id, fp, r.fingerprint);
          });
          return summarizeBatch(results, events);
        }
      }
    }

    // No conflicts (or not atomic), proceed with insertion
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) {
        pending.push(this.classifyAndInsert(lookupStmt, insertStmt, event, ignoreTimestamp));
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      throw error;
    }

    for (const entry of pending) this.recordOutcome(entry);
    const summary = summarizeBatch(pending.map(({ result }) => result), events);
    if (summary.acceptedEvents.length > 0) {
      this.eventsCountCache += summary.acceptedEvents.length;
      this.ensureTotalsSinceCache();
    }
    if (this.rebuild.state === 'done') {
      for (const accepted of summary.acceptedEvents) applyEvent(this.state, accepted);
    }
    return summary;
  }

  ingestionCounters(): IngestionCounters {
    return { ...this.counters };
  }

  async exists(eventId: string): Promise<boolean> {
    const stmt = this.db.prepare('SELECT id FROM events WHERE id = ?');
    return !!stmt.get(eventId);
  }

  async list(options: ListEventsOptions = {}): Promise<CanonicalEvent[]> {
    // A duplicate reference is never returned here (issue #48): only originals and events with no request key.
    const conditions: string[] = ['duplicate_of IS NULL'];
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
      // An unknown cursor applies no filter. `seq` is the durable insertion order (issue #52); unlike `rowid`
      // (not an alias of an INTEGER PRIMARY KEY here), it survives a VACUUM.
      const cursor = this.db.prepare('SELECT seq FROM events WHERE id = ?').get(options.afterId) as
        | { seq: number }
        | undefined;
      if (cursor) {
        conditions.push('seq > ?');
        params.push(cursor.seq);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit && options.limit > 0 ? options.limit : 100;
    params.push(limit);

    const sql = `SELECT * FROM events ${whereClause} ORDER BY timestamp DESC, created_at DESC, seq DESC LIMIT ?`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map((r) => this.rowToEvent(r));
  }

  /**
   * Seq methods for SSE reconnect replay (issue #54), run directly against `events.seq` (the durable counter
   * issue #52 already added, never `rowid`: `events.id` is a `TEXT PRIMARY KEY`, so `rowid` is not an alias of an
   * `INTEGER PRIMARY KEY` and SQLite is free to renumber it on `VACUUM`). `duplicate_of IS NULL` everywhere, same
   * as `list()`: a duplicate reference is never a valid cursor and never counted or replayed.
   */
  async resolveCursor(eventId: string): Promise<EventSeq | null> {
    const row = this.db.prepare('SELECT seq FROM events WHERE id = ? AND duplicate_of IS NULL').get(eventId) as
      | { seq: number }
      | undefined;
    return row ? Number(row.seq) : null;
  }

  async headSeq(): Promise<EventSeq | null> {
    const row = this.db.prepare('SELECT MAX(seq) AS seq FROM events WHERE duplicate_of IS NULL').get() as
      | { seq: number | null }
      | undefined;
    return row?.seq === null || row?.seq === undefined ? null : Number(row.seq);
  }

  async countBetween(afterSeq: EventSeq, upToSeq: EventSeq): Promise<number> {
    if (upToSeq <= afterSeq) return 0;
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM events WHERE duplicate_of IS NULL AND seq > ? AND seq <= ?')
      .get(afterSeq, upToSeq) as { count: number };
    return row.count;
  }

  async listBetween(afterSeq: EventSeq, upToSeq: EventSeq, limit: number): Promise<StoredEvent[]> {
    if (upToSeq <= afterSeq || limit <= 0) return [];
    const rows = this.db
      .prepare('SELECT * FROM events WHERE duplicate_of IS NULL AND seq > ? AND seq <= ? ORDER BY seq ASC LIMIT ?')
      .all(afterSeq, upToSeq, limit) as any[];
    return rows.map((r) => ({ seq: Number(r.seq), event: this.rowToEvent(r) }));
  }

  async findByRequest(provider: string, requestId: string): Promise<{ id: string } | null> {
    const found = this.lookupRequestKey(normalizeProvider(provider), normalizeRequestId(requestId));
    return found ? { id: found.id } : null;
  }

  private rowToDuplicateReference(r: any): DuplicateReference {
    return {
      id: r.id,
      duplicateOf: r.duplicate_of,
      type: r.type,
      provider: r.request_provider,
      requestId: r.request_id,
      receivedAt: Number(r.created_at),
      matchesOriginal: r.matches_original === null || r.matches_original === undefined ? null : Boolean(r.matches_original),
      event: this.rowToEvent(r),
    };
  }

  async listDuplicates(
    options: { limit?: number; provider?: string; requestId?: string; duplicateOf?: string } = {}
  ): Promise<DuplicateReference[]> {
    const conditions: string[] = ['duplicate_of IS NOT NULL'];
    const params: any[] = [];
    if (options.provider) {
      conditions.push('request_provider = ?');
      params.push(normalizeProvider(options.provider));
    }
    if (options.requestId) {
      conditions.push('request_id = ?');
      params.push(normalizeRequestId(options.requestId));
    }
    if (options.duplicateOf) {
      conditions.push('duplicate_of = ?');
      params.push(options.duplicateOf);
    }
    const limit = options.limit && options.limit > 0 ? options.limit : 100;
    params.push(limit);

    const sql = `SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToDuplicateReference(r));
  }

  /** Counts of duplicate references, computed from SQL so they survive a restart, unlike the totals. */
  private usageDuplicateStatsFromDb(): UsageDuplicateStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count,
                SUM(CASE WHEN matches_original = 0 THEN 1 ELSE 0 END) AS mismatched,
                SUM(CASE WHEN matches_original IS NULL THEN 1 ELSE 0 END) AS unverified
         FROM events WHERE duplicate_of IS NOT NULL`
      )
      .get() as { count: number; mismatched: number | null; unverified: number | null };
    return { count: row.count, mismatched: row.mismatched ?? 0, unverified: row.unverified ?? 0 };
  }

  /**
   * Sets `totalsSinceCache` from the real stored `created_at` of the first accepted row, the first time this
   * database ever goes from zero to one accepted event. One extra query, run at most once per database file for
   * its entire lifetime (every call after the first is a no-op check); never the fresh `Date.now()` of whichever
   * process happens to insert first, so a restart reads back the exact same value (issue #53).
   */
  private ensureTotalsSinceCache(): void {
    if (this.totalsSinceCache !== null) return;
    const row = this.db.prepare('SELECT MIN(created_at) AS earliest FROM events WHERE duplicate_of IS NULL').get() as {
      earliest: number | null;
    };
    this.totalsSinceCache = row.earliest ?? Date.now();
  }

  /**
   * `storage: 'sqlite'`, `maxEvents: null` (the database keeps every row) and `droppedEvents: 0`. Since issue
   * #52's startup rebuild makes `this.state` cover every stored row once ready, `acceptedEvents` is simply the
   * row count here too (unlike before #52, when it could lag behind `retainedEvents` after a restart).
   * `retainedEvents` reads the counter kept in memory, never `SELECT COUNT(*)` (issue #53: the SSE heartbeat
   * calls this for every connected client every 15 s).
   */
  async retention(): Promise<SnapshotRetention> {
    this.ensureTotalsSinceCache();
    return {
      storage: 'sqlite',
      maxEvents: null,
      retainedEvents: this.eventsCountCache,
      acceptedEvents: this.eventsCountCache,
      droppedEvents: 0,
      since: null,
      totalsSince: this.totalsSinceCache ?? Date.now(),
    };
  }

  /**
   * `lastEventId`, `eventsCount` and `events` come from SQLite (issue #52): they must be correct for the whole
   * stored history, not only for whatever a ring buffer happened to keep. Every other field comes from
   * `this.state`, built by `applyEvent` on the live path and by the startup rebuild.
   */
  async snapshot(): Promise<ViewerSnapshot> {
    const lastRow = this.db.prepare('SELECT id FROM events WHERE duplicate_of IS NULL ORDER BY seq DESC LIMIT 1').get() as
      | { id: string }
      | undefined;
    const recentRows = this.db
      .prepare('SELECT * FROM events WHERE duplicate_of IS NULL ORDER BY seq DESC LIMIT 100')
      .all() as any[];
    const legacy = this.state.usage.legacyTotals();
    return {
      schemaVersion: '1.0',
      timestamp: Date.now(),
      lastEventId: lastRow?.id ?? null,
      runtimes: Array.from(this.state.runtimes.values()),
      sessions: Array.from(this.state.sessions.values()),
      agents: Array.from(this.state.agents.values(), (agent) => toAgentRecord(this.state, agent)),
      activeTasks: Array.from(this.state.tasks.values()).filter((t) => t.status !== 'COMPLETED' && t.status !== 'FAILED'),
      activeMeetings: Array.from(this.state.meetings.values()).filter((m) => m.status !== 'CONCLUDED'),
      usage: this.state.usage.summary(),
      usageDuplicates: this.usageDuplicateStatsFromDb(),
      totalTokens: legacy.tokens,
      totalCost: legacy.cost,
      eventsCount: this.eventsCountCache,
      events: recentRows.map((r) => this.rowToEvent(r)),
      retention: await this.retention(),
    };
  }

  async usageSummary(): Promise<UsageSummary> {
    return this.state.usage.summary();
  }

  /**
   * Deprecated direct-write affordance (issue #52): nothing in `server/index.ts` calls this any more (`POST
   * /api/v1/runtimes` now appends a `runtime.connected` event and reads the record back), and a call made this
   * way does not survive a restart, because the rebuild only replays stored events.
   */
  async upsertRuntime(runtime: Partial<RuntimeRecord> & { id: string }): Promise<RuntimeRecord> {
    return upsertRuntimeDirect(this.state, runtime);
  }

  async listRuntimes(): Promise<RuntimeRecord[]> {
    return Array.from(this.state.runtimes.values());
  }

  /** Deprecated direct-write affordance, see `upsertRuntime`. Nothing in `server/index.ts` calls it. */
  async upsertSession(session: Partial<SessionRecord> & { id: string }): Promise<SessionRecord> {
    return upsertSessionDirect(this.state, session);
  }

  async listSessions(): Promise<SessionRecord[]> {
    return Array.from(this.state.sessions.values());
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    return this.state.sessions.get(sessionId) ?? null;
  }

  /**
   * Deprecated direct-write affordance (issue #52): nothing in `server/index.ts` calls this any more (`POST
   * /api/v1/agents` now appends an `agent.registered` event and reads the record back), and a call made this way
   * does not survive a restart, because the rebuild only replays stored events.
   */
  async upsertAgent(agent: AgentProfileInput): Promise<AgentRecord> {
    return upsertAgentProfile(this.state, agent);
  }

  async getAgent(agentId: string): Promise<AgentRecord | null> {
    const agent = this.state.agents.get(agentId);
    return agent ? toAgentRecord(this.state, agent) : null;
  }

  async listAgents(): Promise<AgentRecord[]> {
    return Array.from(this.state.agents.values(), (agent) => toAgentRecord(this.state, agent));
  }

  async close(): Promise<void> {
    this.closed = true;
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
/** Only digits, no leading zero (so "0", "007", "-1", "1e3" and "10.5" are all rejected). */
const MAX_EVENTS_PATTERN = /^[1-9][0-9]*$/;

/**
 * Parses `AGENT_VIEWER_MAX_EVENTS` (issue #53). Unset, empty or whitespace-only gives the default (`10000`).
 * Otherwise the trimmed value must be a plain positive integer, no larger than `Number.MAX_SAFE_INTEGER`; any
 * other value throws instead of silently falling back to the default, so a typo is never ignored at startup.
 * A standalone, env-free function so a test can exercise every case without importing the server.
 */
export function parseMaxEvents(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_EVENTS;
  const trimmed = raw.trim();
  if (trimmed === '') return DEFAULT_MAX_EVENTS;
  const value = Number(trimmed);
  if (!MAX_EVENTS_PATTERN.test(trimmed) || !Number.isSafeInteger(value)) {
    throw new Error(`AGENT_VIEWER_MAX_EVENTS must be a positive integer, got "${raw}"`);
  }
  return value;
}

export function createEventStore(): EventStore {
  const storageType = (process.env.AGENT_VIEWER_STORAGE || 'memory').toLowerCase();
  const rawMaxEvents = process.env.AGENT_VIEWER_MAX_EVENTS;
  const maxEvents = parseMaxEvents(rawMaxEvents);
  const maxEventsWasSet = rawMaxEvents !== undefined && rawMaxEvents.trim() !== '';

  if (storageType === 'sqlite') {
    // Since issue #52, SQLite mode has no capped in-memory window to limit: every event is persisted and the
    // startup rebuild replays the whole table. AGENT_VIEWER_MAX_EVENTS only applies to the memory store.
    if (maxEventsWasSet) {
      console.log(`[agent-viewer] AGENT_VIEWER_MAX_EVENTS has no effect in SQLite mode; every event is stored and never capped.`);
    }
    const dbPath = process.env.AGENT_VIEWER_SQLITE_PATH || './data/agent-viewer.db';
    const backup = sqliteBackupMode(process.env.AGENT_VIEWER_SQLITE_BACKUP);
    return new SQLiteEventStore(dbPath, { backup });
  }
  return new MemoryEventStore({ maxEvents });
}
