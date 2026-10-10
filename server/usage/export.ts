/**
 * `GET /api/v1/usage/export` and `GET /api/v1/usage/export/totals` (issue #69): CSV/JSONL streaming export of the
 * usage ledger (#65), and its per-currency reconciliation totals. This module holds everything that can be pure
 * and unit-tested without an HTTP response or a database: query parsing, the `UsageLedgerRow -> ExportCallRecord`
 * mapping (the only allowed source of text cells is the #68 redactor, applied per field), the CSV/JSONL row
 * formatters (quoting, the formula-injection guard, decimal formatting, tag escaping) and the totals reshaping.
 * `server/index.ts` owns the HTTP streaming, the row-count/concurrency guards and the response headers;
 * `server/store.ts` owns `iterateExportRows`, the one piece of I/O this feature adds.
 *
 * Totals are never summed a second time here: `shapeExportTotals` only reshapes the `UsageRollupResponse` the
 * caller already got from `store.rollup()` (issue #66) into this issue's own response contract. The one
 * deliberate simplification from the issue's illustrative example (not tested by its acceptance criteria): rollup
 * has no `status` dimension to group by, so `byStatus` here is the coarse `{ succeeded, failed }` rollup already
 * tracks, not a per-`errorKind` breakdown. Getting a finer breakdown would mean either extending rollup's grouping
 * dimensions (out of this issue's scope, and #66 is a separate, closed issue) or counting rows a second time with
 * a dedicated query, which is exactly the "a second implementation" this module is built to avoid for the figures
 * that actually matter for reconciliation (cost, tokens).
 */
import type { CostSource, UsageLedgerRow } from '../usageLedger';
import { parseUsageFilters, type UsageFilterIssue } from './filters';
import { redactText, type RedactionPolicy } from '../../src/integrations/redaction';
import { TOKEN_KINDS, type TokenKind, type UsageFilters, type UsageRollupResponse } from './types';

export const EXPORT_SCHEMA = 'agent-viewer.usage-export/1';

export type ExportFormat = 'csv' | 'jsonl';

/** Thrown by the query parsers below; the route layer catches it and maps `code` to the matching HTTP status
 * (400 for every code here) and response body. */
export class ExportQueryError extends Error {
  constructor(
    readonly code: 'invalid_format' | 'unsupported_parameter' | 'invalid_filter',
    readonly detail: { parameters: string[] } | { issues: UsageFilterIssue[] } | undefined = undefined
  ) {
    super(code);
    this.name = 'ExportQueryError';
  }
}

/** Parameters that belong to the rollup route's own grouping/bucketing, never to an export or totals request
 * (issue #69's own rule: "Grouping/bucketing parameters of the rollup are rejected with 400
 * unsupported_parameter"). `limit` is rollup's own pagination-of-groups parameter (parsed outside the shared
 * filter parser, see `server/usage/rollup.ts`), not the calls route's `limit`, which the shared parser already
 * rejects as unknown for a rollup-shaped query. */
const ROLLUP_GROUPING_KEYS = ['groupBy', 'sort', 'limit'] as const;

const AFTER_SEQ_PATTERN = /^\d+$/;
const ASOF_SEQ_PATTERN = /^\d+$/;

function readOwnKey(query: Record<string, unknown>, key: string): string | undefined {
  const raw = query[key];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[raw.length - 1] : (raw as string);
}

/**
 * Shared by `parseExportQuery` and `parseExportTotalsQuery`: strips `afterSeq` (export-only, never part of the
 * shared `parseUsageFilters` contract) and the rollup-only grouping keys out of `query` before handing the rest
 * to `parseUsageFilters`, then sets `afterSeq` on the returned `UsageFilters` directly. Throws `ExportQueryError`
 * on any problem; never returns a half-valid result.
 */
function parseExportFilters(query: Record<string, unknown>): UsageFilters {
  const present = ROLLUP_GROUPING_KEYS.filter((key) => query[key] !== undefined);
  if (present.length > 0) {
    throw new ExportQueryError('unsupported_parameter', { parameters: present });
  }

  const { afterSeq: afterSeqRaw, ...rest } = query;
  const issues: UsageFilterIssue[] = [];
  let afterSeq: number | null = null;
  if (afterSeqRaw !== undefined) {
    const raw = readOwnKey(query, 'afterSeq');
    if (typeof raw !== 'string' || !AFTER_SEQ_PATTERN.test(raw)) {
      issues.push({ path: 'afterSeq', message: '"afterSeq" must be a non-negative integer' });
    } else {
      afterSeq = Number(raw);
    }
  }

  const parsed = parseUsageFilters(rest, { allowCallsOnly: false, allowRollupOnly: true });
  if (!parsed.ok) issues.push(...parsed.issues);
  if (issues.length > 0) throw new ExportQueryError('invalid_filter', { issues });
  if (!parsed.ok) throw new ExportQueryError('invalid_filter', { issues }); // unreachable, mirrors rollup.ts's own guard

  const filters = parsed.value.filters;
  filters.afterSeq = afterSeq;
  if (afterSeq !== null && filters.asOfSeq !== null && afterSeq >= filters.asOfSeq) {
    throw new ExportQueryError('invalid_filter', {
      issues: [{ path: 'afterSeq', message: '"afterSeq" must be strictly less than "asOfSeq"' }],
    });
  }
  return filters;
}

export interface ExportQuery {
  format: ExportFormat;
  bom: boolean;
  filters: UsageFilters;
}

/** `GET /api/v1/usage/export`: `format` is required (`csv` or `jsonl`, else `400 invalid_format`), `bom` is an
 * optional boolean flag (CSV only; accepted and ignored for JSONL per the issue's own text), everything else is
 * the shared filter set plus `afterSeq`/`asOfSeq`. */
export function parseExportQuery(query: Record<string, unknown>): ExportQuery {
  const formatRaw = readOwnKey(query, 'format');
  if (formatRaw !== 'csv' && formatRaw !== 'jsonl') {
    throw new ExportQueryError('invalid_format');
  }
  const bomRaw = readOwnKey(query, 'bom');
  const bom = bomRaw === 'true';

  const { format: _format, bom: _bom, ...rest } = query;
  const filters = parseExportFilters(rest);
  return { format: formatRaw, bom, filters };
}

/** `GET /api/v1/usage/export/totals`: no `format`/`bom` (`400 unsupported_parameter` if present), otherwise the
 * same filter set as `parseExportQuery`. */
export function parseExportTotalsQuery(query: Record<string, unknown>): UsageFilters {
  const present = (['format', 'bom'] as const).filter((key) => query[key] !== undefined);
  if (present.length > 0) {
    throw new ExportQueryError('unsupported_parameter', { parameters: present });
  }
  return parseExportFilters(query);
}

// -------------------------------------------------------------
// Row mapping: UsageLedgerRow -> ExportCallRecord, redaction applied per field (section 1 of the issue)
// -------------------------------------------------------------

export interface ExportCallRecord {
  ledgerSeq: number;
  eventId: string;
  requestId: string | null;
  receivedAt: string;
  occurredAt: string;
  status: string;
  provider: string | null;
  model: string | null;
  runtimeId: string | null;
  sessionId: string | null;
  agentId: string | null;
  taskId: string | null;
  traceId: string | null;
  parentId: string | null;
  toolCallId: string | null;
  userId: string | null;
  tags: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  latencyMs: number | null;
  cost: number | null;
  currency: string | null;
  costSource: CostSource;
  /** Always `null`: `usage_ledger.summary` (migration `usage-ledger-summary`, issue #69) is `null` for every row
   * written before that migration, since the table is append-only and cannot be backfilled. A row written after
   * it carries the redacted `event.summary` like every other text column here. */
  summary: string | null;
  redacted: boolean;
}

/**
 * Maps one ledger row to its export record. Every text field listed in the issue's redaction rule (columns 2, 3,
 * 7 to 17, 25, 27: `eventId`, `requestId`, `provider`, `model`, `runtimeId`, `sessionId`, `agentId`, `taskId`,
 * `traceId`, `parentId`, `toolCallId`, `userId`, `tags`, `currency`, `summary`) goes through `redactText`
 * individually; `status` and `costSource` are validated enums and are never redacted; `receivedAt`/`occurredAt`
 * are server/client clock timestamps, not attacker-controlled text, and are never redacted either (though they
 * still pass through the CSV formula guard at serialization time, like every text cell, since a guard that never
 * fires costs nothing and a carve-out would be one more thing to keep in sync). `redacted` is `true` only when
 * applying `redactText` here changed some field: there is no ingestion-time redaction flag to OR it with, since
 * nothing in this codebase redacts at ingestion yet (`src/integrations/redaction.ts` ships the pure function; no
 * server route calls it before this one).
 */
export function toExportCallRecord(row: UsageLedgerRow, policy?: RedactionPolicy): ExportCallRecord {
  let changed = false;
  const redact = (value: string | null): string | null => {
    if (value === null) return null;
    const result = redactText(value, policy);
    if (result.count > 0) changed = true;
    return result.text;
  };
  const tags = row.tags.map((tag) => {
    const result = redactText(tag, policy);
    if (result.count > 0) changed = true;
    return result.text;
  });

  return {
    ledgerSeq: row.seq,
    eventId: redact(row.eventId) ?? row.eventId,
    requestId: redact(row.requestId),
    receivedAt: new Date(row.receivedAt).toISOString(),
    occurredAt: new Date(row.occurredAt).toISOString(),
    status: row.status,
    provider: redact(row.provider),
    model: redact(row.model),
    runtimeId: redact(row.runtimeId),
    sessionId: redact(row.sessionId),
    agentId: redact(row.agentId),
    taskId: redact(row.taskId),
    traceId: redact(row.traceId),
    parentId: redact(row.parentId),
    toolCallId: redact(row.toolCallId),
    userId: redact(row.userId),
    tags,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    latencyMs: row.latencyMs,
    cost: row.cost,
    currency: redact(row.currency),
    costSource: row.costSource,
    summary: redact(row.summary),
    redacted: changed,
  };
}

// -------------------------------------------------------------
// Pure formatters (unit-tested directly by tests/usage-export-format.test.mjs)
// -------------------------------------------------------------

/** `%` then `;` (issue #69, CSV tag escaping), in that order: escaping `%` first keeps the encoding reversible,
 * since escaping `;` first would make the `%` it introduces get escaped a second time. Applied per tag, after
 * redaction, before the tags are joined into one CSV cell. */
export function escapeTag(tag: string): string {
  return tag.replace(/%/g, '%25').replace(/;/g, '%3B');
}

/** `null` when there are no tags (CSV has no way to write "no tags" other than an empty cell), else every tag
 * escaped and joined with `;`. */
export function formatTagsForCsv(tags: readonly string[]): string | null {
  if (tags.length === 0) return null;
  return tags.map(escapeTag).join(';');
}

/** Leading `=`, `+`, `-`, `@`, TAB, CR, LF, or their fullwidth forms (OWASP CSV-injection guidance). A leading
 * plain space is not a trigger: spreadsheets do not evaluate it as a formula prefix. */
const CSV_FORMULA_TRIGGER = /^[=+\-@\t\r\n＝＋－＠]/;

/** Prefixes `value` with `'` when it starts with a formula-injection trigger character; otherwise returns it
 * unchanged. Runs after redaction and tag escaping (issue #69), so a `[REDACTED:...]` marker or an escaped tag
 * can never itself be mistaken for, or hide, a formula prefix. */
export function guardCsvCell(value: string): string {
  return CSV_FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/** RFC 4180 quoting: wraps in double quotes, doubling every inner double quote. Never called for a `null` cell
 * (those are empty, unquoted fields) or a numeric cell (never quoted). */
function quoteCsvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function csvTextCell(value: string | null): string {
  return value === null ? '' : quoteCsvCell(guardCsvCell(value));
}

/**
 * Plain decimal notation of a finite, non-negative number, never exponent notation, with no rounding (issue
 * #69): expands `String(value)`'s shortest round-trip representation digit by digit when it used exponent form,
 * the same technique `server/usageAggregates.ts`'s `toNanoUnits` uses for the same reason, reimplemented here
 * (not imported) since that module's helper is unexported, operates on fixed-point nano units rather than a
 * display string, and belongs to an unrelated feature (the live snapshot's usage summary, not the ledger). Every
 * ledger numeric column is already constrained to a finite, non-negative value by `toLedgerRow`
 * (`finiteNonNegativeInt`/`finiteNonNegativeNumber`), so negative numbers and `NaN`/`Infinity` are not handled.
 * `parseFloat(formatDecimal(n)) === n` holds for every such `n`, including `1e-7` and `1.5e21`-scale values.
 */
export function formatDecimal(value: number): string {
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return text;
  const [, intPart, fracPart = '', expPart] = match;
  const exp = expPart ? Number(expPart) : 0;
  if (exp === 0) return fracPart ? `${intPart}.${fracPart}` : intPart;

  const digits = intPart + fracPart;
  const point = intPart.length + exp;
  let result: string;
  if (point <= 0) {
    result = `0.${'0'.repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    result = digits + '0'.repeat(point - digits.length);
  } else {
    result = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  if (result.includes('.')) {
    result = result.replace(/0+$/, '').replace(/\.$/, '');
  }
  return result;
}

function csvNumberCell(value: number | null): string {
  return value === null ? '' : formatDecimal(value);
}

export const CSV_HEADER =
  'ledgerSeq,eventId,requestId,receivedAt,occurredAt,status,provider,model,runtimeId,sessionId,agentId,taskId,' +
  'traceId,parentId,toolCallId,userId,tags,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,' +
  'reasoningTokens,latencyMs,cost,currency,costSource,summary,redacted';

/** One CSV row (RFC 4180, CRLF line ending, the 28 documented columns in their fixed order). `r.tags` is escaped
 * and joined here (CSV-only; JSONL carries the exact array, see `formatJsonlRow`). */
export function formatCsvRow(r: ExportCallRecord): string {
  const fields = [
    String(r.ledgerSeq),
    csvTextCell(r.eventId),
    csvTextCell(r.requestId),
    csvTextCell(r.receivedAt),
    csvTextCell(r.occurredAt),
    csvTextCell(r.status),
    csvTextCell(r.provider),
    csvTextCell(r.model),
    csvTextCell(r.runtimeId),
    csvTextCell(r.sessionId),
    csvTextCell(r.agentId),
    csvTextCell(r.taskId),
    csvTextCell(r.traceId),
    csvTextCell(r.parentId),
    csvTextCell(r.toolCallId),
    csvTextCell(r.userId),
    csvTextCell(formatTagsForCsv(r.tags)),
    csvNumberCell(r.inputTokens),
    csvNumberCell(r.outputTokens),
    csvNumberCell(r.cacheReadTokens),
    csvNumberCell(r.cacheWriteTokens),
    csvNumberCell(r.reasoningTokens),
    csvNumberCell(r.latencyMs),
    csvNumberCell(r.cost),
    csvTextCell(r.currency),
    csvTextCell(r.costSource),
    csvTextCell(r.summary),
    String(r.redacted),
  ];
  return fields.join(',') + '\r\n';
}

function jsonStringOrNull(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value);
}

function jsonNumberOrNull(value: number | null): string {
  return value === null ? 'null' : formatDecimal(value);
}

/** One JSONL `call` record. Built field by field (not `JSON.stringify` on the whole object) so `cost` is written
 * in the same plain decimal notation as the CSV cell: `JSON.stringify` itself switches to exponent notation for
 * very small or very large magnitudes (e.g. `JSON.stringify(1e-7) === '1e-7'`), which the issue's contract
 * forbids. */
export function formatJsonlRow(r: ExportCallRecord): string {
  const fields = [
    `"record":"call"`,
    `"schema":${JSON.stringify(EXPORT_SCHEMA)}`,
    `"ledgerSeq":${r.ledgerSeq}`,
    `"eventId":${JSON.stringify(r.eventId)}`,
    `"requestId":${jsonStringOrNull(r.requestId)}`,
    `"receivedAt":${JSON.stringify(r.receivedAt)}`,
    `"occurredAt":${JSON.stringify(r.occurredAt)}`,
    `"status":${JSON.stringify(r.status)}`,
    `"provider":${jsonStringOrNull(r.provider)}`,
    `"model":${jsonStringOrNull(r.model)}`,
    `"runtimeId":${jsonStringOrNull(r.runtimeId)}`,
    `"sessionId":${jsonStringOrNull(r.sessionId)}`,
    `"agentId":${jsonStringOrNull(r.agentId)}`,
    `"taskId":${jsonStringOrNull(r.taskId)}`,
    `"traceId":${jsonStringOrNull(r.traceId)}`,
    `"parentId":${jsonStringOrNull(r.parentId)}`,
    `"toolCallId":${jsonStringOrNull(r.toolCallId)}`,
    `"userId":${jsonStringOrNull(r.userId)}`,
    `"tags":${JSON.stringify(r.tags)}`,
    `"inputTokens":${jsonNumberOrNull(r.inputTokens)}`,
    `"outputTokens":${jsonNumberOrNull(r.outputTokens)}`,
    `"cacheReadTokens":${jsonNumberOrNull(r.cacheReadTokens)}`,
    `"cacheWriteTokens":${jsonNumberOrNull(r.cacheWriteTokens)}`,
    `"reasoningTokens":${jsonNumberOrNull(r.reasoningTokens)}`,
    `"latencyMs":${jsonNumberOrNull(r.latencyMs)}`,
    `"cost":${jsonNumberOrNull(r.cost)}`,
    `"currency":${jsonStringOrNull(r.currency)}`,
    `"costSource":${JSON.stringify(r.costSource)}`,
    `"summary":${jsonStringOrNull(r.summary)}`,
    `"redacted":${r.redacted}`,
  ];
  return `{${fields.join(',')}}`;
}

// -------------------------------------------------------------
// Filename (section 2 of the issue): built only from validated values, never raw filter strings.
// -------------------------------------------------------------

function dateOnly(ms: number | null): string {
  return ms === null ? 'all' : new Date(ms).toISOString().slice(0, 10);
}

export function buildExportFilename(filters: UsageFilters, asOfSeq: number, format: ExportFormat): string {
  return `agent-viewer-usage_${dateOnly(filters.from)}_${dateOnly(filters.to)}_seq-${asOfSeq}.${format}`;
}

// -------------------------------------------------------------
// Totals sidecar: reshapes a UsageRollupResponse (issue #66) into this issue's own contract. No cost or token
// arithmetic happens here; every number comes straight from `rollup.totals`.
// -------------------------------------------------------------

export interface ExportCostEntry {
  currency: string | null;
  costSource: CostSource;
  calls: number;
  callsWithCost: number;
  callsWithoutCost: number;
  knownCost: number | null;
  cost: number | null;
}

export interface ExportTokenFigure {
  sum: number | null;
  callsReported: number;
  callsNotReported: number;
}

export interface ExportTotals {
  schema: typeof EXPORT_SCHEMA;
  asOfSeq: number | null;
  afterSeq: number | null;
  filters: Record<string, unknown>;
  rowCount: number;
  complete: boolean;
  incompleteReason?: 'evicted' | 'retention';
  cost: ExportCostEntry[];
  tokens: Record<'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens', ExportTokenFigure>;
  byStatus: { succeeded: number; failed: number };
}

const TOKEN_KIND_TO_LONG_NAME: Record<TokenKind, keyof ExportTotals['tokens']> = {
  input: 'inputTokens',
  output: 'outputTokens',
  cacheRead: 'cacheReadTokens',
  cacheWrite: 'cacheWriteTokens',
  reasoning: 'reasoningTokens',
};

/** Validated filters only, redacted like every other text value this feature emits (issue #69: "The filters
 * object in the summary echoes the validated filters only, with the same redaction applied to string values").
 * `afterSeq`/`asOfSeq`/`format`/`bom` are reported as their own top-level fields, not echoed here. */
function echoFilters(filters: UsageFilters, policy?: RedactionPolicy): Record<string, unknown> {
  const redactList = (values: readonly string[]): string[] => values.map((v) => redactText(v, policy).text);
  const echo: Record<string, unknown> = { timeBasis: filters.timeBasis };
  if (filters.from !== null) echo.from = new Date(filters.from).toISOString();
  if (filters.to !== null) echo.to = new Date(filters.to).toISOString();
  if (filters.agentId.length) echo.agentId = redactList(filters.agentId);
  if (filters.sessionId.length) echo.sessionId = redactList(filters.sessionId);
  if (filters.runtimeId.length) echo.runtimeId = redactList(filters.runtimeId);
  if (filters.taskId.length) echo.taskId = redactList(filters.taskId);
  if (filters.provider.length) echo.provider = redactList(filters.provider);
  if (filters.model.length) echo.model = redactList(filters.model);
  if (filters.status.length) echo.status = filters.status;
  if (filters.costSource.length) echo.costSource = filters.costSource;
  if (filters.currency.length) echo.currency = redactList(filters.currency);
  if (filters.userId.length) echo.userId = redactList(filters.userId);
  if (filters.tag.length) echo.tag = redactList(filters.tag);
  return echo;
}

/**
 * Builds the `/export/totals` response (and the JSONL `summary` record's `totals` member) from a
 * `UsageRollupResponse` the caller already computed by calling `store.rollup()` with the export's own filters
 * (`afterSeq` included) and a one-dimension `groupBy` whose groups are discarded: only `rollup.totals`,
 * `rollup.asOf` and `rollup.coverage` are read here, all independent of which dimension was grouped by. Reusing
 * `store.rollup()` is exactly issue #69's own instruction ("Totals are computed by the #66 rollup service...They
 * are not a second implementation"), including whatever precision #66's own decimal summation has.
 */
export function shapeExportTotals(rollup: UsageRollupResponse, filters: UsageFilters, policy?: RedactionPolicy): ExportTotals {
  const cost: ExportCostEntry[] = rollup.totals.cost.entries.map((entry) => ({
    currency: entry.currency,
    costSource: entry.costSource,
    calls: entry.calls,
    callsWithCost: entry.calls,
    callsWithoutCost: 0,
    knownCost: entry.sum,
    cost: entry.sum,
  }));
  if (rollup.totals.cost.unknownCostCalls > 0) {
    cost.push({
      currency: null,
      costSource: 'unknown',
      calls: rollup.totals.cost.unknownCostCalls,
      callsWithCost: 0,
      callsWithoutCost: rollup.totals.cost.unknownCostCalls,
      knownCost: null,
      cost: null,
    });
  }

  const tokens = {} as ExportTotals['tokens'];
  for (const kind of TOKEN_KINDS) {
    const figure = rollup.totals.tokens[kind];
    tokens[TOKEN_KIND_TO_LONG_NAME[kind]] = {
      sum: figure.sum,
      callsReported: figure.reportedCalls,
      callsNotReported: figure.unreportedCalls,
    };
  }

  const result: ExportTotals = {
    schema: EXPORT_SCHEMA,
    asOfSeq: rollup.asOf.ledgerSeq,
    afterSeq: filters.afterSeq,
    filters: echoFilters(filters, policy),
    rowCount: rollup.totals.calls.total,
    complete: rollup.coverage.complete,
    cost,
    tokens,
    byStatus: { succeeded: rollup.totals.calls.succeeded, failed: rollup.totals.calls.failed },
  };
  if (!rollup.coverage.complete) {
    result.incompleteReason = rollup.coverage.droppedRows > 0 ? 'evicted' : 'retention';
  }
  return result;
}
