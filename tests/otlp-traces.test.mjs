// OTLP/HTTP GenAI traces receiver (issue #97): POST /v1/traces route itself (auth, limits, both wire formats,
// idempotency, cross-source dedup, privacy). The pure mapper's field-by-field mapping rules are covered by
// tests/otlp-mapping.test.mjs instead, following the split tests/otlp-logs.test.mjs/otlp-logs-limits.test.mjs
// already use for the logs receiver.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import {
  encodeVarintField,
  encodeStringField,
  encodeFixed64Field,
  encodeMessageField,
  encodeMessage,
} from '../server/otlp/protobufWire.ts';
import { OTLP_TRACES_PATH } from '../src/integrations/otelConstants.ts';
import { app, store } from '../server/index.ts';

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

function attr(key, value) {
  return { key, value };
}
function str(value) {
  return { stringValue: value };
}
function int(value) {
  return { intValue: value };
}

function chatSpan({ traceId, spanId, parentSpanId, requestId, startNano, endNano } = {}) {
  return {
    traceId,
    spanId,
    parentSpanId,
    name: 'chat claude-sonnet-5',
    startTimeUnixNano: startNano ?? '1760000000000000000',
    endTimeUnixNano: endNano ?? '1760000000940000000',
    attributes: [
      attr('gen_ai.operation.name', str('chat')),
      attr('gen_ai.provider.name', str('anthropic')),
      attr('gen_ai.request.model', str('claude-sonnet-5')),
      attr('gen_ai.usage.input_tokens', int(10)),
      attr('gen_ai.usage.output_tokens', int(5)),
      ...(requestId ? [attr('gen_ai.response.id', str(requestId))] : []),
    ],
    status: { code: 1 },
  };
}

function tracesRequest(spans, { serviceName = 'test-service' } = {}) {
  return { resourceSpans: [{ resource: { attributes: [attr('service.name', str(serviceName))] }, scopeSpans: [{ spans }] }] };
}

/** A fresh, random 32-hex trace id and 16-hex span id per call, so tests never collide on a deterministic id. */
let counter = 0;
function freshIds() {
  counter += 1;
  const n = counter.toString(16).padStart(8, '0');
  return { traceId: `aa${n}${n}${n}aa`.padEnd(32, '0').slice(0, 32), spanId: `bb${n}`.padEnd(16, '0').slice(0, 16) };
}

// -------------------------------------------------------------
// Basic success / partial success / malformed body
// -------------------------------------------------------------

test('HTTP: a bare {} and an empty resourceSpans array are both full success (200 {})', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      for (const body of [{}, { resourceSpans: [] }]) {
        const res = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), {});
        assert.match(res.headers.get('x-agent-viewer-otlp') ?? '', /accepted=0/);
      }
    } finally {
      server.close();
    }
  });
});

test('HTTP: a chat span is stored as one llm.usage event, broadcast over SSE, with the debug header set', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const stream = await fetch(`${baseUrl}/api/v1/events/stream`);
      const reader = stream.body.getReader();
      try {
        const decoder = new TextDecoder();
        await reader.read(); // ": connected"

        const { traceId, spanId } = freshIds();
        const res = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(tracesRequest([chatSpan({ traceId, spanId })], { serviceName: 'crew-a' })),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), {});
        assert.equal(res.headers.get('x-agent-viewer-otlp'), 'accepted=1; duplicates=0; ignored=0; rejected=0; warnings=0');

        const chunk = await reader.read();
        const text = decoder.decode(chunk.value);
        assert.ok(text.includes('"type":"llm.usage"'));
        assert.ok(text.includes(`otlp:${traceId}:${spanId}:llm`));

        const stored = await fetch(`${baseUrl}/api/v1/events?type=llm.usage&limit=1000`);
        const storedJson = await stored.json();
        assert.ok(storedJson.events.some((e) => e.id === `otlp:${traceId}:${spanId}:llm`));
      } finally {
        await reader.cancel().catch(() => {});
      }
    } finally {
      server.close();
    }
  });
});

test('HTTP: an execute_tool span is stored as tool.started + tool.completed', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const { traceId, spanId } = freshIds();
      const toolSpan = {
        traceId,
        spanId,
        name: 'execute_tool search_web',
        startTimeUnixNano: '1760000000000000000',
        endTimeUnixNano: '1760000000500000000',
        attributes: [attr('gen_ai.operation.name', str('execute_tool')), attr('gen_ai.tool.name', str('search_web'))],
        status: { code: 1 },
      };
      const res = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tracesRequest([toolSpan])),
      });
      assert.equal(res.status, 200);
      // Two canonical events (tool.started + tool.completed) come from this one accepted span: the debug
      // header's accepted/duplicates counters are store-level (per event), unlike ignored/rejected/warnings,
      // which are mapper-level (per span, see tests/otlp-mapping.test.mjs).
      assert.equal(res.headers.get('x-agent-viewer-otlp'), 'accepted=2; duplicates=0; ignored=0; rejected=0; warnings=0');

      const stored = await fetch(`${baseUrl}/api/v1/events?limit=1000`);
      const { events } = await stored.json();
      assert.ok(events.some((e) => e.id === `otlp:${traceId}:${spanId}:tool.started`));
      assert.ok(events.some((e) => e.id === `otlp:${traceId}:${spanId}:tool.end` && e.type === 'tool.completed'));
    } finally {
      server.close();
    }
  });
});

test('HTTP: a request mixing a valid span, an invalid-id span and an ignored span reports partialSuccess correctly', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const { traceId, spanId } = freshIds();
      const good = chatSpan({ traceId, spanId });
      const invalid = chatSpan({ traceId, spanId: 'not-hex' });
      const ignored = { traceId, spanId: freshIds().spanId, attributes: [attr('gen_ai.operation.name', str('invoke_agent'))] };

      const res = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tracesRequest([good, invalid, ignored])),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.partialSuccess.rejectedSpans, '1');
      assert.equal(json.partialSuccess.errorMessage, 'rejected 1 of 3 spans: invalid_span_id=1');
      assert.equal(res.headers.get('x-agent-viewer-otlp'), 'accepted=1; duplicates=0; ignored=1; rejected=1; warnings=0');
    } finally {
      server.close();
    }
  });
});

test('HTTP: malformed JSON and a body whose resourceSpans is not an array both get an OTLP-style 400', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const notArray = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resourceSpans: 'nope' }),
      });
      assert.equal(notArray.status, 400);
      assert.equal((await notArray.json()).code, 3);

      const badJson = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      });
      assert.equal(badJson.status, 400);
    } finally {
      server.close();
    }
  });
});

// -------------------------------------------------------------
// Auth, content type, encoding, span cap
// -------------------------------------------------------------

test('HTTP: without a configured token the route is open; with one, a missing/wrong token gets 401 and ?token= never authenticates', async () => {
  await withEnv({ AGENT_VIEWER_API_TOKEN: 'traces-test-token', AGENT_VIEWER_API_KEY: undefined }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const noToken = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(noToken.status, 401);
      assert.equal((await noToken.json()).code, 16);

      const queryToken = await fetch(`${baseUrl}${OTLP_TRACES_PATH}?token=traces-test-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(queryToken.status, 401);

      const rightToken = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
        method: 'POST',
        headers: { authorization: 'Bearer traces-test-token', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(rightToken.status, 200);
    } finally {
      server.close();
    }
  });
});

test('HTTP: an unsupported Content-Type or Content-Encoding gets 415', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const badType = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/xml' },
        body: '<x/>',
      });
      assert.equal(badType.status, 415);

      const badEncoding = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'x-bogus' },
        body: '{}',
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
      const { traceId, spanId } = freshIds();
      const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify(tracesRequest([chatSpan({ traceId, spanId })]))));
      const res = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
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

test('HTTP: more spans than the shared per-request cap gets 413', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      // Default AGENT_VIEWER_OTLP_MAX_RECORDS is 5000 (shared with /v1/logs and /v1/metrics, issue #59/#73);
      // these spans carry no gen_ai.* attributes at all, so they would all be "ignored" if accepted, but the
      // span-count cap is enforced before any mapping happens.
      const spans = Array.from({ length: 5001 }, () => ({ traceId: freshIds().traceId, spanId: freshIds().spanId, attributes: [] }));
      const res = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tracesRequest(spans)),
      });
      assert.equal(res.status, 413);
      assert.equal((await res.json()).code, 3);
    } finally {
      server.close();
    }
  });
});

// -------------------------------------------------------------
// http/protobuf
// -------------------------------------------------------------

/** Builds a minimal protobuf `ExportTraceServiceRequest` with one chat span, enough to exercise the route's
 * protobuf decode path (field numbers per `server/otlp/otlpProtobuf.ts`'s decoder). */
function encodeTraceRequestProtobuf({ traceId, spanId, serviceName = 'pb-service' }) {
  const keyValue = (key, valueField) => encodeMessage([encodeStringField(1, key), encodeMessageField(2, valueField)]);
  const stringValue = (s) => encodeStringField(1, s);
  const intValue = (n) => encodeVarintField(3, BigInt(n));

  const attributes = [
    keyValue('gen_ai.operation.name', stringValue('chat')),
    keyValue('gen_ai.provider.name', stringValue('anthropic')),
    keyValue('gen_ai.request.model', stringValue('claude-sonnet-5')),
    keyValue('gen_ai.usage.input_tokens', intValue(7)),
    keyValue('gen_ai.usage.output_tokens', intValue(3)),
  ];

  const status = encodeMessage([encodeVarintField(3, 1n)]); // STATUS_CODE_OK

  // `trace_id`/`span_id` are raw `bytes` fields (wire type 2); `protobufWire.ts` only exports a string-flavored
  // length-delimited encoder (`encodeStringField`), so this builds the tag+length+payload by hand instead.
  function encodeBytes(fieldNumber, bytes) {
    const tagByte = (fieldNumber << 3) | 2;
    const tag = Uint8Array.from([tagByte]);
    const len = [];
    let l = bytes.length;
    do {
      let b = l & 0x7f;
      l >>>= 7;
      if (l !== 0) b |= 0x80;
      len.push(b);
    } while (l !== 0);
    return Buffer.concat([Buffer.from(tag), Buffer.from(len), Buffer.from(bytes)]);
  }

  const spanBytes = Buffer.concat([
    encodeBytes(1, Buffer.from(traceId, 'hex')),
    encodeBytes(2, Buffer.from(spanId, 'hex')),
    Buffer.from(encodeFixed64Field(7, BigInt('1760000000000000000'))),
    Buffer.from(encodeFixed64Field(8, BigInt('1760000000500000000'))),
    ...attributes.map((a) => Buffer.from(encodeMessageField(9, a))),
    Buffer.from(encodeMessageField(15, status)),
  ]);

  const resourceBytes = Buffer.from(encodeMessageField(1, keyValue('service.name', stringValue(serviceName))));
  const scopeSpansMessageBody = Buffer.from(encodeMessageField(2, spanBytes)); // ScopeSpans.spans = field 2
  const resourceSpansBytes = Buffer.concat([
    Buffer.from(encodeMessageField(1, resourceBytes)), // ResourceSpans.resource = field 1
    Buffer.from(encodeMessageField(2, scopeSpansMessageBody)), // ResourceSpans.scope_spans = field 2
  ]);
  return Buffer.from(encodeMessageField(1, resourceSpansBytes));
}

test('HTTP: application/x-protobuf is accepted and round-trips to one llm.usage event', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const { traceId, spanId } = freshIds();
      const body = encodeTraceRequestProtobuf({ traceId, spanId });
      const res = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf' },
        body,
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/x-protobuf');
      const responseBytes = Buffer.from(await res.arrayBuffer());
      assert.equal(responseBytes.length, 0, 'full success is an empty ExportTraceServiceResponse');

      const stored = await fetch(`${baseUrl}/api/v1/events?type=llm.usage&limit=1000`);
      const { events } = await stored.json();
      assert.ok(events.some((e) => e.id === `otlp:${traceId}:${spanId}:llm`));
    } finally {
      server.close();
    }
  });
});

test('HTTP: three garbage bytes as application/x-protobuf is a clean 400, not a crash', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-protobuf' },
        body: Buffer.from([0xff, 0xff, 0xff]),
      });
      assert.equal(res.status, 400);
    } finally {
      server.close();
    }
  });
});

// -------------------------------------------------------------
// Idempotency and cross-source dedup
// -------------------------------------------------------------

test('HTTP: posting the same export twice stores it once; the second response reports only a duplicate', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const { traceId, spanId } = freshIds();
      const body = JSON.stringify(tracesRequest([chatSpan({ traceId, spanId })]));

      const first = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(first.status, 200);
      assert.equal(first.headers.get('x-agent-viewer-otlp'), 'accepted=1; duplicates=0; ignored=0; rejected=0; warnings=0');

      const second = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(second.status, 200);
      assert.equal(second.headers.get('x-agent-viewer-otlp'), 'accepted=0; duplicates=1; ignored=0; rejected=0; warnings=0');

      const stored = await fetch(`${baseUrl}/api/v1/events?type=llm.usage&limit=1000`);
      const matching = (await stored.json()).events.filter((e) => e.id === `otlp:${traceId}:${spanId}:llm`);
      assert.equal(matching.length, 1);
    } finally {
      server.close();
    }
  });
});

test('HTTP: the same call sent once via POST /api/v1/events and once via OTLP (same provider+requestId) is counted once', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const requestId = `req_cross_source_${Date.now()}`;
      const directEvent = {
        id: `manual_${requestId}`,
        type: 'llm.usage',
        timestamp: Date.now(),
        source: 'agent:cross-source-test',
        severity: 'normal',
        summary: 'manual call',
        payload: { provider: 'anthropic', model: 'claude-sonnet-5', inputTokens: 10, outputTokens: 5, requestId },
      };
      const direct = await fetch(`${baseUrl}/api/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(directEvent),
      });
      assert.equal(direct.status, 202);

      const { traceId, spanId } = freshIds();
      const span = chatSpan({ traceId, spanId, requestId });
      const viaOtlp = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tracesRequest([span])),
      });
      assert.equal(viaOtlp.status, 200);

      const stored = await fetch(`${baseUrl}/api/v1/events?type=llm.usage&limit=1000`);
      const matching = (await stored.json()).events.filter((e) => e.payload?.requestId === requestId);
      assert.equal(matching.length, 1, 'the OTLP span should collapse onto the event already stored for this (provider, requestId)');
    } finally {
      server.close();
    }
  });
});

test('HTTP: a store failure returns 503 with Retry-After, never a non-OTLP body', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    const appendBatchMock = mock.method(store, 'appendBatch', async () => {
      throw new Error('storage unavailable');
    });
    try {
      const { traceId, spanId } = freshIds();
      const res = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tracesRequest([chatSpan({ traceId, spanId })])),
      });
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { code: 14, message: 'Storage unavailable, retry' });
    } finally {
      appendBatchMock.mock.restore();
      server.close();
    }
  });
});

// -------------------------------------------------------------
// Privacy
// -------------------------------------------------------------

test('privacy: sentinel text in prompt/completion-like span attributes never reaches storage, SSE or the response', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const { traceId, spanId } = freshIds();
      const span = chatSpan({ traceId, spanId });
      span.attributes.push(
        attr('gen_ai.prompt', str('SENTINEL_PROMPT_OTLP_TRACES')),
        attr('gen_ai.completion', str('SENTINEL_COMPLETION_OTLP_TRACES'))
      );
      const postRes = await fetch(`${baseUrl}${OTLP_TRACES_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tracesRequest([span])),
      });
      const postJson = await postRes.json();
      const stored = await fetch(`${baseUrl}/api/v1/events?limit=1000`);
      const storedJson = await stored.json();
      const haystack = JSON.stringify(postJson) + JSON.stringify(storedJson);
      assert.equal(haystack.includes('SENTINEL_PROMPT_OTLP_TRACES'), false);
      assert.equal(haystack.includes('SENTINEL_COMPLETION_OTLP_TRACES'), false);
    } finally {
      server.close();
    }
  });
});
