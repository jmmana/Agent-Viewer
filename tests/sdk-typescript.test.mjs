import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app } from '../server/index.ts';
import { AgentViewer, AgentViewerError } from '../sdk/typescript/index.ts';

const vectorsPath = fileURLToPath(new URL('./fixtures/usage-correlation-vectors.json', import.meta.url));
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));

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

    // Usage aggregates, call by call
    const summary = await viewer.usageSummary();
    assert.equal(summary.schemaVersion, '1.0');
    const gemini = summary.byModel.find((entry) => entry.provider === 'Google' && entry.model === 'gemini-3.1-pro');
    assert.ok(gemini, 'Expected a byModel entry for Google gemini-3.1-pro');
    assert.equal(gemini.calls, 1);
    assert.equal(gemini.tokens.input.sum, 4500);
    const researcherUsage = summary.byAgent.find((entry) => entry.agentId === 'researcher');
    assert.equal(researcherUsage?.calls, 2);
    assert.deepEqual(summary, snapshot.usage);
  } finally {
    server.close();
  }
});

test('TypeScript SDK: usageSummary() raises AgentViewerError when the server refuses the request', async () => {
  const previous = process.env.AGENT_VIEWER_API_TOKEN;
  process.env.AGENT_VIEWER_API_TOKEN = 'sdk-usage-token';
  const { server, baseUrl } = await startTestServer();
  try {
    const viewer = new AgentViewer({ url: baseUrl });
    await assert.rejects(viewer.usageSummary(), (err) => err instanceof AgentViewerError && err.status === 401);
    const authorized = new AgentViewer({ url: baseUrl, token: 'sdk-usage-token' });
    assert.equal((await authorized.usageSummary()).schemaVersion, '1.0');
  } finally {
    if (previous === undefined) delete process.env.AGENT_VIEWER_API_TOKEN;
    else process.env.AGENT_VIEWER_API_TOKEN = previous;
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

// -------------------------------------------------------------
// Ingestion integrity (issue #47)
// -------------------------------------------------------------

// -------------------------------------------------------------
// Usage correlation block (issue #64)
// -------------------------------------------------------------

test('TypeScript SDK usage: correlation fields are forwarded when defined, omitted otherwise', async (t) => {
  const { usageEvents } = stubFetch(t);
  t.mock.method(console, 'warn', () => {});
  const agent = new AgentViewer({ url: 'http://sdk.test' }).agent('coder');

  await agent.usage({
    ...base,
    traceId: 'trace_1',
    parentId: 'span_1',
    toolCallId: 'call_1',
    meetingId: 'meeting_1',
    userId: 'usr_1',
    tags: ['env:prod', 'env:prod', 'feature:x'],
  });
  await agent.usage({ ...base });

  const [withCorrelation, without] = usageEvents().map((e) => e.payload);
  assert.equal(withCorrelation.traceId, 'trace_1');
  assert.equal(withCorrelation.parentId, 'span_1');
  assert.equal(withCorrelation.toolCallId, 'call_1');
  assert.equal(withCorrelation.meetingId, 'meeting_1');
  assert.equal(withCorrelation.userId, 'usr_1');
  // The SDK never deduplicates locally: that is the server's job. It sends exactly what it was given.
  assert.deepEqual(withCorrelation.tags, ['env:prod', 'env:prod', 'feature:x']);
  for (const field of [...vectors.idFields, 'tags']) {
    assert.equal(field in without, false, `${field} should not be sent as undefined or null`);
  }
});

function bodiesOf(requests, type) {
  return requests.map((r) => r.body).filter((body) => body.type === type);
}

test('TypeScript SDK usage: toolStarted, toolCompleted and toolFailed forward toolCallId when given', async (t) => {
  const { requests } = stubFetch(t);
  const agent = new AgentViewer({ url: 'http://sdk.test' }).agent('coder');

  await agent.toolStarted('git.commit', 'committing', { toolCallId: 'call_started' });
  await agent.toolCompleted('git.commit', 'done', { toolCallId: 'call_completed' });
  await agent.toolFailed('git.commit', 'failed', { toolCallId: 'call_failed' });
  await agent.toolStarted('git.push');

  const [started, secondStarted] = bodiesOf(requests, 'tool.started');
  const [completed] = bodiesOf(requests, 'tool.completed');
  const [failed] = bodiesOf(requests, 'tool.failed');
  assert.equal(started.payload.toolCallId, 'call_started');
  assert.equal(completed.payload.toolCallId, 'call_completed');
  assert.equal(failed.payload.toolCallId, 'call_failed');
  assert.equal('toolCallId' in secondStarted.payload, false);
});

test('TypeScript SDK usage: an invalid correlation id rejects locally with AgentViewerError before any request', async (t) => {
  const { requests } = stubFetch(t);
  const agent = new AgentViewer({ url: 'http://sdk.test' }).agent('coder');

  for (const field of vectors.idFields) {
    for (const vector of vectors.idCases) {
      await (vector.valid
        ? agent.usage({ ...base, [field]: vector.value })
        : assert.rejects(
          agent.usage({ ...base, [field]: vector.value }),
          (err) => {
            assert.ok(err instanceof AgentViewerError, `${field} / ${vector.name}: expected AgentViewerError`);
            assert.ok(
              err.issues.some((issue) => issue.path === `payload.${field}`),
              `${field} / ${vector.name}: expected an issue at payload.${field}, got ${JSON.stringify(err.issues)}`,
            );
            return true;
          },
        ));
    }
  }
  assert.ok(requests.length > 0, 'valid cases should have sent a request');
});

test('TypeScript SDK usage: tags follow the shared tag vectors, with the same rejection shape', async (t) => {
  stubFetch(t);
  const agent = new AgentViewer({ url: 'http://sdk.test' }).agent('coder');

  for (const vector of vectors.tagCases) {
    if (vector.valid) {
      await agent.usage({ ...base, tags: vector.tags });
      continue;
    }
    await assert.rejects(
      agent.usage({ ...base, tags: vector.tags }),
      (err) => {
        assert.ok(err instanceof AgentViewerError, `${vector.name}: expected AgentViewerError`);
        const paths = err.issues.map((issue) => issue.path);
        for (const expectedPath of vector.expectedPaths) {
          assert.ok(paths.includes(expectedPath), `${vector.name}: expected ${expectedPath} in ${paths}`);
        }
        return true;
      },
    );
  }
});

test('TypeScript SDK: llmFailed() sends the failure payload with correlation fields, severity high', async (t) => {
  const { requests } = stubFetch(t);
  const agent = new AgentViewer({ url: 'http://sdk.test' }).agent('coder');

  await agent.llmFailed({
    provider: 'OpenAI',
    model: 'gpt-4.1',
    errorKind: 'rate_limited',
    httpStatus: 429,
    retryable: true,
    traceId: 'trace_failed',
    tags: ['env:prod'],
    taskId: 'task_1',
  });

  const [body] = bodiesOf(requests, 'llm.failed');
  assert.equal(body.type, 'llm.failed');
  assert.equal(body.severity, 'high');
  assert.equal(body.taskId, 'task_1');
  assert.equal('taskId' in body.payload, false);
  assert.equal(body.payload.provider, 'OpenAI');
  assert.equal(body.payload.model, 'gpt-4.1');
  assert.equal(body.payload.errorKind, 'rate_limited');
  assert.equal(body.payload.httpStatus, 429);
  assert.equal(body.payload.retryable, true);
  assert.equal(body.payload.traceId, 'trace_failed');
  assert.deepEqual(body.payload.tags, ['env:prod']);
});

test('TypeScript SDK: llmFailed() omits model when not given, and rejects an invalid correlation field', async (t) => {
  const { requests } = stubFetch(t);
  const agent = new AgentViewer({ url: 'http://sdk.test' }).agent('coder');

  await agent.llmFailed({ provider: 'OpenAI' });
  const [failed] = bodiesOf(requests, 'llm.failed');
  assert.equal('model' in failed.payload, false);
  assert.equal(failed.payload.errorKind, undefined);

  await assert.rejects(
    agent.llmFailed({ provider: 'OpenAI', traceId: '' }),
    (err) => err instanceof AgentViewerError && err.issues.some((issue) => issue.path === 'payload.traceId'),
  );
});

test('TypeScript SDK: default event ids are 128-bit random UUIDs', async (t) => {
  const { requests } = stubFetch(t);
  const viewer = new AgentViewer({ url: 'http://sdk.test' });
  await viewer.emit({ type: 'agent.status.changed', payload: { status: 'IDLE' } });
  await viewer.emit({ type: 'agent.status.changed', payload: { status: 'IDLE' } });
  await viewer.emitBatch([{ type: 'tool.started', payload: { tool: 'a' } }, { type: 'tool.started', payload: { tool: 'b' } }]);
  const ids = [requests[0].body.id, requests[1].body.id, ...requests[2].body.events.map(({ id }) => id)];
  for (const id of ids) {
    assert.match(id, /^evt_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(id.length, 40);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test('TypeScript SDK: a 409 conflicting_duplicate rejects with code and status after exactly one attempt', async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    attempts++;
    return new Response(
      JSON.stringify({
        error: 'conflicting_duplicate',
        message: 'An event with id "evt_x" was already stored with different content. The new event was not applied.',
        id: 'evt_x',
        fingerprint: 'sha256:b',
        storedFingerprint: 'sha256:a',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } }
    );
  });
  const viewer = new AgentViewer({ url: 'http://sdk.test', maxRetries: 3 });
  await assert.rejects(
    viewer.emit({ id: 'evt_x', type: 'agent.status.changed', payload: { status: 'IDLE' } }),
    (err) =>
      err instanceof AgentViewerError &&
      err.status === 409 &&
      err.code === 'conflicting_duplicate' &&
      err.message.includes('already stored with different content')
  );
  assert.equal(attempts, 1);
});

test('TypeScript SDK: emitBatch surfaces conflicts and per-item status from a live server', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const viewer = new AgentViewer({ url: baseUrl, runtimeId: 'sdk-integrity' });
    const a = { id: 'evt_sdk_ts_a', type: 'tool.started', timestamp: 1_700_000_000_000, agentId: 'ts', payload: { tool: 'grep' } };
    const first = await viewer.emitBatch([a, { ...a }, { ...a, payload: { tool: 'sed' } }, { ...a, id: 'evt_sdk_ts_b' }]);
    assert.equal(first.accepted, 2);
    assert.equal(first.duplicates, 1);
    assert.equal(first.conflicts, 1);
    assert.deepEqual(first.results.map(({ status }) => status), ['accepted', 'duplicate', 'conflict', 'accepted']);
    assert.equal(first.results[2].error, 'conflicting_duplicate');
    assert.equal(first.results[2].storedFingerprint, first.results[0].fingerprint);

    // A single emit of a conflicting event is a 409 for the caller.
    await assert.rejects(
      viewer.emit({ ...a, payload: { tool: 'awk' } }),
      (err) => err instanceof AgentViewerError && err.code === 'conflicting_duplicate' && err.status === 409
    );
  } finally {
    server.close();
  }
});

test('TypeScript SDK: emitBatch against a 0.2.x server reports conflicts as 0 and passes results through', async (t) => {
  const legacyResults = [{ id: 'evt_old', duplicate: false }];
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ accepted: 1, duplicates: 0, total: 1, results: legacyResults }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    })
  );
  const result = await new AgentViewer({ url: 'http://sdk.test' }).emitBatch([{ id: 'evt_old', type: 'tool.started', payload: { tool: 'x' } }]);
  assert.deepEqual(result, { accepted: 1, duplicates: 0, conflicts: 0, results: legacyResults });
});
