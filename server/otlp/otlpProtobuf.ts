/**
 * OpenTelemetry-proto message shapes (issue #73, section 2), built on the generic wire reader/writer in
 * `server/otlp/protobufWire.ts`. Only the subset of `opentelemetry-proto` v1 that `/v1/logs` (issue #59) and
 * `/v1/metrics` (issue #73) actually read: `ExportLogsServiceRequest` and `ExportMetricsServiceRequest`, plus
 * their response messages. The field-number table below is the complete contract; nothing else is decoded,
 * and any field not listed is simply left in the wire reader's map, which is the same as being skipped.
 *
 * Decoding yields the OTLP/JSON shape (lowerCamelCase keys, `int64`/`fixed64` as decimal strings, enums as
 * plain integers) so `src/integrations/otlp/claudeCodeLogs.ts` and `server/otlp/metrics.ts` never see the wire
 * format: both read one JSON-shaped object regardless of which content type the exporter used (issue #73,
 * "one code path").
 */
import {
  type FieldMap,
  decodeMessage,
  firstBytes,
  allBytes,
  firstVarint,
  firstFixed64,
  firstString,
  toSignedInt64,
  fixed64ToDouble,
  encodeVarintField,
  encodeStringField,
  encodeMessageField,
  encodeMessage,
  OtlpProtobufError,
} from './protobufWire';

export { OtlpProtobufError };

// -------------------------------------------------------------
// Common: KeyValue / AnyValue / Resource
// -------------------------------------------------------------

interface JsonAnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
}

interface JsonKeyValue {
  key: string;
  value?: JsonAnyValue;
}

function decodeAnyValue(bytes: Uint8Array, depth: number): JsonAnyValue {
  const fields = decodeMessage(bytes, depth);
  const stringValue = firstString(fields, 1);
  if (stringValue !== undefined) return { stringValue };
  const boolVarint = firstVarint(fields, 2);
  if (boolVarint !== undefined) return { boolValue: boolVarint !== 0n };
  const intVarint = firstVarint(fields, 3);
  if (intVarint !== undefined) return { intValue: toSignedInt64(intVarint).toString() };
  const doubleBits = firstFixed64(fields, 4);
  if (doubleBits !== undefined) return { doubleValue: fixed64ToDouble(doubleBits) };
  // array_value (5), kvlist_value (6) and bytes_value (7) are not read by any mapper today: an AnyValue of
  // one of those kinds normalizes to an empty object, the same as "no recognized value set".
  return {};
}

function decodeKeyValue(bytes: Uint8Array, depth: number): JsonKeyValue {
  const fields = decodeMessage(bytes, depth);
  const key = firstString(fields, 1) ?? '';
  const valueBytes = firstBytes(fields, 2);
  return { key, ...(valueBytes ? { value: decodeAnyValue(valueBytes, depth + 1) } : {}) };
}

function decodeAttributes(fields: FieldMap, fieldNumber: number, depth: number): JsonKeyValue[] {
  return allBytes(fields, fieldNumber).map((bytes) => decodeKeyValue(bytes, depth));
}

function decodeResource(bytes: Uint8Array, depth: number): { attributes: JsonKeyValue[] } {
  const fields = decodeMessage(bytes, depth);
  return { attributes: decodeAttributes(fields, 1, depth + 1) };
}

/** A `fixed64`/`int64` field rendered the OTLP/JSON way: a decimal string, `undefined` when absent. */
function decimalString(bits: bigint | undefined): string | undefined {
  return bits === undefined ? undefined : bits.toString();
}

// -------------------------------------------------------------
// Logs: ExportLogsServiceRequest (issue #59's http/json shape, now also reachable from protobuf)
// -------------------------------------------------------------

interface JsonLogRecord {
  timeUnixNano?: string;
  observedTimeUnixNano?: string;
  eventName?: string;
  body?: JsonAnyValue;
  attributes?: JsonKeyValue[];
}

interface JsonResourceLogs {
  resource?: { attributes: JsonKeyValue[] };
  scopeLogs?: Array<{ logRecords?: JsonLogRecord[] }>;
}

export interface JsonExportLogsServiceRequest {
  resourceLogs?: JsonResourceLogs[];
}

function decodeLogRecord(bytes: Uint8Array, depth: number): JsonLogRecord {
  const fields = decodeMessage(bytes, depth);
  const bodyBytes = firstBytes(fields, 5);
  return {
    timeUnixNano: decimalString(firstFixed64(fields, 1)),
    observedTimeUnixNano: decimalString(firstFixed64(fields, 11)),
    eventName: firstString(fields, 12),
    ...(bodyBytes ? { body: decodeAnyValue(bodyBytes, depth + 1) } : {}),
    attributes: decodeAttributes(fields, 6, depth + 1),
  };
}

function decodeScopeLogs(bytes: Uint8Array, depth: number): { logRecords: JsonLogRecord[] } {
  const fields = decodeMessage(bytes, depth);
  return { logRecords: allBytes(fields, 2).map((b) => decodeLogRecord(b, depth + 1)) };
}

function decodeResourceLogs(bytes: Uint8Array, depth: number): JsonResourceLogs {
  const fields = decodeMessage(bytes, depth);
  const resourceBytes = firstBytes(fields, 1);
  return {
    ...(resourceBytes ? { resource: decodeResource(resourceBytes, depth + 1) } : {}),
    scopeLogs: allBytes(fields, 2).map((b) => decodeScopeLogs(b, depth + 1)),
  };
}

/** Decodes a binary `ExportLogsServiceRequest` into the same shape `src/integrations/otlp/claudeCodeLogs.ts` already reads from JSON. */
export function decodeExportLogsServiceRequest(buf: Uint8Array): JsonExportLogsServiceRequest {
  const fields = decodeMessage(buf, 0);
  return { resourceLogs: allBytes(fields, 1).map((b) => decodeResourceLogs(b, 1)) };
}

// -------------------------------------------------------------
// Metrics: ExportMetricsServiceRequest (issue #73)
// -------------------------------------------------------------

export interface JsonNumberDataPoint {
  startTimeUnixNano?: string;
  timeUnixNano?: string;
  asDouble?: number;
  asInt?: string;
  attributes?: JsonKeyValue[];
  flags?: number;
}

export interface JsonSum {
  dataPoints: JsonNumberDataPoint[];
  aggregationTemporality?: number;
  isMonotonic?: boolean;
}

export interface JsonMetric {
  name?: string;
  unit?: string;
  sum?: JsonSum;
  /** `true` when the metric used `gauge`, `histogram`, `exponentialHistogram` or `summary` instead of `sum`. */
  isOtherKind: boolean;
}

export interface JsonScopeMetrics {
  metrics?: JsonMetric[];
}

export interface JsonResourceMetrics {
  resource?: { attributes: JsonKeyValue[] };
  scopeMetrics?: JsonScopeMetrics[];
}

export interface JsonExportMetricsServiceRequest {
  resourceMetrics?: JsonResourceMetrics[];
}

function decodeNumberDataPoint(bytes: Uint8Array, depth: number): JsonNumberDataPoint {
  const fields = decodeMessage(bytes, depth);
  const asDoubleBits = firstFixed64(fields, 4);
  const asIntBits = firstFixed64(fields, 6);
  const flags = firstVarint(fields, 8);
  return {
    startTimeUnixNano: decimalString(firstFixed64(fields, 2)),
    timeUnixNano: decimalString(firstFixed64(fields, 3)),
    ...(asDoubleBits !== undefined ? { asDouble: fixed64ToDouble(asDoubleBits) } : {}),
    ...(asIntBits !== undefined ? { asInt: toSignedInt64(asIntBits).toString() } : {}),
    attributes: decodeAttributes(fields, 7, depth + 1),
    ...(flags !== undefined ? { flags: Number(flags) } : {}),
  };
}

function decodeSum(bytes: Uint8Array, depth: number): JsonSum {
  const fields = decodeMessage(bytes, depth);
  const temporality = firstVarint(fields, 2);
  const isMonotonic = firstVarint(fields, 3);
  return {
    dataPoints: allBytes(fields, 1).map((b) => decodeNumberDataPoint(b, depth + 1)),
    ...(temporality !== undefined ? { aggregationTemporality: Number(temporality) } : {}),
    ...(isMonotonic !== undefined ? { isMonotonic: isMonotonic !== 0n } : {}),
  };
}

function decodeMetric(bytes: Uint8Array, depth: number): JsonMetric {
  const fields = decodeMessage(bytes, depth);
  const sumBytes = firstBytes(fields, 7);
  // Field numbers of the other OTLP metric point kinds (gauge 5, histogram 9, exponentialHistogram 10,
  // summary 11): detected only so a metric sent as one of these can be rejected as "not Sum", never decoded.
  const isOtherKind = fields.has(5) || fields.has(9) || fields.has(10) || fields.has(11);
  return {
    name: firstString(fields, 1),
    unit: firstString(fields, 3),
    ...(sumBytes ? { sum: decodeSum(sumBytes, depth + 1) } : {}),
    isOtherKind,
  };
}

function decodeScopeMetrics(bytes: Uint8Array, depth: number): JsonScopeMetrics {
  const fields = decodeMessage(bytes, depth);
  return { metrics: allBytes(fields, 2).map((b) => decodeMetric(b, depth + 1)) };
}

function decodeResourceMetrics(bytes: Uint8Array, depth: number): JsonResourceMetrics {
  const fields = decodeMessage(bytes, depth);
  const resourceBytes = firstBytes(fields, 1);
  return {
    ...(resourceBytes ? { resource: decodeResource(resourceBytes, depth + 1) } : {}),
    scopeMetrics: allBytes(fields, 2).map((b) => decodeScopeMetrics(b, depth + 1)),
  };
}

export function decodeExportMetricsServiceRequest(buf: Uint8Array): JsonExportMetricsServiceRequest {
  const fields = decodeMessage(buf, 0);
  return { resourceMetrics: allBytes(fields, 1).map((b) => decodeResourceMetrics(b, 1)) };
}

// -------------------------------------------------------------
// Traces: ExportTraceServiceRequest (issue #97)
// -------------------------------------------------------------

export interface JsonStatus {
  message?: string;
  /** `0` UNSET, `1` OK, `2` ERROR (OTLP/JSON leaves the enum as a plain integer, same as `kind` below). */
  code?: number;
}

export interface JsonSpan {
  /** Lowercase hex, decoded from the wire's raw `bytes` field (never base64: that is the JSON wire shape only
   * for `bytes`, and this decoder always normalizes to the OTLP/JSON *string* convention used by trace/span
   * ids specifically, which real exporters and the JSON examples in `docs/otlp.md` both send as hex). */
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: JsonKeyValue[];
  status?: JsonStatus;
}

export interface JsonScopeSpans {
  spans?: JsonSpan[];
}

export interface JsonResourceSpans {
  resource?: { attributes: JsonKeyValue[] };
  scopeSpans?: JsonScopeSpans[];
}

export interface JsonExportTraceServiceRequest {
  resourceSpans?: JsonResourceSpans[];
}

/** Raw `bytes` (wire type 2) rendered as lowercase hex, OTLP/JSON's convention for `trace_id`/`span_id`. */
function hexBytes(bytes: Uint8Array | undefined): string | undefined {
  return bytes && bytes.length > 0 ? Buffer.from(bytes).toString('hex') : undefined;
}

function decodeStatus(bytes: Uint8Array, depth: number): JsonStatus {
  const fields = decodeMessage(bytes, depth);
  const code = firstVarint(fields, 3);
  return {
    message: firstString(fields, 2),
    ...(code !== undefined ? { code: Number(code) } : {}),
  };
}

/**
 * Only the fields any mapper in this codebase reads (`src/integrations/otlpTraces.ts`): `events` (field 11) and
 * `links` (field 13) are deliberately never decoded, not even into the generic `FieldMap`, so prompt/completion
 * content some instrumentations attach as span events can never reach a mapper or a log line (issue #97,
 * "Privacy by construction"). They are skipped at the wire level by `decodeMessage` itself, the same as any
 * other field number this function does not ask for.
 */
function decodeSpan(bytes: Uint8Array, depth: number): JsonSpan {
  const fields = decodeMessage(bytes, depth);
  const statusBytes = firstBytes(fields, 15);
  const kind = firstVarint(fields, 6);
  return {
    traceId: hexBytes(firstBytes(fields, 1)),
    spanId: hexBytes(firstBytes(fields, 2)),
    parentSpanId: hexBytes(firstBytes(fields, 4)),
    name: firstString(fields, 5),
    ...(kind !== undefined ? { kind: Number(kind) } : {}),
    startTimeUnixNano: decimalString(firstFixed64(fields, 7)),
    endTimeUnixNano: decimalString(firstFixed64(fields, 8)),
    attributes: decodeAttributes(fields, 9, depth + 1),
    ...(statusBytes ? { status: decodeStatus(statusBytes, depth + 1) } : {}),
  };
}

function decodeScopeSpans(bytes: Uint8Array, depth: number): JsonScopeSpans {
  const fields = decodeMessage(bytes, depth);
  return { spans: allBytes(fields, 2).map((b) => decodeSpan(b, depth + 1)) };
}

function decodeResourceSpans(bytes: Uint8Array, depth: number): JsonResourceSpans {
  const fields = decodeMessage(bytes, depth);
  const resourceBytes = firstBytes(fields, 1);
  return {
    ...(resourceBytes ? { resource: decodeResource(resourceBytes, depth + 1) } : {}),
    scopeSpans: allBytes(fields, 2).map((b) => decodeScopeSpans(b, depth + 1)),
  };
}

/** Decodes a binary `ExportTraceServiceRequest` into the same OTLP/JSON shape `src/integrations/otlpTraces.ts` reads. */
export function decodeExportTraceServiceRequest(buf: Uint8Array): JsonExportTraceServiceRequest {
  const fields = decodeMessage(buf, 0);
  return { resourceSpans: allBytes(fields, 1).map((b) => decodeResourceSpans(b, 1)) };
}

// -------------------------------------------------------------
// Responses: ExportLogsServiceResponse / ExportMetricsServiceResponse / google.rpc.Status
// -------------------------------------------------------------

export interface OtlpPartialSuccess {
  rejectedCount: number;
  errorMessage: string;
}

/**
 * Both `ExportLogsPartialSuccess` and `ExportMetricsPartialSuccess` use field 1 for the rejected count
 * (`rejected_log_records` / `rejected_data_points`, both `int64`) and field 2 for `error_message`.
 */
function encodePartialSuccess(partial: OtlpPartialSuccess): Uint8Array {
  return encodeMessage([
    encodeVarintField(1, BigInt(partial.rejectedCount)),
    ...(partial.errorMessage ? [encodeStringField(2, partial.errorMessage)] : []),
  ]);
}

/** Field 1 of both `ExportLogsServiceResponse` and `ExportMetricsServiceResponse` is `partial_success`. */
function encodeExportResponse(partial?: OtlpPartialSuccess): Uint8Array {
  if (!partial) return encodeMessage([]);
  return encodeMessageField(1, encodePartialSuccess(partial));
}

export function encodeExportLogsServiceResponse(partial?: OtlpPartialSuccess): Uint8Array {
  return encodeExportResponse(partial);
}

export function encodeExportMetricsServiceResponse(partial?: OtlpPartialSuccess): Uint8Array {
  return encodeExportResponse(partial);
}

/** `ExportTraceServiceResponse` (issue #97): same shape as the logs/metrics responses above, field 1
 * `partial_success`, whose own field 1 is `rejected_spans` (int64) and field 2 `error_message` (string). */
export function encodeExportTraceServiceResponse(partial?: OtlpPartialSuccess): Uint8Array {
  return encodeExportResponse(partial);
}

/** `google.rpc.Status`: field 1 `code` (int32), field 2 `message` (string). No `details` (field 3). */
export function encodeStatus(code: number, message: string): Uint8Array {
  return encodeMessage([encodeVarintField(1, BigInt(code)), encodeStringField(2, message)]);
}
