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

    const readyRes = await fetch(`${baseUrl}/ready`);
    assert.equal(readyRes.status, 200);
    const readyJson = await readyRes.json();
    assert.deepEqual(readyJson, { ok: true, ready: true, storage: 'memory' });
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
      schemaVersion: 1,
      latestKnownSchemaVersion: 1,
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
    assert.deepEqual(await failedRes.json(), { accepted: true, duplicate: false, id: 'evt_failed_api_1' });

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

test('REST API: generic webhook usage without provider or model lands in the null model bucket', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const res = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'webhook-usage-agent', usage: { inputTokens: 42, outputTokens: 7 } }),
    });
    assert.equal(res.status, 202);

    const usage = await getJson(baseUrl, '/api/v1/usage');
    const agent = usage.byAgent.find((entry) => entry.agentId === 'webhook-usage-agent');
    assert.ok(agent, 'Expected the webhook agent bucket');
    assert.deepEqual(agent.byModel.map((entry) => [entry.provider, entry.model, entry.calls]), [[null, null, 1]]);
    assert.equal(agent.tokens.input.sum, 42);
    assert.equal(agent.costMissingCount, 1);
    assert.ok(usage.byModel.some((entry) => entry.provider === null && entry.model === null && entry.calls >= 1));
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

