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
  isAttributionDimension,
  type RollupDimension,
  type RollupGroupKey,
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
import {
  ATTRIBUTION_RANK,
  SESSION_IDS_CAP,
  resolveMeetingAttribution,
  resolveToolAttribution,
  truncateFreeText,
  type AttributionState,
} from './attribution';

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
    issues.push({
      path: 'groupBy',
      message: 'is required (1 to 3 of agent, model, provider, session, task, day, user, tag, meeting, tool)',
    });
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
  key: RollupGroupKey;
  /** Issue #80: one entry per attribution dimension present in `groupBy` (`meeting` and/or `tool`). Empty for
   * every query that does not group by either. */
  attribution: Partial<Record<'meeting' | 'tool', AttributionState>>;
  /** Issue #80: populated only when `groupBy` includes `meeting`. Holds every non-null `sessionId` seen by a row
   * in this group, uncapped (capping and sorting happen once, in `shapeGroup`). */
  sessionIds: Set<string>;
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

function newRawAggregate(
  key: RollupGroupKey,
  attribution: Partial<Record<'meeting' | 'tool', AttributionState>> = {}
): RawAggregate {
  return {
    key,
    attribution,
    sessionIds: new Set(),
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

/** Stable string key for a group's identity, used to merge a cost-entries (or session-ids) row into its group
 * (both backends compute this the same way from the same `groupBy` order, so SQL and memory rows merge
 * identically). For `meeting`/`tool` (issue #80) the identity includes the attribution state, not only the
 * display value: an `unresolved`, `ambiguous` and `unattributed` tool group all display `tool: null` but must
 * never merge into one group. */
function keyToString(
  key: RollupGroupKey,
  attribution: Partial<Record<'meeting' | 'tool', AttributionState>>,
  groupBy: readonly RollupDimension[]
): string {
  return groupBy
    .map((dim) => {
      if (dim === 'meeting') {
        const value = key.meetingId;
        return `attr:${attribution.meeting ?? 'unattributed'}|${value === null || value === undefined ? '\u0000' : `s:${value}`}`;
      }
      if (dim === 'tool') {
        const value = key.tool;
        return `attr:${attribution.tool ?? 'unattributed'}|${value === null || value === undefined ? '\u0000' : `s:${value}`}`;
      }
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
  if (groupBy.includes('meeting') || groupBy.includes('tool')) {
    group.attribution = { ...raw.attribution };
  }
  if (groupBy.includes('meeting')) {
    const ids = [...raw.sessionIds].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    group.sessionCount = ids.length;
    group.sessionIds = ids.slice(0, SESSION_IDS_CAP);
  }
  return group;
}

/** Issue #80: the dimension's *sort* value. Identical to `key[dim]` for every dimension except `meeting`, whose
 * display field is named `meetingId`, not `meeting` (see `RollupGroupKey`'s doc comment). */
function sortValueFor(key: RollupGroupKey, dim: RollupDimension): string | null {
  if (dim === 'meeting') return key.meetingId ?? null;
  return key[dim] ?? null;
}

function compareByKey(a: RawAggregate, b: RawAggregate, groupBy: readonly RollupDimension[]): number {
  for (const dim of groupBy) {
    const av = sortValueFor(a.key, dim);
    const bv = sortValueFor(b.key, dim);
    if (av === bv) continue;
    if (av === null) return 1;
    if (bv === null) return -1;
    const cmp = Buffer.compare(Buffer.from(av, 'utf8'), Buffer.from(bv, 'utf8'));
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/** Issue #80, section 1's ordering rule: `[rank(meeting)?, rank(tool)?]`, in that fixed order, for whichever of
 * the two dimensions `groupBy` actually includes. An all-zero tuple (every present dimension `attributed`) always
 * sorts first; `isFullyAttributed` below uses the same test to decide what `limit` may truncate. */
function attributionRankTuple(raw: RawAggregate, groupBy: readonly RollupDimension[]): number[] {
  const tuple: number[] = [];
  if (groupBy.includes('meeting')) tuple.push(ATTRIBUTION_RANK[raw.attribution.meeting ?? 'unattributed']);
  if (groupBy.includes('tool')) tuple.push(ATTRIBUTION_RANK[raw.attribution.tool ?? 'unattributed']);
  return tuple;
}

/** A group this query's `limit` is allowed to cut: every attribution dimension in `groupBy` resolved
 * `'attributed'` for it. A group with no attribution dimension in `groupBy` at all is vacuously "fully
 * attributed" (ordinary dimensions have no attribution state to fail). */
function isFullyAttributed(raw: RawAggregate, groupBy: readonly RollupDimension[]): boolean {
  if (groupBy.includes('meeting') && (raw.attribution.meeting ?? 'unattributed') !== 'attributed') return false;
  if (groupBy.includes('tool') && (raw.attribution.tool ?? 'unattributed') !== 'attributed') return false;
  return true;
}

function compareGroups(a: RawAggregate, b: RawAggregate, groupBy: readonly RollupDimension[], sort: RollupSort): number {
  const aRank = attributionRankTuple(a, groupBy);
  const bRank = attributionRankTuple(b, groupBy);
  for (let i = 0; i < aRank.length; i++) {
    if (aRank[i] !== bRank[i]) return (aRank[i] ?? 0) - (bRank[i] ?? 0);
  }
  if (sort === 'calls' && a.callsTotal !== b.callsTotal) return b.callsTotal - a.callsTotal;
  return compareByKey(a, b, groupBy);
}

/** Adds `source`'s figures into `target` in place (issue #80's "merge after truncation" rule: two groups whose
 * free-text key collapses to the same 200-character value must still satisfy the group-sum invariant). */
function mergeRawInto(target: RawAggregate, source: RawAggregate): void {
  target.callsTotal += source.callsTotal;
  target.callsSucceeded += source.callsSucceeded;
  target.callsFailed += source.callsFailed;
  for (const kind of TOKEN_KINDS) {
    target.tokenSums[kind] += source.tokenSums[kind];
    target.tokenReported[kind] += source.tokenReported[kind];
  }
  target.unknownCostCalls += source.unknownCostCalls;
  for (const [costKey, entry] of source.costEntries) {
    const existing = target.costEntries.get(costKey);
    if (existing) {
      existing.sum += entry.sum;
      existing.calls += entry.calls;
    } else {
      target.costEntries.set(costKey, { ...entry });
    }
  }
  for (const sessionId of source.sessionIds) target.sessionIds.add(sessionId);
  if (source.firstAt !== null && (target.firstAt === null || source.firstAt < target.firstAt)) target.firstAt = source.firstAt;
  if (source.lastAt !== null && (target.lastAt === null || source.lastAt > target.lastAt)) target.lastAt = source.lastAt;
}

/** Truncates a raw group's free-text key fields (`title`, `tool`) to `FREE_TEXT_MAX_LENGTH`, then merges any
 * groups whose identity (attribution state plus truncated value) collapsed into the same bucket. A no-op unless
 * `groupBy` includes `meeting` or `tool`: every other dimension has no free-text key. */
function mergeAfterTruncation(groups: readonly RawAggregate[], groupBy: readonly RollupDimension[]): RawAggregate[] {
  if (!groupBy.includes('meeting') && !groupBy.includes('tool')) return [...groups];
  const merged = new Map<string, RawAggregate>();
  for (const raw of groups) {
    const truncatedKey: RollupGroupKey = { ...raw.key };
    if ('title' in truncatedKey) truncatedKey.title = truncateFreeText(truncatedKey.title ?? null);
    if ('tool' in truncatedKey) truncatedKey.tool = truncateFreeText(truncatedKey.tool ?? null);
    const identity = keyToString(truncatedKey, raw.attribution, groupBy);
    const existing = merged.get(identity);
    if (!existing) {
      merged.set(identity, {
        ...raw,
        key: truncatedKey,
        sessionIds: new Set(raw.sessionIds),
        costEntries: new Map(raw.costEntries),
        tokenSums: { ...raw.tokenSums },
        tokenReported: { ...raw.tokenReported },
      });
      continue;
    }
    mergeRawInto(existing, raw);
  }
  return [...merged.values()];
}

function shapeRollupResponse(args: {
  groups: RawAggregate[];
  totals: RawAggregate;
  query: RollupQuery;
  asOf: UsageRollupAsOf;
  coverage: UsageRollupCoverage;
}): UsageRollupResponse {
  const { groups, totals, query, asOf, coverage } = args;
  const mergedGroups = mergeAfterTruncation(groups, query.groupBy);
  const sorted = mergedGroups.sort((a, b) => compareGroups(a, b, query.groupBy, query.sort));
  const groupCount = sorted.length;

  // Issue #80: when `groupBy` carries an attribution dimension, `limit` may only cut *fully attributed* groups;
  // every unattributed/unresolved/ambiguous group is always returned. `sorted` already places every fully
  // attributed group before every other one (the rank tuple is the primary sort key), so filtering it keeps both
  // slices in their original relative order and concatenating them back reproduces that same fixed order.
  let page: RawAggregate[];
  let truncated: boolean;
  if (query.groupBy.some(isAttributionDimension)) {
    const attributedGroups = sorted.filter((g) => isFullyAttributed(g, query.groupBy));
    const nonAttributedGroups = sorted.filter((g) => !isFullyAttributed(g, query.groupBy));
    truncated = attributedGroups.length > query.limit;
    page = [...attributedGroups.slice(0, query.limit), ...nonAttributedGroups];
  } else {
    truncated = groupCount > query.limit;
    page = sorted.slice(0, query.limit);
  }

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

/** Memory-mode equivalent of the SQLite `tool_calls`/`meeting_labels` tables (issue #80): `server/store.ts`
 * builds this from `ServerState.toolCallNames`/`meetingTitles` (`server/serverState.ts`), which `applyEvent`
 * keeps current on every accepted event, live or replayed. */
export interface AttributionIndex {
  toolCallNames: ReadonlyMap<string, ReadonlySet<string>>;
  meetingTitles: ReadonlyMap<string, string>;
}

const EMPTY_ATTRIBUTION_INDEX: AttributionIndex = { toolCallNames: new Map(), meetingTitles: new Map() };

/** Exported for the export route (issue #69), which reuses this unchanged instead of re-deriving the same
 * non-seq filter semantics for its own row stream (`server/usage/export.ts`). `attributionIndex` is only
 * consulted when `filters.tool`/`meetingAttribution`/`toolAttribution` is non-empty (issue #80); every other
 * caller, including the export route, never sets those and so never needs to pass one. */
export function rowMatchesFilters(row: UsageLedgerRow, filters: UsageFilters, attributionIndex: AttributionIndex = EMPTY_ATTRIBUTION_INDEX): boolean {
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
  if (!matchesSet(row.meetingId, filters.meetingId)) return false;
  if (!matchesSet(row.toolCallId, filters.toolCallId)) return false;
  if (filters.tool.length > 0 || filters.toolAttribution.length > 0) {
    const resolved = resolveToolAttribution(row, attributionIndex.toolCallNames);
    if (filters.tool.length > 0 && (resolved.attribution !== 'attributed' || !filters.tool.includes(resolved.tool ?? ''))) return false;
    if (filters.toolAttribution.length > 0 && !(filters.toolAttribution as readonly string[]).includes(resolved.attribution)) return false;
  }
  if (filters.meetingAttribution.length > 0) {
    const resolved = resolveMeetingAttribution(row.meetingId, attributionIndex.meetingTitles);
    if (!(filters.meetingAttribution as readonly string[]).includes(resolved.attribution)) return false;
  }
  return true;
}

function dayKeyFor(tsValue: number, utcOffsetMinutes: number): string {
  const localMs = tsValue + utcOffsetMinutes * 60_000;
  return new Date(localMs).toISOString().slice(0, 10);
}

function dimValue(
  row: UsageLedgerRow,
  dim: Exclude<RollupDimension, 'tag' | 'meeting' | 'tool'>,
  tsValue: number,
  utcOffsetMinutes: number
): string | null {
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

interface ResolvedGroupKey {
  key: RollupGroupKey;
  attribution: Partial<Record<'meeting' | 'tool', AttributionState>>;
}

function buildGroupKey(
  row: UsageLedgerRow,
  groupBy: readonly RollupDimension[],
  tsValue: number,
  utcOffsetMinutes: number,
  tagOverride: string | null | undefined,
  attributionIndex: AttributionIndex
): ResolvedGroupKey {
  const key: RollupGroupKey = {};
  const attribution: Partial<Record<'meeting' | 'tool', AttributionState>> = {};
  for (const dim of groupBy) {
    if (dim === 'tag') {
      key.tag = tagOverride ?? null;
      continue;
    }
    if (dim === 'meeting') {
      const resolved = resolveMeetingAttribution(row.meetingId, attributionIndex.meetingTitles);
      key.meetingId = resolved.meetingId;
      if (resolved.meetingId !== null) key.title = resolved.title;
      attribution.meeting = resolved.attribution;
      continue;
    }
    if (dim === 'tool') {
      const resolved = resolveToolAttribution(row, attributionIndex.toolCallNames);
      key.tool = resolved.tool;
      attribution.tool = resolved.attribution;
      continue;
    }
    key[dim] = dimValue(row, dim, tsValue, utcOffsetMinutes);
  }
  return { key, attribution };
}

function accumulateRow(agg: RawAggregate, row: UsageLedgerRow, tsValue: number, trackSessionId: boolean): void {
  if (trackSessionId && row.sessionId !== null) agg.sessionIds.add(row.sessionId);
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
  query: RollupQuery,
  attributionIndex: AttributionIndex = EMPTY_ATTRIBUTION_INDEX
): { groups: RawAggregate[]; totals: RawAggregate } {
  const groupsMap = new Map<string, RawAggregate>();
  const totals = newRawAggregate({});
  const groupsByTag = query.groupBy.includes('tag');
  const trackSessionId = query.groupBy.includes('meeting');

  for (const row of rows) {
    if (!rowMatchesFilters(row, query.filters, attributionIndex)) continue;
    const tsValue = tsOf(row, query.filters.timeBasis);
    accumulateRow(totals, row, tsValue, false);

    const tagValues: Array<string | null> = groupsByTag ? (row.tags.length > 0 ? row.tags : [null]) : [undefined as any];
    for (const tagValue of tagValues) {
      const { key, attribution } = buildGroupKey(row, query.groupBy, tsValue, query.filters.utcOffsetMinutes, tagValue, attributionIndex);
      const keyStr = keyToString(key, attribution, query.groupBy);
      let agg = groupsMap.get(keyStr);
      if (!agg) {
        agg = newRawAggregate(key, attribution);
        groupsMap.set(keyStr, agg);
      }
      accumulateRow(agg, row, tsValue, trackSessionId);
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
  /** Issue #80. Defaults to an empty index (no row ever resolves to `attributed`) so a caller that does not pass
   * one still gets a well-defined, honestly-unattributed answer instead of a crash. */
  attributionIndex?: AttributionIndex;
}

export function computeMemoryRollup(input: MemoryRollupInput): UsageRollupResponse {
  const { ledger, query, now, coverage, attributionIndex = EMPTY_ATTRIBUTION_INDEX } = input;
  const maxSeq = ledger.length > 0 ? ledger[ledger.length - 1]!.seq : null;
  const ledgerSeq = maxSeq === null ? null : query.filters.asOfSeq !== null ? Math.min(query.filters.asOfSeq, maxSeq) : maxSeq;
  const lastRowReceivedAt = ledgerSeq === null ? null : (ledger.find((row) => row.seq === ledgerSeq)?.receivedAt ?? null);

  // Export-only (issue #69): `afterSeq` is `null` for every rollup-route query, so this is a no-op for #66's own
  // route; the export's totals sidecar sets it to pin the same `(afterSeq, asOfSeq]` window this aggregation runs
  // over.
  const afterSeq = query.filters.afterSeq;
  const eligible = ledgerSeq === null ? [] : ledger.filter((row) => row.seq <= ledgerSeq && (afterSeq === null || row.seq > afterSeq));
  const { groups, totals } = computeMemoryAggregates(eligible, query, attributionIndex);

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
      backfilledRows: totals.callsTotal > 0 ? countBackfilled(eligible, query, attributionIndex) : 0,
      legacyContractRows: totals.callsTotal > 0 ? countLegacyContract(eligible, query, attributionIndex) : 0,
    },
  });
}

function countBackfilled(rows: readonly UsageLedgerRow[], query: RollupQuery, attributionIndex: AttributionIndex): number {
  let count = 0;
  for (const row of rows) {
    if (rowMatchesFilters(row, query.filters, attributionIndex) && row.origin === 'backfill') count++;
  }
  return count;
}

function countLegacyContract(rows: readonly UsageLedgerRow[], query: RollupQuery, attributionIndex: AttributionIndex): number {
  let count = 0;
  for (const row of rows) {
    if (rowMatchesFilters(row, query.filters, attributionIndex) && row.legacyContract) count++;
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

const DIMENSION_COLUMNS: Record<Exclude<RollupDimension, 'day' | 'tag' | 'meeting' | 'tool'>, string> = {
  agent: 'usage_ledger.agent_id',
  model: 'usage_ledger.model',
  provider: 'usage_ledger.provider',
  session: 'usage_ledger.session_id',
  task: 'usage_ledger.task_id',
  user: 'usage_ledger.user_id',
};

/**
 * `tool` dimension key expression (issue #80): one string that encodes both the attribution state and the
 * resolved name, so two groups with the same (null) displayed name but different states (`unresolved` versus
 * `ambiguous` versus `unattributed`) never merge under `GROUP BY`. Decoded back by `keyFromRow`. `tcr` is
 * `tool_call_resolution` (see `ATTRIBUTION_JOINS`), one row per `(session_id, agent_id, tool_call_id)` scope with
 * the distinct tool name when there is exactly one, `NULL` otherwise.
 */
const TOOL_KEY_EXPR = `
  CASE
    WHEN usage_ledger.tool_call_id IS NULL THEN 'U|'
    WHEN tcr.tool_call_id IS NULL THEN 'R|'
    WHEN tcr.ambiguous = 1 THEN 'A|'
    ELSE 'T|' || tcr.resolved_tool
  END
`;

/** `meeting` dimension key expression (issue #80): encodes attribution state plus the raw `meeting_id` (never
 * the title, which is looked up separately so a `meetingId` with no label still groups as `attributed`). */
const MEETING_KEY_EXPR = `
  CASE WHEN usage_ledger.meeting_id IS NULL THEN 'U|' ELSE 'T|' || usage_ledger.meeting_id END
`;

/**
 * `tool_call_resolution` LEFT JOIN, needed whenever a query resolves the `tool` dimension or filters by
 * `tool`/`toolAttribution` (issue #80). Added only when `needed` is true (`toolJoinNeeded`, computed once per
 * query in `computeSqliteRollup`): the 100,000-row scale budget requires every indexed filter to produce a
 * `SEARCH`, never a bare scan or an extra `MATERIALIZE` (`tests/usage-rollup-scale.test.mjs`), and an unconditional
 * join defeated that for every query, including ones that never touch `tool` at all. At most one matching row per
 * `usage_ledger` row (the view is grouped to one row per scope), so it can never fan rows out when it is added. */
function toolResolutionJoin(needed: boolean): string {
  if (!needed) return '';
  return `
  LEFT JOIN tool_call_resolution tcr
    ON usage_ledger.tool_call_id IS NOT NULL
   AND tcr.session_id = COALESCE(usage_ledger.session_id, '')
   AND tcr.agent_id = COALESCE(usage_ledger.agent_id, '')
   AND tcr.tool_call_id = usage_ledger.tool_call_id
  `;
}

/** `meeting_labels` LEFT JOIN, needed only by `buildGroupsSql` when `groupBy` includes `meeting` (the one place
 * that selects a title). No filter ever needs it: `meetingAttribution`/`meetingId` only test `usage_ledger`'s own
 * `meeting_id` column (see `buildWhere`), never the label. At most one matching row (primary key equality). */
function meetingLabelJoin(needed: boolean): string {
  return needed ? 'LEFT JOIN meeting_labels ml ON ml.meeting_id = usage_ledger.meeting_id' : '';
}

function dimExprSql(dim: RollupDimension, tsCol: string): string {
  if (dim === 'day') return `date((${tsCol} + :offsetMs) / 1000, 'unixepoch')`;
  if (dim === 'tag') return 't.tag';
  if (dim === 'tool') return TOOL_KEY_EXPR;
  if (dim === 'meeting') return MEETING_KEY_EXPR;
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

  if (filters.agentId.length) parts.push(inClause('usage_ledger.agent_id', filters.agentId));
  if (filters.model.length) parts.push(inClause('model', filters.model));
  if (filters.provider.length) parts.push(inClause('provider', filters.provider));
  if (filters.sessionId.length) parts.push(inClause('usage_ledger.session_id', filters.sessionId));
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

  // Issue #80: `agent_id`, `session_id`, `tool_call_id` and `meeting_id` are qualified with `usage_ledger.` above
  // and below because `ATTRIBUTION_JOINS` (always present in every statement using this clause) joins in
  // `tool_call_resolution`, which has its own `session_id`/`agent_id`/`tool_call_id` columns; an unqualified
  // reference would be ambiguous once that join is in scope.
  if (filters.meetingId.length) parts.push(inClause('usage_ledger.meeting_id', filters.meetingId));
  if (filters.toolCallId.length) parts.push(inClause('usage_ledger.tool_call_id', filters.toolCallId));
  if (filters.tool.length) {
    parts.push(
      `(usage_ledger.tool_call_id IS NOT NULL AND tcr.tool_call_id IS NOT NULL AND tcr.ambiguous = 0 AND ${inClause('tcr.resolved_tool', filters.tool)})`
    );
  }
  if (filters.meetingAttribution.length) {
    const sub = filters.meetingAttribution.map((state) =>
      state === 'attributed' ? 'usage_ledger.meeting_id IS NOT NULL' : 'usage_ledger.meeting_id IS NULL'
    );
    parts.push(`(${sub.join(' OR ')})`);
  }
  if (filters.toolAttribution.length) {
    const clauseFor = (state: string): string => {
      switch (state) {
        case 'unattributed':
          return 'usage_ledger.tool_call_id IS NULL';
        case 'unresolved':
          return '(usage_ledger.tool_call_id IS NOT NULL AND tcr.tool_call_id IS NULL)';
        case 'ambiguous':
          return '(usage_ledger.tool_call_id IS NOT NULL AND tcr.tool_call_id IS NOT NULL AND tcr.ambiguous = 1)';
        default:
          return '(usage_ledger.tool_call_id IS NOT NULL AND tcr.tool_call_id IS NOT NULL AND tcr.ambiguous = 0)';
      }
    };
    parts.push(`(${filters.toolAttribution.map(clauseFor).join(' OR ')})`);
  }

  return { sql: parts.join(' AND '), params };
}

/** `k{i}` SELECT list shared by the groups, group-cost and group-sessions statements: one encoded expression per
 * `groupBy` dimension (see `dimExprSql`). Never includes the `meeting` dimension's title; that is only ever
 * selected by `buildGroupsSql` itself, since it is the one statement whose output actually needs it. */
function groupKeyCols(groupBy: readonly RollupDimension[], tsCol: string): string {
  return groupBy.map((dim, i) => `${dimExprSql(dim, tsCol)} AS k${i}`).join(',\n      ');
}

function groupByKeyCols(groupBy: readonly RollupDimension[]): string {
  return groupBy.map((_, i) => `k${i}`).join(', ');
}

function joinsFor(tagJoin: boolean, toolJoin: boolean, meetingJoin = false): string {
  return `${tagJoin ? 'LEFT JOIN usage_ledger_tags t ON t.ledger_seq = usage_ledger.seq' : ''}${toolResolutionJoin(toolJoin)}${meetingLabelJoin(meetingJoin)}`;
}

export function buildGroupsSql(
  groupBy: readonly RollupDimension[],
  tsCol: string,
  whereSql: string,
  tagJoin: boolean,
  toolJoin = false
): string {
  const meetingIndex = groupBy.indexOf('meeting');
  const keyCols = meetingIndex === -1 ? groupKeyCols(groupBy, tsCol) : `${groupKeyCols(groupBy, tsCol)},\n      ml.title AS m${meetingIndex}_title`;
  const tokenCols = TOKEN_KINDS.map(
    (kind) => `SUM(${TOKEN_COLUMNS[kind]}) AS ${kind}_sum,\n      COUNT(${TOKEN_COLUMNS[kind]}) AS ${kind}_reported`
  ).join(',\n      ');
  const groupByCols =
    meetingIndex === -1 ? groupByKeyCols(groupBy) : `${groupByKeyCols(groupBy)}, m${meetingIndex}_title`;
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
    ${joinsFor(tagJoin, toolJoin, meetingIndex !== -1)}
    WHERE ${whereSql}
    GROUP BY ${groupByCols}
  `;
}

function buildGroupCostSql(groupBy: readonly RollupDimension[], tsCol: string, whereSql: string, tagJoin: boolean, toolJoin: boolean): string {
  const keyCols = groupKeyCols(groupBy, tsCol);
  const groupByCols = [...groupBy.map((_, i) => `k${i}`), 'currency', 'cost_source'].join(', ');
  return `
    SELECT
      ${keyCols},
      currency,
      cost_source,
      SUM(cost) AS cost_sum,
      COUNT(cost) AS cost_calls
    FROM usage_ledger
    ${joinsFor(tagJoin, toolJoin)}
    WHERE ${whereSql} AND cost IS NOT NULL
    GROUP BY ${groupByCols}
  `;
}

/** Issue #80: distinct `session_id` per group, only ever built when `groupBy` includes `meeting`. Merged into
 * `RawAggregate.sessionIds` the same way `buildGroupCostSql`'s rows are merged into `costEntries`. */
function buildGroupSessionsSql(groupBy: readonly RollupDimension[], tsCol: string, whereSql: string, tagJoin: boolean, toolJoin: boolean): string {
  const keyCols = groupKeyCols(groupBy, tsCol);
  const groupByCols = [...groupBy.map((_, i) => `k${i}`), 'usage_ledger.session_id'].join(', ');
  return `
    SELECT
      ${keyCols},
      usage_ledger.session_id AS session_id
    FROM usage_ledger
    ${joinsFor(tagJoin, toolJoin)}
    WHERE ${whereSql} AND usage_ledger.session_id IS NOT NULL
    GROUP BY ${groupByCols}
  `;
}

export function buildTotalsSql(tsCol: string, whereSql: string, toolJoin = false): string {
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
    ${toolResolutionJoin(toolJoin)}
    WHERE ${whereSql}
  `;
}

function buildTotalsCostSql(whereSql: string, toolJoin: boolean): string {
  return `
    SELECT currency, cost_source, SUM(cost) AS cost_sum, COUNT(cost) AS cost_calls
    FROM usage_ledger
    ${toolResolutionJoin(toolJoin)}
    WHERE ${whereSql} AND cost IS NOT NULL
    GROUP BY currency, cost_source
  `;
}

/** Decodes the `k{i}` columns of one SQLite group/cost/sessions row back into a display key plus attribution
 * state, mirroring `buildGroupKey` (memory mode) exactly so both backends produce the identical `RawAggregate`
 * shape for the same logical row set. */
function keyFromRow(row: Record<string, unknown>, groupBy: readonly RollupDimension[]): ResolvedGroupKey {
  const key: RollupGroupKey = {};
  const attribution: Partial<Record<'meeting' | 'tool', AttributionState>> = {};
  groupBy.forEach((dim, i) => {
    const raw = row[`k${i}`];
    if (dim === 'tool') {
      const encoded = raw === undefined || raw === null ? 'U|' : String(raw);
      if (encoded.startsWith('T|')) {
        attribution.tool = 'attributed';
        key.tool = encoded.slice(2);
      } else if (encoded.startsWith('R|')) {
        attribution.tool = 'unresolved';
        key.tool = null;
      } else if (encoded.startsWith('A|')) {
        attribution.tool = 'ambiguous';
        key.tool = null;
      } else {
        attribution.tool = 'unattributed';
        key.tool = null;
      }
      return;
    }
    if (dim === 'meeting') {
      const encoded = raw === undefined || raw === null ? 'U|' : String(raw);
      if (encoded.startsWith('T|')) {
        attribution.meeting = 'attributed';
        key.meetingId = encoded.slice(2);
        const titleRaw = row[`m${i}_title`];
        key.title = titleRaw === null || titleRaw === undefined ? null : String(titleRaw);
      } else {
        attribution.meeting = 'unattributed';
        key.meetingId = null;
      }
      return;
    }
    key[dim] = raw === undefined || raw === null ? null : (raw as string);
  });
  return { key, attribution };
}

/** Runs every statement of one rollup inside a single read transaction (rule 9: no write can land between them),
 * so `asOf`, the groups and `totals` are all computed against the exact same ledger snapshot. */
export function computeSqliteRollup(db: DatabaseSync, query: RollupQuery, now: () => number = Date.now): UsageRollupResponse {
  const tsCol = query.filters.timeBasis === 'occurred' ? 'occurred_at' : 'received_at';
  const tagJoin = query.groupBy.includes('tag');
  const needsOffset = query.groupBy.includes('day');
  // Issue #80: `tool_call_resolution` is only joined when a statement actually needs it, so every query that
  // never touches `tool` keeps its original (indexed) query plan. See `toolResolutionJoin`'s doc comment.
  const toolJoin = query.groupBy.includes('tool') || query.filters.tool.length > 0 || query.filters.toolAttribution.length > 0;

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

    const groupRows = db
      .prepare(buildGroupsSql(query.groupBy, tsCol, whereSql, tagJoin, toolJoin))
      .all(groupParams) as Array<Record<string, unknown>>;
    const costRows = db
      .prepare(buildGroupCostSql(query.groupBy, tsCol, whereSql, tagJoin, toolJoin))
      .all(groupParams) as Array<Record<string, unknown>>;

    const groupsMap = new Map<string, RawAggregate>();
    for (const row of groupRows) {
      const { key, attribution } = keyFromRow(row, query.groupBy);
      const agg = newRawAggregate(key, attribution);
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
      groupsMap.set(keyToString(key, attribution, query.groupBy), agg);
    }
    for (const row of costRows) {
      const { key, attribution } = keyFromRow(row, query.groupBy);
      const agg = groupsMap.get(keyToString(key, attribution, query.groupBy));
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
    if (query.groupBy.includes('meeting')) {
      const sessionRows = db
        .prepare(buildGroupSessionsSql(query.groupBy, tsCol, whereSql, tagJoin, toolJoin))
        .all(groupParams) as Array<Record<string, unknown>>;
      for (const row of sessionRows) {
        const { key, attribution } = keyFromRow(row, query.groupBy);
        const agg = groupsMap.get(keyToString(key, attribution, query.groupBy));
        if (!agg) continue;
        const sessionId = row.session_id;
        if (typeof sessionId === 'string') agg.sessionIds.add(sessionId);
      }
    }

    const totalsRow = db.prepare(buildTotalsSql(tsCol, whereSql, toolJoin)).get(whereParams) as Record<string, unknown>;
    const totalsCostRows = db
      .prepare(buildTotalsCostSql(whereSql, toolJoin))
      .all(whereParams) as Array<Record<string, unknown>>;

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
