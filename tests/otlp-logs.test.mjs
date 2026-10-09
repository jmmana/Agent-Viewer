// OTLP/HTTP logs receiver (issue #59): pure mapper, deterministic ids, and the POST /v1/logs route itself,
// run with no AGENT_VIEWER_API_TOKEN and the default body/record limits. Body-size, record-count and
// rate-limit behavior need their own env read at module load time, so those live in
// tests/otlp-logs-limits.test.mjs instead.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  mapOtlpLogsRequest,
  looksLikeOtlpLogsRequest,
  countLogRecords,
} from '../src/integrations/otlp/claudeCodeLogs.ts';
import { sessionIdentity } from '../src/integrations/claudeCodeIdentity.ts';
import { OTLP_LOGS_PATH } from '../src/integrations/otelConstants.ts';
import { app, store } from '../server/index.ts';

const fixturesDir = fileURLToPath(new URL('./fixtures/claude-code-otlp/', import.meta.url));
function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8'));
}

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/** Runs `fn` with the given env vars set, restoring the previous values afterwards. */
async function withEnv(vars, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const NO_AUTH_ENV = { AGENT_VIEWER_API_TOKEN: undefined, AGENT_VIEWER_API_KEY: undefined };

// -------------------------------------------------------------
// Synthetic record builders, for cases the real fixtures do not exercise on their own.
// -------------------------------------------------------------
function attr(key, value) {
  return { key, value };
}

function toAttrArray(map) {
  return Object.entries(map)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => attr(key, value));
}

function minimalApiRequestAttrs(overrides = {}) {
  return {
    'session.id': { stringValue: 'synthetic-session-minimal' },
    model: { stringValue: 'claude-sonnet-5' },
    input_tokens: { intValue: 10 },
    output_tokens: { intValue: 5 },
    ...overrides,
  };
}

function logsRequest(records, { serviceName = 'claude-code', resourceAttributes = [] } = {}) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [attr('service.name', { stringValue: serviceName }), ...resourceAttributes] },
        scopeLogs: [{ logRecords: records }],
      },
    ],
  };
}

/** Deep-clones `api-request.json` and overwrites session.id and request_id so the body is unique per test. */
function uniqueApiRequestLogsRequest(suffix) {
  const body = JSON.parse(JSON.stringify(fixture('api-request')));
  const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
  record.attributes = record.attributes.map((entry) => {
    if (entry.key === 'session.id') return attr('session.id', { stringValue: `session-otlp-test-${suffix}` });
    if (entry.key === 'request_id') return attr('request_id', { stringValue: `req_otlp_test_${suffix}` });
    return entry;
  });
  return body;
}

// -------------------------------------------------------------
// Pure mapper: shape detection helpers
// -------------------------------------------------------------

test('looksLikeOtlpLogsRequest: accepts a resourceLogs array, rejects anything else', () => {
  assert.equal(looksLikeOtlpLogsRequest({ resourceLogs: [] }), true);
  assert.equal(looksLikeOtlpLogsRequest({}), false);
  assert.equal(looksLikeOtlpLogsRequest({ resourceLogs: 'nope' }), false);
  assert.equal(looksLikeOtlpLogsRequest(null), false);
  assert.equal(looksLikeOtlpLogsRequest('a string'), false);
});

test('countLogRecords: counts across every resourceLogs and scopeLogs entry', () => {
  const body = {
    resourceLogs: [
      { scopeLogs: [{ logRecords: [{}, {}] }, { logRecords: [{}] }] },
      { scopeLogs: [{ logRecords: [{}] }] },
    ],
  };
  assert.equal(countLogRecords(body), 4);
  assert.equal(countLogRecords({ resourceLogs: [] }), 0);
});

// -------------------------------------------------------------
// Pure mapper: field mapping against the real, recorded fixtures
// -------------------------------------------------------------

test('fixture: api-request.json maps to one llm.usage with the documented fields', () => {
  const result = mapOtlpLogsRequest(fixture('api-request'));
  assert.equal(result.events.length, 1);
  const event = result.events[0];
  const identity = sessionIdentity('14ad3dd2-89b4-49a5-9334-e937d9eb1ecc');

  assert.equal(event.type, 'llm.usage');
  assert.equal(event.runtimeId, 'claude-code');
  assert.equal(event.sessionId, identity.sessionId);
  assert.equal(event.agentId, identity.mainAgentId);
  assert.equal(event.source, `agent:${identity.mainAgentId}`);
  assert.equal(event.timestamp, Date.parse('2026-10-09T15:34:34.156Z'));

  assert.equal(event.payload.provider, 'Anthropic');
  assert.equal(event.payload.model, 'claude-sonnet-5');
  // input_tokens (2) excludes cache per Anthropic semantics, but the canonical contract's checkCacheFields
  // (#46) requires inputTokens >= cacheReadTokens + cacheWriteTokens, so the mapper folds the cache counters
  // in: 2 + 28549 (cache read) + 21286 (cache creation) = 49837. The separate cache fields keep their own,
  // true values below.
  assert.equal(event.payload.inputTokens, 49837);
  assert.equal(event.payload.outputTokens, 4);
  assert.equal(event.payload.cacheReadTokens, 28549);
  assert.equal(event.payload.cacheWriteTokens, 21286);
  assert.equal(event.payload.latencyMs, 1568);
  assert.equal(event.payload.requestId, 'req_SYNTHc0e6d8e2e73ad002f382');
  // cost_usd_micros (90898) wins over cost_usd (0.0908978): 90898 / 1e6 = 0.090898.
  assert.equal(event.payload.cost, 0.090898);
  assert.equal(event.payload.costSource, 'estimated');
  assert.equal(event.payload.currency, 'USD');
  assert.equal('reasoningTokens' in event.payload, false);

  assert.equal(result.mappedByType['llm.usage'], 1);
  assert.equal(result.stats.received, 1);
});

test('fixture: api-error-http.json maps to llm.failed, httpStatus 404 gives errorKind invalid_request', () => {
  const result = mapOtlpLogsRequest(fixture('api-error-http'));
  assert.equal(result.events.length, 1);
  const event = result.events[0];
  assert.equal(event.type, 'llm.failed');
  assert.equal(event.payload.errorKind, 'invalid_request');
  assert.equal(event.payload.httpStatus, 404);
  assert.equal(event.payload.attempts, 1);
  assert.equal(event.payload.latencyMs, 822);
  assert.equal(event.payload.requestId, 'req_SYNTH67d7f88e6f2f81c47fa9');
  assert.equal(event.payload.model, 'totally-invalid-model-name-xyz');
  // The free-text `error` attribute value ("model: totally-invalid-model-name-xyz") is never copied in.
  assert.equal(JSON.stringify(event).includes('model: totally-invalid-model-name-xyz'), false);
  assert.equal(result.mappedByType['llm.failed'], 1);
});

test('fixture: api-error-network.json gets errorKind network and ignores the paired retries-exhausted record', () => {
  const result = mapOtlpLogsRequest(fixture('api-error-network'));
  assert.equal(result.stats.received, 2);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].payload.errorKind, 'network');
  assert.equal('httpStatus' in result.events[0].payload, false);
  assert.equal(result.stats.ignored, 1);
});

test('fixture: mixed-batch.json maps only the api_request record, ignoring the rest by name', () => {
  const result = mapOtlpLogsRequest(fixture('mixed-batch'));
  assert.equal(result.stats.received, 6);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'llm.usage');
  assert.equal(result.stats.ignored, 5);
  assert.equal(result.stats.unknown, 0);
});

test('fixture: api-request-subagent.json still lands on the main agent', () => {
  const result = mapOtlpLogsRequest(fixture('api-request-subagent'));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'llm.usage');
  assert.match(result.events[0].agentId, /^claude-[0-9a-f]+$/);
});

test('fixture: content-logging.json maps only the api_request record and carries no sentinel text', () => {
  const result = mapOtlpLogsRequest(fixture('content-logging'));
  assert.equal(result.stats.ignored, 3);
  assert.equal(result.events.length, 1);
  const serialized = JSON.stringify(result.events[0]);
  for (const sentinel of ['SENTINEL_PROMPT_7f3a', 'SENTINEL_RESPONSE_2b9c', 'SENTINEL_TOOL_9d1e']) {
    assert.equal(serialized.includes(sentinel), false, `leaked: ${sentinel}`);
  }
});

// -------------------------------------------------------------
// Pure mapper: synthetic cases the fixtures do not exercise on their own
// -------------------------------------------------------------

test('mapper: event name resolves from eventName, then the event.name attribute, then body', () => {
  const base = { timeUnixNano: '1700000000000000000', attributes: toAttrArray(minimalApiRequestAttrs()) };

  const viaEventName = mapOtlpLogsRequest(logsRequest([{ ...base, eventName: 'claude_code.api_request' }]));
  assert.equal(viaEventName.events.length, 1);

  const viaAttr = mapOtlpLogsRequest(
    logsRequest([{ ...base, attributes: [...base.attributes, attr('event.name', { stringValue: 'api_request' })] }])
  );
  assert.equal(viaAttr.events.length, 1);

  const viaBody = mapOtlpLogsRequest(logsRequest([{ ...base, body: { stringValue: 'claude_code.api_request' } }]));
  assert.equal(viaBody.events.length, 1);
});

test('mapper: record attributes are looked up before resource attributes', () => {
  const identity = sessionIdentity('record-level-session');
  const record = {
    body: { stringValue: 'claude_code.api_request' },
    timeUnixNano: '1700000000000000000',
    attributes: toAttrArray(minimalApiRequestAttrs({ 'session.id': { stringValue: 'record-level-session' } })),
  };
  const result = mapOtlpLogsRequest(
    logsRequest([record], { resourceAttributes: [attr('session.id', { stringValue: 'resource-level-session' })] })
  );
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].sessionId, identity.sessionId);
});

test('mapper: falls back to a resource attribute when the record does not carry it', () => {
  const identity = sessionIdentity('resource-only-session');
  const record = {
    body: { stringValue: 'claude_code.api_request' },
    timeUnixNano: '1700000000000000000',
    attributes: toAttrArray(minimalApiRequestAttrs({ 'session.id': undefined })),
  };
  const result = mapOtlpLogsRequest(
    logsRequest([record], { resourceAttributes: [attr('session.id', { stringValue: 'resource-only-session' })] })
  );
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].sessionId, identity.sessionId);
});

test('mapper: claude-code-desktop is an accepted service name', () => {
  const record = {
    body: { stringValue: 'claude_code.api_request' },
    timeUnixNano: '1700000000000000000',
    attributes: toAttrArray(minimalApiRequestAttrs()),
  };
  const result = mapOtlpLogsRequest(logsRequest([record], { serviceName: 'claude-code-desktop' }));
  assert.equal(result.events.length, 1);
});

test('mapper: an unrecognized service name counts the record as unknown', () => {
  const record = {
    body: { stringValue: 'claude_code.api_request' },
    timeUnixNano: '1700000000000000000',
    attributes: toAttrArray(minimalApiRequestAttrs()),
  };
  const result = mapOtlpLogsRequest(logsRequest([record], { serviceName: 'some-other-cli' }));
  assert.equal(result.events.length, 0);
  assert.equal(result.stats.unknown, 1);
});

test('mapper: a decimal-string intValue and a JSON-number intValue produce the same id and value', () => {
  const recordNumber = {
    body: { stringValue: 'claude_code.api_request' },
    timeUnixNano: '1700000000000000000',
    attributes: toAttrArray(minimalApiRequestAttrs({ input_tokens: { intValue: 7 } })),
  };
  const recordString = {
    body: { stringValue: 'claude_code.api_request' },
    timeUnixNano: '1700000000000000000',
    attributes: toAttrArray(minimalApiRequestAttrs({ input_tokens: { intValue: '7' } })),
  };
  const resultA = mapOtlpLogsRequest(logsRequest([recordNumber]));
  const resultB = mapOtlpLogsRequest(logsRequest([recordString]));
  assert.equal(resultA.events[0].payload.inputTokens, 7);
  assert.equal(resultB.events[0].payload.inputTokens, 7);
  assert.equal(resultA.events[0].id, resultB.events[0].id);
});

test('mapper: timestamp prefers event.timestamp, then timeUnixNano, then observedTimeUnixNano, then receive time', () => {
  const now = 1_700_000_050_000;

  const withEventTimestamp = mapOtlpLogsRequest(
    logsRequest([
      {
        body: { stringValue: 'claude_code.api_request' },
        timeUnixNano: '1600000000000000000',
        attributes: toAttrArray(minimalApiRequestAttrs({ 'event.timestamp': { stringValue: '2024-01-01T00:00:00.000Z' } })),
      },
    ]),
    { now }
  );
  assert.equal(withEventTimestamp.events[0].timestamp, Date.parse('2024-01-01T00:00:00.000Z'));

  // 1.7e18 ns is exactly 1_700_000_000_000 ms; this magnitude only round-trips correctly through BigInt.
  const withNano = mapOtlpLogsRequest(
    logsRequest([
      { body: { stringValue: 'claude_code.api_request' }, timeUnixNano: '1700000000000000000', attributes: toAttrArray(minimalApiRequestAttrs()) },
    ]),
    { now }
  );
  assert.equal(withNano.events[0].timestamp, 1_700_000_000_000);

  // "0" means unset and falls through to observedTimeUnixNano.
  const withObserved = mapOtlpLogsRequest(
    logsRequest([
      {
        body: { stringValue: 'claude_code.api_request' },
        timeUnixNano: '0',
        observedTimeUnixNano: '1700000000000000000',
        attributes: toAttrArray(minimalApiRequestAttrs()),
      },
    ]),
    { now }
  );
  assert.equal(withObserved.events[0].timestamp, 1_700_000_000_000);

  const withNeither = mapOtlpLogsRequest(
    logsRequest([{ body: { stringValue: 'claude_code.api_request' }, attributes: toAttrArray(minimalApiRequestAttrs()) }]),
    { now }
  );
  assert.equal(withNeither.events[0].timestamp, now);
});

test('mapper: api_request without session.id is unattributed, not invalid', () => {
  const record = {
    body: { stringValue: 'claude_code.api_request' },
    timeUnixNano: '1700000000000000000',
    attributes: toAttrArray(minimalApiRequestAttrs({ 'session.id': undefined })),
  };
  const result = mapOtlpLogsRequest(logsRequest([record]));
  assert.equal(result.events.length, 0);
  assert.equal(result.stats.unattributed, 1);
  assert.match(result.rejectionReasons[0], /session\.id missing/);
});

test('mapper: api_request missing model, input_tokens or output_tokens is invalid', () => {
  for (const missing of ['model', 'input_tokens', 'output_tokens']) {
    const record = {
      body: { stringValue: 'claude_code.api_request' },
      timeUnixNano: '1700000000000000000',
      attributes: toAttrArray(minimalApiRequestAttrs({ [missing]: undefined })),
    };
    const result = mapOtlpLogsRequest(logsRequest([record]));
    assert.equal(result.events.length, 0, `expected ${missing} missing to be invalid`);
    assert.equal(result.stats.invalid, 1, `expected ${missing} missing to be invalid`);
  }
});

test('mapper: a negative input_tokens is invalid, never clamped to 0', () => {
  const record = {
    body: { stringValue: 'claude_code.api_request' },
    timeUnixNano: '1700000000000000000',
    attributes: toAttrArray(minimalApiRequestAttrs({ input_tokens: { intValue: -1 } })),
  };
  const result = mapOtlpLogsRequest(logsRequest([record]));
  assert.equal(result.events.length, 0);
  assert.equal(result.stats.invalid, 1);
});

test('mapper: missing cache tokens, duration, requestId or cost stay unknown, never invented', () => {
  const record = {
    body: { stringValue: 'claude_code.api_request' },
    timeUnixNano: '1700000000000000000',
    attributes: toAttrArray(minimalApiRequestAttrs()),
  };
  const result = mapOtlpLogsRequest(logsRequest([record]));
  const payload = result.events[0].payload;
  assert.equal('cacheReadTokens' in payload, false);
  assert.equal('cacheWriteTokens' in payload, false);
  assert.equal('latencyMs' in payload, false);
  assert.equal('requestId' in payload, false);
  assert.equal('reasoningTokens' in payload, false);
  assert.equal(payload.cost, null);
  assert.equal(payload.costSource, 'unknown');
});

test('mapper: api_error errorKind follows the status_code table', () => {
  const cases = [
    [429, 'rate_limited'],
    [529, 'overloaded'],
    [401, 'auth'],
    [403, 'auth'],
    [400, 'invalid_request'],
    [404, 'invalid_request'],
    [413, 'invalid_request'],
    [500, 'server_error'],
    [599, 'server_error'],
    [418, 'unknown'],
  ];
  for (const [statusCode, expectedKind] of cases) {
    const record = {
      body: { stringValue: 'claude_code.api_error' },
      timeUnixNano: '1700000000000000000',
      attributes: toAttrArray({
        'session.id': { stringValue: 'session-error' },
        model: { stringValue: 'claude-sonnet-5' },
        status_code: { intValue: statusCode },
      }),
    };
    const result = mapOtlpLogsRequest(logsRequest([record]));
    assert.equal(result.events.length, 1, `status ${statusCode}`);
    assert.equal(result.events[0].payload.errorKind, expectedKind, `status ${statusCode}`);
    assert.equal(result.events[0].payload.httpStatus, statusCode, `status ${statusCode}`);
  }
});

test('mapper: api_error without status_code gets errorKind network and never reads the error text', () => {
  const record = {
    body: { stringValue: 'claude_code.api_error' },
    timeUnixNano: '1700000000000000000',
    attributes: toAttrArray({
      'session.id': { stringValue: 'session-error-net' },
      error: { stringValue: 'secret internal detail' },
    }),
  };
  const result = mapOtlpLogsRequest(logsRequest([record]));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].payload.errorKind, 'network');
  assert.equal('httpStatus' in result.events[0].payload, false);
  assert.equal('model' in result.events[0].payload, false);
  assert.equal(JSON.stringify(result.events[0]).includes('secret internal detail'), false);
});

test('mapper: api_retries_exhausted is ignored, never counted as a failure', () => {
  const record = {
    body: { stringValue: 'claude_code.api_retries_exhausted' },
    timeUnixNano: '1700000000000000000',
    attributes: toAttrArray({ 'session.id': { stringValue: 'session-retries' } }),
  };
  const result = mapOtlpLogsRequest(logsRequest([record]));
  assert.equal(result.events.length, 0);
  assert.equal(result.stats.ignored, 1);
});

// -------------------------------------------------------------
// Deterministic, idempotent ids (issue #59, section 6)
// -------------------------------------------------------------

test('ids: the same fixture maps to the same id on repeated calls, across process-like reuse', () => {
  const a = mapOtlpLogsRequest(fixture('api-request'));
  const b = mapOtlpLogsRequest(fixture('api-request'));
  assert.equal(a.events[0].id, b.events[0].id);
  assert.match(a.events[0].id, /^evt_cc_otlp_[0-9a-f]{32}$/);
});

test('ids: changing a hashed field changes the id', () => {
  const base = fixture('api-request');
  const mutated = JSON.parse(JSON.stringify(base));
  const record = mutated.resourceLogs[0].scopeLogs[0].logRecords[0];
  record.attributes = record.attributes.map((entry) =>
    entry.key === 'output_tokens' ? attr('output_tokens', { intValue: 999 }) : entry
  );
  const a = mapOtlpLogsRequest(base);
  const b = mapOtlpLogsRequest(mutated);
  assert.notEqual(a.events[0].id, b.events[0].id);
});

test('ids: the otlp prefix never collides with the hook id prefix', () => {
  const result = mapOtlpLogsRequest(fixture('api-request'));
  assert.ok(result.events[0].id.startsWith('evt_cc_otlp_'));
  // The hook's own ids are `evt_cc_<24 hex>`, with no `otlp_` segment.
  assert.ok(!/^evt_cc_[0-9a-f]{24}$/.test(result.events[0].id));
});

// -------------------------------------------------------------
// HTTP: POST /v1/logs, default config (open, default limits)
// -------------------------------------------------------------

test('HTTP: an empty resourceLogs array is accepted with 200 {}', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceLogs: [] }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {});
    } finally {
      server.close();
    }
  });
});

test('HTTP: a real api-request export is stored as one llm.usage event and broadcast over SSE', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const stream = await fetch(`${baseUrl}/api/v1/events/stream`);
      const reader = stream.body.getReader();
      try {
        const decoder = new TextDecoder();
        await reader.read(); // ": connected"

        const body = uniqueApiRequestLogsRequest('broadcast-1');
        const sessionId = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.find((a) => a.key === 'session.id').value.stringValue;
        const identity = sessionIdentity(sessionId);

        const res = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), {});

        const chunk = await reader.read();
        const text = decoder.decode(chunk.value);
        assert.ok(text.includes('"type":"llm.usage"'));
        assert.ok(text.includes(identity.mainAgentId));

        const stored = await fetch(`${baseUrl}/api/v1/events?sessionId=${identity.sessionId}&type=llm.usage`);
        const storedJson = await stored.json();
        assert.equal(storedJson.count, 1);
      } finally {
        // Always released, even when an assertion above throws: an open SSE stream keeps its 15s heartbeat
        // timer alive, which would otherwise keep the whole test process from exiting.
        await reader.cancel().catch(() => {});
      }
    } finally {
      server.close();
    }
  });
});

test('HTTP: invalid and unattributed records are reported through partialSuccess, valid ones still stored', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const good = uniqueApiRequestLogsRequest('partial-good');
      const goodRecord = good.resourceLogs[0].scopeLogs[0].logRecords[0];

      const invalidRecord = JSON.parse(JSON.stringify(goodRecord));
      invalidRecord.attributes = invalidRecord.attributes.filter((a) => a.key !== 'output_tokens');
      invalidRecord.attributes = invalidRecord.attributes.map((a) => (a.key === 'session.id' ? attr('session.id', { stringValue: 'session-otlp-test-partial-invalid' }) : a));

      const unattributedRecord = JSON.parse(JSON.stringify(goodRecord));
      unattributedRecord.attributes = unattributedRecord.attributes.filter((a) => a.key !== 'session.id');

      good.resourceLogs[0].scopeLogs[0].logRecords = [goodRecord, invalidRecord, unattributedRecord];

      const res = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(good),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.partialSuccess.rejectedLogRecords, '2');
      assert.match(json.partialSuccess.errorMessage, /output_tokens/);
      assert.match(json.partialSuccess.errorMessage, /session\.id missing/);
    } finally {
      server.close();
    }
  });
});

test('HTTP: malformed JSON and a body without resourceLogs both get an OTLP-style 400', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const noArray = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' }),
      });
      assert.equal(noArray.status, 400);
      assert.equal((await noArray.json()).code, 3);

      const badJson = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });
      assert.equal(badJson.status, 400);
      assert.equal((await badJson.json()).code, 3);
    } finally {
      server.close();
    }
  });
});

test('HTTP: without a configured token the route is open, like /api/v1', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceLogs: [] }),
      });
      assert.equal(res.status, 200);
    } finally {
      server.close();
    }
  });
});

test('HTTP: with AGENT_VIEWER_API_TOKEN set, a missing or wrong token gets 401, the right one gets 200', async () => {
  await withEnv({ AGENT_VIEWER_API_TOKEN: 'otlp-test-token', AGENT_VIEWER_API_KEY: undefined }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const noToken = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceLogs: [] }),
      });
      assert.equal(noToken.status, 401);
      assert.equal((await noToken.json()).code, 16);

      // A wrong token with a malformed body still answers 401, not 400: auth runs before body parsing.
      const wrongTokenBadBody = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
        body: '{not json',
      });
      assert.equal(wrongTokenBadBody.status, 401);

      const rightToken = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { authorization: 'Bearer otlp-test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ resourceLogs: [] }),
      });
      assert.equal(rightToken.status, 200);
    } finally {
      server.close();
    }
  });
});

test('HTTP: application/x-protobuf is now accepted (issue #73); an unsupported Content-Type or Content-Encoding still gets 415', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      // Issue #73 adds http/protobuf support to this same route: application/x-protobuf is no longer an
      // unsupported media type. Three garbage bytes are not a valid ExportLogsServiceRequest though, so this
      // is now a 400 (malformed body), not a 415.
      const protobuf = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf' },
        body: Buffer.from([1, 2, 3]),
      });
      assert.equal(protobuf.status, 400);

      const unsupportedType = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/xml' },
        body: Buffer.from('<x/>'),
      });
      assert.equal(unsupportedType.status, 415);
      assert.match((await unsupportedType.json()).message, /http\/json or http\/protobuf/);

      // body-parser understands gzip, deflate and brotli; something else entirely still has to get a clean
      // 415, not a decompression crash.
      const badEncoding = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'x-bogus-encoding' },
        body: Buffer.from('{}'),
      });
      assert.equal(badEncoding.status, 415);
    } finally {
      server.close();
    }
  });
});

test('HTTP: a gzip-encoded body is accepted', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const body = uniqueApiRequestLogsRequest('gzip-1');
      const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify(body)));
      const res = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: gzipped,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {});
    } finally {
      server.close();
    }
  });
});

test('HTTP: a store failure returns 503, never a non-OTLP body', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    const appendBatchMock = mock.method(store, 'appendBatch', async () => {
      throw new Error('storage unavailable');
    });
    try {
      const res = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(uniqueApiRequestLogsRequest('store-failure')),
      });
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { code: 14, message: 'Storage unavailable, retry' });
    } finally {
      appendBatchMock.mock.restore();
      server.close();
    }
  });
});

test('HTTP: posting the same export twice stores it once; two copies of a record in one request store it once', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      // Same record twice inside one request.
      const dupeInBatch = uniqueApiRequestLogsRequest('dedup-inbatch');
      const record = dupeInBatch.resourceLogs[0].scopeLogs[0].logRecords[0];
      dupeInBatch.resourceLogs[0].scopeLogs[0].logRecords = [record, JSON.parse(JSON.stringify(record))];
      const sessionId = record.attributes.find((a) => a.key === 'session.id').value.stringValue;
      const identity = sessionIdentity(sessionId);

      const firstRes = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dupeInBatch),
      });
      assert.equal(firstRes.status, 200);
      const afterFirst = await (await fetch(`${baseUrl}/api/v1/events?sessionId=${identity.sessionId}&type=llm.usage`)).json();
      assert.equal(afterFirst.count, 1);

      // The same export, posted again as a second request.
      const secondRes = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dupeInBatch),
      });
      assert.equal(secondRes.status, 200);
      const afterSecond = await (await fetch(`${baseUrl}/api/v1/events?sessionId=${identity.sessionId}&type=llm.usage`)).json();
      assert.equal(afterSecond.count, 1);
    } finally {
      server.close();
    }
  });
});

test('HTTP: GET /api/v1/otlp/stats reports a shape whose counters satisfy the documented invariant', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const before = await (await fetch(`${baseUrl}/api/v1/otlp/stats`)).json();

      await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(uniqueApiRequestLogsRequest('stats-1')),
      });
      await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fixture('mixed-batch')),
      });

      const after = await (await fetch(`${baseUrl}/api/v1/otlp/stats`)).json();

      assert.equal(typeof after.since, 'number');
      assert.equal(after.since, before.since);

      const delta = {
        received: after.logRecords.received - before.logRecords.received,
        mapped: after.logRecords.mapped - before.logRecords.mapped,
        duplicates: after.logRecords.duplicates - before.logRecords.duplicates,
        ignored: after.logRecords.ignored - before.logRecords.ignored,
        unknown: after.logRecords.unknown - before.logRecords.unknown,
        unattributed: after.logRecords.unattributed - before.logRecords.unattributed,
        invalid: after.logRecords.invalid - before.logRecords.invalid,
      };
      // One uniqueApiRequestLogsRequest (1 record, mapped) plus mixed-batch.json (6 records: 1 mapped, 5 ignored).
      assert.equal(delta.received, 7);
      assert.equal(delta.mapped, 2);
      assert.equal(delta.ignored, 5);
      assert.equal(delta.received, delta.mapped + delta.duplicates + delta.ignored + delta.unknown + delta.unattributed + delta.invalid);
      assert.equal(after.mappedByType['llm.usage'] - before.mappedByType['llm.usage'], 2);
      assert.equal(after.requests.accepted - before.requests.accepted, 2);
    } finally {
      server.close();
    }
  });
});

test('HTTP: GET /api/v1/otlp/stats needs the same token as the rest of /api/v1', async () => {
  await withEnv({ AGENT_VIEWER_API_TOKEN: 'otlp-stats-token', AGENT_VIEWER_API_KEY: undefined }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const noToken = await fetch(`${baseUrl}/api/v1/otlp/stats`);
      assert.equal(noToken.status, 401);

      const withToken = await fetch(`${baseUrl}/api/v1/otlp/stats`, { headers: { authorization: 'Bearer otlp-stats-token' } });
      assert.equal(withToken.status, 200);
      const json = await withToken.json();
      assert.ok('since' in json);
      assert.ok('requests' in json);
      assert.ok('logRecords' in json);
      assert.ok('mappedByType' in json);
      assert.ok('unknownEventNames' in json);
    } finally {
      server.close();
    }
  });
});

// -------------------------------------------------------------
// Privacy (issue #59, section 4 and the Context table)
// -------------------------------------------------------------

test('privacy: content-logging.json leaks no sentinel text, email or raw identity anywhere observable', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_DEBUG: '1' }, async () => {
    const { server, baseUrl } = await startTestServer();
    const originalWarn = console.warn;
    const warnLines = [];
    console.warn = (...args) => {
      warnLines.push(args.map(String).join(' '));
    };
    try {
      const stream = await fetch(`${baseUrl}/api/v1/events/stream`);
      const reader = stream.body.getReader();
      let sseText = '';
      let postJson;
      try {
        const decoder = new TextDecoder();
        await reader.read(); // ": connected"

        const postRes = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fixture('content-logging')),
        });
        postJson = await postRes.json();

        const sseChunk = await reader.read();
        sseText = decoder.decode(sseChunk.value);
      } finally {
        // See the broadcast test above: this must run even if an assertion throws, or the SSE heartbeat
        // keeps the process alive.
        await reader.cancel().catch(() => {});
      }

      const eventsJson = await (await fetch(`${baseUrl}/api/v1/events?type=llm.usage&limit=1000`)).json();
      const statsJson = await (await fetch(`${baseUrl}/api/v1/otlp/stats`)).json();

      const haystack = [JSON.stringify(postJson), sseText, JSON.stringify(eventsJson), JSON.stringify(statsJson), warnLines.join('\n')].join('\n');

      const forbidden = [
        'SENTINEL_PROMPT_7f3a',
        'SENTINEL_RESPONSE_2b9c',
        'SENTINEL_TOOL_9d1e',
        'synthetic-caa58800@example.invalid',
        'b70d0919-7901-4cb5-9a27-4c813c4975ab', // organization.id
        '40f0c9a3-b789-4abb-b11f-ff0915372003', // user.account_uuid
        'user_SYNTH0d8c48bd6a4aa267911c', // user.account_id
        'aa11bb22-cc33-4dd4-8ee5-ff6677889900', // raw session.id
        '77889900-aabb-4ccd-8eef-001122334455', // prompt.id
      ];
      for (const needle of forbidden) {
        assert.equal(haystack.includes(needle), false, `leaked: ${needle}`);
      }
    } finally {
      console.warn = originalWarn;
      server.close();
    }
  });
});

test('privacy: an unrecognized event name is logged by name only, with AGENT_VIEWER_DEBUG=1', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_DEBUG: '1' }, async () => {
    const { server, baseUrl } = await startTestServer();
    const originalWarn = console.warn;
    const warnLines = [];
    console.warn = (...args) => {
      warnLines.push(args.map(String).join(' '));
    };
    try {
      const record = {
        body: { stringValue: 'claude_code.some_brand_new_event' },
        timeUnixNano: '1700000000000000000',
        attributes: toAttrArray({ 'session.id': { stringValue: 'session-otlp-test-unknown-name' }, secret_field: { stringValue: 'should never be logged' } }),
      };
      const res = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(logsRequest([record])),
      });
      assert.equal(res.status, 200);
      const joined = warnLines.join('\n');
      assert.ok(joined.includes('some_brand_new_event'));
      assert.equal(joined.includes('should never be logged'), false);
    } finally {
      console.warn = originalWarn;
      server.close();
    }
  });
});
