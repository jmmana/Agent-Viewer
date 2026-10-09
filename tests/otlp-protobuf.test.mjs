// Issue #73: unit tests for the zero-dependency protobuf wire decoder/encoder (`server/otlp/protobufWire.ts`)
// and the OpenTelemetry-proto message shapes built on it (`server/otlp/otlpProtobuf.ts`), plus an end-to-end
// check that the JSON and protobuf fixtures under `tests/fixtures/otlp/` normalize to the same thing once they
// reach the pure mappers (`server/otlp/metrics.ts`, `server/otlp/logs.ts`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  decodeMessage,
  firstVarint,
  firstFixed64,
  firstString,
  toSignedInt64,
  fixed64ToDouble,
  doubleToFixed64Bits,
  encodeVarint,
  encodeVarintField,
  encodeStringField,
  encodeFixed64Field,
  encodeMessageField,
  encodeMessage,
  OtlpProtobufError,
  MAX_DEPTH,
} from '../server/otlp/protobufWire.ts';
import {
  decodeExportLogsServiceRequest,
  decodeExportMetricsServiceRequest,
  encodeExportMetricsServiceResponse,
  encodeExportLogsServiceResponse,
  encodeStatus,
} from '../server/otlp/otlpProtobuf.ts';
import { mapOtlpMetricsRequest, looksLikeOtlpMetricsRequest } from '../server/otlp/metrics.ts';
import { mapOtlpLogsRequest, looksLikeOtlpLogsRequest } from '../server/otlp/logs.ts';

const fixturesDir = path.join(import.meta.dirname, 'fixtures/otlp');
const SECRET = Buffer.alloc(32, 7);

test('wire: varint round-trips across the single-byte/multi-byte boundary (127, 128, 300, large)', () => {
  for (const value of [0n, 1n, 127n, 128n, 300n, 16384n, 123456789n, 2n ** 53n, 2n ** 53n + 1n, 2n ** 63n - 1n]) {
    const encoded = encodeVarintField(1, value);
    const fields = decodeMessage(encoded);
    assert.equal(firstVarint(fields, 1), value);
  }
});

test('wire: an unknown field is skipped without disturbing the fields that are known', () => {
  const buf = encodeMessage([
    encodeVarintField(1, 42n),
    encodeStringField(99, 'nobody reads field 99'),
    encodeStringField(2, 'hello'),
  ]);
  const fields = decodeMessage(buf);
  assert.equal(firstVarint(fields, 1), 42n);
  assert.equal(firstString(fields, 2), 'hello');
  assert.ok(fields.has(99), 'the unknown field is still present in the map, just never read by a message decoder');
});

test('wire: truncated input is rejected at every stage (varint, length-delimited, fixed64)', () => {
  const full = encodeMessage([encodeStringField(1, 'hello world')]);
  // Cut the buffer at every point short of a full message; a length-0 prefix is a legitimately empty message
  // (decodes to no fields), but any other prefix must throw OtlpProtobufError, never silently return partial data.
  for (let cut = 1; cut < full.length; cut++) {
    assert.throws(() => decodeMessage(full.subarray(0, cut)), OtlpProtobufError, `prefix of length ${cut} should be rejected`);
  }

  const fixed64Buf = encodeFixed64Field(1, 123n);
  for (let cut = 1; cut < fixed64Buf.length; cut++) {
    assert.throws(() => decodeMessage(fixed64Buf.subarray(0, cut)), OtlpProtobufError);
  }

  // A varint tag with the continuation bit set and nothing after it.
  assert.throws(() => decodeMessage(Uint8Array.from([0x80])), OtlpProtobufError);
});

test('wire: a varint longer than 10 bytes is rejected (not silently truncated)', () => {
  const tenContinuations = new Uint8Array(11).fill(0x80);
  tenContinuations[10] = 0x01;
  assert.throws(() => decodeMessage(tenContinuations), OtlpProtobufError);
});

test('wire: wire types 3 and 4 (protobuf groups) are rejected', () => {
  // Tag byte for field 1, wire type 3 (start group): (1 << 3) | 3 = 0x0b.
  assert.throws(() => decodeMessage(Uint8Array.from([0x0b])), OtlpProtobufError);
  // Tag byte for field 1, wire type 4 (end group): (1 << 3) | 4 = 0x0c.
  assert.throws(() => decodeMessage(Uint8Array.from([0x0c])), OtlpProtobufError);
});

test('wire: nested messages are capped at the documented depth', () => {
  assert.throws(() => decodeMessage(new Uint8Array(0), MAX_DEPTH + 1), OtlpProtobufError);
  // At the cap itself, an empty message still decodes fine: the cap rejects exceeding it, not reaching it.
  assert.deepEqual(decodeMessage(new Uint8Array(0), MAX_DEPTH), new Map());
});

test('wire: int64 values above and below 2^53 round-trip exactly through fixed64/sfixed64', () => {
  for (const value of [0n, 1n, 2n ** 53n - 1n, 2n ** 53n, 2n ** 53n + 1n, 2n ** 62n]) {
    const buf = encodeFixed64Field(1, value);
    const fields = decodeMessage(buf);
    assert.equal(toSignedInt64(firstFixed64(fields, 1)), value);
  }
});

test('wire: sfixed64 negative values decode correctly (twos complement)', () => {
  for (const value of [-1n, -5n, -(2n ** 53n), -(2n ** 62n)]) {
    const buf = encodeFixed64Field(1, value);
    const fields = decodeMessage(buf);
    assert.equal(toSignedInt64(firstFixed64(fields, 1)), value);
  }
});

test('wire: double round-trips through fixed64 bits', () => {
  for (const value of [0, 0.0184, -3.5, 1.7976931348623157e308, Number.MIN_VALUE]) {
    const buf = encodeFixed64Field(4, doubleToFixed64Bits(value));
    const fields = decodeMessage(buf);
    assert.equal(fixed64ToDouble(firstFixed64(fields, 4)), value);
  }
});

test('wire: encodeVarint rejects nothing for 0 and round-trips the empty tag path', () => {
  assert.deepEqual(encodeVarint(0n), Uint8Array.from([0]));
});

test('otlpProtobuf: ExportLogsServiceResponse encodes an empty success and a partialSuccess with the right field numbers', () => {
  const empty = encodeExportLogsServiceResponse();
  assert.equal(empty.length, 0);

  const partial = encodeExportLogsServiceResponse({ rejectedCount: 2, errorMessage: 'bad records' });
  const outer = decodeMessage(partial);
  const partialSuccessBytes = outer.get(1)[0].bytes;
  const inner = decodeMessage(partialSuccessBytes, 1);
  assert.equal(firstVarint(inner, 1), 2n);
  assert.equal(firstString(inner, 2), 'bad records');
});

test('otlpProtobuf: ExportMetricsServiceResponse uses the same shape as the logs response', () => {
  const partial = encodeExportMetricsServiceResponse({ rejectedCount: 1, errorMessage: 'one bad point' });
  const outer = decodeMessage(partial);
  const inner = decodeMessage(outer.get(1)[0].bytes, 1);
  assert.equal(firstVarint(inner, 1), 1n);
  assert.equal(firstString(inner, 2), 'one bad point');
});

test('otlpProtobuf: google.rpc.Status encodes code and message', () => {
  const status = encodeStatus(3, 'Expected an OTLP ExportLogsServiceRequest with resourceLogs');
  const fields = decodeMessage(status);
  assert.equal(firstVarint(fields, 1), 3n);
  assert.equal(firstString(fields, 2), 'Expected an OTLP ExportLogsServiceRequest with resourceLogs');
});

test('otlpProtobuf: a malformed protobuf buffer raises OtlpProtobufError, not a silent empty result', () => {
  assert.throws(() => decodeExportMetricsServiceRequest(Uint8Array.from([0xff, 0xff, 0xff])), OtlpProtobufError);
  assert.throws(() => decodeExportLogsServiceRequest(Uint8Array.from([0xff, 0xff, 0xff])), OtlpProtobufError);
});

// -------------------------------------------------------------
// Fixture-based end-to-end: the JSON and protobuf forms of the same export normalize to the same thing once
// mapped (issue #73 acceptance criteria). Fixtures and their generator live in tests/fixtures/otlp/.
// -------------------------------------------------------------

function readJsonFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8'));
}

function readPbFixture(name) {
  return new Uint8Array(fs.readFileSync(path.join(fixturesDir, `${name}.pb`)));
}

test('fixtures: metrics-request.json and metrics-request.pb map to the same telemetry points', () => {
  const jsonBody = readJsonFixture('metrics-request');
  const pbBody = decodeExportMetricsServiceRequest(readPbFixture('metrics-request'));
  assert.ok(looksLikeOtlpMetricsRequest(jsonBody));
  assert.ok(looksLikeOtlpMetricsRequest(pbBody));

  const now = 1767225600000;
  const fromJson = mapOtlpMetricsRequest(jsonBody, { now, wireFormat: 'json', hmacSecret: SECRET });
  const fromPb = mapOtlpMetricsRequest(pbBody, { now, wireFormat: 'protobuf', hmacSecret: SECRET });

  assert.equal(fromJson.points.length, 2);
  assert.equal(fromPb.points.length, 2);
  // Values, series keys and every field except `wireFormat` and `receivedAt` must be identical: the same bytes
  // of consumption, reported two different ways on the wire, must be stored as the exact same evidence.
  for (let i = 0; i < fromJson.points.length; i++) {
    const { wireFormat: _j, ...jsonPoint } = fromJson.points[i];
    const { wireFormat: _p, ...pbPoint } = fromPb.points[i];
    assert.deepEqual(pbPoint, jsonPoint);
  }
});

test('fixtures: logs-request.json and logs-request.pb map to the same llm.usage event', () => {
  const jsonBody = readJsonFixture('logs-request');
  const pbBody = decodeExportLogsServiceRequest(readPbFixture('logs-request'));
  assert.ok(looksLikeOtlpLogsRequest(jsonBody));
  assert.ok(looksLikeOtlpLogsRequest(pbBody));

  const now = 1767225600000;
  const fromJson = mapOtlpLogsRequest(jsonBody, { now });
  const fromPb = mapOtlpLogsRequest(pbBody, { now });

  assert.equal(fromJson.events.length, 1);
  assert.deepEqual(fromPb.events, fromJson.events);
});
