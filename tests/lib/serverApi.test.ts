/**
 * Tests for the portal's REST client (issue #88, sub-issue #332): auth header only (never a query-string
 * token), the error taxonomy (`unauthorized | forbidden | not_found | conflict | invalid | network | contract`),
 * the runtime validator's "null stays null" and "unknown state maps to unknown, never ok" rules, and the
 * `Idempotency-Key` header on writes.
 *
 * Fixtures mirror the real, shipped server shapes (`server/pricing/api.ts`'s `GET /api/v1/pricing` and
 * `POST /api/v1/pricing/changes`, `server/budgets.ts`'s `GET/POST/PUT/DELETE /api/v1/budgets`), not the
 * issue's own illustrative sketch (see the module doc comment in `src/integrations/serverApi.ts` for the
 * adaptation, the same kind #319 made for `budget.alert` vs #86's draft).
 */
import { describe, expect, it, vi } from 'vitest';
import { createServerApi } from '../../src/integrations/serverApi';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_PRICE_ENTRY = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  aliases: [],
  kind: 'list',
  currency: 'USD',
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  inputPerMillion: 3.0,
  outputPerMillion: 15.0,
  cacheReadPerMillion: 0.3,
  cacheWritePerMillion: 3.75,
  reasoningPerMillion: null,
  reasoningBilling: null,
  source: 'api',
  estimated: false,
  sourceUrl: null,
  sourceCheckedAt: null,
  note: null,
};

const VALID_PRICING_RESPONSE = {
  schema: 'agent-viewer.pricing/1',
  status: 'ok',
  issues: [],
  pricingVersion: 7,
  contentHash: `sha256:${'a'.repeat(64)}`,
  createdAt: '2026-10-08T14:02:11.000Z',
  estimated: false,
  starter: { bundledAsOf: '2026-01-01', appliedAsOf: '2026-01-01', updateAvailable: false },
  readonly: false,
  fileInSync: true,
  entries: [VALID_PRICE_ENTRY],
};

const VALID_BUDGET_VIEW = {
  id: 'bud_01HZ',
  name: 'Backend agent monthly',
  scope: { type: 'agent', value: 'backend-agent' },
  period: 'month',
  timezone: 'UTC',
  currency: 'USD',
  basis: 'reported',
  limit: 50,
  warningRatio: 0.8,
  enabled: true,
  revision: 1,
  createdAt: 1000,
  updatedAt: 1000,
  status: {
    state: 'warning',
    window: { start: 1000, end: 2000 },
    spent: 41.2,
    spentComplete: true,
    knownSpent: 41.2,
    breakdown: { reported: 41.2, estimated: 0 },
    containsEstimates: false,
    limitRemaining: 8.8,
    ratio: 0.824,
    calls: { total: 10, withCost: 10, unknownCost: 0, otherCurrency: 0, missingCurrency: 0 },
    unknownReasons: [],
    pricingVersions: [],
    evaluatedAt: 2000,
  },
};

const VALID_BUDGET_VIEW_UNKNOWN_STATE = {
  ...VALID_BUDGET_VIEW,
  id: 'bud_01J0',
  name: 'QA agent monthly',
  scope: { type: 'agent', value: 'qa-agent' },
  status: {
    ...VALID_BUDGET_VIEW.status,
    state: 'unknown',
    spent: null,
    knownSpent: 0,
    breakdown: { reported: 0, estimated: 0 },
    limitRemaining: null,
    ratio: null,
    unknownReasons: ['unknown_cost'],
  },
};

const VALID_BUDGETS_RESPONSE = {
  schemaVersion: '1.0',
  generatedAt: 2000,
  count: 2,
  budgets: [VALID_BUDGET_VIEW, VALID_BUDGET_VIEW_UNKNOWN_STATE],
};

describe('createServerApi: auth header, never a query token', () => {
  it('sends Authorization: Bearer <token> and never a token in the URL', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).not.toContain('tok-123');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
      return jsonResponse(200, VALID_PRICING_RESPONSE);
    });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => 'tok-123', fetchImpl: fetchMock as unknown as typeof fetch });
    const result = await api.getPricing();
    expect(result.ok).toBe(true);
  });

  it('sends no Authorization header when getToken resolves to undefined', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
      return jsonResponse(200, VALID_BUDGETS_RESPONSE);
    });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl: fetchMock as unknown as typeof fetch });
    await api.getBudgets();
  });

  it('waits for token resolution before the first request', async () => {
    let resolveToken: (value: string | undefined) => void = () => {};
    const tokenPromise = new Promise<string | undefined>((resolve) => { resolveToken = resolve; });
    let requested = false;
    const fetchMock = vi.fn(async () => {
      requested = true;
      return jsonResponse(200, VALID_PRICING_RESPONSE);
    });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: () => tokenPromise, fetchImpl: fetchMock as unknown as typeof fetch });
    const pending = api.getPricing();
    await Promise.resolve();
    await Promise.resolve();
    expect(requested).toBe(false);
    resolveToken('tok-456');
    const result = await pending;
    expect(requested).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe('createServerApi: validator rules', () => {
  it('parses a valid pricing response, preserving null price fields', async () => {
    const fetchImpl = async () => jsonResponse(200, VALID_PRICING_RESPONSE);
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl });
    const result = await api.getPricing();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.entries[0].reasoningPerMillion).toBeNull();
  });

  it('maps an unrecognized budget state to "unknown", never "ok", and logs a contract warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const weird = {
      ...VALID_BUDGETS_RESPONSE,
      budgets: [{ ...VALID_BUDGET_VIEW, status: { ...VALID_BUDGET_VIEW.status, state: 'totally-fine' } }],
    };
    const fetchImpl = async () => jsonResponse(200, weird);
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl });
    const result = await api.getBudgets();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.budgets[0].status?.state).toBe('unknown');
    expect(result.data.budgets[0].status?.state).not.toBe('ok');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('keeps a budget spent/ratio of null as null, never coerced to 0', async () => {
    const fetchImpl = async () => jsonResponse(200, VALID_BUDGETS_RESPONSE);
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl });
    const result = await api.getBudgets();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const unknownBudget = result.data.budgets.find((b) => b.id === 'bud_01J0');
    expect(unknownBudget?.status?.spent).toBeNull();
    expect(unknownBudget?.status?.ratio).toBeNull();
  });

  it('rejects a wrong top-level shape as a "contract" error, never throwing', async () => {
    const fetchImpl = async () => jsonResponse(200, { schemaVersion: '1.0' });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl });
    const result = await api.getBudgets();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('contract');
  });

  it('rejects a non-JSON body as a "contract" error', async () => {
    const fetchImpl = async () => new Response('not json', { status: 200 });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl });
    const result = await api.getPricing();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('contract');
  });
});

describe('createServerApi: error mapping', () => {
  it('maps 401 to unauthorized', async () => {
    const fetchImpl = async () => jsonResponse(401, { error: 'unauthorized' });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => 'tok', fetchImpl });
    const result = await api.getBudgets();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unauthorized');
  });

  it('maps 403 to forbidden and keeps the server error code', async () => {
    const fetchImpl = async () => jsonResponse(403, { error: 'admin_requires_token' });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl });
    const result = await api.putPricingChanges({ expectedVersion: 7, reason: 'test', upserts: [], removals: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('forbidden');
    expect(result.code).toBe('admin_requires_token');
  });

  it('maps 404 to not_found', async () => {
    const fetchImpl = async () => jsonResponse(404, { error: 'budget_not_found' });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl });
    const result = await api.getBudget('bud_missing');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('not_found');
  });

  it('maps 409 to conflict and keeps currentVersion for a pricing version conflict', async () => {
    const fetchImpl = async () => jsonResponse(409, { error: 'version_conflict', currentVersion: 9 });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl });
    const result = await api.putPricingChanges({ expectedVersion: 7, reason: 'test', upserts: [], removals: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('conflict');
    expect(result.currentVersion).toBe(9);
  });

  it('maps 400 to invalid and keeps field issues', async () => {
    const fetchImpl = async () => jsonResponse(400, { error: 'validation_failed', issues: [{ path: 'limit', message: 'must be positive' }] });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl });
    const result = await api.createBudget({ name: 'x', scope: { type: 'all', value: null }, period: 'month', currency: 'USD', basis: 'reported', limit: -1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('invalid');
    expect(result.issues).toEqual([{ path: 'limit', message: 'must be positive' }]);
  });

  it('maps 422 to invalid as well', async () => {
    const fetchImpl = async () => jsonResponse(422, { error: 'validation_failed', issues: [] });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl });
    const result = await api.getPricing();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('invalid');
  });

  it('turns a thrown network failure into a "network" result, never a thrown exception', async () => {
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl });
    const result = await api.getBudgets();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('network');
  });

  it('maps a bare 500 to "network" (kept data stale, same as an unreachable server)', async () => {
    const fetchImpl = async () => jsonResponse(500, { error: 'internal' });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl });
    const result = await api.getBudgets();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('network');
  });
});

describe('createServerApi: Idempotency-Key on writes', () => {
  it('sends the same Idempotency-Key on createBudget when the caller supplies one (safe retry)', async () => {
    const seenKeys: (string | undefined)[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      seenKeys.push((init?.headers as Record<string, string>)['Idempotency-Key']);
      return jsonResponse(201, VALID_BUDGET_VIEW);
    });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl: fetchMock as unknown as typeof fetch });
    const input = { name: 'x', scope: { type: 'all' as const, value: null }, period: 'month' as const, currency: 'USD', basis: 'reported' as const, limit: 10 };
    await api.createBudget(input, { idempotencyKey: 'key-1' });
    await api.createBudget(input, { idempotencyKey: 'key-1' });
    expect(seenKeys).toEqual(['key-1', 'key-1']);
  });

  it('generates an Idempotency-Key automatically when the caller does not supply one', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
      return jsonResponse(201, VALID_BUDGET_VIEW);
    });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl: fetchMock as unknown as typeof fetch });
    await api.createBudget({ name: 'x', scope: { type: 'all', value: null }, period: 'month', currency: 'USD', basis: 'reported', limit: 10 });
  });

  it('sends Idempotency-Key on putPricingChanges', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
      return jsonResponse(200, { changed: true, pricingVersion: 8 });
    });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl: fetchMock as unknown as typeof fetch });
    await api.putPricingChanges({ expectedVersion: 7, reason: 'test', upserts: [], removals: [] });
  });

  it('never sends Idempotency-Key on a GET request', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string> | undefined)?.['Idempotency-Key']).toBeUndefined();
      return jsonResponse(200, VALID_BUDGETS_RESPONSE);
    });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl: fetchMock as unknown as typeof fetch });
    await api.getBudgets();
  });
});

describe('createServerApi: deleteBudget', () => {
  it('returns ok with no data on a 204', async () => {
    const fetchImpl = async () => new Response(null, { status: 204 });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => undefined, fetchImpl });
    const result = await api.deleteBudget('bud_01HZ');
    expect(result.ok).toBe(true);
  });
});
