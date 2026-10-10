/**
 * Tests for `useLedgerAgentUsage` (issue #78): fetches `groupBy=agent` with the window's range, demo mode makes
 * no request, a stale response never overwrites a newer one, a new real usage/failed event id debounces a
 * refetch while an already-seen one does not, and the rolling-window clock poll only fires while visible.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLedgerAgentUsage } from '../../src/components/usage/useLedgerAgentUsage';
import type { LedgerConnection } from '../../src/components/modelOps/useModelOpsLedger';
import type { ViewerEvent } from '../../src/types/agent';
import type { UsageWindowOption } from '../../src/integrations/usageWindow';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function rollupBody() {
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
  };
}

function usageEvent(id: string, type: 'llm.usage' | 'llm.failed' = 'llm.usage'): ViewerEvent {
  return { id, type, timestamp: Date.now(), source: 'agent:demo', severity: 'normal', summary: 'demo', payload: {} };
}

const READY_LEDGER: LedgerConnection = { baseUrl: 'https://server.example', token: 'tok', tokenResolved: true };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useLedgerAgentUsage', () => {
  it('demo mode (ledger: null) never calls fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, rollupBody()));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useLedgerAgentUsage({ ledger: null, window: 'all', events: [] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.query.status).toBe('idle');
  });

  it('fetches groupBy=agent with the window range, and becomes ready', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse(200, rollupBody());
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useLedgerAgentUsage({ ledger: READY_LEDGER, window: 'lastHour', events: [], now: () => 5_000_000 })
    );
    await waitFor(() => expect(result.current.query.status).toBe('ready'));

    const parsed = new URL(urls[0]);
    expect(parsed.searchParams.get('groupBy')).toBe('agent');
    expect(parsed.searchParams.get('from')).toBe(String(5_000_000 - 60 * 60 * 1000));
  });

  it('refetches with a new range when the window changes', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse(200, rollupBody());
    });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = renderHook(
      ({ window }: { window: UsageWindowOption }) =>
        useLedgerAgentUsage({ ledger: READY_LEDGER, window, events: [], now: () => 5_000_000 }),
      { initialProps: { window: 'all' } }
    );
    await waitFor(() => expect(urls.length).toBe(1));
    expect(new URL(urls[0]).searchParams.has('from')).toBe(false);

    rerender({ window: '7d' });
    await waitFor(() => expect(urls.length).toBe(2));
    expect(new URL(urls[1]).searchParams.get('from')).toBe(String(5_000_000 - 7 * 24 * 60 * 60 * 1000));
  });

  it('maps unauthorized and unavailable statuses', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, {}));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useLedgerAgentUsage({ ledger: READY_LEDGER, window: 'all', events: [] }));
    await waitFor(() => expect(result.current.query.status).toBe('unauthorized'));
  });

  it('drops a stale response: a slow first fetch never overwrites a newer retry', async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) return first;
      return jsonResponse(200, rollupBody());
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useLedgerAgentUsage({ ledger: READY_LEDGER, window: 'all', events: [] }));
    await waitFor(() => expect(callCount).toBe(1));

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.query.status).toBe('ready'));

    resolveFirst(jsonResponse(200, rollupBody()));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.query.status).toBe('ready');
  });

  it('a new real usage/failed event id debounces a refetch; an already-seen one does not', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(200, rollupBody()));
    vi.stubGlobal('fetch', fetchMock);

    const seed = usageEvent('evt-seed');
    const { rerender } = renderHook(
      ({ events }) => useLedgerAgentUsage({ ledger: READY_LEDGER, window: 'all', events, now: () => Date.now() }),
      { initialProps: { events: [seed] } }
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsAfterMount = fetchMock.mock.calls.length;

    rerender({ events: [seed] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterMount);

    const freshEvent = usageEvent('evt-new-1');
    rerender({ events: [seed, freshEvent] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterMount);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it('polls a rolling window every 60s while the document is visible, but never for "all"', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(200, rollupBody()));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useLedgerAgentUsage({ ledger: READY_LEDGER, window: 'today', events: [] }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsAfterMount = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it('never polls on a timer for "all"', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(200, rollupBody()));
    vi.stubGlobal('fetch', fetchMock);

    renderHook(() => useLedgerAgentUsage({ ledger: READY_LEDGER, window: 'all', events: [] }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsAfterMount = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterMount);
  });
});
