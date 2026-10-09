import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { app } from '../server/index.ts';

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

test('Webhook: generic webhook converts simple payload to canonical events', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const payload = {
      agent: 'tester_agent',
      status: 'researching',
      message: 'Reading test specifications',
      tool: 'spec.fetch',
    };

    const res = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 202);
    const json = await res.json();
    assert.equal(json.accepted, true);
    assert.ok(json.eventsGenerated >= 2);
  } finally {
    server.close();
  }
});

test('Webhook: HMAC security verifies signature and rejects tampered bodies or replays', async () => {
  process.env.AGENT_VIEWER_WEBHOOK_SECRET = 'super-secret-hmac-key';
  const { server, baseUrl } = await startTestServer();

  try {
    const bodyObj = { agent: 'secure-bot', message: 'Hello secured webhook' };
    const rawBody = JSON.stringify(bodyObj);
    const timestamp = Date.now().toString();

    const validSignature = crypto
      .createHmac('sha256', process.env.AGENT_VIEWER_WEBHOOK_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    // 1. Valid signature
    const validRes = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Viewer-Signature': validSignature,
        'X-Agent-Viewer-Timestamp': timestamp,
      },
      body: rawBody,
    });
    assert.equal(validRes.status, 202);

    // 2. Tampered signature
    const invalidRes = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Viewer-Signature': 'tampered_signature_123',
        'X-Agent-Viewer-Timestamp': timestamp,
      },
      body: rawBody,
    });
    assert.equal(invalidRes.status, 401);

    // 3. Expired timestamp (replay attack)
    const expiredTimestamp = (Date.now() - 600_000).toString(); // 10 minutes ago
    const replaySignature = crypto
      .createHmac('sha256', process.env.AGENT_VIEWER_WEBHOOK_SECRET)
      .update(`${expiredTimestamp}.${rawBody}`)
      .digest('hex');

    const replayRes = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Viewer-Signature': replaySignature,
        'X-Agent-Viewer-Timestamp': expiredTimestamp,
      },
      body: rawBody,
    });
    assert.equal(replayRes.status, 401);
  } finally {
    delete process.env.AGENT_VIEWER_WEBHOOK_SECRET;
    server.close();
  }
});

test('Webhook stability: invalid payload {"message": 123} returns 400, /health stays 200, malformed JSON returns 400 JSON', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    // 1. Invalid message type (number instead of string) -> 400
    const res1 = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 123 }),
    });
    assert.equal(res1.status, 400);
    const json1 = await res1.json();
    assert.equal(json1.error, 'validation_failed');

    // 2. /health remains 200 and healthy
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.status, 'healthy');

    // 3. Malformed JSON payload -> 400 in JSON
    const resMalformed = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"invalid": json',
    });
    assert.equal(resMalformed.status, 400);
    const malformedJson = await resMalformed.json();
    assert.equal(malformedJson.error, 'bad_request');
  } finally {
    server.close();
  }
});

test('Webhook: without a key, generated ids are random and each delivery gets new ids', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const send = () =>
      fetch(`${baseUrl}/api/v1/webhooks/generic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: 'uuid-hook',
          status: 'coding',
          message: 'Working',
          tool: 'grep',
          usage: { provider: 'p', model: 'm', inputTokens: 3, outputTokens: 1 },
        }),
      });
    const first = await send();
    assert.equal(first.status, 202);
    const json = await first.json();
    assert.equal(json.accepted, true);
    assert.equal(json.duplicate, false);
    assert.equal(json.eventsGenerated, 4);
    assert.equal(json.acceptedCount, 4);
    assert.equal(json.duplicates, 0);
    assert.equal(json.idempotency.source, 'none');
    const prefixes = json.eventIds.map((id) => id.replace(/_[0-9a-f-]{36}$/, ''));
    assert.deepEqual(prefixes, ['evt_wh_status', 'evt_wh_msg', 'evt_wh_tool', 'evt_wh_usage']);
    for (const id of json.eventIds) {
      assert.match(id, /^evt_[a-z_]+_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }

    // The same delivery again generates new ids, so nothing collides.
    const second = await (await send()).json();
    assert.equal(second.acceptedCount, 4);
    assert.equal(second.duplicates, 0);
    assert.equal(second.idempotency.source, 'none');
    assert.equal(new Set([...json.eventIds, ...second.eventIds]).size, 8);
  } finally {
    server.close();
  }
});
