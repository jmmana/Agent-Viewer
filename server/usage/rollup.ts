/**
 * `GET /api/v1/usage/rollup` (issue #66): parses and validates the request, builds the SQLite query (or runs the
 * equivalent aggregation over the in-memory ledger), and shapes both into one identical `UsageRollupResponse`.
 *
 * Both backends produce a `RawAggregate` per group plus one for `totals`, then hand them to `shapeRollupResponse`,
 * the single place that rounds costs, orders cost entries, sorts and truncates groups, and builds `day` buckets.
 * Rounding, ordering and sorting can never diverge between memory and SQLite mode because this one function does
 * all of it; a query-planning decision such as "sort and limit in SQL" or "fetch every group and sort in JS" never
 * changes the response.
 *
 * Design note: the SQL in section 3 of the issue sorts, limits and counts groups with `ORDER BY` / `LIMIT` /
 * `COUNT(*) OVER ()` inside the database. This module instead fetches every group unsorted from SQLite (still
 * through indexed, bound-parameter `WHERE` clauses, so the 100,000-row scale budget is unaffected) and sorts,
 * paginates and counts them here, in the same code the memory store uses. Distinct-group cardinality is bounded
 * by the product of the filtered dimensions' own cardinalities (tens to low thousands even at 100,000 ledger
 * rows), never by the row count, so this trades a small, bounded amount of extra work for the guarantee that
 * sorting, `BINARY` key comparison and truncation are implemented exactly once.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { CostSource, UsageLedgerRow } from '../usageLedger';
import { parseUsageFilters, type UsageFilterIssue } from './filters';
import {
  ROLLUP_DIMENSIONS,
  TOKEN_KINDS,
  filtersToEcho,
  type RollupDimension,
  type RollupQuery,
  type RollupSort,
  type TokenKind,
  type UsageFilters,
  type UsageRollupAsOf,
  type UsageRollupCoverage,
  type UsageRollupGroup,
  type UsageRollupResponse,
  type UsageRollupTotals,
} from './types';

// -------------------------------------------------------------
// 1. Request parsing (`groupBy`, `sort`, `limit`, plus the shared filters, plus the full unknown-parameter check)
// -------------------------------------------------------------

/** Thrown by `parseRollupQuery`. The route layer catches it and responds `400 { error: "invalid_filter", issues }`. */
export class UsageFilterError extends Error {
  readonly issues: UsageFilterIssue[];

  constructor(issues: UsageFilterIssue[]) {
    super(`invalid_filter: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'UsageFilterError';
    this.issues = issues;
  }
}

function round9(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** The shared `parseUsageFilters` (issue #67) only accepts epoch ms or a full ISO 8601 date-time with an
 * explicit offset for `from`/`to` (its own issue never asked for a bare date). Issue #66's own spec also takes a
 * bare `YYYY-MM-DD` as UTC midnight, so the rollup route expands it to a full offset date-time before handing
 * the query to the shared parser, rather than changing that parser's contract (and its own passing tests) out
 * from under issue #67. */
function expandBareDateParam(value: unknown): unknown {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
}

export function parseRollupQuery(query: Record<string, unknown>): RollupQuery {
  const issues: UsageFilterIssue[] = [];

  // groupBy/sort/limit are rollup-only, parsed here rather than by the shared parser: rollup's own `limit`
  // means something different, with a different valid range, from the calls endpoint's pagination `limit`.
  const { groupBy: groupByRaw, sort: sortRaw, limit: limitRaw, ...coreQuery } = query;
  if ('from' in coreQuery) coreQuery.from = expandBareDateParam(coreQuery.from);
  if ('to' in coreQuery) coreQuery.to = expandBareDateParam(coreQuery.to);

  const groupByValues: string[] = [];
  if (groupByRaw !== undefined) {
    const items = Array.isArray(groupByRaw) ? groupByRaw : [groupByRaw];
    for (const item of items) {
      if (typeof item !== 'string') {
        issues.push({ path: 'groupBy', message: 'must be a string' });
        continue;
      }
      for (const part of item.split(',')) {
        const trimmed = part.trim();
        if (trimmed.length > 0) groupByValues.push(trimmed);
      }
    }
  }

  if (groupByValues.length === 0) {
    issues.push({ path: 'groupBy', message: 'is required (1 to 3 of agent, model, provider, session, task, day, user, tag)' });
  }
  if (groupByValues.length > 3) {
    issues.push({ path: 'groupBy', message: 'at most 3 dimensions are allowed' });
  }

  const seen = new Set<string>();
  const groupBy: RollupDimension[] = [];
  for (const value of groupByValues) {
    if (!(ROLLUP_DIMENSIONS as readonly string[]).includes(value)) {
      issues.push({ path: 'groupBy', message: `unknown dimension "${value}"` });
      continue;
    }
    if (seen.has(value)) {
      issues.push({ path: 'groupBy', message: `duplicate dimension "${value}"` });
      continue;
    }
    seen.add(value);
    groupBy.push(value as RollupDimension);
  }

  let sort: RollupSort = 'key';
  if (sortRaw !== undefined) {
    if (sortRaw === 'key' || sortRaw === 'calls') sort = sortRaw;
    else issues.push({ path: 'sort', message: 'must be "key" or "calls"' });
  }

  let limit = 1000;
  if (limitRaw !== undefined) {
    if (typeof limitRaw !== 'string' || !/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 10_000) {
      issues.push({ path: 'limit', message: 'must be an integer between 1 and 10000' });
    } else {
      limit = Number(limitRaw);
    }
  }

  const parsed = parseUsageFilters(coreQuery, { allowCallsOnly: false, allowRollupOnly: true });
  if (!parsed.ok) issues.push(...parsed.issues);

  if (issues.length > 0) throw new UsageFilterError(issues);
  if (!parsed.ok) throw new UsageFilterError(parsed.issues); // unreachable: covered by the check above

  return { groupBy, filters: parsed.value.filters, sort, limit };
}

// -------------------------------------------------------------
// 2. Shared aggregate shape and shaper (section 2, the normative aggregation rules)
// -------------------------------------------------------------

interface RawCostEntry {
  currency: string | null;
  costSource: CostSource;
  sum: number;
  calls: number;
}

/** One group's (or `totals`') accumulated figures, before rounding, ordering or key formatting. */
interface RawAggregate {
  key: Partial<Record<RollupDimension, string | null>>;
  callsTotal: number;
  callsSucceeded: number;
  callsFailed: number;
  tokenSums: Record<TokenKind, number>;
  tokenReported: Record<TokenKind, number>;
  /** Keyed by `${currency ?? '\u0000'}|${costSource}` so SQL rows and memory rows merge identically. */
  costEntries: Map<string, RawCostEntry>;
  unknownCostCalls: number;
  firstAt: number | null;
  lastAt: number | null;
}

function newRawAggregate(key: Partial<Record<RollupDimension, string | null>>): RawAggregate {
  return {
    key,
    callsTotal: 0,
    callsSucceeded: 0,
    callsFailed: 0,
    tokenSums: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    tokenReported: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    costEntries: new Map(),
    unknownCostCalls: 0,
    firstAt: null,
    lastAt: null,
  };
}

/** Stable string key for a group's dimension values, used to merge a cost-entries row into its group (both
 * backends compute this the same way from the same `groupBy` order, so SQL and memory rows merge identically). */
function keyToString(key: Partial<Record<RollupDimension, string | null>>, groupBy: readonly RollupDimension[]): string {
  return groupBy
    .map((dim) => {
      const value = key[dim];
      return value === null || value === undefined ? '\u0000' : `s:${value}`;
    })
    .join('\u0001');
}

const COST_SOURCE_ORDER: Record<CostSource, number> = { 'provider-reported': 0, estimated: 1, unknown: 2 };

/** `null` currency last; otherwise ascending UTF-8 byte comparison (`BINARY`), matching SQLite's default collation
 * so memory and SQLite mode order cost entries identically. */
function compareCostEntries(a: RawCostEntry, b: RawCostEntry): number {
  if (a.currency !== b.currency) {
    if (a.currency === null) return 1;
    if (b.currency === null) return -1;
    const cmp = Buffer.compare(Buffer.from(a.currency, 'utf8'), Buffer.from(b.currency, 'utf8'));
    if (cmp !== 0) return cmp;
  }
  return COST_SOURCE_ORDER[a.costSource] - COST_SOURCE_ORDER[b.costSource];
}

function shapeTotals(raw: RawAggregate): UsageRollupTotals {
  const tokens = {} as UsageRollupTotals['tokens'];
  for (const kind of TOKEN_KINDS) {
    const reportedCalls = raw.tokenReported[kind];
    tokens[kind] = {
      sum: reportedCalls > 0 ? raw.tokenSums[kind] : null,
      reportedCalls,
      unreportedCalls: raw.callsTotal - reportedCalls,
    };
  }
  const entries = [...raw.costEntries.values()]
    .map((entry) => ({ ...entry, sum: round9(entry.sum) }))
    .sort(compareCostEntries);
  return {
    calls: { total: raw.callsTotal, succeeded: raw.callsSucceeded, failed: raw.callsFailed },
    tokens,
    cost: { entries, unknownCostCalls: raw.unknownCostCalls },
    firstAt: raw.firstAt,
    lastAt: raw.lastAt,
  };
}

function shapeGroup(raw: RawAggregate, groupBy: readonly RollupDimension[], utcOffsetMinutes: number): UsageRollupGroup {
  const group: UsageRollupGroup = { ...shapeTotals(raw), key: raw.key };
  if (groupBy.includes('day')) {
    const dayKey = raw.key.day;
    if (typeof dayKey === 'string') {
      // The local midnight of `dayKey`, expressed as a UTC instant: the SQL builder computes the key the same
      // way (`date((<ts> + :offsetMs) / 1000, 'unixepoch')`), so this inverse must match exactly.
      const bucketStart = Date.parse(`${dayKey}T00:00:00.000Z`) - utcOffsetMinutes * 60_000;
      group.bucketStart = bucketStart;
      group.bucketEnd = bucketStart + 86_400_000;
    }
  }
  return group;
}

function compareByKey(a: RawAggregate, b: RawAggregate, groupBy: readonly RollupDimension[]): number {
  for (const dim of groupBy) {
    const av = a.key[dim] ?? null;
    const bv = b.key[dim] ?? null;
    if (av === bv) continue;
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp = Buffer.compare(Buffer.from(av, 'utf8'), Buffer.from(bv, 'utf8'));
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function compareGroups(a: RawAggregate, b: RawAggregate, groupBy: readonly RollupDimension[], sort: RollupSort): number {
  if (sort === 'calls' && a.callsTotal !== b.callsTotal) return b.callsTotal - a.callsTotal;
  return compareByKey(a, b, groupBy);
}

function shapeRollupResponse(args: {
  groups: RawAggregate[];
  totals: RawAggregate;
  query: RollupQuery;
  asOf: UsageRollupAsOf;
  coverage: UsageRollupCoverage;
}): UsageRollupResponse {
  const { groups, totals, query, asOf, coverage } = args;
  const sorted = [...groups].sort((a, b) => compareGroups(a, b, query.groupBy, query.sort));
  const groupCount = sorted.length;
  const truncated = groupCount > query.limit;
  const page = sorted.slice(0, query.limit);

  return {
    schemaVersion: '1.0',
    query: {
      groupBy: query.groupBy,
      timeBasis: query.filters.timeBasis,
      from: query.filters.from,
      to: query.filters.to,
      utcOffsetMinutes: query.filters.utcOffsetMinutes,
      filters: filtersToEcho(query.filters),
      asOfSeq: query.filters.asOfSeq,
      sort: query.sort,
      limit: query.limit,
    },
    asOf,
    coverage,
    groupsAreAdditive: !query.groupBy.includes('tag'),
    groupCount,
    truncated,
    groups: page.map((raw) => shapeGroup(raw, query.groupBy, query.filters.utcOffsetMinutes)),
    totals: shapeTotals(totals),
  };
}

// -------------------------------------------------------------
// 3. Memory-mode aggregation (pure function over an already-filtered-by-seq row array)
// -------------------------------------------------------------

function matchesSet(value: string | null, filterValues: readonly string[]): boolean {
  if (filterValues.length === 0) return true;
  return value !== null && filterValues.includes(value);
}

function matchesCurrency(row: UsageLedgerRow, filters: UsageFilters): boolean {
  if (filters.currency.length === 0) return true;
  if (row.currency === null) return filters.currency.includes('none');
  return filters.currency.includes(row.currency);
}

function tsOf(row: UsageLedgerRow, timeBasis: UsageFilters['timeBasis']): number {
  return timeBasis === 'occurred' ? row.occurredAt : row.receivedAt;
}

/** Exported for the export route (issue #69), which reuses this unchanged instead of re-deriving the same
 * non-seq filter semantics for its own row stream (`server/usage/export.ts`). */
export function rowMatchesFilters(row: UsageLedgerRow, filters: UsageFilters): boolean {
  const tsValue = tsOf(row, filters.timeBasis);
  if (filters.from !== null && tsValue < filters.from) return false;
  if (filters.to !== null && tsValue >= filters.to) return false;
  if (!matchesSet(row.agentId, filters.agentId)) return false;
  if (!matchesSet(row.model, filters.model)) return false;
  if (!matchesSet(row.provider, filters.provider)) return false;
  if (!matchesSet(row.sessionId, filters.sessionId)) return false;
  if (!matchesSet(row.taskId, filters.taskId)) return false;
  if (!matchesSet(row.runtimeId, filters.runtimeId)) return false;
  if (!matchesSet(row.userId, filters.userId)) return false;
  if (filters.status.length > 0 && !(filters.status as readonly string[]).includes(row.status)) return false;
  if (filters.costSource.length > 0 && !filters.costSource.includes(row.costSource)) return false;
  if (!matchesCurrency(row, filters)) return false;
  if (filters.tag.length > 0 && !row.tags.some((tag) => filters.tag.includes(tag))) return false;
  return true;
}

function dayKeyFor(tsValue: number, utcOffsetMinutes: number): string {
  const localMs = tsValue + utcOffsetMinutes * 60_000;
  return new Date(localMs).toISOString().slice(0, 10);
}

function dimValue(row: UsageLedgerRow, dim: Exclude<RollupDimension, 'tag'>, tsValue: number, utcOffsetMinutes: number): string | null {
  switch (dim) {
    case 'agent':
      return row.agentId;
    case 'model':
      return row.model;
    case 'provider':
      return row.provider;
    case 'session':
      return row.sessionId;
    case 'task':
      return row.taskId;
    case 'user':
      return row.userId;
    case 'day':
      return dayKeyFor(tsValue, utcOffsetMinutes);
  }
}

function buildGroupKey(
  row: UsageLedgerRow,
  groupBy: readonly RollupDimension[],
  tsValue: number,
  utcOffsetMinutes: number,
  tagOverride: string | null | undefined
): Partial<Record<RollupDimension, string | null>> {
  const key: Partial<Record<RollupDimension, string | null>> = {};
  for (const dim of groupBy) {
    key[dim] = dim === 'tag' ? (tagOverride ?? null) : dimValue(row, dim, tsValue, utcOffsetMinutes);
  }
  return key;
}

function accumulateRow(agg: RawAggregate, row: UsageLedgerRow, tsValue: number): void {
  agg.callsTotal++;
  if (row.eventType === 'llm.usage') agg.callsSucceeded++;
  else agg.callsFailed++;

  const tokenValues: Array<[TokenKind, number | null]> = [
    ['input', row.inputTokens],
    ['output', row.outputTokens],
    ['cacheRead', row.cacheReadTokens],
    ['cacheWrite', row.cacheWriteTokens],
    ['reasoning', row.reasoningTokens],
  ];
  for (const [kind, value] of tokenValues) {
    if (value !== null) {
      agg.tokenSums[kind] += value;
      agg.tokenReported[kind]++;
    }
  }

  if (row.cost === null) {
    agg.unknownCostCalls++;
  } else {
    const costKey = `${row.currency ?? '\u0000'}|${row.costSource}`;
    let entry = agg.costEntries.get(costKey);
    if (!entry) {
      entry = { currency: row.currency, costSource: row.costSource, sum: 0, calls: 0 };
      agg.costEntries.set(costKey, entry);
    }
    entry.sum += row.cost;
    entry.calls++;
  }

  if (agg.firstAt === null || tsValue < agg.firstAt) agg.firstAt = tsValue;
  if (agg.lastAt === null || tsValue > agg.lastAt) agg.lastAt = tsValue;
}

/**
 * Aggregates an already seq-bounded set of ledger rows (the caller applies `asOfSeq` first). Pure and
 * synchronous: safe to call directly from `MemoryEventStore`, which never awaits between a lookup and a mutation.
 */
export function computeMemoryAggregates(
  rows: readonly UsageLedgerRow[],
  query: RollupQuery
): { groups: RawAggregate[]; totals: RawAggregate } {
  const groupsMap = new Map<string, RawAggregate>();
  const totals = newRawAggregate({});
  const groupsByTag = query.groupBy.includes('tag');

  for (const row of rows) {
    if (!rowMatchesFilters(row, query.filters)) continue;
    const tsValue = tsOf(row, query.filters.timeBasis);
    accumulateRow(totals, row, tsValue);

    const tagValues: Array<string | null> = groupsByTag ? (row.tags.length > 0 ? row.tags : [null]) : [undefined as any];
    for (const tagValue of tagValues) {
      const key = buildGroupKey(row, query.groupBy, tsValue, query.filters.utcOffsetMinutes, tagValue);
      const keyStr = keyToString(key, query.groupBy);
      let agg = groupsMap.get(keyStr);
      if (!agg) {
        agg = newRawAggregate(key);
        groupsMap.set(keyStr, agg);
      }
      accumulateRow(agg, row, tsValue);
    }
  }

  return { groups: [...groupsMap.values()], totals };
}

/** `true` when a query whose lower bound is `from` (or unbounded) could include rows older than `purgedThrough`
 * (retention, issue #70) and so cannot be answered completely from what the ledger still holds. Retention purges
 * by `received_at` regardless of the query's own `timeBasis`, so this stays conservative: any unbounded or
 * early-starting query is flagged, even one filtered by `occurred_at`. */
function rangeReachesPurge(purgedThrough: number | null, from: number | null): boolean {
  if (purgedThrough === null) return false;
  return from === null || from <= purgedThrough;
}

export interface MemoryRollupInput {
  /** The full ledger, insertion (and therefore seq) ordered. */
  ledger: readonly UsageLedgerRow[];
  query: RollupQuery;
  now: () => number;
  /** From `MemoryEventStore`'s own cap bookkeeping (issue #53 applied to the ledger) and retention (issue #70). */
  coverage: { droppedRows: number; capComplete: boolean; purgedThrough: number | null };
}

export function computeMemoryRollup(input: MemoryRollupInput): UsageRollupResponse {
  const { ledger, query, now, coverage } = input;
  const maxSeq = ledger.length > 0 ? ledger[ledger.length - 1]!.seq : null;
  const ledgerSeq = maxSeq === null ? null : query.filters.asOfSeq !== null ? Math.min(query.filters.asOfSeq, maxSeq) : maxSeq;
  const lastRowReceivedAt = ledgerSeq === null ? null : (ledger.find((row) => row.seq === ledgerSeq)?.receivedAt ?? null);

  // Export-only (issue #69): `afterSeq` is `null` for every rollup-route query, so this is a no-op for #66's own
  // route; the export's totals sidecar sets it to pin the same `(afterSeq, asOfSeq]` window this aggregation runs
  // over.
  const afterSeq = query.filters.afterSeq;
  const eligible = ledgerSeq === null ? [] : ledger.filter((row) => row.seq <= ledgerSeq && (afterSeq === null || row.seq > afterSeq));
  const { groups, totals } = computeMemoryAggregates(eligible, query);

  return shapeRollupResponse({
    groups,
    totals,
    query,
    asOf: { ledgerSeq, lastRowReceivedAt, generatedAt: now() },
    coverage: {
      storage: 'memory',
      complete: coverage.capComplete && !rangeReachesPurge(coverage.purgedThrough, query.filters.from),
      droppedRows: coverage.droppedRows,
      purgedThrough: coverage.purgedThrough,
      backfilledRows: totals.callsTotal > 0 ? countBackfilled(eligible, query) : 0,
      legacyContractRows: totals.callsTotal > 0 ? countLegacyContract(eligible, query) : 0,
    },
  });
}

function countBackfilled(rows: readonly UsageLedgerRow[], query: RollupQuery): number {
  let count = 0;
  for (const row of rows) {
    if (rowMatchesFilters(row, query.filters) && row.origin === 'backfill') count++;
  }
  return count;
}

function countLegacyContract(rows: readonly UsageLedgerRow[], query: RollupQuery): number {
  let count = 0;
  for (const row of rows) {
    if (rowMatchesFilters(row, query.filters) && row.legacyContract) count++;
  }
  return count;
}

// -------------------------------------------------------------
// 4. SQLite-mode aggregation (bound-parameter SQL, one read transaction)
// -------------------------------------------------------------

const TOKEN_COLUMNS: Record<TokenKind, string> = {
  input: 'input_tokens',
  output: 'output_tokens',
  cacheRead: 'cache_read_tokens',
  cacheWrite: 'cache_write_tokens',
  reasoning: 'reasoning_tokens',
};

const DIMENSION_COLUMNS: Record<Exclude<RollupDimension, 'day' | 'tag'>, string> = {
  agent: 'agent_id',
  model: 'model',
  provider: 'provider',
  session: 'session_id',
  task: 'task_id',
  user: 'user_id',
};

function dimExprSql(dim: RollupDimension, tsCol: string): string {
  if (dim === 'day') return `date((${tsCol} + :offsetMs) / 1000, 'unixepoch')`;
  if (dim === 'tag') return 't.tag';
  return DIMENSION_COLUMNS[dim];
}

/** The subset of `node:sqlite`'s `SQLInputValue` this module ever binds. */
type SqlParam = string | number | null;

interface WhereClause {
  sql: string;
  params: Record<string, SqlParam>;
}

/** Builds the `WHERE` clause shared, byte for byte, by all four statements (groups, group cost entries, totals,
 * totals cost entries): dimension names never reach SQL text as raw values, only as bound parameters. Exported
 * for the pure query-builder tests (`tests/usage-rollup-scale.test.mjs`): a filter value is only ever a bound
 * parameter, never concatenated into the SQL string, and the `EXPLAIN QUERY PLAN` checks run against this exact
 * clause. */
export function buildWhere(filters: UsageFilters, tsCol: string, ledgerSeq: number | null): WhereClause {
  const params: Record<string, SqlParam> = { ledgerSeq };
  let counter = 0;
  const parts: string[] = ['seq <= :ledgerSeq'];

  // Export-only (issue #69): the lower half of an `(afterSeq, asOfSeq]` incremental window. `null` (the only value
  // any rollup-route query ever sets) adds nothing, so this is a no-op for #66's own route.
  if (filters.afterSeq !== null) {
    params.afterSeq = filters.afterSeq;
    parts.push('seq > :afterSeq');
  }

  function inClause(column: string, values: readonly string[]): string {
    const names = values.map((value) => {
      const name = `p${counter++}`;
      params[name] = value;
      return `:${name}`;
    });
    return `${column} IN (${names.join(', ')})`;
  }

  if (filters.from !== null) {
    params.fromTs = filters.from;
    parts.push(`${tsCol} >= :fromTs`);
  }
  if (filters.to !== null) {
    params.toTs = filters.to;
    parts.push(`${tsCol} < :toTs`);
  }

  if (filters.agentId.length) parts.push(inClause('agent_id', filters.agentId));
  if (filters.model.length) parts.push(inClause('model', filters.model));
  if (filters.provider.length) parts.push(inClause('provider', filters.provider));
  if (filters.sessionId.length) parts.push(inClause('session_id', filters.sessionId));
  if (filters.taskId.length) parts.push(inClause('task_id', filters.taskId));
  if (filters.runtimeId.length) parts.push(inClause('runtime_id', filters.runtimeId));
  if (filters.userId.length) parts.push(inClause('user_id', filters.userId));
  if (filters.status.length) parts.push(inClause('status', filters.status));
  if (filters.costSource.length) parts.push(inClause('cost_source', filters.costSource));

  if (filters.currency.length) {
    const named = filters.currency.filter((value) => value !== 'none');
    const sub: string[] = [];
    if (named.length) sub.push(inClause('currency', named));
    if (named.length !== filters.currency.length) sub.push('currency IS NULL');
    parts.push(`(${sub.join(' OR ')})`);
  }

  if (filters.tag.length) {
    parts.push(`seq IN (SELECT ledger_seq FROM usage_ledger_tags WHERE ${inClause('tag', filters.tag)})`);
  }

  return { sql: parts.join(' AND '), params };
}

export function buildGroupsSql(groupBy: readonly RollupDimension[], tsCol: string, whereSql: string, tagJoin: boolean): string {
  const keyCols = groupBy.map((dim, i) => `${dimExprSql(dim, tsCol)} AS k${i}`).join(',\n      ');
  const tokenCols = TOKEN_KINDS.map(
    (kind) => `SUM(${TOKEN_COLUMNS[kind]}) AS ${kind}_sum,\n      COUNT(${TOKEN_COLUMNS[kind]}) AS ${kind}_reported`
  ).join(',\n      ');
  const groupByCols = groupBy.map((_, i) => `k${i}`).join(', ');
  const join = tagJoin ? 'LEFT JOIN usage_ledger_tags t ON t.ledger_seq = usage_ledger.seq' : '';
  return `
    SELECT
      ${keyCols},
      COUNT(*) AS calls_total,
      SUM(CASE WHEN event_type = 'llm.usage' THEN 1 ELSE 0 END) AS calls_succeeded,
      SUM(CASE WHEN event_type = 'llm.failed' THEN 1 ELSE 0 END) AS calls_failed,
      ${tokenCols},
      COUNT(*) - COUNT(cost) AS unknown_cost_calls,
      MIN(${tsCol}) AS first_at,
      MAX(${tsCol}) AS last_at
    FROM usage_ledger
    ${join}
    WHERE ${whereSql}
    GROUP BY ${groupByCols}
  `;
}

function buildGroupCostSql(groupBy: readonly RollupDimension[], tsCol: string, whereSql: string, tagJoin: boolean): string {
  const keyCols = groupBy.map((dim, i) => `${dimExprSql(dim, tsCol)} AS k${i}`).join(',\n      ');
  const groupByCols = [...groupBy.map((_, i) => `k${i}`), 'currency', 'cost_source'].join(', ');
  const join = tagJoin ? 'LEFT JOIN usage_ledger_tags t ON t.ledger_seq = usage_ledger.seq' : '';
  return `
    SELECT
      ${keyCols},
      currency,
      cost_source,
      SUM(cost) AS cost_sum,
      COUNT(cost) AS cost_calls
    FROM usage_ledger
    ${join}
    WHERE ${whereSql} AND cost IS NOT NULL
    GROUP BY ${groupByCols}
  `;
}

export function buildTotalsSql(tsCol: string, whereSql: string): string {
  const tokenCols = TOKEN_KINDS.map(
    (kind) => `SUM(${TOKEN_COLUMNS[kind]}) AS ${kind}_sum,\n      COUNT(${TOKEN_COLUMNS[kind]}) AS ${kind}_reported`
  ).join(',\n      ');
  return `
    SELECT
      COUNT(*) AS calls_total,
      SUM(CASE WHEN event_type = 'llm.usage' THEN 1 ELSE 0 END) AS calls_succeeded,
      SUM(CASE WHEN event_type = 'llm.failed' THEN 1 ELSE 0 END) AS calls_failed,
      ${tokenCols},
      COUNT(*) - COUNT(cost) AS unknown_cost_calls,
      MIN(${tsCol}) AS first_at,
      MAX(${tsCol}) AS last_at,
      SUM(CASE WHEN origin = 'backfill' THEN 1 ELSE 0 END) AS backfilled_rows,
      SUM(CASE WHEN legacy_contract = 1 THEN 1 ELSE 0 END) AS legacy_contract_rows
    FROM usage_ledger
    WHERE ${whereSql}
  `;
}

function buildTotalsCostSql(whereSql: string): string {
  return `
    SELECT currency, cost_source, SUM(cost) AS cost_sum, COUNT(cost) AS cost_calls
    FROM usage_ledger
    WHERE ${whereSql} AND cost IS NOT NULL
    GROUP BY currency, cost_source
  `;
}

function keyFromRow(row: Record<string, unknown>, groupBy: readonly RollupDimension[]): Partial<Record<RollupDimension, string | null>> {
  const key: Partial<Record<RollupDimension, string | null>> = {};
  groupBy.forEach((dim, i) => {
    const value = row[`k${i}`];
    key[dim] = value === undefined ? null : (value as string | null);
  });
  return key;
}

/** Runs every statement of one rollup inside a single read transaction (rule 9: no write can land between them),
 * so `asOf`, the groups and `totals` are all computed against the exact same ledger snapshot. */
export function computeSqliteRollup(db: DatabaseSync, query: RollupQuery, now: () => number = Date.now): UsageRollupResponse {
  const tsCol = query.filters.timeBasis === 'occurred' ? 'occurred_at' : 'received_at';
  const tagJoin = query.groupBy.includes('tag');
  const needsOffset = query.groupBy.includes('day');

  db.exec('BEGIN');
  try {
    const maxSeqRow = db.prepare('SELECT MAX(seq) AS maxSeq FROM usage_ledger').get() as { maxSeq: number | null };
    const maxSeq = maxSeqRow.maxSeq === null || maxSeqRow.maxSeq === undefined ? null : Number(maxSeqRow.maxSeq);
    const ledgerSeq = maxSeq === null ? null : query.filters.asOfSeq !== null ? Math.min(query.filters.asOfSeq, maxSeq) : maxSeq;

    let lastRowReceivedAt: number | null = null;
    if (ledgerSeq !== null) {
      const row = db.prepare('SELECT received_at AS receivedAt FROM usage_ledger WHERE seq = :seq').get({ seq: ledgerSeq }) as
        | { receivedAt: number }
        | undefined;
      lastRowReceivedAt = row ? Number(row.receivedAt) : null;
    }

    const { sql: whereSql, params: whereParams } = buildWhere(query.filters, tsCol, ledgerSeq);
    const groupParams: Record<string, SqlParam> = needsOffset
      ? { ...whereParams, offsetMs: query.filters.utcOffsetMinutes * 60_000 }
      : whereParams;

    const groupRows = db.prepare(buildGroupsSql(query.groupBy, tsCol, whereSql, tagJoin)).all(groupParams) as Array<Record<string, unknown>>;
    const costRows = db
      .prepare(buildGroupCostSql(query.groupBy, tsCol, whereSql, tagJoin))
      .all(groupParams) as Array<Record<string, unknown>>;

    const groupsMap = new Map<string, RawAggregate>();
    for (const row of groupRows) {
      const key = keyFromRow(row, query.groupBy);
      const agg = newRawAggregate(key);
      agg.callsTotal = Number(row.calls_total);
      agg.callsSucceeded = Number(row.calls_succeeded ?? 0);
      agg.callsFailed = Number(row.calls_failed ?? 0);
      for (const kind of TOKEN_KINDS) {
        const sum = row[`${kind}_sum`];
        agg.tokenSums[kind] = sum === null || sum === undefined ? 0 : Number(sum);
        agg.tokenReported[kind] = Number(row[`${kind}_reported`] ?? 0);
      }
      agg.unknownCostCalls = Number(row.unknown_cost_calls ?? 0);
      agg.firstAt = row.first_at === null || row.first_at === undefined ? null : Number(row.first_at);
      agg.lastAt = row.last_at === null || row.last_at === undefined ? null : Number(row.last_at);
      groupsMap.set(keyToString(key, query.groupBy), agg);
    }
    for (const row of costRows) {
      const key = keyFromRow(row, query.groupBy);
      const agg = groupsMap.get(keyToString(key, query.groupBy));
      if (!agg) continue;
      const currency = (row.currency as string | null) ?? null;
      const costSource = row.cost_source as CostSource;
      agg.costEntries.set(`${currency ?? '\u0000'}|${costSource}`, {
        currency,
        costSource,
        sum: Number(row.cost_sum),
        calls: Number(row.cost_calls),
      });
    }

    const totalsRow = db.prepare(buildTotalsSql(tsCol, whereSql)).get(whereParams) as Record<string, unknown>;
    const totalsCostRows = db.prepare(buildTotalsCostSql(whereSql)).all(whereParams) as Array<Record<string, unknown>>;

    const totals = newRawAggregate({});
    totals.callsTotal = Number(totalsRow.calls_total ?? 0);
    totals.callsSucceeded = Number(totalsRow.calls_succeeded ?? 0);
    totals.callsFailed = Number(totalsRow.calls_failed ?? 0);
    for (const kind of TOKEN_KINDS) {
      const sum = totalsRow[`${kind}_sum`];
      totals.tokenSums[kind] = sum === null || sum === undefined ? 0 : Number(sum);
      totals.tokenReported[kind] = Number(totalsRow[`${kind}_reported`] ?? 0);
    }
    totals.unknownCostCalls = Number(totalsRow.unknown_cost_calls ?? 0);
    totals.firstAt = totalsRow.first_at === null || totalsRow.first_at === undefined ? null : Number(totalsRow.first_at);
    totals.lastAt = totalsRow.last_at === null || totalsRow.last_at === undefined ? null : Number(totalsRow.last_at);
    for (const row of totalsCostRows) {
      const currency = (row.currency as string | null) ?? null;
      const costSource = row.cost_source as CostSource;
      totals.costEntries.set(`${currency ?? '\u0000'}|${costSource}`, {
        currency,
        costSource,
        sum: Number(row.cost_sum),
        calls: Number(row.cost_calls),
      });
    }

    const backfilledRows = Number(totalsRow.backfilled_rows ?? 0);
    const legacyContractRows = Number(totalsRow.legacy_contract_rows ?? 0);

    // Retention (#70) purges `usage_ledger` rows by `received_at` and records the highest cutoff it ever reached
    // in `retention_state`, independently of whether anything was deleted this run. Read inside the same
    // transaction as every other statement above so this answer is consistent with the rows actually queried.
    const purgeRow = db.prepare("SELECT purged_before FROM retention_state WHERE scope = 'usage_ledger'").get() as
      | { purged_before: number | null }
      | undefined;
    const purgedThrough = purgeRow?.purged_before ?? null;

    db.exec('COMMIT');

    return shapeRollupResponse({
      groups: [...groupsMap.values()],
      totals,
      query,
      asOf: { ledgerSeq, lastRowReceivedAt, generatedAt: now() },
      coverage: {
        storage: 'sqlite',
        complete: !rangeReachesPurge(purgedThrough, query.filters.from),
        droppedRows: 0,
        purgedThrough,
        backfilledRows,
        legacyContractRows,
      },
    });
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Already rolled back (for example if COMMIT itself threw).
    }
    throw error;
  }
}

export type { UsageFilterIssue };
