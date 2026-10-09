import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEventLog, MAX_EVENT_LOG_SIZE_BYTES } from '../src/integrations/eventLogParser.ts';
import { SessionReplayPlayer } from '../src/integrations/replayEngine.ts';
import { createLiveSimulationState } from '../src/engine/simulationEngine.ts';

const otlpFixturesDir = fileURLToPath(new URL('./fixtures/otlp/', import.meta.url));
function readOtlpFixture(name) {
  return fs.readFileSync(path.join(otlpFixturesDir, name), 'utf8');
}

test('Event log parser: parses valid Canonical JSONL V1 lines', async () => {
  const jsonl = [
    JSON.stringify({
      schemaVersion: '1.0',
      id: 'evt_01',
      type: 'agent.registered',
      timestamp: 1000,
      source: 'test',
      summary: 'Agent Registered',
      payload: { name: 'Bot 1' },
    }),
    JSON.stringify({
      schemaVersion: '1.0',
      id: 'evt_02',
      type: 'agent.status.changed',
      timestamp: 2000,
      source: 'test',
      agentId: 'Bot 1',
      summary: 'Status changed',
      payload: { status: 'THINKING' },
    }),
  ].join('\n');

  const res = await parseEventLog(jsonl);
  assert.equal(res.events.length, 2);
  assert.equal(res.issues.length, 0);
  assert.equal(res.format, 'jsonl');
  assert.equal(res.events[0].id, 'evt_01');
  assert.equal(res.events[1].id, 'evt_02');
});

test('Event log parser: captures invalid and malformed lines without aborting valid lines', async () => {
  const lines = [
    JSON.stringify({
      schemaVersion: '1.0',
      id: 'evt_valid_1',
      type: 'agent.status.changed',
      timestamp: 1000,
      source: 'test',
      summary: 'Valid event 1',
      payload: { status: 'IDLE' },
    }),
    '{ malformed json here',
    JSON.stringify({
      schemaVersion: '1.0',
      id: '', // invalid empty ID
      type: 'agent.status.changed',
      timestamp: 2000,
      source: 'test',
      summary: 'Invalid event',
      payload: { status: 'IDLE' },
    }),
    JSON.stringify({
      schemaVersion: '1.0',
      id: 'evt_valid_2',
      type: 'agent.message.sent',
      timestamp: 3000,
      source: 'test',
      summary: 'Valid event 2',
      payload: { text: 'Hello' },
    }),
  ].join('\n');

  const res = await parseEventLog(lines);
  assert.equal(res.events.length, 2);
  assert.equal(res.events[0].id, 'evt_valid_1');
  assert.equal(res.events[1].id, 'evt_valid_2');
  assert.equal(res.issues.length, 2);
  assert.equal(res.issues[0].line, 2); // malformed
  assert.equal(res.issues[1].line, 3); // invalid schema
});

test('Event log parser: accepts llm.failed lines and keeps unknown figures absent', async () => {
  const jsonl = [
    JSON.stringify({
      schemaVersion: '1.0',
      id: 'evt_usage_log',
      type: 'llm.usage',
      timestamp: 1000,
      source: 'agent:researcher',
      summary: 'Usage report',
      payload: { provider: 'Anthropic', model: 'claude-sonnet', inputTokens: 1200, outputTokens: 80, cacheReadTokens: 1000 },
    }),
    JSON.stringify({
      schemaVersion: '1.0',
      id: 'evt_failed_log',
      type: 'llm.failed',
      timestamp: 2000,
      source: 'agent:researcher',
      summary: 'Anthropic/claude-sonnet call failed (overloaded)',
      payload: { provider: 'Anthropic', model: 'claude-sonnet', errorKind: 'overloaded', httpStatus: 529, retryable: true },
    }),
  ].join('\n');

  const res = await parseEventLog(jsonl);
  assert.equal(res.issues.length, 0);
  assert.equal(res.events.length, 2);
  const failed = res.events.find((event) => event.id === 'evt_failed_log');
  assert.equal(failed.type, 'llm.failed');
  assert.equal(failed.agentId, 'researcher');
  assert.equal(failed.payload.errorKind, 'overloaded');
  assert.equal(failed.payload.cost, null);
  assert.equal('inputTokens' in failed.payload, false);
  const usage = res.events.find((event) => event.id === 'evt_usage_log');
  assert.equal(usage.payload.cacheReadTokens, 1000);
  assert.equal('cachedTokens' in usage.payload, false);
  assert.equal('reasoningTokens' in usage.payload, false);
});

test('Event log parser: keeps the usage correlation fields, tags deduplicated (issue #64)', async () => {
  const jsonl = JSON.stringify({
    schemaVersion: '1.0',
    id: 'evt_usage_correlation_log',
    type: 'llm.usage',
    timestamp: 1000,
    source: 'agent:researcher',
    summary: 'Usage report with correlation',
    payload: {
      provider: 'Anthropic',
      model: 'claude-sonnet',
      inputTokens: 1200,
      outputTokens: 80,
      traceId: 'trace_log_parser',
      parentId: 'span_log_parser',
      toolCallId: 'call_log_parser',
      meetingId: 'meeting_log_parser',
      userId: 'usr_log_parser',
      tags: ['env:prod', 'env:prod'],
    },
  });

  const res = await parseEventLog(jsonl);
  assert.equal(res.issues.length, 0);
  assert.equal(res.events.length, 1);
  const [event] = res.events;
  assert.equal(event.payload.traceId, 'trace_log_parser');
  assert.equal(event.payload.parentId, 'span_log_parser');
  assert.equal(event.payload.toolCallId, 'call_log_parser');
  assert.equal(event.payload.meetingId, 'meeting_log_parser');
  assert.equal(event.payload.userId, 'usr_log_parser');
  assert.deepEqual(event.payload.tags, ['env:prod']);
});

test('Event log parser: rejects payloads exceeding 25 MB limit', async () => {
  // Create an artificial oversized string
  const giant = 'a'.repeat(MAX_EVENT_LOG_SIZE_BYTES + 10);
  await assert.rejects(
    async () => {
      await parseEventLog(giant);
    },
    {
      message: /exceeds maximum allowed size of 25 MB/,
    }
  );
});

// -----------------------------------------------------------------------------------------------------------
// OTLP file import (issue #74): detection by parsing (not a substring test), logs conversion through the
// shared #59 mapper, the metrics/traces issues, and the new `code`/`path`/`otlp` fields.
// -----------------------------------------------------------------------------------------------------------

test('Event log parser: a canonical line whose summary contains "resourceSpans" text still parses as JSONL', async () => {
  const line = JSON.stringify({
    schemaVersion: '1.0',
    id: 'evt_text_mentions_resourceSpans',
    type: 'agent.registered',
    timestamp: 1000,
    source: 'test',
    summary: 'A run that mentions resourceSpans in its own summary text',
    payload: { id: 'agent_1', name: 'Agent' },
  });
  const res = await parseEventLog(line);
  assert.equal(res.format, 'jsonl');
  assert.equal(res.events.length, 1);
  assert.equal(res.issues.length, 0);
});

test('Event log parser: a pretty-printed OTLP logs document and the equivalent one-request-per-line NDJSON convert to the same events', async () => {
  const pretty = readOtlpFixture('claude-code-logs.pretty.json');
  const ndjson = readOtlpFixture('claude-code-logs.ndjson');
  const fromPretty = await parseEventLog(pretty);
  const fromNdjson = await parseEventLog(ndjson);

  assert.equal(fromPretty.format, 'otlp');
  assert.equal(fromNdjson.format, 'otlp');
  assert.equal(fromPretty.events.length, 4);
  assert.deepEqual(fromPretty.otlp, fromNdjson.otlp);

  const sortById = (events) => [...events].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(sortById(fromPretty.events), sortById(fromNdjson.events));

  assert.equal(fromPretty.totalLines, pretty.split(/\r?\n/).length);
  assert.equal(fromNdjson.totalLines, ndjson.split(/\r?\n/).length);
});

test('Event log parser: converting the same OTLP fixture twice yields identical event ids', async () => {
  const pretty = readOtlpFixture('claude-code-logs.pretty.json');
  const a = await parseEventLog(pretty);
  const b = await parseEventLog(pretty);
  assert.deepEqual(a.events.map((e) => e.id).sort(), b.events.map((e) => e.id).sort());
});

test('Event log parser: a record with no reported cost converts with cost unknown, never 0', async () => {
  const res = await parseEventLog(readOtlpFixture('claude-code-logs.pretty.json'));
  const withoutCost = res.events.find((e) => e.type === 'llm.usage' && e.payload.cost === null);
  assert.ok(withoutCost, 'expected one llm.usage event with no reported cost');
  assert.equal(withoutCost.payload.costSource, 'unknown');
});

test('Event log parser: a record with no cache figures converts with cache tokens absent, never 0', async () => {
  const res = await parseEventLog(readOtlpFixture('claude-code-logs.pretty.json'));
  const withoutCache = res.events.find(
    (e) => e.type === 'llm.usage' && e.payload.inputTokens === 2,
  );
  assert.ok(withoutCache, 'expected the llm.usage event built from the record with no cache attributes');
  assert.equal('cacheReadTokens' in withoutCache.payload, false);
  assert.equal('cacheWriteTokens' in withoutCache.payload, false);
});

test('Event log parser: a record with neither timeUnixNano nor observedTimeUnixNano is rejected, never stamped with the current time', async () => {
  const res = await parseEventLog(readOtlpFixture('claude-code-logs.pretty.json'));
  const farFuture = Date.now() + 1000 * 60 * 60 * 24 * 365 * 10; // ten years from "now": the fixture's real times
  // All converted events keep their real, far-past fixture timestamps; none drifted to anywhere near "now".
  for (const event of res.events) {
    assert.ok(event.timestamp < farFuture);
  }
  const rejected = res.issues.find((i) => i.code === 'otlp-record-skipped' && i.error.includes('Timestamp'));
  assert.ok(rejected, 'expected one otlp-record-skipped issue for the record with no usable timestamp');
  assert.equal(rejected.raw, undefined);
});

test('Event log parser: a record the mapper maps but that fails contract validation is rejected with field names only', async () => {
  const body = {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: '1700000000000000000',
                eventName: 'claude_code.api_request',
                attributes: [
                  { key: 'session.id', value: { stringValue: 'sess-contract-invalid' } },
                  // `model` is missing on purpose: the mapper rejects this before validateCanonicalEvent runs.
                  { key: 'input_tokens', value: { intValue: 10 } },
                  { key: 'output_tokens', value: { intValue: 5 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const res = await parseEventLog(JSON.stringify(body));
  assert.equal(res.events.length, 0);
  const issue = res.issues.find((i) => i.code === 'otlp-record-skipped');
  assert.ok(issue);
  assert.match(issue.error, /model/i);
  assert.equal(/\d{2,}/.test(issue.error), false, 'the message should not echo numeric values');
});

test('Event log parser: non-usage records are counted in otlp.skipped, not reported one issue each', async () => {
  const res = await parseEventLog(readOtlpFixture('claude-code-logs.pretty.json'));
  assert.equal(res.otlp.skipped, 1);
  const skippedIssues = res.issues.filter((i) => i.code === 'otlp-record-skipped');
  // Only the missing-timestamp record is an issue; the ignored non-usage record is silent.
  assert.equal(skippedIssues.length, 1);
});

test('Event log parser: otlp.logRecords equals converted + skipped + rejected for every OTLP fixture', async () => {
  for (const name of ['claude-code-logs.pretty.json', 'claude-code-logs.ndjson', 'claude-code-metrics.json', 'mixed.ndjson']) {
    const res = await parseEventLog(readOtlpFixture(name));
    assert.ok(res.otlp, `${name} should report an otlp summary`);
    assert.equal(res.otlp.logRecords, res.otlp.converted + res.otlp.skipped + res.otlp.rejected, name);
  }
});

test('Event log parser: more than 50 rejected records produce at most 51 otlp-record-skipped issues', async () => {
  const records = [];
  for (let i = 0; i < 60; i++) {
    records.push({
      timeUnixNano: String(1700000000000000000 + i),
      eventName: 'claude_code.api_request',
      attributes: [{ key: 'session.id', value: { stringValue: `sess-${i}` } }], // model missing: always invalid
    });
  }
  const body = {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
        scopeLogs: [{ logRecords: records }],
      },
    ],
  };
  const res = await parseEventLog(JSON.stringify(body));
  const skippedIssues = res.issues.filter((i) => i.code === 'otlp-record-skipped');
  assert.ok(skippedIssues.length <= 51);
  assert.equal(res.otlp.rejected, 60);
});

test('Event log parser: a metrics-only file converts no events and reports the documented issue', async () => {
  const res = await parseEventLog(readOtlpFixture('claude-code-metrics.json'));
  assert.equal(res.format, 'otlp');
  assert.equal(res.events.length, 0);
  assert.equal(res.issues.length, 1);
  assert.equal(res.issues[0].code, 'otlp-metrics-not-replayable');
  assert.equal(
    res.issues[0].error,
    'OTLP metrics are pre-aggregated counters and cannot be replayed as individual calls. Export the logs signal (resourceLogs) to replay usage, or send metrics to the server.',
  );
  assert.deepEqual(res.otlp.signals, ['metrics']);
});

test('Event log parser: a traces-only file converts no events and keeps the unchanged "not supported yet" message', async () => {
  const body = {
    resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [] }],
  };
  const res = await parseEventLog(JSON.stringify(body));
  assert.equal(res.format, 'otlp');
  assert.equal(res.events.length, 0);
  assert.equal(res.issues.length, 1);
  assert.equal(res.issues[0].code, 'otlp-traces-not-supported');
  assert.equal(res.issues[0].error, 'OTLP traces are not supported yet. Export the run as canonical JSONL V1.');
  assert.deepEqual(res.otlp.signals, ['traces']);
});

test('Event log parser: a mixed file returns logs and canonical events plus one metrics and one traces issue', async () => {
  const res = await parseEventLog(readOtlpFixture('mixed.ndjson'));
  assert.equal(res.format, 'otlp');
  assert.ok(res.events.length >= 2, 'expects the canonical line and the converted logs event');
  assert.deepEqual(res.otlp.signals, ['logs', 'metrics', 'traces']);
  const metricsIssues = res.issues.filter((i) => i.code === 'otlp-metrics-not-replayable');
  const tracesIssues = res.issues.filter((i) => i.code === 'otlp-traces-not-supported');
  assert.equal(metricsIssues.length, 1);
  assert.equal(tracesIssues.length, 1);
});

test('Event log parser: a logs file whose records all map to nothing reports otlp-no-usage-records; zero records reports nothing', async () => {
  const onlyIgnored = {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: '1700000000000000000',
                eventName: 'claude_code.user_prompt',
                attributes: [{ key: 'session.id', value: { stringValue: 'sess-ignored' } }],
              },
            ],
          },
        ],
      },
    ],
  };
  const res = await parseEventLog(JSON.stringify(onlyIgnored));
  assert.equal(res.events.length, 0);
  assert.equal(res.issues.length, 1);
  assert.equal(res.issues[0].code, 'otlp-no-usage-records');

  const zeroRecords = {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
        scopeLogs: [{ logRecords: [] }],
      },
    ],
  };
  const resZero = await parseEventLog(JSON.stringify(zeroRecords));
  assert.equal(resZero.issues.length, 0);
});

test('Event log parser: no OTLP issue sets raw or echoes JSON.parse text, and the sentinel string never appears anywhere', async () => {
  const results = await Promise.all(
    ['claude-code-logs.pretty.json', 'claude-code-logs.ndjson', 'mixed.ndjson'].map((name) =>
      parseEventLog(readOtlpFixture(name)),
    ),
  );
  for (const res of results) {
    const dump = JSON.stringify(res);
    assert.equal(dump.includes('SENTINEL_PROMPT_TEXT_DO_NOT_LEAK'), false);
    for (const issue of res.issues) {
      if (issue.code && issue.code.startsWith('otlp')) {
        assert.equal(issue.raw, undefined);
      }
    }
  }
});

test('Event log parser: a truncated pretty-printed OTLP document reports one invalid-json issue, not one per physical line', async () => {
  const truncated = '{\n  "resourceLogs": [\n    {\n      "resource": {';
  const res = await parseEventLog(truncated);
  assert.equal(res.issues.length, 1);
  assert.equal(res.issues[0].code, 'invalid-json');
  assert.equal(res.issues[0].line, 1);
  assert.equal(res.issues[0].raw, undefined);
  assert.equal(res.totalLines, truncated.split(/\r?\n/).length);
});

test('Event log parser: converted OTLP events are sorted ascending by timestamp regardless of record order in the file', async () => {
  const res = await parseEventLog(readOtlpFixture('claude-code-logs.ndjson'));
  const timestamps = res.events.map((e) => e.timestamp);
  const sorted = [...timestamps].sort((a, b) => a - b);
  assert.deepEqual(timestamps, sorted);
});

test('Event log parser: the 25 MB limit applies to OTLP input exactly as to JSONL, for a string and for a Blob', async () => {
  const giant = `{"resourceLogs":[],"padding":"${'a'.repeat(MAX_EVENT_LOG_SIZE_BYTES + 10)}"}`;
  await assert.rejects(async () => parseEventLog(giant), { message: /exceeds maximum allowed size of 25 MB/ });

  const blob = new Blob([giant]);
  await assert.rejects(async () => parseEventLog(blob), { message: /exceeds maximum allowed size of 25 MB/ });
});

test('Replay engine: step, jumpTo, and seekRatio work accurately', async () => {
  const events = [
    {
      schemaVersion: '1.0',
      id: 'evt_1',
      type: 'agent.registered',
      timestamp: 1000,
      source: 'test',
      summary: 'Reg',
      payload: { id: 'agent_1', name: 'Alpha' },
    },
    {
      schemaVersion: '1.0',
      id: 'evt_2',
      type: 'agent.status.changed',
      timestamp: 2000,
      source: 'test',
      agentId: 'agent_1',
      summary: 'Status',
      payload: { status: 'CODING' },
    },
    {
      schemaVersion: '1.0',
      id: 'evt_3',
      type: 'agent.message.sent',
      timestamp: 3000,
      source: 'test',
      agentId: 'agent_1',
      summary: 'Msg',
      payload: { text: 'Done' },
    },
  ];

  const player = new SessionReplayPlayer(events);
  assert.equal(player.totalEvents, 3);

  // Jump to index 2
  const state2 = player.jumpTo(2, () => createLiveSimulationState());
  assert.equal(state2.agents.length, 1);
  assert.equal(state2.agents[0].id, 'agent_1');
  assert.equal(state2.agents[0].status, 'CODING');

  // Jump to index 3 (all events applied)
  const state3 = player.jumpTo(3, () => createLiveSimulationState());
  assert.equal(state3.agents.length, 1);
  assert.equal(state3.agents[0].speechBubble?.text, 'Done');

  // Seek ratio 0
  const state0 = player.seekRatio(0, () => createLiveSimulationState());
  assert.equal(state0.agents.length, 0);
});
