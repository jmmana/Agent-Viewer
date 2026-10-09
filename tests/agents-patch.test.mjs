import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { app } from '../server/index.ts';

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

const NO_AUTH_ENV = {
  AGENT_VIEWER_API_TOKEN: undefined,
  AGENT_VIEWER_API_KEY: undefined,
  AGENT_VIEWER_WEBHOOK_SECRET: undefined,
};

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

function agentId() {
  return `patch-${randomUUID()}`;
}

async function createAgent(baseUrl, id) {
  const response = await fetch(`${baseUrl}/api/v1/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: 'Patch Agent' }),
  });
  assert.equal(response.status, 201);
}

async function snapshotState(baseUrl, id) {
  const snapshot = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
  return {
    agent: snapshot.agents.find((candidate) => candidate.id === id),
    totalTokens: snapshot.totalTokens,
    totalCost: snapshot.totalCost,
    eventsCount: snapshot.eventsCount,
  };
}

async function patch(baseUrl, id, body) {
  return fetch(`${baseUrl}/api/v1/agents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function getSseReader(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/events/stream`);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /connected/);
  return reader;
}

async function readEvents(reader, count) {
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (data) events.push(JSON.parse(data.slice(6)));
    }
  }
  return events;
}

test('PATCH rejects usage, unknown, read-only, invalid, empty, and reserved fields without changing state', async (t) => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    const id = agentId();
    try {
      await createAgent(baseUrl, id);
      const reservedIds = ['system', 'external-runtime', `runtime:${randomUUID()}`];
      for (const reservedId of reservedIds) await createAgent(baseUrl, reservedId);
      const usageResponse = await fetch(`${baseUrl}/api/v1/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: '1.0',
          id: `${id}-usage`,
          type: 'llm.usage',
          timestamp: Date.now(),
          source: `agent:${id}`,
          agentId: id,
          severity: 'normal',
          summary: 'Reported usage',
          payload: {
            provider: 'Test',
            model: 'model',
            inputTokens: 20,
            outputTokens: 4,
            cachedTokens: 1,
            reasoningTokens: 2,
            cost: 0.25,
          },
        }),
      });
      assert.equal(usageResponse.status, 202);

      const reader = await getSseReader(baseUrl);
      const unchanged = async () => {
        const before = await snapshotState(baseUrl, id);
        const check = async (body, expectedIssues, expectedMessage) => {
          const response = await patch(baseUrl, id, body);
          assert.equal(response.status, 400);
          const json = await response.json();
          assert.equal(json.error, 'validation_failed');
          if (expectedMessage) assert.match(json.message, expectedMessage);
          assert.deepEqual(
            json.issues.map(({ path, code }) => ({ path, code })),
            expectedIssues,
          );
          assert.deepEqual(await snapshotState(baseUrl, id), before);
        };
        return check;
      };

      await t.test('usage_not_patchable covers every usage and cost field', async () => {
        const check = await unchanged();
        const keys = [
          'tokensInput', 'tokensOutput', 'inputTokens', 'outputTokens', 'cachedTokens', 'cacheReadTokens',
          'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'cost', 'currency', 'costSource', 'latencyMs', 'usage',
        ];
        const body = Object.fromEntries(keys.map((key) => [key, key === 'cost' ? -5 : 500]));
        await check(
          body,
          [
            ...keys.map((key) => ({ path: key, code: 'usage_not_patchable' })),
            { path: '', code: 'empty_patch' },
          ],
          /llm\.usage/,
        );
        await check(
          { cost: -5 },
          [{ path: 'cost', code: 'usage_not_patchable' }, { path: '', code: 'empty_patch' }],
          /llm\.usage/,
        );
        await check(
          { tokensInput: '500' },
          [{ path: 'tokensInput', code: 'usage_not_patchable' }, { path: '', code: 'empty_patch' }],
          /llm\.usage/,
        );
      });

      await t.test('mixed profile and usage fields reject the entire request', async () => {
        const check = await unchanged();
        await check(
          { status: 'CODING', cost: 1 },
          [{ path: 'cost', code: 'usage_not_patchable' }],
          /llm\.usage/,
        );
      });

      await t.test('unknown keys, including case variants and __proto__, are rejected', async () => {
        const check = await unchanged();
        await check({ Cost: 1 }, [{ path: 'Cost', code: 'unknown_field' }, { path: '', code: 'empty_patch' }]);
        await check('{"__proto__":"value"}', [
          { path: '__proto__', code: 'unknown_field' },
          { path: '', code: 'empty_patch' },
        ]);
      });

      await t.test('lastSeenAt is read-only', async () => {
        const check = await unchanged();
        await check({ lastSeenAt: 1 }, [
          { path: 'lastSeenAt', code: 'read_only_field' },
          { path: '', code: 'empty_patch' },
        ]);
      });

      await t.test('allowed profile fields require trimmed, bounded strings', async () => {
        const check = await unchanged();
        for (const [key, value] of [
          ['name', null], ['roleTitle', 1], ['provider', ''], ['model', 'x'.repeat(201)],
          ['workspace', '  '], ['statusText', null], ['statusText', 'x'.repeat(1001)],
        ]) {
          await check({ [key]: value }, [{ path: key, code: 'invalid_type' }]);
        }
      });

      await t.test('invalid statuses use invalid_status', async () => {
        const check = await unchanged();
        for (const value of [null, 42, '', 'DANCING']) {
          await check({ status: value }, [{ path: 'status', code: 'invalid_status' }]);
        }
      });

      await t.test('empty objects and id-only bodies use empty_patch', async () => {
        const check = await unchanged();
        await check({}, [{ path: '', code: 'empty_patch' }]);
        await check({ id: 'ignored' }, [{ path: '', code: 'empty_patch' }]);
      });

      await t.test('reserved ids are rejected and unknown agents remain 404', async () => {
        const check = await unchanged();
        for (const reservedId of reservedIds) {
          const response = await patch(baseUrl, reservedId, { name: 'Not allowed' });
          assert.equal(response.status, 400);
          assert.deepEqual((await response.json()).issues.map(({ path, code }) => ({ path, code })), [
            { path: 'agentId', code: 'reserved_agent_id' },
          ]);
        }
        await check({ status: 'DANCING' }, [{ path: 'status', code: 'invalid_status' }]);
        const missing = await patch(baseUrl, agentId(), { name: 'Missing' });
        assert.equal(missing.status, 404);
        assert.equal((await missing.json()).error, 'agent_not_found');
      });

      const noFrame = reader.read().then(({ value, done }) => ({
        done,
        text: value ? new TextDecoder().decode(value) : '',
      }));
      const result = await Promise.race([
        noFrame,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 80)),
      ]);
      assert.equal(result, 'timeout');
      await reader.cancel();

      const accepted = await patch(baseUrl, id, { status: 'CODING' });
      assert.equal(accepted.status, 200);
      const snapshot = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
      const agentTotals = snapshot.agents.reduce(
        (totals, agent) => ({
          input: totals.input + agent.tokensInput,
          output: totals.output + agent.tokensOutput,
          cached: totals.cached + agent.cachedTokens,
          reasoning: totals.reasoning + agent.reasoningTokens,
          cost: totals.cost + (agent.cost ?? 0),
        }),
        { input: 0, output: 0, cached: 0, reasoning: 0, cost: 0 },
      );
      assert.deepEqual(snapshot.totalTokens, {
        input: agentTotals.input,
        output: agentTotals.output,
        cached: agentTotals.cached,
        reasoning: agentTotals.reasoning,
      });
      // Unknown is never zero (#51): the total cost is a number only when every call reported one.
      if (snapshot.totalCost !== null) {
        assert.ok(snapshot.agents.every((agent) => agent.cost !== null));
        assert.ok(Math.abs(snapshot.totalCost - agentTotals.cost) < 1e-9);
      }
    } finally {
      server.close();
    }
  });
});

test('PATCH emits only replayable profile and status events, including on retries and concurrency', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    const id = agentId();
    try {
      await createAgent(baseUrl, id);
      const reader = await getSseReader(baseUrl);

      const profile = await patch(baseUrl, id, { model: 'gpt-5' });
      assert.equal(profile.status, 200);
      const [profileEvent] = await readEvents(reader, 1);
      assert.equal(profileEvent.type, 'agent.updated');
      assert.deepEqual(profileEvent.payload, { model: 'gpt-5' });

      const status = await patch(baseUrl, id, { status: ' coding ', statusText: ' x ' });
      assert.equal(status.status, 200);
      const [statusEvent] = await readEvents(reader, 1);
      assert.equal(statusEvent.type, 'agent.status.changed');
      assert.deepEqual(statusEvent.payload, { status: 'CODING', statusText: 'x' });

      const combined = await patch(baseUrl, id, { name: ' A ', status: 'DONE', workspace: ' meeting ' });
      assert.equal(combined.status, 200);
      const [nameEvent, combinedStatusEvent] = await readEvents(reader, 2);
      assert.deepEqual([nameEvent.type, combinedStatusEvent.type], ['agent.updated', 'agent.status.changed']);
      assert.deepEqual(nameEvent.payload, { name: 'A' });
      assert.deepEqual(combinedStatusEvent.payload, { status: 'DONE', workspace: 'meeting' });
      assert.equal(nameEvent.timestamp, combinedStatusEvent.timestamp);

      const statusText = await patch(baseUrl, id, { statusText: ' x ' });
      assert.equal(statusText.status, 200);
      const [statusTextEvent] = await readEvents(reader, 1);
      assert.equal(statusTextEvent.type, 'agent.updated');
      assert.deepEqual(statusTextEvent.payload, { statusText: 'x' });
      assert.equal((await statusText.json()).statusText, 'x');

      await patch(baseUrl, id, { model: 'same' });
      await patch(baseUrl, id, { model: 'same' });
      const retries = await readEvents(reader, 2);
      assert.deepEqual(retries.map((event) => event.payload), [{ model: 'same' }, { model: 'same' }]);

      const concurrent = await Promise.all([
        patch(baseUrl, id, { model: 'one', status: 'CODING' }),
        patch(baseUrl, id, { provider: 'two', status: 'DONE' }),
      ]);
      assert.deepEqual(concurrent.map((response) => response.status), [200, 200]);
      const concurrentEvents = await readEvents(reader, 4);
      assert.equal(new Set(concurrentEvents.map((event) => event.id)).size, 4);
      assert.deepEqual(concurrentEvents.map((event) => event.type).sort(), [
        'agent.status.changed', 'agent.status.changed', 'agent.updated', 'agent.updated',
      ]);

      const listedResponse = await fetch(
        `${baseUrl}/api/v1/events?agentId=${encodeURIComponent(id)}&type=agent.updated`,
      );
      assert.equal(listedResponse.status, 200);
      const listed = await listedResponse.json();
      assert.ok(listed.events.some((event) => event.payload.model === 'gpt-5'));
      assert.equal((await (await fetch(`${baseUrl}/api/v1/snapshot`)).json()).agents.find((agent) => agent.id === id).model, 'one');
      await reader.cancel();
    } finally {
      server.close();
    }
  });
});
