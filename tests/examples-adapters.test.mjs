import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIAgentsViewerAdapter } from '../examples/openai-agents-adapter.ts';
import { LangGraphViewerAdapter } from '../examples/langgraph-adapter.ts';
import { GoogleADKViewerAdapter } from '../examples/google-adk-adapter.ts';

/**
 * Stubs `fetch` and records every request body, so each adapter test runs against a fake viewer instead
 * of a live server (issue #64: one test per example adapter, checking the trace/parent/tool-call-id
 * mapping table and the "omitted when not exposed" cases).
 */
function stubFetch(t) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ accepted: true, duplicate: false }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  });
  return {
    requests,
    bodiesOf: (type) => requests.map((r) => r.body).filter((body) => body.type === type),
  };
}

test('OpenAI Agents adapter: forwards call ids and usage correlation only when given', async (t) => {
  const { bodiesOf } = stubFetch(t);
  const adapter = new OpenAIAgentsViewerAdapter({ url: 'http://sdk.test' });

  await adapter.onAgentStart({ id: 'researcher', name: 'Researcher' });
  await adapter.onToolCall('web.search', 'query terms', 'call_abc');
  await adapter.onToolResult('web.search', 'found 3 results', 'call_abc');
  await adapter.onToolError('web.search', 'timeout', 'call_def');
  await adapter.onToolCall('web.search'); // the framework gave no call id
  await adapter.onUsage({
    promptTokens: 1200,
    completionTokens: 400,
    traceId: 'trace_agents_run',
    parentId: 'span_parent',
    toolCallId: 'call_abc',
    tags: ['env:prod', 'env:prod'],
  });
  await adapter.onUsage({ promptTokens: 10, completionTokens: 2 });

  const [started, startedWithoutId] = bodiesOf('tool.started');
  const [completed] = bodiesOf('tool.completed');
  const [failed] = bodiesOf('tool.failed');
  assert.equal(started.payload.toolCallId, 'call_abc');
  assert.equal(completed.payload.toolCallId, 'call_abc');
  assert.equal(failed.payload.toolCallId, 'call_def');
  assert.equal('toolCallId' in startedWithoutId.payload, false);

  const [withCorrelation, without] = bodiesOf('llm.usage');
  assert.equal(withCorrelation.payload.traceId, 'trace_agents_run');
  assert.equal(withCorrelation.payload.parentId, 'span_parent');
  assert.equal(withCorrelation.payload.toolCallId, 'call_abc');
  // The adapter sends tags exactly as given; the server deduplicates, not the SDK.
  assert.deepEqual(withCorrelation.payload.tags, ['env:prod', 'env:prod']);
  for (const field of ['traceId', 'parentId', 'toolCallId', 'tags']) {
    assert.equal(field in without.payload, false, `${field} should be omitted when the framework gave none`);
  }
});

test('LangGraph adapter: forwards tool_call.id, root run id and parentRunId only when given', async (t) => {
  const { bodiesOf } = stubFetch(t);
  const adapter = new LangGraphViewerAdapter();

  await adapter.onNodeStart('researcher');
  await adapter.onToolStart('researcher', 'web.search', 'query', 'toolcall_1');
  await adapter.onToolEnd('researcher', 'web.search', 'done', 'toolcall_1');
  await adapter.onToolError('researcher', 'web.search', 'boom', 'toolcall_2');
  await adapter.onToolStart('researcher', 'web.search'); // LangGraph gave no tool_call.id this time
  await adapter.onModelUsage('researcher', {
    provider: 'OpenAI',
    model: 'gpt-4.1',
    inputTokens: 100,
    outputTokens: 20,
    traceId: 'trace_root_run',
    parentId: 'run_parent',
    tags: ['feature:x'],
  });
  await adapter.onModelUsage('researcher', {
    provider: 'OpenAI', model: 'gpt-4.1', inputTokens: 10, outputTokens: 2,
  });

  const [started, startedWithoutId] = bodiesOf('tool.started');
  const [completed] = bodiesOf('tool.completed');
  const [failed] = bodiesOf('tool.failed');
  assert.equal(started.payload.toolCallId, 'toolcall_1');
  assert.equal(completed.payload.toolCallId, 'toolcall_1');
  assert.equal(failed.payload.toolCallId, 'toolcall_2');
  assert.equal('toolCallId' in startedWithoutId.payload, false);

  const [withCorrelation, without] = bodiesOf('llm.usage');
  assert.equal(withCorrelation.payload.traceId, 'trace_root_run');
  assert.equal(withCorrelation.payload.parentId, 'run_parent');
  assert.deepEqual(withCorrelation.payload.tags, ['feature:x']);
  for (const field of ['traceId', 'parentId', 'toolCallId', 'tags']) {
    assert.equal(field in without.payload, false);
  }
});

test('Google ADK adapter: forwards the function call id and invocation_id, never a parentId', async (t) => {
  const { bodiesOf } = stubFetch(t);
  const adapter = new GoogleADKViewerAdapter({ url: 'http://sdk.test' });

  await adapter.registerAgent('gemini_agent', 'Gemini Agent');
  await adapter.onFunctionCall('gemini_agent', 'lookup', 'args', 'fc_1');
  await adapter.onFunctionResponse('gemini_agent', 'lookup', 'result', 'fc_1');
  await adapter.onFunctionCall('gemini_agent', 'lookup'); // ADK gave no function call id
  await adapter.onUsageMetadata('gemini_agent', {
    promptTokenCount: 100,
    candidatesTokenCount: 20,
    traceId: 'invocation_123',
    toolCallId: 'fc_1',
    tags: ['env:prod'],
  });
  await adapter.onUsageMetadata('gemini_agent', { promptTokenCount: 10, candidatesTokenCount: 2 });

  const [called, calledWithoutId] = bodiesOf('tool.started');
  const [responded] = bodiesOf('tool.completed');
  assert.equal(called.payload.toolCallId, 'fc_1');
  assert.equal(responded.payload.toolCallId, 'fc_1');
  assert.equal('toolCallId' in calledWithoutId.payload, false);

  const [withCorrelation, without] = bodiesOf('llm.usage');
  assert.equal(withCorrelation.payload.traceId, 'invocation_123');
  assert.equal(withCorrelation.payload.toolCallId, 'fc_1');
  assert.deepEqual(withCorrelation.payload.tags, ['env:prod']);
  // Google ADK does not expose a parent span id at this layer: the adapter never sends one.
  for (const field of ['parentId', 'traceId', 'toolCallId', 'tags']) {
    assert.equal(field in without.payload, false);
  }
  assert.equal('parentId' in withCorrelation.payload, false);
});
