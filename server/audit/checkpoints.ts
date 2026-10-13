import type { DatabaseSync } from 'node:sqlite';
import { canonicalize } from '../chain';
import {
  CHECKPOINT_FORMAT_VERSION,
  signCheckpoint,
  type CheckpointBody,
  type CheckpointReason,
  type SignedCheckpoint,
} from './checkpointFormat';
import type { LoadedSigningKey } from './signingKey';

/**
 * Signed checkpoint writer and scheduler (issue #387). Owns no connection of its own: it uses the store's writer
 * handle (`EventStore.getDatabaseHandle()`), and every write is one synchronous `BEGIN IMMEDIATE` transaction, the
 * same pattern as `SQLiteEventStore.append`, so it can never interleave with an append in this process and is
 * serialized with any other process writing the same file.
 *
 * A checkpoint is only ever written when the chain head has advanced past the latest checkpoint's `headSeq`; a
 * head *behind* the latest checkpoint (rows deleted from the tail) is refused and logged, never signed, so a
 * truncation can never be laundered into a fresh, valid-looking checkpoint.
 */

export const DEFAULT_CHECKPOINT_EVERY_EVENTS = 1000;
export const DEFAULT_CHECKPOINT_INTERVAL_MS = 3_600_000;

const POSITIVE_INT = /^[1-9][0-9]*$/;

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!POSITIVE_INT.test(trimmed) || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

export interface CheckpointScheduleConfig {
  everyEvents: number;
  intervalMs: number;
}

/** Strict like `AGENT_VIEWER_MAX_EVENTS`: a typo stops startup rather than silently changing the audit cadence. */
export function parseCheckpointScheduleConfig(env: NodeJS.ProcessEnv): CheckpointScheduleConfig {
  const intervalMs = parsePositiveInt('AGENT_VIEWER_CHECKPOINT_INTERVAL_MS', env.AGENT_VIEWER_CHECKPOINT_INTERVAL_MS, DEFAULT_CHECKPOINT_INTERVAL_MS);
  if (intervalMs > 2_147_483_647) throw new Error('AGENT_VIEWER_CHECKPOINT_INTERVAL_MS must be at most 2147483647');
  return {
    everyEvents: parsePositiveInt('AGENT_VIEWER_CHECKPOINT_EVERY_EVENTS', env.AGENT_VIEWER_CHECKPOINT_EVERY_EVENTS, DEFAULT_CHECKPOINT_EVERY_EVENTS),
    intervalMs,
  };
}

export interface AuditKeyInfo {
  keyId: string;
  algorithm: 'ed25519';
  publicKeyPem: string;
  source: string;
  createdAt: number;
  retiredAt: number | null;
  active: boolean;
}

export interface CreateCheckpointResult {
  created: boolean;
  /** The new checkpoint when `created`, otherwise the latest existing one (or `null` when there is none). */
  checkpoint: SignedCheckpoint | null;
  /** Why nothing was written, when `created` is `false`. */
  skipped?: 'chain_empty' | 'head_unchanged' | 'head_behind_checkpoint' | 'key_not_active';
}

interface CheckpointRow {
  seq: number;
  head_seq: number;
  chained_count: number;
  digest: string;
  body_json: string;
  signature: string;
}

function rowToSigned(row: CheckpointRow): SignedCheckpoint {
  return { body: JSON.parse(row.body_json) as CheckpointBody, digest: row.digest, signature: row.signature };
}

/** `true` when `db` has every table this service reads (migrations 17, 18 and 20). */
export function auditCheckpointsSupported(db: DatabaseSync): boolean {
  const names = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('audit_checkpoints', 'audit_keys', 'audit_meta', 'chain_checkpoints')").all() as Array<{ name: string }>).map(
      (row) => row.name
    )
  );
  return names.size === 4;
}

export interface AuditCheckpointServiceOptions {
  db: DatabaseSync;
  key: LoadedSigningKey;
  schedule: CheckpointScheduleConfig;
  now?: () => number;
  log?: (message: string) => void;
}

export class AuditCheckpointService {
  private readonly db: DatabaseSync;
  readonly key: LoadedSigningKey;
  readonly schedule: CheckpointScheduleConfig;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | null = null;
  private eventsSinceCheckpoint = 0;
  private stopped = false;

  constructor(options: AuditCheckpointServiceOptions) {
    this.db = options.db;
    this.key = options.key;
    this.schedule = options.schedule;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.warn(`[agent-viewer] ${message}`));
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      throw error;
    }
  }

  private instanceId(): string {
    const row = this.db.prepare("SELECT value FROM audit_meta WHERE key = 'instance_id'").get() as { value: string } | undefined;
    if (!row) throw new Error('audit_meta.instance_id is missing');
    return row.value;
  }

  private chainHead(): { seq: number; hash: string } | null {
    const row = this.db.prepare('SELECT seq, hash FROM events WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1').get() as
      | { seq: number; hash: string }
      | undefined;
    return row ? { seq: Number(row.seq), hash: row.hash } : null;
  }

  private latestRow(): CheckpointRow | undefined {
    return this.db
      .prepare('SELECT seq, head_seq, chained_count, digest, body_json, signature FROM audit_checkpoints ORDER BY seq DESC LIMIT 1')
      .get() as CheckpointRow | undefined;
  }

  private activeKeyId(): string | null {
    const row = this.db.prepare('SELECT key_id FROM audit_keys WHERE retired_at IS NULL').get() as { key_id: string } | undefined;
    return row?.key_id ?? null;
  }

  /**
   * Startup: makes the loaded key the single active `audit_keys` row. A different key than the active one retires
   * it (`retired_at`) and inserts the new one in the same transaction, then signs an immediate `key_change`
   * checkpoint if the head advanced past the latest checkpoint. Also seeds the event-count trigger from the rows
   * chained since the latest checkpoint, so a restart never resets the cadence.
   */
  start(): { keyChanged: boolean; retiredKeyId: string | null; checkpoint: CreateCheckpointResult | null } {
    for (const warning of this.key.warnings) this.log(warning);
    const now = this.now();
    const { keyChanged, retiredKeyId } = this.transaction(() => {
      const active = this.activeKeyId();
      if (active === this.key.keyId) return { keyChanged: false, retiredKeyId: null };
      if (active !== null) this.db.prepare('UPDATE audit_keys SET retired_at = ? WHERE retired_at IS NULL').run(now);
      this.db
        .prepare('INSERT INTO audit_keys (key_id, algorithm, public_key_pem, source, created_at, retired_at) VALUES (?, ?, ?, ?, ?, NULL)')
        .run(this.key.keyId, 'ed25519', this.key.publicKeyPem, this.key.source, now);
      return { keyChanged: active !== null, retiredKeyId: active };
    });
    if (keyChanged) this.log(`audit signing key changed: ${retiredKeyId} retired, ${this.key.keyId} active.`);

    const checkpoint = keyChanged ? this.createCheckpoint('key_change') : null;
    const latest = this.latestRow();
    this.eventsSinceCheckpoint = Number(
      (this.db.prepare('SELECT COUNT(*) AS c FROM events WHERE hash IS NOT NULL AND seq > ?').get(latest ? Number(latest.head_seq) : 0) as { c: number }).c
    );

    this.stopped = false;
    this.timer = setInterval(() => {
      this.runSafely('interval');
    }, this.schedule.intervalMs);
    this.timer.unref();
    return { keyChanged, retiredKeyId, checkpoint };
  }

  /** Signs a checkpoint over the current chain head, unless the head has not advanced (see the class doc). */
  createCheckpoint(reason: CheckpointReason): CreateCheckpointResult {
    const head = this.chainHead();
    return this.createCheckpointAt(head ? head.seq : null, reason);
  }

  /**
   * Signs a checkpoint pinned to `targetSeq` rather than the live chain head (issue #400: the audit bundle
   * exporter needs to anchor its tail to the `toSeq` of a requested range, which may be behind the live head at
   * export time). `targetSeq === null` behaves like an empty chain. `createCheckpoint` is the common case of this
   * (`targetSeq` is always the live head), kept as its own method so most callers never need to think about
   * pinning. A `targetSeq` that is not itself a chained row (no `hash`), or that falls behind the latest existing
   * checkpoint's `headSeq`, is refused exactly like a stale live head would be: this can never be used to sign a
   * checkpoint "backwards" past one that already exists.
   */
  createCheckpointAt(targetSeq: number | null, reason: CheckpointReason): CreateCheckpointResult {
    const result = this.transaction((): CreateCheckpointResult => {
      const latest = this.latestRow();
      const latestSigned = latest ? rowToSigned(latest) : null;
      if (this.activeKeyId() !== this.key.keyId) {
        return { created: false, checkpoint: latestSigned, skipped: 'key_not_active' };
      }
      if (targetSeq === null) return { created: false, checkpoint: latestSigned, skipped: 'chain_empty' };
      const targetRow = this.db.prepare('SELECT seq, hash FROM events WHERE seq = ? AND hash IS NOT NULL').get(targetSeq) as
        | { seq: number; hash: string }
        | undefined;
      if (!targetRow) return { created: false, checkpoint: latestSigned, skipped: 'chain_empty' };
      const head = { seq: Number(targetRow.seq), hash: targetRow.hash };
      if (latest && head.seq === Number(latest.head_seq)) return { created: false, checkpoint: latestSigned, skipped: 'head_unchanged' };
      if (latest && head.seq < Number(latest.head_seq)) return { created: false, checkpoint: latestSigned, skipped: 'head_behind_checkpoint' };

      const addedSinceLatest = Number(
        (this.db
          .prepare('SELECT COUNT(*) AS c FROM events WHERE hash IS NOT NULL AND seq > ? AND seq <= ?')
          .get(latest ? Number(latest.head_seq) : 0, head.seq) as { c: number }).c
      );
      const body: CheckpointBody = {
        version: CHECKPOINT_FORMAT_VERSION,
        instanceId: this.instanceId(),
        checkpointSeq: latest ? Number(latest.seq) + 1 : 1,
        headSeq: head.seq,
        headHash: head.hash,
        chainedCount: (latest ? Number(latest.chained_count) : 0) + addedSinceLatest,
        createdAt: this.now(),
        reason,
        keyId: this.key.keyId,
        prevCheckpointDigest: latest ? latest.digest : null,
      };
      const signed = signCheckpoint(body, this.key.privateKey);
      this.db
        .prepare(
          `INSERT INTO audit_checkpoints (seq, created_at, reason, head_seq, head_hash, chained_count, key_id, prev_digest, digest, body_json, signature)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          body.checkpointSeq, body.createdAt, body.reason, body.headSeq, body.headHash, body.chainedCount, body.keyId,
          body.prevCheckpointDigest, signed.digest, canonicalize(body), signed.signature
        );
      return { created: true, checkpoint: signed };
    });
    if (result.created) this.eventsSinceCheckpoint = 0;
    if (result.skipped === 'head_behind_checkpoint') {
      this.log('audit checkpoint refused: the chain head is behind the latest signed checkpoint (rows were removed from the tail).');
    } else if (result.skipped === 'key_not_active') {
      this.log('audit checkpoint refused: this server\'s signing key is no longer the active key in audit_keys.');
    }
    return result;
  }

  private runSafely(reason: CheckpointReason): void {
    if (this.stopped) return;
    try {
      this.createCheckpoint(reason);
    } catch (error) {
      this.log(`audit checkpoint (${reason}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Called once per newly chained event; signs an `events` checkpoint every `schedule.everyEvents` of them. */
  noteChainedEvents(count = 1): void {
    if (this.stopped) return;
    this.eventsSinceCheckpoint += count;
    if (this.eventsSinceCheckpoint >= this.schedule.everyEvents) {
      this.eventsSinceCheckpoint = 0;
      this.runSafely('events');
    }
  }

  /** Graceful shutdown: stops the timer, then signs a final `shutdown` checkpoint if the head advanced. Must run
   * before the store closes its handle. Safe to call more than once. */
  shutdown(): void {
    if (this.stopped) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.runSafely('shutdown');
    this.stopped = true;
  }

  latest(): SignedCheckpoint | null {
    const row = this.latestRow();
    return row ? rowToSigned(row) : null;
  }

  /** Ascending by `checkpointSeq`, keyset-paginated on `afterSeq`. */
  list(afterSeq: number, limit: number): SignedCheckpoint[] {
    const rows = this.db
      .prepare('SELECT seq, head_seq, chained_count, digest, body_json, signature FROM audit_checkpoints WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(afterSeq, limit) as unknown as CheckpointRow[];
    return rows.map(rowToSigned);
  }

  keys(): AuditKeyInfo[] {
    const rows = this.db
      .prepare('SELECT key_id, public_key_pem, source, created_at, retired_at FROM audit_keys ORDER BY id')
      .all() as Array<{ key_id: string; public_key_pem: string; source: string; created_at: number; retired_at: number | null }>;
    return rows.map((row) => ({
      keyId: row.key_id,
      algorithm: 'ed25519',
      publicKeyPem: row.public_key_pem,
      source: row.source,
      createdAt: Number(row.created_at),
      retiredAt: row.retired_at === null ? null : Number(row.retired_at),
      active: row.retired_at === null,
    }));
  }
}
