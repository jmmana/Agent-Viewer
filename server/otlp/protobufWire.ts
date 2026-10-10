/**
 * Zero-dependency protobuf wire-format reader and writer (issue #73).
 *
 * Agent Viewer's only runtime dependencies are `express`, `lucide-react` and `zod` (issue #73, "Current
 * behavior"). Real OpenTelemetry exporters (Claude Code included) default to `http/protobuf`, so `/v1/logs`
 * and `/v1/metrics` need to read it without pulling in a protobuf library or the OpenTelemetry proto packages.
 * This module only understands the wire format itself (varint, 64-bit, length-delimited, 32-bit): it has no
 * idea what a `Metric` or a `LogRecord` is. `server/otlp/otlpProtobuf.ts` builds the OpenTelemetry-specific
 * message shapes on top of it, using a field-number table instead of a `.proto` file.
 *
 * Decoding rules (issue #73, section 2): unknown fields are skipped by walking past their wire-type-appropriate
 * length, wire types 3 and 4 (deprecated protobuf groups) are rejected as errors, a truncated field (not enough
 * bytes left for its declared type or length) is an error, and message nesting is capped at `MAX_DEPTH` so a
 * crafted input cannot force unbounded recursion.
 */

export class OtlpProtobufError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtlpProtobufError';
  }
}

/** Matches the depth cap called out by issue #73, section 2. */
export const MAX_DEPTH = 16;

type WireValue =
  | { wireType: 0; varint: bigint }
  | { wireType: 1; fixed64: bigint }
  | { wireType: 2; bytes: Uint8Array }
  | { wireType: 5; fixed32: number };

/** Every value seen for a field number, in wire order. Repeated fields (like `resourceLogs`) collect here. */
export type FieldMap = Map<number, WireValue[]>;

interface Cursor {
  i: number;
}

function readVarint(buf: Uint8Array, pos: Cursor): bigint {
  let result = 0n;
  let shift = 0n;
  for (let count = 0; count < 10; count++) {
    if (pos.i >= buf.length) throw new OtlpProtobufError('truncated varint');
    const byte = buf[pos.i++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return BigInt.asUintN(64, result);
    shift += 7n;
  }
  throw new OtlpProtobufError('varint longer than 10 bytes');
}

function readFixed64Bits(buf: Uint8Array, pos: Cursor): bigint {
  if (pos.i + 8 > buf.length) throw new OtlpProtobufError('truncated 64-bit field');
  let result = 0n;
  for (let k = 7; k >= 0; k--) result = (result << 8n) | BigInt(buf[pos.i + k]);
  pos.i += 8;
  return result;
}

function readFixed32Bits(buf: Uint8Array, pos: Cursor): number {
  if (pos.i + 4 > buf.length) throw new OtlpProtobufError('truncated 32-bit field');
  const value = (buf[pos.i] | (buf[pos.i + 1] << 8) | (buf[pos.i + 2] << 16) | (buf[pos.i + 3] << 24)) >>> 0;
  pos.i += 4;
  return value;
}

function readLengthDelimited(buf: Uint8Array, pos: Cursor): Uint8Array {
  const lengthBig = readVarint(buf, pos);
  if (lengthBig > BigInt(buf.length)) throw new OtlpProtobufError('truncated length-delimited field');
  const length = Number(lengthBig);
  if (pos.i + length > buf.length) throw new OtlpProtobufError('truncated length-delimited field');
  const bytes = buf.subarray(pos.i, pos.i + length);
  pos.i += length;
  return bytes;
}

/**
 * Parses one embedded message's bytes into a map of field number to every value seen for it (wire format only,
 * no schema). `depth` is the nesting level of `buf` itself: the top-level call is `decodeMessage(bytes, 0)`, and
 * every message-typed field decoded from the result should recurse with `depth + 1`.
 */
export function decodeMessage(buf: Uint8Array, depth = 0): FieldMap {
  if (depth > MAX_DEPTH) throw new OtlpProtobufError(`message nesting exceeds the depth cap (${MAX_DEPTH})`);
  const fields: FieldMap = new Map();
  const pos: Cursor = { i: 0 };
  while (pos.i < buf.length) {
    const tag = readVarint(buf, pos);
    const fieldNumber = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNumber === 0) throw new OtlpProtobufError('field number 0 is not valid');

    let value: WireValue;
    switch (wireType) {
      case 0:
        value = { wireType: 0, varint: readVarint(buf, pos) };
        break;
      case 1:
        value = { wireType: 1, fixed64: readFixed64Bits(buf, pos) };
        break;
      case 2:
        value = { wireType: 2, bytes: readLengthDelimited(buf, pos) };
        break;
      case 5:
        value = { wireType: 5, fixed32: readFixed32Bits(buf, pos) };
        break;
      case 3:
      case 4:
        throw new OtlpProtobufError(`wire type ${wireType} (protobuf groups) is not supported, field ${fieldNumber}`);
      default:
        throw new OtlpProtobufError(`unknown wire type ${wireType}, field ${fieldNumber}`);
    }

    const existing = fields.get(fieldNumber);
    if (existing) existing.push(value);
    else fields.set(fieldNumber, [value]);
  }
  return fields;
}

// -------------------------------------------------------------
// Typed field accessors. Each one returns undefined (or an empty array) rather than throwing when the field is
// absent or was encoded with an unexpected wire type: a mismatch is treated as "field not set", the same way a
// missing field is, not as a hard parse error (only the wire format itself, not the schema fit, is validated).
// -------------------------------------------------------------

export function firstBytes(fields: FieldMap, fieldNumber: number): Uint8Array | undefined {
  const value = fields.get(fieldNumber)?.find((v): v is { wireType: 2; bytes: Uint8Array } => v.wireType === 2);
  return value?.bytes;
}

export function allBytes(fields: FieldMap, fieldNumber: number): Uint8Array[] {
  return (fields.get(fieldNumber) ?? []).filter((v): v is { wireType: 2; bytes: Uint8Array } => v.wireType === 2).map((v) => v.bytes);
}

export function firstVarint(fields: FieldMap, fieldNumber: number): bigint | undefined {
  const value = fields.get(fieldNumber)?.find((v) => v.wireType === 0);
  return value && value.wireType === 0 ? value.varint : undefined;
}

export function firstFixed64(fields: FieldMap, fieldNumber: number): bigint | undefined {
  const value = fields.get(fieldNumber)?.find((v) => v.wireType === 1);
  return value && value.wireType === 1 ? value.fixed64 : undefined;
}

export function firstFixed32(fields: FieldMap, fieldNumber: number): number | undefined {
  const value = fields.get(fieldNumber)?.find((v) => v.wireType === 5);
  return value && value.wireType === 5 ? value.fixed32 : undefined;
}

export function firstString(fields: FieldMap, fieldNumber: number): string | undefined {
  const bytes = firstBytes(fields, fieldNumber);
  return bytes ? Buffer.from(bytes).toString('utf8') : undefined;
}

/** Interprets a raw 64-bit value (as read by `firstFixed64`) as `sfixed64` (two's complement signed). */
export function toSignedInt64(bits: bigint): bigint {
  return BigInt.asIntN(64, bits);
}

/** Interprets a raw 64-bit value (as read by `firstFixed64`) as an IEEE-754 `double`. */
export function fixed64ToDouble(bits: bigint): number {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt.asUintN(64, bits));
  return buf.readDoubleLE(0);
}

/** The reverse of `fixed64ToDouble`: an IEEE-754 `double` as the raw 64 bits `encodeFixed64Field` expects. */
export function doubleToFixed64Bits(value: number): bigint {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value);
  return buf.readBigUInt64LE(0);
}

// -------------------------------------------------------------
// Writer: only what building an OTLP response needs (`ExportMetricsServiceResponse`, `ExportLogsServiceResponse`
// and `google.rpc.Status`), so this stays small and symmetrical with the reader above instead of a general
// protobuf encoder.
// -------------------------------------------------------------

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function encodeVarint(value: bigint): Uint8Array {
  let v = BigInt.asUintN(64, value);
  const bytes: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0n);
  return Uint8Array.from(bytes);
}

function encodeTag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint(BigInt((fieldNumber << 3) | wireType));
}

/** A varint-wire-type field (bool, enum, int32/int64, uint32/uint64). */
export function encodeVarintField(fieldNumber: number, value: bigint | number | boolean): Uint8Array {
  const asBigInt = typeof value === 'boolean' ? BigInt(value ? 1 : 0) : typeof value === 'number' ? BigInt(value) : value;
  return concatBytes([encodeTag(fieldNumber, 0), encodeVarint(asBigInt)]);
}

/** A wire-type-1 (64-bit) field: `fixed64`, `sfixed64` or `double`. Callers pick the right bit pattern
 * (`toSignedInt64`/`doubleToFixed64Bits` and their inverses) before and after this; the wire format itself does
 * not distinguish between them. Used by the test fixture generator to build request messages (the runtime only
 * ever reads these fields, via `firstFixed64`), and by `fixed64ToDouble`'s own round-trip tests. */
export function encodeFixed64Field(fieldNumber: number, bits: bigint): Uint8Array {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt.asUintN(64, bits));
  return concatBytes([encodeTag(fieldNumber, 1), buf]);
}

/** A length-delimited field carrying raw bytes (used for both `string` and embedded messages). */
export function encodeBytesField(fieldNumber: number, bytes: Uint8Array): Uint8Array {
  return concatBytes([encodeTag(fieldNumber, 2), encodeVarint(BigInt(bytes.length)), bytes]);
}

export function encodeStringField(fieldNumber: number, value: string): Uint8Array {
  return encodeBytesField(fieldNumber, new TextEncoder().encode(value));
}

/** Wraps an already-encoded sub-message as a length-delimited field, the protobuf embedding convention. */
export function encodeMessageField(fieldNumber: number, innerBytes: Uint8Array): Uint8Array {
  return encodeBytesField(fieldNumber, innerBytes);
}

export function encodeMessage(parts: Uint8Array[]): Uint8Array {
  return concatBytes(parts);
}
