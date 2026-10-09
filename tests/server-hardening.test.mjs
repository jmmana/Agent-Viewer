import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { app } from '../server/index.ts';

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

function signWebhook(secret, rawBody, timestamp = Date.now().toString()) {
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return { timestamp, signature };
}

const NO_AUTH_ENV = {
  AGENT_VIEWER_API_TOKEN: undefined,
  AGENT_VIEWER_API_KEY: undefined,
  AGENT_VIEWER_WEBHOOK_SECRET: undefined,
};

test('Auth: API tokens are compared with crypto.timingSafeEqual and wrong lengths are rejected with 401', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'timing-safe-token-123' }, async () => {
    const { server, baseUrl } = await startTestServer();
    const spy = mock.method(crypto, 'timingSafeEqual');
    try {
      const okRes = await fetch(`${baseUrl}/api/v1/snapshot`, {
        headers: { Authorization: 'Bearer timing-safe-token-123' },
      });
      assert.equal(okRes.status, 200);
      assert.ok(spy.mock.callCount() > 0, 'expected the bearer token check to use crypto.timingSafeEqual');

      const shortRes = await fetch(`${baseUrl}/api/v1/snapshot`, { headers: { Authorization: 'Bearer x' } });
      assert.equal(shortRes.status, 401);
      const longRes = await fetch(`${baseUrl}/api/v1/snapshot?token=${'y'.repeat(200)}`);
      assert.equal(longRes.status, 401);
      assert.equal((await longRes.json()).error, 'unauthorized');
    } finally {
      spy.mock.restore();
      server.close();
    }
  });
});

test('Auth: GET /api/v1/usage needs the same token as the other /api/v1 routes', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'usage-route-token' }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const unauth = await fetch(`${baseUrl}/api/v1/usage`);
      assert.equal(unauth.status, 401);
      assert.equal((await unauth.json()).error, 'unauthorized');

      const wrong = await fetch(`${baseUrl}/api/v1/usage`, { headers: { Authorization: 'Bearer wrong-token' } });
      assert.equal(wrong.status, 401);

      const auth = await fetch(`${baseUrl}/api/v1/usage`, { headers: { Authorization: 'Bearer usage-route-token' } });
      assert.equal(auth.status, 200);
      assert.equal((await auth.json()).schemaVersion, '1.0');
    } finally {
      server.close();
    }
  });
});

test('Auth: AGENT_VIEWER_API_KEY is accepted as a deprecated alias of AGENT_VIEWER_API_TOKEN', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_KEY: 'legacy-alias-token' }, async () => {
    const { server, baseUrl } = await startTestServer();
    const warn = mock.method(console, 'warn', () => {});
    try {
      const unauth = await fetch(`${baseUrl}/api/v1/snapshot`);
      assert.equal(unauth.status, 401);

      const auth = await fetch(`${baseUrl}/api/v1/snapshot`, { headers: { Authorization: 'Bearer legacy-alias-token' } });
      assert.equal(auth.status, 200);
    } finally {
      warn.mock.restore();
      server.close();
    }
  });
});

test('Auth: AGENT_VIEWER_API_TOKEN wins over the deprecated AGENT_VIEWER_API_KEY when both are set', async () => {
  await withEnv(
    { ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'canonical-token', AGENT_VIEWER_API_KEY: 'old-key' },
    async () => {
      const { server, baseUrl } = await startTestServer();
      try {
        const old = await fetch(`${baseUrl}/api/v1/snapshot`, { headers: { Authorization: 'Bearer old-key' } });
        assert.equal(old.status, 401);
        const canonical = await fetch(`${baseUrl}/api/v1/snapshot`, { headers: { Authorization: 'Bearer canonical-token' } });
        assert.equal(canonical.status, 200);
      } finally {
        server.close();
      }
    }
  );
});

test('PATCH /api/v1/agents/:id: the path id wins over body.id', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const created = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'patch-path-agent', name: 'Path Agent' }),
      });
      assert.equal(created.status, 201);

      const patched = await fetch(`${baseUrl}/api/v1/agents/patch-path-agent`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'hijacked-agent', status: 'CODING', statusText: 'Writing code' }),
      });
      assert.equal(patched.status, 200);
      const json = await patched.json();
      assert.equal(json.id, 'patch-path-agent');
      assert.equal(json.status, 'CODING');

      const snapshot = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
      assert.equal(snapshot.agents.some((a) => a.id === 'hijacked-agent'), false);
      assert.equal(snapshot.agents.find((a) => a.id === 'patch-path-agent').status, 'CODING');
    } finally {
      server.close();
    }
  });
});

test('PATCH /api/v1/agents/:id: rejects unknown statuses with 400 and normalizes valid ones to upper case', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'patch-status-agent', name: 'Status Agent' }),
      });

      const invalid = await fetch(`${baseUrl}/api/v1/agents/patch-status-agent`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'DANCING' }),
      });
      assert.equal(invalid.status, 400);
      const invalidJson = await invalid.json();
      assert.equal(invalidJson.error, 'validation_failed');
      assert.match(invalidJson.message, /DANCING/);

      const wrongType = await fetch(`${baseUrl}/api/v1/agents/patch-status-agent`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 42 }),
      });
      assert.equal(wrongType.status, 400);

      const snapshotAfterInvalid = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
      assert.equal(snapshotAfterInvalid.agents.find((a) => a.id === 'patch-status-agent').status, 'IDLE');

      const lower = await fetch(`${baseUrl}/api/v1/agents/patch-status-agent`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'reviewing' }),
      });
      assert.equal(lower.status, 200);
      assert.equal((await lower.json()).status, 'REVIEWING');
    } finally {
      server.close();
    }
  });
});

test('Webhook: the same signed request is rejected when replayed inside the timestamp window', async () => {
  const secret = 'replay-cache-secret';
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_WEBHOOK_SECRET: secret }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const rawBody = JSON.stringify({ agent: 'replay-bot', message: 'Only once' });
      const { timestamp, signature } = signWebhook(secret, rawBody);
      const send = () =>
        fetch(`${baseUrl}/api/v1/webhooks/generic`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Agent-Viewer-Signature': signature,
            'X-Agent-Viewer-Timestamp': timestamp,
          },
          body: rawBody,
        });

      const first = await send();
      assert.equal(first.status, 202);

      const replay = await send();
      assert.equal(replay.status, 409);
      assert.equal((await replay.json()).error, 'webhook_replay_detected');

      // A fresh signature for the same body (new timestamp) is a new request and is accepted.
      const resigned = signWebhook(secret, rawBody, (Number(timestamp) + 1).toString());
      const fresh = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Viewer-Signature': resigned.signature,
          'X-Agent-Viewer-Timestamp': resigned.timestamp,
        },
        body: rawBody,
      });
      assert.equal(fresh.status, 202);
    } finally {
      server.close();
    }
  });
});

test('Webhook: requires the API token when only AGENT_VIEWER_API_TOKEN is configured', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'webhook-api-token' }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const body = JSON.stringify({ agent: 'token-bot', status: 'thinking' });
      const unauth = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(unauth.status, 401);
      assert.equal((await unauth.json()).error, 'unauthorized');

      const bearer = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer webhook-api-token' },
        body,
      });
      assert.equal(bearer.status, 202);

      const query = await fetch(`${baseUrl}/api/v1/webhooks/generic?token=webhook-api-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(query.status, 202);
    } finally {
      server.close();
    }
  });
});

test('Webhook: with a webhook secret configured, a valid HMAC signature authenticates the request', async () => {
  const secret = 'hmac-and-token-secret';
  await withEnv(
    { ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'unused-by-signed-webhooks', AGENT_VIEWER_WEBHOOK_SECRET: secret },
    async () => {
      const { server, baseUrl } = await startTestServer();
      try {
        const rawBody = JSON.stringify({ agent: 'signed-bot', status: 'coding' });
        const { timestamp, signature } = signWebhook(secret, rawBody);
        const signed = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Agent-Viewer-Signature': signature,
            'X-Agent-Viewer-Timestamp': timestamp,
          },
          body: rawBody,
        });
        assert.equal(signed.status, 202);

        const unsigned = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer unused-by-signed-webhooks' },
          body: rawBody,
        });
        assert.equal(unsigned.status, 401);
        assert.equal((await unsigned.json()).error, 'missing_webhook_signature');
      } finally {
        server.close();
      }
    }
  );
});

test('Webhook: payloads that do not map to a known event shape are rejected with 400', async () => {
  await withEnv(NO_AUTH_ENV, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      for (const body of [{}, { foo: 'bar' }, { agent: 'lonely-agent' }, { agent: 'x', usage: {} }, { status: '' }]) {
        const res = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
        const json = await res.json();
        assert.equal(json.error, 'unrecognized_webhook_payload');
        assert.match(json.message, /status/);
      }

      const snapshot = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
      assert.equal(snapshot.agents.some((a) => a.id === 'generic-agent' || a.id === 'lonely-agent'), false);

      const usageOnly = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'usage-bot', usage: { provider: 'Google', model: 'gemini', inputTokens: 1 } }),
      });
      assert.equal(usageOnly.status, 202);
    } finally {
      server.close();
    }
  });
});

test('Startup: dotenv does not print its banner when the server module loads', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', "await import('./server/index.ts')"], {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}${result.stderr}`;
  assert.doesNotMatch(output, /injected env|dotenv/i);
});
