// OTLP/HTTP logs receiver (issue #59): body size, record count and rate-limit behavior. These read their
// configuration once, at module load, so they get their own low limits here instead of sharing a process
// with tests/otlp-logs.test.mjs (which needs the defaults).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.AGENT_VIEWER_OTLP_MAX_BODY = '2kb';
process.env.AGENT_VIEWER_OTLP_MAX_RECORDS = '2';
// High on purpose: the rate limiter itself (shared with /api/v1) has its own dedicated, low-limit test in
// tests/otlp-logs-rate-limit.test.mjs, so this file's several requests never trip it by accident.
process.env.AGENT_VIEWER_RATE_LIMIT = '1000';
delete process.env.AGENT_VIEWER_API_TOKEN;
delete process.env.AGENT_VIEWER_API_KEY;

const { app } = await import('../server/index.ts');
const { OTLP_LOGS_PATH } = await import('../src/integrations/otelConstants.ts');

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

function minimalApiRequestRecord(suffix) {
  return {
    body: { stringValue: 'claude_code.api_request' },
    timeUnixNano: '1700000000000000000',
    attributes: [
      { key: 'session.id', value: { stringValue: `session-limits-${suffix}` } },
      { key: 'model', value: { stringValue: 'claude-sonnet-5' } },
      { key: 'input_tokens', value: { intValue: 1 } },
      { key: 'output_tokens', value: { intValue: 1 } },
    ],
  };
}

test('HTTP: a request over AGENT_VIEWER_OTLP_MAX_RECORDS gets 413, one within it gets 200', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const tooMany = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
          scopeLogs: [{ logRecords: [minimalApiRequestRecord('a'), minimalApiRequestRecord('b'), minimalApiRequestRecord('c')] }],
        },
      ],
    };
    const overLimit = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tooMany),
    });
    assert.equal(overLimit.status, 413);
    const body = await overLimit.json();
    assert.equal(body.code, 3);
    assert.match(body.message, /2 log records/);

    const atLimit = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
          scopeLogs: [{ logRecords: [minimalApiRequestRecord('d'), minimalApiRequestRecord('e')] }],
        },
      ],
    };
    const withinLimit = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(atLimit),
    });
    assert.equal(withinLimit.status, 200);
  } finally {
    server.close();
  }
});

test('HTTP: a body over AGENT_VIEWER_OTLP_MAX_BODY (decoded size) gets 413', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const record = minimalApiRequestRecord('big');
    // Pad well past the 2kb limit with an attribute value that the mapper does not read (not in the allowlist),
    // so the only thing being tested is the size limit, not the mapping.
    record.attributes.push({ key: 'padding', value: { stringValue: 'x'.repeat(4000) } });
    const tooBig = {
      resourceLogs: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
          scopeLogs: [{ logRecords: [record] }],
        },
      ],
    };
    const res = await fetch(`${baseUrl}${OTLP_LOGS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tooBig),
    });
    assert.equal(res.status, 413);
    const json = await res.json();
    assert.equal(json.code, 3);
    assert.match(json.message, /2kb/);
  } finally {
    server.close();
  }
});
