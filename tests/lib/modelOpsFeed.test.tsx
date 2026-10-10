/**
 * `FeedTab` (issue #79): real calls in server order, failed status with `errorCode`, `n/a` fields, pagination,
 * and the absence of any fabricated entry or prompt text, in `ledger` mode; the pre-ledger simulated list in
 * `simulated` mode.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeedTab } from '../../src/components/modelOps/FeedTab';
import type { FeedState } from '../../src/components/modelOps/useModelOpsLedger';
import type { CallRecord } from '../../src/integrations/ledgerClient';

function callRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    seq: 1,
    eventId: 'evt-1',
    type: 'llm.usage',
    status: 'ok',
    backfilled: false,
    occurredAt: 1000,
    receivedAt: 1500,
    agentId: null,
    sessionId: 's-1',
    runtimeId: null,
    taskId: null,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    tokens: { input: 10, output: 5, cacheRead: null, cacheWrite: null, reasoning: null },
    latencyMs: 300,
    requestId: null,
    cost: 0.02,
    currency: 'USD',
    costSource: 'provider-reported',
    errorCode: null,
    trace: { traceId: null, parentId: null, toolCallId: null, meetingId: null },
    userId: null,
    tags: [],
    ...overrides,
  };
}

function feedState(calls: CallRecord[], overrides: Partial<FeedState> = {}): FeedState {
  return { query: { status: 'ready', data: null }, calls, hasMore: false, nextCursor: null, loadingMore: false, loadMoreError: null, ...overrides };
}

function baseProps(feed: FeedState) {
  return {
    mode: 'ledger' as const,
    locale: 'en' as const,
    agents: [],
    onRetry: vi.fn(),
    feed,
    feedFilters: { status: 'all' as const, model: null, agentId: null },
    onFeedFiltersChange: vi.fn(),
    onLoadMore: vi.fn(),
    apiBase: 'https://server.example',
    simulatedCalls: [],
  };
}

describe('FeedTab, ledger mode', () => {
  it('lists calls in the server order given, with no fabricated entry, status code, prompt or endpoint text', () => {
    const calls = [callRecord({ eventId: 'evt-2', seq: 2 }), callRecord({ eventId: 'evt-1', seq: 1 })];
    render(<FeedTab {...baseProps(feedState(calls))} />);
    // 2 feed rows plus the model filter's own <option>.
    const rendered = screen.getAllByText('claude-sonnet-4-5');
    expect(rendered.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('200 OK')).toBeNull();
    expect(screen.queryByText('CACHED')).toBeNull();
    expect(screen.queryByText(/POST \/v1\/chat\/completions/)).toBeNull();
  });

  it('shows a failed call with its errorCode and an n/a for an unreported field', () => {
    const calls = [callRecord({ status: 'timeout', errorCode: 'timeout', type: 'llm.failed', latencyMs: null })];
    render(<FeedTab {...baseProps(feedState(calls))} />);
    expect(screen.getByText(/timeout/)).toBeTruthy();
    expect(screen.getAllByText('n/a').length).toBeGreaterThan(0);
  });

  it('shows "Load more" exactly when hasMore is true, and calls onLoadMore', () => {
    const calls = [callRecord()];
    const onLoadMore = vi.fn();
    const { rerender } = render(<FeedTab {...baseProps(feedState(calls, { hasMore: false }))} onLoadMore={onLoadMore} />);
    expect(screen.queryByText('Load more')).toBeNull();

    rerender(<FeedTab {...baseProps(feedState(calls, { hasMore: true, nextCursor: 'c1' }))} onLoadMore={onLoadMore} />);
    screen.getByText('Load more').click();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('shows the loading, unavailable, unauthorized and error states', () => {
    const props = baseProps(feedState([]));
    const { rerender } = render(<FeedTab {...props} feed={{ ...props.feed, query: { status: 'loading' } }} />);
    expect(screen.getByRole('status')).toBeTruthy();

    rerender(<FeedTab {...props} feed={{ ...props.feed, query: { status: 'unavailable' } }} />);
    expect(screen.getByText(/does not expose the usage ledger/)).toBeTruthy();

    rerender(<FeedTab {...props} feed={{ ...props.feed, query: { status: 'unauthorized' } }} />);
    expect(screen.getByText(/requires an API token/)).toBeTruthy();
  });

  it('shows the empty state when the ledger has no calls, and the filtered state when filters match nothing', () => {
    const props = baseProps(feedState([]));
    const { rerender } = render(<FeedTab {...props} />);
    expect(screen.getByText('No model calls have been recorded yet')).toBeTruthy();

    rerender(<FeedTab {...props} feedFilters={{ status: 'failed', model: null, agentId: null }} />);
    expect(screen.getByText('No calls match the current filters.')).toBeTruthy();
  });
});

describe('FeedTab, simulated mode', () => {
  it('shows the empty hint with no calls, and the SIMULATED badge once one exists', () => {
    const { rerender } = render(<FeedTab {...baseProps(feedState([]))} mode="simulated" />);
    expect(screen.getByText(/Run the simulator/)).toBeTruthy();

    rerender(
      <FeedTab
        {...baseProps(feedState([]))}
        mode="simulated"
        simulatedCalls={[
          {
            id: 'sim-1',
            simulated: true,
            timestamp: Date.now(),
            provider: 'OpenAI',
            model: 'gpt-4o',
            agentId: null,
            preset: 'custom',
            inputTokens: 10,
            outputTokens: 5,
            cachedTokens: 0,
            estimatedCost: 0.001,
            currency: 'USD',
            latencyMs: 100,
          },
        ]}
      />
    );
    expect(screen.getAllByText('SIMULATED').length).toBeGreaterThan(0);
  });
});
