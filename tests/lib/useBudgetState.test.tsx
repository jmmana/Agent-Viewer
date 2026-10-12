/**
 * Tests for `useBudgetState` (issue #334): fetches once `serverApi` is available and the tab is open, refreshes
 * every 30s, throttles a trailing refresh after a new `llm.usage` event to at most one request per 5s, marks a
 * failed refresh stale while keeping the last good data, and never lets a stale (out-of-order) response
 * overwrite a newer one.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBudgetState, BUDGET_STATE_REFRESH_INTERVAL_MS, BUDGET_STATE_EVENT_THROTTLE_MS } from '../../src/integrations/useBudgetState';
import { createServerApi, type ServerApi } from '../../src/integrations/serverApi';
import type { ViewerEvent } from '../../src/types/agent';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function budgetView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    name: 'Monthly ceiling',
    scope: { type: 'all', value: null },
    period: 'month',
    timezone: 'UTC',
    currency: 'USD',
    basis: 'reported',
    limit: 100,
    warningRatio: 0.8,
    enabled: true,
    revision: 1,
    createdAt: 1000,
    updatedAt: 1000,
    status: null,
    ...overrides,
  };
}

function budgetsBody(budgets: unknown[] = [], generatedAt = 5000) {
  return { schemaVersion: '1.0', generatedAt, count: budgets.length, budgets };
}

function makeApi(fetchImpl: typeof fetch): ServerApi {
  return createServerApi({ apiBase: 'https://server.example', getToken: async () => 'tok', fetchImpl });
}

function usageEvent(id: string): ViewerEvent {
  return {
    id,
    type: 'llm.usage',
    timestamp: Date.now(),
    source: 'agent:demo',
    severity: 'normal',
    summary: 'demo',
    payload: {},
  } as ViewerEvent;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useBudgetState', () => {
  it('makes no request when serverApi is null', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, budgetsBody()));
    renderHook(() => useBudgetState({ serverApi: null, isOpen: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches once serverApi becomes available and the tab opens', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, budgetsBody([budgetView()])));
    const api = makeApi(fetchMock);

    const { result, rerender } = renderHook(({ serverApi, isOpen }) => useBudgetState({ serverApi, isOpen }), {
      initialProps: { serverApi: null as ServerApi | null, isOpen: true },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ serverApi: api, isOpen: true });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.budgets).toHaveLength(1);
    expect(result.current.asOf).toBe(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not fetch while the tab is closed, and fetches once it opens', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, budgetsBody()));
    const api = makeApi(fetchMock);

    const { rerender } = renderHook(({ isOpen }) => useBudgetState({ serverApi: api, isOpen }), {
      initialProps: { isOpen: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ isOpen: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('refreshes on a 30s timer', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(200, budgetsBody()));
    const api = makeApi(fetchMock);

    renderHook(() => useBudgetState({ serverApi: api, isOpen: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BUDGET_STATE_REFRESH_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BUDGET_STATE_REFRESH_INTERVAL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throttles a refresh after an llm.usage event to at most one request per 5s, trailing', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(200, budgetsBody()));
    const api = makeApi(fetchMock);

    const seedEvent = usageEvent('evt-seed');
    const { rerender } = renderHook(({ events }) => useBudgetState({ serverApi: api, isOpen: true, events }), {
      initialProps: { events: [seedEvent] as ViewerEvent[] },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsAfterOpen = fetchMock.mock.calls.length;
    expect(callsAfterOpen).toBe(1);

    // The seed event was already present on mount: it must not itself trigger a refetch.
    rerender({ events: [seedEvent] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterOpen);

    // Two new events arrive close together, well inside the 5s throttle window: only one trailing request fires.
    const eventA = usageEvent('evt-a');
    rerender({ events: [seedEvent, eventA] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterOpen);

    const eventB = usageEvent('evt-b');
    rerender({ events: [seedEvent, eventA, eventB] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // Still inside the 5s window since the first fetch: no extra request yet, and no second timer was started.
    expect(fetchMock.mock.calls.length).toBe(callsAfterOpen);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BUDGET_STATE_EVENT_THROTTLE_MS);
    });
    // Exactly one trailing request for both events combined.
    expect(fetchMock.mock.calls.length).toBe(callsAfterOpen + 1);
  });

  it('marks the state stale on a failed refresh and keeps the last good budgets (never clears colors)', async () => {
    let shouldFail = false;
    const fetchMock = vi.fn(async () => {
      if (shouldFail) return jsonResponse(500, { error: 'boom' });
      return jsonResponse(200, budgetsBody([budgetView({ status: { state: 'ok', window: { start: 0, end: 1 }, spent: 10, spentComplete: true, knownSpent: 10, breakdown: { reported: 10, estimated: 0 }, containsEstimates: false, limitRemaining: 90, ratio: 0.1, calls: { total: 1, withCost: 1, unknownCost: 0, otherCurrency: 0, missingCurrency: 0 }, unknownReasons: [], pricingVersions: [1], evaluatedAt: 1234 } })]));
    });
    const api = makeApi(fetchMock);

    const { result } = renderHook(() => useBudgetState({ serverApi: api, isOpen: true }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.budgets).toHaveLength(1);
    expect(result.current.stale).toBe(false);

    shouldFail = true;
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.stale).toBe(true));
    // Status stays "ready" (never regresses once a success has landed) and the budget list is untouched.
    expect(result.current.status).toBe('ready');
    expect(result.current.budgets).toHaveLength(1);
    expect(result.current.budgets[0].status?.state).toBe('ok');
    expect(result.current.errorMessage).toBeTruthy();
  });

  it('an initial fetch that fails (no prior data) reports "error", not "ready"', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    const api = makeApi(fetchMock);

    const { result } = renderHook(() => useBudgetState({ serverApi: api, isOpen: true }));
    await waitFor(() => expect(result.current.stale).toBe(true));
    expect(result.current.status).toBe('error');
    expect(result.current.budgets).toEqual([]);
  });

  it('drops a stale response: a slow first fetch never overwrites a newer refresh', async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) return first;
      return jsonResponse(200, budgetsBody([budgetView({ id: 'fresh', name: 'Fresh data' })]));
    });
    const api = makeApi(fetchMock);

    const { result } = renderHook(() => useBudgetState({ serverApi: api, isOpen: true }));
    await waitFor(() => expect(callCount).toBe(1));

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.budgets[0]?.id).toBe('fresh');

    // The slow first response now resolves, late. It must not overwrite the newer, already-applied data.
    resolveFirst(jsonResponse(200, budgetsBody([budgetView({ id: 'stale', name: 'Stale data' })])));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.budgets[0]?.id).toBe('fresh');
  });

  it('refresh() fetches immediately, independent of the timers', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, budgetsBody()));
    const api = makeApi(fetchMock);

    const { result } = renderHook(() => useBudgetState({ serverApi: api, isOpen: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
