/**
 * Pure mapping of a Claude Code OTLP/HTTP logs export (`POST /v1/logs`, issue #59) into canonical V1 events.
 *
 * No network, no store, no process-wide state: `mapOtlpLogsRequest` takes a parsed JSON body and the current
 * time, and returns the canonical events it could build plus counters. The route in `server/index.ts` and the
 * browser-side `parseEventLog` (issue #74, `src/integrations/eventLogParser.ts`) both call this module and own
 * auth/limits/persistence or file detection and issue reporting themselves.
 *
 * Browser-safe by design (issue #74): no `node:*` import, no `Buffer`, no I/O, so `src/lib` can bundle it for
 * an OTLP file dropped in the browser, not only for the server's live receiver.
 *
 * Privacy (see `docs/claude-code.md` and the Context section of issue #59): this module reads an allowlist of
 * attributes only. Everything else (emails, account ids, `prompt`, `response`, `error`, `tool_*`, `vcs.*`,
 * `body`) is never copied, logged or kept. The raw `session.id` is hashed through `sessionIdentity` and never
 * stored or returned.
 */
import { sessionIdentity } from '../claudeCodeIdentity';
import { validateCanonicalEvent, type CanonicalEvent } from '../canonicalContract';

const ACCEPTED_SERVICE_NAMES = new Set(['claude-code', 'claude-code-desktop']);

/**
 * Known Claude Code events (short form, no `claude_code.` prefix) that 0.3.0 reads but does not map. Anything
 * not in this list and not `api_request`/`api_error` is counted as `unknown` instead, by design: the stats
 * endpoint surfaces unrecognized names so a later release can decide whether to map them.
 */
const IGNORED_EVENT_NAMES = new Set([
  'user_prompt', 'assistant_response', 'tool_result', 'tool_decision', 'api_refusal',
  'api_retries_exhausted', 'api_request_body', 'api_response_body', 'subagent_completed', 'compaction',
  'hook_execution_start', 'hook_execution_complete', 'hook_registered', 'plugin_loaded',
  'mcp_server_connection', 'auth_refresh', 'auth_error', 'settings_changed',
]);

const ID_HASH_VERSION = 'cc-otlp-1';
const ID_PREFIX = 'evt_cc_otlp_';
const MAX_MODEL_LENGTH = 100;
const MAX_UNKNOWN_EVENT_NAMES = 50;
const MAX_UNKNOWN_EVENT_NAME_LENGTH = 100;

export interface OtlpParseStats {
  received: number;
  mapped: number;
  duplicates: number;
  ignored: number;
  unknown: number;
  unattributed: number;
  invalid: number;
}

export interface OtlpMapResult {
  /** Canonical events already built and validated, ready for `store.appendBatch`. */
  events: CanonicalEvent[];
  /** Counts everything except `mapped`/`duplicates`, which only the store round-trip can tell apart. */
  stats: Omit<OtlpParseStats, 'mapped' | 'duplicates'>;
  mappedByType: { 'llm.usage': number; 'llm.failed': number };
  /** Event names (short form) this release does not recognize, capped at 100 chars each. */
  unknownEventNames: Map<string, number>;
  /** Short, content-free reasons for every rejected (unattributed or invalid) record, for `partialSuccess`. */
  rejectionReasons: string[];
}

// -------------------------------------------------------------
// OTLP JSON value helpers
// -------------------------------------------------------------

interface OtlpAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  doubleValue?: number;
  intValue?: number | string;
}

interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue;
}

interface OtlpLogRecord {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  eventName?: string;
  body?: OtlpAnyValue;
  attributes?: OtlpKeyValue[];
  droppedAttributesCount?: number;
}

interface OtlpScopeLogs {
  scope?: { name?: string; version?: string };
  logRecords?: OtlpLogRecord[];
}

interface OtlpResourceLogs {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeLogs?: OtlpScopeLogs[];
}

export interface OtlpExportLogsServiceRequest {
  resourceLogs?: OtlpResourceLogs[];
}

/** True when the body looks like `{"resourceLogs": [...]}`, OTLP/HTTP's top-level shape. */
export function looksLikeOtlpLogsRequest(body: unknown): body is OtlpExportLogsServiceRequest {
  return (
    typeof body === 'object' &&
    body !== null &&
    Array.isArray((body as OtlpExportLogsServiceRequest).resourceLogs)
  );
}

/** Counts log records across every `resourceLogs[].scopeLogs[]`, for the per-request record limit. */
export function countLogRecords(body: OtlpExportLogsServiceRequest): number {
  let count = 0;
  for (const rl of body.resourceLogs ?? []) {
    for (const sl of rl.scopeLogs ?? []) {
      count += sl.logRecords?.length ?? 0;
    }
  }
  return count;
}

function attributeMap(attributes: OtlpKeyValue[] | undefined): Map<string, OtlpAnyValue> {
  const map = new Map<string, OtlpAnyValue>();
  for (const attr of attributes ?? []) {
    if (attr && typeof attr.key === 'string' && attr.value && !map.has(attr.key)) map.set(attr.key, attr.value);
  }
  return map;
}

/** Record attributes first, then resource attributes (issue #59, section 4: "record attributes first"). */
function lookupAttribute(recordAttrs: Map<string, OtlpAnyValue>, resourceAttrs: Map<string, OtlpAnyValue>, key: string): OtlpAnyValue | undefined {
  return recordAttrs.get(key) ?? resourceAttrs.get(key);
}

/** A string value, or `undefined` for anything else (never coerces a number or boolean into a string). */
function stringOf(value: OtlpAnyValue | undefined): string | undefined {
  return typeof value?.stringValue === 'string' ? value.stringValue : undefined;
}

/**
 * A numeric field accepts an `intValue` as a JSON number, an `intValue` as a decimal string, or a `doubleValue`.
 * Confirmed necessary against real Claude Code exports (see `tests/fixtures/claude-code-otlp/README.md`,
 * open question 3): the same batch sends `input_tokens` as an `intValue` number and `duration_ms` on other
 * event types as a decimal `stringValue`. Returns `undefined` when the value is missing, not a plain finite
 * number, or (for `intValue`) not an integer.
 */
function numberOf(value: OtlpAnyValue | undefined): number | undefined {
  if (!value) return undefined;
  if (typeof value.doubleValue === 'number') return Number.isFinite(value.doubleValue) ? value.doubleValue : undefined;
  if (typeof value.intValue === 'number') return Number.isInteger(value.intValue) ? value.intValue : undefined;
  if (typeof value.intValue === 'string' && /^-?\d+$/.test(value.intValue)) {
    const parsed = Number(value.intValue);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** `numberOf`, but only non-negative integers pass; anything else (including a valid negative number) is `undefined`. */
function nonNegativeIntOf(value: OtlpAnyValue | undefined): number | undefined {
  const n = numberOf(value);
  return n !== undefined && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * ms since epoch from an OTLP `*UnixNano` field. Values are decimal strings above `2^53`, so this always goes
 * through `BigInt`, never `Number(nanos) / 1e6` (issue #59, section 4). `"0"` or an unparseable value means
 * "unset".
 */
function msFromUnixNano(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  try {
    const nanos = BigInt(typeof value === 'number' ? Math.trunc(value) : value);
    if (nanos <= 0n) return undefined;
    const ms = Number(nanos / 1_000_000n);
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  } catch {
    return undefined;
  }
}

/** Event name resolution per issue #59 section 4: `eventName`, then `event.name` (prefixed), then `body`. */
function resolveEventName(record: OtlpLogRecord, recordAttrs: Map<string, OtlpAnyValue>): string | undefined {
  if (typeof record.eventName === 'string' && record.eventName.trim() !== '') {
    const name = record.eventName.trim();
    return name.startsWith('claude_code.') ? name : `claude_code.${name}`;
  }
  const attrName = stringOf(recordAttrs.get('event.name'));
  if (attrName && attrName.trim() !== '') {
    const name = attrName.trim();
    return name.startsWith('claude_code.') ? name : `claude_code.${name}`;
  }
  const bodyName = stringOf(record.body);
  if (bodyName && bodyName.startsWith('claude_code.')) return bodyName;
  return undefined;
}

// -------------------------------------------------------------
// Deterministic, idempotent ids (issue #59, section 6)
// -------------------------------------------------------------

interface IdHashInputs {
  rawSessionId: string;
  eventName: string;
  requestId: string | null;
  clientRequestId: string | null;
  eventTimestamp: string | null;
  eventSequence: number | null;
  timeUnixNano: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  cost: number | null;
  durationMs: number | null;
  statusCode: number | null;
  attempt: number | null;
}

/**
 * One 32-bit FNV-1a pass. Not cryptographic, deterministic and allocation-free: exactly what a content-derived
 * id needs here (issue #74 forbids `Math.random()`/`Date.now()` and `node:crypto`, not strong hashing).
 */
function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, '0');
}

/**
 * A 128-bit (32 hex char) digest from four independent FNV-1a passes over the same payload, one per seed.
 * Four 32-bit lanes keep the function trivial to audit while giving the same collision resistance a reader
 * would expect from a deterministic id: parsing the same bytes twice always yields the same 32 hex characters.
 */
function deterministicHashHex32(payload: string): string {
  const seeds = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  return seeds.map((seed) => hex8(fnv1a32(payload, seed))).join('');
}

export function otlpDeterministicId(inputs: IdHashInputs): string {
  const payload = JSON.stringify([
    ID_HASH_VERSION,
    inputs.rawSessionId,
    inputs.eventName,
    inputs.requestId,
    inputs.clientRequestId,
    inputs.eventTimestamp,
    inputs.eventSequence,
    inputs.timeUnixNano,
    inputs.model,
    inputs.inputTokens,
    inputs.outputTokens,
    inputs.cacheReadTokens,
    inputs.cacheCreationTokens,
    inputs.cost,
    inputs.durationMs,
    inputs.statusCode,
    inputs.attempt,
  ]);
  return `${ID_PREFIX}${deterministicHashHex32(payload)}`;
}

// -------------------------------------------------------------
// Timestamp resolution (issue #59, section 4)
// -------------------------------------------------------------

function resolveTimestampMs(eventTimestampRaw: string | undefined, timeUnixNano: string | number | undefined, observedTimeUnixNano: string | number | undefined, receivedAtMs: number): number {
  if (eventTimestampRaw) {
    const parsed = Date.parse(eventTimestampRaw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const fromTime = msFromUnixNano(timeUnixNano);
  if (fromTime !== undefined) return fromTime;
  const fromObserved = msFromUnixNano(observedTimeUnixNano);
  if (fromObserved !== undefined) return fromObserved;
  return receivedAtMs;
}

// -------------------------------------------------------------
// errorKind (issue #59, section 5)
// -------------------------------------------------------------

/**
 * Adapted to the `LlmErrorKind` vocabulary already merged by issue #46 (`rate_limited`, `auth`), instead of
 * the issue's draft names (`rate_limit`, `authentication_failed`), which predate that merge. `network` is new:
 * issue #59 explicitly allows adding a value `#46`'s set lacks for a case like this (no HTTP status at all).
 */
function errorKindForStatusCode(statusCode: number | undefined): string {
  if (statusCode === undefined) return 'network';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode === 529) return 'overloaded';
  if (statusCode === 401 || statusCode === 403) return 'auth';
  if (statusCode === 400 || statusCode === 404 || statusCode === 413) return 'invalid_request';
  if (statusCode >= 500 && statusCode <= 599) return 'server_error';
  return 'unknown';
}

// -------------------------------------------------------------
// Mapping
// -------------------------------------------------------------

interface MapContext {
  rawSessionId: string;
  recordAttrs: Map<string, OtlpAnyValue>;
  resourceAttrs: Map<string, OtlpAnyValue>;
  receivedAtMs: number;
  /** Raw `timeUnixNano` of the record, as a decimal string, for the id hash (issue #59, section 6). */
  timeUnixNanoRaw: string | null;
}

function get(ctx: MapContext, key: string): OtlpAnyValue | undefined {
  return lookupAttribute(ctx.recordAttrs, ctx.resourceAttrs, key);
}

function cutModel(model: string): string {
  return model.length > MAX_MODEL_LENGTH ? model.slice(0, MAX_MODEL_LENGTH) : model;
}

/** Builds the candidate `llm.usage` event for one `claude_code.api_request` record, or `null` if unattributed. */
function buildApiRequestEvent(ctx: MapContext): { event: unknown; reason?: never } | { event?: never; reason: string } {
  const identity = sessionIdentity(ctx.rawSessionId);
  const modelRaw = stringOf(get(ctx, 'model'));
  const rawInputTokens = nonNegativeIntOf(get(ctx, 'input_tokens'));
  const outputTokens = nonNegativeIntOf(get(ctx, 'output_tokens'));
  const cacheReadTokens = nonNegativeIntOf(get(ctx, 'cache_read_tokens'));
  const cacheCreationTokens = nonNegativeIntOf(get(ctx, 'cache_creation_tokens'));
  /**
   * Claude Code's `input_tokens` excludes cache reads and writes (Anthropic semantics: the three are separate,
   * non-overlapping counters). The canonical contract's `LlmUsagePayloadSchema` predates this receiver (#46)
   * and enforces the opposite assumption: `cacheReadTokens + cacheWriteTokens` must never exceed `inputTokens`,
   * because for the providers it was designed against, cache hits are a subset of the input tokens billed.
   * A real multi-turn Claude Code session routinely has a tiny `input_tokens` (only the newest text) next to a
   * huge `cache_read_tokens` (the rest of the conversation, replayed from cache), which fails that check
   * outright. Folding the cache counters into `inputTokens` here, instead of relaxing #46's shared contract
   * check, keeps this item's blast radius to its own mapper: `inputTokens` becomes "every prompt-side token
   * Anthropic counted for this call", satisfying the existing invariant by construction, while the real,
   * separate `cache_read_tokens`/`cache_creation_tokens` counts are still kept in their own fields below.
   */
  const inputTokens =
    rawInputTokens !== undefined
      ? rawInputTokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0)
      : undefined;
  const durationMs = nonNegativeIntOf(get(ctx, 'duration_ms'));
  const requestId = stringOf(get(ctx, 'request_id'));
  const clientRequestId = stringOf(get(ctx, 'client_request_id'));
  const eventTimestampRaw = stringOf(get(ctx, 'event.timestamp'));
  const eventSequence = numberOf(get(ctx, 'event.sequence'));

  const costUsdMicros = numberOf(get(ctx, 'cost_usd_micros'));
  const costUsd = numberOf(get(ctx, 'cost_usd'));
  let cost: number | null = null;
  if (costUsdMicros !== undefined) cost = costUsdMicros / 1e6;
  else if (costUsd !== undefined) cost = costUsd;
  // A negative or non-finite cost is invalid, not silently turned into null: let validateCanonicalEvent reject it.
  const costIsPresentButInvalid = cost !== null && (!Number.isFinite(cost) || cost < 0);

  const model = modelRaw ? cutModel(modelRaw) : undefined;

  const id = otlpDeterministicId({
    rawSessionId: ctx.rawSessionId,
    eventName: 'claude_code.api_request',
    requestId: requestId ?? null,
    clientRequestId: clientRequestId ?? null,
    eventTimestamp: eventTimestampRaw ?? null,
    eventSequence: eventSequence ?? null,
    timeUnixNano: ctx.timeUnixNanoRaw,
    model: model ?? null,
    // Hashed as the raw attribute, not the combined `inputTokens` below: one hash input per wire value keeps
    // the formula a direct, auditable function of what Claude Code actually sent.
    inputTokens: rawInputTokens ?? null,
    outputTokens: outputTokens ?? null,
    cacheReadTokens: cacheReadTokens ?? null,
    cacheCreationTokens: cacheCreationTokens ?? null,
    cost: costUsdMicros ?? costUsd ?? null,
    durationMs: durationMs ?? null,
    statusCode: null,
    attempt: null,
  });

  if (!model) return { reason: 'claude_code.api_request record rejected: model missing' };
  if (rawInputTokens === undefined) return { reason: 'claude_code.api_request record rejected: input_tokens missing or not a non-negative integer' };
  if (outputTokens === undefined) return { reason: 'claude_code.api_request record rejected: output_tokens missing or not a non-negative integer' };
  if (costIsPresentButInvalid) return { reason: 'claude_code.api_request record rejected: cost is negative or not finite' };

  const shortName = identity.mainAgentName;
  const event = {
    schemaVersion: '1.0',
    id,
    type: 'llm.usage',
    // The caller (mapOtlpLogsRequest) always overrides this with the resolved event timestamp.
    timestamp: ctx.receivedAtMs,
    runtimeId: 'claude-code',
    sessionId: identity.sessionId,
    source: `agent:${identity.mainAgentId}`,
    agentId: identity.mainAgentId,
    severity: 'normal',
    summary: `${shortName} used ${model}`,
    payload: {
      provider: 'Anthropic',
      model,
      inputTokens,
      outputTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheCreationTokens !== undefined ? { cacheWriteTokens: cacheCreationTokens } : {}),
      ...(durationMs !== undefined ? { latencyMs: durationMs } : {}),
      ...(requestId ? { requestId } : {}),
      cost,
      costSource: cost !== null ? 'estimated' : 'unknown',
      ...(cost !== null ? { currency: 'USD' } : {}),
    },
  };
  return { event };
}

function buildApiErrorEvent(ctx: MapContext): { event: unknown; reason?: never } | { event?: never; reason: string } {
  const identity = sessionIdentity(ctx.rawSessionId);
  const modelRaw = stringOf(get(ctx, 'model'));
  const model = modelRaw ? cutModel(modelRaw) : undefined;
  const statusCode = nonNegativeIntOf(get(ctx, 'status_code'));
  const durationMs = nonNegativeIntOf(get(ctx, 'duration_ms'));
  const attempt = nonNegativeIntOf(get(ctx, 'attempt'));
  const requestId = stringOf(get(ctx, 'request_id'));
  const clientRequestId = stringOf(get(ctx, 'client_request_id'));
  const eventTimestampRaw = stringOf(get(ctx, 'event.timestamp'));
  const eventSequence = numberOf(get(ctx, 'event.sequence'));

  const errorKind = errorKindForStatusCode(statusCode);

  const id = otlpDeterministicId({
    rawSessionId: ctx.rawSessionId,
    eventName: 'claude_code.api_error',
    requestId: requestId ?? null,
    clientRequestId: clientRequestId ?? null,
    eventTimestamp: eventTimestampRaw ?? null,
    eventSequence: eventSequence ?? null,
    timeUnixNano: ctx.timeUnixNanoRaw,
    model: model ?? null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    cost: null,
    durationMs: durationMs ?? null,
    statusCode: statusCode ?? null,
    attempt: attempt ?? null,
  });

  const shortName = identity.mainAgentName;
  const event = {
    schemaVersion: '1.0',
    id,
    type: 'llm.failed',
    // The caller (mapOtlpLogsRequest) always overrides this with the resolved event timestamp.
    timestamp: ctx.receivedAtMs,
    runtimeId: 'claude-code',
    sessionId: identity.sessionId,
    source: `agent:${identity.mainAgentId}`,
    agentId: identity.mainAgentId,
    severity: 'high',
    summary: `${shortName} request failed (${errorKind})`,
    payload: {
      provider: 'Anthropic',
      ...(model ? { model } : {}),
      ...(requestId ? { requestId } : {}),
      ...(statusCode !== undefined ? { httpStatus: statusCode } : {}),
      errorKind,
      ...(attempt !== undefined ? { attempts: attempt } : {}),
      ...(durationMs !== undefined ? { latencyMs: durationMs } : {}),
    },
  };
  return { event };
}

/** Caps the length and count of tracked unknown event names, so the stats endpoint cannot grow unbounded. */
function trackUnknownName(map: Map<string, number>, rawName: string): void {
  const name = rawName.slice(0, MAX_UNKNOWN_EVENT_NAME_LENGTH);
  const current = map.get(name);
  if (current !== undefined) {
    map.set(name, current + 1);
    return;
  }
  if (map.size >= MAX_UNKNOWN_EVENT_NAMES) return;
  map.set(name, 1);
}

export interface MapOtlpOptions {
  /** Server receive time, used as the last-resort timestamp fallback. Defaults to `Date.now()`. */
  now?: number;
  /** Called once per newly observed unknown event name (debug logging). Never receives record content. */
  onUnknownEventName?: (name: string) => void;
}

/**
 * Maps one parsed OTLP `ExportLogsServiceRequest` body into canonical events plus counters. Does not touch the
 * store: the caller runs `store.appendBatch` on `result.events` and folds the real `accepted`/`duplicates`
 * split into its own running totals.
 */
export function mapOtlpLogsRequest(body: OtlpExportLogsServiceRequest, options: MapOtlpOptions = {}): OtlpMapResult {
  const receivedAtMs = options.now ?? Date.now();
  const events: CanonicalEvent[] = [];
  const unknownEventNames = new Map<string, number>();
  const rejectionReasons: string[] = [];
  const mappedByType = { 'llm.usage': 0, 'llm.failed': 0 };
  const stats = { received: 0, ignored: 0, unknown: 0, unattributed: 0, invalid: 0 };

  for (const rl of body.resourceLogs ?? []) {
    const resourceAttrs = attributeMap(rl.resource?.attributes);
    const serviceName = stringOf(resourceAttrs.get('service.name'));
    const serviceAccepted = serviceName !== undefined && ACCEPTED_SERVICE_NAMES.has(serviceName);

    for (const sl of rl.scopeLogs ?? []) {
      for (const record of sl.logRecords ?? []) {
        stats.received += 1;
        const recordAttrs = attributeMap(record.attributes);

        if (!serviceAccepted) {
          stats.unknown += 1;
          continue;
        }

        const eventName = resolveEventName(record, recordAttrs);
        if (!eventName) {
          stats.unknown += 1;
          continue;
        }
        const shortName = eventName.slice('claude_code.'.length);

        if (shortName !== 'api_request' && shortName !== 'api_error') {
          if (IGNORED_EVENT_NAMES.has(shortName)) {
            stats.ignored += 1;
          } else {
            stats.unknown += 1;
            const hadName = unknownEventNames.has(shortName.slice(0, MAX_UNKNOWN_EVENT_NAME_LENGTH));
            trackUnknownName(unknownEventNames, shortName);
            if (!hadName) options.onUnknownEventName?.(shortName.slice(0, MAX_UNKNOWN_EVENT_NAME_LENGTH));
          }
          continue;
        }

        const rawSessionId = stringOf(lookupAttribute(recordAttrs, resourceAttrs, 'session.id'));
        if (!rawSessionId) {
          stats.unattributed += 1;
          rejectionReasons.push(`${eventName} record rejected: session.id missing`);
          continue;
        }

        const timeUnixNanoRaw = typeof record.timeUnixNano === 'string'
          ? record.timeUnixNano
          : record.timeUnixNano !== undefined ? String(record.timeUnixNano) : null;
        const ctx: MapContext = {
          rawSessionId,
          recordAttrs,
          resourceAttrs,
          receivedAtMs,
          timeUnixNanoRaw,
        };
        // The id hash only needs the raw timeUnixNano; the actual stored timestamp also tries event.timestamp
        // and observedTimeUnixNano, in that order (issue #59, section 4).
        const eventTimestampRaw = stringOf(lookupAttribute(recordAttrs, resourceAttrs, 'event.timestamp'));
        const timestamp = resolveTimestampMs(eventTimestampRaw, record.timeUnixNano, record.observedTimeUnixNano, receivedAtMs);

        const built = shortName === 'api_request' ? buildApiRequestEvent(ctx) : buildApiErrorEvent(ctx);
        if (built.reason) {
          stats.invalid += 1;
          rejectionReasons.push(built.reason);
          continue;
        }

        const candidate = { ...(built.event as Record<string, unknown>), timestamp };
        const validation = validateCanonicalEvent(candidate);
        if (!validation.success || !validation.data) {
          stats.invalid += 1;
          const firstIssue = validation.issues?.[0];
          rejectionReasons.push(`${eventName} record rejected: ${firstIssue?.message ?? 'validation failed'}`);
          continue;
        }

        events.push(validation.data);
        mappedByType[validation.data.type as 'llm.usage' | 'llm.failed'] += 1;
      }
    }
  }

  return { events, stats, mappedByType, unknownEventNames, rejectionReasons };
}
