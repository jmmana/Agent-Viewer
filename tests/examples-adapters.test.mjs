import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleADKViewerAdapter } from '../examples/google-adk-adapter.ts';

/**
 * Stubs `fetch` and records every request body, so each adapter test runs against a fake viewer instead
 * of a live server (issue #64: one test per example adapter, checking the trace/parent/tool-call-id
 * mapping table and the "omitted when not exposed" cases).
 *
 * The OpenAI Agents case that used to live here was removed by issue #100: the hand-wired
 * `OpenAIAgentsViewerAdapter` callback class it tested was replaced by a real tracing-processor
 * implementation (`packages/openai-agents/src/processor.ts`, published as
 * `@warlockcode/agent-viewer-openai-agents`, issue #361; registered on the real `@openai/agents` tracing
 * pipeline) with its own, more thorough test suite at `tests/openai-agents-adapter.test.mjs`.
 *
 * The LangGraph case was removed the same way by issue #346: the hand-wired example adapter it tested was
 * replaced by `packages/langgraph` (`@warlockcode/agent-viewer-langgraph`), tested in
 * `tests/langgraph-adapter.test.mjs`.
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
