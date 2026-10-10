import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  app,
  currentAuthMode,
  currentWebhookAuthMode,
  openApiWarning,
  startServer,
} from '../server/index.ts';

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

test('Auth state helpers report token, open, and signature modes without exposing credentials', async () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    await withEnv({ ...NO_AUTH_ENV }, async () => {
      assert.equal(currentAuthMode(), 'open');
      assert.equal(currentWebhookAuthMode(), 'open');
    });
    await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'secret-token' }, async () => {
      assert.equal(currentAuthMode(), 'token');
      assert.equal(currentWebhookAuthMode(), 'token');
      assert.equal(openApiWarning({ port: 8787, tokenSet: true, webhookSecret: false }).length, 0);
    });
    await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_KEY: 'legacy-token' }, async () => {
      assert.equal(currentAuthMode(), 'token');
      assert.equal(currentWebhookAuthMode(), 'token');
    });
    await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_WEBHOOK_SECRET: 'signature-secret' }, async () => {
      assert.equal(currentAuthMode(), 'open');
      assert.equal(currentWebhookAuthMode(), 'signature');
    });
    await withEnv(
      { ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'secret-token', AGENT_VIEWER_WEBHOOK_SECRET: 'signature-secret' },
      async () => {
        assert.equal(currentAuthMode(), 'token');
        assert.equal(currentWebhookAuthMode(), 'signature');
      },
    );
    await withEnv(
      { ...NO_AUTH_ENV, AGENT_VIEWER_API_KEY: 'legacy-token', AGENT_VIEWER_WEBHOOK_SECRET: 'signature-secret' },
      async () => {
        assert.equal(currentAuthMode(), 'token');
        assert.equal(currentWebhookAuthMode(), 'signature');
      },
    );
    await withEnv(
      { ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'secret-token', AGENT_VIEWER_API_KEY: 'legacy-token' },
      async () => {
        assert.equal(currentAuthMode(), 'token');
        assert.equal(currentWebhookAuthMode(), 'token');
      },
    );
    await withEnv(
      {
        ...NO_AUTH_ENV,
        AGENT_VIEWER_API_TOKEN: 'secret-token',
        AGENT_VIEWER_API_KEY: 'legacy-token',
        AGENT_VIEWER_WEBHOOK_SECRET: 'signature-secret',
      },
      async () => {
        assert.equal(currentAuthMode(), 'token');
        assert.equal(currentWebhookAuthMode(), 'signature');
      },
    );
  } finally {
    warn.mock.restore();
  }
});

test('openApiWarning describes the bind and webhook state without including token material', () => {
  const open = openApiWarning({ port: 8787, tokenSet: false, webhookSecret: false }).join('\n');
  assert.match(open, /Listening on every interface, port 8787/);
  assert.match(open, /Webhooks are open too/);
  assert.doesNotMatch(open, /secret-token|legacy-token/);

  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    const warning = openApiWarning({ port: 8787, host, tokenSet: false, webhookSecret: true }).join('\n');
    assert.match(warning, new RegExp(`Listening on ${host.replaceAll(':', '\\:')} only, port 8787`));
    assert.doesNotMatch(warning, /Webhooks are open/);
    assert.doesNotMatch(warning, /AGENT_VIEWER_WEBHOOK_SECRET/);
  }
});

test('/health reports live auth state and never returns the token', async () => {
  await withEnv({ ...NO_AUTH_ENV }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const open = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(open.ok, true);
      assert.equal(open.auth, 'open');
      assert.equal(open.webhookAuth, 'open');

      process.env.AGENT_VIEWER_API_TOKEN = 'never-return-this-token';
      const token = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(token.auth, 'token');
      assert.equal(token.webhookAuth, 'token');
      assert.doesNotMatch(JSON.stringify(token), /never-return-this-token/);

      process.env.AGENT_VIEWER_WEBHOOK_SECRET = 'webhook-secret';
      const signed = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(signed.auth, 'token');
      assert.equal(signed.webhookAuth, 'signature');

      delete process.env.AGENT_VIEWER_API_TOKEN;
      const openSigned = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(openSigned.auth, 'open');
      assert.equal(openSigned.webhookAuth, 'signature');
    } finally {
      server.close();
    }
  });
});

test('startServer prints the loopback warning once after listening', async () => {
  await withEnv({ ...NO_AUTH_ENV }, async () => {
    const warning = mock.method(console, 'warn', () => {});
    const server = startServer(0, '127.0.0.1');
    try {
      await new Promise((resolve) => server.once('listening', resolve));
      const port = server.address().port;
      assert.equal(warning.mock.callCount(), 6);
      assert.match(warning.mock.calls[1].arguments[0], new RegExp(`Listening on 127\\.0\\.0\\.1 only, port ${port}`));
      assert.match(warning.mock.calls[2].arguments[0], /Webhooks are open too/);
      assert.doesNotMatch(warning.mock.calls[1].arguments[0], /port 0/);
    } finally {
      warning.mock.restore();
      server.close();
    }
  });
});

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
      const longRes = await fetch(`${baseUrl}/api/v1/snapshot`, {
        headers: { Authorization: `Bearer ${'y'.repeat(200)}` },
      });
      assert.equal(longRes.status, 401);
      assert.equal((await longRes.json()).error, 'unauthorized');
    } finally {
      spy.mock.restore();
      server.close();
    }
  });
});

test('Auth: a token or api_key query parameter never authenticates, even with the correct value (issue #71)', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'query-token-rejected' }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      for (const query of [
        'token=query-token-rejected',
        'api_key=query-token-rejected',
        'token[]=query-token-rejected',
        'token=a&token=b',
      ]) {
        const res = await fetch(`${baseUrl}/api/v1/snapshot?${query}`);
        assert.equal(res.status, 401, query);
        const body = await res.json();
        assert.equal(body.error, 'query_token_not_supported');
        assert.doesNotMatch(JSON.stringify(body), /query-token-rejected/);
      }
    } finally {
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

test('Webhook: the same signed request is a duplicate when replayed inside the timestamp window', async () => {
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
      const firstJson = await first.json();
      assert.equal(firstJson.duplicate, false);

      const replay = await send();
      assert.equal(replay.status, 200);
      const replayJson = await replay.json();
      assert.equal(replayJson.duplicate, true);
      assert.equal(replayJson.idempotency.source, 'signature');
      assert.deepEqual(replayJson.eventIds, firstJson.eventIds);

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
      const freshJson = await fresh.json();
      assert.equal(freshJson.duplicate, false);
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

      // Breaking change (issue #71): a token in the query string never authenticates, even for a webhook URL
      // that cannot set headers. Such senders must sign with AGENT_VIEWER_WEBHOOK_SECRET instead.
      const query = await fetch(`${baseUrl}/api/v1/webhooks/generic?token=webhook-api-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(query.status, 401);
      assert.equal((await query.json()).error, 'query_token_not_supported');
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
      // These should return unrecognized_webhook_payload: no status, message, text, tool, or usage
      for (const body of [{}, { foo: 'bar' }, { agent: 'lonely-agent' }, { status: '' }]) {
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

      // Empty usage object should return validation_failed because provider and model are required
      const emptyUsage = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'x', usage: {} }),
      });
      assert.equal(emptyUsage.status, 400);
      const usageJson = await emptyUsage.json();
      assert.equal(usageJson.error, 'validation_failed');

      const snapshot = await (await fetch(`${baseUrl}/api/v1/snapshot`)).json();
      assert.equal(snapshot.agents.some((a) => a.id === 'generic-agent' || a.id === 'lonely-agent'), false);

      // Usage-only payload missing outputTokens should fail validation
      const missingOutput = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'usage-bot', usage: { provider: 'Google', model: 'gemini', inputTokens: 1 } }),
      });
      assert.equal(missingOutput.status, 400);
      const missingJson = await missingOutput.json();
      assert.equal(missingJson.error, 'validation_failed');

      // Complete usage should work
      const completeUsage = await fetch(`${baseUrl}/api/v1/webhooks/generic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'usage-bot', usage: { provider: 'Google', model: 'gemini', inputTokens: 1, outputTokens: 0 } }),
      });
      assert.equal(completeUsage.status, 202);
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
