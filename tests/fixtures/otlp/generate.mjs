#!/usr/bin/env -S npx tsx
/**
 * Generates the binary (`.pb`) OTLP fixtures next to their JSON twins (issue #73's acceptance criteria require
 * the JSON and protobuf forms of the same export to normalize to the same object, and the generator script that
 * produced the `.pb` files committed alongside them).
 *
 * The issue's own suggestion was to capture these from the official OpenTelemetry Python SDK's `otlp-proto-http`
 * exporter. That was not used here: Agent Viewer's zero-dependency decoder (`server/otlp/protobufWire.ts`,
 * `server/otlp/otlpProtobuf.ts`) only reads the wire format, it does not write request messages (the runtime
 * only ever needs to *encode* a response, never a request), and installing the Python OpenTelemetry SDK was not
 * practical for this change. Instead, this script is a small request-side protobuf encoder built directly on
 * the same generic wire primitives the runtime decoder itself exports (`encodeVarintField`, `encodeStringField`,
 * `encodeFixed64Field`, `encodeMessageField`), driven by the exact field-number table from issue #73, section 2.
 * It is deliberately kept out of `server/`: it is a test-fixture tool, not a runtime capability, so it is never
 * on the path that decides whether a real OTLP exporter's bytes are accepted.
 *
 * Run with `npx tsx tests/fixtures/otlp/generate.mjs` after changing a fixture's JSON shape below, then commit
 * both the `.json` and the regenerated `.pb` file.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  encodeVarintField,
  encodeStringField,
  encodeFixed64Field,
  encodeMessageField,
  encodeMessage,
  doubleToFixed64Bits,
} from '../../../server/otlp/protobufWire.ts';

const outDir = path.join(import.meta.dirname);

// -------------------------------------------------------------
// Request-side encoders, field numbers from issue #73 section 2's table.
// -------------------------------------------------------------

function encodeAnyValue(value) {
  if (value === undefined) return encodeMessage([]);
  if (typeof value.stringValue === 'string') return encodeMessage([encodeStringField(1, value.stringValue)]);
  if (typeof value.boolValue === 'boolean') return encodeMessage([encodeVarintField(2, value.boolValue)]);
  if (value.intValue !== undefined) return encodeMessage([encodeVarintField(3, BigInt(value.intValue))]);
  if (typeof value.doubleValue === 'number') return encodeMessage([encodeFixed64Field(4, doubleToFixed64Bits(value.doubleValue))]);
  return encodeMessage([]);
}

function encodeKeyValue(attr) {
  return encodeMessage([encodeStringField(1, attr.key), ...(attr.value ? [encodeMessageField(2, encodeAnyValue(attr.value))] : [])]);
}

function encodeAttributes(fieldNumber, attributes) {
  return (attributes ?? []).map((attr) => encodeMessageField(fieldNumber, encodeKeyValue(attr)));
}

function encodeResource(resource) {
  return encodeMessage(encodeAttributes(1, resource?.attributes));
}

function encodeNumberDataPoint(dp) {
  const parts = [];
  if (dp.startTimeUnixNano !== undefined) parts.push(encodeFixed64Field(2, BigInt(dp.startTimeUnixNano)));
  if (dp.timeUnixNano !== undefined) parts.push(encodeFixed64Field(3, BigInt(dp.timeUnixNano)));
  if (dp.asDouble !== undefined) parts.push(encodeFixed64Field(4, doubleToFixed64Bits(dp.asDouble)));
  if (dp.asInt !== undefined) parts.push(encodeFixed64Field(6, BigInt(dp.asInt)));
  parts.push(...encodeAttributes(7, dp.attributes));
  if (dp.flags !== undefined) parts.push(encodeVarintField(8, dp.flags));
  return encodeMessage(parts);
}

function encodeSum(sum) {
  const parts = (sum.dataPoints ?? []).map((dp) => encodeMessageField(1, encodeNumberDataPoint(dp)));
  if (sum.aggregationTemporality !== undefined) parts.push(encodeVarintField(2, sum.aggregationTemporality));
  if (sum.isMonotonic !== undefined) parts.push(encodeVarintField(3, sum.isMonotonic));
  return encodeMessage(parts);
}

function encodeMetric(metric) {
  const parts = [];
  if (metric.name !== undefined) parts.push(encodeStringField(1, metric.name));
  if (metric.unit !== undefined) parts.push(encodeStringField(3, metric.unit));
  if (metric.sum) parts.push(encodeMessageField(7, encodeSum(metric.sum)));
  return encodeMessage(parts);
}

function encodeScopeMetrics(scope) {
  return encodeMessage((scope.metrics ?? []).map((m) => encodeMessageField(2, encodeMetric(m))));
}

function encodeResourceMetrics(rm) {
  const parts = [];
  if (rm.resource) parts.push(encodeMessageField(1, encodeResource(rm.resource)));
  parts.push(...(rm.scopeMetrics ?? []).map((sm) => encodeMessageField(2, encodeScopeMetrics(sm))));
  return encodeMessage(parts);
}

export function encodeExportMetricsServiceRequest(body) {
  return encodeMessage((body.resourceMetrics ?? []).map((rm) => encodeMessageField(1, encodeResourceMetrics(rm))));
}

function encodeLogRecord(record) {
  const parts = [];
  if (record.timeUnixNano !== undefined) parts.push(encodeFixed64Field(1, BigInt(record.timeUnixNano)));
  if (record.body) parts.push(encodeMessageField(5, encodeAnyValue(record.body)));
  parts.push(...encodeAttributes(6, record.attributes));
  if (record.observedTimeUnixNano !== undefined) parts.push(encodeFixed64Field(11, BigInt(record.observedTimeUnixNano)));
  if (record.eventName !== undefined) parts.push(encodeStringField(12, record.eventName));
  return encodeMessage(parts);
}

function encodeScopeLogs(scope) {
  return encodeMessage((scope.logRecords ?? []).map((r) => encodeMessageField(2, encodeLogRecord(r))));
}

function encodeResourceLogs(rl) {
  const parts = [];
  if (rl.resource) parts.push(encodeMessageField(1, encodeResource(rl.resource)));
  parts.push(...(rl.scopeLogs ?? []).map((sl) => encodeMessageField(2, encodeScopeLogs(sl))));
  return encodeMessage(parts);
}

export function encodeExportLogsServiceRequest(body) {
  return encodeMessage((body.resourceLogs ?? []).map((rl) => encodeMessageField(1, encodeResourceLogs(rl))));
}

// -------------------------------------------------------------
// Fixture content. Session ids are synthetic UUIDs, never real customer data.
// -------------------------------------------------------------

const metricsRequest = {
  resourceMetrics: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
      scopeMetrics: [
        {
          metrics: [
            {
              name: 'claude_code.token.usage',
              unit: 'tokens',
              sum: {
                aggregationTemporality: 1,
                isMonotonic: true,
                dataPoints: [
                  {
                    attributes: [
                      { key: 'session.id', value: { stringValue: '8f1c2b3a-0000-4000-8000-000000000001' } },
                      { key: 'model', value: { stringValue: 'claude-sonnet-4-5' } },
                      { key: 'type', value: { stringValue: 'input' } },
                    ],
                    startTimeUnixNano: '1767225540000000000',
                    timeUnixNano: '1767225600000000000',
                    asInt: '1200',
                  },
                ],
              },
            },
            {
              name: 'claude_code.cost.usage',
              unit: 'USD',
              sum: {
                aggregationTemporality: 1,
                isMonotonic: true,
                dataPoints: [
                  {
                    attributes: [
                      { key: 'session.id', value: { stringValue: '8f1c2b3a-0000-4000-8000-000000000001' } },
                      { key: 'model', value: { stringValue: 'claude-sonnet-4-5' } },
                    ],
                    startTimeUnixNano: '1767225540000000000',
                    timeUnixNano: '1767225600000000000',
                    asDouble: 0.0184,
                  },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};

const logsRequest = {
  resourceLogs: [
    {
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
      scopeLogs: [
        {
          logRecords: [
            {
              timeUnixNano: '1767225600000000000',
              eventName: 'claude_code.api_request',
              attributes: [
                { key: 'session.id', value: { stringValue: '8f1c2b3a-0000-4000-8000-000000000001' } },
                { key: 'model', value: { stringValue: 'claude-sonnet-4-5' } },
                { key: 'input_tokens', value: { intValue: '1200' } },
                { key: 'output_tokens', value: { intValue: '340' } },
                { key: 'request_id', value: { stringValue: 'req-fixture-1' } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function write(name, body, encoder) {
  fs.writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, `${name}.pb`), Buffer.from(encoder(body)));
}

write('metrics-request', metricsRequest, encodeExportMetricsServiceRequest);
write('logs-request', logsRequest, encodeExportLogsServiceRequest);

console.log(`Wrote fixtures to ${outDir}`);
