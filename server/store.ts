import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { CanonicalEvent } from '../src/integrations/canonicalContract';
import { MIGRATIONS, runMigrations, type Migration, type MigrationResult } from './db/migrations';
import { eventFingerprint } from './eventFingerprint';
import { rowToEvent } from './eventRow';
import { readPackageVersion } from './version';
import type { TelemetryPointInput } from './otlp/metrics';
import type { TelemetryPointRecord } from './telemetry';
import {
  extractUsageFingerprintFields,
  fingerprintFieldsMatch,
  normalizeProvider,
  normalizeRequestId,
  requestKeyFor,
  requestKeyString,
  type UsageFingerprintFields,
} from './requestKey';
import {
  dbRowToLedgerRowInput,
  ledgerRequestKey,
  runUsageLedgerBackfill,
  sameCall,
  toLedgerRow,
  type IngestChannel,
  type LedgerOrigin,
  type LedgerSkipReason,
  type UsageLedgerRow,
} from './usageLedger';
import { buildListCallsQuery, listCallsInMemory, sqliteRowToCallRecord, type CallsPage, type CallsQuery } from './usage/calls';
import { type UsageSummary } from './usageAggregates';
import { computeMemoryRollup, computeSqliteRollup } from './usage/rollup';
import type { RollupQuery, UsageRollupResponse } from './usage/types';
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
  /**
   * Backward paging cursor (issue #72): only events stored strictly before this id, in arrival order. Combines
   * with `afterId` and the other filters. Like `afterId`, a cursor not found (or filtered out by the other
   * options) applies no cut; the route layer is the one that rejects an unresolvable `beforeId` with `400`.
   */
  beforeId?: string;
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
  /**
   * Server receive time (ms epoch) of the event this id is held under (issue #65): for 'accepted', the receive
   * time of this very call; for a 'duplicate', the receive time of the *original* acceptance, never of the
   * retry.
   */
  receivedAt: number;
  /** Set when outcome === 'duplicate'. */
  duplicateReason?: DuplicateReason;
  /** The id the client actually sent. Present only when it differs from `id`. */
  submittedId?: string;
  /** Only for a 'request_id' duplicate: whether its usage-relevant fields match the original's. */
  matchesOriginal?: boolean | null;
}

/** Options accepted by `append`/`appendBatch` (issue #65). Optional and additive: the agent/runtime callers in
 * `server/index.ts` that never produce usage events keep working unchanged. */
export interface AppendOptions {
  /** Server clock at request arrival. All events of one `appendBatch` call share one value. Default `Date.now()`. */
  receivedAt?: number;
  /** Which route accepted this event, recorded on its ledger row when it is `llm.usage`/`llm.failed`. */
  channel?: IngestChannel;
}

/** What `list()` returns (issue #65): the stored event plus the server receive time SQLite already kept in
 * `created_at` but never returned. `GET /api/v1/snapshot` and SSE frames are unaffected; see the issue. */
export type EventWithReceivedAt = CanonicalEvent & { receivedAt: number };

export interface UsageLedgerStatus {
  schemaVersion: '1.0';
  storage: 'memory' | 'sqlite';
  rows: number;
  rowsByOrigin: { live: number; backfill: number };
  legacyRows: number;
  skips: { duplicate: number; conflict: number; unparseable: number };
  oldestReceivedAt: number | null;
  newestReceivedAt: number | null;
  /** `false` only in memory mode, once the memory-mode ledger cap (`AGENT_VIEWER_USAGE_LEDGER_MAX_ROWS`) has
   * dropped rows (issue #53's "no silent loss" rule, applied to the ledger). Always `true` in SQLite mode. */
  complete: boolean;
  migration: { id: string; appliedAt: number } | null;
}

// -------------------------------------------------------------
// Retention (issue #70)
// -------------------------------------------------------------

/** What `EventStore.purge` deletes. Either cutoff is omitted entirely to leave that table untouched: there is no
 * "purge everything" cutoff of `Infinity`, so a caller that forgets a field purges nothing for it, never
 * everything. Deliberately has no `error` field: a thrown exception is how a failed purge is reported, by
 * design (`server/retention.ts` is the one that catches it and records `status: 'error'`). */
export interface PurgeOptions {
  /** `events.created_at` cutoff (ms epoch, exclusive floor): rows strictly older are deleted. Omitted = keep. */
  eventsCutoffMs?: number;
  /** `usage_ledger.received_at` cutoff, independent of `eventsCutoffMs`. Omitted = keep. */
  ledgerCutoffMs?: number;
  /** Rows deleted per transaction. Default 5000 (the issue's own default); tests override it. */
  batchSize?: number;
}

/** Result of one `purge()` call. The two `*OldestReceivedAt` fields are measured *after* the purge, so they
 * reflect what is left, not what was removed. */
export interface PurgeResult {
  eventsDeleted: number;
  ledgerDeleted: number;
  eventsOldestReceivedAt: number | null;
  ledgerOldestReceivedAt: number | null;
}

export type RetentionTrigger = 'startup' | 'schedule';
export type RetentionRunStatus = 'running' | 'ok' | 'error' | 'skipped';

/** One row of the purge audit log (`retention_runs`), or its in-memory equivalent. */
export interface RetentionRunRecord {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  trigger: RetentionTrigger;
  status: RetentionRunStatus;
  eventsWindowDays: number | null;
  eventsCutoffMs: number | null;
  eventsDeleted: number;
  ledgerWindowDays: number | null;
  ledgerCutoffMs: number | null;
  ledgerDeleted: number;
  /** Short, content-free reason (error code plus message, truncated): never event payloads, summaries or ids. */
  error: string | null;
}

/** Everything `finishRetentionRun` sets once a run (or an immediate skip) is decided. */
export type RetentionRunPatch = Omit<RetentionRunRecord, 'id' | 'startedAt' | 'trigger' | 'status'> & {
  status: Exclude<RetentionRunStatus, 'running'>;
};

/** One scope ('events' or the usage ledger) inside `GET /api/v1/admin/retention`. `windowDays`/`policy` are not
 * here: they come straight from the parsed config, which never changes while the process runs. */
export interface RetentionScopeStatus {
  /** `COUNT(*)` of the table, including rows a later item (duplicates, ledger skips) also tracks elsewhere. */
  count: number;
  /** `MIN` of the table's receive-time column. `null` only when the table is empty. */
  oldestReceivedAt: number | null;
  /** Largest cutoff under which rows were ever actually deleted (survives a restart and the 500-row prune). */
  purgedBefore: number | null;
  /** Cutoff of the most recent *finished* run that had a window configured for this scope. `null` until one has. */
  lastCutoffMs: number | null;
  /** Rows deleted by that same run. `null` until one has finished; a real `0` after that is not `null`. */
  lastDeleted: number | null;
  /** Lifetime rows deleted by retention for this scope (persisted, survives the 500-row prune). Real `0` allowed. */
  deletedTotal: number;
}

/** What `EventStore.retentionStatus` returns; `server/index.ts` adds `schemaVersion`, `storage`, `now`,
 * `intervalMinutes`, the per-scope `windowDays`/`policy` and `totalDeletedSinceStart` (process-local, owned by
 * `server/retention.ts`, never the store) to build the full `GET /api/v1/admin/retention` response. */
export interface RetentionStatus {
  events: RetentionScopeStatus;
  usageLedger: RetentionScopeStatus;
  lastRun: RetentionRunRecord | null;
  runs: RetentionRunRecord[];
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
  /** The `receivedAt` each submitted id was accepted under (issue #65): covers both accepted and duplicate ids,
   * so a caller can echo the original acceptance time even for a duplicate item in the batch. */
  receivedAtById: Map<string, number>;
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
  /** Server receive time this id is held under (issue #65). Filled in by the caller once known; `0` is a safe
   * placeholder for call sites that do not yet have it (`append`/`appendBatch` always overwrite it before the
   * result reaches a caller). */
  receivedAt?: number;
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
    receivedAt: extra?.receivedAt ?? 0,
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
  const receivedAtById = new Map<string, number>();
  results.forEach((result, index) => {
    if (result.outcome === 'accepted') {
      accepted++;
      acceptedEvents.push(events[index]);
      acceptedSeqs.push(result.seq);
      receivedAtById.set(events[index].id, result.receivedAt);
    } else if (result.outcome === 'duplicate') {
      duplicates++;
      receivedAtById.set(events[index].id, result.receivedAt);
    } else {
      conflicts++;
    }
  });
  return { accepted, duplicates, conflicts, results, acceptedEvents, acceptedSeqs, receivedAtById };
}

/** Result of one `appendTelemetryPoints` call (issue #73). Never includes a point's value or any raw attribute. */
export interface TelemetryAppendOutcome {
  accepted: number;
  /** Same `(series_key, start_time_unix_nano, time_unix_nano)` already stored with the same value: a harmless retry. */
  duplicates: number;
  /** Same key already stored with a different value: the first value is kept, this one is rejected. */
  conflicts: number;
  /** Memory mode only: rejected because `AGENT_VIEWER_TELEMETRY_MAX_POINTS` was already full. Always 0 for SQLite. */
  rejectedCapacity: number;
  /** Short, content-free reasons for every `conflicts`/`rejectedCapacity` point, for the route's `partialSuccess`. */
  messages: string[];
}

export interface TelemetryStats {
  pointsStored: number;
  pointsWithoutSession: number;
  /** Memory mode only: `true` once `AGENT_VIEWER_TELEMETRY_MAX_POINTS` has rejected at least one point. */
  truncated: boolean;
}

export interface TelemetryPointFilter {
  sessionId?: string;
  runtimeId?: string;
}

export interface EventStore {
  /** Stores a new event, or classifies a repeated id as a duplicate (same content) or a conflict (different content). */
  append(event: CanonicalEvent, options?: AppendOptions): Promise<AppendResult>;
  /** Same rules as `append`, item by item in input order, also against earlier items of the same batch. */
  appendBatch(
    events: CanonicalEvent[],
    options?: { atomic?: boolean; ignoreTimestamp?: boolean } & AppendOptions
  ): Promise<AppendBatchResult>;
  /** Conflicts rejected and legacy rows matched by id only, since process start. */
  ingestionCounters(): IngestionCounters;
  /** True for an original event id and for a duplicate reference's own id. */
  exists(eventId: string): Promise<boolean>;
  /** Never includes a duplicate reference: only originals and events with no request key. Each event carries its
   * server receive time (issue #65). */
  list(options?: ListEventsOptions): Promise<EventWithReceivedAt[]>;

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
  /** Counts and time bounds of the usage ledger (issue #65), never a sum of tokens or cost. */
  usageLedgerStatus(): Promise<UsageLedgerStatus>;
  /** Read-only, metadata-only keyset page over the usage ledger (issue #67), ordered by `seq`. Never sums,
   * never counts, never touches `events`. */
  listCalls(query: CallsQuery): Promise<CallsPage>;
  /** A persistent random id for SQLite (survives a restart, issue #67's cursor "store epoch"), a new one every
   * process for memory mode. A cursor whose `e` differs from this is a 410 `cursor_expired`. */
  usageLedgerEpoch(): string;
  /** Grouped sums over the usage ledger (issue #66): `GET /api/v1/usage/rollup`. Both stores go through the same
   * shaper (`server/usage/rollup.ts`), so rounding, key ordering and `day` buckets never diverge. */
  rollup(query: RollupQuery): Promise<UsageRollupResponse>;

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

  /**
   * Stores OTLP metric points (issue #73). Never touches `events`, the snapshot, SSE or any rollup: a point here
   * is evidence for the ledger-vs-metrics cross-check, never a second copy of a ledger row.
   */
  appendTelemetryPoints(points: TelemetryPointInput[]): Promise<TelemetryAppendOutcome>;
  /** Raw stored points, for `server/telemetry.ts` to resolve delta/cumulative totals. No pagination: issue #73's
   * reconciliation endpoint (deferred, see `docs/otlp.md`) will add that when it lands. */
  listTelemetryPoints(filter?: TelemetryPointFilter): Promise<TelemetryPointRecord[]>;
  telemetryStats(): Promise<TelemetryStats>;
  /** The HMAC secret behind `series_key`. Generated once; persisted in SQLite mode, per-process in memory mode. */
  getTelemetryHmacSecret(): Promise<Buffer>;

  /**
   * Deletes events and/or ledger rows older than the given cutoffs (issue #70), in batches of `batchSize`
   * (default 5000), each its own transaction, yielding to the event loop between batches. No cascade: the two
   * cutoffs are independent, and purging events never touches the ledger or vice versa. Never throws away the
   * `purged_before`/`deleted_total` coverage signal, even if it throws partway through a batch.
   */
  purge(opts?: PurgeOptions): Promise<PurgeResult>;
  /** Counts, coverage signals and run history for `GET /api/v1/admin/retention` (issue #70). No sum of tokens or
   * cost, same rule as `usageLedgerStatus`. */
  retentionStatus(limit?: number): Promise<RetentionStatus>;
  /** Starts one retention run: inserts a `running` row (or, when `skip` is true, an already-finished `skipped`
   * one) and returns its id. Pair with `finishRetentionRun`. */
  recordRetentionRun(input: { startedAt: number; trigger: RetentionTrigger; skip?: boolean }): Promise<number>;
  /** Finishes a run started by `recordRetentionRun`, and prunes the run log to the latest 500 rows. */
  finishRetentionRun(id: number, patch: RetentionRunPatch): Promise<void>;

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

  /**
   * Removes every entry for which `remove` is true, preserving the relative order of what is kept (issue #70's
   * time-based purge: a different path from the count-based eviction `push` does, and independent of it). Since
   * what remains is never more than it was, this never triggers a `push` eviction while rebuilding. Returns the
   * removed entries, oldest first, so the caller can clean up any index keyed by their ids; an empty array (and
   * no rebuild at all) when nothing matched.
   */
  purgeWhere(remove: (entry: RetainedEntry) => boolean): RetainedEntry[] {
    const oldestToNewest: RetainedEntry[] = [];
    this.forEachNewestToOldest((entry) => {
      oldestToNewest.push(entry);
    });
    oldestToNewest.reverse();

    const removed: RetainedEntry[] = [];
    const kept: RetainedEntry[] = [];
    for (const entry of oldestToNewest) {
      if (remove(entry)) removed.push(entry);
      else kept.push(entry);
    }
    if (removed.length === 0) return removed;

    this.buf = [];
    this.writeIndex = 0;
    for (const entry of kept) this.push(entry);
    return removed;
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
  /** Cap on stored OTLP telemetry points (issue #73). Default `100000`; must be an integer >= 1. */
  telemetryMaxPoints?: number;
  /**
   * Cap on stored usage ledger rows (issue #65). Default `100000`; must be an integer >= 1. Deliberately **not**
   * tied to `maxEvents`: the ledger is evidence and must outlive the event ring's much smaller default window
   * (`new MemoryEventStore(50)` still keeps far more than 50 ledger rows). Once reached, further ledger rows (and
   * their skip decisions) are dropped, never silently: `usageLedgerStatus().complete` turns `false` and stays
   * `false` for the life of the process.
   */
  usageLedgerMaxRows?: number;
}

const DEFAULT_MAX_EVENTS = 10000;
/** Default `AGENT_VIEWER_TELEMETRY_MAX_POINTS` (issue #73): memory-mode cap on stored OTLP metric points. */
export const DEFAULT_TELEMETRY_MAX_POINTS = 100000;
/** Default `AGENT_VIEWER_USAGE_LEDGER_MAX_ROWS` (issue #65): memory-mode cap on stored ledger rows. */
export const DEFAULT_USAGE_LEDGER_MAX_ROWS = 100000;
/** Default `purge()` batch size (issue #70): rows deleted per transaction before yielding to the event loop. */
export const DEFAULT_RETENTION_BATCH_SIZE = 5000;
/** `retention_runs` / the in-memory run log keep at most this many rows (issue #70). Lifetime counts live in
 * `retention_state` (SQLite) or the store's own counters (memory) precisely so pruning this loses nothing. */
export const RETENTION_RUNS_MAX = 500;

function telemetryPointKey(point: Pick<TelemetryPointInput, 'seriesKey' | 'startTimeUnixNano' | 'timeUnixNano'>): string {
  return `${point.seriesKey}|${point.startTimeUnixNano}|${point.timeUnixNano}`;
}

function telemetryInputToRecord(point: TelemetryPointInput): TelemetryPointRecord {
  return {
    seriesKey: point.seriesKey,
    temporality: point.temporality,
    metricKind: point.metricKind,
    tokenType: point.tokenType,
    currency: point.currency,
    sessionId: point.sessionId,
    runtimeId: point.runtimeId,
    startTimeUnixNano: point.startTimeUnixNano,
    timeUnixNano: point.timeUnixNano,
    timeMs: point.timeMs,
    value: point.value,
  };
}

function matchesTelemetryFilter(point: TelemetryPointInput, filter?: TelemetryPointFilter): boolean {
  if (!filter) return true;
  if (filter.sessionId !== undefined && point.sessionId !== filter.sessionId) return false;
  if (filter.runtimeId !== undefined && point.runtimeId !== filter.runtimeId) return false;
  return true;
}
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
  /** Server receive time of every original event id ever accepted (issue #65), kept forever like `eventHashes`:
   * a duplicate must echo the *original* acceptance time, even long after the event itself was evicted. */
  private originalReceivedAt = new Map<string, number>();
  /** Usage ledger rows (issue #65), append-only, never tied to the event ring: evicting an event from `window`
   * never removes its ledger row. Capped independently by `usageLedgerMaxRows`. */
  private ledger: UsageLedgerRow[] = [];
  private ledgerByEventId = new Map<string, number>();
  private ledgerByRequestKey = new Map<string, number>();
  private ledgerSkips = new Map<string, { reason: LedgerSkipReason; keptEventId: string | null; detectedAt: number }>();
  private ledgerSeq = 1;
  private usageLedgerMaxRows: number;
  /** Issue #67's cursor "store epoch": minted once per process, never persisted. A cursor from a previous
   * process (or another `MemoryEventStore` instance) always fails the epoch check, so it is reported
   * `cursor_expired` instead of resuming a walk against an unrelated `seq` space. */
  private readonly ledgerEpoch = crypto.randomBytes(16).toString('hex');
  /** `false` once `usageLedgerMaxRows` has dropped at least one ledger row or skip (issue #53's rule, applied to
   * the ledger: never lost silently, always reported). */
  private ledgerComplete = true;
  /** Count of `llm.usage`/`llm.failed` events that reached a ledger decision but were refused a row because the
   * ledger was already at `usageLedgerMaxRows` (issue #66's `coverage.droppedRows`). This store never evicts an
   * existing row to make room (unlike the retained event window): once full, it refuses new rows instead, so a
   * "dropped" row here is one that was never admitted, not one later removed. */
  private ledgerDroppedRows = 0;
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
  /** Keyed by `series_key|start_time_unix_nano|time_unix_nano` (issue #73's idempotency key). */
  private telemetryPoints = new Map<string, TelemetryPointInput>();
  private telemetryMaxPoints: number;
  private telemetryTruncated = false;
  private telemetryWithoutSessionCount = 0;
  /** Generated on first use (issue #73): per-process, never persisted in memory mode. */
  private telemetrySecret: Buffer | null = null;
  /** Retention (issue #70): bounded in-process run log and the two coverage counters, the memory-mode equivalent
   * of the SQLite `retention_runs`/`retention_state` tables (there is nothing to survive a restart here, since a
   * fresh process starts this store from empty anyway). */
  private retentionRuns: RetentionRunRecord[] = [];
  private nextRetentionRunId = 1;
  private retentionState: Record<'events' | 'usageLedger', { purgedBefore: number | null; deletedTotal: number }> = {
    events: { purgedBefore: null, deletedTotal: 0 },
    usageLedger: { purgedBefore: null, deletedTotal: 0 },
  };

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
    const telemetryMaxPoints = opts.telemetryMaxPoints ?? DEFAULT_TELEMETRY_MAX_POINTS;
    if (!Number.isInteger(telemetryMaxPoints) || telemetryMaxPoints < 1) {
      throw new Error(`MemoryEventStore telemetryMaxPoints must be a positive integer, got ${telemetryMaxPoints}`);
    }
    this.telemetryMaxPoints = telemetryMaxPoints;
    const usageLedgerMaxRows = opts.usageLedgerMaxRows ?? DEFAULT_USAGE_LEDGER_MAX_ROWS;
    if (!Number.isInteger(usageLedgerMaxRows) || usageLedgerMaxRows < 1) {
      throw new Error(`MemoryEventStore usageLedgerMaxRows must be a positive integer, got ${usageLedgerMaxRows}`);
    }
    this.usageLedgerMaxRows = usageLedgerMaxRows;
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
  private classifyAndApply(
    event: CanonicalEvent,
    ignoreTimestamp = false,
    receivedAtOverride?: number,
    channel: IngestChannel = 'events'
  ): AppendResult {
    const fingerprint = eventFingerprint(event, ignoreTimestamp);

    const storedFingerprint = this.eventHashes.get(event.id);
    if (storedFingerprint !== undefined) {
      const originalReceivedAt = this.originalReceivedAt.get(event.id) ?? receivedAtOverride ?? this.now();
      if (storedFingerprint === fingerprint) {
        return appendResult('duplicate', event.id, fingerprint, undefined, { receivedAt: originalReceivedAt });
      }
      this.counters.conflicts++;
      warnConflict(event, fingerprint, storedFingerprint);
      return appendResult('conflict', event.id, fingerprint, storedFingerprint);
    }

    const existingRef = this.duplicateRefs.get(event.id);
    if (existingRef) {
      const refFingerprint = eventFingerprint(existingRef.event, ignoreTimestamp);
      const originalReceivedAt =
        this.originalReceivedAt.get(existingRef.duplicateOf) ?? receivedAtOverride ?? this.now();
      if (refFingerprint === fingerprint) {
        return appendResult('duplicate', existingRef.duplicateOf, fingerprint, undefined, {
          submittedId: event.id,
          receivedAt: originalReceivedAt,
        });
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
        const originalReceivedAt = this.originalReceivedAt.get(original.id) ?? receivedAtOverride ?? this.now();
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
          receivedAt: originalReceivedAt,
        });
      }
    }

    this.eventHashes.set(event.id, fingerprint);
    this.acceptedEvents++;
    const receivedAt = receivedAtOverride ?? this.now();
    this.originalReceivedAt.set(event.id, receivedAt);
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
    if (requestKey) {
      this.requestIndex.set(requestKey.key, { id: event.id, fields: extractUsageFingerprintFields(event) });
    }
    // Ledger decision first (issue #70): its outcome gates whether the usage figures below are applied, so a
    // resent id whose event row was purged but whose ledger row was not never double counts (see `applyEvent`'s
    // `skipUsage` doc comment in `server/serverState.ts`).
    const ledgerSkipped = this.applyLedgerDecision(event, { receivedAt, origin: 'live', channel, legacyContract: false });
    this.processEventSideEffects(event, ledgerSkipped);
    return appendResult('accepted', event.id, fingerprint, undefined, { seq, receivedAt });
  }

  /**
   * Gives one accepted `llm.usage`/`llm.failed` event exactly one ledger decision (issue #65): a new row, or a
   * `usage_ledger_skips` entry (`duplicate` when the `(provider, requestId)` key is already held by a row with
   * the same figures, `conflict` when it is held with different figures). A non-usage event, or a payload
   * `toLedgerRow` cannot read, produces neither (nothing to do for the former; the latter cannot happen on the
   * live path, since the routes already validated the payload shape). Mirrors `SQLiteEventStore`'s transactional
   * write so both stores reach the same rows and skips for the same input (see `tests/usage-ledger.test.mjs`).
   */
  /** Returns `true` when this call matched an existing ledger row (a `duplicate` or `conflict` skip) instead of
   * inserting a new one, so the caller knows not to add this event's usage figures a second time (issue #70).
   * Always `false` for a non-usage event (`toLedgerRow` returns `null`): there is nothing to double count. */
  private applyLedgerDecision(
    event: CanonicalEvent,
    ctx: { receivedAt: number; origin: LedgerOrigin; channel: IngestChannel; legacyContract: boolean }
  ): boolean {
    const ledgerRow = toLedgerRow(event, ctx);
    if (ledgerRow === null) return false;

    // Defensive, same as the SQLite half's `ON CONFLICT(event_id) DO NOTHING` check: a resent event id whose
    // *event* was purged independently of the ledger (issue #70) but whose ledger row was kept must never insert
    // a second row by id, even without a request key to match on.
    if (this.ledgerByEventId.has(ledgerRow.eventId)) return true;

    const key = ledgerRequestKey(ledgerRow);
    if (key !== null) {
      const existingIndex = this.ledgerByRequestKey.get(key);
      if (existingIndex !== undefined) {
        const existing = this.ledger[existingIndex];
        const reason: LedgerSkipReason = sameCall(existing, ledgerRow) ? 'duplicate' : 'conflict';
        this.recordLedgerSkip(ledgerRow.eventId, reason, existing.eventId, ctx.receivedAt);
        return true;
      }
    }

    if (this.ledger.length >= this.usageLedgerMaxRows) {
      this.ledgerComplete = false;
      this.ledgerDroppedRows++;
      return false;
    }
    const row: UsageLedgerRow = { ...ledgerRow, seq: this.ledgerSeq++ };
    const index = this.ledger.length;
    this.ledger.push(row);
    this.ledgerByEventId.set(row.eventId, index);
    if (key !== null) this.ledgerByRequestKey.set(key, index);
    return false;
  }

  private recordLedgerSkip(eventId: string, reason: LedgerSkipReason, keptEventId: string | null, detectedAt: number): void {
    if (this.ledgerSkips.size + this.ledger.length >= this.usageLedgerMaxRows * 2) {
      // Extremely defensive: skips share no hard cap of their own in the issue, but must still never grow
      // without bound once the ledger itself is already full and reporting incomplete.
      this.ledgerComplete = false;
      return;
    }
    this.ledgerSkips.set(eventId, { reason, keptEventId, detectedAt });
  }

  async usageLedgerStatus(): Promise<UsageLedgerStatus> {
    let live = 0;
    let backfill = 0;
    let legacyRows = 0;
    let oldest: number | null = null;
    let newest: number | null = null;
    for (const row of this.ledger) {
      if (row.origin === 'live') live++;
      else backfill++;
      if (row.legacyContract) legacyRows++;
      if (oldest === null || row.receivedAt < oldest) oldest = row.receivedAt;
      if (newest === null || row.receivedAt > newest) newest = row.receivedAt;
    }
    let duplicate = 0;
    let conflict = 0;
    let unparseable = 0;
    for (const skip of this.ledgerSkips.values()) {
      if (skip.reason === 'duplicate') duplicate++;
      else if (skip.reason === 'conflict') conflict++;
      else unparseable++;
    }
    return {
      schemaVersion: '1.0',
      storage: 'memory',
      rows: this.ledger.length,
      rowsByOrigin: { live, backfill },
      legacyRows,
      skips: { duplicate, conflict, unparseable },
      oldestReceivedAt: oldest,
      newestReceivedAt: newest,
      complete: this.ledgerComplete,
      migration: null,
    };
  }

  /** Read-only keyset page over `this.ledger` (issue #67). Pure delegation to `listCallsInMemory`: `this.ledger`
   * is append-only and therefore always seq-ascending (see its own field comment), which is exactly what that
   * function assumes. */
  async listCalls(query: CallsQuery): Promise<CallsPage> {
    return listCallsInMemory(this.ledger, query);
  }

  /** A fresh random id every process (issue #67): memory mode never persists `seq`, so a cursor from an earlier
   * process must never be mistaken for one from this one. */
  usageLedgerEpoch(): string {
    return this.ledgerEpoch;
  }

  async rollup(query: RollupQuery): Promise<UsageRollupResponse> {
    return computeMemoryRollup({
      ledger: this.ledger,
      query,
      now: this.now,
      coverage: {
        droppedRows: this.ledgerDroppedRows,
        capComplete: this.ledgerComplete,
        purgedThrough: this.retentionState.usageLedger.purgedBefore,
      },
    });
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

  async append(event: CanonicalEvent, options?: AppendOptions): Promise<AppendResult> {
    return this.classifyAndApply(event, false, options?.receivedAt, options?.channel ?? 'events');
  }

  async appendBatch(
    events: CanonicalEvent[],
    options?: { atomic?: boolean; ignoreTimestamp?: boolean } & AppendOptions
  ): Promise<AppendBatchResult> {
    const atomic = options?.atomic ?? false;
    const ignoreTimestamp = options?.ignoreTimestamp ?? false;
    const receivedAt = options?.receivedAt ?? this.now();
    const channel = options?.channel ?? 'events-batch';

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
              return appendResult('accepted', e.id, fp, undefined, { receivedAt });
            }
            if (stored === fp) {
              return appendResult('duplicate', e.id, fp, undefined, {
                receivedAt: this.originalReceivedAt.get(e.id) ?? receivedAt,
              });
            }
            this.counters.conflicts++;
            return appendResult('conflict', e.id, fp, stored);
          });
          return summarizeBatch(results, events);
        }
      }
      // All checks passed, now insert. Each item evicts through the ring as it is pushed, in order, so a batch
      // larger than maxEvents still retains exactly the newest maxEvents events (issue #53).
      const results = events.map((event) => this.classifyAndApply(event, ignoreTimestamp, receivedAt, channel));
      return summarizeBatch(results, events);
    } else {
      const results = events.map((event) => this.classifyAndApply(event, ignoreTimestamp, receivedAt, channel));
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
   * the other filters; an `afterId` not found, or filtered out, applies no cut; default limit 100). Without
   * `beforeId`, walks the ring newest to oldest and stops as soon as `limit` entries are collected, instead of
   * copying the whole window per call (issue #53).
   */
  async list(options: ListEventsOptions = {}): Promise<EventWithReceivedAt[]> {
    const limit = options.limit && options.limit > 0 ? options.limit : 100;
    const matches = (event: CanonicalEvent): boolean => {
      if (options.runtimeId && event.runtimeId !== options.runtimeId) return false;
      if (options.sessionId && event.sessionId !== options.sessionId) return false;
      if (options.agentId && event.agentId !== options.agentId) return false;
      if (options.type && event.type !== options.type) return false;
      if (options.since !== undefined && event.timestamp < options.since) return false;
      return true;
    };

    if (!options.beforeId) {
      const result: EventWithReceivedAt[] = [];
      this.window.forEachNewestToOldest(({ event, receivedAt }) => {
        if (!matches(event)) return true;
        // Mirrors `result.slice(0, index)` on the equivalent array implementation: everything from the cursor
        // onward (older, in this walk order) is excluded, whether or not `limit` was reached yet.
        if (options.afterId && event.id === options.afterId) return false;
        result.push({ ...event, receivedAt });
        return result.length < limit;
      });
      return result;
    }

    // `beforeId` (issue #72), the mirror of `afterId`: a cursor not found, or filtered out, applies no cut, same
    // convention as `afterId`. Whether the cursor turns up at all is only known once the walk (down to any
    // `afterId` cut) finishes, so the matched events are collected first and sliced relative to the cursor
    // afterward, rather than exited early the way the no-`beforeId` branch above does.
    const matched: EventWithReceivedAt[] = [];
    let cursorIndex = -1;
    this.window.forEachNewestToOldest(({ event, receivedAt }) => {
      if (!matches(event)) return true;
      if (options.afterId && event.id === options.afterId) return false;
      if (event.id === options.beforeId) {
        cursorIndex = matched.length;
        return true;
      }
      matched.push({ ...event, receivedAt });
      return true;
    });
    const start = cursorIndex === -1 ? 0 : cursorIndex;
    return matched.slice(start, start + limit);
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

  async appendTelemetryPoints(points: TelemetryPointInput[]): Promise<TelemetryAppendOutcome> {
    let accepted = 0;
    let duplicates = 0;
    let conflicts = 0;
    let rejectedCapacity = 0;
    const messages: string[] = [];

    for (const point of points) {
      const key = telemetryPointKey(point);
      const existing = this.telemetryPoints.get(key);
      if (existing) {
        if (existing.value === point.value) {
          duplicates++;
        } else {
          conflicts++;
          messages.push(`${point.metricName}: conflicting duplicate (same point reported twice with different values)`);
        }
        continue;
      }
      if (this.telemetryPoints.size >= this.telemetryMaxPoints) {
        rejectedCapacity++;
        this.telemetryTruncated = true;
        messages.push(`${point.metricName}: rejected, AGENT_VIEWER_TELEMETRY_MAX_POINTS (${this.telemetryMaxPoints}) reached`);
        continue;
      }
      this.telemetryPoints.set(key, point);
      accepted++;
      if (point.sessionId === null) this.telemetryWithoutSessionCount++;
    }

    return { accepted, duplicates, conflicts, rejectedCapacity, messages };
  }

  async listTelemetryPoints(filter?: TelemetryPointFilter): Promise<TelemetryPointRecord[]> {
    const results: TelemetryPointRecord[] = [];
    for (const point of this.telemetryPoints.values()) {
      if (matchesTelemetryFilter(point, filter)) results.push(telemetryInputToRecord(point));
    }
    return results;
  }

  async telemetryStats(): Promise<TelemetryStats> {
    return {
      pointsStored: this.telemetryPoints.size,
      pointsWithoutSession: this.telemetryWithoutSessionCount,
      truncated: this.telemetryTruncated,
    };
  }

  async getTelemetryHmacSecret(): Promise<Buffer> {
    if (!this.telemetrySecret) this.telemetrySecret = crypto.randomBytes(32);
    return this.telemetrySecret;
  }

  /**
   * Time-based purge (issue #70), independent of the count-based window eviction above: dropping an event here
   * never touches `eventHashes`/`originalReceivedAt`/`requestIndex` (dedup memory), exactly like a capacity
   * eviction does not, so a resent purged id is still classified as a duplicate and never reaches the ledger a
   * second time. Dropping a ledger row never touches `events`. Synchronous work only: a memory-mode table is
   * bounded by its own cap (`maxEvents`, `usageLedgerMaxRows`), so there is nothing here that needs batching or an
   * event-loop yield the way the SQLite path does.
   */
  async purge(opts: PurgeOptions = {}): Promise<PurgeResult> {
    let eventsDeleted = 0;
    if (opts.eventsCutoffMs !== undefined) {
      const cutoff = opts.eventsCutoffMs;
      const removed = this.window.purgeWhere((entry) => entry.receivedAt < cutoff);
      if (removed.length > 0) {
        for (const entry of removed) this.eventSeqs.delete(entry.event.id);
        this.droppedEvents += removed.length;
        this.bumpRetentionState('events', cutoff, removed.length);
      }
      eventsDeleted = removed.length;
    }

    let ledgerDeleted = 0;
    if (opts.ledgerCutoffMs !== undefined) {
      const cutoff = opts.ledgerCutoffMs;
      const kept: UsageLedgerRow[] = [];
      let removedCount = 0;
      for (const row of this.ledger) {
        if (row.receivedAt < cutoff) removedCount++;
        else kept.push(row);
      }
      if (removedCount > 0) {
        this.ledger = kept;
        this.ledgerByEventId.clear();
        this.ledgerByRequestKey.clear();
        for (let i = 0; i < this.ledger.length; i++) {
          const row = this.ledger[i];
          this.ledgerByEventId.set(row.eventId, i);
          const key = ledgerRequestKey(row);
          if (key !== null) this.ledgerByRequestKey.set(key, i);
        }
        this.bumpRetentionState('usageLedger', cutoff, removedCount);
      }
      ledgerDeleted = removedCount;
    }

    return {
      eventsDeleted,
      ledgerDeleted,
      eventsOldestReceivedAt: this.window.oldest()?.receivedAt ?? null,
      ledgerOldestReceivedAt: this.ledger.reduce<number | null>(
        (min, row) => (min === null || row.receivedAt < min ? row.receivedAt : min),
        null
      ),
    };
  }

  /** `purged_before` (max of existing and this cutoff, so it only ever moves forward) and `deleted_total`, for
   * one scope. Always called with `count > 0`, so `deleted_total` only ever increases on an actual deletion. */
  private bumpRetentionState(scope: 'events' | 'usageLedger', cutoffMs: number, count: number): void {
    const state = this.retentionState[scope];
    state.purgedBefore = state.purgedBefore === null ? cutoffMs : Math.max(state.purgedBefore, cutoffMs);
    state.deletedTotal += count;
  }

  async retentionStatus(limit = 20): Promise<RetentionStatus> {
    const runs = this.retentionRuns.slice(0, Math.max(1, Math.min(limit, RETENTION_RUNS_MAX)));
    const lastRun = this.retentionRuns[0] ?? null;
    const lastFinishedWith = (pick: (r: RetentionRunRecord) => boolean) =>
      this.retentionRuns.find((r) => r.finishedAt !== null && pick(r)) ?? null;
    const lastEventsRun = lastFinishedWith((r) => r.eventsWindowDays !== null);
    const lastLedgerRun = lastFinishedWith((r) => r.ledgerWindowDays !== null);

    let ledgerOldest: number | null = null;
    for (const row of this.ledger) {
      if (ledgerOldest === null || row.receivedAt < ledgerOldest) ledgerOldest = row.receivedAt;
    }

    return {
      events: {
        count: this.window.size,
        oldestReceivedAt: this.window.oldest()?.receivedAt ?? null,
        purgedBefore: this.retentionState.events.purgedBefore,
        lastCutoffMs: lastEventsRun?.eventsCutoffMs ?? null,
        lastDeleted: lastEventsRun ? lastEventsRun.eventsDeleted : null,
        deletedTotal: this.retentionState.events.deletedTotal,
      },
      usageLedger: {
        count: this.ledger.length,
        oldestReceivedAt: ledgerOldest,
        purgedBefore: this.retentionState.usageLedger.purgedBefore,
        lastCutoffMs: lastLedgerRun?.ledgerCutoffMs ?? null,
        lastDeleted: lastLedgerRun ? lastLedgerRun.ledgerDeleted : null,
        deletedTotal: this.retentionState.usageLedger.deletedTotal,
      },
      lastRun,
      runs,
    };
  }

  async recordRetentionRun(input: { startedAt: number; trigger: RetentionTrigger; skip?: boolean }): Promise<number> {
    const id = this.nextRetentionRunId++;
    const record: RetentionRunRecord = {
      id,
      startedAt: input.startedAt,
      finishedAt: input.skip ? input.startedAt : null,
      trigger: input.trigger,
      status: input.skip ? 'skipped' : 'running',
      eventsWindowDays: null,
      eventsCutoffMs: null,
      eventsDeleted: 0,
      ledgerWindowDays: null,
      ledgerCutoffMs: null,
      ledgerDeleted: 0,
      error: null,
    };
    this.retentionRuns.unshift(record);
    if (this.retentionRuns.length > RETENTION_RUNS_MAX) this.retentionRuns.length = RETENTION_RUNS_MAX;
    return id;
  }

  async finishRetentionRun(id: number, patch: RetentionRunPatch): Promise<void> {
    const record = this.retentionRuns.find((r) => r.id === id);
    if (!record) return;
    Object.assign(record, patch);
  }

  async close(): Promise<void> {
    // In-memory does not require cleanup
  }

  /** Applies one accepted event's side effects. The reducer itself lives in `serverState.ts` (issue #52), shared
   * with `SQLiteEventStore` so the live path and a rebuild from storage reach the same state. `skipUsage` (issue
   * #70) is forwarded to `applyEvent`: true when the ledger step just classified this as a resend of data it
   * already holds (see `applyLedgerDecision`). */
  private processEventSideEffects(event: CanonicalEvent, skipUsage = false): void {
    applyEvent(this.state, event, { skipUsage });
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
  /** Issue #70: true when `applyLedgerDecision` matched an existing ledger row instead of inserting a new one
   * (reachable once events are purged independently of the ledger), so `append`/`appendBatch` must call
   * `applyEvent` with `skipUsage: true` and never add this event's tokens and cost twice. `undefined`/`false` for
   * every outcome other than a fresh 'accepted' usage/failed event, which is the only case it can ever be `true`. */
  ledgerSkipped?: boolean;
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
  /** Issue #67's cursor "store epoch": the `usage_ledger_meta` row migration 7 (`usage-calls-indexes`) writes
   * once, read back here so it survives a restart. Set in the constructor, right after migrations run. */
  private ledgerEpoch = '';
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

    const epochRow = this.db.prepare("SELECT value FROM usage_ledger_meta WHERE key = 'store_epoch'").get() as
      | { value: string }
      | undefined;
    // Always present once migration 7 has run (it inserts the row unconditionally when missing); the fallback
    // only guards a store opened against a schema a future migration changes the shape of.
    this.ledgerEpoch = epochRow?.value ?? crypto.randomBytes(16).toString('hex');

    this.backfillNullSeq();
    const maxSeqRow = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM events').get() as { maxSeq: number };
    this.nextSeq = maxSeqRow.maxSeq + 1;
    const countRow = this.db.prepare('SELECT COUNT(*) AS count FROM events WHERE duplicate_of IS NULL').get() as { count: number };
    this.eventsCountCache = countRow.count;
    const earliestRow = this.db.prepare('SELECT MIN(created_at) AS earliest FROM events WHERE duplicate_of IS NULL').get() as {
      earliest: number | null;
    };
    if (earliestRow.earliest !== null) this.totalsSinceCache = earliestRow.earliest;

    // Usage ledger startup catch-up (issue #65): runs on every open, not only the first time migration 6 itself
    // applies. Normally a no-op (its own WHERE clause only selects usage/failed rows missing both a ledger row
    // and a skip row); it fills any gap left by an older server that wrote events while the ledger table existed
    // but was not kept up to date, for example after a downgrade to 0.3.x and back.
    const baselineRow = this.db.prepare('SELECT applied_at FROM schema_migrations WHERE version = 1').get() as
      | { applied_at: number }
      | undefined;
    runUsageLedgerBackfill(
      this.db,
      { origin: 'backfill', legacyContractCutoff: baselineRow ? Number(baselineRow.applied_at) : null },
      { log: (message) => this.rebuildOptions.logger.info(message) }
    );

    // Retention (issue #70): a `retention_runs` row left `running` means the process died mid-purge. Closed as
    // `error`/`interrupted` on the next open, so the audit log never silently claims a run is still in flight.
    // Only reachable once migration 8 has created the table.
    if (this.tableExists('retention_runs')) this.closeStaleRetentionRuns();

    // Kicked off here (not only from `server/index.ts`) so a store built directly, as many tests do, never needs
    // an explicit `init()` call: for a file with no backlog beyond one page, every row is applied synchronously
    // below, before this constructor returns (see `init()`).
    this.initPromise = this.init();
  }

  private tableExists(name: string): boolean {
    return Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }

  private closeStaleRetentionRuns(): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE retention_runs SET status = 'error', finished_at = ?, error = 'interrupted' WHERE status = 'running'"
      )
      .run(now);
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
    matchesOriginal: boolean | null,
    receivedAt: number
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
      receivedAt,
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
    return this.db.prepare('SELECT content_hash, duplicate_of, created_at FROM events WHERE id = ?');
  }

  /** The server receive time already stored for `id`, or `null` when no row holds that id. */
  private lookupCreatedAt(id: string): number | null {
    const row = this.db.prepare('SELECT created_at FROM events WHERE id = ?').get(id) as { created_at: number } | undefined;
    return row ? Number(row.created_at) : null;
  }

  /**
   * The original event id already stored under this `(provider, requestId)` key, with the usage-relevant fields
   * needed for the fingerprint comparison and its server receive time (issue #65: a duplicate echoes the
   * original's acceptance time, never the retry's). Kept as its own small method so a test can override it, for
   * example to force the UNIQUE-constraint race path deterministically (`node:sqlite` is synchronous, so two
   * instances in one process cannot truly interleave).
   */
  private lookupRequestKey(
    provider: string,
    requestId: string
  ): { id: string; fields: UsageFingerprintFields; receivedAt: number } | null {
    const row = this.db
      .prepare(
        'SELECT id, type, payload, created_at FROM events WHERE request_provider = ? AND request_id = ? AND duplicate_of IS NULL LIMIT 1'
      )
      .get(provider, requestId) as { id: string; type: string; payload: string; created_at: number } | undefined;
    if (!row) return null;
    const payload = JSON.parse(row.payload || '{}');
    return {
      id: row.id,
      fields: extractUsageFingerprintFields({ type: row.type, payload } as CanonicalEvent),
      receivedAt: Number(row.created_at),
    };
  }

  /** Decides the outcome for an id that is already stored. A NULL hash cannot be compared: duplicate, never conflict. */
  private classifyStored(
    event: CanonicalEvent,
    fingerprint: string,
    row: { content_hash: string | null; duplicate_of: string | null; created_at: number }
  ): PendingOutcome {
    const stored = row.content_hash;
    // A row whose own id is itself a duplicate reference resolves to its original; resending its id is still an
    // event_id duplicate (its own content is remembered too), it just points one hop further. The original's own
    // receive time (not this row's) is what a duplicate response must echo.
    const originalId = row.duplicate_of ?? event.id;
    const submittedId = row.duplicate_of ? event.id : undefined;
    const originalReceivedAt = row.duplicate_of ? (this.lookupCreatedAt(originalId) ?? Number(row.created_at)) : Number(row.created_at);
    if (stored === null || stored === undefined) {
      return {
        result: appendResult('duplicate', originalId, fingerprint, undefined, { submittedId, receivedAt: originalReceivedAt }),
        event,
        legacyUnverified: true,
      };
    }
    if (stored === fingerprint) {
      return {
        result: appendResult('duplicate', originalId, fingerprint, undefined, { submittedId, receivedAt: originalReceivedAt }),
        event,
        legacyUnverified: false,
      };
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
  private classifyAndInsert(
    lookupStmt: any,
    insertStmt: any,
    event: CanonicalEvent,
    ignoreTimestamp = false,
    receivedAt: number = Date.now(),
    channel: IngestChannel = 'events'
  ): PendingOutcome {
    const fingerprint = eventFingerprint(event, ignoreTimestamp);
    const existing = lookupStmt.get(event.id) as
      | { content_hash: string | null; duplicate_of: string | null; created_at: number }
      | undefined;
    if (existing) return this.classifyStored(event, fingerprint, existing);

    const requestKey = requestKeyFor(event);
    const original = requestKey ? this.lookupRequestKey(requestKey.provider, requestKey.requestId) : null;
    if (requestKey && original) {
      const matchesOriginal = fingerprintFieldsMatch(original.fields, extractUsageFingerprintFields(event));
      try {
        this.insertEvent(insertStmt, event, fingerprint, requestKey, original.id, matchesOriginal, receivedAt);
      } catch (error) {
        if (!isUniqueIdViolation(error)) throw error;
        const raced = lookupStmt.get(event.id) as
          | { content_hash: string | null; duplicate_of: string | null; created_at: number }
          | undefined;
        if (!raced) throw error;
        return this.classifyStored(event, fingerprint, raced);
      }
      return {
        result: appendResult('duplicate', original.id, fingerprint, undefined, {
          duplicateReason: 'request_id',
          submittedId: event.id,
          matchesOriginal,
          receivedAt: original.receivedAt,
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
      seq = this.insertEvent(insertStmt, event, fingerprint, requestKey, null, null, receivedAt);
    } catch (error) {
      if (requestKey && isUniqueRequestKeyViolation(error)) {
        // Lost a race with another writer that claimed this request key first. Defensive only: several processes
        // sharing one SQLite file is not officially supported (issue #48, out of scope). The process that lost
        // the race never forwards the event to the memory fallback: only `append`/`appendBatch` do that, and
        // only for an 'accepted' outcome.
        const raced = this.lookupRequestKey(requestKey.provider, requestKey.requestId);
        if (raced) {
          const matchesOriginal = fingerprintFieldsMatch(raced.fields, extractUsageFingerprintFields(event));
          this.insertEvent(insertStmt, event, fingerprint, requestKey, raced.id, matchesOriginal, receivedAt);
          return {
            result: appendResult('duplicate', raced.id, fingerprint, undefined, {
              duplicateReason: 'request_id',
              submittedId: event.id,
              matchesOriginal,
              receivedAt: raced.receivedAt,
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
      const raced = lookupStmt.get(event.id) as
        | { content_hash: string | null; duplicate_of: string | null; created_at: number }
        | undefined;
      if (!raced) throw error;
      return this.classifyStored(event, fingerprint, raced);
    }
    // A newly accepted usage event gets exactly one ledger decision in this same insert step (issue #65), so it
    // is covered by whichever transaction the caller (`append`/`appendBatch`) already opened around this call.
    // Its result also gates whether `applyEvent` applies this event's usage figures (issue #70): see
    // `applyLedgerDecision`'s doc comment.
    const ledgerSkipped = this.applyLedgerDecision(event, { receivedAt, origin: 'live', channel, legacyContract: false });
    return {
      result: appendResult('accepted', event.id, fingerprint, undefined, { seq, receivedAt }),
      event,
      legacyUnverified: false,
      ledgerSkipped,
    };
  }

  /**
   * SQLite half of the ledger write (issue #65). See `MemoryEventStore.applyLedgerDecision` for the mirrored
   * memory-mode logic; both must reach the same rows and skips for the same input sequence
   * (`tests/usage-ledger.test.mjs`, "store parity").
   *
   * Returns `true` when this matched an existing ledger row (a `duplicate` or `conflict` skip) instead of
   * inserting a new one (issue #70): the caller must then tell `applyEvent` to skip this event's usage figures,
   * or a resent id whose `events` row was purged but whose ledger row was not would add its tokens and cost a
   * second time. `false` for a non-usage event (nothing to double count) and for a genuinely new row.
   */
  private applyLedgerDecision(
    event: CanonicalEvent,
    ctx: { receivedAt: number; origin: LedgerOrigin; channel: IngestChannel; legacyContract: boolean }
  ): boolean {
    const ledgerRow = toLedgerRow(event, ctx);
    if (ledgerRow === null) return false;

    const key = ledgerRequestKey(ledgerRow);
    if (key !== null) {
      const existingRaw = this.db
        .prepare('SELECT * FROM usage_ledger WHERE provider = ? AND request_id = ? LIMIT 1')
        .get(ledgerRow.provider, ledgerRow.requestId);
      if (existingRaw) {
        const existing = dbRowToLedgerRowInput(existingRaw);
        const reason: LedgerSkipReason = sameCall(existing, ledgerRow) ? 'duplicate' : 'conflict';
        this.db
          .prepare(
            'INSERT INTO usage_ledger_skips (event_id, reason, kept_event_id, detected_at, origin) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING'
          )
          .run(ledgerRow.eventId, reason, existing.eventId, ctx.receivedAt, ctx.origin);
        return true;
      }
    }

    // No request key (or one that found nothing above): the only remaining way this could already hold a row is
    // a resent event id whose *event* row was purged independently of the ledger (issue #70) while its ledger
    // row was kept. `event_id` is UNIQUE, so that insert is a silent `ON CONFLICT ... DO NOTHING` no-op; `changes`
    // tells the two cases apart, which the caller needs to decide whether to skip this event's usage figures.
    const insertResult = this.db
      .prepare(
        `INSERT INTO usage_ledger (
          event_id, event_type, request_id, received_at, occurred_at, origin, legacy_contract, ingest_channel,
          runtime_id, session_id, agent_id, task_id, provider, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens, cost, currency, cost_source, latency_ms,
          status, error_kind, trace_id, parent_id, tool_call_id, meeting_id, user_id, tags
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO NOTHING`
      )
      .run(
        ledgerRow.eventId,
        ledgerRow.eventType,
        ledgerRow.requestId,
        ledgerRow.receivedAt,
        ledgerRow.occurredAt,
        ledgerRow.origin,
        ledgerRow.legacyContract ? 1 : 0,
        ledgerRow.ingestChannel,
        ledgerRow.runtimeId,
        ledgerRow.sessionId,
        ledgerRow.agentId,
        ledgerRow.taskId,
        ledgerRow.provider,
        ledgerRow.model,
        ledgerRow.inputTokens,
        ledgerRow.outputTokens,
        ledgerRow.cacheReadTokens,
        ledgerRow.cacheWriteTokens,
        ledgerRow.reasoningTokens,
        ledgerRow.cost,
        ledgerRow.currency,
        ledgerRow.costSource,
        ledgerRow.latencyMs,
        ledgerRow.status,
        ledgerRow.errorKind,
        ledgerRow.traceId,
        ledgerRow.parentId,
        ledgerRow.toolCallId,
        ledgerRow.meetingId,
        ledgerRow.userId,
        JSON.stringify(ledgerRow.tags)
      );

    const inserted = Number((insertResult as { changes?: number | bigint }).changes ?? 0) > 0;

    // One `usage_ledger_tags` row per tag, in the same transaction as the ledger row (issue #66), keyed by the
    // row's own `seq` (the table's rowid alias, read back from `run()`). Skipped when the insert itself was a
    // no-op (a same-process race on `event_id`; rare, since the live path already checked duplicates above).
    if (inserted && ledgerRow.tags.length > 0) {
      const seq = Number((insertResult as { lastInsertRowid: number | bigint }).lastInsertRowid);
      const insertTag = this.db.prepare('INSERT OR IGNORE INTO usage_ledger_tags (ledger_seq, tag) VALUES (?, ?)');
      for (const tag of ledgerRow.tags) insertTag.run(seq, tag);
    }

    return !inserted;
  }

  async usageLedgerStatus(): Promise<UsageLedgerStatus> {
    const counts = this.db
      .prepare(
        `SELECT COUNT(*) AS rows,
                SUM(CASE WHEN origin = 'live' THEN 1 ELSE 0 END) AS live,
                SUM(CASE WHEN origin = 'backfill' THEN 1 ELSE 0 END) AS backfill,
                SUM(CASE WHEN legacy_contract = 1 THEN 1 ELSE 0 END) AS legacyRows,
                MIN(received_at) AS oldest,
                MAX(received_at) AS newest
         FROM usage_ledger`
      )
      .get() as { rows: number; live: number | null; backfill: number | null; legacyRows: number | null; oldest: number | null; newest: number | null };
    const skipCounts = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN reason = 'duplicate' THEN 1 ELSE 0 END) AS duplicate,
          SUM(CASE WHEN reason = 'conflict' THEN 1 ELSE 0 END) AS conflict,
          SUM(CASE WHEN reason = 'unparseable' THEN 1 ELSE 0 END) AS unparseable
         FROM usage_ledger_skips`
      )
      .get() as { duplicate: number | null; conflict: number | null; unparseable: number | null };
    const migrationRow = this.db
      .prepare("SELECT version, applied_at FROM schema_migrations WHERE name = 'usage-ledger' LIMIT 1")
      .get() as { version: number; applied_at: number } | undefined;

    return {
      schemaVersion: '1.0',
      storage: 'sqlite',
      rows: counts.rows,
      rowsByOrigin: { live: counts.live ?? 0, backfill: counts.backfill ?? 0 },
      legacyRows: counts.legacyRows ?? 0,
      skips: {
        duplicate: skipCounts.duplicate ?? 0,
        conflict: skipCounts.conflict ?? 0,
        unparseable: skipCounts.unparseable ?? 0,
      },
      oldestReceivedAt: counts.oldest === null || counts.oldest === undefined ? null : Number(counts.oldest),
      newestReceivedAt: counts.newest === null || counts.newest === undefined ? null : Number(counts.newest),
      complete: true,
      migration: migrationRow
        ? { id: `${String(migrationRow.version).padStart(4, '0')}_usage_ledger`, appliedAt: Number(migrationRow.applied_at) }
        : null,
    };
  }

  /** Read-only keyset page over `usage_ledger` (issue #67): one query, explicit column list, `LIMIT limit + 1`
   * to detect `hasMore` without a `COUNT(*)`. */
  async listCalls(query: CallsQuery): Promise<CallsPage> {
    const { sql, params } = buildListCallsQuery(query);
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const hasMore = rows.length > query.limit;
    const sliced = hasMore ? rows.slice(0, query.limit) : rows;
    const records = sliced.map(sqliteRowToCallRecord);
    return {
      rows: records,
      hasMore,
      lastSeq: records.length > 0 ? records[records.length - 1].seq : null,
    };
  }

  usageLedgerEpoch(): string {
    return this.ledgerEpoch;
  }

  async rollup(query: RollupQuery): Promise<UsageRollupResponse> {
    return computeSqliteRollup(this.db, query);
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

  /** See `server/eventRow.ts`: shared with the usage ledger backfill (issue #65) so both read the same shape. */
  private rowToEvent(r: any): CanonicalEvent {
    return rowToEvent(r);
  }

  /**
   * Wrapped in its own transaction since issue #65: a new event's row and its ledger decision (`toLedgerRow`,
   * inside `classifyAndInsert`) must both land or both roll back, so an event can never exist without a ledger
   * row or a recorded skip. A duplicate or conflict never reaches `classifyAndInsert`'s insert step, so wrapping
   * every call (not only the accepted path) is a minor, constant cost in exchange for never special-casing which
   * outcome needed the transaction.
   */
  async append(event: CanonicalEvent, options?: AppendOptions): Promise<AppendResult> {
    const receivedAt = options?.receivedAt ?? Date.now();
    const channel = options?.channel ?? 'events';
    let pending: PendingOutcome;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      pending = this.classifyAndInsert(this.prepareLookup(), this.prepareInsert(), event, false, receivedAt, channel);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      throw error;
    }
    this.recordOutcome(pending);
    if (pending.result.outcome === 'accepted') {
      this.eventsCountCache++;
      this.ensureTotalsSinceCache();
      // While a startup rebuild is running (or failed), the event is persisted only: the rebuild loop (or a
      // restart) is the one that applies it, so it is never applied twice (issue #52).
      if (this.rebuild.state === 'done') applyEvent(this.state, event, { skipUsage: pending.ledgerSkipped });
    }
    return pending.result;
  }

  /**
   * All or nothing at the storage level: the batch runs inside BEGIN IMMEDIATE ... COMMIT and rolls back on any
   * error. Rows inserted earlier in the batch are visible to later items, so repeats inside one batch are classified
   * like repeats across requests. Memory side effects run after the commit, with the accepted events only.
   * When atomic is true and a conflict is found, the entire batch is rejected without inserting any events.
   */
  async appendBatch(
    events: CanonicalEvent[],
    options?: { atomic?: boolean; ignoreTimestamp?: boolean } & AppendOptions
  ): Promise<AppendBatchResult> {
    const atomic = options?.atomic ?? false;
    const ignoreTimestamp = options?.ignoreTimestamp ?? false;
    // One receive time for the whole batch (issue #65): every accepted item shares it, and it also becomes
    // every item's `events.created_at`, so the two can never disagree.
    const receivedAt = options?.receivedAt ?? Date.now();
    const channel = options?.channel ?? 'events-batch';

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
              return appendResult('accepted', e.id, fp, undefined, { receivedAt });
            }
            if (r.fingerprint === fp) {
              return appendResult('duplicate', e.id, fp, undefined, { receivedAt: this.lookupCreatedAt(e.id) ?? receivedAt });
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
        pending.push(this.classifyAndInsert(lookupStmt, insertStmt, event, ignoreTimestamp, receivedAt, channel));
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
      // issue #70: `ledgerSkipped` per accepted event, keyed by id (unique among accepted events), so each one
      // gets `applyEvent`'s `skipUsage` exactly like the single-event `append` path above.
      const ledgerSkippedById = new Map(pending.map((entry) => [entry.event.id, entry.ledgerSkipped ?? false]));
      for (const accepted of summary.acceptedEvents) {
        applyEvent(this.state, accepted, { skipUsage: ledgerSkippedById.get(accepted.id) ?? false });
      }
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

  async list(options: ListEventsOptions = {}): Promise<EventWithReceivedAt[]> {
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
    if (options.beforeId) {
      // Mirror of `afterId` (issue #72): only events stored before the cursor event. Same "unknown cursor applies
      // no filter" convention; the route layer rejects an unresolvable `beforeId` before calling `list()`.
      const cursor = this.db.prepare('SELECT seq FROM events WHERE id = ?').get(options.beforeId) as
        | { seq: number }
        | undefined;
      if (cursor) {
        conditions.push('seq < ?');
        params.push(cursor.seq);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit && options.limit > 0 ? options.limit : 100;
    params.push(limit);

    // Ordered by `seq` alone (issue #72), the same durable arrival order `afterId`/`beforeId` cursors compare
    // against. Ordering by `timestamp` first disagreed with a `seq` cursor whenever events arrive with a
    // non-monotonic `timestamp` (batches, several runtimes, backfills), which could duplicate or skip rows while
    // paging. `since` still filters on `timestamp`; only the row order changes here.
    const sql = `SELECT * FROM events ${whereClause} ORDER BY seq DESC LIMIT ?`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    // `receivedAt` (issue #65): the server clock already stored in `created_at`, finally returned. `GET
    // /api/v1/snapshot` and SSE frames are unaffected on purpose; they build their own event lists separately.
    return rows.map((r) => ({ ...this.rowToEvent(r), receivedAt: Number(r.created_at) }));
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

  private telemetryInsertStmt(): any {
    return this.db.prepare(`
      INSERT INTO telemetry_metric_points (
        received_at, metric_name, metric_kind, token_type, unit, currency, temporality, series_key,
        session_id, runtime_id, model, service_name, service_version,
        start_time_unix_nano, time_unix_nano, time_ms, value, wire_format
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(series_key, start_time_unix_nano, time_unix_nano) DO NOTHING
    `);
  }

  /**
   * Inserts every point in one transaction (issue #73: "one transaction per request in SQLite"). A point whose
   * key is already stored is read back to tell a harmless retry (same value) from a conflicting duplicate
   * (different value, first value kept): no retry or race path is needed here the way `classifyAndInsert` needs
   * one for `events.id`, because `node:sqlite` is synchronous and this method never awaits mid-transaction.
   */
  async appendTelemetryPoints(points: TelemetryPointInput[]): Promise<TelemetryAppendOutcome> {
    if (points.length === 0) return { accepted: 0, duplicates: 0, conflicts: 0, rejectedCapacity: 0, messages: [] };

    const insertStmt = this.telemetryInsertStmt();
    const selectStmt = this.db.prepare(
      'SELECT value FROM telemetry_metric_points WHERE series_key = ? AND start_time_unix_nano = ? AND time_unix_nano = ?'
    );

    let accepted = 0;
    let duplicates = 0;
    let conflicts = 0;
    const messages: string[] = [];

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const point of points) {
        const result = insertStmt.run(
          point.receivedAt,
          point.metricName,
          point.metricKind,
          point.tokenType,
          point.unit,
          point.currency,
          point.temporality,
          point.seriesKey,
          point.sessionId,
          point.runtimeId,
          point.model,
          point.serviceName,
          point.serviceVersion,
          point.startTimeUnixNano,
          point.timeUnixNano,
          point.timeMs,
          point.value,
          point.wireFormat
        );
        const inserted = Number((result as { changes?: number | bigint }).changes ?? 0) > 0;
        if (inserted) {
          accepted++;
          continue;
        }
        const existing = selectStmt.get(point.seriesKey, point.startTimeUnixNano, point.timeUnixNano) as
          | { value: number }
          | undefined;
        if (existing && existing.value === point.value) {
          duplicates++;
        } else {
          conflicts++;
          messages.push(`${point.metricName}: conflicting duplicate (same point reported twice with different values)`);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Already rolled back.
      }
      throw error;
    }

    // Memory mode's AGENT_VIEWER_TELEMETRY_MAX_POINTS cap does not apply here: SQLite storage is durable and
    // bounded by disk, not by an in-process map (issue #73, section 3).
    return { accepted, duplicates, conflicts, rejectedCapacity: 0, messages };
  }

  async listTelemetryPoints(filter?: TelemetryPointFilter): Promise<TelemetryPointRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter?.sessionId !== undefined) {
      clauses.push('session_id = ?');
      params.push(filter.sessionId);
    }
    if (filter?.runtimeId !== undefined) {
      clauses.push('runtime_id = ?');
      params.push(filter.runtimeId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT series_key, temporality, metric_kind, token_type, currency, session_id, runtime_id,
                start_time_unix_nano, time_unix_nano, time_ms, value
         FROM telemetry_metric_points ${where}`
      )
      .all(...params) as Array<{
      series_key: string;
      temporality: 'delta' | 'cumulative';
      metric_kind: 'tokens' | 'cost';
      token_type: string | null;
      currency: string | null;
      session_id: string | null;
      runtime_id: string | null;
      start_time_unix_nano: string;
      time_unix_nano: string;
      time_ms: number;
      value: number;
    }>;
    return rows.map((row) => ({
      seriesKey: row.series_key,
      temporality: row.temporality,
      metricKind: row.metric_kind,
      tokenType: row.token_type,
      currency: row.currency,
      sessionId: row.session_id,
      runtimeId: row.runtime_id,
      startTimeUnixNano: row.start_time_unix_nano,
      timeUnixNano: row.time_unix_nano,
      timeMs: row.time_ms,
      value: row.value,
    }));
  }

  async telemetryStats(): Promise<TelemetryStats> {
    const stored = this.db.prepare('SELECT COUNT(*) AS count FROM telemetry_metric_points').get() as { count: number };
    const withoutSession = this.db
      .prepare('SELECT COUNT(*) AS count FROM telemetry_metric_points WHERE session_id IS NULL')
      .get() as { count: number };
    return { pointsStored: stored.count, pointsWithoutSession: withoutSession.count, truncated: false };
  }

  /** Generated once and persisted (issue #73), so retries after a restart still deduplicate against series keys
   * computed before it. */
  async getTelemetryHmacSecret(): Promise<Buffer> {
    const row = this.db.prepare('SELECT value FROM telemetry_meta WHERE key = ?').get('series_hmac_secret') as
      | { value: string }
      | undefined;
    if (row) return Buffer.from(row.value, 'hex');

    const secret = crypto.randomBytes(32);
    try {
      this.db
        .prepare('INSERT INTO telemetry_meta (key, value) VALUES (?, ?)')
        .run('series_hmac_secret', secret.toString('hex'));
    } catch {
      // Lost a race with another writer in this same process (defensive only: several processes sharing one
      // SQLite file is not officially supported, same caveat as the events table's own race paths).
      const raced = this.db.prepare('SELECT value FROM telemetry_meta WHERE key = ?').get('series_hmac_secret') as
        | { value: string }
        | undefined;
      if (raced) return Buffer.from(raced.value, 'hex');
      throw new Error('Could not read or write the telemetry series-key secret');
    }
    return secret;
  }

  /**
   * Sets `retention_state.purged_before` for one scope to `max(existing, cutoffMs)`, in its own transaction,
   * *before* the first delete batch of a run that actually has rows to remove (issue #70). This ordering is the
   * whole point: if the process dies partway through the batches that follow, the coverage signal already
   * reflects that data at or before this cutoff may be incomplete, which is the safe direction to be wrong in.
   */
  private setPurgedBefore(scope: 'events' | 'usage_ledger', cutoffMs: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('UPDATE retention_state SET purged_before = MAX(COALESCE(purged_before, 0), ?) WHERE scope = ?')
        .run(cutoffMs, scope);
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Already rolled back.
      }
      throw error;
    }
  }

  /** Deletes up to `batchSize` rows of `events` older than `cutoffMs`, in one transaction, also keeping
   * `eventsCountCache` and `retention_state.deleted_total` correct. Returns rows actually deleted this batch. */
  private deleteEventsBatch(cutoffMs: number, batchSize: number): number {
    let deleted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db
        .prepare(
          'DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE created_at < ? ORDER BY rowid LIMIT ?) RETURNING duplicate_of'
        )
        .all(cutoffMs, batchSize) as Array<{ duplicate_of: string | null }>;
      deleted = rows.length;
      if (deleted > 0) {
        const originals = rows.filter((r) => r.duplicate_of === null).length;
        this.eventsCountCache -= originals;
        this.db.prepare('UPDATE retention_state SET deleted_total = deleted_total + ? WHERE scope = ?').run(deleted, 'events');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Already rolled back.
      }
      throw error;
    }
    return deleted;
  }

  /** Same shape as `deleteEventsBatch`, for `usage_ledger`. The append-only trigger (migration 6) only blocks
   * `UPDATE`; a `DELETE` is exactly how retention is meant to remove a ledger row. */
  private deleteLedgerBatch(cutoffMs: number, batchSize: number): number {
    let deleted = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db
        .prepare('DELETE FROM usage_ledger WHERE rowid IN (SELECT rowid FROM usage_ledger WHERE received_at < ? ORDER BY rowid LIMIT ?)')
        .run(cutoffMs, batchSize);
      deleted = Number((result as { changes?: number | bigint }).changes ?? 0);
      if (deleted > 0) {
        this.db
          .prepare('UPDATE retention_state SET deleted_total = deleted_total + ? WHERE scope = ?')
          .run(deleted, 'usage_ledger');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Already rolled back.
      }
      throw error;
    }
    return deleted;
  }

  /** Runs one table's purge to completion: sets `purged_before` once (only if there is anything to delete), then
   * loops delete batches, yielding to the event loop between them, stopping once a batch comes back short. */
  private async purgeTable(
    scope: 'events' | 'usage_ledger',
    deleteBatch: (cutoffMs: number, batchSize: number) => number,
    existsOlderSql: string,
    cutoffMs: number,
    batchSize: number
  ): Promise<number> {
    const existsOlder = this.db.prepare(existsOlderSql).get(cutoffMs);
    if (!existsOlder) return 0;
    this.setPurgedBefore(scope, cutoffMs);

    let total = 0;
    while (!this.closed) {
      const deleted = deleteBatch(cutoffMs, batchSize);
      total += deleted;
      if (deleted < batchSize) break;
      // Yields the event loop between batches (issue #70), so the SSE heartbeat and a concurrently scheduled
      // timer still fire while a large purge is in progress.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return total;
  }

  /**
   * Deletes events and/or ledger rows older than their cutoffs (issue #70). The two cutoffs are independent and
   * neither table has a foreign key to the other (migration 6, migration 8): purging one never touches the
   * other, by construction, not by a check here. See `server/retention.ts` for the scheduler that calls this.
   */
  async purge(opts: PurgeOptions = {}): Promise<PurgeResult> {
    const batchSize = opts.batchSize && opts.batchSize > 0 ? Math.trunc(opts.batchSize) : DEFAULT_RETENTION_BATCH_SIZE;

    const eventsDeleted =
      opts.eventsCutoffMs !== undefined
        ? await this.purgeTable(
            'events',
            (cutoff, size) => this.deleteEventsBatch(cutoff, size),
            'SELECT 1 FROM events WHERE created_at < ? LIMIT 1',
            opts.eventsCutoffMs,
            batchSize
          )
        : 0;

    const ledgerDeleted =
      opts.ledgerCutoffMs !== undefined
        ? await this.purgeTable(
            'usage_ledger',
            (cutoff, size) => this.deleteLedgerBatch(cutoff, size),
            'SELECT 1 FROM usage_ledger WHERE received_at < ? LIMIT 1',
            opts.ledgerCutoffMs,
            batchSize
          )
        : 0;

    if (eventsDeleted > 0 || ledgerDeleted > 0) {
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // Best effort: a checkpoint failure (for example a long-held read transaction elsewhere) never fails the
        // purge itself. The WAL file shrinks on a later successful checkpoint instead.
      }
    }

    const eventsOldest = this.db.prepare('SELECT MIN(created_at) AS v FROM events').get() as { v: number | null };
    const ledgerOldest = this.db.prepare('SELECT MIN(received_at) AS v FROM usage_ledger').get() as { v: number | null };
    return {
      eventsDeleted,
      ledgerDeleted,
      eventsOldestReceivedAt: eventsOldest.v,
      ledgerOldestReceivedAt: ledgerOldest.v,
    };
  }

  async retentionStatus(limit = 20): Promise<RetentionStatus> {
    const eventsCount = (this.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c;
    const eventsOldest = (this.db.prepare('SELECT MIN(created_at) AS v FROM events').get() as { v: number | null }).v;
    const ledgerCount = (this.db.prepare('SELECT COUNT(*) AS c FROM usage_ledger').get() as { c: number }).c;
    const ledgerOldest = (this.db.prepare('SELECT MIN(received_at) AS v FROM usage_ledger').get() as { v: number | null }).v;

    const stateRows = this.db.prepare('SELECT scope, purged_before, deleted_total FROM retention_state').all() as Array<{
      scope: string;
      purged_before: number | null;
      deleted_total: number;
    }>;
    const stateByScope = new Map(stateRows.map((r) => [r.scope, r]));
    const eventsState = stateByScope.get('events');
    const ledgerState = stateByScope.get('usage_ledger');

    const runRows = this.db.prepare('SELECT * FROM retention_runs ORDER BY id DESC LIMIT ?').all(limit) as any[];
    const runs = runRows.map((r) => this.rowToRetentionRun(r));
    const lastRun = runs[0] ?? null;

    const lastEventsRunRow = this.db
      .prepare(
        'SELECT events_cutoff_ms, events_deleted FROM retention_runs WHERE finished_at IS NOT NULL AND events_window_days IS NOT NULL ORDER BY id DESC LIMIT 1'
      )
      .get() as { events_cutoff_ms: number | null; events_deleted: number } | undefined;
    const lastLedgerRunRow = this.db
      .prepare(
        'SELECT ledger_cutoff_ms, ledger_deleted FROM retention_runs WHERE finished_at IS NOT NULL AND ledger_window_days IS NOT NULL ORDER BY id DESC LIMIT 1'
      )
      .get() as { ledger_cutoff_ms: number | null; ledger_deleted: number } | undefined;

    return {
      events: {
        count: eventsCount,
        oldestReceivedAt: eventsOldest,
        purgedBefore: eventsState?.purged_before ?? null,
        lastCutoffMs: lastEventsRunRow?.events_cutoff_ms ?? null,
        lastDeleted: lastEventsRunRow ? lastEventsRunRow.events_deleted : null,
        deletedTotal: eventsState?.deleted_total ?? 0,
      },
      usageLedger: {
        count: ledgerCount,
        oldestReceivedAt: ledgerOldest,
        purgedBefore: ledgerState?.purged_before ?? null,
        lastCutoffMs: lastLedgerRunRow?.ledger_cutoff_ms ?? null,
        lastDeleted: lastLedgerRunRow ? lastLedgerRunRow.ledger_deleted : null,
        deletedTotal: ledgerState?.deleted_total ?? 0,
      },
      lastRun,
      runs,
    };
  }

  private rowToRetentionRun(r: any): RetentionRunRecord {
    return {
      id: Number(r.id),
      startedAt: Number(r.started_at),
      finishedAt: r.finished_at === null ? null : Number(r.finished_at),
      trigger: r.trigger,
      status: r.status,
      eventsWindowDays: r.events_window_days === null ? null : Number(r.events_window_days),
      eventsCutoffMs: r.events_cutoff_ms === null ? null : Number(r.events_cutoff_ms),
      eventsDeleted: Number(r.events_deleted),
      ledgerWindowDays: r.ledger_window_days === null ? null : Number(r.ledger_window_days),
      ledgerCutoffMs: r.ledger_cutoff_ms === null ? null : Number(r.ledger_cutoff_ms),
      ledgerDeleted: Number(r.ledger_deleted),
      error: r.error,
    };
  }

  async recordRetentionRun(input: { startedAt: number; trigger: RetentionTrigger; skip?: boolean }): Promise<number> {
    const status = input.skip ? 'skipped' : 'running';
    const finishedAt = input.skip ? input.startedAt : null;
    const result = this.db
      .prepare('INSERT INTO retention_runs (started_at, finished_at, trigger, status) VALUES (?, ?, ?, ?)')
      .run(input.startedAt, finishedAt, input.trigger, status);
    return Number(result.lastInsertRowid);
  }

  async finishRetentionRun(id: number, patch: RetentionRunPatch): Promise<void> {
    this.db
      .prepare(
        `UPDATE retention_runs
         SET finished_at = ?, status = ?, events_window_days = ?, events_cutoff_ms = ?, events_deleted = ?,
             ledger_window_days = ?, ledger_cutoff_ms = ?, ledger_deleted = ?, error = ?
         WHERE id = ?`
      )
      .run(
        patch.finishedAt,
        patch.status,
        patch.eventsWindowDays,
        patch.eventsCutoffMs,
        patch.eventsDeleted,
        patch.ledgerWindowDays,
        patch.ledgerCutoffMs,
        patch.ledgerDeleted,
        patch.error,
        id
      );
    // Self-pruning (issue #70): retention_runs keeps at most the latest 500 rows. Lifetime counts and
    // `purged_before` live in `retention_state`, which this never touches, so pruning here loses no coverage
    // signal, only old run history.
    this.db
      .prepare(`DELETE FROM retention_runs WHERE id NOT IN (SELECT id FROM retention_runs ORDER BY id DESC LIMIT ${RETENTION_RUNS_MAX})`)
      .run();
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

/** Parses `AGENT_VIEWER_TELEMETRY_MAX_POINTS` (issue #73). Unset, empty or invalid falls back to the default:
 * unlike `AGENT_VIEWER_MAX_EVENTS`, a typo here should not stop the whole server from starting. */
export function parseTelemetryMaxPoints(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_TELEMETRY_MAX_POINTS;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_TELEMETRY_MAX_POINTS;
}

/** Parses `AGENT_VIEWER_USAGE_LEDGER_MAX_ROWS` (issue #65). Same leniency as `parseTelemetryMaxPoints`: unset,
 * empty or invalid falls back to the default instead of stopping the server. */
export function parseUsageLedgerMaxRows(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_USAGE_LEDGER_MAX_ROWS;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_USAGE_LEDGER_MAX_ROWS;
}

export function createEventStore(): EventStore {
  const storageType = (process.env.AGENT_VIEWER_STORAGE || 'memory').toLowerCase();
  const rawMaxEvents = process.env.AGENT_VIEWER_MAX_EVENTS;
  const maxEvents = parseMaxEvents(rawMaxEvents);
  const maxEventsWasSet = rawMaxEvents !== undefined && rawMaxEvents.trim() !== '';
  const telemetryMaxPoints = parseTelemetryMaxPoints(process.env.AGENT_VIEWER_TELEMETRY_MAX_POINTS);
  const usageLedgerMaxRows = parseUsageLedgerMaxRows(process.env.AGENT_VIEWER_USAGE_LEDGER_MAX_ROWS);

  if (storageType === 'sqlite') {
    // Since issue #52, SQLite mode has no capped in-memory window to limit: every event is persisted and the
    // startup rebuild replays the whole table. AGENT_VIEWER_MAX_EVENTS only applies to the memory store.
    // AGENT_VIEWER_TELEMETRY_MAX_POINTS and AGENT_VIEWER_USAGE_LEDGER_MAX_ROWS have the same scope restriction,
    // for the same reason (issues #73 and #65): the database keeps every row and every ledger entry.
    if (maxEventsWasSet) {
      console.log(`[agent-viewer] AGENT_VIEWER_MAX_EVENTS has no effect in SQLite mode; every event is stored and never capped.`);
    }
    const dbPath = process.env.AGENT_VIEWER_SQLITE_PATH || './data/agent-viewer.db';
    const backup = sqliteBackupMode(process.env.AGENT_VIEWER_SQLITE_BACKUP);
    return new SQLiteEventStore(dbPath, { backup });
  }
  return new MemoryEventStore({ maxEvents, telemetryMaxPoints, usageLedgerMaxRows });
}
