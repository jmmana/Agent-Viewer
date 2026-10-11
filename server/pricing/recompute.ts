/**
 * Pricing recompute (issue #296, sub-issue of #84, "Data model" / "API: recompute" sections of #84's own body).
 * The write side of estimation: lets an operator re-run `estimateCall`/`estimateLedgerRow` (`server/pricing/
 * estimate.ts`, built and tested by #84 itself) against a corrected or explicitly pinned price-table version,
 * without ever touching revision 0 (the ingestion-time estimate, stored directly on `usage_ledger`) or the
 * canonical event. This module owns the SQL and the run/revision bookkeeping; it never re-derives pricing math.
 *
 * One `DatabaseSync` connection is assumed to belong to one running server process (`server/store.ts`'s
 * `SQLiteEventStore` holds exactly one), so the single-in-flight-run lock below is keyed by the connection
 * object itself (a `WeakMap`), not a module-level flag: two independent connections (for example two test
 * files, each with its own `:memory:` database) never contend for the same lock, and the lock needs no explicit
 * reset between tests.
 *
 * `node:sqlite` is synchronous: once a run's SQL starts, it has the whole event loop to itself until it returns,
 * so two genuinely concurrent HTTP requests can never interleave on their own (unlike, say, two requests whose
 * bodies are still being read). The `onLockAcquired`/`onBeforeCommit` hooks on `RecomputeDeps` exist only so a
 * test can reproduce "a second request arrives mid-run" and "the process dies mid-transaction" by calling back
 * into this module reentrantly from inside a run already in progress; production code never sets them.
 */
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { resolvePrice, type PriceEntry } from '../../src/integrations/pricingContract';
import { normalizeProvider } from '../requestKey';
import {
  buildPriceComponents,
  estimateLedgerRow,
  isEstimateStatus,
  rateNanoPerMillion,
  roundHalfEvenNano,
  type EstimateCallInput,
  type EstimatePricingSnapshot,
  type EstimateStatus,
  type LedgerEstimateFields,
} from './estimate';

// -------------------------------------------------------------
// Request parsing (POST /api/v1/pricing/recompute body)
// -------------------------------------------------------------

export interface RecomputeFilter {
  /** Half-open window lower bound on `occurred_at`, epoch ms, inclusive. `null` means unbounded. */
  from: number | null;
  /** Half-open window upper bound on `occurred_at`, epoch ms, exclusive. `null` means unbounded. */
  to: number | null;
  /** Exact match against `usage_ledger.model` (stored as reported, case-sensitive: the same convention
   * `server/usage/filters.ts` uses for the calls and rollup endpoints). */
  model: string | null;
  /** Normalized with `normalizeProvider`, the same way the ledger's own `provider` column is. */
  provider: string | null;
  agentId: string | null;
  /** Matches a row whose latest known estimate (revision 0 if it was never recomputed) has any status other
   * than `'estimated'`, including the virtual `'not_estimated'` status of a pre-0.6.0 row. */
  onlyUnestimated: boolean;
}

export interface ParsedRecomputeRequest {
  reason: string;
  /** Explicit operator selection, or `null` to resolve each row against the currently active version. */
  pricingVersion: number | null;
  filter: RecomputeFilter;
  dryRun: boolean;
}

export interface RecomputeFieldIssue {
  path: string;
  message: string;
}

export type ParseRecomputeResult =
  | { ok: true; value: ParsedRecomputeRequest }
  | {
      ok: false;
      status: 400;
      code: 'reason_required' | 'invalid_filter' | 'invalid_request';
      message: string;
      issues?: RecomputeFieldIssue[];
    };

const ALLOWED_FILTER_KEYS = new Set(['from', 'to', 'model', 'provider', 'agentId', 'onlyUnestimated']);
const MAX_REASON_LENGTH = 500;

function emptyFilter(): RecomputeFilter {
  return { from: null, to: null, model: null, provider: null, agentId: null, onlyUnestimated: false };
}

/** Parses and validates one `POST /api/v1/pricing/recompute` request body. Never throws; every problem is a
 * structured 400. `reason_required` covers both an absent/blank `reason` and one over 500 characters, since the
 * issue defines no separate code for the length case. */
export function parseRecomputeRequest(body: unknown): ParseRecomputeResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, code: 'invalid_request', message: 'Request body must be a JSON object.' };
  }
  const input = body as Record<string, unknown>;

  const reasonRaw = input.reason;
  if (typeof reasonRaw !== 'string' || reasonRaw.trim().length === 0) {
    return { ok: false, status: 400, code: 'reason_required', message: 'reason is required and must be a non-empty string.' };
  }
  if (reasonRaw.length > MAX_REASON_LENGTH) {
    return { ok: false, status: 400, code: 'reason_required', message: `reason must be at most ${MAX_REASON_LENGTH} characters.` };
  }

  let pricingVersion: number | null = null;
  if (input.pricingVersion !== undefined && input.pricingVersion !== null) {
    if (typeof input.pricingVersion !== 'number' || !Number.isInteger(input.pricingVersion) || input.pricingVersion < 1) {
      return { ok: false, status: 400, code: 'invalid_request', message: 'pricingVersion must be a positive integer when present.' };
    }
    pricingVersion = input.pricingVersion;
  }

  let dryRun = false;
  if (input.dryRun !== undefined && input.dryRun !== null) {
    if (typeof input.dryRun !== 'boolean') {
      return { ok: false, status: 400, code: 'invalid_request', message: 'dryRun must be a boolean when present.' };
    }
    dryRun = input.dryRun;
  }

  const filter = emptyFilter();
  const filterRaw = input.filter;
  if (filterRaw !== undefined && filterRaw !== null) {
    if (typeof filterRaw !== 'object' || Array.isArray(filterRaw)) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_filter',
        message: 'filter must be an object.',
        issues: [{ path: 'filter', message: 'Expected an object' }],
      };
    }
    const filterObj = filterRaw as Record<string, unknown>;
    const issues: RecomputeFieldIssue[] = [];
    for (const key of Object.keys(filterObj)) {
      if (!ALLOWED_FILTER_KEYS.has(key)) issues.push({ path: `filter.${key}`, message: 'Unknown filter field' });
    }
    if (issues.length > 0) {
      return { ok: false, status: 400, code: 'invalid_filter', message: 'Unknown filter field(s).', issues };
    }

    if (filterObj.from !== undefined && filterObj.from !== null) {
      if (typeof filterObj.from !== 'number' || !Number.isFinite(filterObj.from)) {
        issues.push({ path: 'filter.from', message: 'Expected a number (epoch ms)' });
      } else filter.from = filterObj.from;
    }
    if (filterObj.to !== undefined && filterObj.to !== null) {
      if (typeof filterObj.to !== 'number' || !Number.isFinite(filterObj.to)) {
        issues.push({ path: 'filter.to', message: 'Expected a number (epoch ms)' });
      } else filter.to = filterObj.to;
    }
    if (filterObj.model !== undefined && filterObj.model !== null) {
      if (typeof filterObj.model !== 'string' || filterObj.model.length === 0) {
        issues.push({ path: 'filter.model', message: 'Expected a non-empty string' });
      } else filter.model = filterObj.model;
    }
    if (filterObj.provider !== undefined && filterObj.provider !== null) {
      if (typeof filterObj.provider !== 'string' || filterObj.provider.trim().length === 0) {
        issues.push({ path: 'filter.provider', message: 'Expected a non-empty string' });
      } else filter.provider = normalizeProvider(filterObj.provider);
    }
    if (filterObj.agentId !== undefined && filterObj.agentId !== null) {
      if (typeof filterObj.agentId !== 'string' || filterObj.agentId.length === 0) {
        issues.push({ path: 'filter.agentId', message: 'Expected a non-empty string' });
      } else filter.agentId = filterObj.agentId;
    }
    if (filterObj.onlyUnestimated !== undefined && filterObj.onlyUnestimated !== null) {
      if (typeof filterObj.onlyUnestimated !== 'boolean') {
        issues.push({ path: 'filter.onlyUnestimated', message: 'Expected a boolean' });
      } else filter.onlyUnestimated = filterObj.onlyUnestimated;
    }
    if (issues.length > 0) {
      return { ok: false, status: 400, code: 'invalid_filter', message: 'Invalid filter field(s).', issues };
    }
  }

  return { ok: true, value: { reason: reasonRaw, pricingVersion, filter, dryRun } };
}

// -------------------------------------------------------------
// Errors
// -------------------------------------------------------------

export class PricingVersionNotFoundError extends Error {
  readonly code = 'pricing_version_not_found' as const;
  constructor(readonly version: number) {
    super(`Pricing version ${version} does not exist.`);
    this.name = 'PricingVersionNotFoundError';
  }
}

export class RecomputeTooBroadError extends Error {
  readonly code = 'filter_too_broad' as const;
  constructor(
    readonly matched: number,
    readonly maxRows: number
  ) {
    super(`The filter matched ${matched} rows, more than the configured limit of ${maxRows}.`);
    this.name = 'RecomputeTooBroadError';
  }
}

export class RecomputeInProgressError extends Error {
  readonly code = 'recompute_in_progress' as const;
  constructor() {
    super('Another pricing recompute run is already in progress.');
    this.name = 'RecomputeInProgressError';
  }
}

// -------------------------------------------------------------
// Row selection
// -------------------------------------------------------------

interface MatchedRow {
  eventId: string;
  occurredAt: number;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  rev0CostNano: number | null;
  rev0Currency: string | null;
  rev0PricingVersion: number | null;
  rev0Status: EstimateStatus | null;
  latestCostNano: number | null;
  latestCurrency: string | null;
  latestPricingVersion: number | null;
  latestStatus: EstimateStatus | null;
}

/** Every matched row joined to its own latest `usage_estimates` entry, if any. The join's `ON` clause leads
 * with `ledger_id`, so it uses the index `usage_ledger` columns + the `usage_estimates` `PRIMARY KEY
 * (ledger_id, revision)` already provide; nothing here depends on the issue's required `ix_usage_estimates_
 * revision` index (that one serves the per-call history endpoint's own ordering instead). */
/** The subset of `node:sqlite`'s `SQLInputValue` this module ever binds, mirroring `server/usage/rollup.ts`'s
 * own `SqlParam` alias. */
type SqlParam = string | number | null;

const BASE_FROM_JOIN = `
  FROM usage_ledger ul
  LEFT JOIN usage_estimates latest
    ON latest.ledger_id = ul.event_id
   AND latest.revision = (SELECT MAX(revision) FROM usage_estimates WHERE ledger_id = ul.event_id)
`;

function buildFilterSql(filter: RecomputeFilter): { whereSql: string; params: SqlParam[] } {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (filter.from !== null) {
    clauses.push('ul.occurred_at >= ?');
    params.push(filter.from);
  }
  if (filter.to !== null) {
    clauses.push('ul.occurred_at < ?');
    params.push(filter.to);
  }
  if (filter.model !== null) {
    clauses.push('ul.model = ?');
    params.push(filter.model);
  }
  if (filter.provider !== null) {
    clauses.push('ul.provider = ?');
    params.push(filter.provider);
  }
  if (filter.agentId !== null) {
    clauses.push('ul.agent_id = ?');
    params.push(filter.agentId);
  }
  if (filter.onlyUnestimated) {
    clauses.push("COALESCE(latest.estimate_status, ul.estimate_status, 'not_estimated') != 'estimated'");
  }
  return { whereSql: clauses.length > 0 ? clauses.join(' AND ') : '1=1', params };
}

function countMatched(db: DatabaseSync, whereSql: string, params: SqlParam[]): number {
  const row = db.prepare(`SELECT COUNT(*) AS c ${BASE_FROM_JOIN} WHERE ${whereSql}`).get(...params) as {
    c: number | bigint;
  };
  return Number(row.c);
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function selectMatchedRows(db: DatabaseSync, whereSql: string, params: SqlParam[]): MatchedRow[] {
  const sql = `
    SELECT
      ul.event_id AS eventId, ul.occurred_at AS occurredAt, ul.provider AS provider, ul.model AS model,
      ul.input_tokens AS inputTokens, ul.output_tokens AS outputTokens,
      ul.cache_read_tokens AS cacheReadTokens, ul.cache_write_tokens AS cacheWriteTokens,
      ul.reasoning_tokens AS reasoningTokens,
      ul.estimated_cost_nano AS rev0CostNano, ul.estimated_currency AS rev0Currency,
      ul.pricing_version AS rev0PricingVersion, ul.estimate_status AS rev0Status,
      latest.estimated_cost_nano AS latestCostNano, latest.estimated_currency AS latestCurrency,
      latest.pricing_version AS latestPricingVersion, latest.estimate_status AS latestStatus
    ${BASE_FROM_JOIN}
    WHERE ${whereSql}
    ORDER BY ul.seq ASC
  `;
  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    eventId: r.eventId as string,
    occurredAt: Number(r.occurredAt),
    provider: (r.provider as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    inputTokens: toNullableNumber(r.inputTokens),
    outputTokens: toNullableNumber(r.outputTokens),
    cacheReadTokens: toNullableNumber(r.cacheReadTokens),
    cacheWriteTokens: toNullableNumber(r.cacheWriteTokens),
    reasoningTokens: toNullableNumber(r.reasoningTokens),
    rev0CostNano: toNullableNumber(r.rev0CostNano),
    rev0Currency: (r.rev0Currency as string | null) ?? null,
    rev0PricingVersion: toNullableNumber(r.rev0PricingVersion),
    rev0Status: isEstimateStatus(r.rev0Status) ? r.rev0Status : null,
    latestCostNano: toNullableNumber(r.latestCostNano),
    latestCurrency: (r.latestCurrency as string | null) ?? null,
    latestPricingVersion: toNullableNumber(r.latestPricingVersion),
    latestStatus: isEstimateStatus(r.latestStatus) ? r.latestStatus : null,
  }));
}

export interface EstimateView {
  costNano: number | null;
  currency: string | null;
  pricingVersion: number | null;
  status: EstimateStatus | 'not_estimated';
}

/** The row's latest known estimate before this run touches it: its newest `usage_estimates` row if it has one,
 * else revision 0 (the ledger row's own ingestion-time columns), with a `null` `estimate_status` (a pre-0.6.0
 * row) read as the virtual `'not_estimated'`. */
function beforeOf(row: MatchedRow): EstimateView {
  if (row.latestStatus !== null) {
    return {
      costNano: row.latestCostNano,
      currency: row.latestCurrency,
      pricingVersion: row.latestPricingVersion,
      status: row.latestStatus,
    };
  }
  return {
    costNano: row.rev0CostNano,
    currency: row.rev0Currency,
    pricingVersion: row.rev0PricingVersion,
    status: row.rev0Status ?? 'not_estimated',
  };
}

function toEstimateInput(row: MatchedRow): EstimateCallInput {
  return {
    provider: row.provider,
    model: row.model,
    occurredAt: row.occurredAt,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
  };
}

/** True when the newly computed result differs from the row's prior estimate in any field that matters: a run
 * only ever writes a `usage_estimates` row for a row that actually changed (the issue's own rule; unchanged
 * rows are counted, not rewritten). */
function resultChanged(before: EstimateView, after: LedgerEstimateFields): boolean {
  return (
    before.costNano !== after.estimatedCostNano ||
    before.currency !== after.estimatedCurrency ||
    before.pricingVersion !== after.pricingVersion ||
    before.status !== after.estimateStatus
  );
}

// -------------------------------------------------------------
// Engine
// -------------------------------------------------------------

export interface RecomputeRowCounts {
  matched: number;
  written: number;
  unchanged: number;
  estimated: number;
  unestimable: number;
}

export interface RecomputeSample {
  ledgerId: string;
  before: EstimateView;
  after: EstimateView;
}

const MAX_SAMPLES = 20;

export interface RecomputeDeps {
  getCurrentPricingSnapshot(): EstimatePricingSnapshot;
  /** Resolves one historical/pinned pricing-table version by number (`server/pricing/store.ts`'s
   * `PricingStore.getVersion`), or `null` when it does not exist. Also used to derive the per-component
   * breakdown on read (`getCallEstimates` below), for whichever version produced a past revision. */
  getPricingVersionSnapshot(version: number): EstimatePricingSnapshot | null;
  /** Hard cap on matched rows (`AGENT_VIEWER_RECOMPUTE_MAX_ROWS`), resolved by the caller so this module stays
   * free of environment variables. */
  maxRows: number;
  now?: () => number;
  generateRunId?: () => string;
  /** Test-only, see the module doc comment. */
  onLockAcquired?: () => void;
  /** Test-only, see the module doc comment. */
  onBeforeCommit?: (counts: RecomputeRowCounts) => void;
}

export interface RecomputeRunResult {
  dryRun: false;
  runId: string;
  revision: number;
  createdAt: number;
  pricingVersion: number | null;
  rows: RecomputeRowCounts;
}

export interface RecomputeDryRunResult {
  dryRun: true;
  pricingVersion: number | null;
  rows: RecomputeRowCounts;
  samples: RecomputeSample[];
}

export type RecomputeOutcome = RecomputeRunResult | RecomputeDryRunResult;

/** The subset of `RecomputeDeps` a caller (the `EventStore.recomputePricing` method) exposes as a public, but
 * test-only, extra parameter, so a test can reach the reentrancy/rollback hooks through the same surface
 * production code calls, without widening `RecomputeDeps` itself (resolved internally from the pricing store
 * and `AGENT_VIEWER_RECOMPUTE_MAX_ROWS`) into something a route handler could accidentally mis-supply. */
export type RecomputeTestHooks = Pick<RecomputeDeps, 'onLockAcquired' | 'onBeforeCommit'>;

/** One running flag per `DatabaseSync` connection, not a module-level flag: each connection belongs to one
 * server process (see the module doc comment), so this is exactly the "only one run at a time" the issue asks
 * for, and it needs no manual reset between test files, each of which opens its own connection. */
const activeRuns = new WeakMap<DatabaseSync, true>();

function defaultRunId(): string {
  return `run_${crypto.randomUUID()}`;
}

/**
 * Runs one recompute: resolves the pricing snapshot (pinned by `request.pricingVersion` or the currently active
 * one), counts the matched rows against `deps.maxRows`, then either returns a dry-run preview or commits a new
 * revision in one transaction. Throws `RecomputeInProgressError`, `PricingVersionNotFoundError` or
 * `RecomputeTooBroadError` for the three non-2xx outcomes the route maps to 409/404/413; any other error leaves
 * no `usage_estimates` or `pricing_recompute_runs` row behind (the transaction rolls back) and propagates.
 */
export function runPricingRecompute(db: DatabaseSync, request: ParsedRecomputeRequest, deps: RecomputeDeps): RecomputeOutcome {
  if (activeRuns.has(db)) throw new RecomputeInProgressError();
  activeRuns.set(db, true);
  try {
    deps.onLockAcquired?.();

    let pricingSnapshot: EstimatePricingSnapshot;
    if (request.pricingVersion !== null) {
      const pinned = deps.getPricingVersionSnapshot(request.pricingVersion);
      if (!pinned) throw new PricingVersionNotFoundError(request.pricingVersion);
      pricingSnapshot = pinned;
    } else {
      pricingSnapshot = deps.getCurrentPricingSnapshot();
    }

    const { whereSql, params } = buildFilterSql(request.filter);
    const matched = countMatched(db, whereSql, params);
    if (matched > deps.maxRows) throw new RecomputeTooBroadError(matched, deps.maxRows);

    const now = deps.now ?? Date.now;

    if (request.dryRun) {
      const rows = selectMatchedRows(db, whereSql, params);
      const counts: RecomputeRowCounts = { matched: rows.length, written: 0, unchanged: 0, estimated: 0, unestimable: 0 };
      const samples: RecomputeSample[] = [];
      for (const row of rows) {
        const before = beforeOf(row);
        const after = estimateLedgerRow(toEstimateInput(row), pricingSnapshot, now);
        if (resultChanged(before, after)) counts.written++;
        else counts.unchanged++;
        if (after.estimateStatus === 'estimated') counts.estimated++;
        else counts.unestimable++;
        if (samples.length < MAX_SAMPLES) {
          samples.push({
            ledgerId: row.eventId,
            before,
            after: {
              costNano: after.estimatedCostNano,
              currency: after.estimatedCurrency,
              pricingVersion: after.pricingVersion,
              status: after.estimateStatus,
            },
          });
        }
      }
      return { dryRun: true, pricingVersion: pricingSnapshot.pricingVersion, rows: counts, samples };
    }

    const generateRunId = deps.generateRunId ?? defaultRunId;
    db.exec('BEGIN IMMEDIATE');
    try {
      const revisionRow = db.prepare('SELECT MAX(revision) AS m FROM pricing_recompute_runs').get() as {
        m: number | bigint | null;
      };
      const revision = revisionRow.m === null ? 1 : Number(revisionRow.m) + 1;
      const runId = generateRunId();
      const createdAt = now();

      const rows = selectMatchedRows(db, whereSql, params);
      const counts: RecomputeRowCounts = { matched: rows.length, written: 0, unchanged: 0, estimated: 0, unestimable: 0 };
      const insertEstimate = db.prepare(`
        INSERT INTO usage_estimates
          (ledger_id, revision, run_id, estimated_cost_nano, estimated_currency, pricing_version, estimate_status, estimated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        const before = beforeOf(row);
        const after = estimateLedgerRow(toEstimateInput(row), pricingSnapshot, now);
        if (resultChanged(before, after)) {
          insertEstimate.run(
            row.eventId,
            revision,
            runId,
            after.estimatedCostNano,
            after.estimatedCurrency,
            after.pricingVersion,
            after.estimateStatus,
            after.estimatedAt
          );
          counts.written++;
        } else {
          counts.unchanged++;
        }
        if (after.estimateStatus === 'estimated') counts.estimated++;
        else counts.unestimable++;
      }

      // Test-only hook (see the module doc comment): throwing here proves the whole run rolls back atomically.
      deps.onBeforeCommit?.(counts);

      db.prepare(`
        INSERT INTO pricing_recompute_runs
          (run_id, revision, created_at, reason, pricing_version_selector, filter_json,
           rows_matched, rows_written, rows_unchanged, rows_estimated, rows_unestimable)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        revision,
        createdAt,
        request.reason,
        request.pricingVersion,
        JSON.stringify(request.filter),
        counts.matched,
        counts.written,
        counts.unchanged,
        counts.estimated,
        counts.unestimable
      );
      db.exec('COMMIT');
      return { dryRun: false, runId, revision, createdAt, pricingVersion: pricingSnapshot.pricingVersion, rows: counts };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction may already have been rolled back by node:sqlite itself.
      }
      throw error;
    }
  } finally {
    activeRuns.delete(db);
  }
}

// -------------------------------------------------------------
// Run history: GET /api/v1/pricing/recompute-runs[/:runId]
// -------------------------------------------------------------

export interface RecomputeRunRecord {
  runId: string;
  revision: number;
  createdAt: number;
  reason: string;
  pricingVersionSelector: number | null;
  filter: RecomputeFilter;
  rows: RecomputeRowCounts;
}

function rowToRunRecord(r: Record<string, unknown>): RecomputeRunRecord {
  return {
    runId: r.run_id as string,
    revision: Number(r.revision),
    createdAt: Number(r.created_at),
    reason: r.reason as string,
    pricingVersionSelector: toNullableNumber(r.pricing_version_selector),
    filter: JSON.parse(r.filter_json as string) as RecomputeFilter,
    rows: {
      matched: Number(r.rows_matched),
      written: Number(r.rows_written),
      unchanged: Number(r.rows_unchanged),
      estimated: Number(r.rows_estimated),
      unestimable: Number(r.rows_unestimable),
    },
  };
}

export interface RecomputeRunsPage {
  runs: RecomputeRunRecord[];
  hasMore: boolean;
}

/** Newest first (by `revision`, which is strictly increasing with `created_at`). `before`, when given, returns
 * only runs strictly older than that revision, so the previous page's last `revision` is the next page's
 * cursor. */
export function listRecomputeRuns(db: DatabaseSync, options: { limit: number; before: number | null }): RecomputeRunsPage {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  if (options.before !== null) {
    clauses.push('revision < ?');
    params.push(options.before);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM pricing_recompute_runs ${where} ORDER BY revision DESC LIMIT ?`)
    .all(...params, options.limit + 1) as Array<Record<string, unknown>>;
  const hasMore = rows.length > options.limit;
  return { runs: rows.slice(0, options.limit).map(rowToRunRecord), hasMore };
}

export function getRecomputeRun(db: DatabaseSync, runId: string): RecomputeRunRecord | null {
  const row = db.prepare('SELECT * FROM pricing_recompute_runs WHERE run_id = ?').get(runId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToRunRecord(row) : null;
}

// -------------------------------------------------------------
// Per-call revision history: GET /api/v1/usage/calls/:id/estimates
// -------------------------------------------------------------

export interface CallEstimateComponent {
  component: string;
  tokens: number;
  ratePerMillion: number | null;
  costNano: number;
}

export interface CallEstimateRevision {
  revision: number;
  cost: number | null;
  costNano: number | null;
  currency: string | null;
  pricingVersion: number | null;
  status: EstimateStatus | 'not_estimated';
  estimatedAt: number | null;
  run: { runId: string; reason: string } | null;
  components: CallEstimateComponent[];
}

export interface CallEstimatesResult {
  eventId: string;
  revisions: CallEstimateRevision[];
}

/**
 * Prices the named components `estimateCall` would have priced for `row`, against whichever pricing version
 * produced the stored result, anchored to the stored `costNano` so the components always sum to it exactly
 * (rounding each component independently, half-even, would not generally reproduce the single rounding step
 * `estimateCall` performs once over the whole sum; the residual, always a handful of nano at most, is folded
 * into the last component). Returns `[]` whenever a breakdown cannot be reconstructed: a non-`'estimated'`
 * status, no recorded pricing version, a missing provider/model, a version that no longer resolves an entry, or
 * usage that `buildPriceComponents` itself rejects (missing or inconsistent counts): none of these are
 * expected on a row that was actually estimated, but this never throws for an old or edited price table.
 */
function deriveComponents(
  row: EstimateCallInput,
  status: EstimateStatus | 'not_estimated',
  pricingVersion: number | null,
  costNano: number | null,
  getPricingVersionSnapshot: (version: number) => EstimatePricingSnapshot | null
): CallEstimateComponent[] {
  if (status !== 'estimated' || pricingVersion === null || costNano === null) return [];
  if (row.provider === null || row.model === null) return [];

  const snapshot = getPricingVersionSnapshot(pricingVersion);
  if (!snapshot) return [];
  const entry: PriceEntry | null = resolvePrice(snapshot.entries, { provider: row.provider, model: row.model, at: row.occurredAt });
  if (!entry) return [];

  const breakdown = buildPriceComponents(row, entry);
  if (!breakdown) return [];
  if (breakdown.some((component) => component.tokens > 0 && component.ratePerMillion === null)) return [];

  const scaled = breakdown.map((component) =>
    component.tokens === 0 || component.ratePerMillion === null
      ? 0n
      : BigInt(component.tokens) * rateNanoPerMillion(component.ratePerMillion)
  );
  const rounded = scaled.map((value) => roundHalfEvenNano(value, 1_000_000n));
  const sumRounded = rounded.reduce((a, b) => a + b, 0n);
  const residual = BigInt(costNano) - sumRounded;

  const result: CallEstimateComponent[] = breakdown.map((component, index) => ({
    component: component.component,
    tokens: component.tokens,
    ratePerMillion: component.ratePerMillion,
    costNano: Number(rounded[index]),
  }));
  if (residual !== 0n && result.length > 0) {
    const lastIndex = result.length - 1;
    result[lastIndex] = { ...result[lastIndex], costNano: result[lastIndex].costNano + Number(residual) };
  }
  return result;
}

/** Every revision of one call (`eventId`, the ledger's own external identifier, see the migration's doc
 * comment), revision 0 first. `null` means the ledger has no row for `eventId` (the route's 404
 * `call_not_found`). */
export function getCallEstimates(
  db: DatabaseSync,
  eventId: string,
  deps: Pick<RecomputeDeps, 'getPricingVersionSnapshot'>
): CallEstimatesResult | null {
  const ledgerRow = db
    .prepare(`
      SELECT event_id AS eventId, occurred_at AS occurredAt, provider, model,
             input_tokens AS inputTokens, output_tokens AS outputTokens,
             cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens,
             reasoning_tokens AS reasoningTokens,
             estimated_cost_nano AS costNano, estimated_currency AS currency, pricing_version AS pricingVersion,
             estimate_status AS status, estimated_at AS estimatedAt
      FROM usage_ledger WHERE event_id = ?
    `)
    .get(eventId) as Record<string, unknown> | undefined;
  if (!ledgerRow) return null;

  const estimateRows = db
    .prepare(`
      SELECT ue.revision AS revision, ue.estimated_cost_nano AS costNano, ue.estimated_currency AS currency,
             ue.pricing_version AS pricingVersion, ue.estimate_status AS status, ue.estimated_at AS estimatedAt,
             ue.run_id AS runId, r.reason AS reason
      FROM usage_estimates ue
      JOIN pricing_recompute_runs r ON r.run_id = ue.run_id
      WHERE ue.ledger_id = ?
      ORDER BY ue.revision ASC
    `)
    .all(eventId) as Array<Record<string, unknown>>;

  const callInput: EstimateCallInput = {
    provider: (ledgerRow.provider as string | null) ?? null,
    model: (ledgerRow.model as string | null) ?? null,
    occurredAt: Number(ledgerRow.occurredAt),
    inputTokens: toNullableNumber(ledgerRow.inputTokens),
    outputTokens: toNullableNumber(ledgerRow.outputTokens),
    cacheReadTokens: toNullableNumber(ledgerRow.cacheReadTokens),
    cacheWriteTokens: toNullableNumber(ledgerRow.cacheWriteTokens),
    reasoningTokens: toNullableNumber(ledgerRow.reasoningTokens),
  };

  function toRevision(
    revision: number,
    rawCostNano: unknown,
    currency: unknown,
    rawPricingVersion: unknown,
    rawStatus: unknown,
    rawEstimatedAt: unknown,
    run: { runId: string; reason: string } | null
  ): CallEstimateRevision {
    const status: EstimateStatus | 'not_estimated' = isEstimateStatus(rawStatus) ? rawStatus : 'not_estimated';
    const costNano = toNullableNumber(rawCostNano);
    const pricingVersion = toNullableNumber(rawPricingVersion);
    return {
      revision,
      cost: costNano === null ? null : costNano / 1e9,
      costNano,
      currency: (currency as string | null) ?? null,
      pricingVersion,
      status,
      estimatedAt: toNullableNumber(rawEstimatedAt),
      run,
      components: deriveComponents(callInput, status, pricingVersion, costNano, deps.getPricingVersionSnapshot),
    };
  }

  const revisions: CallEstimateRevision[] = [
    toRevision(
      0,
      ledgerRow.costNano,
      ledgerRow.currency,
      ledgerRow.pricingVersion,
      ledgerRow.status,
      ledgerRow.estimatedAt,
      null
    ),
    ...estimateRows.map((r) =>
      toRevision(Number(r.revision), r.costNano, r.currency, r.pricingVersion, r.status, r.estimatedAt, {
        runId: r.runId as string,
        reason: r.reason as string,
      })
    ),
  ];

  return { eventId, revisions };
}
