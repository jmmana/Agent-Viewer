import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { EMPTY_DIGEST } from '../chain';
import type { AuditCheckpointService } from './checkpoints';
import type { SignedCheckpoint } from './checkpointFormat';
import { dbRowToLedgerRowInput, type UsageLedgerRow } from '../usageLedger';
import { toExportCallRecord } from '../usage/export';
import type { PricingStore } from '../pricing/store';

/**
 * Offline-verifiable audit bundle export (issue #400, first sub-issue of #110). A single NDJSON stream a client
 * saves to disk and later verifies without trusting this server again: `header`, `key`(s), `pricing`(0+),
 * `checkpoint`(0+), `tombstone`(0+), `event`+`ledger` pairs in ascending chain `seq`, `footer`. The standalone
 * verifier that checks all of this independently is issue #401, not implemented here; this module only produces
 * a bundle a hand-written test can assert against line by line.
 *
 * Pure-ish: no Express. Opens its own read-only `node:sqlite` connection (same pattern as `./verify.ts`), separate
 * from any writer connection the caller holds, and reads the whole export inside one `BEGIN`/`COMMIT` so
 * concurrent ingestion, retention or redaction can never change what one export sees (issue #110's "consistent
 * snapshot" requirement). `server/index.ts` owns the HTTP specifics (headers, gzip, the concurrency cap, the
 * 401/403/409/400/503 mapping); this module only knows how to produce or reject a range.
 *
 * Deferred, documented here because it shapes the `pricing` line below: issue #110 asks for each referenced
 * pricing version's digest to be "committed under the chain" so a verifier can detect a tampered price table.
 * The pricing table (`server/pricing/store.ts`) lives entirely in flat files outside SQLite and predates the hash
 * chain (#105) by two milestones; #110 itself says that chain commitment work is blocked on an extension to #83
 * if #83 does not already provide it, and it does not. This module ships `pricing` lines with the digest the
 * pricing store already computes and stores (`PricingVersion.contentHash`, `computeContentHash` in
 * `src/integrations/pricingContract.ts`) but does not yet chain-anchor it; a future issue can add an
 * `audit.pricing.activated` chained commitment event (the same pattern issue #107 uses for `audit.key.created`)
 * and this module's `pricing` line format does not need to change when that lands, only its trust story.
 */

let _DatabaseSync: any = null;
function getDatabaseSync(): any {
  if (!_DatabaseSync) {
    const req = createRequire(import.meta.url);
    _DatabaseSync = req('node:sqlite').DatabaseSync;
  }
  return _DatabaseSync;
}

export const BUNDLE_FORMAT_VERSION = 1;

export class AuditBundleRangeError extends Error {
  readonly code = 'invalid_range' as const;
}

/** Thrown when the store has no chain to export from (memory storage, or a schema predating migration 17). */
export class AuditBundleUnsupportedError extends Error {
  readonly code = 'audit_requires_chain' as const;
}

export interface AuditBundleRawQuery {
  fromSeq?: string;
  toSeq?: string;
  from?: string;
  to?: string;
}

export interface AuditBundleRequestedRange {
  fromSeq: number | null;
  toSeq: number | null;
  from: number | null;
  to: number | null;
}

const NON_NEGATIVE_INT = /^(0|[1-9][0-9]*)$/;
const POSITIVE_INT = /^[1-9][0-9]*$/;

function parseSeqParam(name: string, raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!POSITIVE_INT.test(raw)) throw new AuditBundleRangeError(`"${name}" must be a positive integer`);
  return Number(raw);
}

function parseTimeParam(name: string, raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!NON_NEGATIVE_INT.test(raw)) throw new AuditBundleRangeError(`"${name}" must be a non-negative integer (epoch ms)`);
  return Number(raw);
}

/** Parses and validates the raw query string params; throws `AuditBundleRangeError` on anything malformed or
 * mixed. Does not touch the database: resolving `fromSeq`/`toSeq` against `from`/`to` needs a connection, done by
 * `resolveRange` below. */
export function parseAuditBundleQuery(query: AuditBundleRawQuery): AuditBundleRequestedRange {
  const fromSeq = parseSeqParam('fromSeq', query.fromSeq);
  const toSeq = parseSeqParam('toSeq', query.toSeq);
  const from = parseTimeParam('from', query.from);
  const to = parseTimeParam('to', query.to);
  if ((fromSeq !== null || toSeq !== null) && (from !== null || to !== null)) {
    throw new AuditBundleRangeError('fromSeq/toSeq cannot be combined with from/to');
  }
  if (fromSeq !== null && toSeq !== null && fromSeq > toSeq) {
    throw new AuditBundleRangeError('fromSeq must be <= toSeq');
  }
  if (from !== null && to !== null && from > to) {
    throw new AuditBundleRangeError('from must be <= to');
  }
  return { fromSeq, toSeq, from, to };
}

export interface ResolvedRange {
  fromSeq: number;
  /** `toSeq < fromSeq` means an empty range (no event in it), per issue #110's "empty range" rule. */
  toSeq: number;
  chainStartSeq: number | null;
  genesisHash: string;
}

/** Resolves a validated query against the live chain: `fromSeq`/`toSeq` default to the first retained row and
 * the current head; `from`/`to` translate by `created_at` (server receive time), never the client `timestamp`. */
function resolveRange(db: any, requested: AuditBundleRequestedRange): ResolvedRange {
  const chainStartRow = db.prepare('SELECT MIN(seq) AS s FROM events WHERE hash IS NOT NULL').get() as { s: number | null };
  const chainStartSeq = chainStartRow.s === null ? null : Number(chainStartRow.s);
  const headRow = db.prepare('SELECT MAX(seq) AS s FROM events WHERE hash IS NOT NULL').get() as { s: number | null };
  const headSeq = headRow.s === null ? null : Number(headRow.s);
  const genesisRow = db.prepare("SELECT hash FROM chain_checkpoints WHERE kind = 'genesis' LIMIT 1").get() as { hash: string } | undefined;
  const genesisHash = genesisRow?.hash ?? EMPTY_DIGEST;

  if (chainStartSeq === null || headSeq === null) {
    // Empty chain: every request resolves to the same empty range, seq 1..0.
    return { fromSeq: 1, toSeq: 0, chainStartSeq: null, genesisHash };
  }

  let fromSeq = requested.fromSeq ?? chainStartSeq;
  let toSeq = requested.toSeq ?? headSeq;

  if (requested.from !== null) {
    const row = db.prepare('SELECT MIN(seq) AS s FROM events WHERE hash IS NOT NULL AND created_at >= ?').get(requested.from) as { s: number | null };
    fromSeq = row.s === null ? headSeq + 1 : Number(row.s);
  }
  if (requested.to !== null) {
    const row = db.prepare('SELECT MAX(seq) AS s FROM events WHERE hash IS NOT NULL AND created_at < ?').get(requested.to) as { s: number | null };
    toSeq = row.s === null ? chainStartSeq - 1 : Number(row.s);
  }

  if (fromSeq < chainStartSeq) fromSeq = chainStartSeq;
  if (toSeq > headSeq) toSeq = headSeq;
  // Issue #110's "empty range" rule: an empty range always normalizes to exactly `toSeq = fromSeq - 1`, not
  // whatever lower bound it happened to resolve to (e.g. `fromSeq` requested past the current head).
  if (toSeq < fromSeq) toSeq = fromSeq - 1;
  return { fromSeq, toSeq, chainStartSeq, genesisHash };
}

export interface AuditBundleDeps {
  dbPath: string;
  /** `null` when this server has no signing key configured (memory storage already refused earlier; this is for
   * a SQLite server that simply never set up #387). The bundle is still produced, just without a forced tail
   * checkpoint: its last `checkpoint` line (if any) may then be older than `toSeq`, same as #110's own "partial
   * ranges" rule already covers for other reasons. */
  checkpoints: AuditCheckpointService | null;
  pricingStore: PricingStore;
  write: (line: string) => Promise<void> | void;
  isAborted: () => boolean;
  now?: () => number;
  pageSize?: number;
}

export interface AuditBundleResult {
  fromSeq: number;
  toSeq: number;
  events: number;
  ledgerRows: number;
  checkpoints: number;
  tombstones: number;
  pricingVersions: number;
  aborted: boolean;
}

interface TokenTotal {
  sum: number | null;
  knownCalls: number;
  unknownCalls: number;
}

function newTokenTotal(): TokenTotal {
  return { sum: null, knownCalls: 0, unknownCalls: 0 };
}

function addToken(total: TokenTotal, value: number | null): void {
  if (value === null) {
    total.unknownCalls++;
    return;
  }
  total.knownCalls++;
  total.sum = total.sum === null ? value : total.sum + value;
}

interface CostGroup {
  currency: string | null;
  knownCalls: number;
  unknownCalls: number;
  cost: number | null;
}

class CostTotals {
  private readonly groups = new Map<string | null, CostGroup>();

  add(currency: string | null, cost: number | null): void {
    let group = this.groups.get(currency);
    if (!group) {
      group = { currency, knownCalls: 0, unknownCalls: 0, cost: null };
      this.groups.set(currency, group);
    }
    if (cost === null) {
      group.unknownCalls++;
    } else {
      group.knownCalls++;
      group.cost = group.cost === null ? cost : group.cost + cost;
    }
  }

  toArray(): CostGroup[] {
    return [...this.groups.values()].sort((a, b) => {
      if (a.currency === null) return b.currency === null ? 0 : 1;
      if (b.currency === null) return -1;
      return a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0;
    });
  }
}

class FooterTotals {
  calls = 0;
  readonly callsByStatus: Record<string, number> = {};
  readonly tokens = {
    inputTokens: newTokenTotal(),
    outputTokens: newTokenTotal(),
    cacheReadTokens: newTokenTotal(),
    cacheWriteTokens: newTokenTotal(),
    reasoningTokens: newTokenTotal(),
  };
  readonly reportedCost = new CostTotals();
  readonly estimatedCost = new CostTotals();

  add(row: UsageLedgerRow, estimatedCostDecimal: number | null): void {
    this.calls++;
    this.callsByStatus[row.status] = (this.callsByStatus[row.status] ?? 0) + 1;
    addToken(this.tokens.inputTokens, row.inputTokens);
    addToken(this.tokens.outputTokens, row.outputTokens);
    addToken(this.tokens.cacheReadTokens, row.cacheReadTokens);
    addToken(this.tokens.cacheWriteTokens, row.cacheWriteTokens);
    addToken(this.tokens.reasoningTokens, row.reasoningTokens);
    this.reportedCost.add(row.currency, row.cost);
    this.estimatedCost.add(row.estimatedCurrency, estimatedCostDecimal);
  }

  toJSON() {
    return {
      calls: this.calls,
      callsByStatus: this.callsByStatus,
      tokens: this.tokens,
      reportedCost: this.reportedCost.toArray(),
      estimatedCost: this.estimatedCost.toArray(),
    };
  }
}

interface RawEventRow {
  seq: number;
  id: string;
  event_json: string | null;
  created_at: number;
  submitter_id: string | null;
  prev_hash: string | null;
  hash: string | null;
  type: string;
  content_hash: string | null;
  tombstoned_at: number | null;
  tombstone_reason: string | null;
  tombstone_audit_seq: number | null;
  tombstone_rules_version: string | null;
}

const EVENT_COLUMNS =
  'seq, id, event_json, created_at, submitter_id, prev_hash, hash, type, content_hash, tombstoned_at, tombstone_reason, tombstone_audit_seq, tombstone_rules_version';

/**
 * Streams the bundle for `[resolved.fromSeq, resolved.toSeq]` through `deps.write`. Returns counts for the
 * caller's own logging/headers. Never throws for a tampered database (that is the verifier's job, #401): it can
 * still throw for a genuine I/O problem, which the HTTP route turns into its own error response.
 */
export async function streamAuditBundle(deps: AuditBundleDeps, requested: AuditBundleRequestedRange): Promise<AuditBundleResult> {
  const now = deps.now ?? Date.now;
  const pageSize = deps.pageSize && deps.pageSize > 0 ? deps.pageSize : 1000;
  const DBSync = getDatabaseSync();
  const db = new DBSync(deps.dbPath, { readOnly: true });
  try {
    const hasChain = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chain_checkpoints'").get() as
      | { name: string }
      | undefined) !== undefined;
    if (!hasChain) throw new AuditBundleUnsupportedError('Audit bundles need AGENT_VIEWER_STORAGE=sqlite with the hash chain enabled');

    const resolved = resolveRange(db, requested);
    const isEmpty = resolved.toSeq < resolved.fromSeq;

    // Tail anchoring (issue #110): force a signed checkpoint at toSeq before taking the snapshot, so the bundle's
    // last checkpoint line always covers toSeq. Runs on the checkpoint service's own writer connection, entirely
    // separate from the read-only connection this function holds; must happen before BEGIN below so the snapshot
    // this function takes includes the checkpoint it just caused to exist.
    if (!isEmpty && deps.checkpoints) {
      const latest = deps.checkpoints.latest();
      if (!latest || latest.body.headSeq < resolved.toSeq) {
        deps.checkpoints.createCheckpointAt(resolved.toSeq, 'manual');
      }
    }

    db.exec('BEGIN');
    try {
      const instanceRow = db.prepare("SELECT value FROM audit_meta WHERE key = 'instance_id'").get() as { value: string } | undefined;
      const instanceId = instanceRow?.value ?? '';

      let prevHash = resolved.genesisHash;
      if (resolved.fromSeq > (resolved.chainStartSeq ?? resolved.fromSeq)) {
        const beforeRow = db.prepare('SELECT hash FROM events WHERE hash IS NOT NULL AND seq < ? ORDER BY seq DESC LIMIT 1').get(resolved.fromSeq) as
          | { hash: string }
          | undefined;
        if (beforeRow) prevHash = beforeRow.hash;
      }

      let headHash = prevHash;
      if (!isEmpty) {
        const headRow = db.prepare('SELECT hash FROM events WHERE hash IS NOT NULL AND seq = ?').get(resolved.toSeq) as { hash: string } | undefined;
        if (headRow) headHash = headRow.hash;
      }

      const hashStream = crypto.createHash('sha256');
      const writeLine = async (obj: unknown): Promise<void> => {
        const line = JSON.stringify(obj);
        hashStream.update(line, 'utf8');
        hashStream.update('\n', 'utf8');
        await deps.write(`${line}\n`);
      };

      const complete = resolved.fromSeq <= (resolved.chainStartSeq ?? resolved.fromSeq);

      await writeLine({
        kind: 'header',
        format: 'agent-viewer-audit-bundle',
        formatVersion: BUNDLE_FORMAT_VERSION,
        generatedAt: now(),
        instanceId,
        storage: 'sqlite',
        chain: { algorithm: 'sha256', canonicalization: 'JCS-RFC8785' },
        range: { fromSeq: resolved.fromSeq, toSeq: resolved.toSeq, prevHash, headHash },
        requested: { fromSeq: requested.fromSeq, toSeq: requested.toSeq, from: requested.from, to: requested.to },
        complete,
      });

      let keyCount = 0;
      if (deps.checkpoints) {
        for (const key of deps.checkpoints.keys()) {
          keyCount++;
          await writeLine({
            kind: 'key',
            keyId: key.keyId,
            algorithm: key.algorithm,
            publicKeyPem: key.publicKeyPem,
            createdAt: key.createdAt,
            retiredAt: key.retiredAt,
            active: key.active,
          });
        }
      }

      // Pricing versions referenced by any ledger row in range (deferred chain commitment: see this module's doc
      // comment). Found via the distinct pricing_version values among usage_ledger rows whose event is in range.
      let pricingVersionCount = 0;
      if (!isEmpty) {
        const versionRows = db
          .prepare(
            `SELECT DISTINCT ul.pricing_version AS v FROM usage_ledger ul
             JOIN events e ON e.id = ul.event_id
             WHERE e.hash IS NOT NULL AND e.seq >= ? AND e.seq <= ? AND ul.pricing_version IS NOT NULL
             ORDER BY v`
          )
          .all(resolved.fromSeq, resolved.toSeq) as Array<{ v: number }>;
        for (const { v } of versionRows) {
          const version = deps.pricingStore.getVersion(Number(v));
          if (!version) continue;
          pricingVersionCount++;
          await writeLine({
            kind: 'pricing',
            pricingVersion: version.pricingVersion,
            digest: version.contentHash,
            createdAt: version.createdAt,
            origin: version.origin,
            entries: version.entries,
          });
        }
      }

      // Checkpoints whose headSeq falls in range, ascending. Includes the tail checkpoint just forced above.
      let checkpointCount = 0;
      if (!isEmpty && deps.checkpoints) {
        let afterSeq = 0;
        while (true) {
          const page: SignedCheckpoint[] = deps.checkpoints.list(afterSeq, 200);
          if (page.length === 0) break;
          for (const checkpoint of page) {
            afterSeq = checkpoint.body.checkpointSeq;
            if (checkpoint.body.headSeq < resolved.fromSeq || checkpoint.body.headSeq > resolved.toSeq) continue;
            checkpointCount++;
            await writeLine({ kind: 'checkpoint', ...checkpoint });
          }
          if (page.length < 200) break;
        }
      }

      // Tombstones in range, ascending seq: every tombstoned row carries its own replacement reason and the
      // seq of the (chained, still-recomputable) audit event that committed the tombstone, per issue #109.
      let tombstoneCount = 0;
      if (!isEmpty) {
        const stmt = db.prepare(
          `SELECT ${EVENT_COLUMNS} FROM events WHERE hash IS NOT NULL AND seq >= ? AND seq <= ? AND tombstoned_at IS NOT NULL ORDER BY seq`
        );
        const rows = stmt.all(resolved.fromSeq, resolved.toSeq) as RawEventRow[];
        for (const row of rows) {
          tombstoneCount++;
          await writeLine({
            kind: 'tombstone',
            seq: Number(row.seq),
            eventId: row.id,
            at: Number(row.tombstoned_at),
            reason: row.tombstone_reason,
            auditSeq: row.tombstone_audit_seq === null ? null : Number(row.tombstone_audit_seq),
            rulesVersion: row.tombstone_rules_version,
            contentHash: row.content_hash,
          });
        }
      }

      // Events, each immediately followed by its ledger row when one exists (llm.usage/llm.failed only).
      const totals = new FooterTotals();
      let eventCount = 0;
      let ledgerCount = 0;
      if (!isEmpty) {
        const page = db.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE hash IS NOT NULL AND seq >= ? AND seq <= ? ORDER BY seq LIMIT ?`);
        const ledgerStmt = (ids: string[]) =>
          db
            .prepare(
              `SELECT seq, event_id, event_type, request_id, received_at, occurred_at, origin, legacy_contract, ingest_channel, runtime_id, session_id, agent_id, task_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost, currency, cost_source, latency_ms, status, error_kind, trace_id, parent_id, tool_call_id, meeting_id, user_id, tags, summary, estimated_cost_nano, estimated_currency, pricing_version, estimate_status, estimated_at
               FROM usage_ledger WHERE event_id IN (${ids.map(() => '?').join(',')})`
            )
            .all(...ids) as any[];

        let cursor = resolved.fromSeq - 1;
        while (true) {
          if (deps.isAborted()) return { fromSeq: resolved.fromSeq, toSeq: resolved.toSeq, events: eventCount, ledgerRows: ledgerCount, checkpoints: checkpointCount, tombstones: tombstoneCount, pricingVersions: pricingVersionCount, aborted: true };
          const rows = page.all(cursor, resolved.toSeq, pageSize) as RawEventRow[];
          if (rows.length === 0) break;
          cursor = Number(rows[rows.length - 1]!.seq);

          const ledgerIds = rows.filter((r) => r.type === 'llm.usage' || r.type === 'llm.failed').map((r) => r.id);
          const ledgerByEventId = new Map<string, UsageLedgerRow>();
          if (ledgerIds.length > 0) {
            for (const raw of ledgerStmt(ledgerIds)) {
              ledgerByEventId.set(raw.event_id, { seq: Number(raw.seq), ...dbRowToLedgerRowInput(raw) });
            }
          }

          for (const row of rows) {
            if (deps.isAborted()) return { fromSeq: resolved.fromSeq, toSeq: resolved.toSeq, events: eventCount, ledgerRows: ledgerCount, checkpoints: checkpointCount, tombstones: tombstoneCount, pricingVersions: pricingVersionCount, aborted: true };
            eventCount++;
            let parsedEvent: unknown = null;
            try {
              parsedEvent = row.event_json === null ? null : JSON.parse(row.event_json);
            } catch {
              parsedEvent = null;
            }
            await writeLine({
              kind: 'event',
              seq: Number(row.seq),
              prevHash: row.prev_hash,
              hash: row.hash,
              receivedAt: Number(row.created_at),
              submitterId: row.submitter_id,
              event: parsedEvent,
            });

            const ledgerRow = ledgerByEventId.get(row.id);
            if (ledgerRow) {
              ledgerCount++;
              const record = toExportCallRecord(ledgerRow);
              await writeLine({ kind: 'ledger', ...record });
              totals.add(ledgerRow, record.estimatedCost);
            }
          }
          if (rows.length < pageSize) break;
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      // The footer's own line is never hashed into contentSha256 (the digest covers every byte up to and
      // including the newline of the line *before* the footer), so it bypasses writeLine and is sent directly.
      const footerLine = JSON.stringify({
        kind: 'footer',
        counts: { events: eventCount, ledger: ledgerCount, checkpoints: checkpointCount, tombstones: tombstoneCount, pricing: pricingVersionCount },
        totals: totals.toJSON(),
        contentSha256: hashStream.digest('hex'),
      });
      await deps.write(`${footerLine}\n`);

      return {
        fromSeq: resolved.fromSeq,
        toSeq: resolved.toSeq,
        events: eventCount,
        ledgerRows: ledgerCount,
        checkpoints: checkpointCount,
        tombstones: tombstoneCount,
        pricingVersions: pricingVersionCount,
        aborted: false,
      };
    } finally {
      try {
        db.exec('COMMIT');
      } catch {
        // Read-only snapshot; nothing was written, so a failed commit (e.g. already aborted) is not fatal here.
      }
    }
  } finally {
    db.close();
  }
}
