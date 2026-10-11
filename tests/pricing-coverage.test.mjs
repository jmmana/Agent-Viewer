// Issue #83 (sub-issue #272): GET /api/v1/pricing/coverage against ledger fixtures (needs #65, already closed).
// Seeds the real usage ledger through `store.append` (like tests/usage-rollup.test.mjs) and checks that the
// endpoint lists exactly the priced-vs-unpriced models, counts rows with no model separately, and is empty when
// everything resolves to a price.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, store } from '../server/index.ts';
import { resetPricingStoreForTests } from '../server/pricing/store.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';

const TOKEN = 'test-pricing-coverage-token';

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

let eventCounter = 0;
function usageEvent({ provider, model, occurredAt }) {
  eventCounter++;
  const result = validateCanonicalEvent({
    id: `evt_coverage_${eventCounter}`,
    type: 'llm.usage',
    timestamp: occurredAt,
    source: 'agent:test',
    agentId: 'agent-1',
    summary: 'test call',
    payload: {
      provider,
      model,
      inputTokens: 10,
      outputTokens: 5,
      cost: null,
      currency: null,
      costSource: 'unknown',
      requestId: `req_coverage_${eventCounter}`,
      tags: [],
    },
  });
  if (!result.success) throw new Error(`invalid test event: ${JSON.stringify(result.issues)}`);
  return result.data;
}

/** `llm.usage`'s `provider`/`model` are both required, non-empty strings at the contract level: a ledger row
 * with `model: null` can only come from an `llm.failed` event, whose `model` is optional (issue #59, e.g. a
 * connection failure before a model was chosen). `provider` stays required even there, so "no provider" is not
 * reachable through the event contract; this fixture covers the one case that is. */
function failedEventWithNoModel({ provider, occurredAt }) {
  eventCounter++;
  const result = validateCanonicalEvent({
    id: `evt_coverage_failed_${eventCounter}`,
    type: 'llm.failed',
    timestamp: occurredAt,
    source: 'agent:test',
    agentId: 'agent-1',
    summary: 'test failure',
    payload: {
      provider,
      errorKind: 'unknown',
      requestId: `req_coverage_failed_${eventCounter}`,
      tags: [],
    },
  });
  if (!result.success) throw new Error(`invalid test event: ${JSON.stringify(result.issues)}`);
  return result.data;
}

test('GET /pricing/coverage lists unpriced models, counts rows without a model, and is empty when all priced', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-pricing-coverage-'));
  await withEnv(
    {
      AGENT_VIEWER_PRICING_FILE: path.join(dir, 'pricing.json'),
      AGENT_VIEWER_PRICING_HISTORY_FILE: path.join(dir, 'pricing-history.jsonl'),
      AGENT_VIEWER_API_TOKEN: TOKEN,
      AGENT_VIEWER_API_KEY: undefined,
    },
    async () => {
      resetPricingStoreForTests();
      const { server, baseUrl } = await startTestServer();
      const headers = { Authorization: `Bearer ${TOKEN}` };
      try {
        // Price "acme/acme-1" explicitly; leave "mystery/model-9" unpriced; one row with no model at all.
        await fetch(`${baseUrl}/api/v1/pricing/changes`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedVersion: 1,
            reason: 'price acme for coverage test',
            upserts: [{ provider: 'acme', model: 'acme-1', kind: 'list', currency: 'USD', effectiveFrom: '2020-01-01T00:00:00Z', inputPerMillion: 1 }],
          }),
        });

        const baseTs = 1_800_000_000_000;
        await store.append(usageEvent({ provider: 'acme', model: 'acme-1', occurredAt: baseTs }));
        await store.append(usageEvent({ provider: 'acme', model: 'acme-1', occurredAt: baseTs + 1000 }));
        await store.append(usageEvent({ provider: 'mystery', model: 'model-9', occurredAt: baseTs + 2000 }));
        await store.append(usageEvent({ provider: 'mystery', model: 'model-9', occurredAt: baseTs + 3000 }));
        await store.append(usageEvent({ provider: 'mystery', model: 'model-9', occurredAt: baseTs + 4000 }));
        await store.append(failedEventWithNoModel({ provider: 'incident', occurredAt: baseTs + 5000 }));

        const res = await fetch(`${baseUrl}/api/v1/pricing/coverage`, { headers });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.pricingVersion, 2);
        assert.equal(body.truncated, false);
        assert.equal(body.withoutModel.calls, 1);
        assert.equal(body.unpriced.length, 1);
        assert.equal(body.unpriced[0].provider, 'mystery');
        assert.equal(body.unpriced[0].model, 'model-9');
        assert.equal(body.unpriced[0].calls, 3);
        assert.ok(body.unpriced.every((row) => row.provider !== 'acme'));

        // Now price "mystery/model-9" too: coverage must become empty (acme rows already priced).
        await fetch(`${baseUrl}/api/v1/pricing/changes`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedVersion: 2,
            reason: 'price mystery for coverage test',
            upserts: [{ provider: 'mystery', model: 'model-9', kind: 'list', currency: 'USD', effectiveFrom: '2020-01-01T00:00:00Z', inputPerMillion: 2 }],
          }),
        });
        const fullyPriced = await (await fetch(`${baseUrl}/api/v1/pricing/coverage`, { headers })).json();
        assert.deepEqual(fullyPriced.unpriced, []);
        assert.equal(fullyPriced.withoutModel.calls, 1);
      } finally {
        server.close();
        resetPricingStoreForTests();
      }
    }
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
