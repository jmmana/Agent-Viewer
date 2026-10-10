/**
 * Client for the demo app's read-only view of the usage ledger (issue #79), over the two server APIs issue #66
 * (`GET /api/v1/usage/rollup`) and issue #67 (`GET /api/v1/usage/calls`) ship. Model Ops is the only caller: this
 * module is never imported from `src/lib` (the embeddable `@warlockcode/agent-viewer` component), enforced by
 * `tests/lib/libraryIsolation.test.ts`. It never writes to the server: both functions here only ever send `GET`.
 *
 * Every response is validated with zod before it reaches a component, the same discipline `canonicalContract.ts`
 * uses for incoming events: a server whose shape drifted from what this client expects (an old deploy, a
 * misconfigured proxy) is a `'error'` result, never a thrown exception a component has to guard against.
 *
 * Deliberate adaptation from the issue's own illustrative text: the shipped route is singular,
 * `GET /api/v1/usage/rollup` (not `/rollups`), `groupBy` dimensions are `agent`/`model`/`provider`/... (not
 * `agentId`), and the response always carries a `totals` aggregate alongside `groups` for whatever `groupBy` was
 * requested (there is no separate "no groupBy" request: `groupBy` is required, 1 to 3 dimensions). This client
 * matches the server exactly implemented by #66/#67 (`server/usage/types.ts`, `server/usage/rollup.ts`,
 * `server/usage/calls.ts`), not the issue's pre-implementation sketch.
 *
 * `meeting` and `tool` (issue #80, consumed by issue #81) add two attribution dimensions, never a time-overlap
 * guess: a row is `attributed` only through its own `meetingId` or `toolCallId`. A `meeting` group's key carries
 * `meetingId` (and `title` only when `meetingId` is non-null); a `tool` group's key carries `tool`. Both carry an
 * `attribution` object naming the state of the dimension actually requested, plus `sessionIds`/`sessionCount` for
 * `meeting`. See `server/usage/attribution.ts` for the rules this client only mirrors, never reimplements.
 */
import { z } from 'zod';
import { LLM_ERROR_KINDS } from './canonicalTypes';

export type RollupDimension =
  | 'agent'
  | 'model'
  | 'provider'
  | 'session'
  | 'task'
  | 'day'
  | 'user'
  | 'tag'
  | 'meeting'
  | 'tool';

/** `tool` dimension attribution states (issue #80). */
export type ToolAttributionState = 'attributed' | 'unattributed' | 'unresolved' | 'ambiguous';
/** `meeting` dimension attribution states: never ambiguous or unresolved (a `meetingId` link either exists or not). */
export type MeetingAttributionState = 'attributed' | 'unattributed';

export type TokenKind = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning';

export const TOKEN_KINDS: readonly TokenKind[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

export type CostSource = 'provider-reported' | 'estimated' | 'unknown';

/** `'ok'` plus every `LlmErrorKind` (issue #46): the ledger's only failure classification. There is no single
 * generic "failed" status on the wire, so a "failed calls only" filter sends every non-`'ok'` value here. */
export const FAILED_CALL_STATUSES: readonly string[] = [...LLM_ERROR_KINDS];
export const ALL_CALL_STATUSES: readonly string[] = ['ok', ...LLM_ERROR_KINDS];

const TokenKindRollupSchema = z.object({
  sum: z.number().nullable(),
  reportedCalls: z.number(),
  unreportedCalls: z.number(),
});

export type TokenKindRollup = z.infer<typeof TokenKindRollupSchema>;

const CostEntrySchema = z.object({
  currency: z.string().nullable(),
  costSource: z.enum(['provider-reported', 'estimated', 'unknown']),
  sum: z.number(),
  calls: z.number(),
});

export type CostEntry = z.infer<typeof CostEntrySchema>;

const RollupTotalsSchema = z.object({
  calls: z.object({ total: z.number(), succeeded: z.number(), failed: z.number() }),
  tokens: z.object({
    input: TokenKindRollupSchema,
    output: TokenKindRollupSchema,
    cacheRead: TokenKindRollupSchema,
    cacheWrite: TokenKindRollupSchema,
    reasoning: TokenKindRollupSchema,
  }),
  cost: z.object({ entries: z.array(CostEntrySchema), unknownCostCalls: z.number() }),
  firstAt: z.number().nullable(),
  lastAt: z.number().nullable(),
});

export type RollupTotals = z.infer<typeof RollupTotalsSchema>;

const RollupGroupSchema = RollupTotalsSchema.extend({
  key: z.record(z.string(), z.string().nullable()),
  bucketStart: z.number().optional(),
  bucketEnd: z.number().optional(),
  /** Present when `groupBy` includes `meeting` and/or `tool` (issue #80): one entry per attribution dimension
   * actually requested, always an object, never a bare string. */
  attribution: z
    .object({
      meeting: z.enum(['attributed', 'unattributed']).optional(),
      tool: z.enum(['attributed', 'unattributed', 'unresolved', 'ambiguous']).optional(),
    })
    .optional(),
  /** `meeting` groups only: distinct session ids that contributed, capped server-side. */
  sessionIds: z.array(z.string()).optional(),
  /** `meeting` groups only: the true distinct session count, uncapped even when `sessionIds` is truncated. */
  sessionCount: z.number().optional(),
});

export type RollupGroup = z.infer<typeof RollupGroupSchema>;

const RollupResponseSchema = z.object({
  schemaVersion: z.string(),
  asOf: z.object({
    ledgerSeq: z.number().nullable(),
    lastRowReceivedAt: z.number().nullable(),
    generatedAt: z.number(),
  }),
  coverage: z.object({
    storage: z.enum(['memory', 'sqlite']),
    complete: z.boolean(),
    droppedRows: z.number(),
    purgedThrough: z.number().nullable(),
    backfilledRows: z.number(),
    legacyContractRows: z.number(),
  }),
  groupsAreAdditive: z.boolean(),
  groupCount: z.number(),
  truncated: z.boolean(),
  groups: z.array(RollupGroupSchema),
  totals: RollupTotalsSchema,
});

export type RollupResponse = z.infer<typeof RollupResponseSchema>;

const CallTokensSchema = z.object({
  input: z.number().nullable(),
  output: z.number().nullable(),
  cacheRead: z.number().nullable(),
  cacheWrite: z.number().nullable(),
  reasoning: z.number().nullable(),
});

const CallRecordSchema = z.object({
  seq: z.number(),
  eventId: z.string(),
  type: z.enum(['llm.usage', 'llm.failed']),
  status: z.string(),
  backfilled: z.boolean(),
  occurredAt: z.number(),
  receivedAt: z.number(),
  agentId: z.string().nullable(),
  sessionId: z.string().nullable(),
  runtimeId: z.string().nullable(),
  taskId: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  tokens: CallTokensSchema,
  latencyMs: z.number().nullable(),
  requestId: z.string().nullable(),
  cost: z.number().nullable(),
  currency: z.string().nullable(),
  costSource: z.enum(['provider-reported', 'estimated', 'unknown']),
  errorCode: z.string().nullable(),
  trace: z.object({
    traceId: z.string().nullable(),
    parentId: z.string().nullable(),
    toolCallId: z.string().nullable(),
    meetingId: z.string().nullable(),
  }),
  userId: z.string().nullable(),
  tags: z.array(z.string()),
});

export type CallRecord = z.infer<typeof CallRecordSchema>;

const CallsResponseSchema = z.object({
  schemaVersion: z.string(),
  asOf: z.number(),
  storage: z.string(),
  data: z.array(CallRecordSchema),
  page: z.object({
    limit: z.number(),
    order: z.enum(['asc', 'desc']),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export type CallsResponse = z.infer<typeof CallsResponseSchema>;

/**
 * Every call into this module answers with one of these, never a thrown exception:
 * - `'unavailable'`: 404 or 501, the server predates the usage ledger (issue #65/#66/#67 not deployed).
 * - `'unauthorized'`: 401, the server requires a token this request did not carry (or carried a stale one).
 * - `'error'`: a network failure, a non-2xx the two cases above do not cover, or a payload that fails validation.
 */
export type LedgerResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'unavailable' }
  | { kind: 'unauthorized' }
  | { kind: 'error'; message: string };

function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

function appendQuery(search: URLSearchParams, key: string, value: string | number | readonly string[] | undefined): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) search.append(key, item);
    return;
  }
  search.append(key, String(value));
}

async function request<T>(url: string, token: string | undefined, schema: z.ZodType<T>, fetchImpl: typeof fetch): Promise<LedgerResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      // Bearer header only, never a query-string token: the server's own `openModeGuard` (issue #71) rejects a
      // `token`/`api_key` query parameter outright, and a URL is far more likely to end up in a log line.
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      cache: 'no-store',
    });
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : 'Network request failed' };
  }

  if (response.status === 401) return { kind: 'unauthorized' };
  if (response.status === 404 || response.status === 501) return { kind: 'unavailable' };
  if (!response.ok) {
    return { kind: 'error', message: `Request failed with status ${response.status}` };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { kind: 'error', message: 'Response was not valid JSON' };
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { kind: 'error', message: 'Response did not match the expected usage ledger shape' };
  }
  return { kind: 'ok', data: parsed.data };
}

export interface RollupQueryParams {
  /** 1 to 3 dimensions; the server rejects an empty or over-long list as `invalid_filter`. */
  groupBy: RollupDimension[];
  /** Epoch ms, inclusive lower bound. Omitted means "All time". */
  from?: number;
  to?: number;
  agentId?: string[];
  model?: string[];
  provider?: string[];
  status?: string[];
  /** Row-level filter, independent of `groupBy` (issue #80). */
  taskId?: string[];
  /** Row-level equality filter on the ledger's `meeting_id` (issue #80). */
  meetingId?: string[];
  /** Row-level equality filter on the ledger's `tool_call_id` (issue #80). */
  toolCallId?: string[];
  /** Row-level equality filter on the *resolved* tool name (issue #80): only matches `attributed` rows. */
  tool?: string[];
  meetingAttribution?: MeetingAttributionState[];
  toolAttribution?: ToolAttributionState[];
  sort?: 'key' | 'calls';
  limit?: number;
}

export function fetchRollup(
  base: string,
  token: string | undefined,
  params: RollupQueryParams,
  fetchImpl: typeof fetch = fetch
): Promise<LedgerResult<RollupResponse>> {
  const search = new URLSearchParams();
  appendQuery(search, 'groupBy', params.groupBy.join(','));
  appendQuery(search, 'from', params.from);
  appendQuery(search, 'to', params.to);
  appendQuery(search, 'agentId', params.agentId);
  appendQuery(search, 'model', params.model);
  appendQuery(search, 'provider', params.provider);
  appendQuery(search, 'status', params.status);
  appendQuery(search, 'taskId', params.taskId);
  appendQuery(search, 'meetingId', params.meetingId);
  appendQuery(search, 'toolCallId', params.toolCallId);
  appendQuery(search, 'tool', params.tool);
  appendQuery(search, 'meetingAttribution', params.meetingAttribution);
  appendQuery(search, 'toolAttribution', params.toolAttribution);
  appendQuery(search, 'sort', params.sort);
  appendQuery(search, 'limit', params.limit);
  return request(`${trimBase(base)}/api/v1/usage/rollup?${search.toString()}`, token, RollupResponseSchema, fetchImpl);
}

export interface CallsQueryParams {
  limit?: number;
  cursor?: string | null;
  agentId?: string[];
  model?: string[];
  provider?: string[];
  status?: string[];
  /** Epoch ms, inclusive lower bound (issue #78's per-agent call list reuses the same usage window as the
   * rollup). Omitted means "All time", same convention as `RollupQueryParams.from`. */
  from?: number;
  to?: number;
}

export function fetchCalls(
  base: string,
  token: string | undefined,
  params: CallsQueryParams = {},
  fetchImpl: typeof fetch = fetch
): Promise<LedgerResult<CallsResponse>> {
  const search = new URLSearchParams();
  appendQuery(search, 'limit', params.limit);
  appendQuery(search, 'cursor', params.cursor ?? undefined);
  appendQuery(search, 'agentId', params.agentId);
  appendQuery(search, 'model', params.model);
  appendQuery(search, 'provider', params.provider);
  appendQuery(search, 'status', params.status);
  appendQuery(search, 'from', params.from);
  appendQuery(search, 'to', params.to);
  return request(`${trimBase(base)}/api/v1/usage/calls?${search.toString()}`, token, CallsResponseSchema, fetchImpl);
}
