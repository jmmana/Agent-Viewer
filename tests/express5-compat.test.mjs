// Regression tests for the Express 4 to Express 5 migration: behavior that Express 5 changed by default
// and the server keeps as it was.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { app, store } from '../server/index.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

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

/** Runs `fn` with the given env vars set, restoring the previous values afterwards. */
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

const NO_AUTH_ENV = {
  AGENT_VIEWER_API_TOKEN: undefined,
  AGENT_VIEWER_API_KEY: undefined,
  AGENT_VIEWER_WEBHOOK_SECRET: undefined,
};

test('CORS preflight: OPTIONS answers 204 on the root, known routes and unknown paths', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    for (const path of ['/', '/api/v1/events', '/api/v1/agents/alice', '/not/a/route']) {
      const res = await fetch(`${baseUrl}${path}`, { method: 'OPTIONS' });
      assert.equal(res.status, 204, `OPTIONS ${path}`);
      assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, OPTIONS');
      assert.match(res.headers.get('access-control-allow-headers') ?? '', /idempotency-key/);
    }
  } finally {
    server.close();
  }
});

test('POST /api/v1/events without a JSON body returns 400 validation_failed, also with Idempotency-Key', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const noBody = await fetch(`${baseUrl}/api/v1/events`, { method: 'POST' });
      assert.equal(noBody.status, 400);
      const noBodyJson = await noBody.json();
      assert.equal(noBodyJson.error, 'validation_failed');
      assert.ok(noBodyJson.issues.some((issue) => issue.path === 'type'));

      const withKey = await fetch(`${baseUrl}/api/v1/events`, {
        method: 'POST',
        headers: { 'Idempotency-Key': 'evt_no_body_key' },
      });
      assert.equal(withKey.status, 400);
      const withKeyJson = await withKey.json();
      assert.equal(withKeyJson.error, 'validation_failed');
      // The key fills in the id, so only the other required fields are reported.
      assert.ok(!withKeyJson.issues.some((issue) => issue.path === 'id'));

      const textBody = await fetch(`${baseUrl}/api/v1/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'not json',
      });
      assert.equal(textBody.status, 400);
      assert.equal((await textBody.json()).error, 'validation_failed');
    } finally {
      server.close();
    }
  });
});

test('Webhook: a signed request without a JSON body is verified against "{}"', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_WEBHOOK_SECRET: 'express5-secret' }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const timestamp = Date.now().toString();
      const signature = crypto.createHmac('sha256', 'express5-secret').update(`${timestamp}.{}`).digest('hex');
      const res = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
        method: 'POST',
        headers: { 'X-Agent-Viewer-Signature': signature, 'X-Agent-Viewer-Timestamp': timestamp },
      });
      // The signature passes; the empty payload is then rejected for not describing any activity.
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'unrecognized_webhook_payload');
    } finally {
      server.close();
    }
  });
});

test('Query strings keep the extended (qs) parser of Express 4', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      for (const id of ['evt_qs_1', 'evt_qs_2']) {
        const res = await fetch(`${baseUrl}/api/v1/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            schemaVersion: '1.0',
            id,
            type: 'agent.status.changed',
            timestamp: Date.now(),
            sessionId: 'ses_express5_qs',
            source: 'agent:qs',
            agentId: 'qs',
            summary: 'qs',
            payload: { status: 'THINKING' },
          }),
        });
        assert.equal(res.status, 202);
      }
      // With qs, `limit[0]=1` parses to ['1'] and Number(['1']) is 1. The simple parser would ignore it.
      const res = await fetch(`${baseUrl}/api/v1/events?sessionId=ses_express5_qs&limit[0]=1`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).count, 1);
    } finally {
      server.close();
    }
  });
});

test('Async handlers: a rejected store call returns a JSON 500 and the server keeps serving', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    const listMock = mock.method(store, 'list', async () => {
      throw new Error('storage unavailable');
    });
    try {
      const res = await fetch(`${baseUrl}/api/v1/events`);
      assert.equal(res.status, 500);
      assert.match(res.headers.get('content-type') ?? '', /application\/json/);
      assert.deepEqual(await res.json(), { error: 'internal_server_error', message: 'storage unavailable' });

      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200);
    } finally {
      listMock.mock.restore();
      server.close();
    }
  });
});

test('Async handlers: a rejected cursor lookup during an SSE reconnect closes the connection instead of hanging it, and the server keeps serving (issue #54)', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    const cursorMock = mock.method(store, 'resolveCursor', async () => {
      throw new Error('storage unavailable');
    });
    try {
      // The SSE stream already sent its headers (and registered the connection) before the cursor lookup
      // rejects, so the connection is closed instead of answering with a JSON 500.
      const stream = await fetch(`${baseUrl}/api/v1/events/stream`, { headers: { 'Last-Event-ID': 'evt_missing' } });
      assert.equal(stream.status, 200);
      await assert.rejects(stream.text());

      const health = await fetch(`${baseUrl}/health`);
      assert.equal(health.status, 200);
    } finally {
      cursorMock.mock.restore();
      server.close();
    }
  });
});

test('Startup: a port that is already in use stops the server with EADDRINUSE', async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, resolve));
  const address = blocker.address();
  const busyPort = typeof address === 'object' && address ? address.port : 0;
  try {
    const env = { ...process.env, PORT: String(busyPort) };
    delete env.NODE_ENV;
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.notEqual(result.status, 0, 'the server must not keep running or exit cleanly');
    assert.match(result.stderr, /EADDRINUSE/);
    assert.doesNotMatch(result.stdout, /listening/);
  } finally {
    blocker.close();
  }
});
