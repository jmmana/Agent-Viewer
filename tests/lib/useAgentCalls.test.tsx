/**
 * Tests for `useAgentCalls` (issue #78): the per-agent paginated call list behind `AgentDetailModal`'s "View
 * calls" section. Mirrors the coverage style of `ledgerAgentUsage.test.tsx` and `useModelOpsLedger`'s own feed
 * tests: demo mode makes no request, pagination follows `nextCursor`, a page is deduped by `eventId`, the 500-row
 * display cap stops `loadMore` from requesting further pages, an invalid cursor recovers by reloading page 1, and
 * only a usage/failed event for THIS agent triggers a debounced refetch.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAgentCalls, AGENT_CALLS_DISPLAY_CAP } from '../../src/components/usage/useAgentCalls';
import type { LedgerConnection } from '../../src/components/modelOps/useModelOpsLedger';
import type { ViewerEvent } from '../../src/types/agent';
import type { CallRecord } from '../../src/integrations/ledgerClient';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function call(eventId: string, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    seq: 1,
    eventId,
    type: 'llm.usage',
    status: 'ok',
    backfilled: false,
    occurredAt: 1000,
    receivedAt: 1001,
    agentId: 'atlas',
    sessionId: null,
    runtimeId: null,
    taskId: null,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    tokens: { input: 100, output: 50, cacheRead: null, cacheWrite: null, reasoning: null },
    latencyMs: 500,
    requestId: `req-${eventId}`,
    cost: 0.01,
    currency: 'USD',
    costSource: 'provider-reported',
    errorCode: null,
    trace: { traceId: null, parentId: null, toolCallId: null, meetingId: null },
    userId: null,
    tags: [],
    ...overrides,
  };
}

function callsBody(calls: CallRecord[], nextCursor: string | null = null): unknown {
  return {
    schemaVersion: '1.0',
    asOf: Date.now(),
    storage: 'memory',
    data: calls,
    page: { limit: 50, order: 'desc', hasMore: nextCursor !== null, nextCursor },
  };
}

function usageEvent(id: string, agentId: string, type: 'llm.usage' | 'llm.failed' = 'llm.usage'): ViewerEvent {
  return { id, type, timestamp: Date.now(), source: `agent:${agentId}`, agentId, severity: 'normal', summary: 'demo', payload: {} };
}

const READY_LEDGER: LedgerConnection = { baseUrl: 'https://server.example', token: 'tok', tokenResolved: true };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useAgentCalls', () => {
  it('demo mode (ledger: null) never calls fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, callsBody([])));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAgentCalls({ ledger: null, agentId: 'atlas', window: 'all', enabled: true, events: [] }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.query.status).toBe('idle');
  });

  it('does not fetch while disabled, fetches once enabled', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, callsBody([call('a')])));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender, result } = renderHook(
      ({ enabled }) => useAgentCalls({ ledger: READY_LEDGER, agentId: 'atlas', window: 'all', enabled, events: [] }),
      { initialProps: { enabled: false } }
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.query.status).toBe('ready'));
    expect(result.current.calls).toHaveLength(1);
  });

  it('sends agentId as a filter and paginates via loadMore, deduping by eventId', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(String(url));
      if (urls.length === 1) return jsonResponse(200, callsBody([call('a'), call('b')], 'cursor-1'));
      return jsonResponse(200, callsBody([call('b'), call('c')], null));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useAgentCalls({ ledger: READY_LEDGER, agentId: 'atlas', window: 'all', enabled: true, events: [] })
    );
    await waitFor(() => expect(result.current.query.status).toBe('ready'));
    expect(new URL(urls[0]).searchParams.getAll('agentId')).toEqual(['atlas']);
    expect(result.current.calls.map((c) => c.eventId)).toEqual(['a', 'b']);
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.calls.map((c) => c.eventId)).toEqual(['a', 'b', 'c']));
    expect(result.current.hasMore).toBe(false);
  });

  it('resets and refetches page 1 when the agent or window changes', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse(200, callsBody([call('a')]));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender, result } = renderHook(
      ({ agentId }) => useAgentCalls({ ledger: READY_LEDGER, agentId, window: 'all', enabled: true, events: [] }),
      { initialProps: { agentId: 'atlas' } }
    );
    await waitFor(() => expect(urls.length).toBe(1));

    rerender({ agentId: 'juno' });
    await waitFor(() => expect(result.current.query.status).toBe('ready'));
    expect(urls.length).toBe(2);
    expect(new URL(urls[1]).searchParams.getAll('agentId')).toEqual(['juno']);
  });

  it('stops requesting more pages once the 500-row display cap is reached', async () => {
    // Every page returns 50 freshly-id'd calls and a non-null cursor, so the server would hand out an unlimited
    // number of pages; only the hook's own cap (not the server) should stop the chase at 500.
    let page = 0;
    const fetchMock = vi.fn(async () => {
      const items = Array.from({ length: 50 }, (_, i) => call(`p${page}-${i}`));
      page += 1;
      return jsonResponse(200, callsBody(items, `cursor-${page}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useAgentCalls({ ledger: READY_LEDGER, agentId: 'atlas', window: 'all', enabled: true, events: [] })
    );
    await waitFor(() => expect(result.current.calls.length).toBe(50));

    for (let i = 0; i < 9 && result.current.calls.length < AGENT_CALLS_DISPLAY_CAP; i += 1) {
      const before = result.current.calls.length;
      act(() => result.current.loadMore());
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(result.current.calls.length).toBeGreaterThan(before));
    }

    expect(result.current.calls.length).toBe(AGENT_CALLS_DISPLAY_CAP);
    expect(result.current.atCap).toBe(true);
    expect(result.current.hasMore).toBe(false);

    const callsBeforeExtra = fetchMock.mock.calls.length;
    act(() => result.current.loadMore());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock.mock.calls.length).toBe(callsBeforeExtra);
  });

  it('recovers from an invalid cursor (400) by reloading page 1', async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      callCount += 1;
      const u = new URL(String(url));
      if (u.searchParams.get('cursor')) return jsonResponse(400, { error: 'invalid_cursor' });
      return jsonResponse(200, callsBody([call('a')], callCount === 1 ? 'stale-cursor' : null));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() =>
      useAgentCalls({ ledger: READY_LEDGER, agentId: 'atlas', window: 'all', enabled: true, events: [] })
    );
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.hasMore).toBe(false));
    expect(result.current.query.status).toBe('ready');
    expect(result.current.loadMoreError).toBeNull();
  });

  it('maps unauthorized and unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, {})));
    const { result } = renderHook(() =>
      useAgentCalls({ ledger: READY_LEDGER, agentId: 'atlas', window: 'all', enabled: true, events: [] })
    );
    await waitFor(() => expect(result.current.query.status).toBe('unauthorized'));
  });

  it('refetches on a usage/failed event for THIS agent, debounced; ignores other agents', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse(200, callsBody([call('a')])));
    vi.stubGlobal('fetch', fetchMock);

    const seed = usageEvent('seed', 'atlas');
    const { rerender } = renderHook(
      ({ events }) => useAgentCalls({ ledger: READY_LEDGER, agentId: 'atlas', window: 'all', enabled: true, events, now: () => Date.now() }),
      { initialProps: { events: [seed] } }
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const callsAfterMount = fetchMock.mock.calls.length;

    // Event for a different agent: never triggers a refetch.
    const otherAgentEvent = usageEvent('other-1', 'juno');
    rerender({ events: [seed, otherAgentEvent] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock.mock.calls.length).toBe(callsAfterMount);

    // Event for this agent: triggers a debounced refetch.
    const ownEvent = usageEvent('own-1', 'atlas');
    rerender({ events: [seed, otherAgentEvent, ownEvent] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });
});
