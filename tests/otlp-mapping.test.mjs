// Issue #97: unit tests for the pure OTLP/HTTP GenAI traces mapper (`src/integrations/otlpTraces.ts`). No
// network, no store: these exercise `mapOtlpTraces` directly against synthetic OTLP/JSON span batches, the same
// style `tests/otlp-logs.test.mjs` uses for the logs mapper. HTTP-level behavior (auth, limits, protobuf,
// idempotency against the store) lives in `tests/otlp-traces.test.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mapOtlpTraces, looksLikeOtlpTracesRequest, countSpans } from '../src/integrations/otlpTraces.ts';

const TRACE_ID = '5b8efff798038103d269b633813fc6ab';
const SPAN_ID = 'eee19b7ec3c1b174';
const PARENT_SPAN_ID = 'eee19b7ec3c1b173';
const START_NANO = '1760000000000000000';
const END_NANO = '1760000000940000000'; // 940ms after start

function attr(key, value) {
  return { key, value };
}

function str(value) {
  return { stringValue: value };
}
function int(value) {
  return { intValue: value };
}

/** One resourceSpans entry with one scope and the given spans. */
function tracesRequest(spans, { serviceName = 'research-crew', resourceAttributes = [] } = {}) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr('service.name', str(serviceName)), ...resourceAttributes] },
        scopeSpans: [{ spans }],
      },
    ],
  };
}

function chatSpan(overrides = {}) {
  return {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    parentSpanId: PARENT_SPAN_ID,
    name: 'chat claude-sonnet-5',
    startTimeUnixNano: START_NANO,
    endTimeUnixNano: END_NANO,
    attributes: [
      attr('gen_ai.operation.name', str('chat')),
      attr('gen_ai.provider.name', str('anthropic')),
      attr('gen_ai.request.model', str('claude-sonnet-5')),
      attr('gen_ai.response.id', str('msg_01ABC')),
      attr('gen_ai.agent.name', str('researcher')),
      attr('gen_ai.usage.input_tokens', int(1200)),
      attr('gen_ai.usage.output_tokens', int(340)),
    ],
    status: { code: 1 },
    ...overrides,
  };
}

// -------------------------------------------------------------
// Shape detection
// -------------------------------------------------------------

test('looksLikeOtlpTracesRequest: accepts {}, {resourceSpans: []}, rejects anything else', () => {
  assert.equal(looksLikeOtlpTracesRequest({}), true);
  assert.equal(looksLikeOtlpTracesRequest({ resourceSpans: [] }), true);
  assert.equal(looksLikeOtlpTracesRequest({ resourceSpans: 'nope' }), false);
  assert.equal(looksLikeOtlpTracesRequest(null), false);
  assert.equal(looksLikeOtlpTracesRequest('a string'), false);
});

test('countSpans: counts across every resourceSpans and scopeSpans entry', () => {
  const body = {
    resourceSpans: [
      { scopeSpans: [{ spans: [{}, {}] }, { spans: [{}] }] },
      { scopeSpans: [{ spans: [{}] }] },
    ],
  };
  assert.equal(countSpans(body), 4);
  assert.equal(countSpans({}), 0);
});

// -------------------------------------------------------------
// LLM spans -> llm.usage
// -------------------------------------------------------------

test('mapper: a chat span maps to one llm.usage with the documented fields (issue #97 worked example)', () => {
  const result = mapOtlpTraces(tracesRequest([chatSpan()]));
  assert.equal(result.events.length, 1);
  assert.equal(result.accepted, 1);
  assert.equal(result.ignored, 0);
  assert.equal(result.rejected.count, 0);

  const event = result.events[0];
  assert.equal(event.type, 'llm.usage');
  assert.equal(event.id, `otlp:${TRACE_ID}:${SPAN_ID}:llm`);
  assert.equal(event.timestamp, 1760000000940);
  assert.equal(event.runtimeId, 'otlp:research-crew');
  assert.equal(event.source, 'otlp:research-crew');
  assert.equal(event.agentId, 'researcher');
  assert.equal(event.payload.provider, 'anthropic');
  assert.equal(event.payload.model, 'claude-sonnet-5');
  assert.equal(event.payload.inputTokens, 1200);
  assert.equal(event.payload.outputTokens, 340);
  assert.equal(event.payload.latencyMs, 940);
  assert.equal(event.payload.requestId, 'msg_01ABC');
  assert.equal(event.payload.traceId, TRACE_ID);
  assert.equal(event.payload.spanId, SPAN_ID);
  assert.equal(event.payload.parentId, PARENT_SPAN_ID);
  // Unknown is not zero: no cost attribute was sent.
  assert.equal(event.payload.cost, null);
  assert.equal(event.payload.costSource, 'unknown');
});

test('mapper: cache read/write and reasoning tokens map when present, stay absent (not 0) when not', () => {
  const span = chatSpan({
    attributes: [
      ...chatSpan().attributes,
      attr('gen_ai.usage.cache_read.input_tokens', int(800)),
      attr('gen_ai.usage.cache_creation.input_tokens', int(200)),
      attr('gen_ai.usage.reasoning.output_tokens', int(50)),
    ],
  });
  const event = mapOtlpTraces(tracesRequest([span])).events[0];
  assert.equal(event.payload.cacheReadTokens, 800);
  assert.equal(event.payload.cacheWriteTokens, 200);
  assert.equal(event.payload.reasoningTokens, 50);

  const bare = mapOtlpTraces(tracesRequest([chatSpan()])).events[0];
  assert.equal('cacheReadTokens' in bare.payload, false);
  assert.equal('cacheWriteTokens' in bare.payload, false);
  assert.equal('reasoningTokens' in bare.payload, false);
});

test('mapper: a failing span (llm.failed) can omit inputTokens/outputTokens entirely; summary never shows 0', () => {
  // llm.usage requires both counts (LlmUsagePayloadSchema, issue #46): a non-failed span missing either one
  // cannot be represented and is rejected rather than stored with an invented 0 (see the "unmappable" test
  // below). llm.failed's counts are nullish, so a failed call can omit them, which is what "unknown is not
  // zero" means in practice for this receiver.
  const span = chatSpan({
    status: { code: 2 },
    attributes: chatSpan().attributes.filter((a) => a.key !== 'gen_ai.usage.input_tokens' && a.key !== 'gen_ai.usage.output_tokens'),
  });
  const result = mapOtlpTraces(tracesRequest([span]));
  assert.equal(result.events.length, 1);
  const event = result.events[0];
  assert.equal(event.type, 'llm.failed');
  assert.equal('inputTokens' in event.payload, false);
  assert.equal('outputTokens' in event.payload, false);
  assert.equal(JSON.stringify(event).includes('"inputTokens":0'), false);
  assert.equal(JSON.stringify(event).includes('"outputTokens":0'), false);
});

test('mapper: a non-failed LLM span missing a required token count is rejected as unmappable, never stored as 0', () => {
  const span = chatSpan({ attributes: chatSpan().attributes.filter((a) => a.key !== 'gen_ai.usage.input_tokens') });
  const result = mapOtlpTraces(tracesRequest([span]));
  assert.equal(result.events.length, 0);
  assert.deepEqual(result.rejected.reasons, ['unmappable']);
});

test('mapper: an invalid optional attribute value (negative, fractional, too large, numeric string) is unknown, never 0, and warns', () => {
  // Cache tokens are nullish in the schema (unlike the base inputTokens/outputTokens above), so the span stays
  // accepted when one of these is dropped for being malformed.
  for (const badValue of [{ intValue: -5 }, { doubleValue: 1.5 }, { intValue: String(Number.MAX_SAFE_INTEGER) + '0' }, { stringValue: '42' }]) {
    const span = chatSpan({ attributes: [...chatSpan().attributes, attr('gen_ai.usage.cache_read.input_tokens', badValue)] });
    const result = mapOtlpTraces(tracesRequest([span]));
    assert.equal(result.events.length, 1, `span should still be accepted for ${JSON.stringify(badValue)}`);
    assert.equal('cacheReadTokens' in result.events[0].payload, false);
    assert.ok(result.warnings >= 1, `expected a warning for ${JSON.stringify(badValue)}`);
  }
});

test('mapper: gen_ai.usage.cost yields estimated cost; cost.source=provider-reported is honored; invalid currency is dropped with a warning', () => {
  const withCost = chatSpan({
    attributes: [...chatSpan().attributes, attr('gen_ai.usage.cost', { doubleValue: 0.0123 }), attr('gen_ai.usage.cost.currency', str('usd'))],
  });
  const event = mapOtlpTraces(tracesRequest([withCost])).events[0];
  assert.equal(event.payload.cost, 0.0123);
  assert.equal(event.payload.costSource, 'estimated');
  assert.equal(event.payload.currency, 'USD');

  const providerReported = chatSpan({
    attributes: [
      ...chatSpan().attributes,
      attr('gen_ai.usage.cost', { doubleValue: 0.5 }),
      attr('gen_ai.usage.cost.source', str('provider-reported')),
    ],
  });
  assert.equal(mapOtlpTraces(tracesRequest([providerReported])).events[0].payload.costSource, 'provider-reported');

  const badCurrency = chatSpan({
    attributes: [...chatSpan().attributes, attr('gen_ai.usage.cost', { doubleValue: 1 }), attr('gen_ai.usage.cost.currency', str('US$'))],
  });
  const result = mapOtlpTraces(tracesRequest([badCurrency]));
  assert.equal('currency' in result.events[0].payload, false);
  assert.ok(result.warnings >= 1);
});

test('mapper: a span with no cost attribute yields cost: null, costSource: "unknown" (never 0)', () => {
  const event = mapOtlpTraces(tracesRequest([chatSpan()])).events[0];
  assert.equal(event.payload.cost, null);
  assert.equal(event.payload.costSource, 'unknown');
});

test('mapper: status ERROR (numeric or string) or error.type yields llm.failed with a mapped errorKind, never status.message', () => {
  const failedNumeric = chatSpan({ status: { code: 2, message: 'leaking a secret prompt fragment' } });
  const eventA = mapOtlpTraces(tracesRequest([failedNumeric])).events[0];
  assert.equal(eventA.type, 'llm.failed');
  assert.equal(eventA.severity, 'high');
  assert.equal(JSON.stringify(eventA).includes('leaking a secret prompt fragment'), false);

  const failedString = chatSpan({ status: { code: 'STATUS_CODE_ERROR' } });
  assert.equal(mapOtlpTraces(tracesRequest([failedString])).events[0].type, 'llm.failed');

  const withErrorType = chatSpan({
    status: { code: 0 },
    attributes: [...chatSpan().attributes, attr('error.type', str('429'))],
  });
  const eventC = mapOtlpTraces(tracesRequest([withErrorType])).events[0];
  assert.equal(eventC.type, 'llm.failed');
  assert.equal(eventC.payload.errorKind, 'rate_limited');
  assert.equal(eventC.payload.providerErrorCode, '429');
});

test('mapper: status ERROR with no error.type leaves errorKind as the schema default, never invented', () => {
  const span = chatSpan({ status: { code: 2 } });
  const event = mapOtlpTraces(tracesRequest([span])).events[0];
  assert.equal(event.payload.errorKind, 'unknown');
  assert.equal('providerErrorCode' in event.payload, false);
});

// -------------------------------------------------------------
// Tool spans -> tool.started / tool.completed / tool.failed
// -------------------------------------------------------------

function toolSpan(overrides = {}) {
  return {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    parentSpanId: PARENT_SPAN_ID,
    name: 'execute_tool search_web',
    startTimeUnixNano: START_NANO,
    endTimeUnixNano: END_NANO,
    attributes: [
      attr('gen_ai.operation.name', str('execute_tool')),
      attr('gen_ai.tool.name', str('search_web')),
      attr('gen_ai.tool.call.id', str('call_123')),
      attr('gen_ai.tool.type', str('function')),
      attr('gen_ai.agent.name', str('researcher')),
    ],
    status: { code: 1 },
    ...overrides,
  };
}

test('mapper: an execute_tool span yields tool.started + tool.completed, ordered, sharing correlation ids', () => {
  const result = mapOtlpTraces(tracesRequest([toolSpan()]));
  assert.equal(result.accepted, 1);
  assert.equal(result.events.length, 2);
  const [started, completed] = result.events;
  assert.equal(started.type, 'tool.started');
  assert.equal(completed.type, 'tool.completed');
  assert.equal(started.timestamp, 1760000000000);
  assert.equal(completed.timestamp, 1760000000940);
  assert.equal(completed.payload.durationMs, 940);
  for (const event of [started, completed]) {
    assert.equal(event.payload.tool, 'search_web');
    assert.equal(event.payload.toolCallId, 'call_123');
    assert.equal(event.payload.traceId, TRACE_ID);
    assert.equal(event.payload.spanId, SPAN_ID);
    assert.equal(event.payload.parentId, PARENT_SPAN_ID);
    assert.equal(event.agentId, 'researcher');
  }
  assert.equal(started.id, `otlp:${TRACE_ID}:${SPAN_ID}:tool.started`);
  assert.equal(completed.id, `otlp:${TRACE_ID}:${SPAN_ID}:tool.end`);
});

test('mapper: a failed tool span yields tool.failed (same id as tool.completed would have used) with no error text from status.message', () => {
  const span = toolSpan({ status: { code: 2, message: 'tool args: secret payload' } });
  const result = mapOtlpTraces(tracesRequest([span]));
  const failed = result.events.find((e) => e.type === 'tool.failed');
  assert.ok(failed);
  assert.equal(failed.id, `otlp:${TRACE_ID}:${SPAN_ID}:tool.end`);
  assert.equal(failed.severity, 'high');
  assert.equal(JSON.stringify(failed).includes('secret payload'), false);
});

test('mapper: a tool span falls back to the span name (minus "execute_tool ") when gen_ai.tool.name is absent', () => {
  const span = toolSpan({ attributes: toolSpan().attributes.filter((a) => a.key !== 'gen_ai.tool.name') });
  const event = mapOtlpTraces(tracesRequest([span])).events[0];
  assert.equal(event.payload.tool, 'search_web');
});

test('mapper: a tool span with neither gen_ai.tool.name nor a usable span name is rejected as no_tool_name', () => {
  const span = toolSpan({ name: undefined, attributes: toolSpan().attributes.filter((a) => a.key !== 'gen_ai.tool.name') });
  const result = mapOtlpTraces(tracesRequest([span]));
  assert.equal(result.events.length, 0);
  assert.equal(result.rejected.count, 1);
  assert.deepEqual(result.rejected.reasons, ['no_tool_name']);
});

test('mapper: a tool span with a zero/missing start falls back to its end for both events', () => {
  const span = toolSpan({ startTimeUnixNano: undefined });
  const result = mapOtlpTraces(tracesRequest([span]));
  const [started, completed] = result.events;
  assert.equal(started.timestamp, 1760000000940);
  assert.equal(completed.timestamp, 1760000000940);
});

// -------------------------------------------------------------
// Ignored spans (agent/workflow/other GenAI operations, never an event, never rejected)
// -------------------------------------------------------------

test('mapper: invoke_agent/create_agent and non-GenAI spans are ignored even when they carry usage attributes', () => {
  for (const operation of ['invoke_agent', 'create_agent', 'something_else_entirely']) {
    const span = {
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      startTimeUnixNano: START_NANO,
      endTimeUnixNano: END_NANO,
      attributes: [attr('gen_ai.operation.name', str(operation)), attr('gen_ai.usage.input_tokens', int(999))],
    };
    const result = mapOtlpTraces(tracesRequest([span]));
    assert.equal(result.events.length, 0, operation);
    assert.equal(result.ignored, 1, operation);
    assert.equal(result.rejected.count, 0, operation);
  }

  const noOperation = { traceId: TRACE_ID, spanId: SPAN_ID, attributes: [] };
  const result = mapOtlpTraces(tracesRequest([noOperation]));
  assert.equal(result.ignored, 1);
});

// -------------------------------------------------------------
// Deterministic ids / idempotency (mapper level: the store handles cross-request dedup)
// -------------------------------------------------------------

test('ids: mapping the same span twice yields the same event id', () => {
  const a = mapOtlpTraces(tracesRequest([chatSpan()]));
  const b = mapOtlpTraces(tracesRequest([chatSpan()]));
  assert.equal(a.events[0].id, b.events[0].id);
});

test('ids: an uppercase trace/span id in JSON yields the same event id as lowercase', () => {
  const lower = mapOtlpTraces(tracesRequest([chatSpan()]));
  const upper = mapOtlpTraces(
    tracesRequest([chatSpan({ traceId: TRACE_ID.toUpperCase(), spanId: SPAN_ID.toUpperCase(), parentSpanId: PARENT_SPAN_ID.toUpperCase() })])
  );
  assert.equal(lower.events[0].id, upper.events[0].id);
  assert.equal(lower.events[0].payload.traceId, upper.events[0].payload.traceId);
});

test('rejected: an invalid traceId or spanId rejects the span with the documented reason code', () => {
  const badTrace = mapOtlpTraces(tracesRequest([chatSpan({ traceId: 'not-hex' })]));
  assert.deepEqual(badTrace.rejected.reasons, ['invalid_trace_id']);

  const zeroTrace = mapOtlpTraces(tracesRequest([chatSpan({ traceId: '0'.repeat(32) })]));
  assert.deepEqual(zeroTrace.rejected.reasons, ['invalid_trace_id']);

  const badSpan = mapOtlpTraces(tracesRequest([chatSpan({ spanId: 'zz' })]));
  assert.deepEqual(badSpan.rejected.reasons, ['invalid_span_id']);
});

test('rejected: a span with no usable timestamp (both start and end zero/missing) is rejected as no_timestamp', () => {
  const span = chatSpan({ startTimeUnixNano: undefined, endTimeUnixNano: undefined });
  const result = mapOtlpTraces(tracesRequest([span]));
  assert.deepEqual(result.rejected.reasons, ['no_timestamp']);
});

// -------------------------------------------------------------
// Agent resolution (span id/name, then nearest same-request ancestor, then service.name)
// -------------------------------------------------------------

test('agent resolution: a child span with no agent attributes inherits its invoke_agent ancestor name', () => {
  const parentSpanId = 'aaaaaaaaaaaaaaaa';
  const ancestor = {
    traceId: TRACE_ID,
    spanId: parentSpanId,
    attributes: [attr('gen_ai.operation.name', str('invoke_agent')), attr('gen_ai.agent.name', str('planner'))],
  };
  const child = chatSpan({ parentSpanId, attributes: chatSpan().attributes.filter((a) => a.key !== 'gen_ai.agent.name') });
  const result = mapOtlpTraces(tracesRequest([ancestor, child]));
  const llmEvent = result.events.find((e) => e.type === 'llm.usage');
  assert.equal(llmEvent.agentId, 'planner');
});

test('agent resolution: falls back to resource service.name when no agent attribute is found anywhere', () => {
  const span = chatSpan({ parentSpanId: undefined, attributes: chatSpan().attributes.filter((a) => a.key !== 'gen_ai.agent.name') });
  const result = mapOtlpTraces(tracesRequest([span], { serviceName: 'billing-bot' }));
  assert.equal(result.events[0].agentId, 'billing-bot');
});

test('agent resolution: a parent-chain cycle terminates instead of looping forever', () => {
  const a = { traceId: TRACE_ID, spanId: 'aaaaaaaaaaaaaaaa', parentSpanId: 'bbbbbbbbbbbbbbbb', attributes: [] };
  const b = { traceId: TRACE_ID, spanId: 'bbbbbbbbbbbbbbbb', parentSpanId: 'aaaaaaaaaaaaaaaa', attributes: [] };
  const child = chatSpan({
    parentSpanId: 'aaaaaaaaaaaaaaaa',
    attributes: chatSpan().attributes.filter((attribute) => attribute.key !== 'gen_ai.agent.name'),
  });
  const result = mapOtlpTraces(tracesRequest([a, b, child]));
  // No agent attribute anywhere in the cycle: falls through to the resource service.name, and does not hang.
  assert.equal(result.events.find((e) => e.type === 'llm.usage').agentId, 'research-crew');
});

// -------------------------------------------------------------
// Privacy by construction
// -------------------------------------------------------------

test('privacy: an attribute outside the allowlist never reaches the event, even as a lookalike key', () => {
  const span = chatSpan({
    attributes: [
      ...chatSpan().attributes,
      attr('gen_ai.prompt', str('SENTINEL_PROMPT_SHOULD_NEVER_APPEAR')),
      attr('gen_ai.completion', str('SENTINEL_COMPLETION_SHOULD_NEVER_APPEAR')),
    ],
  });
  const result = mapOtlpTraces(tracesRequest([span]));
  const serialized = JSON.stringify(result.events[0]);
  assert.equal(serialized.includes('SENTINEL_PROMPT_SHOULD_NEVER_APPEAR'), false);
  assert.equal(serialized.includes('SENTINEL_COMPLETION_SHOULD_NEVER_APPEAR'), false);
});
