import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { eventHash } from '../chain';
import { verifySignedCheckpoints } from './verifyCheckpoints';
import {
  checkpointDigest,
  keyIdFor,
  parseCheckpointBody,
  verifyCheckpointSignature,
  type CheckpointBody,
  type SignedCheckpoint,
} from './checkpointFormat';

/**
 * Chain-walk verifier for the hash chain issue #105 adds over SQLite-stored events (first sub-issue of #106,
 * "formal audit" theme). A pure module: no Express, no CLI, no dependency on `EventStore`. It takes a SQLite
 * file path and opens its own read-only connection, separate from any writer connection the caller might hold
 * (so a long verification run never blocks ingestion by sharing a transaction with it). Used by
 * `GET /api/v1/audit/verify` (`server/index.ts`) and will be reused unchanged by `agent-viewer verify --db`
 * (issue #388) and by #387's checkpoint verification, which extends `VerifyReport.checkpoints`.
 *
 * Scope of this slice: chain-break detection only (`hash_mismatch`, `link_mismatch`, `unparseable_event`,
 * `column_mismatch`, `missing_hash`, `tombstone_invalid`). Without a signed checkpoint (#387,
 * `./verifyCheckpoints.ts`) a
 * *consistent* rewrite (an attacker who edits a row and recomputes every later hash correctly) is undetectable by
 * design, and the `no_checkpoints` warning says so; with one, a rewrite of any covered row is a `head_mismatch`. `seq_gap` is deliberately never produced by this slice: deleting a chained
 * row is reported as `link_mismatch` instead (the next remaining row's `prev_hash` no longer matches anything
 * this walk computed), which issue #106's own acceptance criteria accepts ("yields seq_gap (or link_mismatch)").
 * The type stays in `BreakKind` for shape stability across sub-issues.
 *
 * Issue #408: issue #109's tombstone (`POST /api/v1/audit/retention/purge`, `/redact`) rewrites a row's
 * `event_json` (content replaced, `tombstone` object added) while deliberately keeping `seq`, `hash`, `prev_hash`
 * and every header column byte-identical, so a tombstoned row's own stored `hash` never recomputes from its
 * current content again, on purpose. This walk is tombstone-aware: a row flagged `tombstoned_at IS NOT NULL`
 * skips the content-hash recompute (its link to the previous row is still checked normally, since links are
 * never touched by a tombstone) and is instead cross-checked against the chained
 * `audit.retention.purged`/`audit.redaction.applied` event its `tombstone_audit_seq` names, which must exist, be
 * of the right type, and have committed exactly this row's original `hash`/`content_hash`. A missing, wrong-type
 * or mismatched pointer is reported as `tombstone_invalid` rather than a silent pass. Mirrors
 * `scripts/verify-audit-bundle.mjs`'s `REDACTION` check and `tests/audit-retention.test.mjs`'s own
 * `tombstoneAwareWalk` helper, written for exactly this purpose.
 */

let _DatabaseSync: any = null;
function getDatabaseSync(): any {
  if (!_DatabaseSync) {
    const req = createRequire(import.meta.url);
    _DatabaseSync = req('node:sqlite').DatabaseSync;
  }
  return _DatabaseSync;
}

export type BreakKind =
  | 'hash_mismatch' // recomputed entry hash differs from the stored one: row content was edited
  | 'link_mismatch' // prev_hash differs from the previous chained row's hash: row inserted, removed or reordered
  | 'seq_gap' // reserved for a future, checkpoint-aware slice; never produced by this one (see module doc comment)
  | 'missing_hash' // a row past every known checkpoint's coverage has no hash
  | 'unparseable_event' // event_json is not valid JSON
  | 'column_mismatch' // an indexed column disagrees with the parsed event_json
  | 'tombstone_invalid'; // issue #408: a tombstoned row's `tombstone_audit_seq` does not point to a real,
  // matching `audit.retention.purged`/`audit.redaction.applied` event (forged or missing tombstone)

export interface ChainBreak {
  kind: BreakKind;
  seq: number;
  eventId: string | null;
  expectedHash?: string;
  storedHash?: string;
  /** Set only for `column_mismatch`. Never the value, only the name (issue #106: "the message names the
   * column, never its value"). */
  column?: string;
  message: string;
}

/** Signed checkpoint failures (issue #387), produced by `verifySignedCheckpoints` (`./verifyCheckpoints.ts`). */
export type CheckpointFailureKind =
  | 'signature_invalid'
  | 'key_unknown'
  | 'instance_mismatch'
  | 'head_mismatch'
  | 'count_mismatch'
  | 'seq_beyond_head'
  | 'checkpoint_link_broken'
  | 'checkpoint_missing';

export interface CheckpointFailure {
  kind: CheckpointFailureKind;
  checkpoint: number;
  seq: number;
  message: string;
}

export interface CheckpointResult {
  checked: number;
  valid: number;
  firstFailure: CheckpointFailure | null;
}

export type WarningCode =
  | 'no_checkpoints' // no signed checkpoint exists, so a consistent rewrite would NOT be detected
  | 'legacy_rows' // unchained rows exist and are counted, not individually verified, by this walk
  | 'partial_scope' // reserved for #387's scope=recent; never produced by this slice (always falls back to full)
  | 'no_yield_in_memory_db' // the path is :memory:, verification ran without a yield between pages
  | 'empty_chain'; // the database has no events at all

export interface VerifyWarning {
  code: WarningCode;
  message: string;
}

export interface VerifyReport {
  ok: boolean;
  storage: 'sqlite';
  instanceId: string;
  verifiedAt: number;
  durationMs: number;
  coverage: { fromSeq: number; toSeq: number; scope: 'full' | 'recent' };
  chain: {
    checked: number;
    headSeq: number | null;
    headHash: string | null;
    chainStartSeq: number | null;
    unchained: number;
  };
  firstBreak: ChainBreak | null;
  /** Signed checkpoint verification (issue #387); all zero when no checkpoint exists. */
  checkpoints: CheckpointResult;
  /** Filled only by the CLI (#388) after cross-checking an exported file; never set by `GET /audit/verify`. */
  exported: CheckpointResult | null;
  /** `'server-reported'` unless the caller pinned a public key (`VerifyOptions.trustedKeyPem`, issue #388's
   * `agent-viewer verify --public-key`), in which case it is always `'pinned'`, independent of the outcome. */
  keyTrust: 'server-reported' | 'pinned';
  warnings: VerifyWarning[];
}

export interface VerifyOptions {
  /** Path to the SQLite database file, exactly as `EventStore.getDatabasePath()` returns it. */
  dbPath: string;
  /** Requested scope. This slice has no checkpoints to anchor "recent" to, so it always walks and reports
   * `full` regardless of what is requested; the parameter is accepted now so the HTTP route and the CLI (#388)
   * do not need to change their own signature once #387 makes `recent` real. */
  scope?: 'full' | 'recent';
  /** Rows read per page. Default 5000 (issue #106). Exposed for tests. */
  pageSize?: number;
  /** Injected clock, for deterministic tests. */
  now?: () => number;
  /** Awaited between pages (after one `setImmediate`), for tests to observe yielding without a real sleep. */
  afterPage?: () => Promise<void> | void;
  /** PKCS#8/SPKI PEM of a public key to pin (issue #388, `agent-viewer verify --public-key`): when given, only
   * this key is trusted for checkpoint signatures, and `VerifyReport.keyTrust` is `'pinned'` regardless of the
   * outcome. See `verifySignedCheckpoints`'s own doc comment for what "only this key" means for a key rotation
   * the pinned copy does not know about. */
  trustedKeyPem?: string;
}

interface RawRow {
  seq: number;
  id: string;
  event_json: string | null;
  created_at: number;
  submitter_id: string | null;
  prev_hash: string | null;
  hash: string | null;
  type: string;
  timestamp: number;
  runtime_id: string | null;
  session_id: string | null;
  agent_id: string | null;
  task_id: string | null;
  severity: string;
  summary: string;
  content_hash: string | null;
  /** Issue #408/#109: `NULL` unless migration 21 has run and this row was tombstoned. */
  tombstoned_at: number | null;
  tombstone_audit_seq: number | null;
}

const ROW_COLUMNS =
  'seq, id, event_json, created_at, submitter_id, prev_hash, hash, type, timestamp, runtime_id, session_id, agent_id, task_id, severity, summary, content_hash';

/** Mirrors `SQLiteEventStore.prepareInsert`'s column mapping exactly (`server/store.ts`): what a column must
 * equal for a given parsed event, so tampering with a column directly (never touching `event_json`) is caught
 * even though the chain hash itself only covers `event_json`. */
function expectedColumns(event: any): Record<string, string | number | null> {
  return {
    type: event?.type ?? null,
    timestamp: event?.timestamp ?? null,
    runtime_id: event?.runtimeId ?? null,
    session_id: event?.sessionId ?? null,
    agent_id: event?.agentId ?? null,
    task_id: event?.taskId ?? null,
    severity: event?.severity ?? null,
    summary: event?.summary ?? null,
  };
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Walks the chain in a single read-only pass (ascending `seq`, chained rows only) and reports the first break.
 * Never throws for a tampered database: a broken chain is a successful report (`ok: false`), not an error. It
 * can still throw for a genuine I/O problem (file missing, cannot open read-only), which the caller (the HTTP
 * route, the CLI) turns into its own error response/exit code.
 */
export async function verifyChain(options: VerifyOptions): Promise<VerifyReport> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const pageSize = options.pageSize && options.pageSize > 0 ? options.pageSize : 5000;
  const isMemoryPath = options.dbPath === ':memory:';

  const DBSync = getDatabaseSync();
  const db = new DBSync(options.dbPath, isMemoryPath ? {} : { readOnly: true });
  try {
    const warnings: VerifyWarning[] = [];
    if (isMemoryPath) {
      warnings.push({ code: 'no_yield_in_memory_db', message: 'Database path is :memory:; verification ran on a single connection with no yield between pages.' });
    }

    // `audit_meta` exists only once migration 18 has run; a database deliberately opened against a truncated
    // migrations list (some tests do this) or one that predates this item entirely simply reports no instance id.
    const hasMetaTable = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_meta'").get() as
      | { name: string }
      | undefined) !== undefined;
    const instanceRow = hasMetaTable
      ? (db.prepare("SELECT value FROM audit_meta WHERE key = 'instance_id'").get() as { value: string } | undefined)
      : undefined;
    const instanceId = instanceRow?.value ?? '';

    const totalsRow = db.prepare('SELECT COUNT(*) AS total, COALESCE(MAX(seq), 0) AS maxSeq FROM events').get() as {
      total: number;
      maxSeq: number;
    };
    const toSeq = Number(totalsRow.maxSeq);

    if (Number(totalsRow.total) === 0) {
      warnings.push({ code: 'empty_chain', message: 'The database has no events.' });
      // Issue #387: an empty table with signed checkpoints on record means every covered row was removed.
      const emptyCheckpoints = verifySignedCheckpoints(db, instanceId, null, options.trustedKeyPem);
      return {
        ok: emptyCheckpoints.firstFailure === null,
        storage: 'sqlite',
        instanceId,
        verifiedAt: startedAt,
        durationMs: now() - startedAt,
        coverage: { fromSeq: 0, toSeq: 0, scope: 'full' },
        chain: { checked: 0, headSeq: null, headHash: null, chainStartSeq: null, unchained: 0 },
        firstBreak: null,
        checkpoints: emptyCheckpoints,
        exported: null,
        keyTrust: options.trustedKeyPem !== undefined ? 'pinned' : 'server-reported',
        warnings,
      };
    }

    // `hash`/`prev_hash`/`submitter_id` on `events`, and `chain_checkpoints` itself, exist only once migration
    // 17 has run; a database deliberately opened against a truncated migrations list (some tests do this) or
    // one that predates issue #105 entirely has neither, and is reported as fully unchained, never queried for
    // a column it does not have.
    const hasCheckpointsTable = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chain_checkpoints'").get() as
      | { name: string }
      | undefined) !== undefined;

    // Issue #408/#109: `tombstoned_at`/`tombstone_audit_seq` exist only once migration 21 has run (same migration
    // that adds `legal_holds`, checked the same way `store.ts`'s own `tombstonesEnabled` is). A database between
    // migrations 17 and 20 has the chain but no tombstone columns, so every row there is correctly selected as
    // never tombstoned (`NULL AS ...` below) rather than the query failing on a column that does not exist yet.
    const hasTombstoneColumns = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legal_holds'").get() as
      | { name: string }
      | undefined) !== undefined;
    const tombstoneColumnsSql = hasTombstoneColumns ? 'tombstoned_at, tombstone_audit_seq' : 'NULL AS tombstoned_at, NULL AS tombstone_audit_seq';

    const chainStartSeq: number | null = hasCheckpointsTable
      ? (() => {
          const row = db.prepare('SELECT MIN(seq) AS s FROM events WHERE hash IS NOT NULL').get() as { s: number | null };
          return row.s === null ? null : Number(row.s);
        })()
      : null;

    const unchainedCount = hasCheckpointsTable
      ? Number((db.prepare('SELECT COUNT(*) AS c FROM events WHERE hash IS NULL').get() as { c: number }).c)
      : Number(totalsRow.total);
    if (unchainedCount > 0) {
      warnings.push({ code: 'legacy_rows', message: `${unchainedCount} unchained row(s) are counted but not individually verified by this walk.` });
    }

    const headRow = chainStartSeq === null
      ? undefined
      : (db.prepare('SELECT seq, hash FROM events WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1').get() as
          | { seq: number; hash: string }
          | undefined);
    const headSeq = headRow ? Number(headRow.seq) : null;
    const headHash = headRow ? headRow.hash : null;

    // Issue #106: a row past every checkpoint's known coverage with no hash is suspicious (every legitimate
    // unchained row is accounted for by the genesis checkpoint or a `resume` checkpoint, see
    // `ensureChainResumeCheckpoint` in `server/store.ts`); one that is not is reported as `missing_hash`.
    let missingHashBreak: ChainBreak | null = null;
    if (hasCheckpointsTable) {
      const maxCheckpointSeqRow = db.prepare('SELECT COALESCE(MAX(last_seq), 0) AS s FROM chain_checkpoints').get() as { s: number };
      const maxCheckpointSeq = Number(maxCheckpointSeqRow.s);
      const orphan = db
        .prepare('SELECT seq, id FROM events WHERE hash IS NULL AND seq > ? ORDER BY seq LIMIT 1')
        .get(maxCheckpointSeq) as { seq: number; id: string } | undefined;
      if (orphan) {
        missingHashBreak = {
          kind: 'missing_hash',
          seq: Number(orphan.seq),
          eventId: orphan.id,
          message: `Row at seq ${orphan.seq} has no chain hash and is not covered by any recorded checkpoint.`,
        };
      }
    }

    let firstBreak: ChainBreak | null = null;
    let checked = 0;
    if (chainStartSeq !== null) {
      const page = db.prepare(`SELECT ${ROW_COLUMNS}, ${tombstoneColumnsSql} FROM events WHERE hash IS NOT NULL AND seq > ? ORDER BY seq LIMIT ?`);
      // Issue #408: a tombstoned row's committing audit event always has a *higher* seq than the tombstoned row
      // itself (it is appended fresh in the same transaction that rewrites the row), so by the time this ascending
      // walk reaches a tombstoned row, its audit event has not been read yet. A direct point lookup by seq (the
      // primary key) is simpler and cheaper than a two-pass walk or buffering every audit event seen so far.
      const auditEventLookup = db.prepare('SELECT type, event_json FROM events WHERE seq = ?');
      let cursor = chainStartSeq - 1;
      // Issue #105: the first chained row's `prev_hash` is the genesis checkpoint's own hash (there is exactly
      // one, by the unique index on `chain_checkpoints(kind) WHERE kind = 'genesis'`), never `null`, so this
      // closes the one gap a naive "skip the link check on the first row" approach would leave: tampering with
      // the first chained row's `prev_hash` (and recomputing its own `hash` to match) is still caught here.
      const genesisHashRow = hasCheckpointsTable
        ? (db.prepare("SELECT hash FROM chain_checkpoints WHERE kind = 'genesis' LIMIT 1").get() as { hash: string } | undefined)
        : undefined;
      let expectedPrevHash: string | null = genesisHashRow?.hash ?? null;

      pageLoop: while (true) {
        const rows = page.all(cursor, pageSize) as RawRow[];
        if (rows.length === 0) break;
        for (const row of rows) {
          cursor = Number(row.seq);
          // Stop at the earlier of (a) a break found in this walk, or (b) the pre-existing missing_hash break
          // past this seq: there is no point reporting a chain break *after* an orphaned-hash row, since that
          // row already proves the chain's bookkeeping was tampered with at an earlier point.
          if (missingHashBreak && cursor >= missingHashBreak.seq) {
            firstBreak = missingHashBreak;
            break pageLoop;
          }
          checked++;

          if (row.prev_hash !== expectedPrevHash) {
            firstBreak = {
              kind: 'link_mismatch',
              seq: Number(row.seq),
              eventId: row.id,
              expectedHash: expectedPrevHash ?? undefined,
              storedHash: row.prev_hash ?? undefined,
              message: `prev_hash at seq ${row.seq} does not match the previous chained row's hash.`,
            };
            break pageLoop;
          }

          let parsedEvent: any;
          try {
            parsedEvent = row.event_json === null ? null : JSON.parse(row.event_json);
            if (parsedEvent === null) throw new Error('event_json is NULL on a chained row');
          } catch {
            firstBreak = {
              kind: 'unparseable_event',
              seq: Number(row.seq),
              eventId: row.id,
              message: `event_json at seq ${row.seq} is not valid JSON.`,
            };
            break pageLoop;
          }

          if (row.tombstoned_at === null) {
            const recomputed = eventHash({
              seq: Number(row.seq),
              prevHash: row.prev_hash ?? '',
              receivedAt: Number(row.created_at),
              submitterId: row.submitter_id ?? '',
              event: parsedEvent,
            });
            if (recomputed !== row.hash) {
              firstBreak = {
                kind: 'hash_mismatch',
                seq: Number(row.seq),
                eventId: row.id,
                expectedHash: recomputed,
                storedHash: row.hash ?? undefined,
                message: `The stored hash does not match the event content at seq ${row.seq}.`,
              };
              break pageLoop;
            }
          } else {
            // Issue #408: a legitimately tombstoned row's `event_json` was rewritten by design (issue #109), so
            // it never recomputes to its own stored `hash` again; that is not tampering. Instead, cross-check the
            // tombstone against the chained audit event `tombstone_audit_seq` names: it must exist, be of the
            // right type, and have committed exactly this row's original `hash`/`content_hash` (mirrors
            // `verify-audit-bundle.mjs`'s `REDACTION` check and `tombstoneAwareWalk` in
            // `tests/audit-retention.test.mjs`). A missing, wrong-type or mismatched pointer means the tombstone
            // itself cannot be trusted, so it is reported as a break rather than silently passed.
            const auditRow = row.tombstone_audit_seq === null
              ? undefined
              : (auditEventLookup.get(row.tombstone_audit_seq) as { type: string; event_json: string | null } | undefined);
            let committed: { id?: unknown; hash?: unknown; contentHash?: unknown } | undefined;
            if (auditRow && (auditRow.type === 'audit.retention.purged' || auditRow.type === 'audit.redaction.applied')) {
              try {
                const auditEvent = auditRow.event_json === null ? null : JSON.parse(auditRow.event_json);
                const events = auditEvent?.payload?.events;
                if (Array.isArray(events)) committed = events.find((entry: any) => entry && entry.id === row.id);
              } catch {
                committed = undefined;
              }
            }
            if (!committed || committed.hash !== row.hash || committed.contentHash !== row.content_hash) {
              firstBreak = {
                kind: 'tombstone_invalid',
                seq: Number(row.seq),
                eventId: row.id,
                message: `The tombstone at seq ${row.seq} is not committed by a matching audit event.`,
              };
              break pageLoop;
            }
          }

          const expected = expectedColumns(parsedEvent);
          const actual: Record<string, string | number | null> = {
            type: row.type,
            timestamp: Number(row.timestamp),
            runtime_id: row.runtime_id,
            session_id: row.session_id,
            agent_id: row.agent_id,
            task_id: row.task_id,
            severity: row.severity,
            summary: row.summary,
          };
          const mismatchedColumn = Object.keys(expected).find((key) => expected[key] !== actual[key]);
          if (mismatchedColumn) {
            firstBreak = {
              kind: 'column_mismatch',
              seq: Number(row.seq),
              eventId: row.id,
              column: mismatchedColumn,
              message: `Column "${mismatchedColumn}" at seq ${row.seq} does not match the stored event content.`,
            };
            break pageLoop;
          }

          expectedPrevHash = row.hash;
        }
        if (!isMemoryPath) {
          await yieldToEventLoop();
          await options.afterPage?.();
        }
      }

      // The walk never reached the orphaned row (it is past the current head, or past where the walk stopped
      // for an unrelated reason): still surface it, since "first break" means lowest seq, not "first found".
      if (!firstBreak && missingHashBreak) firstBreak = missingHashBreak;
    } else if (missingHashBreak) {
      firstBreak = missingHashBreak;
    }

    // Issue #387: signed checkpoints, verified against the same read-only snapshot of the chain.
    const checkpoints = verifySignedCheckpoints(db, instanceId, headSeq, options.trustedKeyPem);
    if (checkpoints.checked === 0) {
      warnings.push({ code: 'no_checkpoints', message: 'No signed checkpoint exists; a consistent rewrite of the entire chain would not be detected.' });
    }

    return {
      ok: firstBreak === null && checkpoints.firstFailure === null,
      storage: 'sqlite',
      instanceId,
      verifiedAt: startedAt,
      durationMs: now() - startedAt,
      coverage: { fromSeq: chainStartSeq ?? 0, toSeq, scope: 'full' },
      chain: { checked, headSeq, headHash, chainStartSeq, unchained: unchainedCount },
      firstBreak,
      checkpoints,
      exported: null,
      keyTrust: options.trustedKeyPem !== undefined ? 'pinned' : 'server-reported',
      warnings,
    };
  } finally {
    db.close();
  }
}

/**
 * Parses `agent-viewer verify --checkpoints <file>`'s own copy of checkpoints (one JSON `SignedCheckpoint` per
 * non-empty line, the same shape `GET /api/v1/audit/checkpoints?format=jsonl` streams). Throws on a structurally
 * invalid line; the caller maps that to the CLI's usage-error exit code (not an integrity failure: a malformed
 * export file is not evidence of tampering, it just cannot be read).
 */
export function parseExportedCheckpointsFile(text: string): SignedCheckpoint[] {
  const checkpoints: SignedCheckpoint[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1}: not valid JSON`);
    }
    if (!raw || typeof raw !== 'object') throw new Error(`line ${i + 1}: not a checkpoint object`);
    const record = raw as Record<string, unknown>;
    const body = parseCheckpointBody(record.body);
    if (!body || typeof record.digest !== 'string' || typeof record.signature !== 'string') {
      throw new Error(`line ${i + 1}: not a valid signed checkpoint`);
    }
    checkpoints.push({ body, digest: record.digest, signature: record.signature });
  }
  return checkpoints;
}

/**
 * Cross-checks an exported checkpoint file against a chain the caller can query one `seq` at a time (issue #388:
 * "compare an exported checkpoint file against a live server without the server seeing the file" via
 * `GET /api/v1/audit/entries/:seq`, or the same thing read directly from a local database for `--db` mode).
 * Lighter than a full re-verification: it checks that every checkpoint in the file is internally
 * self-consistent (its own signature, digest, and the file's own prev-digest chain) and that its signed
 * `headHash` matches what the chain actually has at `headSeq` today. It does not re-derive `chainedCount` or
 * require every intermediate checkpoint to exist in the live chain's own `audit_checkpoints` table: that full
 * check is what `verifyChain` already does when the file is the live chain's own export.
 */
export async function crossCheckExportedCheckpoints(
  checkpoints: readonly SignedCheckpoint[],
  options: {
    trustedKeyPem?: string;
    /** Public keys this verification trusts, keyed by `keyId` (ignored when `trustedKeyPem` is given). */
    knownKeys?: ReadonlyMap<string, string>;
    /** Resolves the chain's actual hash at `seq`, or `null` if that `seq` is unknown to the chain. */
    getHashAtSeq: (seq: number) => Promise<string | null>;
  }
): Promise<CheckpointResult> {
  const result: CheckpointResult = { checked: 0, valid: 0, firstFailure: null };
  const keys = new Map<string, string>();
  if (options.trustedKeyPem !== undefined) {
    try {
      keys.set(keyIdFor(crypto.createPublicKey(options.trustedKeyPem)), options.trustedKeyPem);
    } catch {
      // Unparseable pinned key: every checkpoint reports key_unknown below, which is correct.
    }
  } else if (options.knownKeys) {
    for (const [keyId, pem] of options.knownKeys) keys.set(keyId, pem);
  }

  let prevDigest: string | null = null;
  let expectedSeq = 1;
  for (const checkpoint of checkpoints) {
    const body: CheckpointBody = checkpoint.body;
    result.checked++;
    const cursor = body.checkpointSeq;
    const fail = (kind: CheckpointFailureKind, message: string): void => {
      if (!result.firstFailure) result.firstFailure = { kind, checkpoint: cursor, seq: body.headSeq, message };
    };

    const digest = checkpointDigest(body);
    const linkPrev = prevDigest;
    const linkExpectedSeq = expectedSeq;
    prevDigest = digest;
    expectedSeq = cursor + 1;

    const pem = keys.get(body.keyId);
    let valid = true;
    if (!pem) {
      fail('key_unknown', `Checkpoint ${cursor} is signed by unknown key ${body.keyId}.`);
      valid = false;
    } else if (!verifyCheckpointSignature(body, checkpoint.signature, pem)) {
      fail('signature_invalid', `Checkpoint ${cursor} has an invalid signature.`);
      valid = false;
    } else if (checkpoint.digest !== digest) {
      fail('signature_invalid', `Checkpoint ${cursor}'s stored digest does not match its signed body.`);
      valid = false;
    }
    if (valid && cursor !== linkExpectedSeq) {
      fail('checkpoint_missing', `Checkpoint ${linkExpectedSeq} is missing from the export (found ${cursor} next).`);
      valid = false;
    }
    if (valid && body.prevCheckpointDigest !== linkPrev) {
      fail('checkpoint_link_broken', `Checkpoint ${cursor} does not link to the previous checkpoint's digest in this export.`);
      valid = false;
    }
    if (valid) {
      const actualHash = await options.getHashAtSeq(body.headSeq);
      if (actualHash === null || actualHash !== body.headHash) {
        fail('head_mismatch', `The chain's row at seq ${body.headSeq} does not match checkpoint ${cursor}'s signed head hash.`);
        valid = false;
      }
    }
    if (valid) result.valid++;
  }
  return result;
}
