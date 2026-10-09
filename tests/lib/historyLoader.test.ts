/**
 * Tests for the live portal's history loader (issue #72): loads `GET /api/v1/snapshot`, then pages further back
 * with `GET /api/v1/events?beforeId=...` up to `maxEvents`, before the caller ever subscribes to the stream.
 */
import { describe, expect, it } from 'vitest';
import { loadLiveHistory, parseHistoryLimit, DEFAULT_HISTORY_LIMIT } from '../../src/integrations/historyLoader';
import type { LiveSnapshot } from '../../src/integrations/snapshotRebuild';
import { registered, messageSent, T0 } from './fixtures';

interface FetchCall {
  url: string;
  headers: Record<string, string> | undefined;
}

/** A minimal fetch mock: a list of handlers tried in order, first match answers. */
function createFetchMock(handlers: Array<{ match: RegExp; status?: number; body: unknown }>) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: init?.headers as Record<string, string> | undefined });
    const handler = handlers.find((h) => h.match.test(url));
    if (!handler) throw new Error(`Unexpected fetch call: ${url}`);
    const status = handler.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => handler.body,
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function emptySnapshot(overrides: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    lastEventId: null,
    events: [],
    agents: [],
    totalTokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    totalCost: 0,
    ...overrides,
  };
}

describe('parseHistoryLimit', () => {
  it('defaults to 1000 when absent, blank, non-numeric, non-integer or out of [1, 5000]', () => {
    expect(parseHistoryLimit(undefined)).toBe(DEFAULT_HISTORY_LIMIT);
    expect(parseHistoryLimit('')).toBe(DEFAULT_HISTORY_LIMIT);
    expect(parseHistoryLimit('not-a-number')).toBe(DEFAULT_HISTORY_LIMIT);
    expect(parseHistoryLimit('12.5')).toBe(DEFAULT_HISTORY_LIMIT);
    expect(parseHistoryLimit('0')).toBe(DEFAULT_HISTORY_LIMIT);
    expect(parseHistoryLimit('5001')).toBe(DEFAULT_HISTORY_LIMIT);
    expect(parseHistoryLimit('-5')).toBe(DEFAULT_HISTORY_LIMIT);
  });

  it('accepts any integer in [1, 5000]', () => {
    expect(parseHistoryLimit('1')).toBe(1);
    expect(parseHistoryLimit('2500')).toBe(2500);
    expect(parseHistoryLimit('5000')).toBe(5000);
  });
});

describe('loadLiveHistory', () => {
  it('on an empty server, loads only the snapshot: no events to page, lastEventId null', async () => {
    const { fetchImpl, calls } = createFetchMock([
      { match: /\/api\/v1\/snapshot$/, body: emptySnapshot() },
    ]);

    const result = await loadLiveHistory('https://server.example', { fetch: fetchImpl });

    expect(calls).toHaveLength(1);
    expect(result.lastEventId).toBeNull();
    expect(result.state.events).toHaveLength(0);
  });

  it('sends Authorization: Bearer <token> on the snapshot and every paging request', async () => {
    const snapshot = emptySnapshot({
      lastEventId: 'evt-1',
      events: [registered('ana', 'Ana', {}, { id: 'evt-1', at: T0 })],
    });
    const { fetchImpl, calls } = createFetchMock([
      { match: /\/api\/v1\/snapshot$/, body: snapshot },
      { match: /\/api\/v1\/events\?/, body: { events: [], hasMore: false, nextBeforeId: null } },
    ]);

    await loadLiveHistory('https://server.example', { fetch: fetchImpl, token: 'tok-123', maxEvents: 50 });

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.headers?.Authorization).toBe('Bearer tok-123');
    }
  });

  it('pages backward with beforeId until hasMore is false, stopping at maxEvents', async () => {
    const snapshotEvent = registered('ana', 'Ana', {}, { id: 'evt-snap-1', at: T0 + 100 });
    const snapshot = emptySnapshot({ lastEventId: 'evt-snap-1', events: [snapshotEvent] });
    const page1 = [messageSent('ana', 'm2', {}, { id: 'evt-page-2', at: T0 + 20 }), messageSent('ana', 'm1', {}, { id: 'evt-page-1', at: T0 + 10 })];
    const page2 = [messageSent('ana', 'm0', {}, { id: 'evt-page-0', at: T0 })];
    const requestedUrls: string[] = [];

    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      requestedUrls.push(url);
      if (/\/api\/v1\/snapshot$/.test(url)) {
        return { ok: true, status: 200, json: async () => snapshot } as Response;
      }
      if (url.includes('beforeId=evt-snap-1')) {
        return { ok: true, status: 200, json: async () => ({ events: page1, hasMore: true, nextBeforeId: 'evt-page-1' }) } as Response;
      }
      if (url.includes('beforeId=evt-page-1')) {
        return { ok: true, status: 200, json: async () => ({ events: page2, hasMore: false, nextBeforeId: null }) } as Response;
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }) as typeof fetch;

    const result = await loadLiveHistory('https://server.example', { fetch: fetchImpl, maxEvents: 50 });

    expect(requestedUrls).toHaveLength(3);
    expect(result.state.events.map((e) => e.id)).toEqual(['evt-snap-1', 'evt-page-2', 'evt-page-1', 'evt-page-0']);
    expect(result.lastEventId).toBe('evt-snap-1');
  });

  it('a failed page (for example invalid_cursor) stops paging and keeps whatever was already loaded', async () => {
    const snapshotEvent = registered('ana', 'Ana', {}, { id: 'evt-snap-1', at: T0 + 100 });
    const snapshot = emptySnapshot({ lastEventId: 'evt-snap-1', events: [snapshotEvent] });
    const page1 = [messageSent('ana', 'm1', {}, { id: 'evt-page-1', at: T0 + 10 })];

    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (/\/api\/v1\/snapshot$/.test(url)) {
        return { ok: true, status: 200, json: async () => snapshot } as Response;
      }
      if (url.includes('beforeId=evt-snap-1')) {
        return { ok: true, status: 200, json: async () => ({ events: page1, hasMore: true, nextBeforeId: 'evt-page-1' }) } as Response;
      }
      if (url.includes('beforeId=evt-page-1')) {
        return { ok: false, status: 400, json: async () => ({ error: 'invalid_cursor' }) } as Response;
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    }) as typeof fetch;

    const result = await loadLiveHistory('https://server.example', { fetch: fetchImpl, maxEvents: 50 });

    expect(result.state.events.map((e) => e.id)).toEqual(['evt-snap-1', 'evt-page-1']);
  });

  it('stops paging once maxEvents is reached, never fetching more than needed', async () => {
    const snapshotEvent = registered('ana', 'Ana', {}, { id: 'evt-snap-1', at: T0 + 100 });
    const snapshot = emptySnapshot({ lastEventId: 'evt-snap-1', events: [snapshotEvent] });
    let pageRequests = 0;

    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (/\/api\/v1\/snapshot$/.test(url)) {
        return { ok: true, status: 200, json: async () => snapshot } as Response;
      }
      pageRequests++;
      // Exactly one event short of maxEvents is left (snapshot already has 1, maxEvents is 2): the page must
      // ask for a `limit` of 1, never the full page size, and the loop must stop once that single event lands,
      // even though this handler would keep saying hasMore: true forever.
      expect(url).toContain('limit=1');
      return {
        ok: true,
        status: 200,
        json: async () => ({ events: [messageSent('ana', 'm', {}, { id: `evt-extra-${pageRequests}`, at: T0 })], hasMore: true, nextBeforeId: `evt-extra-${pageRequests}` }),
      } as Response;
    }) as typeof fetch;

    const result = await loadLiveHistory('https://server.example', { fetch: fetchImpl, maxEvents: 2 });

    expect(pageRequests).toBe(1);
    expect(result.state.events).toHaveLength(2);
  });

  it('an old server with no beforeId support (no hasMore in the response) stops after the first page', async () => {
    const snapshotEvent = registered('ana', 'Ana', {}, { id: 'evt-snap-1', at: T0 + 100 });
    const snapshot = emptySnapshot({ lastEventId: 'evt-snap-1', events: [snapshotEvent] });
    const { fetchImpl, calls } = createFetchMock([
      { match: /\/api\/v1\/snapshot$/, body: snapshot },
      // No hasMore/nextBeforeId fields at all: the old GET /api/v1/events response shape.
      { match: /\/api\/v1\/events\?/, body: { events: [messageSent('ana', 'm', {}, { id: 'evt-old-server', at: T0 })] } },
    ]);

    const result = await loadLiveHistory('https://server.example', { fetch: fetchImpl, maxEvents: 50 });

    expect(calls).toHaveLength(2);
    expect(result.state.events.map((e) => e.id)).toEqual(['evt-snap-1', 'evt-old-server']);
  });

  it('a snapshot failure propagates, so the caller can show an error and retry instead of a partial history', async () => {
    const { fetchImpl } = createFetchMock([{ match: /\/api\/v1\/snapshot$/, status: 500, body: { error: 'internal' } }]);

    await expect(loadLiveHistory('https://server.example', { fetch: fetchImpl })).rejects.toThrow();
  });

  it('strips a trailing slash from apiBase before building request URLs', async () => {
    const { fetchImpl, calls } = createFetchMock([{ match: /\/api\/v1\/snapshot$/, body: emptySnapshot() }]);

    await loadLiveHistory('https://server.example/', { fetch: fetchImpl });

    expect(calls[0].url).toBe('https://server.example/api/v1/snapshot');
  });
});
