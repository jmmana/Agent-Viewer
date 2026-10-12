// Tests for the TypeScript LangGraph adapter (issue #344), following the harness of
// `tests/openai-agents-adapter.test.mjs`: a real in-process server validates every event against the
// canonical contract. The fixtures replay the callback sequences `@langchain/core` dispatches for a LangGraph
// run (positional `handle*` arguments, fixed run ids, a fixed clock, no network beyond 127.0.0.1) straight
// into the adapter's core, so they run without the framework installed. The last test drives the real
// `AgentViewerCallbackHandler` through a real `StateGraph` and is skipped when `@langchain/langgraph` is absent.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../server/index.ts';
import { AgentViewer } from '../packages/sdk/src/index.ts';
import { AgentViewerLangGraphCore } from '../packages/langgraph/src/core.ts';

const CANARY_PROMPT = 'CANARY-PROMPT-7f3a';
const CANARY_COMPLETION = 'CANARY-COMPLETION-9b21';
const CANARY_TOOL_INPUT = 'CANARY-TOOL-INPUT-44c0';
const CANARY_TOOL_OUTPUT = 'CANARY-TOOL-OUTPUT-1d8e';
const CANARY_ERROR = 'CANARY-ERROR-MESSAGE-a5f2';
const CANARY_METADATA = 'CANARY-METADATA-0e7b';

const RUNTIME = 'lg-test';

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/** Deterministic clock: starts at a fixed epoch and advances 10ms per read. */
function fixedClock(start = 1_760_000_000_000) {
  let t = start;
  return () => {
    t += 10;
    return t;
  };
}

function createCore(baseUrl, extra = {}) {
  const errors = [];
  const core = new AgentViewerLangGraphCore({
    url: baseUrl,
    runtimeId: RUNTIME,
    now: fixedClock(),
    onError: (error, dropped) => errors.push({ error, dropped }),
    ...extra,
  });
  return { core, errors };
}

async function eventsFor(baseUrl, sessionId) {
  const response = await fetch(`${baseUrl}/api/v1/events?sessionId=${encodeURIComponent(sessionId)}&limit=500`);
  assert.equal(response.status, 200);
  const { events } = await response.json();
  return events;
}

function byId(events, id) {
  const found = events.filter((e) => e.id === id);
  assert.equal(found.length, 1, `expected exactly one event ${id}, got ${found.length}`);
  return found[0];
}

/** Metadata the way LangGraph fills it: whitelisted keys plus keys the adapter must never read or forward. */
function nodeMeta(threadId, node, extra = {}) {
  return {
    thread_id: threadId,
    langgraph_node: node,
    langgraph_step: 1,
    langgraph_triggers: [`branch:to:${node}`],
    langgraph_checkpoint_ns: `${node}:00000000-0000-0000-0000-000000000000`,
    user_secret: CANARY_METADATA,
    ...extra,
  };
}

function modelMeta(threadId, node, model = 'gpt-4o-mini') {
  return nodeMeta(threadId, node, { ls_provider: 'openai', ls_model_name: model, ls_model_type: 'chat', ls_temperature: 0 });
}

const CHAT_MODEL = { lc: 1, type: 'not_implemented', id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'] };
const GRAPH = { lc: 1, type: 'not_implemented', id: ['langgraph', 'CompiledStateGraph'], name: 'LangGraph' };

function startGraph(core, runId, threadId) {
  core.handleChainStart(GRAPH, { messages: [CANARY_PROMPT] }, runId, undefined, [], { thread_id: threadId }, undefined, 'LangGraph');
}

function startNode(core, runId, parentRunId, threadId, node) {
  core.handleChainStart(
    { lc: 1, type: 'not_implemented', id: ['langgraph', 'RunnableCallable'] },
    { messages: [CANARY_PROMPT] },
    runId,
    parentRunId,
    ['graph:step:1'],
    nodeMeta(threadId, node),
    undefined,
    node,
  );
}

function modelCall(core, runId, parentRunId, threadId, node, usageMetadata, model) {
  core.handleChatModelStart(CHAT_MODEL, [[{ content: CANARY_PROMPT }]], runId, parentRunId, { invocation_params: { model } }, [], modelMeta(threadId, node, model), 'ChatOpenAI');
  core.handleLLMEnd(
    {
      generations: [[{ text: CANARY_COMPLETION, message: { content: CANARY_COMPLETION, usage_metadata: usageMetadata } }]],
      llmOutput: {},
    },
    runId,
    parentRunId,
  );
}

function assertPrivate(events) {
  const serialized = JSON.stringify(events);
  for (const canary of [CANARY_PROMPT, CANARY_COMPLETION, CANARY_TOOL_INPUT, CANARY_TOOL_OUTPUT, CANARY_ERROR, CANARY_METADATA]) {
    assert.ok(!serialized.includes(canary), `${canary} leaked into an event`);
  }
  for (const key of ['user_secret', 'langgraph_checkpoint_ns', 'langgraph_triggers', 'langgraph_step', 'ls_temperature']) {
    assert.ok(!serialized.includes(key), `metadata key ${key} leaked into an event`);
  }
}

test('LangGraph adapter: normal run with full token usage', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const thread = 'lg-thread-full';
    const { core, errors } = createCore(baseUrl);
    startGraph(core, 'run-graph', thread);
    startNode(core, 'run-node-agent', 'run-graph', thread, 'agent');
    modelCall(core, 'run-llm-1', 'run-node-agent', thread, 'agent', {
      input_tokens: 120,
      output_tokens: 40,
      total_tokens: 160,
      input_token_details: { cache_read: 20, cache_creation: 10 },
      output_token_details: { reasoning: 5 },
    }, 'gpt-4o-mini');
    core.handleChainEnd({ messages: [CANARY_COMPLETION] }, 'run-node-agent', 'run-graph');
    core.handleChainEnd({ messages: [CANARY_COMPLETION] }, 'run-graph');
    await core.flush();

    assert.deepEqual(errors, []);
    const events = await eventsFor(baseUrl, thread);
    const registered = byId(events, `lg:${RUNTIME}:run-node-agent:agent.registered`);
    assert.equal(registered.payload.name, 'agent');
    assert.equal(byId(events, `lg:${RUNTIME}:run-node-agent:node.started`).payload.status, 'THINKING');
    assert.equal(byId(events, `lg:${RUNTIME}:run-node-agent:node.completed`).payload.status, 'DONE');

    const usage = byId(events, `lg:${RUNTIME}:run-llm-1:llm.usage`);
    assert.equal(usage.agentId, 'agent');
    assert.equal(usage.runtimeId, RUNTIME);
    assert.equal(usage.payload.provider, 'openai');
    assert.equal(usage.payload.model, 'gpt-4o-mini');
    assert.equal(usage.payload.inputTokens, 120);
    assert.equal(usage.payload.outputTokens, 40);
    assert.equal(usage.payload.cacheReadTokens, 20);
    assert.equal(usage.payload.cacheWriteTokens, 10);
    assert.equal(usage.payload.reasoningTokens, 5);
    assert.equal(usage.payload.latencyMs, 10);
    assert.equal(usage.payload.costSource, 'unknown');
    assert.equal(usage.payload.cost ?? null, null);

    // The graph run itself is not a node: no status event for it.
    assert.equal(events.filter((e) => e.id.includes(':run-graph:')).length, 0);
    assertPrivate(events);
    assert.deepEqual(core.stats(), { sent: 4, failed: 0, dropped: 0, callsWithoutUsage: 0 });
  } finally {
    server.close();
  }
});

test('LangGraph adapter: partially reported tokens stay absent, never 0', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const thread = 'lg-thread-partial';
    const { core, errors } = createCore(baseUrl, { reportedCost: () => ({ cost: 0.0042, currency: 'USD' }) });
    startNode(core, 'run-node-p', undefined, thread, 'agent');
    modelCall(core, 'run-llm-p1', 'run-node-p', thread, 'agent', { input_tokens: 50, output_tokens: 7, total_tokens: 57 }, 'gpt-4o');
    // Only the input count: llm.usage needs both, so nothing is sent and the call is counted.
    modelCall(core, 'run-llm-p2', 'run-node-p', thread, 'agent', { input_tokens: 50 }, 'gpt-4o');
    // No usage at all.
    core.handleChatModelStart(CHAT_MODEL, [[]], 'run-llm-p3', 'run-node-p', {}, [], modelMeta(thread, 'agent'), 'ChatOpenAI');
    core.handleLLMEnd({ generations: [[{ text: CANARY_COMPLETION }]] }, 'run-llm-p3', 'run-node-p');
    core.handleChainEnd({}, 'run-node-p');
    await core.flush();

    assert.deepEqual(errors, []);
    const events = await eventsFor(baseUrl, thread);
    const usage = byId(events, `lg:${RUNTIME}:run-llm-p1:llm.usage`);
    assert.equal(usage.payload.inputTokens, 50);
    assert.equal(usage.payload.outputTokens, 7);
    for (const field of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      assert.equal(usage.payload[field] ?? null, null, `${field} must stay unreported`);
    }
    assert.equal(usage.payload.cost, 0.0042);
    assert.equal(usage.payload.currency, 'USD');
    assert.equal(usage.payload.costSource, 'provider-reported');
    assert.equal(events.filter((e) => e.type === 'llm.usage').length, 1);
    assert.equal(core.stats().callsWithoutUsage, 2);
    assertPrivate(events);
  } finally {
    server.close();
  }
});

test('LangGraph adapter: model failure becomes llm.failed without the error message', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const thread = 'lg-thread-failed';
    const { core, errors } = createCore(baseUrl);
    startNode(core, 'run-node-f', undefined, thread, 'agent');
    core.handleChatModelStart(CHAT_MODEL, [[{ content: CANARY_PROMPT }]], 'run-llm-f', 'run-node-f', {}, [], modelMeta(thread, 'agent'), 'ChatOpenAI');
    const error = Object.assign(new Error(CANARY_ERROR), { name: 'RateLimitError', status: 429 });
    core.handleLLMError(error, 'run-llm-f', 'run-node-f');
    core.handleChainError(new Error(CANARY_ERROR), 'run-node-f');
    await core.flush();

    assert.deepEqual(errors, []);
    const events = await eventsFor(baseUrl, thread);
    const failed = byId(events, `lg:${RUNTIME}:run-llm-f:llm.failed`);
    assert.equal(failed.agentId, 'agent');
    assert.equal(failed.severity, 'high');
    assert.equal(failed.payload.provider, 'openai');
    assert.equal(failed.payload.model, 'gpt-4o-mini');
    assert.equal(failed.payload.errorKind, 'rate_limited');
    assert.equal(failed.payload.httpStatus, 429);
    assert.equal(events.filter((e) => e.type === 'llm.usage').length, 0);
    assert.equal(byId(events, `lg:${RUNTIME}:run-node-f:node.failed`).payload.status, 'BLOCKED');
    assertPrivate(events);
  } finally {
    server.close();
  }
});

test('LangGraph adapter: successful and failed tool calls carry their toolCallId', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const thread = 'lg-thread-tools';
    const { core, errors } = createCore(baseUrl);
    startNode(core, 'run-node-tools', undefined, thread, 'tools');
    core.handleToolStart({ name: 'search' }, JSON.stringify({ q: CANARY_TOOL_INPUT }), 'run-tool-ok', 'run-node-tools', [], nodeMeta(thread, 'tools'), 'search', 'call_ok_1');
    core.handleToolEnd({ content: CANARY_TOOL_OUTPUT, tool_call_id: 'call_ok_1' }, 'run-tool-ok', 'run-node-tools');
    core.handleToolStart({ name: 'calculator' }, CANARY_TOOL_INPUT, 'run-tool-bad', 'run-node-tools', [], nodeMeta(thread, 'tools'), 'calculator', 'call_bad_1');
    core.handleToolError(Object.assign(new TypeError(CANARY_ERROR)), 'run-tool-bad', 'run-node-tools');
    core.handleChainEnd({}, 'run-node-tools');
    await core.flush();

    assert.deepEqual(errors, []);
    const events = await eventsFor(baseUrl, thread);
    const started = byId(events, `lg:${RUNTIME}:run-tool-ok:tool.started`);
    const completed = byId(events, `lg:${RUNTIME}:run-tool-ok:tool.completed`);
    assert.equal(started.agentId, 'tools');
    assert.equal(started.payload.tool, 'search');
    assert.equal(started.payload.toolCallId, 'call_ok_1');
    assert.equal(completed.payload.toolCallId, 'call_ok_1');
    // Fixed clock: start tracked at T, tool.started stamped at T+10, end read at T+20.
    assert.equal(completed.payload.durationMs, 20);
    assert.equal(started.payload.inputSummary ?? null, null);
    assert.equal(completed.payload.outputSummary ?? null, null);

    byId(events, `lg:${RUNTIME}:run-tool-bad:tool.started`);
    const failed = byId(events, `lg:${RUNTIME}:run-tool-bad:tool.failed`);
    assert.equal(failed.agentId, 'tools');
    assert.equal(failed.severity, 'high');
    assert.equal(failed.payload.tool, 'calculator');
    assert.equal(failed.payload.toolCallId, 'call_bad_1');
    assert.equal(failed.payload.error, 'TypeError');
    assertPrivate(events);
  } finally {
    server.close();
  }
});

test('LangGraph adapter: tool summaries are opt-in and come only from the host function', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const thread = 'lg-thread-tool-summary';
    const { core } = createCore(baseUrl, {
      toolInputSummary: (tool, input) => `${tool} input of ${input.length} chars`,
      toolOutputSummary: (tool) => `${tool} returned`,
    });
    startNode(core, 'run-node-s', undefined, thread, 'tools');
    core.handleToolStart({ name: 'search' }, CANARY_TOOL_INPUT, 'run-tool-s', 'run-node-s', [], nodeMeta(thread, 'tools'), 'search', 'call_s');
    core.handleToolEnd(CANARY_TOOL_OUTPUT, 'run-tool-s', 'run-node-s');
    core.handleChainEnd({}, 'run-node-s');
    await core.flush();

    const events = await eventsFor(baseUrl, thread);
    assert.equal(byId(events, `lg:${RUNTIME}:run-tool-s:tool.started`).payload.inputSummary, `search input of ${CANARY_TOOL_INPUT.length} chars`);
    assert.equal(byId(events, `lg:${RUNTIME}:run-tool-s:tool.completed`).payload.outputSummary, 'search returned');
    assertPrivate(events);
  } finally {
    server.close();
  }
});

test('LangGraph adapter: interleaved parallel branches are attributed by their own parent chain', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const thread = 'lg-thread-parallel';
    const { core, errors } = createCore(baseUrl);
    startGraph(core, 'run-graph-par', thread);
    // Fan-out in one step: both nodes start before either model call, and end in the opposite order.
    startNode(core, 'run-node-research', 'run-graph-par', thread, 'research');
    startNode(core, 'run-node-write', 'run-graph-par', thread, 'write');
    // A `Send` map-reduce: the same node twice in one step, as two distinct runs.
    startNode(core, 'run-node-worker-a', 'run-graph-par', thread, 'worker');
    startNode(core, 'run-node-worker-b', 'run-graph-par', thread, 'worker');
    // An intermediate runnable inside `research` (same langgraph_node metadata, different name).
    core.handleChainStart({ id: ['langchain', 'RunnableSequence'] }, {}, 'run-seq-research', 'run-node-research', [], nodeMeta(thread, 'research'), undefined, 'RunnableSequence');
    modelCall(core, 'run-llm-write', 'run-node-write', thread, 'write', { input_tokens: 20, output_tokens: 2 });
    modelCall(core, 'run-llm-research', 'run-seq-research', thread, 'research', { input_tokens: 10, output_tokens: 1 });
    modelCall(core, 'run-llm-worker-b', 'run-node-worker-b', thread, 'worker', { input_tokens: 31, output_tokens: 3 });
    modelCall(core, 'run-llm-worker-a', 'run-node-worker-a', thread, 'worker', { input_tokens: 30, output_tokens: 3 });
    core.handleChainEnd({}, 'run-seq-research', 'run-node-research');
    core.handleChainEnd({}, 'run-node-worker-b', 'run-graph-par');
    core.handleChainEnd({}, 'run-node-write', 'run-graph-par');
    core.handleChainEnd({}, 'run-node-research', 'run-graph-par');
    core.handleChainEnd({}, 'run-node-worker-a', 'run-graph-par');
    core.handleChainEnd({}, 'run-graph-par');
    await core.flush();

    assert.deepEqual(errors, []);
    const events = await eventsFor(baseUrl, thread);
    const research = byId(events, `lg:${RUNTIME}:run-llm-research:llm.usage`);
    const write = byId(events, `lg:${RUNTIME}:run-llm-write:llm.usage`);
    assert.equal(research.agentId, 'research');
    assert.equal(research.payload.inputTokens, 10);
    assert.equal(write.agentId, 'write');
    assert.equal(write.payload.inputTokens, 20);

    const workerA = byId(events, `lg:${RUNTIME}:run-llm-worker-a:llm.usage`);
    const workerB = byId(events, `lg:${RUNTIME}:run-llm-worker-b:llm.usage`);
    assert.notEqual(workerA.id, workerB.id);
    assert.equal(workerA.agentId, 'worker');
    assert.equal(workerB.agentId, 'worker');
    assert.equal(workerA.payload.inputTokens, 30);
    assert.equal(workerB.payload.inputTokens, 31);
    byId(events, `lg:${RUNTIME}:run-node-worker-a:node.started`);
    byId(events, `lg:${RUNTIME}:run-node-worker-b:node.started`);
    // The intermediate runnable is not a node.
    assert.equal(events.filter((e) => e.id.includes(':run-seq-research:')).length, 0);
    assert.equal(events.filter((e) => e.type === 'llm.usage').length, 4);
    assertPrivate(events);
  } finally {
    server.close();
  }
});

test('LangGraph adapter: a model call inside a subgraph is attributed to the inner node', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const thread = 'lg-thread-subgraph';
    const { core, errors } = createCore(baseUrl, {
      agentForNode: (node) => (node === 'planner' ? { id: 'planner-agent', name: 'Planner', roleTitle: 'Planner' } : node),
    });
    startGraph(core, 'run-graph-outer', thread);
    startNode(core, 'run-node-planner', 'run-graph-outer', thread, 'planner');
    // The compiled subgraph runs inside the outer node and inherits its langgraph_node metadata.
    core.handleChainStart(GRAPH, {}, 'run-graph-inner', 'run-node-planner', [], nodeMeta(thread, 'planner'), undefined, 'LangGraph');
    startNode(core, 'run-node-draft', 'run-graph-inner', thread, 'draft');
    modelCall(core, 'run-llm-draft', 'run-node-draft', thread, 'draft', { input_tokens: 64, output_tokens: 16 });
    core.handleChainEnd({}, 'run-node-draft', 'run-graph-inner');
    core.handleChainEnd({}, 'run-graph-inner', 'run-node-planner');
    core.handleChainEnd({}, 'run-node-planner', 'run-graph-outer');
    core.handleChainEnd({}, 'run-graph-outer');
    await core.flush();

    assert.deepEqual(errors, []);
    const events = await eventsFor(baseUrl, thread);
    const usage = byId(events, `lg:${RUNTIME}:run-llm-draft:llm.usage`);
    assert.equal(usage.agentId, 'draft');
    assert.equal(usage.payload.inputTokens, 64);
    const planner = byId(events, `lg:${RUNTIME}:run-node-planner:agent.registered`);
    assert.equal(planner.agentId, 'planner-agent');
    assert.equal(planner.payload.name, 'Planner');
    assert.equal(byId(events, `lg:${RUNTIME}:run-node-planner:node.started`).agentId, 'planner-agent');
    assert.equal(byId(events, `lg:${RUNTIME}:run-node-draft:node.started`).agentId, 'draft');
    assert.equal(events.filter((e) => e.id.includes(':run-graph-inner:')).length, 0);
    assertPrivate(events);
  } finally {
    server.close();
  }
});

test('LangGraph adapter: replayed callbacks and a same-named nested run do not count twice', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const thread = 'lg-thread-replay';
    const { core, errors } = createCore(baseUrl);
    startNode(core, 'run-node-r', undefined, thread, 'agent');
    startNode(core, 'run-node-r', undefined, thread, 'agent');
    // A runnable inside the node that carries the node's own name is still that node, not a second one.
    startNode(core, 'run-node-r-inner', 'run-node-r', thread, 'agent');
    modelCall(core, 'run-llm-r', 'run-node-r-inner', thread, 'agent', { input_tokens: 5, output_tokens: 1 });
    core.handleLLMEnd({ generations: [[{ message: { usage_metadata: { input_tokens: 5, output_tokens: 1 } } }]] }, 'run-llm-r');
    core.handleChainEnd({}, 'run-node-r-inner', 'run-node-r');
    core.handleChainEnd({}, 'run-node-r');
    core.handleChainEnd({}, 'run-node-r');
    await core.flush();

    assert.deepEqual(errors, []);
    const events = await eventsFor(baseUrl, thread);
    assert.equal(events.filter((e) => e.type === 'llm.usage').length, 1);
    assert.equal(events.filter((e) => e.type === 'agent.status.changed').length, 2);
    assert.equal(byId(events, `lg:${RUNTIME}:run-llm-r:llm.usage`).agentId, 'agent');
    assert.deepEqual(core.stats(), { sent: 4, failed: 0, dropped: 0, callsWithoutUsage: 0 });
  } finally {
    server.close();
  }
});

test('LangGraph adapter: a full queue drops and counts events, an unreachable server counts failures', async () => {
  const dropped = [];
  const core = new AgentViewerLangGraphCore({
    // Port 9 (discard) on loopback: nothing listens, so the request fails fast without leaving the host.
    viewer: new AgentViewer({ url: 'http://127.0.0.1:9', runtimeId: RUNTIME, maxRetries: 0, timeoutMs: 2000 }),
    maxQueue: 2,
    now: fixedClock(),
    onError: (error, event) => dropped.push(event?.id),
  });
  startNode(core, 'run-node-q', undefined, 'lg-thread-queue', 'agent');
  modelCall(core, 'run-llm-q', 'run-node-q', 'lg-thread-queue', 'agent', { input_tokens: 1, output_tokens: 1 });
  // agent.registered and node.started are queued synchronously; llm.usage overflows the queue of 2.
  assert.equal(core.stats().dropped, 1);
  assert.ok(dropped.includes(`lg:${RUNTIME}:run-llm-q:llm.usage`));
  await core.flush();
  const stats = core.stats();
  assert.equal(stats.failed, 2);
  assert.equal(stats.sent, 0);
});

let langgraph;
let langchainMessages;
let langchainChatModels;
let langchainTools;
try {
  langgraph = await import('@langchain/langgraph');
  langchainMessages = await import('@langchain/core/messages');
  langchainChatModels = await import('@langchain/core/language_models/chat_models');
  langchainTools = await import('@langchain/core/tools');
} catch {
  langgraph = undefined;
}

test(
  'LangGraph adapter: the real handler captures a real StateGraph through @langchain/core callbacks',
  { skip: langgraph ? false : '@langchain/langgraph is not installed (devDependency of packages/langgraph)' },
  async () => {
    const { AgentViewerCallbackHandler } = await import('../packages/langgraph/src/index.ts');
    const { StateGraph, Annotation, START, END } = langgraph;
    const { AIMessage } = langchainMessages;
    const { BaseChatModel } = langchainChatModels;
    const { tool } = langchainTools;
    const { z } = await import('zod');

    class UsageChatModel extends BaseChatModel {
      _llmType() {
        return 'usage-fake';
      }
      async _generate() {
        const message = new AIMessage({
          content: CANARY_COMPLETION,
          usage_metadata: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        });
        return { generations: [{ text: CANARY_COMPLETION, message }] };
      }
    }

    const lookup = tool(async () => CANARY_TOOL_OUTPUT, {
      name: 'lookup',
      description: 'Looks something up',
      schema: z.object({ q: z.string() }),
    });

    const { server, baseUrl } = await startTestServer();
    try {
      const handler = new AgentViewerCallbackHandler({ url: baseUrl, runtimeId: 'lg-real' });
      assert.equal(handler.awaitHandlers, true);
      const State = Annotation.Root({ n: Annotation({ reducer: (a, b) => a + b, default: () => 0 }) });
      const model = new UsageChatModel({});
      const graph = new StateGraph(State)
        .addNode('agent', async (_state, config) => {
          await model.invoke(CANARY_PROMPT, config);
          await lookup.invoke({ q: CANARY_TOOL_INPUT }, config);
          return { n: 1 };
        })
        .addEdge(START, 'agent')
        .addEdge('agent', END)
        .compile();

      await graph.invoke({ n: 0 }, { callbacks: [handler], configurable: { thread_id: 'lg-thread-real' } });
      await handler.flush();

      const events = await eventsFor(baseUrl, 'lg-thread-real');
      const usage = events.filter((e) => e.type === 'llm.usage');
      assert.equal(usage.length, 1);
      assert.equal(usage[0].agentId, 'agent');
      assert.equal(usage[0].payload.inputTokens, 3);
      assert.equal(usage[0].payload.outputTokens, 2);
      assert.ok(usage[0].id.startsWith('lg:lg-real:'));
      const toolStarted = events.filter((e) => e.type === 'tool.started');
      assert.equal(toolStarted.length, 1);
      assert.equal(toolStarted[0].agentId, 'agent');
      assert.equal(toolStarted[0].payload.tool, 'lookup');
      assert.equal(events.filter((e) => e.type === 'agent.status.changed' && e.agentId === 'agent').length, 2);
      assertPrivate(events);
      assert.equal(handler.stats().failed, 0);
    } finally {
      server.close();
    }
  },
);
