import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

test('REST API: /health and /ready endpoints', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.service, 'agent-viewer');
    assert.equal(healthJson.schemaVersion, '1.0');
    assert.ok(['open', 'token'].includes(healthJson.auth));
    assert.ok(['open', 'token', 'signature'].includes(healthJson.webhookAuth));

    const readyRes = await fetch(`${baseUrl}/ready`);
    assert.equal(readyRes.status, 200);
    const readyJson = await readyRes.json();
    // Memory storage has nothing to replay (issue #52): the rebuild is reported 'done' at once, with
    // zero events and zero duration.
    assert.deepEqual(readyJson, {
      ok: true,
      ready: true,
      storage: 'memory',
      ingestion: { conflicts: readyJson.ingestion.conflicts, legacyUnverifiedDuplicates: 0 },
      rebuild: {
        state: 'done',
        totalEvents: 0,
        processedEvents: 0,
        skippedEvents: 0,
        skippedEventIds: [],
        startedAt: readyJson.rebuild.startedAt,
        finishedAt: readyJson.rebuild.finishedAt,
        durationMs: 0,
      },
    });
    assert.equal(typeof readyJson.ingestion.conflicts, 'number');
    assert.equal(typeof readyJson.rebuild.startedAt, 'number');
    assert.equal(readyJson.rebuild.finishedAt, readyJson.rebuild.startedAt);
  } finally {
    server.close();
  }
});

test('REST API: /ready includes schema info only when SQLite is the active store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-ready-'));
  const file = path.join(dir, 'ready.db');
  const code = `
    import http from 'node:http';
    import { app } from './server/index.ts';
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', async () => {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/ready');
      console.log(JSON.stringify(await response.json()));
      server.close();
    });
  `;
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, AGENT_VIEWER_STORAGE: 'sqlite', AGENT_VIEWER_SQLITE_PATH: file, AGENT_VIEWER_SQLITE_BACKUP: 'off' },
    });
    assert.equal(result.status, 0, result.stderr);
    const ready = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(ready.ok, true);
    assert.equal(ready.storage, 'sqlite');
    assert.deepEqual(ready.database, {
      schemaVersion: 5,
      latestKnownSchemaVersion: 5,
      appliedAt: ready.database.appliedAt,
    });
    assert.equal(typeof ready.database.appliedAt, 'number');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REST API: /ready returns 503 when schema info cannot be read', async () => {
  const original = store.getSchemaInfo;
  store.getSchemaInfo = () => {
    throw new Error('schema metadata unavailable');
  };
  const { server, baseUrl } = await startTestServer();
  try {
    const response = await fetch(`${baseUrl}/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      ok: false,
      ready: false,
      error: 'schema metadata unavailable',
    });
  } finally {
    server.close();
    if (original === undefined) delete store.getSchemaInfo;
    else store.getSchemaInfo = original;
  }
});

test('REST API: POST /api/v1/events single event and idempotency', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const event = {
      schemaVersion: '1.0',
      id: 'evt_api_test_1',
      type: 'agent.status.changed',
      timestamp: Date.now(),
      runtimeId: 'rt_test',
      sessionId: 'ses_test',
      source: 'agent:alice',
      agentId: 'alice',
      summary: 'Alice status changed',
      payload: { status: 'THINKING' },
    };

    // First emission
    const postRes1 = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    assert.equal(postRes1.status, 202);
    const json1 = await postRes1.json();
    assert.equal(json1.accepted, true);
    assert.equal(json1.duplicate, false);

    // Second emission (duplicate check)
    const postRes2 = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    assert.equal(postRes2.status, 200);
    const json2 = await postRes2.json();
    assert.equal(json2.accepted, true);
    assert.equal(json2.duplicate, true);
  } finally {
    server.close();
  }
});

test('REST API: POST /api/v1/events/batch batch processing', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const batch = {
      events: [
        {
          schemaVersion: '1.0',
          id: 'evt_batch_1',
          type: 'agent.registered',
          timestamp: Date.now(),
          source: 'agent:bob',
          agentId: 'bob',
          summary: 'Registered Bob',
          payload: { name: 'Bob', roleTitle: 'Dev' },
        },
        {
          schemaVersion: '1.0',
          id: 'evt_batch_2',
          type: 'tool.started',
          timestamp: Date.now(),
          source: 'agent:bob',
          agentId: 'bob',
          summary: 'Bob using git',
          payload: { tool: 'git.commit' },
        },
      ],
    };

    const res = await fetch(`${baseUrl}/api/v1/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    assert.equal(res.status, 202);
    const json = await res.json();
    assert.equal(json.accepted, 2);
    assert.equal(json.total, 2);
    assert.equal(json.results.length, 2);
  } finally {
    server.close();
  }
});

test('REST API: /api/v1/snapshot contains aggregated state', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const res = await fetch(`${baseUrl}/api/v1/snapshot`);
    assert.equal(res.status, 200);
    const snapshot = await res.json();
    assert.equal(snapshot.schemaVersion, '1.0');
    assert.ok(Array.isArray(snapshot.agents));
    assert.ok(Array.isArray(snapshot.runtimes));
    assert.ok(Array.isArray(snapshot.sessions));
  } finally {
    server.close();
  }
});

test('REST API: GET /api/v1/snapshot and GET /api/v1/events report retention (issue #53)', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const before = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
    assert.equal(before.retention.storage, 'memory');
    assert.equal(before.retention.maxEvents, 10000);
    assert.equal(typeof before.retention.totalsSince, 'number');
    assert.equal(before.retention.acceptedEvents, before.retention.retainedEvents + before.retention.droppedEvents);

    const retentionEvent = {
      id: 'evt_retention_api',
      type: 'agent.message.sent',
      timestamp: Date.now(),
      source: 'agent:retention-tester',
      summary: 'Retention test',
      payload: { text: 'hi' },
    };
    const postRes = await postEvent(baseUrl, retentionEvent);
    assert.equal(postRes.status, 202);

    const eventsBody = await (await fetch(`${baseUrl}/api/v1/events`)).json();
    assert.equal(eventsBody.retention.storage, 'memory');
    assert.equal(eventsBody.retention.acceptedEvents, before.retention.acceptedEvents + 1);

    const after = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
    assert.equal(after.retention.acceptedEvents, before.retention.acceptedEvents + 1);

    // A retry of the same id and content is a duplicate: it must not move acceptedEvents.
    const retryRes = await postEvent(baseUrl, retentionEvent);
    assert.equal(retryRes.status, 200);
    const afterRetry = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
    assert.equal(afterRetry.retention.acceptedEvents, after.retention.acceptedEvents);
  } finally {
    server.close();
  }
});

async function postEvent(baseUrl, event) {
  return fetch(`${baseUrl}/api/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
}

async function listEvents(baseUrl, query) {
  const res = await fetch(`${baseUrl}/api/v1/events?${query}`);
  assert.equal(res.status, 200);
  return (await res.json()).events;
}

function agentTotals(agent) {
  return {
    tokensInput: agent.tokensInput,
    tokensOutput: agent.tokensOutput,
    cachedTokens: agent.cachedTokens,
    reasoningTokens: agent.reasoningTokens,
    cost: agent.cost,
  };
}

test('REST API: llm.usage without cache fields round trips without invented zeros', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const postRes = await postEvent(baseUrl, {
      id: 'evt_usage_no_cache_api',
      type: 'llm.usage',
      timestamp: Date.now(),
      source: 'agent:usage-no-cache',
      agentId: 'usage-no-cache',
      summary: 'Usage without cache data',
      payload: { provider: 'Google', model: 'gemini-2.5-pro', inputTokens: 5000, outputTokens: 1000 },
    });
    assert.equal(postRes.status, 202);

    const events = await listEvents(baseUrl, 'agentId=usage-no-cache&type=llm.usage');
    const stored = events.find((event) => event.id === 'evt_usage_no_cache_api');
    assert.ok(stored, 'Expected the usage event in GET /api/v1/events');
    assert.deepEqual(stored.payload, {
      provider: 'Google',
      model: 'gemini-2.5-pro',
      inputTokens: 5000,
      outputTokens: 1000,
      cost: null,
      costSource: 'unknown',
    });
    assert.equal('cachedTokens' in stored.payload, false);
    assert.equal('reasoningTokens' in stored.payload, false);
  } finally {
    server.close();
  }
});

test('REST API: llm.usage without cache fields round trips without invented zeros on the SQLite store', () => {
  // The store is chosen when the server module loads, so the SQLite case runs in its own process.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-api-sqlite-'));
  try {
    const serverUrl = new URL('../server/index.ts', import.meta.url).href;
    const script = `
      const http = await import('node:http');
      const { app } = await import(${JSON.stringify(serverUrl)});
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = 'http://127.0.0.1:' + server.address().port;
      const post = await fetch(baseUrl + '/api/v1/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'evt_usage_no_cache_sqlite',
          type: 'llm.usage',
          timestamp: Date.now(),
          source: 'agent:usage-sqlite',
          agentId: 'usage-sqlite',
          summary: 'Usage without cache data',
          payload: { provider: 'Google', model: 'gemini-2.5-pro', inputTokens: 5000, outputTokens: 1000 },
        }),
      });
      const listed = await (await fetch(baseUrl + '/api/v1/events?agentId=usage-sqlite')).json();
      server.close();
      console.log(JSON.stringify({ status: post.status, events: listed.events }));
      process.exit(0);
    `;
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      AGENT_VIEWER_STORAGE: 'sqlite',
      AGENT_VIEWER_SQLITE_PATH: path.join(dir, 'events.db'),
    };
    delete env.AGENT_VIEWER_API_TOKEN;
    delete env.AGENT_VIEWER_API_KEY;
    const result = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
      { cwd: dir, env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(env.AGENT_VIEWER_SQLITE_PATH), 'Expected the server to use the SQLite store');
    const output = JSON.parse(result.stdout.trim().split('\n').pop());
    assert.equal(output.status, 202);
    const stored = output.events.find((event) => event.id === 'evt_usage_no_cache_sqlite');
    assert.ok(stored, 'Expected the usage event in GET /api/v1/events');
    assert.deepEqual(stored.payload, {
      provider: 'Google',
      model: 'gemini-2.5-pro',
      inputTokens: 5000,
      outputTokens: 1000,
      cost: null,
      costSource: 'unknown',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REST API: a conflicting cachedTokens alias is rejected with 400', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const res = await postEvent(baseUrl, {
      id: 'evt_usage_alias_conflict_api',
      type: 'llm.usage',
      timestamp: Date.now(),
      source: 'agent:usage-alias',
      summary: 'Conflicting cache counters',
      payload: {
        provider: 'Anthropic',
        model: 'claude-sonnet',
        inputTokens: 500,
        outputTokens: 50,
        cachedTokens: 120,
        cacheReadTokens: 80,
      },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'validation_failed');
    assert.deepEqual(body.issues, [
      {
        path: 'payload.cachedTokens',
        message: 'cachedTokens is deprecated and conflicts with cacheReadTokens; send only cacheReadTokens',
      },
    ]);
  } finally {
    server.close();
  }
});

test('REST API: llm.failed is stored, listed and streamed without changing any total', async () => {
  const { server, baseUrl } = await startTestServer();
  let reader;

  try {
    // Register the agent with a real usage first, so its totals are not zero.
    const usageRes = await postEvent(baseUrl, {
      id: 'evt_failed_agent_usage_api',
      type: 'llm.usage',
      timestamp: Date.now(),
      source: 'agent:failed-researcher',
      agentId: 'failed-researcher',
      summary: 'Usage before the failure',
      payload: {
        provider: 'Anthropic',
        model: 'claude-sonnet',
        inputTokens: 300,
        outputTokens: 40,
        cacheReadTokens: 100,
        reasoningTokens: 5,
        cost: 0.01,
        costSource: 'provider-reported',
        currency: 'USD',
      },
    });
    assert.equal(usageRes.status, 202);

    const before = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
    const agentBefore = before.agents.find((agent) => agent.id === 'failed-researcher');
    assert.ok(agentBefore, 'Expected the agent to be registered');

    const stream = await fetch(`${baseUrl}/api/v1/events/stream`);
    assert.equal(stream.status, 200);
    reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const initial = await reader.read();
    assert.ok(decoder.decode(initial.value).includes('connected'));

    const failedRes = await postEvent(baseUrl, {
      id: 'evt_failed_api_1',
      type: 'llm.failed',
      timestamp: Date.now(),
      source: 'agent:failed-researcher',
      agentId: 'failed-researcher',
      summary: 'Anthropic/claude-sonnet call failed (rate_limited)',
      payload: {
        provider: 'Anthropic',
        model: 'claude-sonnet',
        errorKind: 'rate_limited',
        httpStatus: 429,
        retryable: true,
        requestId: 'req_011CA',
        latencyMs: 212,
      },
    });
    assert.equal(failedRes.status, 202);
    const failedJson = await failedRes.json();
    assert.match(failedJson.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(failedJson, { accepted: true, duplicate: false, id: 'evt_failed_api_1', fingerprint: failedJson.fingerprint });

    // A partly billed failure must not change the totals either.
    const billedRes = await postEvent(baseUrl, {
      id: 'evt_failed_api_2',
      type: 'llm.failed',
      timestamp: Date.now(),
      source: 'agent:failed-researcher',
      agentId: 'failed-researcher',
      summary: 'Anthropic/claude-sonnet call failed (timeout)',
      payload: {
        provider: 'Anthropic',
        model: 'claude-sonnet',
        errorKind: 'timeout',
        inputTokens: 900,
        outputTokens: 30,
        cost: 0.5,
        costSource: 'provider-reported',
        currency: 'USD',
      },
    });
    assert.equal(billedRes.status, 202);

    let streamed = '';
    while (!streamed.includes('id: evt_failed_api_1')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'The stream closed before the llm.failed event arrived');
      streamed += decoder.decode(chunk.value);
    }
    assert.ok(streamed.includes('"type":"llm.failed"'));

    const listed = await listEvents(baseUrl, 'type=llm.failed');
    const stored = listed.find((event) => event.id === 'evt_failed_api_1');
    assert.ok(stored, 'Expected the llm.failed event in GET /api/v1/events?type=llm.failed');
    assert.ok(listed.every((event) => event.type === 'llm.failed'));
    assert.deepEqual(stored.payload, {
      provider: 'Anthropic',
      model: 'claude-sonnet',
      errorKind: 'rate_limited',
      httpStatus: 429,
      retryable: true,
      requestId: 'req_011CA',
      latencyMs: 212,
      cost: null,
      costSource: 'unknown',
    });
    assert.equal('inputTokens' in stored.payload, false);

    const after = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
    const agentAfter = after.agents.find((agent) => agent.id === 'failed-researcher');
    assert.deepEqual(agentTotals(agentAfter), agentTotals(agentBefore));
    assert.deepEqual(after.totalTokens, before.totalTokens);
    assert.equal(after.totalCost, before.totalCost);
  } finally {
    await reader?.cancel();
    server.close();
  }
});

// -------------------------------------------------------------
// Usage aggregates (issue #51)
// -------------------------------------------------------------

const TOKEN_KINDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

function assertBucketShape(bucket) {
  assert.equal(typeof bucket.calls, 'number');
  assert.deepEqual(Object.keys(bucket.tokens).sort(), [...TOKEN_KINDS].sort());
  assert.ok(Array.isArray(bucket.byCurrency));
  for (const key of ['costUnknownCount', 'costMissingCount', 'currencyMissingCount']) {
    assert.equal(typeof bucket[key], 'number');
  }
  const pairCalls = bucket.byCurrency.reduce((total, pair) => total + pair.calls, 0);
  assert.equal(pairCalls + bucket.costUnknownCount, bucket.calls);
}

async function getJson(baseUrl, route) {
  const res = await fetch(`${baseUrl}${route}`);
  assert.equal(res.status, 200);
  return res.json();
}

test('REST API: GET /api/v1/usage returns the usage summary, equal to snapshot.usage', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const posted = await postEvent(baseUrl, {
      id: 'evt_usage_endpoint_1',
      type: 'llm.usage',
      timestamp: Date.now(),
      source: 'agent:usage-endpoint',
      agentId: 'usage-endpoint',
      summary: 'Priced usage',
      payload: {
        provider: 'openai',
        model: 'gpt-5',
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 400,
        cost: 0.02,
        costSource: 'provider-reported',
        currency: 'USD',
      },
    });
    assert.equal(posted.status, 202);

    const usage = await getJson(baseUrl, '/api/v1/usage');
    const snapshot = await getJson(baseUrl, '/api/v1/snapshot');
    assert.deepStrictEqual(usage, snapshot.usage);

    assert.equal(usage.schemaVersion, '1.0');
    assert.ok(usage.eventsReduced >= 1);
    assertBucketShape(usage.total);
    assertBucketShape(usage.total.failed);
    const agent = usage.byAgent.find((entry) => entry.agentId === 'usage-endpoint');
    assert.ok(agent, 'Expected the agent bucket');
    assert.equal(agent.calls, 1);
    assert.deepEqual(agent.tokens.cacheRead, { sum: 400, unreportedCount: 0 });
    assert.deepEqual(agent.tokens.reasoning, { sum: null, unreportedCount: 1 });
    assert.deepEqual(agent.byCurrency, [
      { currency: 'USD', costSource: 'provider-reported', amount: 0.02, amountExact: '0.02', calls: 1 },
    ]);
    assert.deepEqual(agent.byModel.map((entry) => [entry.provider, entry.model, entry.calls]), [['openai', 'gpt-5', 1]]);
    const listed = snapshot.agents.find((entry) => entry.id === 'usage-endpoint');
    assert.equal(listed.cost, 0.02);
  } finally {
    server.close();
  }
});

test('REST API: totalCost and the agent cost are null after a usage event without cost', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const posted = await postEvent(baseUrl, {
      id: 'evt_usage_no_cost_total',
      type: 'llm.usage',
      timestamp: Date.now(),
      source: 'agent:usage-no-cost',
      agentId: 'usage-no-cost',
      summary: 'Usage without cost',
      payload: { provider: 'openai', model: 'gpt-5', inputTokens: 10, outputTokens: 1 },
    });
    assert.equal(posted.status, 202);

    const snapshot = await getJson(baseUrl, '/api/v1/snapshot');
    assert.equal(snapshot.totalCost, null);
    assert.equal(snapshot.agents.find((entry) => entry.id === 'usage-no-cost').cost, null);
    const agent = snapshot.usage.byAgent.find((entry) => entry.agentId === 'usage-no-cost');
    assert.equal(agent.costMissingCount, 1);
    assert.deepEqual(agent.byCurrency, []);
  } finally {
    server.close();
  }
});

test('REST API: generic webhook usage without provider or model is rejected with validation_failed', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const res = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'webhook-usage-agent', usage: { inputTokens: 42, outputTokens: 7 } }),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'validation_failed');
    assert.ok(json.issues.some((i) => i.path === 'usage.provider'));
    assert.ok(json.issues.some((i) => i.path === 'usage.model'));

    // With provider and model, it should work
    const complete = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: 'webhook-usage-agent',
        usage: { provider: 'openai', model: 'gpt-4', inputTokens: 42, outputTokens: 7 },
      }),
    });
    assert.equal(complete.status, 202);

    const usage = await getJson(baseUrl, '/api/v1/usage');
    const agent = usage.byAgent.find((entry) => entry.agentId === 'webhook-usage-agent');
    assert.ok(agent, 'Expected the webhook agent bucket');
    assert.deepEqual(agent.byModel.map((entry) => [entry.provider, entry.model, entry.calls]), [['openai', 'gpt-4', 1]]);
    assert.equal(agent.tokens.input.sum, 42);
    assert.equal(agent.costMissingCount, 1);
  } finally {
    server.close();
  }
});

test('REST API: an agent registered without calls reports cost null and zero legacy tokens', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const res = await fetch(`${baseUrl}/api/v1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'registered-no-calls', name: 'No Calls' }),
    });
    assert.equal(res.status, 201);
    const expected = { tokensInput: 0, tokensOutput: 0, cachedTokens: 0, reasoningTokens: 0, cost: null };
    assert.deepEqual(agentTotals(await res.json()), expected);

    const patched = await fetch(`${baseUrl}/api/v1/agents/registered-no-calls`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'THINKING' }),
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(agentTotals(await patched.json()), expected);

    const snapshot = await getJson(baseUrl, '/api/v1/snapshot');
    assert.deepEqual(agentTotals(snapshot.agents.find((entry) => entry.id === 'registered-no-calls')), expected);
  } finally {
    server.close();
  }
});

for (const storage of ['memory', 'sqlite']) {
  test(`REST API: GET /api/v1/usage on an empty ${storage} server, then the documented example`, () => {
    // A fresh server needs a fresh module, so this case runs in its own process.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-viewer-api-usage-${storage}-`));
    try {
      const serverUrl = new URL('../server/index.ts', import.meta.url).href;
      const fixture = fs.readFileSync(new URL('./fixtures/usage/docs-example.jsonl', import.meta.url), 'utf8');
      const script = `
        const http = await import('node:http');
        const { app } = await import(${JSON.stringify(serverUrl)});
        const server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const baseUrl = 'http://127.0.0.1:' + server.address().port;
        const empty = await (await fetch(baseUrl + '/api/v1/usage')).json();
        const events = ${JSON.stringify(fixture)}.split('\\n').filter(Boolean).map((line) => JSON.parse(line));
        const batch = await fetch(baseUrl + '/api/v1/events/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events }),
        });
        const usage = await (await fetch(baseUrl + '/api/v1/usage')).json();
        const snapshot = await (await fetch(baseUrl + '/api/v1/snapshot')).json();
        server.close();
        console.log(JSON.stringify({ empty, batchStatus: batch.status, usage, snapshot }));
        process.exit(0);
      `;
      const env = {
        ...process.env,
        NODE_ENV: 'test',
        AGENT_VIEWER_STORAGE: storage,
        AGENT_VIEWER_SQLITE_PATH: path.join(dir, 'events.db'),
      };
      delete env.AGENT_VIEWER_API_TOKEN;
      delete env.AGENT_VIEWER_API_KEY;
      const result = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
        { cwd: dir, env, encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout.trim().split('\n').pop());

      const emptyBucket = {
        calls: 0,
        tokens: Object.fromEntries(TOKEN_KINDS.map((kind) => [kind, { sum: null, unreportedCount: 0 }])),
        byCurrency: [],
        costUnknownCount: 0,
        costMissingCount: 0,
        currencyMissingCount: 0,
        firstTimestamp: null,
        lastTimestamp: null,
      };
      assert.deepStrictEqual(output.empty, {
        schemaVersion: '1.0',
        eventsReduced: 0,
        total: { ...emptyBucket, failed: emptyBucket },
        byModel: [],
        byAgent: [],
      });

      assert.equal(output.batchStatus, 202);
      assert.deepStrictEqual(output.usage, output.snapshot.usage);
      assert.equal(output.usage.eventsReduced, 4);
      assert.equal(output.usage.total.calls, 3);
      assert.equal(output.usage.total.failed.calls, 1);
      assert.deepEqual(output.usage.total.byCurrency, [
        { currency: 'USD', costSource: 'provider-reported', amount: 0.042, amountExact: '0.042', calls: 2 },
      ]);
      assert.deepEqual(output.snapshot.totalTokens, { input: 4200, output: 950, cached: 1200, reasoning: 0 });
      assert.equal(output.snapshot.totalCost, null);
      if (storage === 'sqlite') assert.ok(fs.existsSync(env.AGENT_VIEWER_SQLITE_PATH), 'Expected the SQLite store');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}


// -------------------------------------------------------------
// Ingestion integrity: duplicate vs conflict (issue #47)
// -------------------------------------------------------------

function integrityEvent(id, payload = {}, envelope = {}) {
  return {
    schemaVersion: '1.0',
    id,
    type: 'llm.usage',
    timestamp: 1_700_000_000_000,
    source: 'agent:integrity',
    agentId: 'integrity',
    summary: 'Audited call',
    payload: { provider: 'p', model: 'm', inputTokens: 100, outputTokens: 10, cost: 0.01, costSource: 'provider-reported', currency: 'USD', ...payload },
    ...envelope,
  };
}

async function readyIngestion(baseUrl) {
  const res = await fetch(`${baseUrl}/ready`);
  assert.equal(res.status, 200);
  return (await res.json()).ingestion;
}

test('REST API: re-sending an event returns 200 duplicate with the fingerprint of the first 202', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const event = integrityEvent('evt_integrity_dup');
    const first = await postEvent(baseUrl, event);
    assert.equal(first.status, 202);
    const firstJson = await first.json();
    assert.match(firstJson.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(firstJson, { accepted: true, duplicate: false, id: event.id, fingerprint: firstJson.fingerprint });

    const second = await postEvent(baseUrl, event);
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), {
      accepted: true,
      duplicate: true,
      duplicateReason: 'event_id',
      id: event.id,
      fingerprint: firstJson.fingerprint,
    });

    // The same event with its keys in another order is still the same content.
    const reordered = Object.fromEntries(Object.entries(event).reverse());
    const third = await postEvent(baseUrl, reordered);
    assert.equal(third.status, 200);
    assert.equal((await third.json()).fingerprint, firstJson.fingerprint);
  } finally {
    server.close();
  }
});

test('REST API: the same id with different content returns 409 conflicting_duplicate and changes nothing', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const original = integrityEvent('evt_integrity_conflict');
    const first = await postEvent(baseUrl, original);
    assert.equal(first.status, 202);
    const { fingerprint: storedFingerprint } = await first.json();

    const { cost: _omitted, ...withoutCost } = original.payload;
    const variants = [
      ['inputTokens 100 vs 101', integrityEvent(original.id, { inputTokens: 101 })],
      ['cost 0.01 vs 0.02', integrityEvent(original.id, { cost: 0.02 })],
      ['cost 0.01 vs 0', integrityEvent(original.id, { cost: 0 })],
      ['cost vs missing', { ...original, payload: withoutCost }],
      ['timestamp', integrityEvent(original.id, {}, { timestamp: original.timestamp + 1 })],
    ];

    const snapshotBefore = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
    const countersBefore = await readyIngestion(baseUrl);
    for (const [label, variant] of variants) {
      const res = await postEvent(baseUrl, variant);
      assert.equal(res.status, 409, label);
      const body = await res.json();
      assert.deepEqual(Object.keys(body).sort(), ['error', 'fingerprint', 'id', 'message', 'storedFingerprint'], label);
      assert.equal(body.error, 'conflicting_duplicate', label);
      assert.equal(
        body.message,
        'An event with id "evt_integrity_conflict" was already stored with different content. The new event was not applied.'
      );
      assert.equal(body.id, original.id);
      assert.equal(body.storedFingerprint, storedFingerprint, label);
      assert.match(body.fingerprint, /^sha256:[0-9a-f]{64}$/);
      assert.notEqual(body.fingerprint, storedFingerprint, label);
    }

    const listed = await listEvents(baseUrl, 'agentId=integrity&limit=1000');
    const stored = listed.filter(({ id }) => id === original.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].payload.inputTokens, 100);
    assert.equal(stored[0].payload.cost, 0.01);
    assert.equal(stored[0].timestamp, original.timestamp);

    const snapshotAfter = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
    assert.deepStrictEqual(snapshotAfter.usage, snapshotBefore.usage);
    assert.deepStrictEqual(snapshotAfter.totalTokens, snapshotBefore.totalTokens);
    assert.equal(snapshotAfter.totalCost, snapshotBefore.totalCost);
    const countersAfter = await readyIngestion(baseUrl);
    assert.equal(countersAfter.conflicts, countersBefore.conflicts + variants.length);
    assert.equal(countersAfter.legacyUnverifiedDuplicates, 0);

    // A type alias that validation resolves to the canonical type is the same event: a duplicate.
    const message = { id: 'evt_integrity_alias', timestamp: 5, source: 'agent:integrity', summary: 'hi', payload: { text: 'hola' } };
    assert.equal((await postEvent(baseUrl, { ...message, type: 'agent.message.sent' })).status, 202);
    assert.equal((await postEvent(baseUrl, { ...message, type: 'message.sent' })).status, 200);
  } finally {
    server.close();
  }
});

test('REST API: Idempotency-Key must match a non-empty body id', async () => {
  const { server, baseUrl } = await startTestServer();
  const post = (headers, body) =>
    fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  try {
    const { id: _id, ...withoutId } = integrityEvent('unused');
    const mismatch = await post({ 'Idempotency-Key': 'evt_key_a' }, { ...withoutId, id: 'evt_key_b' });
    assert.equal(mismatch.status, 400);
    assert.deepEqual(await mismatch.json(), {
      error: 'idempotency_key_mismatch',
      message: 'Idempotency-Key "evt_key_a" does not match the event id "evt_key_b".',
    });
    const stored = await listEvents(baseUrl, 'agentId=integrity&limit=1000');
    assert.equal(stored.some(({ id }) => id === 'evt_key_a' || id === 'evt_key_b'), false, 'nothing stored');

    const headerOnly = await post({ 'Idempotency-Key': 'evt_key_header' }, withoutId);
    assert.equal(headerOnly.status, 202);
    assert.equal((await headerOnly.json()).id, 'evt_key_header');

    const emptyBodyId = await post({ 'Idempotency-Key': 'evt_key_empty' }, { ...withoutId, id: '' });
    assert.equal(emptyBodyId.status, 202);
    assert.equal((await emptyBodyId.json()).id, 'evt_key_empty');

    const equal = await post({ 'Idempotency-Key': 'evt_key_same' }, { ...withoutId, id: 'evt_key_same' });
    assert.equal(equal.status, 202);
    assert.equal((await equal.json()).id, 'evt_key_same');
  } finally {
    server.close();
  }
});

test('REST API: batch reports per-item status and conflicts, and only stores and streams accepted items', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const a = integrityEvent('evt_integrity_b_a');
    const aPrime = integrityEvent('evt_integrity_b_a', { outputTokens: 99 });
    const b = integrityEvent('evt_integrity_b_b', { inputTokens: 7 });
    const countersBefore = await readyIngestion(baseUrl);
    const res = await fetch(`${baseUrl}/api/v1/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [a, a, aPrime, b] }),
    });
    assert.equal(res.status, 202);
    const json = await res.json();
    assert.equal(json.accepted, 2);
    assert.equal(json.duplicates, 1);
    assert.equal(json.conflicts, 1);
    assert.equal(json.total, 4);
    assert.deepEqual(json.results.map(({ status }) => status), ['accepted', 'duplicate', 'conflict', 'accepted']);
    assert.deepEqual(json.results.map(({ duplicate }) => duplicate), [false, true, false, false]);
    const [first, second, third, fourth] = json.results;
    assert.deepEqual(Object.keys(first).sort(), ['duplicate', 'fingerprint', 'id', 'status']);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(third.error, 'conflicting_duplicate');
    assert.equal(third.storedFingerprint, first.fingerprint);
    assert.notEqual(third.fingerprint, first.fingerprint);
    assert.equal(fourth.id, b.id);

    const stored = (await listEvents(baseUrl, 'agentId=integrity&limit=1000')).filter(({ id }) => id === a.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].payload.outputTokens, 10, "A' never replaces A");
    assert.equal((await readyIngestion(baseUrl)).conflicts, countersBefore.conflicts + 1);

    // Everything a conflict: still 202, with the counts telling the story.
    const allConflicts = await fetch(`${baseUrl}/api/v1/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([aPrime, integrityEvent(b.id, { inputTokens: 8 })]),
    });
    assert.equal(allConflicts.status, 202);
    const allJson = await allConflicts.json();
    assert.deepEqual([allJson.accepted, allJson.duplicates, allJson.conflicts], [0, 0, 2]);
  } finally {
    server.close();
  }
});

test('REST API: a batch that repeats an id no longer reports duplicate: false for both items', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const event = integrityEvent('evt_integrity_repeat');
    const res = await fetch(`${baseUrl}/api/v1/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: [event, event] }),
    });
    assert.equal(res.status, 202);
    const json = await res.json();
    assert.equal(json.accepted, 1);
    assert.equal(json.duplicates, 1);
    assert.deepEqual(json.results.map(({ id, duplicate, status }) => [id, duplicate, status]), [
      ['evt_integrity_repeat', false, 'accepted'],
      ['evt_integrity_repeat', true, 'duplicate'],
    ]);
  } finally {
    server.close();
  }
});

test('REST API: /ready reports the ingestion counters', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const before = await readyIngestion(baseUrl);
    assert.deepEqual(Object.keys(before).sort(), ['conflicts', 'legacyUnverifiedDuplicates']);
    const event = integrityEvent('evt_integrity_ready');
    assert.equal((await postEvent(baseUrl, event)).status, 202);
    assert.equal((await postEvent(baseUrl, event)).status, 200);
    assert.deepEqual(await readyIngestion(baseUrl), before, 'a duplicate is not a conflict');
    assert.equal((await postEvent(baseUrl, integrityEvent(event.id, { inputTokens: 1 }))).status, 409);
    assert.deepEqual(await readyIngestion(baseUrl), { ...before, conflicts: before.conflicts + 1 });
  } finally {
    server.close();
  }
});

test('REST API: a server-generated id that is not accepted returns 500 internal_id_collision, is logged and never streamed', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const { server, baseUrl } = await startTestServer();
  const stream = await fetch(`${baseUrl}/api/v1/events/stream`);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  const realAppend = store.append.bind(store);
  try {
    assert.equal((await fetch(`${baseUrl}/api/v1/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'collider', name: 'Collider' }),
    })).status, 201);

    const requests = [
      ['POST', '/api/v1/agents', { id: 'collider', name: 'Collider' }],
      ['PATCH', '/api/v1/agents/collider', { status: 'CODING' }],
      ['PATCH', '/api/v1/agents/collider', { name: 'Renamed' }],
      ['POST', '/api/v1/runtimes', { id: 'collider-rt' }],
    ];
    for (const outcome of ['duplicate', 'conflict']) {
      store.append = async (event) => ({
        outcome,
        id: event.id,
        fingerprint: 'sha256:test',
        ...(outcome === 'conflict' ? { storedFingerprint: 'sha256:stored' } : {}),
        duplicate: outcome === 'duplicate',
        accepted: outcome !== 'conflict',
      });
      for (const [method, route, body] of requests) {
        const errorsBefore = errors.mock.callCount();
        const res = await fetch(`${baseUrl}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(res.status, 500, `${method} ${route} (${outcome})`);
        const json = await res.json();
        assert.equal(json.error, 'internal_id_collision');
        assert.equal(errors.mock.callCount(), errorsBefore + 1, 'logged once at error');
        assert.match(String(errors.mock.calls.at(-1).arguments[0]), new RegExp(`"outcome":"${outcome}"`));
      }
    }
    store.append = realAppend;

    // A marker proves the stream is live; nothing from the rejected requests may come before it.
    const marker = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'evt_collision_marker', type: 'agent.message.sent', timestamp: 1, source: 'agent:m', summary: 'm', payload: { text: 'm' } }),
    });
    assert.equal(marker.status, 202);
    while (!text.includes('id: evt_collision_marker')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    const streamedIds = text.split('\n').filter((line) => line.startsWith('id: ')).map((line) => line.slice(4));
    assert.equal(streamedIds.at(-1), 'evt_collision_marker');
    assert.equal(streamedIds.filter((id) => id !== 'evt_collision_marker').every((id) => id.startsWith('evt_reg_')), true);
    assert.equal(streamedIds.length, 2, 'only the first registration and the marker were streamed');
  } finally {
    store.append = realAppend;
    await reader.cancel();
    server.close();
  }
});

test('REST API: a webhook whose generated ids conflict returns 409 and does not broadcast', async (t) => {
  const { server, baseUrl } = await startTestServer();
  const realAppendBatch = store.appendBatch.bind(store);
  try {
    store.appendBatch = async (events) => {
      const results = events.map((event, index) => ({
        outcome: index === 0 ? 'accepted' : index === 1 ? 'duplicate' : 'conflict',
        id: event.id,
        fingerprint: 'sha256:test',
        storedFingerprint: 'sha256:different',
      }));
      return { accepted: 1, duplicates: 1, conflicts: events.length - 2, results, acceptedEvents: [events[0]], acceptedSeqs: [1] };
    };
    const res = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'hook-collider', status: 'coding', message: 'hi', tool: 'grep' }),
    });
    // With conflicts, webhook returns 409 instead of 202
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.error, 'event_id_conflict');
    assert.equal(json.conflictingIds.length, 1);
  } finally {
    store.appendBatch = realAppendBatch;
    server.close();
  }
});

// -------------------------------------------------------------
// Request-id deduplication (issue #48)
// -------------------------------------------------------------

function usageWithRequest(id, requestId, payload = {}) {
  return integrityEvent(id, { provider: 'openai', requestId, ...payload });
}

test('REST API: a new event id with the same (provider, requestId) is a 200 request_id duplicate pointing to the original', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const original = usageWithRequest('evt_reqdup_original', 'req-abc-1');
    const firstRes = await postEvent(baseUrl, original);
    assert.equal(firstRes.status, 202);

    const before = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
    const agentBefore = before.agents.find((agent) => agent.id === 'integrity');

    const duplicate = usageWithRequest('evt_reqdup_second', 'req-abc-1', { inputTokens: 999 });
    const secondRes = await postEvent(baseUrl, duplicate);
    assert.equal(secondRes.status, 200);
    const secondJson = await secondRes.json();
    assert.equal(secondJson.accepted, true);
    assert.equal(secondJson.duplicate, true);
    assert.equal(secondJson.duplicateReason, 'request_id');
    assert.equal(secondJson.id, 'evt_reqdup_original');
    assert.equal(secondJson.submittedId, 'evt_reqdup_second');
    assert.equal(secondJson.matchesOriginal, false, 'inputTokens differs from the original');

    const after = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
    // usageDuplicates is expected to grow by the duplicate itself; every other figure must stay identical.
    assert.deepEqual(
      { ...after, timestamp: 0, usageDuplicates: null },
      { ...before, timestamp: 0, usageDuplicates: null },
      'totals and agent fields unchanged by the duplicate'
    );
    assert.deepEqual(after.usageDuplicates, { count: before.usageDuplicates.count + 1, mismatched: before.usageDuplicates.mismatched + 1, unverified: before.usageDuplicates.unverified });
    assert.equal(after.agents.find((agent) => agent.id === 'integrity').provider, agentBefore.provider);

    // Never returned by GET /api/v1/events.
    const listed = await listEvents(baseUrl, 'limit=100');
    assert.ok(!listed.some((event) => event.id === 'evt_reqdup_second'));
    assert.ok(listed.some((event) => event.id === 'evt_reqdup_original'));

    // Re-sending the duplicate's own event id resolves to the original as an event_id duplicate.
    const resend = await postEvent(baseUrl, duplicate);
    assert.equal(resend.status, 200);
    const resendJson = await resend.json();
    assert.equal(resendJson.duplicateReason, 'event_id');
    assert.equal(resendJson.id, 'evt_reqdup_original');
    assert.equal(resendJson.submittedId, 'evt_reqdup_second');
  } finally {
    server.close();
  }
});

test('REST API: provider matching ignores case and surrounding whitespace, requestId matches exactly after trim', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const original = integrityEvent('evt_reqdup_case_1', { provider: ' OpenAI ', requestId: 'req-case-1' });
    assert.equal((await postEvent(baseUrl, original)).status, 202);

    const sameKey = integrityEvent('evt_reqdup_case_2', { provider: 'openai', requestId: ' req-case-1 ' });
    const dup = await postEvent(baseUrl, sameKey);
    assert.equal(dup.status, 200);
    const dupJson = await dup.json();
    assert.equal(dupJson.duplicateReason, 'request_id');
    assert.equal(dupJson.id, 'evt_reqdup_case_1');

    // A different request id under the same normalized provider is a brand new original.
    const otherRequest = integrityEvent('evt_reqdup_case_3', { provider: 'OPENAI', requestId: 'req-case-2' });
    assert.equal((await postEvent(baseUrl, otherRequest)).status, 202);
  } finally {
    server.close();
  }
});

test('REST API: the same requestId under two different providers is counted twice', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const first = integrityEvent('evt_reqdup_provA', { provider: 'provider-a', requestId: 'shared-request-id' });
    const second = integrityEvent('evt_reqdup_provB', { provider: 'provider-b', requestId: 'shared-request-id' });
    assert.equal((await postEvent(baseUrl, first)).status, 202);
    const res = await postEvent(baseUrl, second);
    assert.equal(res.status, 202);
    assert.equal((await res.json()).duplicate, false);
  } finally {
    server.close();
  }
});

test('REST API: llm.failed followed by llm.usage with the same key is a request_id duplicate with matchesOriginal false', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const failed = {
      schemaVersion: '1.0',
      id: 'evt_reqdup_failed',
      type: 'llm.failed',
      timestamp: 1_700_000_000_000,
      source: 'agent:integrity',
      agentId: 'integrity',
      summary: 'Call failed',
      payload: { provider: 'anthropic', model: 'claude', requestId: 'req-mixed-1', errorKind: 'rate_limited' },
    };
    assert.equal((await postEvent(baseUrl, failed)).status, 202);

    const usage = integrityEvent('evt_reqdup_usage_after_failed', { provider: 'anthropic', requestId: 'req-mixed-1' });
    const res = await postEvent(baseUrl, usage);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.duplicateReason, 'request_id');
    assert.equal(json.id, 'evt_reqdup_failed');
    assert.equal(json.matchesOriginal, false);
  } finally {
    server.close();
  }
});

test('REST API: cost null against cost 0 is a mismatch; unknown is never equal to zero', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const original = integrityEvent('evt_reqdup_cost_null', { provider: 'costprovider', requestId: 'req-cost-1', cost: null, currency: null, costSource: 'unknown' });
    assert.equal((await postEvent(baseUrl, original)).status, 202);
    const zeroCost = integrityEvent('evt_reqdup_cost_zero', { provider: 'costprovider', requestId: 'req-cost-1', cost: 0, currency: 'USD', costSource: 'provider-reported' });
    const res = await postEvent(baseUrl, zeroCost);
    assert.equal((await res.json()).matchesOriginal, false);
  } finally {
    server.close();
  }
});

test('REST API: events without requestId, or with a blank one, behave exactly as before (no request-key dedup)', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const noRequestId = integrityEvent('evt_reqdup_none_1', { provider: 'noreq' });
    const blankRequestId = integrityEvent('evt_reqdup_none_2', { provider: 'noreq', requestId: '   ' });
    assert.equal((await postEvent(baseUrl, noRequestId)).status, 202);
    const res = await postEvent(baseUrl, blankRequestId);
    assert.equal(res.status, 202, 'a blank requestId never links two different ids');
    assert.equal((await res.json()).duplicate, false);
  } finally {
    server.close();
  }
});

test('REST API: in a batch, two events sharing a key resolve as original then request_id duplicate, in input order', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const first = usageWithRequest('evt_reqdup_batch_1', 'req-batch-1');
    const second = usageWithRequest('evt_reqdup_batch_2', 'req-batch-1', { inputTokens: 5 });
    const plainDuplicate = { ...first };
    const res = await fetch(`${baseUrl}/api/v1/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([first, second, plainDuplicate]),
    });
    assert.equal(res.status, 202);
    const json = await res.json();
    assert.equal(json.results.length, 3);
    assert.equal(json.results[0].status, 'accepted');
    assert.equal(json.results[0].duplicate, false);
    assert.equal(json.results[1].status, 'duplicate');
    assert.equal(json.results[1].duplicateReason, 'request_id');
    assert.equal(json.results[1].id, 'evt_reqdup_batch_1');
    assert.equal(json.results[1].submittedId, 'evt_reqdup_batch_2');
    assert.equal(json.results[2].status, 'duplicate');
    assert.equal(json.results[2].duplicateReason, 'event_id');
    assert.equal(json.results[2].id, 'evt_reqdup_batch_1');
  } finally {
    server.close();
  }
});

test('REST API: GET /api/v1/usage/duplicates lists references, honors filters, and requires the token when configured', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const original = usageWithRequest('evt_reqdup_list_1', 'req-list-1');
    const duplicate = usageWithRequest('evt_reqdup_list_2', 'req-list-1', { inputTokens: 7 });
    await postEvent(baseUrl, original);
    await postEvent(baseUrl, duplicate);

    const res = await fetch(`${baseUrl}/api/v1/usage/duplicates?provider=openai&requestId=req-list-1`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.schemaVersion, '1.0');
    assert.equal(json.count, 1);
    const [ref] = json.duplicates;
    assert.equal(ref.id, 'evt_reqdup_list_2');
    assert.equal(ref.duplicateOf, 'evt_reqdup_list_1');
    assert.equal(ref.provider, 'openai');
    assert.equal(ref.requestId, 'req-list-1');
    assert.equal(typeof ref.receivedAt, 'number');
    assert.equal(ref.matchesOriginal, false);
    assert.equal(ref.event.id, 'evt_reqdup_list_2');
    assert.equal(ref.event.payload.inputTokens, 7);

    const byDuplicateOf = await (await fetch(`${baseUrl}/api/v1/usage/duplicates?duplicateOf=evt_reqdup_list_1`)).json();
    assert.equal(byDuplicateOf.count, 1);

    const noMatch = await (await fetch(`${baseUrl}/api/v1/usage/duplicates?provider=someone-else`)).json();
    assert.equal(noMatch.count, 0);
  } finally {
    server.close();
  }
});

test('REST API: GET /api/v1/usage/duplicates requires the API token when one is configured', async () => {
  process.env.AGENT_VIEWER_API_TOKEN = 'dup-endpoint-secret';
  const { server, baseUrl } = await startTestServer();
  try {
    const unauth = await fetch(`${baseUrl}/api/v1/usage/duplicates`);
    assert.equal(unauth.status, 401);
    const authed = await fetch(`${baseUrl}/api/v1/usage/duplicates`, {
      headers: { Authorization: 'Bearer dup-endpoint-secret' },
    });
    assert.equal(authed.status, 200);
  } finally {
    delete process.env.AGENT_VIEWER_API_TOKEN;
    server.close();
  }
});

test('REST API: snapshot.usageDuplicates counts references, mismatched and unverified', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const before = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();

    const original = usageWithRequest('evt_reqdup_snap_1', 'req-snap-1');
    await postEvent(baseUrl, original);
    const matching = usageWithRequest('evt_reqdup_snap_2', 'req-snap-1');
    await postEvent(baseUrl, matching);
    const mismatching = usageWithRequest('evt_reqdup_snap_3', 'req-snap-1', { inputTokens: 12345 });
    await postEvent(baseUrl, mismatching);

    const after = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
    assert.equal(after.usageDuplicates.count, before.usageDuplicates.count + 2);
    assert.equal(after.usageDuplicates.mismatched, before.usageDuplicates.mismatched + 1);
    assert.equal(after.usageDuplicates.unverified, before.usageDuplicates.unverified);
  } finally {
    server.close();
  }
});

test('REST API: a mismatched request-id duplicate logs one warning with ids and provider only, never payload text', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { server, baseUrl } = await startTestServer();
  try {
    const original = usageWithRequest('evt_reqdup_warn_1', 'req-warn-1');
    await postEvent(baseUrl, original);
    await postEvent(baseUrl, usageWithRequest('evt_reqdup_warn_2', 'req-warn-1', { inputTokens: 55555, model: 'super-secret-model-name' }));

    const lines = warn.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes('Request-id duplicate does not match'));
    assert.equal(lines.length, 1, 'one warning line for the mismatch');
    assert.ok(!lines[0].includes('\n'), 'a single line');
    assert.ok(!lines[0].includes('super-secret-model-name'), 'never logs payload content');
    const logged = JSON.parse(lines[0].slice(lines[0].indexOf('{')));
    assert.deepEqual(Object.keys(logged).sort(), ['duplicateId', 'originalId', 'provider', 'requestId'].sort());
    assert.equal(logged.originalId, 'evt_reqdup_warn_1');
    assert.equal(logged.duplicateId, 'evt_reqdup_warn_2');
  } finally {
    server.close();
  }
});
