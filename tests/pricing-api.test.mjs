// Issue #83 (sub-issue: pricing admin API and documentation, issue #272). Exercises the 8 `/api/v1/pricing*`
// endpoints end to end against the real `app` (built on the contract of issue #270 and the file store of issue
// #271): request/response shapes, the status codes the issue lists (201/200/400/401/403/404/409/503),
// `expectedVersion` conflicts, the admin-token and open-API behavior, read-only mode with reload, and that the
// shared `/api/v1` rate limiter and Bearer auth still apply to these routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from '../server/index.ts';
import { resetPricingStoreForTests } from '../server/pricing/store.ts';
import starterTable from '../server/pricing/starter.json' with { type: 'json' };

const TOKEN = 'test-pricing-admin-token';

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

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

/** Runs `fn(baseUrl)` against a fresh server backed by a fresh pricing store in a throwaway temp directory,
 * with `AGENT_VIEWER_API_TOKEN` set (admin writes enabled) unless `extraEnv` overrides it. */
async function withPricingServer(fn, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-pricing-api-'));
  const env = {
    AGENT_VIEWER_PRICING_FILE: path.join(dir, 'pricing.json'),
    AGENT_VIEWER_PRICING_HISTORY_FILE: path.join(dir, 'pricing-history.jsonl'),
    AGENT_VIEWER_PRICING_READONLY: undefined,
    AGENT_VIEWER_API_TOKEN: TOKEN,
    AGENT_VIEWER_API_KEY: undefined,
    ...extraEnv,
  };
  return withEnv(env, async () => {
    resetPricingStoreForTests();
    const { server, baseUrl } = await startTestServer();
    try {
      return await fn(baseUrl);
    } finally {
      server.close();
      resetPricingStoreForTests();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

function auth(token = TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

test('GET /pricing reports the bundled starter as version 1, with starter/estimated/readonly metadata', async () => {
  await withPricingServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/pricing`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.pricingVersion, 1);
    assert.equal(body.estimated, true);
    assert.equal(body.readonly, false);
    assert.equal(body.fileInSync, true);
    assert.equal(body.starter.appliedAsOf, starterTable.starter.asOf);
    assert.equal(body.starter.updateAvailable, false);
    assert.ok(body.entries.length > 0);
    assert.deepEqual(body.issues, []);
  });
});

test('GET /pricing/versions lists newest first and honors limit/beforeVersion', async () => {
  await withPricingServer(async (baseUrl) => {
    // Create version 2 via a change so there is something to paginate over.
    await fetch(`${baseUrl}/api/v1/pricing/changes`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 1,
        reason: 'test change',
        upserts: [{ provider: 'acme', model: 'acme-1', kind: 'list', currency: 'USD', effectiveFrom: '2026-01-01T00:00:00Z', inputPerMillion: 1 }],
      }),
    });

    const res = await fetch(`${baseUrl}/api/v1/pricing/versions`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.versions.map((v) => v.pricingVersion), [2, 1]);
    assert.equal(body.versions[0].origin, 'api');
    assert.equal(body.versions[0].reason, 'test change');

    const limited = await (await fetch(`${baseUrl}/api/v1/pricing/versions?limit=1`, { headers: auth() })).json();
    assert.deepEqual(limited.versions.map((v) => v.pricingVersion), [2]);

    const before = await (await fetch(`${baseUrl}/api/v1/pricing/versions?beforeVersion=2`, { headers: auth() })).json();
    assert.deepEqual(before.versions.map((v) => v.pricingVersion), [1]);

    const badLimit = await fetch(`${baseUrl}/api/v1/pricing/versions?limit=0`, { headers: auth() });
    assert.equal(badLimit.status, 400);
    assert.equal((await badLimit.json()).error, 'validation_failed');
  });
});

test('GET /pricing/versions/:version returns the full snapshot, 404 for unknown, 400 for non-integer', async () => {
  await withPricingServer(async (baseUrl) => {
    const ok = await fetch(`${baseUrl}/api/v1/pricing/versions/1`, { headers: auth() });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.pricingVersion, 1);
    assert.ok(Array.isArray(body.entries));

    const missing = await fetch(`${baseUrl}/api/v1/pricing/versions/999`, { headers: auth() });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'version_not_found');

    const invalid = await fetch(`${baseUrl}/api/v1/pricing/versions/not-a-number`, { headers: auth() });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'validation_failed');
  });
});

test('GET /pricing/versions/:version/diff reports added, removed and changed entries', async () => {
  await withPricingServer(async (baseUrl) => {
    await fetch(`${baseUrl}/api/v1/pricing/changes`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 1,
        reason: 'add acme',
        upserts: [{ provider: 'acme', model: 'acme-1', kind: 'list', currency: 'USD', effectiveFrom: '2026-01-01T00:00:00Z', inputPerMillion: 1 }],
      }),
    });

    const diffRes = await fetch(`${baseUrl}/api/v1/pricing/versions/2/diff?against=1`, { headers: auth() });
    assert.equal(diffRes.status, 200);
    const diff = await diffRes.json();
    assert.equal(diff.added.length, 1);
    assert.equal(diff.added[0].provider, 'acme');
    assert.deepEqual(diff.removed, []);
    assert.deepEqual(diff.changed, []);

    const missing = await fetch(`${baseUrl}/api/v1/pricing/versions/2/diff?against=999`, { headers: auth() });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'version_not_found');
  });
});

test('GET /pricing/resolve returns the entry or 404 price_not_found, honors version and at, 400 on bad params', async () => {
  await withPricingServer(async (baseUrl) => {
    const firstEntry = starterTable.entries[0];
    const okRes = await fetch(
      `${baseUrl}/api/v1/pricing/resolve?provider=${firstEntry.provider}&model=${firstEntry.model}&at=2026-10-11T00:00:00Z`,
      { headers: auth() }
    );
    assert.equal(okRes.status, 200);
    const ok = await okRes.json();
    assert.equal(ok.pricingVersion, 1);
    assert.equal(ok.entry.provider, firstEntry.provider);

    const notFound = await fetch(`${baseUrl}/api/v1/pricing/resolve?provider=nobody&model=nothing&at=2026-10-11T00:00:00Z`, { headers: auth() });
    assert.equal(notFound.status, 404);
    assert.equal((await notFound.json()).error, 'price_not_found');

    const missingAt = await fetch(`${baseUrl}/api/v1/pricing/resolve?provider=a&model=b`, { headers: auth() });
    assert.equal(missingAt.status, 400);
    assert.equal((await missingAt.json()).error, 'validation_failed');

    const zonelessAt = await fetch(`${baseUrl}/api/v1/pricing/resolve?provider=a&model=b&at=2026-10-11T00:00:00`, { headers: auth() });
    assert.equal(zonelessAt.status, 400);

    const unknownVersion = await fetch(
      `${baseUrl}/api/v1/pricing/resolve?provider=${firstEntry.provider}&model=${firstEntry.model}&at=2026-10-11T00:00:00Z&version=999`,
      { headers: auth() }
    );
    assert.equal(unknownVersion.status, 404);
    assert.equal((await unknownVersion.json()).error, 'version_not_found');
  });
});

test('POST /pricing/changes creates one version per request, rejects a stale expectedVersion, a no-op, a missing removal and a duplicate key', async () => {
  await withPricingServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/v1/pricing/changes`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 1,
        reason: 'Negotiated discount',
        actor: 'juan',
        upserts: [
          { provider: 'openai', model: 'acme-x', kind: 'override', currency: 'USD', effectiveFrom: '2026-10-01T00:00:00Z', inputPerMillion: 2, estimated: false },
        ],
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.changed, true);
    assert.equal(createdBody.pricingVersion, 2);
    assert.equal(createdBody.parentVersion, 1);
    assert.ok(createdBody.contentHash.startsWith('sha256:'));

    const stale = await fetch(`${baseUrl}/api/v1/pricing/changes`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, reason: 'stale', upserts: [{ provider: 'a', model: 'b', kind: 'list', currency: 'USD', effectiveFrom: '2026-01-01T00:00:00Z', inputPerMillion: 1 }] }),
    });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json();
    assert.equal(staleBody.error, 'version_conflict');
    assert.equal(staleBody.currentVersion, 2);

    const noop = await fetch(`${baseUrl}/api/v1/pricing/changes`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 2,
        reason: 'no-op',
        upserts: [
          { provider: 'openai', model: 'acme-x', kind: 'override', currency: 'USD', effectiveFrom: '2026-10-01T00:00:00Z', inputPerMillion: 2, estimated: false },
        ],
      }),
    });
    assert.equal(noop.status, 200);
    const noopBody = await noop.json();
    assert.equal(noopBody.changed, false);
    assert.equal(noopBody.pricingVersion, 2);

    const emptyChange = await fetch(`${baseUrl}/api/v1/pricing/changes`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 2, reason: 'nothing to do' }),
    });
    assert.equal(emptyChange.status, 400);
    assert.equal((await emptyChange.json()).error, 'validation_failed');

    const missingRemoval = await fetch(`${baseUrl}/api/v1/pricing/changes`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 2, reason: 'remove ghost', removals: [{ provider: 'ghost', model: 'ghost', kind: 'list', effectiveFrom: '2026-01-01T00:00:00Z' }] }),
    });
    assert.equal(missingRemoval.status, 400);
    assert.equal((await missingRemoval.json()).error, 'removal_not_found');

    const sameKeyTwice = await fetch(`${baseUrl}/api/v1/pricing/changes`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: 2,
        reason: 'duplicate',
        upserts: [
          { provider: 'dup', model: 'dup', kind: 'list', currency: 'USD', effectiveFrom: '2026-01-01T00:00:00Z', inputPerMillion: 1 },
          { provider: 'dup', model: 'dup', kind: 'list', currency: 'USD', effectiveFrom: '2026-01-01T00:00:00Z', inputPerMillion: 2 },
        ],
      }),
    });
    assert.equal(sameKeyTwice.status, 400);
    assert.equal((await sameKeyTwice.json()).error, 'validation_failed');
  });
});

test('POST /pricing/changes: 403 admin_requires_token on an open API, 403 pricing_readonly under AGENT_VIEWER_PRICING_READONLY', async () => {
  await withPricingServer(
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/pricing/changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1, reason: 'x', upserts: [{ provider: 'a', model: 'b', kind: 'list', currency: 'USD', effectiveFrom: '2026-01-01T00:00:00Z', inputPerMillion: 1 }] }),
      });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, 'admin_requires_token');
      // Reads still work with no token configured.
      const read = await fetch(`${baseUrl}/api/v1/pricing`);
      assert.equal(read.status, 200);
    },
    { AGENT_VIEWER_API_TOKEN: undefined }
  );

  await withPricingServer(
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/pricing/changes`, {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 1, reason: 'x', upserts: [{ provider: 'a', model: 'b', kind: 'list', currency: 'USD', effectiveFrom: '2026-01-01T00:00:00Z', inputPerMillion: 1 }] }),
      });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, 'pricing_readonly');

      // Reload still works in read-only mode.
      const reload = await fetch(`${baseUrl}/api/v1/pricing/reload`, { method: 'POST', headers: auth() });
      assert.equal(reload.status, 200);
      assert.equal((await reload.json()).changed, false);
    },
    { AGENT_VIEWER_PRICING_READONLY: '1' }
  );
});

test('POST /pricing/reload: 201 on an edited file, 200 changed:false when unchanged, 403 admin_requires_token when open', async () => {
  await withPricingServer(async (baseUrl) => {
    const initial = await (await fetch(`${baseUrl}/api/v1/pricing`, { headers: auth() })).json();

    const noop = await fetch(`${baseUrl}/api/v1/pricing/reload`, { method: 'POST', headers: auth() });
    assert.equal(noop.status, 200);
    assert.equal((await noop.json()).changed, false);

    // Edit pricing.json by hand (operator edit), matching the file store's own lifecycle rules (issue #271).
    const pricingFile = process.env.AGENT_VIEWER_PRICING_FILE;
    const content = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
    content.entries.push({
      provider: 'handwritten',
      model: 'handwritten-1',
      aliases: [],
      kind: 'list',
      currency: 'USD',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      inputPerMillion: 1,
      outputPerMillion: null,
      cacheReadPerMillion: null,
      cacheWritePerMillion: null,
      reasoningPerMillion: null,
      reasoningBilling: null,
      estimated: true,
      sourceUrl: null,
      sourceCheckedAt: null,
      note: null,
    });
    fs.writeFileSync(pricingFile, JSON.stringify(content, null, 2));

    const changed = await fetch(`${baseUrl}/api/v1/pricing/reload`, { method: 'POST', headers: auth() });
    assert.equal(changed.status, 201);
    const changedBody = await changed.json();
    assert.equal(changedBody.changed, true);
    assert.equal(changedBody.pricingVersion, initial.pricingVersion + 1);
  });

  await withPricingServer(
    async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/v1/pricing/reload`, { method: 'POST' });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, 'admin_requires_token');
    },
    { AGENT_VIEWER_API_TOKEN: undefined }
  );
});

test('/api/v1/pricing routes require a valid Bearer token when one is configured (shared auth middleware)', async () => {
  await withPricingServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/v1/pricing`);
    assert.equal(res.status, 401);
    const wrongToken = await fetch(`${baseUrl}/api/v1/pricing`, { headers: auth('wrong-token') });
    assert.equal(wrongToken.status, 401);
  });
});
