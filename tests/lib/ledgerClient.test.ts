/**
 * Tests for the Model Ops ledger client (issue #79): response validation, status-code mapping, auth header and
 * query-string shape over `GET /api/v1/usage/rollup` (#66) and `GET /api/v1/usage/calls` (#67).
 */
import { describe, expect, it, vi } from 'vitest';
import { fetchCalls, fetchRollup, FAILED_CALL_STATUSES } from '../../src/integrations/ledgerClient';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_ROLLUP = {
  schemaVersion: '1.0',
  asOf: { ledgerSeq: 12, lastRowReceivedAt: 1000, generatedAt: 2000 },
  coverage: { storage: 'memory', complete: true, droppedRows: 0, purgedThrough: null, backfilledRows: 0, legacyContractRows: 0 },
  groupsAreAdditive: true,
  groupCount: 1,
  truncated: false,
  groups: [
    {
      key: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      calls: { total: 10, succeeded: 9, failed: 1 },
      tokens: {
        input: { sum: 100, reportedCalls: 10, unreportedCalls: 0 },
        output: { sum: 50, reportedCalls: 10, unreportedCalls: 0 },
        cacheRead: { sum: null, reportedCalls: 0, unreportedCalls: 10 },
        cacheWrite: { sum: null, reportedCalls: 0, unreportedCalls: 10 },
        reasoning: { sum: null, reportedCalls: 0, unreportedCalls: 10 },
      },
      cost: { entries: [{ currency: 'USD', costSource: 'provider-reported', sum: 1.5, calls: 9 }], unknownCostCalls: 1 },
      firstAt: 100,
      lastAt: 200,
    },
  ],
  totals: {
    calls: { total: 10, succeeded: 9, failed: 1 },
    tokens: {
      input: { sum: 100, reportedCalls: 10, unreportedCalls: 0 },
      output: { sum: 50, reportedCalls: 10, unreportedCalls: 0 },
      cacheRead: { sum: null, reportedCalls: 0, unreportedCalls: 10 },
      cacheWrite: { sum: null, reportedCalls: 0, unreportedCalls: 10 },
      reasoning: { sum: null, reportedCalls: 0, unreportedCalls: 10 },
    },
    cost: { entries: [{ currency: 'USD', costSource: 'provider-reported', sum: 1.5, calls: 9 }], unknownCostCalls: 1 },
    firstAt: 100,
    lastAt: 200,
  },
};

const VALID_CALLS = {
  schemaVersion: '1.0',
  asOf: 2000,
  storage: 'memory',
  data: [
    {
      seq: 1,
      eventId: 'evt_1',
      type: 'llm.usage',
      status: 'ok',
      backfilled: false,
      occurredAt: 100,
      receivedAt: 150,
      agentId: 'agent-1',
      sessionId: null,
      runtimeId: null,
      taskId: null,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      tokens: { input: 10, output: 5, cacheRead: null, cacheWrite: null, reasoning: null },
      latencyMs: 400,
      requestId: null,
      cost: 0.01,
      currency: 'USD',
      costSource: 'provider-reported',
      errorCode: null,
      trace: { traceId: null, parentId: null, toolCallId: null, meetingId: null },
      userId: null,
      tags: [],
    },
  ],
  page: { limit: 50, order: 'desc', hasMore: false, nextCursor: null },
};

describe('fetchRollup', () => {
  it('sends Authorization: Bearer <token>, never a token in the URL, and parses a valid response', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).not.toContain('tok-123');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
      return jsonResponse(200, VALID_ROLLUP);
    });
    const result = await fetchRollup('https://server.example', 'tok-123', { groupBy: ['provider', 'model'] }, fetchMock as unknown as typeof fetch);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.data.groups[0].key.provider).toBe('anthropic');
      expect(result.data.totals.calls.total).toBe(10);
    }
  });

  it('sends no Authorization header when no token is given', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      return jsonResponse(200, VALID_ROLLUP);
    });
    await fetchRollup('https://server.example', undefined, { groupBy: ['provider'] }, fetchMock as unknown as typeof fetch);
  });

  it('builds groupBy as a single comma-joined parameter', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toContain('groupBy=provider%2Cmodel');
      return jsonResponse(200, VALID_ROLLUP);
    });
    await fetchRollup('https://server.example/', undefined, { groupBy: ['provider', 'model'] }, fetchMock as unknown as typeof fetch);
  });

  it('maps 404 and 501 to "unavailable" (server predates the ledger)', async () => {
    const fetchImpl = async () => jsonResponse(404, { error: 'not_found' });
    const result = await fetchRollup('https://server.example', undefined, { groupBy: ['provider'] }, fetchImpl as unknown as typeof fetch);
    expect(result.kind).toBe('unavailable');

    const fetchImpl501 = async () => jsonResponse(501, {});
    const result501 = await fetchRollup('https://server.example', undefined, { groupBy: ['provider'] }, fetchImpl501 as unknown as typeof fetch);
    expect(result501.kind).toBe('unavailable');
  });

  it('maps 401 to "unauthorized"', async () => {
    const fetchImpl = async () => jsonResponse(401, { error: 'unauthorized' });
    const result = await fetchRollup('https://server.example', undefined, { groupBy: ['provider'] }, fetchImpl as unknown as typeof fetch);
    expect(result.kind).toBe('unauthorized');
  });

  it('rejects a malformed payload as "error" instead of throwing', async () => {
    const fetchImpl = async () => jsonResponse(200, { schemaVersion: '1.0' });
    const result = await fetchRollup('https://server.example', undefined, { groupBy: ['provider'] }, fetchImpl as unknown as typeof fetch);
    expect(result.kind).toBe('error');
  });

  it('turns a network failure into an "error" result, never a thrown exception', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await fetchRollup('https://server.example', undefined, { groupBy: ['provider'] }, fetchImpl as unknown as typeof fetch);
    expect(result.kind).toBe('error');
  });
});

describe('fetchCalls', () => {
  it('parses a valid calls page and forwards the cursor and status list', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('cursor')).toBe('abc');
      expect(parsed.searchParams.getAll('status')).toEqual(FAILED_CALL_STATUSES as string[]);
      return jsonResponse(200, VALID_CALLS);
    });
    const result = await fetchCalls(
      'https://server.example',
      'tok',
      { cursor: 'abc', status: [...FAILED_CALL_STATUSES] },
      fetchMock as unknown as typeof fetch
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.data.data).toHaveLength(1);
      expect(result.data.data[0].eventId).toBe('evt_1');
      expect(result.data.page.nextCursor).toBeNull();
    }
  });

  it('same-origin base: trims a trailing slash before building the URL', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toBe('https://server.example/api/v1/usage/calls?limit=50');
      return jsonResponse(200, VALID_CALLS);
    });
    await fetchCalls('https://server.example/', undefined, { limit: 50 }, fetchMock as unknown as typeof fetch);
  });

  it('forwards from/to as pass-through query params, same convention as fetchRollup (issue #78)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('from')).toBe('1000');
      expect(parsed.searchParams.get('to')).toBe('2000');
      return jsonResponse(200, VALID_CALLS);
    });
    await fetchCalls(
      'https://server.example',
      'tok',
      { agentId: ['atlas'], from: 1000, to: 2000 },
      fetchMock as unknown as typeof fetch
    );
  });

  it('omits from/to entirely when not given ("All time")', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.has('from')).toBe(false);
      expect(parsed.searchParams.has('to')).toBe(false);
      return jsonResponse(200, VALID_CALLS);
    });
    await fetchCalls('https://server.example', 'tok', { agentId: ['atlas'] }, fetchMock as unknown as typeof fetch);
  });
});
