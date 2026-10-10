/**
 * Tests for `useModelOpsLedger` (issue #79): fetches only while the modal is open, the three rollups of one
 * refresh share `from`/`to`, a stale response is dropped, a new real event id triggers a debounced refetch, an
 * already-seen id does not, and `loadMore` follows the cursor while de-duplicating by id.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useModelOpsLedger, type LedgerConnection } from '../../src/components/modelOps/useModelOpsLedger';
import type { ViewerEvent } from '../../src/types/agent';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function rollupBody(overrides: Partial<{ groupBy: string[] }> = {}) {
  return {
    schemaVersion: '1.0',
    asOf: { ledgerSeq: 1, lastRowReceivedAt: 1, generatedAt: Date.now() },
    coverage: { storage: 'memory', complete: true, droppedRows: 0, purgedThrough: null, backfilledRows: 0, legacyContractRows: 0 },
    groupsAreAdditive: true,
    groupCount: 0,
    truncated: false,
    groups: [],
    totals: {
      calls: { total: 0, succeeded: 0, failed: 0 },
      tokens: {
        input: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
        output: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
        cacheRead: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
        cacheWrite: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
        reasoning: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
      },
      cost: { entries: [], unknownCostCalls: 0 },
      firstAt: null,
      lastAt: null,
    },
    ...overrides,
  };
}

function callsBody(data: unknown[] = [], nextCursor: string | null = null) {
  return { schemaVersion: '1.0', asOf: Date.now(), storage: 'memory', data, page: { limit: 50, order: 'desc', hasMore: nextCursor !== null, nextCursor } };
}

function call(eventId: string, type: 'llm.usage' | 'llm.failed' = 'llm.usage'): ViewerEvent {
  return {
    id: eventId,
    type,
    timestamp: Date.now(),
    source: 'agent:demo',
    severity: 'normal',
    summary: 'demo',
    payload: {},
  };
}

const READY_LEDGER: LedgerConnection = { baseUrl: 'https://server.example', token: 'tok', tokenResolved: true };

describe('useModelOpsLedger', () => {
  it('makes no request while the modal is closed, and fetches once it opens', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, rollupBody()));
    const { rerender } = renderHook(
      ({ isOpen }) => useModelOpsLedger({ ledger: READY_LEDGER, isOpen, events: [], now: () => 1000 }),
      { initialProps: { isOpen: false } }
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ isOpen: true });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
    vi.unstubAllGlobals();
  });

  it('the three rollup requests of one refresh share the same from/to window', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse(200, rollupBody());
    });
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useModelOpsLedger({ ledger: READY_LEDGER, isOpen: true, events: [], now: () => 5_000_000 }));
    await waitFor(() => expect(urls.filter((u) => u.includes('/usage/rollup')).length).toBe(3));

    const parsed = urls.filter((u) => u.includes('/usage/rollup')).map((u) => new URL(u));
    const groupByValues = parsed.map((u) => u.searchParams.get('groupBy')).sort();
    expect(groupByValues).toEqual(['agent,model', 'provider', 'provider,model']);
    // "All time" (the default range): no `from` on any of the three.
    for (const u of parsed) expect(u.searchParams.has('from')).toBe(false);
    const toValues = new Set(parsed.map((u) => u.searchParams.get('to')));
    expect(toValues.size).toBe(1);

    vi.unstubAllGlobals();
  });

  it('drops a stale response: a slow first fetch never overwrites a newer retry', async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount <= 3) return first;
      return jsonResponse(200, rollupBody({ groupBy: [] }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useModelOpsLedger({ ledger: READY_LEDGER, isOpen: true, events: [] }));
    await waitFor(() => expect(callCount).toBeGreaterThanOrEqual(3));

    act(() => result.current.retry());
    await waitFor(() => expect(callCount).toBeGreaterThanOrEqual(6));
    await waitFor(() => expect(result.current.modelRollup.status).toBe('ready'));

    // The first (still-pending) response now resolves, late. It must not flip the state back to "loading" data.
    resolveFirst(jsonResponse(200, rollupBody({ groupBy: ['should-not-apply'] })));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.modelRollup.status).toBe('ready');

    vi.unstubAllGlobals();
  });

  it('a new, real llm.usage event id triggers a debounced refetch; an already-seen id does not', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(200, rollupBody()));
    vi.stubGlobal('fetch', fetchMock);

    const seedEvent = call('evt-seed');
    const { result, rerender } = renderHook(
      ({ events }) => useModelOpsLedger({ ledger: READY_LEDGER, isOpen: true, events, now: () => Date.now() }),
      { initialProps: { events: [seedEvent] } }
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsAfterOpen = fetchMock.mock.calls.length;

    // The seed event was already present when the hook entered ledger mode: it must not trigger a refetch.
    rerender({ events: [seedEvent] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterOpen);

    // A genuinely new event id debounces (1500ms) before refetching.
    const newEvent = call('evt-new-1');
    rerender({ events: [seedEvent, newEvent] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterOpen);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterOpen);

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('loadMoreFeed follows the cursor and de-duplicates by id', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/usage/calls')) {
        if (parsed.searchParams.get('cursor') === 'cursor-1') {
          return jsonResponse(200, callsBody([{ ...BASE_CALL, seq: 2, eventId: 'evt-1' }, { ...BASE_CALL, seq: 3, eventId: 'evt-2' }], null));
        }
        return jsonResponse(200, callsBody([{ ...BASE_CALL, seq: 1, eventId: 'evt-1' }], 'cursor-1'));
      }
      return jsonResponse(200, rollupBody());
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useModelOpsLedger({ ledger: READY_LEDGER, isOpen: true, events: [] }));
    await waitFor(() => expect(result.current.feed.calls.map((c) => c.eventId)).toEqual(['evt-1']));
    expect(result.current.feed.hasMore).toBe(true);

    act(() => result.current.loadMoreFeed());
    await waitFor(() => expect(result.current.feed.calls.map((c) => c.eventId)).toEqual(['evt-1', 'evt-2']));
    expect(result.current.feed.hasMore).toBe(false);

    vi.unstubAllGlobals();
  });

  it('simulated mode (ledger: null) never calls fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, rollupBody()));
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useModelOpsLedger({ ledger: null, isOpen: true, events: [] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

const BASE_CALL = {
  seq: 1,
  eventId: 'evt-1',
  type: 'llm.usage',
  status: 'ok',
  backfilled: false,
  occurredAt: 100,
  receivedAt: 150,
  agentId: null,
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
  tags: [] as string[],
};
