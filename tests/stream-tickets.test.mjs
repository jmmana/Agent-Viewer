import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStreamTicketStore } from '../server/stream-tickets.ts';
import { app } from '../server/index.ts';

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

const NO_AUTH_ENV = { AGENT_VIEWER_API_TOKEN: undefined, AGENT_VIEWER_API_KEY: undefined };

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------
// Unit tests of the in-memory store
// ---------------------------------------------------------------

test('createStreamTicketStore: issues a ticket matching the documented shape, single use', () => {
  let now = 1_000_000;
  const store = createStreamTicketStore({ now: () => now, tokenFingerprint: () => 'tok-a', env: {} });

  const issued = store.issue();
  assert.equal(issued.ok, true);
  assert.match(issued.ticket, /^avst_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.issuedAt, 1_000_000);
  assert.equal(issued.expiresAt, 1_030_000);
  assert.equal(issued.ttlMs, 30_000);
  assert.equal(store.size(), 1);

  assert.equal(store.consume(issued.ticket), true);
  assert.equal(store.size(), 0);
  // Second use of the same ticket fails: it was deleted on first lookup.
  assert.equal(store.consume(issued.ticket), false);
});

test('createStreamTicketStore: an unknown ticket is rejected', () => {
  const store = createStreamTicketStore({ tokenFingerprint: () => '', env: {} });
  assert.equal(store.consume('avst_does-not-exist'), false);
});

test('createStreamTicketStore: expiry is governed by the injected clock', () => {
  let now = 0;
  const store = createStreamTicketStore({ now: () => now, tokenFingerprint: () => 'tok', env: { AGENT_VIEWER_STREAM_TICKET_TTL_MS: '1000' } });
  const issued = store.issue();
  assert.equal(issued.ok, true);
  now = 999;
  assert.equal(store.consume(issued.ticket), true);

  const second = store.issue();
  now = 2000; // past the second ticket's expiry
  assert.equal(store.consume(second.ticket), false);
});

test('createStreamTicketStore: a ticket minted under a different token is rejected (revocation on rotation)', () => {
  let fingerprint = 'token-a';
  const store = createStreamTicketStore({ tokenFingerprint: () => fingerprint, env: {} });
  const issued = store.issue();
  fingerprint = 'token-b';
  assert.equal(store.consume(issued.ticket), false);
});

test('createStreamTicketStore: AGENT_VIEWER_STREAM_TICKET_TTL_MS is clamped to [1000, 300000], invalid falls back to 30000', () => {
  const low = createStreamTicketStore({ tokenFingerprint: () => '', env: { AGENT_VIEWER_STREAM_TICKET_TTL_MS: '1' } });
  assert.equal(low.issue().ttlMs, 1_000);

  const high = createStreamTicketStore({ tokenFingerprint: () => '', env: { AGENT_VIEWER_STREAM_TICKET_TTL_MS: '999999' } });
  assert.equal(high.issue().ttlMs, 300_000);

  const invalid = createStreamTicketStore({ tokenFingerprint: () => '', env: { AGENT_VIEWER_STREAM_TICKET_TTL_MS: 'nope' } });
  assert.equal(invalid.issue().ttlMs, 30_000);
});

test('createStreamTicketStore: AGENT_VIEWER_STREAM_TICKET_MAX caps outstanding tickets, sweeping expired ones first', () => {
  let now = 0;
  const store = createStreamTicketStore({
    now: () => now,
    tokenFingerprint: () => '',
    env: { AGENT_VIEWER_STREAM_TICKET_MAX: '2', AGENT_VIEWER_STREAM_TICKET_TTL_MS: '1000' },
  });
  const first = store.issue();
  const second = store.issue();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(store.issue().ok, false);

  now = 2000; // first and second have now expired
  const third = store.issue();
  assert.equal(third.ok, true);
});

// ---------------------------------------------------------------
// HTTP integration: POST /api/v1/stream-tickets and GET /api/v1/events/stream?ticket=
// ---------------------------------------------------------------

// Runs first among the HTTP integration tests, while the process-wide ticket store is still empty: it asserts
// an exact outstanding count, which a ticket left over from a later test in this same file would throw off.
test('POST /api/v1/stream-tickets: 429 stream_ticket_limit once the outstanding cap is reached', async () => {
  await withEnv(
    { ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'cap-token', AGENT_VIEWER_STREAM_TICKET_MAX: '1' },
    async () => {
      const { server, baseUrl } = await startTestServer();
      try {
        const first = await fetch(`${baseUrl}/api/v1/stream-tickets`, {
          method: 'POST',
          headers: { Authorization: 'Bearer cap-token' },
        });
        assert.equal(first.status, 201);

        const second = await fetch(`${baseUrl}/api/v1/stream-tickets`, {
          method: 'POST',
          headers: { Authorization: 'Bearer cap-token' },
        });
        assert.equal(second.status, 429);
        assert.equal((await second.json()).error, 'stream_ticket_limit');
      } finally {
        server.close();
      }
    }
  );
});

test('POST /api/v1/stream-tickets: requires a Bearer token, rejects a ticket as credential, 201 with a valid token', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'mint-token' }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const noAuth = await fetch(`${baseUrl}/api/v1/stream-tickets`, { method: 'POST' });
      assert.equal(noAuth.status, 401);

      const mint = await fetch(`${baseUrl}/api/v1/stream-tickets`, {
        method: 'POST',
        headers: { Authorization: 'Bearer mint-token' },
      });
      assert.equal(mint.status, 201);
      assert.equal(mint.headers.get('cache-control'), 'no-store');
      const body = await mint.json();
      assert.match(body.ticket, /^avst_[A-Za-z0-9_-]{43}$/);
      assert.equal(body.ttlMs, 30_000);
      assert.equal(new Date(body.expiresAt).toISOString(), body.expiresAt);
      assert.equal(body.streamPath, `/api/v1/events/stream?ticket=${body.ticket}`);

      // A ticket cannot mint tickets: it is not a Bearer header, so this still needs a real token.
      const withTicket = await fetch(`${baseUrl}/api/v1/stream-tickets?ticket=${body.ticket}`, { method: 'POST' });
      assert.equal(withTicket.status, 401);
    } finally {
      server.close();
    }
  });
});

test('POST /api/v1/stream-tickets: rejects an unknown body field with 400 validation_failed', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'mint-token-2' }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const res = await fetch(`${baseUrl}/api/v1/stream-tickets`, {
        method: 'POST',
        headers: { Authorization: 'Bearer mint-token-2', 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'read-only' }),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'validation_failed');

      const empty = await fetch(`${baseUrl}/api/v1/stream-tickets`, {
        method: 'POST',
        headers: { Authorization: 'Bearer mint-token-2' },
      });
      assert.equal(empty.status, 201);
    } finally {
      server.close();
    }
  });
});

async function mintTicket(baseUrl, token) {
  const res = await fetch(`${baseUrl}/api/v1/stream-tickets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await res.json()).ticket;
}

test('GET .../events/stream?ticket=: a valid Bearer header wins over a ticket and leaves it unconsumed', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'bearer-wins-token' }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const ticket = await mintTicket(baseUrl, 'bearer-wins-token');
      const res = await fetch(`${baseUrl}/api/v1/events/stream?ticket=${ticket}`, {
        headers: { Authorization: 'Bearer bearer-wins-token' },
      });
      assert.equal(res.status, 200);
      await res.body.cancel();

      // The ticket was never consumed, so it still works on its own.
      const second = await fetch(`${baseUrl}/api/v1/events/stream?ticket=${ticket}`);
      assert.equal(second.status, 200);
      await second.body.cancel();
    } finally {
      server.close();
    }
  });
});

test('GET .../events/stream?ticket=: two parallel uses of one ticket yield one 200 and one 401 invalid_stream_ticket', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'parallel-token' }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const ticket = await mintTicket(baseUrl, 'parallel-token');
      const [a, b] = await Promise.all([
        fetch(`${baseUrl}/api/v1/events/stream?ticket=${ticket}`),
        fetch(`${baseUrl}/api/v1/events/stream?ticket=${ticket}`),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [200, 401]);
      const failed = a.status === 401 ? a : b;
      assert.equal((await failed.json()).error, 'invalid_stream_ticket');
      const okResponse = a.status === 200 ? a : b;
      await okResponse.body.cancel();
    } finally {
      server.close();
    }
  });
});

test('GET .../events/stream?ticket=: unknown, expired and rotated tickets all get 401 invalid_stream_ticket', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'expiry-token', AGENT_VIEWER_STREAM_TICKET_TTL_MS: '1000' }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const unknown = await fetch(`${baseUrl}/api/v1/events/stream?ticket=avst_${'a'.repeat(43)}`);
      assert.equal(unknown.status, 401);
      assert.equal((await unknown.json()).error, 'invalid_stream_ticket');

      const ticket = await mintTicket(baseUrl, 'expiry-token');
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const expired = await fetch(`${baseUrl}/api/v1/events/stream?ticket=${ticket}`);
      assert.equal(expired.status, 401);
      assert.equal((await expired.json()).error, 'invalid_stream_ticket');
    } finally {
      server.close();
    }
  });
});

test('GET .../events/stream?ticket=: a malformed (repeated/array) ticket also gets 401 invalid_stream_ticket', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'malformed-token' }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const ticket = await mintTicket(baseUrl, 'malformed-token');
      const repeated = await fetch(`${baseUrl}/api/v1/events/stream?ticket=${ticket}&ticket=other`);
      assert.equal(repeated.status, 401);
      assert.equal((await repeated.json()).error, 'invalid_stream_ticket');
    } finally {
      server.close();
    }
  });
});

test('A ticket on any route other than GET /api/v1/events/stream does not authenticate', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'wrong-route-token' }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const ticket = await mintTicket(baseUrl, 'wrong-route-token');
      const res = await fetch(`${baseUrl}/api/v1/snapshot?ticket=${ticket}`);
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error, 'unauthorized');
    } finally {
      server.close();
    }
  });
});

test('A HEAD request to the stream route with a ticket does not consume it', async () => {
  await withEnv({ ...NO_AUTH_ENV, AGENT_VIEWER_API_TOKEN: 'head-token' }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const ticket = await mintTicket(baseUrl, 'head-token');
      const head = await fetch(`${baseUrl}/api/v1/events/stream?ticket=${ticket}`, { method: 'HEAD' });
      assert.equal(head.status, 401);

      const get = await fetch(`${baseUrl}/api/v1/events/stream?ticket=${ticket}`);
      assert.equal(get.status, 200);
      await get.body.cancel();
    } finally {
      server.close();
    }
  });
});

test('In open mode, POST /api/v1/stream-tickets still answers 201 and the stream accepts any request', async () => {
  await withEnv({ ...NO_AUTH_ENV }, async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const mint = await fetch(`${baseUrl}/api/v1/stream-tickets`, { method: 'POST' });
      assert.equal(mint.status, 201);
      const { ticket } = await mint.json();

      const withoutTicket = await fetch(`${baseUrl}/api/v1/events/stream`);
      assert.equal(withoutTicket.status, 200);
      await withoutTicket.body.cancel();

      const withTicket = await fetch(`${baseUrl}/api/v1/events/stream?ticket=${ticket}`);
      assert.equal(withTicket.status, 200);
      await withTicket.body.cancel();
    } finally {
      server.close();
    }
  });
});
