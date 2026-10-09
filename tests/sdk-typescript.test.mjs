import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../server/index.ts';
import { AgentViewer } from '../sdk/typescript/index.ts';

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

test('TypeScript SDK: completes the exact 5-minute developer experience workflow', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const viewer = new AgentViewer({
      url: baseUrl,
      runtimeId: 'sdk-test-runtime',
      sessionId: 'session-sdk-01',
    });

    const agent = viewer.agent({
      id: 'researcher',
      name: 'Research Agent',
    });

    // 1. Thinking
    await agent.thinking('Analyzing documentation');

    // 2. Tool started and completed
    await agent.toolStarted('web.search');
    await agent.toolCompleted('web.search', 'found 5 results');

    // 3. Message
    await agent.message('I found the information.');

    // 4. Usage, with the cost source and currency stated, linked to a task created first
    await agent.usage({
      provider: 'Google',
      model: 'gemini-3.1-pro',
      inputTokens: 4500,
      outputTokens: 900,
      cost: 0.012,
      costSource: 'provider-reported',
      currency: 'USD',
    });
    await viewer.emit({
      type: 'task.created',
      agentId: 'researcher',
      taskId: 'task_ts_42',
      summary: 'Integration task',
      payload: { id: 'task_ts_42', title: 'Integration task' },
    });
    await agent.usage({
      provider: 'Anthropic',
      model: 'claude-sonnet-4-5',
      inputTokens: 1800,
      outputTokens: 450,
      cacheReadTokens: 1200,
      cacheWriteTokens: 300,
      reasoningTokens: 0,
      latencyMs: 900,
      cost: 0.012,
      costSource: 'estimated',
      currency: 'USD',
      requestId: 'req_ts_01',
      taskId: 'task_ts_42',
    });

    // 5. Done
    await agent.done();

    // Verify through snapshot
    const snapshot = await viewer.snapshot();
    assert.equal(snapshot.schemaVersion, '1.0');
    assert.ok(snapshot.agents.some((a) => a.id === 'researcher'));
    const researcher = snapshot.agents.find((a) => a.id === 'researcher');
    assert.equal(researcher?.tokensInput, 4500 + 1800);
    assert.equal(researcher?.tokensOutput, 900 + 450);

    // Verify the stored events keep what the SDK sent
    const listed = await fetch(`${baseUrl}/api/v1/events?type=llm.usage&agentId=researcher&limit=50`).then((r) => r.json());
    const byModel = new Map(listed.events.map((e) => [e.payload.model, e]));
    const simple = byModel.get('gemini-3.1-pro');
    assert.equal(simple.payload.costSource, 'provider-reported');
    assert.equal(simple.payload.currency, 'USD');
    assert.equal(simple.payload.cost, 0.012);
    assert.equal('cachedTokens' in simple.payload, false);
    assert.equal('reasoningTokens' in simple.payload, false);

    const full = byModel.get('claude-sonnet-4-5');
    assert.equal(full.taskId, 'task_ts_42');
    assert.equal('taskId' in full.payload, false);
    assert.equal('cachedTokens' in full.payload, false);
    assert.deepEqual(
      {
        inputTokens: full.payload.inputTokens,
        outputTokens: full.payload.outputTokens,
        cacheReadTokens: full.payload.cacheReadTokens,
        cacheWriteTokens: full.payload.cacheWriteTokens,
        reasoningTokens: full.payload.reasoningTokens,
        latencyMs: full.payload.latencyMs,
        cost: full.payload.cost,
        costSource: full.payload.costSource,
        currency: full.payload.currency,
        requestId: full.payload.requestId,
      },
      {
        inputTokens: 1800,
        outputTokens: 450,
        cacheReadTokens: 1200,
        cacheWriteTokens: 300,
        reasoningTokens: 0,
        latencyMs: 900,
        cost: 0.012,
        costSource: 'estimated',
        currency: 'USD',
        requestId: 'req_ts_01',
      },
    );
  } finally {
    server.close();
  }
});

// -------------------------------------------------------------
// usage() unit tests with a stubbed fetch (no server)
// -------------------------------------------------------------

const WARNING_PREFIX = '[AgentViewer] a cost was reported without costSource';

/** Replaces globalThis.fetch for one test and records every request body it receives. */
function stubFetch(t) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ accepted: true, duplicate: false }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  });
  const usageEvents = () => requests.map((r) => r.body).filter((e) => e.type === 'llm.usage');
  return { requests, usageEvents };
}

function unstatedWarnings(warn) {
  return warn.mock.calls.filter((call) => String(call.arguments[0]).startsWith(WARNING_PREFIX));
}

const base = { provider: 'OpenAI', model: 'gpt-4o', inputTokens: 10, outputTokens: 5 };

test('TypeScript SDK usage: omitted or null token fields are left out and 0 is kept', async (t) => {
  const { usageEvents } = stubFetch(t);
  t.mock.method(console, 'warn', () => {});
  const agent = new AgentViewer({ url: 'http://sdk.test' }).agent('coder');

  await agent.usage({ ...base });
  await agent.usage({
    ...base,
    cachedTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    currency: null,
    cost: null,
    costSource: null,
  });
  await agent.usage({ ...base, cachedTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

  const [omitted, nulls, zeros] = usageEvents().map((e) => e.payload);
  for (const payload of [omitted, nulls]) {
    assert.deepEqual(payload, { ...base, cost: null, costSource: 'unknown' });
  }
  assert.equal(zeros.cachedTokens, 0);
  assert.equal(zeros.reasoningTokens, 0);
  assert.equal(zeros.cacheReadTokens, 0);
  assert.equal(zeros.cacheWriteTokens, 0);
});

test('TypeScript SDK usage: a stated costSource is forwarded with no warning', async (t) => {
  const { usageEvents } = stubFetch(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const agent = new AgentViewer({ url: 'http://sdk.test' }).agent('coder');

  for (const costSource of ['provider-reported', 'estimated', 'unknown']) {
    await agent.usage({ ...base, cost: 0.02, costSource });
  }

  assert.deepEqual(usageEvents().map((e) => e.payload.costSource), ['provider-reported', 'estimated', 'unknown']);
  assert.deepEqual(usageEvents().map((e) => e.payload.cost), [0.02, 0.02, 0.02]);
  assert.equal(warn.mock.callCount(), 0);
});

test('TypeScript SDK usage: a bare cost is sent as unknown and warns once per client', async (t) => {
  const { usageEvents } = stubFetch(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const viewer = new AgentViewer({ url: 'http://sdk.test' });

  await viewer.agent('a').usage({ ...base, cost: 0.01 });
  await viewer.agent('b').usage({ ...base, cost: 0 });
  await viewer.agent('a').usage({ ...base, cost: 0.03, costSource: null });

  assert.deepEqual(usageEvents().map((e) => e.payload.costSource), ['unknown', 'unknown', 'unknown']);
  assert.deepEqual(usageEvents().map((e) => e.payload.cost), [0.01, 0, 0.03]);
  assert.equal(unstatedWarnings(warn).length, 1);
  assert.equal(warn.mock.callCount(), 1);

  // A second client warns again.
  const other = new AgentViewer({ url: 'http://sdk.test' });
  await other.agent('a').usage({ ...base, cost: 0 });
  assert.equal(unstatedWarnings(warn).length, 2);
  assert.equal(usageEvents().at(-1).payload.cost, 0);

  // No cost means no warning.
  const quiet = new AgentViewer({ url: 'http://sdk.test' });
  await quiet.agent('a').usage({ ...base });
  await quiet.agent('a').usage({ ...base, cost: null });
  await quiet.agent('a').usage({ ...base, cost: null, costSource: 'provider-reported' });
  assert.equal(unstatedWarnings(warn).length, 2);
  assert.equal(usageEvents().at(-1).payload.costSource, 'provider-reported');
  assert.equal(usageEvents().at(-1).payload.cost, null);
});

test('TypeScript SDK usage: an invalid costSource rejects with TypeError before any request', async (t) => {
  const { requests } = stubFetch(t);
  t.mock.method(console, 'warn', () => {});
  const agent = new AgentViewer({ url: 'http://sdk.test' }).agent('coder');

  await assert.rejects(
    agent.usage({ ...base, cost: 0.01, costSource: /** @type {any} */ ('provider') }),
    (err) => err instanceof TypeError
      && err.message === 'costSource must be one of provider-reported, estimated, unknown (got "provider")',
  );
  await assert.rejects(agent.usage({ ...base, costSource: /** @type {any} */ ('') }), TypeError);
  assert.equal(requests.length, 0);
});

test('TypeScript SDK usage: new fields go to the payload and taskId to the envelope', async (t) => {
  const { usageEvents } = stubFetch(t);
  t.mock.method(console, 'warn', () => {});
  const agent = new AgentViewer({ url: 'http://sdk.test' }).agent('builder');

  await agent.usage({
    provider: 'Anthropic',
    model: 'claude-sonnet-4-5',
    inputTokens: 1800,
    outputTokens: 450,
    cost: 0.012,
    costSource: 'provider-reported',
    cacheReadTokens: 1200,
    cacheWriteTokens: 300,
    currency: 'USD',
    requestId: 'req_01',
    taskId: 'task_42',
  });
  await agent.usage({ ...base, cost: 0.001, costSource: 'estimated', currency: null });
  await agent.usage({ ...base, currency: 'usd' });

  const [stated, nullCurrency, rawCurrency] = usageEvents();
  assert.equal(stated.taskId, 'task_42');
  assert.equal(stated.agentId, 'builder');
  assert.deepEqual(stated.payload, {
    provider: 'Anthropic',
    model: 'claude-sonnet-4-5',
    inputTokens: 1800,
    outputTokens: 450,
    cacheReadTokens: 1200,
    cacheWriteTokens: 300,
    cost: 0.012,
    costSource: 'provider-reported',
    currency: 'USD',
    requestId: 'req_01',
  });
  assert.equal('taskId' in nullCurrency, false);
  assert.equal('currency' in nullCurrency.payload, false);
  // Currency is forwarded as given; the server checks the format.
  assert.equal(rawCurrency.payload.currency, 'usd');
});
