/**
 * `useMeetingUsage` (issue #81): fetches `groupBy=meeting` with no `from`/`to` (all retained history), only
 * while the Meetings tab is open, and only once the token is resolved. A burst of `llm.usage` events triggers
 * one debounced, rate-limited refetch rather than one request per event (same shape as `useModelOpsLedger`).
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useMeetingUsage } from '../../src/components/usage/useMeetingUsage';
import type { LedgerConnection } from '../../src/components/modelOps/useModelOpsLedger';
import type { ViewerEvent } from '../../src/types/agent';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function rollupBody(groups: unknown[] = []) {
  return {
    schemaVersion: '1.0',
    asOf: { ledgerSeq: 1, lastRowReceivedAt: 1, generatedAt: Date.now() },
    coverage: { storage: 'memory', complete: true, droppedRows: 0, purgedThrough: null, backfilledRows: 0, legacyContractRows: 0 },
    groupsAreAdditive: true,
    groupCount: groups.length,
    truncated: false,
    groups,
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

function usageEvent(id: string): ViewerEvent {
  return { id, type: 'llm.usage', timestamp: Date.now(), source: 'agent:demo', severity: 'normal', summary: 'demo', payload: {} };
}

const READY: LedgerConnection = { baseUrl: 'https://server.example', token: 'tok', tokenResolved: true };

describe('useMeetingUsage', () => {
  it('never fetches in demo mode (ledger null)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useMeetingUsage({ ledger: null, isOpen: true, events: [] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('fetches groupBy=meeting with no from/to filter once open and the token resolved', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse(200, rollupBody());
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMeetingUsage({ ledger: READY, isOpen: true, events: [] }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const url = new URL(urls[0]);
    expect(url.searchParams.get('groupBy')).toBe('meeting');
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.has('to')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('stays idle while the token has not resolved yet, then loading, never reading a real 401 too early', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, {}));
    vi.stubGlobal('fetch', fetchMock);
    const notResolved: LedgerConnection = { baseUrl: 'https://server.example', tokenResolved: false };
    const { result } = renderHook(() => useMeetingUsage({ ledger: notResolved, isOpen: true, events: [] }));
    expect(result.current.status).toBe('loading');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('maps 401 to unauthorized and 404 to unavailable, never throwing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, {}));
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(
      ({ ledger }) => useMeetingUsage({ ledger, isOpen: true, events: [] }),
      { initialProps: { ledger: READY } }
    );
    await waitFor(() => expect(result.current.status).toBe('unauthorized'));

    fetchMock.mockImplementation(async () => jsonResponse(404, {}));
    rerender({ ledger: { ...READY, baseUrl: 'https://server.example/other' } });
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    vi.unstubAllGlobals();
  });

  it('debounces a burst of new llm.usage events into one refetch, rate-limited to 5s apart', async () => {
    vi.useFakeTimers();
    let now = 1_000_000;
    const fetchMock = vi.fn(async () => jsonResponse(200, rollupBody()));
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = renderHook(
      ({ events }: { events: ViewerEvent[] }) => useMeetingUsage({ ledger: READY, isOpen: true, events, now: () => now }),
      { initialProps: { events: [] as ViewerEvent[] } }
    );
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));

    rerender({ events: [usageEvent('u-1')] });
    rerender({ events: [usageEvent('u-1'), usageEvent('u-2')] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(fetchMock.mock.calls.length).toBe(2); // one refetch for the whole burst, not two

    // Re-seen ids never trigger another refetch.
    rerender({ events: [usageEvent('u-1'), usageEvent('u-2')] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(fetchMock.mock.calls.length).toBe(2);

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
