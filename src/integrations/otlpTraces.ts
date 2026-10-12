/**
 * Pure mapping of an OTLP/HTTP GenAI traces export (`POST /v1/traces`, issue #97) into canonical V1 events.
 *
 * No network, no store, no process-wide state: `mapOtlpTraces` takes a parsed OTLP/JSON body (or the same
 * shape decoded from protobuf by `server/otlp/otlpProtobuf.ts`'s `decodeExportTraceServiceRequest`) and
 * returns the canonical events it could build plus counters. The route in `server/index.ts` owns
 * auth/limits/persistence; issue #98 (OTLP trace file import) reuses this exact function for the browser, which
 * is why it is exported at the top level of `src/integrations` (issue #97, "Code layout") instead of living
 * under `src/integrations/otlp/` like the logs mapper, and why it never imports `node:*` or `Buffer`.
 *
 * Privacy by construction (issue #97, "Privacy by construction"): only the attributes named in the mapping
 * tables below are ever read. Everything else a GenAI span can carry (`gen_ai.prompt`, `gen_ai.completion`,
 * `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, tool call arguments and
 * results, span events and links, and any resource attribute other than `service.name`) is never copied,
 * returned or logged. `status.message` is never read either, since it can echo prompt fragments; only the
 * short, closed-vocabulary `error.type` attribute is used for failure detail.
 *
 * This item is a converter in front of the existing ingestion path: it never stores spans, never prices a
 * call, and never retroactively re-attributes an event to an agent discovered later.
 */
import { validateCanonicalEvent, type CanonicalEvent } from './canonicalContract';

// -------------------------------------------------------------
// OTLP JSON value helpers (same shapes `server/otlp/otlpProtobuf.ts` decodes protobuf into)
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

interface OtlpStatus {
  message?: string;
  /** OTLP/JSON allows either the integer or the enum's string name; both are accepted here. */
  code?: number | string;
}

interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpKeyValue[];
  status?: OtlpStatus;
}

interface OtlpScopeSpans {
  spans?: OtlpSpan[];
}

interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: OtlpScopeSpans[];
}

export interface OtlpExportTraceServiceRequest {
  resourceSpans?: OtlpResourceSpans[];
}

/**
 * True when the body looks like an OTLP/HTTP traces export. Unlike the logs/metrics receivers, a bare `{}`
 * (no `resourceSpans` key at all) is accepted too (issue #97, "Success": "An empty request (`{}` or zero
 * spans) is also full success"), not just `{"resourceSpans":[]}`.
 */
export function looksLikeOtlpTracesRequest(body: unknown): body is OtlpExportTraceServiceRequest {
  if (typeof body !== 'object' || body === null) return false;
  const resourceSpans = (body as OtlpExportTraceServiceRequest).resourceSpans;
  return resourceSpans === undefined || Array.isArray(resourceSpans);
}

/** Counts spans across every `resourceSpans[].scopeSpans[]`, for the per-request span cap. */
export function countSpans(body: OtlpExportTraceServiceRequest): number {
  let count = 0;
  for (const rs of body.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      count += ss.spans?.length ?? 0;
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

const MAX_STRING_LENGTH = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

/** A raw `stringValue`, with no length or character filtering. Used only for the controlled vocabulary
 * (`gen_ai.operation.name`, `status.code` as a string) that never carries prompt content or PII. */
function rawString(value: OtlpAnyValue | undefined): string | undefined {
  return typeof value?.stringValue === 'string' ? value.stringValue : undefined;
}

/**
 * Reads one of the allowlisted string attributes named in issue #97's "Attribute value decoding" section
 * (`provider`, `model`, agent id/name, `service.name`, `gen_ai.response.id`, tool name/id, `error.type`,
 * session id). Empty, over `maxLength` characters, or containing a control character all count as "absent",
 * with a warning (`warn()` is called); nothing is ever truncated, since a truncated id would change identity.
 * Absent entirely (no such attribute) never warns: unknown is not an error.
 */
function readAllowlistedString(
  attrs: Map<string, OtlpAnyValue>,
  key: string,
  warn: () => void,
  maxLength = MAX_STRING_LENGTH
): string | undefined {
  if (!attrs.has(key)) return undefined;
  const value = rawString(attrs.get(key));
  if (value === undefined || value.length === 0 || value.length > maxLength || CONTROL_CHARACTERS.test(value)) {
    warn();
    return undefined;
  }
  return value;
}

/** First present attribute among `keys`, each read through `readAllowlistedString`. */
function readAllowlistedStringFirst(
  attrs: Map<string, OtlpAnyValue>,
  keys: string[],
  warn: () => void,
  maxLength = MAX_STRING_LENGTH
): string | undefined {
  for (const key of keys) {
    if (attrs.has(key)) return readAllowlistedString(attrs, key, warn, maxLength);
  }
  return undefined;
}

/**
 * A non-negative integer token-count-style attribute: `intValue` as a string or number, or a `doubleValue`
 * with an integral value, within `0..Number.MAX_SAFE_INTEGER`. A `stringValue` holding a number is not
 * accepted (issue #97). Present but invalid (negative, fractional, too large, or the wrong type) warns and
 * returns `undefined`, the same as absent; the caller must still accept the span (never reject it for this
 * alone): unknown is not zero.
 */
function readTokenCount(attr: OtlpAnyValue | undefined, warn: () => void): number | undefined {
  if (attr === undefined) return undefined;
  let n: number | undefined;
  if (typeof attr.doubleValue === 'number') {
    n = attr.doubleValue;
  } else if (typeof attr.intValue === 'number') {
    n = attr.intValue;
  } else if (typeof attr.intValue === 'string' && /^-?\d+$/.test(attr.intValue)) {
    n = Number(attr.intValue);
  } else {
    warn();
    return undefined;
  }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) {
    warn();
    return undefined;
  }
  return n;
}

function readTokenCountFirst(attrs: Map<string, OtlpAnyValue>, keys: string[], warn: () => void): number | undefined {
  for (const key of keys) {
    if (attrs.has(key)) return readTokenCount(attrs.get(key), warn);
  }
  return undefined;
}

/** `gen_ai.usage.cost`: `doubleValue` or `intValue`, finite and `>= 0`. Fractional values are allowed
 * (unlike token counts). Present but invalid warns and is treated as absent. */
function readCost(attrs: Map<string, OtlpAnyValue>, warn: () => void): number | undefined {
  if (!attrs.has('gen_ai.usage.cost')) return undefined;
  const attr = attrs.get('gen_ai.usage.cost');
  let n: number | undefined;
  if (typeof attr?.doubleValue === 'number') n = attr.doubleValue;
  else if (typeof attr?.intValue === 'number') n = attr.intValue;
  else if (typeof attr?.intValue === 'string' && /^-?\d+$/.test(attr.intValue)) n = Number(attr.intValue);
  if (n === undefined || !Number.isFinite(n) || n < 0) {
    warn();
    return undefined;
  }
  return n;
}

/** `gen_ai.usage.cost.currency`: uppercased, must match `^[A-Z]{3}$`, never defaulted to USD. */
function readCurrency(attrs: Map<string, OtlpAnyValue>, warn: () => void): string | undefined {
  if (!attrs.has('gen_ai.usage.cost.currency')) return undefined;
  const raw = rawString(attrs.get('gen_ai.usage.cost.currency'));
  const upper = raw?.toUpperCase();
  if (!upper || !/^[A-Z]{3}$/.test(upper)) {
    warn();
    return undefined;
  }
  return upper;
}

/** BigInt-safe `*UnixNano` parse. `undefined`/non-numeric/`<= 0` all mean "unset" (OTLP's own convention). */
function nanoBigInt(value: string | number | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  try {
    const n = BigInt(typeof value === 'number' ? Math.trunc(value) : value);
    return n > 0n ? n : undefined;
  } catch {
    return undefined;
  }
}

function nanoToMs(nanos: bigint | undefined): number | undefined {
  if (nanos === undefined) return undefined;
  const ms = Number(nanos / 1_000_000n);
  return Number.isFinite(ms) ? ms : undefined;
}

/** `round((end - start) / 1e6)`, computed entirely in `BigInt` (issue #97). `undefined` when either end is
 * missing/zero or end is before start. */
function computeLatencyMs(startNs: bigint | undefined, endNs: bigint | undefined): number | undefined {
  if (startNs === undefined || endNs === undefined || endNs < startNs) return undefined;
  const diff = endNs - startNs;
  const rounded = (diff + 500_000n) / 1_000_000n;
  const ms = Number(rounded);
  return Number.isFinite(ms) ? ms : undefined;
}

const HEX_TRACE_ID = /^[0-9a-f]{32}$/;
const HEX_SPAN_ID = /^[0-9a-f]{16}$/;
const ALL_ZERO = /^0+$/;

/** Lowercased hex id, or `undefined` if the field is missing or not a string (case folding makes an uppercase
 * JSON id produce the same event id as a lowercase one, issue #97). */
function lowerHex(value: string | undefined): string | undefined {
  return typeof value === 'string' ? value.toLowerCase() : undefined;
}

function isValidTraceId(id: string | undefined): id is string {
  return id !== undefined && HEX_TRACE_ID.test(id) && !ALL_ZERO.test(id);
}

function isValidSpanId(id: string | undefined): id is string {
  return id !== undefined && HEX_SPAN_ID.test(id) && !ALL_ZERO.test(id);
}

// -------------------------------------------------------------
// GenAI operation classification (issue #97, "Which spans produce events")
// -------------------------------------------------------------

const LLM_OPERATIONS = new Set(['chat', 'text_completion', 'generate_content', 'embeddings']);

type SpanCategory = 'llm' | 'tool' | 'ignore';

function classifySpan(attrs: Map<string, OtlpAnyValue>): SpanCategory {
  const operation = rawString(attrs.get('gen_ai.operation.name'));
  if (operation !== undefined) {
    if (LLM_OPERATIONS.has(operation)) return 'llm';
    if (operation === 'execute_tool') return 'tool';
    // invoke_agent, create_agent, or anything else: used only to resolve agent names, never an event.
    return 'ignore';
  }
  // No operation.name at all: fall back to a tool call only when gen_ai.tool.name is present.
  if (rawString(attrs.get('gen_ai.tool.name')) !== undefined) return 'tool';
  return 'ignore';
}

/** `status.code` `ERROR` (`2` or `"STATUS_CODE_ERROR"`), or an `error.type` attribute present at all. */
function isFailedSpan(status: OtlpStatus | undefined, attrs: Map<string, OtlpAnyValue>): boolean {
  if (status?.code === 2 || status?.code === 'STATUS_CODE_ERROR' || status?.code === 'ERROR') return true;
  return attrs.has('error.type');
}

/**
 * Best-effort mapping from the free-form (but short, machine-oriented) `error.type` attribute to the closed
 * `LlmErrorKind` vocabulary (`src/integrations/canonicalTypes.ts`), which issue #46 shipped before this item:
 * the issue's original draft assumed a free-text `errorType` field that does not exist in the merged contract.
 * `error.type` per the GenAI semantic conventions is typically an HTTP status code or an exception class name,
 * never prompt content, so this heuristic never reads `status.message`.
 */
function errorKindFromErrorType(raw: string): string {
  const lower = raw.toLowerCase();
  if (/^\s*429\s*$/.test(raw) || lower.includes('rate')) return 'rate_limited';
  if (/^\s*529\s*$/.test(raw) || lower.includes('overload')) return 'overloaded';
  if (/^\s*(401|403)\s*$/.test(raw) || lower.includes('auth') || lower.includes('permission')) return 'auth';
  if (/^\s*(400|404|413|422)\s*$/.test(raw) || lower.includes('invalid') || lower.includes('badrequest')) return 'invalid_request';
  if (/^\s*5\d{2}\s*$/.test(raw) || lower.includes('server') || lower.includes('internal')) return 'server_error';
  if (lower.includes('timeout') || lower.includes('timedout')) return 'timeout';
  if (lower.includes('cancel')) return 'cancelled';
  if (lower.includes('connection') || lower.includes('network')) return 'network';
  return 'unknown';
}

// -------------------------------------------------------------
// Agent resolution (issue #97: span id/name, nearest same-request ancestor, then service.name)
// -------------------------------------------------------------

interface IndexedSpan {
  span: OtlpSpan;
  attrs: Map<string, OtlpAnyValue>;
}

const MAX_ANCESTOR_HOPS = 32;

function agentFromSpanAttrs(attrs: Map<string, OtlpAnyValue>, warn: () => void): string | undefined {
  return (
    readAllowlistedString(attrs, 'gen_ai.agent.id', warn) ?? readAllowlistedString(attrs, 'gen_ai.agent.name', warn)
  );
}

/**
 * span `gen_ai.agent.id`, then `gen_ai.agent.name`, then the nearest ancestor span in the same request with
 * either (walk bounded to 32 hops, cycle safe), then the span's own resource `service.name`.
 */
function resolveAgentId(
  span: OtlpSpan,
  attrs: Map<string, OtlpAnyValue>,
  serviceName: string | undefined,
  index: Map<string, IndexedSpan>,
  warn: () => void
): string | undefined {
  const direct = agentFromSpanAttrs(attrs, warn);
  if (direct !== undefined) return direct;

  const visited = new Set<string>();
  let currentParentId = lowerHex(span.parentSpanId);
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS && currentParentId && !visited.has(currentParentId); hop++) {
    visited.add(currentParentId);
    const ancestor = index.get(currentParentId);
    if (!ancestor) break;
    const fromAncestor = agentFromSpanAttrs(ancestor.attrs, warn);
    if (fromAncestor !== undefined) return fromAncestor;
    currentParentId = lowerHex(ancestor.span.parentSpanId);
  }

  return serviceName;
}

function buildIndex(body: OtlpExportTraceServiceRequest): Map<string, IndexedSpan> {
  const index = new Map<string, IndexedSpan>();
  for (const rs of body.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const spanId = lowerHex(span.spanId);
        if (!spanId || index.has(spanId)) continue;
        index.set(spanId, { span, attrs: attributeMap(span.attributes) });
      }
    }
  }
  return index;
}

// -------------------------------------------------------------
// Result shape (issue #97, "Code layout": reused by #98 for OTLP trace file import)
// -------------------------------------------------------------

export interface OtlpTracesMapResult {
  /** Canonical events already built and validated, ready for `store.appendBatch`. */
  events: CanonicalEvent[];
  /** Spans that produced a valid event (before the store's own duplicate/conflict check). */
  accepted: number;
  /** Spans classified as agent/workflow/other GenAI operations, or non-GenAI spans: never an event, never rejected. */
  ignored: number;
  /** Count of attribute values dropped as invalid (present but malformed), across every span in the request. */
  warnings: number;
  /** GenAI spans that could not be mapped. `reasons` holds one closed-vocabulary code per rejected span,
   * for example `invalid_trace_id` or `no_timestamp` (issue #97, "Deterministic ids"). */
  rejected: { count: number; reasons: string[] };
}

export interface MapOtlpTracesOptions {
  /** Reserved for callers that want a fixed clock in tests; unused today (every event's timestamp comes from
   * the span itself, never from the receive time: see "Unknown is not zero" in the issue). */
  now?: number;
}

/** Builds the `llm.usage`/`llm.failed` event for one LLM-operation span, or a rejection reason code. */
function buildLlmEvent(
  span: OtlpSpan,
  attrs: Map<string, OtlpAnyValue>,
  ids: { traceId: string; spanId: string; parentId: string | undefined },
  runtimeId: string,
  agentId: string | undefined,
  warn: () => void
): { event: CanonicalEvent } | { reason: string } {
  const startNs = nanoBigInt(span.startTimeUnixNano);
  const endNs = nanoBigInt(span.endTimeUnixNano);
  const timestamp = nanoToMs(endNs) ?? nanoToMs(startNs);
  if (timestamp === undefined) return { reason: 'no_timestamp' };

  const failed = isFailedSpan(span.status, attrs);
  const provider = readAllowlistedStringFirst(attrs, ['gen_ai.provider.name', 'gen_ai.system'], warn) ?? 'unknown';
  const model = readAllowlistedStringFirst(attrs, ['gen_ai.response.model', 'gen_ai.request.model'], warn) ?? 'unknown';
  const inputTokens = readTokenCountFirst(attrs, ['gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens'], warn);
  const outputTokens = readTokenCountFirst(attrs, ['gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens'], warn);
  const cacheReadTokens = readTokenCountFirst(
    attrs,
    ['gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.cache_read_input_tokens'],
    warn
  );
  const cacheWriteTokens = readTokenCountFirst(
    attrs,
    ['gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_creation_input_tokens'],
    warn
  );
  const reasoningTokens = readTokenCountFirst(attrs, ['gen_ai.usage.reasoning.output_tokens'], warn);
  const latencyMs = computeLatencyMs(startNs, endNs);
  const requestId = readAllowlistedString(attrs, 'gen_ai.response.id', warn);
  const sessionId = readAllowlistedStringFirst(attrs, ['gen_ai.conversation.id', 'session.id'], warn);
  const cost = readCost(attrs, warn);
  const currency = cost !== undefined ? readCurrency(attrs, warn) : undefined;
  const costSourceAttr = cost !== undefined ? rawString(attrs.get('gen_ai.usage.cost.source')) : undefined;

  const payload: Record<string, unknown> = {
    provider,
    model,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(cost !== undefined
      ? { cost, costSource: costSourceAttr === 'provider-reported' ? 'provider-reported' : 'estimated' }
      : {}),
    ...(currency !== undefined ? { currency } : {}),
    traceId: ids.traceId,
    spanId: ids.spanId,
    ...(ids.parentId !== undefined ? { parentId: ids.parentId } : {}),
  };

  let type: 'llm.usage' | 'llm.failed';
  let severity: 'normal' | 'high';
  let summary: string;
  const agentPrefix = agentId !== undefined ? `${agentId}: ` : '';

  if (failed) {
    type = 'llm.failed';
    severity = 'high';
    const errorTypeRaw = readAllowlistedString(attrs, 'error.type', warn, 100);
    if (errorTypeRaw !== undefined) {
      payload.errorKind = errorKindFromErrorType(errorTypeRaw);
      payload.providerErrorCode = errorTypeRaw;
    }
    const kindSuffix = errorTypeRaw !== undefined ? ` (${errorKindFromErrorType(errorTypeRaw)})` : '';
    summary = `${agentPrefix}${model} call failed${kindSuffix}`;
  } else {
    type = 'llm.usage';
    severity = 'normal';
    const inPart = inputTokens !== undefined ? `${inputTokens} in` : '? in';
    const outPart = outputTokens !== undefined ? `${outputTokens} out` : '? out';
    summary = `${agentPrefix}${model} call, ${inPart} / ${outPart} tokens`;
  }

  const candidate = {
    schemaVersion: '1.0',
    id: `otlp:${ids.traceId}:${ids.spanId}:llm`,
    type,
    timestamp,
    runtimeId,
    source: runtimeId,
    ...(agentId !== undefined ? { agentId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    severity,
    summary,
    payload,
  };

  // `LlmUsagePayloadSchema` (issue #46, shipped before this item) keeps `inputTokens`/`outputTokens` required,
  // not nullable: only the cache/reasoning breakdown and `llm.failed`'s counts are nullish. A non-failed span
  // missing either one (for example an embeddings call whose instrumentation never set `output_tokens`) fails
  // validation here and is rejected as `unmappable`, never stored with an invented `0`: that is what "unknown
  // is not zero" means in practice given the contract this item was built on, rather than this item relaxing
  // #46's schema itself (out of scope for this item; see the issue's "Open questions", #2).
  const validation = validateCanonicalEvent(candidate);
  if (!validation.success || !validation.data) return { reason: 'unmappable' };
  return { event: validation.data };
}

/** Builds the `tool.started` + `tool.completed`/`tool.failed` pair for one `execute_tool` span, or a rejection reason. */
function buildToolEvents(
  span: OtlpSpan,
  attrs: Map<string, OtlpAnyValue>,
  ids: { traceId: string; spanId: string; parentId: string | undefined },
  runtimeId: string,
  agentId: string | undefined,
  warn: () => void
): { events: [CanonicalEvent, CanonicalEvent] } | { reason: string } {
  const tool =
    readAllowlistedString(attrs, 'gen_ai.tool.name', warn) ??
    (span.name?.startsWith('execute_tool ') ? span.name.slice('execute_tool '.length).trim() : undefined);
  if (!tool || tool.length === 0) return { reason: 'no_tool_name' };

  const startNs = nanoBigInt(span.startTimeUnixNano);
  const endNs = nanoBigInt(span.endTimeUnixNano);
  const startMs = nanoToMs(startNs);
  const endMs = nanoToMs(endNs);
  // A tool span with a zero/missing start falls back to its end for both events (issue #97).
  const startedAt = startMs ?? endMs;
  const endedAt = endMs ?? startMs;
  if (startedAt === undefined || endedAt === undefined) return { reason: 'no_timestamp' };

  const durationMs = computeLatencyMs(startNs, endNs);
  const toolCallId = readAllowlistedString(attrs, 'gen_ai.tool.call.id', warn);
  const toolCategory = readAllowlistedString(attrs, 'gen_ai.tool.type', warn);
  const failed = isFailedSpan(span.status, attrs);

  const sharedCorrelation = {
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    traceId: ids.traceId,
    spanId: ids.spanId,
    ...(ids.parentId !== undefined ? { parentId: ids.parentId } : {}),
  };

  const startedCandidate = {
    schemaVersion: '1.0',
    id: `otlp:${ids.traceId}:${ids.spanId}:tool.started`,
    type: 'tool.started',
    timestamp: startedAt,
    runtimeId,
    source: runtimeId,
    ...(agentId !== undefined ? { agentId } : {}),
    severity: 'normal',
    summary: `${tool} tool call started`,
    payload: { tool, ...sharedCorrelation, ...(toolCategory !== undefined ? { category: toolCategory } : {}) },
  };
  const startedValidation = validateCanonicalEvent(startedCandidate);
  if (!startedValidation.success || !startedValidation.data) return { reason: 'unmappable' };

  const endCandidate = {
    schemaVersion: '1.0',
    id: `otlp:${ids.traceId}:${ids.spanId}:tool.end`,
    type: failed ? 'tool.failed' : 'tool.completed',
    timestamp: endedAt,
    runtimeId,
    source: runtimeId,
    ...(agentId !== undefined ? { agentId } : {}),
    severity: failed ? 'high' : 'normal',
    summary: `${tool} tool call ${failed ? 'failed' : 'completed'}`,
    payload: { tool, ...sharedCorrelation, ...(durationMs !== undefined ? { durationMs } : {}) },
  };
  const endValidation = validateCanonicalEvent(endCandidate);
  if (!endValidation.success || !endValidation.data) return { reason: 'unmappable' };

  return { events: [startedValidation.data, endValidation.data] };
}

/**
 * Maps one parsed `ExportTraceServiceRequest` body into canonical events plus counters. Does not touch the
 * store: the caller runs `store.appendBatch` on `result.events`, folds the real accepted/duplicate/conflict
 * split into its own running totals, and builds the `partialSuccess`/debug-header counters from `result`.
 */
export function mapOtlpTraces(body: OtlpExportTraceServiceRequest, _options: MapOtlpTracesOptions = {}): OtlpTracesMapResult {
  const events: CanonicalEvent[] = [];
  const rejectedReasons: string[] = [];
  let ignored = 0;
  let warnings = 0;
  // Counts spans, not events: a tool span yields two events (started + completed/failed) but is one accepted
  // span, so `accepted + ignored + rejected.count` always equals the number of spans received.
  let acceptedSpans = 0;
  const warn = () => {
    warnings += 1;
  };

  const index = buildIndex(body);

  for (const rs of body.resourceSpans ?? []) {
    const resourceAttrs = attributeMap(rs.resource?.attributes);
    const serviceName = readAllowlistedString(resourceAttrs, 'service.name', warn);
    const runtimeId = `otlp:${serviceName ?? 'unknown_service'}`;

    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs = attributeMap(span.attributes);
        const category = classifySpan(attrs);
        if (category === 'ignore') {
          ignored += 1;
          continue;
        }

        const traceId = lowerHex(span.traceId);
        const spanId = lowerHex(span.spanId);
        const parentId = lowerHex(span.parentSpanId);

        if (!isValidTraceId(traceId)) {
          rejectedReasons.push('invalid_trace_id');
          continue;
        }
        if (!isValidSpanId(spanId)) {
          rejectedReasons.push('invalid_span_id');
          continue;
        }

        const agentId = resolveAgentId(span, attrs, serviceName, index, warn);
        const ids = { traceId, spanId, parentId };

        if (category === 'llm') {
          const result = buildLlmEvent(span, attrs, ids, runtimeId, agentId, warn);
          if ('reason' in result) {
            rejectedReasons.push(result.reason);
            continue;
          }
          events.push(result.event);
          acceptedSpans += 1;
        } else {
          const result = buildToolEvents(span, attrs, ids, runtimeId, agentId, warn);
          if ('reason' in result) {
            rejectedReasons.push(result.reason);
            continue;
          }
          events.push(...result.events);
          acceptedSpans += 1;
        }
      }
    }
  }

  // Ordering (issue #97): (timestamp, started before end, event id), so the agent status machine ends in the
  // status of the latest span and the result is deterministic.
  events.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    const rankOf = (e: CanonicalEvent) => (e.type === 'tool.started' ? 0 : 1);
    const rankDiff = rankOf(a) - rankOf(b);
    if (rankDiff !== 0) return rankDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return {
    events,
    accepted: acceptedSpans,
    ignored,
    warnings,
    rejected: { count: rejectedReasons.length, reasons: rejectedReasons },
  };
}
