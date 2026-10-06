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
