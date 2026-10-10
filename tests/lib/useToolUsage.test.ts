/**
 * `useToolUsage` (issue #81): lazy (`enabled`-gated so a chip the pointer never touches never fetches), scoped
 * to one agent (and optionally one task), with a 5s cache so hovering the same chip repeatedly does not refetch.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useToolUsage } from '../../src/components/usage/useToolUsage';
import type { LedgerConnection } from '../../src/components/modelOps/useModelOpsLedger';

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

const READY: LedgerConnection = { baseUrl: 'https://server.example', token: 'tok', tokenResolved: true };

describe('useToolUsage', () => {
  it('fetches nothing while disabled, and fetches groupBy=tool scoped to the agent once enabled', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse(200, rollupBody());
    });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender, result } = renderHook(
      ({ enabled }) => useToolUsage({ ledger: READY, agentId: 'ana', enabled, now: () => 1_000_000 }),
      { initialProps: { enabled: false } }
    );
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const url = new URL(urls[0]);
    expect(url.searchParams.get('groupBy')).toBe('tool');
    expect(url.searchParams.getAll('agentId')).toEqual(['ana']);
    vi.unstubAllGlobals();
  });

  it('includes taskId only when given', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(String(url));
      return jsonResponse(200, rollupBody());
    });
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useToolUsage({ ledger: READY, agentId: 'ana', taskId: 'task-1', enabled: true, now: () => 2_000_000 }));
    await waitFor(() => expect(urls.length).toBe(1));
    expect(new URL(urls[0]).searchParams.getAll('taskId')).toEqual(['task-1']);
    vi.unstubAllGlobals();
  });

  it('reuses a cached result for 5 seconds for the same (agent, task), then refetches after it expires', async () => {
    let now = 0;
    const fetchMock = vi.fn(async () => jsonResponse(200, rollupBody()));
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = renderHook(
      ({ enabled }) => useToolUsage({ ledger: READY, agentId: 'unique-agent-cache-test', enabled, now: () => now }),
      { initialProps: { enabled: false } }
    );
    rerender({ enabled: true });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(1));

    rerender({ enabled: false });
    now = 1000; // well within the 5s TTL
    rerender({ enabled: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock.mock.calls.length).toBe(1); // cache hit, no second request

    rerender({ enabled: false });
    now = 6000; // past the 5s TTL
    rerender({ enabled: true });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    vi.unstubAllGlobals();
  });
});
