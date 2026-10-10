/**
 * `parseUsageFilters` (issue #67, section 2): the one query-string parser for both the calls endpoint (#67) and
 * the rollup endpoint (#66), so an identical query string selects an identical row set on both. Whichever of
 * the two issues lands first owns this file; the other reuses it unchanged except for adding its own gated
 * extras (issue #66 added `allowRollupOnly`, covering `userId`, `tag`, `asOfSeq` and `utcOffsetMinutes`, the
 * same way issue #67's own `allowCallsOnly` gates `requestId`, `traceId`, `order`, `limit` and `cursor`).
 *
 * Issue #80 added five more rollup-only keys under the same `allowRollupOnly` gate: `meetingId`, `toolCallId`,
 * `tool` (row-level equality filters) and `meetingAttribution`/`toolAttribution` (row-level equality on the
 * resolved attribution state, see `server/usage/attribution.ts`).
 *
 * Strict by design: every violation is a 400 `invalid_filter` with `issues[].path` naming the parameter,
 * never a silent fallback. `token` and `api_key` are accepted and ignored (consumed by the auth middleware in
 * `server/index.ts`); as of issue #71 that middleware is Bearer-only and `server/index.ts` already rejects any
 * `token`/`api_key` query key for the whole `/api/v1` mount before any route handler runs
 * (`rejectQueryToken`), so in practice this parser never sees them on a live request. They are still handled
 * here, inert, so the parser's own contract (testable without the Express middleware chain) matches the issue's
 * text exactly and does not quietly depend on that upstream middleware staying in place.
 */
import type { CostSource } from '../usageLedger';
import { emptyUsageFilters, isCallStatus, isCostSource, type CallStatus, type TimeBasis, type UsageFilters } from './types';
import type { MeetingAttributionState, ToolAttributionState } from './attribution';

const MEETING_ATTRIBUTION_STATES: readonly MeetingAttributionState[] = ['attributed', 'unattributed'];
const TOOL_ATTRIBUTION_STATES: readonly ToolAttributionState[] = ['attributed', 'unattributed', 'unresolved', 'ambiguous'];

function isMeetingAttributionState(value: string): value is MeetingAttributionState {
  return (MEETING_ATTRIBUTION_STATES as readonly string[]).includes(value);
}

function isToolAttributionState(value: string): value is ToolAttributionState {
  return (TOOL_ATTRIBUTION_STATES as readonly string[]).includes(value);
}

export interface UsageFilterIssue {
  path: string;
  message: string;
}

export interface ParsedUsageFilters {
  filters: UsageFilters;
  order: 'desc' | 'asc';
  limit: number;
  /** Raw cursor string, not yet decoded: decoding needs the store epoch and is done by the caller. */
  cursor: string | null;
}

export type ParseUsageFiltersResult = { ok: true; value: ParsedUsageFilters } | { ok: false; issues: UsageFilterIssue[] };

export interface ParseUsageFiltersOptions {
  /** True for the calls route (#67): accepts `requestId`, `traceId`, `order`, `limit`, `cursor`. False for the
   * rollup route (#66), where those keys do not exist and are rejected as unknown parameters. */
  allowCallsOnly: boolean;
  /** True for the rollup route (#66): accepts `userId`, `tag`, `asOfSeq`, `utcOffsetMinutes`. False (or
   * omitted) for the calls route, where those keys do not exist and are rejected as unknown parameters.
   * Rollup's own `groupBy`/`sort`/`limit` are never parsed here at all (its `limit` means something different,
   * with a different valid range, from the calls route's pagination `limit`): the rollup route strips them from
   * the query object it passes in and parses them itself (`server/usage/rollup.ts`). */
  allowRollupOnly?: boolean;
}

const IGNORED_KEYS = new Set(['token', 'api_key']);

const SHARED_REPEATABLE_KEYS = [
  'agentId',
  'sessionId',
  'runtimeId',
  'taskId',
  'provider',
  'model',
  'status',
  'costSource',
  'currency',
] as const;

const SHARED_SINGLE_KEYS = ['from', 'to', 'timeBasis'] as const;

const CALLS_ONLY_REPEATABLE_KEYS = ['requestId'] as const;
const CALLS_ONLY_SINGLE_KEYS = ['traceId', 'order', 'limit', 'cursor'] as const;

const ROLLUP_ONLY_REPEATABLE_KEYS = [
  'userId',
  'tag',
  'meetingId',
  'toolCallId',
  'tool',
  'meetingAttribution',
  'toolAttribution',
] as const;
const ROLLUP_ONLY_SINGLE_KEYS = ['asOfSeq', 'utcOffsetMinutes'] as const;

const MAX_VALUES_PER_KEY = 100;
const MAX_LIMIT = 1000;

const EPOCH_MS_PATTERN = /^\d+$/;
/** ISO 8601 date-time with an explicit offset (`Z` or `+hh:mm`/`-hh:mm`); a date-only value or one without an
 * offset is rejected, so the window never depends on the server's own time zone. */
const ISO_WITH_OFFSET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

function parseTimeBound(raw: string): number | null {
  if (EPOCH_MS_PATTERN.test(raw)) {
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  }
  if (ISO_WITH_OFFSET_PATTERN.test(raw)) {
    const value = Date.parse(raw);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/** Reads one repeatable parameter from `query`, validating its shape (string, or array of non-empty strings,
 * capped at `MAX_VALUES_PER_KEY`) and pushing any issue found under `key` to `issues`. Returns `[]` on any
 * problem, so the caller can keep validating the rest of the query string instead of stopping at the first
 * error. */
function readRepeatable(query: Record<string, unknown>, key: string, issues: UsageFilterIssue[]): string[] {
  const raw = query[key];
  if (raw === undefined) return [];
  let values: unknown[];
  if (typeof raw === 'string') {
    values = [raw];
  } else if (Array.isArray(raw)) {
    values = raw;
  } else {
    issues.push({ path: key, message: `"${key}" must be a string or a repeated string parameter` });
    return [];
  }
  if (values.length > MAX_VALUES_PER_KEY) {
    issues.push({ path: key, message: `"${key}" accepts at most ${MAX_VALUES_PER_KEY} values` });
    return [];
  }
  const strings: string[] = [];
  let bad = false;
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) {
      issues.push({ path: key, message: `Every value of "${key}" must be a non-empty string` });
      bad = true;
      continue;
    }
    strings.push(value);
  }
  return bad ? [] : strings;
}

/** Reads one non-repeatable parameter, rejecting an array (the parameter sent twice) or an empty string. */
function readSingle(query: Record<string, unknown>, key: string, issues: UsageFilterIssue[]): string | undefined {
  const raw = query[key];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    issues.push({ path: key, message: `"${key}" must not be repeated` });
    return undefined;
  }
  if (typeof raw !== 'string') {
    issues.push({ path: key, message: `"${key}" must be a string` });
    return undefined;
  }
  if (raw.length === 0) {
    issues.push({ path: key, message: `"${key}" must not be empty` });
    return undefined;
  }
  return raw;
}

export function parseUsageFilters(
  query: Record<string, unknown>,
  options: ParseUsageFiltersOptions
): ParseUsageFiltersResult {
  const issues: UsageFilterIssue[] = [];

  const allowedRepeatable = new Set<string>(SHARED_REPEATABLE_KEYS);
  const allowedSingle = new Set<string>(SHARED_SINGLE_KEYS);
  if (options.allowCallsOnly) {
    for (const key of CALLS_ONLY_REPEATABLE_KEYS) allowedRepeatable.add(key);
    for (const key of CALLS_ONLY_SINGLE_KEYS) allowedSingle.add(key);
  }
  if (options.allowRollupOnly) {
    for (const key of ROLLUP_ONLY_REPEATABLE_KEYS) allowedRepeatable.add(key);
    for (const key of ROLLUP_ONLY_SINGLE_KEYS) allowedSingle.add(key);
  }

  for (const key of Object.keys(query)) {
    if (IGNORED_KEYS.has(key)) continue;
    if (allowedRepeatable.has(key) || allowedSingle.has(key)) continue;
    issues.push({ path: key, message: `Unknown parameter "${key}"` });
  }

  const filters: UsageFilters = emptyUsageFilters();

  filters.agentId = readRepeatable(query, 'agentId', issues);
  filters.sessionId = readRepeatable(query, 'sessionId', issues);
  filters.runtimeId = readRepeatable(query, 'runtimeId', issues);
  filters.taskId = readRepeatable(query, 'taskId', issues);
  filters.provider = readRepeatable(query, 'provider', issues);
  filters.model = readRepeatable(query, 'model', issues);
  filters.status = readRepeatable(query, 'status', issues) as CallStatus[];
  filters.costSource = readRepeatable(query, 'costSource', issues) as CostSource[];
  filters.currency = readRepeatable(query, 'currency', issues);
  if (options.allowCallsOnly) {
    filters.requestId = readRepeatable(query, 'requestId', issues);
  }
  if (options.allowRollupOnly) {
    filters.userId = readRepeatable(query, 'userId', issues);
    filters.tag = readRepeatable(query, 'tag', issues);
    filters.meetingId = readRepeatable(query, 'meetingId', issues);
    filters.toolCallId = readRepeatable(query, 'toolCallId', issues);
    filters.tool = readRepeatable(query, 'tool', issues);
    filters.meetingAttribution = readRepeatable(query, 'meetingAttribution', issues) as MeetingAttributionState[];
    filters.toolAttribution = readRepeatable(query, 'toolAttribution', issues) as ToolAttributionState[];
  }

  for (const value of filters.status) {
    if (!isCallStatus(value)) issues.push({ path: 'status', message: `"${value}" is not a known status` });
  }
  for (const value of filters.costSource) {
    if (!isCostSource(value)) issues.push({ path: 'costSource', message: `"${value}" is not a known costSource` });
  }
  for (const value of filters.currency) {
    if (value !== 'none' && !CURRENCY_CODE_PATTERN.test(value)) {
      issues.push({ path: 'currency', message: `"${value}" must be an uppercase ISO 4217 code or "none"` });
    }
  }
  for (const value of filters.meetingAttribution) {
    if (!isMeetingAttributionState(value)) {
      issues.push({ path: 'meetingAttribution', message: `"${value}" must be one of ${MEETING_ATTRIBUTION_STATES.join(', ')}` });
    }
  }
  for (const value of filters.toolAttribution) {
    if (!isToolAttributionState(value)) {
      issues.push({ path: 'toolAttribution', message: `"${value}" must be one of ${TOOL_ATTRIBUTION_STATES.join(', ')}` });
    }
  }

  const fromRaw = readSingle(query, 'from', issues);
  const toRaw = readSingle(query, 'to', issues);
  let from: number | null = null;
  let to: number | null = null;
  if (fromRaw !== undefined) {
    from = parseTimeBound(fromRaw);
    if (from === null) issues.push({ path: 'from', message: '"from" must be epoch milliseconds or an ISO 8601 date-time with an explicit offset' });
  }
  if (toRaw !== undefined) {
    to = parseTimeBound(toRaw);
    if (to === null) issues.push({ path: 'to', message: '"to" must be epoch milliseconds or an ISO 8601 date-time with an explicit offset' });
  }
  if (from !== null && to !== null && from >= to) {
    issues.push({ path: 'to', message: '"from" must be strictly before "to"' });
  }
  filters.from = from;
  filters.to = to;

  const timeBasisRaw = readSingle(query, 'timeBasis', issues);
  let timeBasis: TimeBasis = 'received';
  if (timeBasisRaw !== undefined) {
    if (timeBasisRaw === 'received' || timeBasisRaw === 'occurred') {
      timeBasis = timeBasisRaw;
    } else {
      issues.push({ path: 'timeBasis', message: '"timeBasis" must be "received" or "occurred"' });
    }
  }
  filters.timeBasis = timeBasis;

  let traceId: string | null = null;
  let order: 'desc' | 'asc' = 'desc';
  let limit = 100;
  let cursor: string | null = null;

  if (options.allowCallsOnly) {
    const traceIdRaw = readSingle(query, 'traceId', issues);
    traceId = traceIdRaw ?? null;

    const orderRaw = readSingle(query, 'order', issues);
    if (orderRaw !== undefined) {
      if (orderRaw === 'desc' || orderRaw === 'asc') {
        order = orderRaw;
      } else {
        issues.push({ path: 'order', message: '"order" must be "desc" or "asc"' });
      }
    }

    const limitRaw = readSingle(query, 'limit', issues);
    if (limitRaw !== undefined) {
      if (/^\d+$/.test(limitRaw) && Number(limitRaw) >= 1 && Number(limitRaw) <= MAX_LIMIT) {
        limit = Number(limitRaw);
      } else {
        issues.push({ path: 'limit', message: `"limit" must be an integer between 1 and ${MAX_LIMIT}` });
      }
    }

    const cursorRaw = readSingle(query, 'cursor', issues);
    cursor = cursorRaw ?? null;
  }
  filters.traceId = traceId;

  if (options.allowRollupOnly) {
    const asOfSeqRaw = readSingle(query, 'asOfSeq', issues);
    if (asOfSeqRaw !== undefined) {
      if (/^\d+$/.test(asOfSeqRaw) && Number(asOfSeqRaw) >= 1) {
        filters.asOfSeq = Number(asOfSeqRaw);
      } else {
        issues.push({ path: 'asOfSeq', message: '"asOfSeq" must be an integer >= 1' });
      }
    }

    const offsetRaw = readSingle(query, 'utcOffsetMinutes', issues);
    if (offsetRaw !== undefined) {
      if (/^-?\d+$/.test(offsetRaw)) {
        const n = Number(offsetRaw);
        if (Number.isSafeInteger(n) && n >= -720 && n <= 840) {
          filters.utcOffsetMinutes = n;
        } else {
          issues.push({ path: 'utcOffsetMinutes', message: '"utcOffsetMinutes" must be between -720 and 840' });
        }
      } else {
        issues.push({ path: 'utcOffsetMinutes', message: '"utcOffsetMinutes" must be an integer' });
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  return { ok: true, value: { filters, order, limit, cursor } };
}
