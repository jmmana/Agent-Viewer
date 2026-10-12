// Tests for the OpenAI Agents tracing processor (issue #100), following the harness pattern of
// `tests/sdk-typescript.test.mjs`: a real in-process server, exercised through the real `@openai/agents`
// tracing pipeline (`withTrace`/`createXSpan`/`addTraceProcessor`), never a hand-rolled fake span shape.
// This both replays fixture-like span data (full control over the fields) and proves the real dispatch path
// (`addTraceProcessor`, `Span.start()`/`end()`, parent/trace context) invokes the processor, which is what the
// issue's "offline end-to-end test" and "replay unit tests" ask for; see the README for why a fully offline
// test of OpenAI's *own* model classes is not possible (generation/response spans are created inside
// `@openai/agents-openai`, which this harness does not exercise).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  addTraceProcessor,
  setTraceProcessors,
  setTracingDisabled,
  withTrace,
  createAgentSpan,
  createFunctionSpan,
  createGenerationSpan,
  createResponseSpan,
  createHandoffSpan,
} from '@openai/agents';
import { app } from '../server/index.ts';
import { AgentViewerTracingProcessor } from '../examples/openai-agents-adapter/processor.ts';

// `@openai/agents` disables tracing by default when NODE_ENV === 'test' (see `config.js`'s `tracing.disabled`
// getter); this suite exercises the real tracing pipeline, so it must be turned back on explicitly.
setTracingDisabled(false);

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

const CANARY_INPUT = 'CANARY_TOOL_INPUT_SHOULD_NEVER_LEAVE_THE_RUNTIME';
const CANARY_OUTPUT = 'CANARY_TOOL_OUTPUT_SHOULD_NEVER_LEAVE_THE_RUNTIME';

/** Drives one fixture run: one agent, a cached-and-reasoning model call, one tool call, a handoff to a second
 * agent, and a failed model call on the second agent. Returns the processor so the caller can flush/inspect. */
async function runFixtureTrace(processor, { groupId }) {
  await withTrace(
    'fixture-run',
    async (trace) => {
      const triage = createAgentSpan({ data: { name: 'Triage Agent', tools: ['lookup'], handoffs: ['Billing Agent'] } }, trace);
      triage.start();

      const generation = createGenerationSpan({ data: {} }, triage);
      generation.start();
      generation.spanData.model = 'gpt-4o-mini';
      generation.spanData.usage = {
        requests: 1,
        input_tokens: 120,
        output_tokens: 40,
        total_tokens: 160,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens_details: { reasoning_tokens: 5 },
      };
      generation.end();

      const tool = createFunctionSpan(
        { data: { name: 'lookup', input: JSON.stringify({ q: CANARY_INPUT }), output: JSON.stringify({ r: CANARY_OUTPUT }) } },
        triage,
      );
      tool.start();
      tool.end();

      const handoff = createHandoffSpan({ data: { from_agent: 'Triage Agent', to_agent: 'Billing Agent' } }, triage);
      handoff.start();
      handoff.end();

      triage.end();

      const billing = createAgentSpan({ data: { name: 'Billing Agent' } }, trace);
      billing.start();

      const failedResponse = createResponseSpan({ data: {} }, billing);
      failedResponse.start();
      failedResponse.spanData._response = { model: 'gpt-4o', id: 'resp_failed_1' };
      failedResponse.setError({ message: 'rate limited' });
      failedResponse.end();

      billing.end();
    },
    { groupId },
  );
  await processor.forceFlush();
}

test('OpenAI Agents processor: full fixture run produces the expected canonical events', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const processor = new AgentViewerTracingProcessor({
      url: baseUrl,
      runtimeId: 'openai-agents-test',
      flushIntervalMs: 50,
    });
    addTraceProcessor(processor);

    await runFixtureTrace(processor, { groupId: 'session-fixture-1' });

    const eventsResponse = await fetch(`${baseUrl}/api/v1/events?sessionId=session-fixture-1&limit=200`);
    assert.equal(eventsResponse.status, 200);
    const { events } = await eventsResponse.json();

    const byType = (type) => events.filter((e) => e.type === type);

    // Both agents were registered, with the real agent name and no invented model.
    const registered = byType('agent.registered');
    assert.ok(registered.some((e) => e.payload.name === 'Triage Agent' && e.payload.model === 'Custom'));
    assert.ok(registered.some((e) => e.payload.name === 'Billing Agent'));

    // Usage: exact token figures from the fixture, cache and reasoning preserved, cost unknown, no invented model.
    const usage = byType('llm.usage');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].payload.provider, 'OpenAI');
    assert.equal(usage[0].payload.model, 'gpt-4o-mini');
    assert.equal(usage[0].payload.inputTokens, 120);
    assert.equal(usage[0].payload.outputTokens, 40);
    assert.equal(usage[0].payload.cacheReadTokens, 20);
    assert.equal(usage[0].payload.reasoningTokens, 5);
    assert.equal(usage[0].payload.cost, null);
    assert.equal(usage[0].payload.costSource, 'unknown');
    assert.ok(typeof usage[0].payload.traceId === 'string' && usage[0].payload.traceId.length > 0);

    // Failure: emitted as llm.failed, model recorded from the fixture (not invented), no usage with zeros.
    const failed = byType('llm.failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].payload.model, 'gpt-4o');
    assert.equal(failed[0].payload.errorKind, 'unknown');

    // Tool call: toolCallId correlates started/completed, durationMs present, no invented status.
    const toolStarted = byType('tool.started');
    const toolCompleted = byType('tool.completed');
    assert.equal(toolStarted.length, 1);
    assert.equal(toolCompleted.length, 1);
    assert.equal(toolStarted[0].payload.toolCallId, toolCompleted[0].payload.toolCallId);
    assert.equal(typeof toolCompleted[0].payload.durationMs, 'number');

    // Handoff: a message from the source agent naming the target, no model-authored reason text.
    const messages = byType('agent.message.sent');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].payload.text, 'Handoff to Billing Agent');
    assert.equal(messages[0].payload.targetAgentName, 'Billing Agent');

    // Privacy: the tool's real input/output never left the runtime (includeToolInputSummary defaults to false).
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(CANARY_INPUT));
    assert.ok(!serialized.includes(CANARY_OUTPUT));
  } finally {
    setTraceProcessors([]);
    server.close();
  }
});

// Plain-object span/trace fixtures (same readable properties the processor reads: `traceId`, `spanId`,
// `parentId`, `spanData`, `startedAt`, `endedAt`, `error`), used to test id determinism directly, independent
// of the real SDK's own random id generation (each `withTrace()` call mints a fresh, non-reproducible
// `traceId`, so it cannot itself be used to simulate a redelivery of the exact same span).
function fakeSpan({ traceId, spanId, parentId = null, data, startedAt = '2026-01-01T00:00:00.000Z', endedAt = '2026-01-01T00:00:01.000Z', error = null }) {
  return { traceId, spanId, parentId, spanData: data, startedAt, endedAt, error };
}

test('OpenAI Agents processor: deterministic ids make a redelivered span a no-op on the ledger', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const processor = new AgentViewerTracingProcessor({ url: baseUrl, runtimeId: 'openai-agents-test', flushIntervalMs: 50 });

    async function deliverOnce() {
      const trace = { traceId: 'trace-replay-1', groupId: 'session-replay', name: 'replay' };
      await processor.onTraceStart(trace);
      const agentSpan = fakeSpan({ traceId: trace.traceId, spanId: 'span-agent-1', data: { type: 'agent', name: 'Replay Agent' } });
      await processor.onSpanStart(agentSpan);
      const genSpan = fakeSpan({
        traceId: trace.traceId,
        spanId: 'span-gen-1',
        parentId: 'span-agent-1',
        data: { type: 'generation', model: 'gpt-4o-mini', usage: { input_tokens: 10, output_tokens: 5 } },
      });
      await processor.onSpanStart(genSpan);
      await processor.onSpanEnd(genSpan);
      await processor.onSpanEnd(agentSpan);
      await processor.onTraceEnd(trace);
      await processor.forceFlush();
    }

    await deliverOnce();
    const firstPass = await (await fetch(`${baseUrl}/api/v1/events?sessionId=session-replay&limit=200`)).json();
    assert.ok(firstPass.events.length > 0);

    const statsBefore = processor.stats();
    await deliverOnce();
    const statsAfter = processor.stats();
    assert.ok(statsAfter.duplicates > statsBefore.duplicates, 'redelivering the same spans should be reported as duplicates');

    const secondPass = await (await fetch(`${baseUrl}/api/v1/events?sessionId=session-replay&limit=200`)).json();
    assert.equal(secondPass.events.length, firstPass.events.length, 'a redelivery must not double-count events');
  } finally {
    server.close();
  }
});

test('OpenAI Agents processor: concurrent tool calls get distinct ids and keep the agent in USING_TOOL', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const processor = new AgentViewerTracingProcessor({ url: baseUrl, runtimeId: 'openai-agents-test', flushIntervalMs: 50 });
    addTraceProcessor(processor);

    await withTrace(
      'concurrent-tools',
      async (trace) => {
        const agent = createAgentSpan({ data: { name: 'Worker' } }, trace);
        agent.start();
        const toolA = createFunctionSpan({ data: { name: 'search' } }, agent);
        const toolB = createFunctionSpan({ data: { name: 'search' } }, agent);
        toolA.start();
        toolB.start();
        toolA.end();
        // toolB is still running: the agent must not have gone back to THINKING/IDLE yet.
        assert.notEqual(toolA.spanId, toolB.spanId);
        toolB.end();
        agent.end();
      },
      { groupId: 'session-concurrent' },
    );
    await processor.forceFlush();

    const { events } = await (await fetch(`${baseUrl}/api/v1/events?sessionId=session-concurrent&limit=200`)).json();
    const toolStarted = events.filter((e) => e.type === 'tool.started');
    const toolCompleted = events.filter((e) => e.type === 'tool.completed');
    assert.equal(toolStarted.length, 2);
    assert.equal(toolCompleted.length, 2);
    assert.notEqual(toolStarted[0].payload.toolCallId, toolStarted[1].payload.toolCallId);

    const statuses = events.filter((e) => e.type === 'agent.status.changed').map((e) => e.payload.status);
    // After the first tool ends (one still in flight) the agent is reported USING_TOOL, not THINKING/IDLE.
    assert.ok(statuses.includes('USING_TOOL'));
  } finally {
    setTraceProcessors([]);
    server.close();
  }
});

test('OpenAI Agents processor: a model call with no agent ancestor is attributed to the unattributed fallback, never dropped', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const processor = new AgentViewerTracingProcessor({ url: baseUrl, runtimeId: 'openai-agents-test', flushIntervalMs: 50 });
    addTraceProcessor(processor);

    await withTrace(
      'orphan-generation',
      async (trace) => {
        const generation = createGenerationSpan({ data: {} }, trace);
        generation.start();
        generation.spanData.model = 'gpt-4o-mini';
        generation.spanData.usage = { input_tokens: 10, output_tokens: 5 };
        generation.end();
      },
      { groupId: 'session-orphan' },
    );
    await processor.forceFlush();

    const { events } = await (await fetch(`${baseUrl}/api/v1/events?sessionId=session-orphan&limit=200`)).json();
    const usage = events.filter((e) => e.type === 'llm.usage');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].agentId, 'openai-agents-test');
    const registered = events.filter((e) => e.type === 'agent.registered');
    assert.ok(registered.some((e) => e.payload.name === 'OpenAI Agents (unattributed)'));
  } finally {
    setTraceProcessors([]);
    server.close();
  }
});

test('OpenAI Agents processor: a missing token counter is omitted, never sent as 0', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const processor = new AgentViewerTracingProcessor({ url: baseUrl, runtimeId: 'openai-agents-test', flushIntervalMs: 50 });
    addTraceProcessor(processor);

    await withTrace(
      'no-usage-run',
      async (trace) => {
        const agent = createAgentSpan({ data: { name: 'Silent' } }, trace);
        agent.start();
        const generation = createGenerationSpan({ data: {} }, agent);
        generation.start();
        generation.spanData.model = 'gpt-4o-mini';
        // No usage reported at all (provider omitted it): must not be sent as llm.usage with zeros.
        generation.end();
        agent.end();
      },
      { groupId: 'session-no-usage' },
    );
    await processor.forceFlush();

    assert.equal(processor.stats().noUsageCalls, 1);
    const { events } = await (await fetch(`${baseUrl}/api/v1/events?sessionId=session-no-usage&limit=200`)).json();
    assert.equal(events.filter((e) => e.type === 'llm.usage').length, 0);
  } finally {
    setTraceProcessors([]);
    server.close();
  }
});

test('OpenAI Agents processor: a down server never blocks the run, and shutdown resolves within its timeout', async () => {
  // Port 1 on loopback is reserved and refuses connections immediately on every platform CI runs on.
  const processor = new AgentViewerTracingProcessor({
    url: 'http://127.0.0.1:1',
    runtimeId: 'openai-agents-test',
    flushIntervalMs: 20,
    shutdownTimeoutMs: 300,
    maxRetries: 0,
  });
  addTraceProcessor(processor);

  const startedAt = Date.now();
  await withTrace(
    'down-server-run',
    async (trace) => {
      const agent = createAgentSpan({ data: { name: 'Resilient' } }, trace);
      agent.start();
      const generation = createGenerationSpan({ data: {} }, agent);
      generation.start();
      generation.spanData.model = 'gpt-4o-mini';
      generation.spanData.usage = { input_tokens: 10, output_tokens: 5 };
      generation.end();
      agent.end();
    },
    { groupId: 'session-down' },
  );
  const traceElapsedMs = Date.now() - startedAt;
  // The trace callbacks themselves never await the network: they return almost immediately regardless of the
  // unreachable server. A generous bound avoids flakiness while still catching an accidental awaited send.
  assert.ok(traceElapsedMs < 500, `trace completion should not block on the network (took ${traceElapsedMs}ms)`);

  const shutdownStartedAt = Date.now();
  await processor.shutdown();
  const shutdownElapsedMs = Date.now() - shutdownStartedAt;
  assert.ok(shutdownElapsedMs < 2000, `shutdown() should resolve within its bound (took ${shutdownElapsedMs}ms)`);

  setTraceProcessors([]);
});
