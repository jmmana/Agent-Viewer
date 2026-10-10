/**
 * Render tests for `AgentCallsTable` (issue #78): the empty state reads differently from "unknown", a failed
 * call is visibly marked with its `errorCode`, an estimated cost carries its tag, a `[REDACTED:...]` requestId
 * always renders as a chip regardless of `maskSecrets`, and the 500-row cap hint only shows when `atCap` is true.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentCallsTable } from '../../src/components/usage/AgentCallsTable';
import type { CallRecord } from '../../src/integrations/ledgerClient';
import type { QueryState } from '../../src/components/modelOps/useModelOpsLedger';

function call(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    seq: 1,
    eventId: 'evt_1',
    type: 'llm.usage',
    status: 'ok',
    backfilled: false,
    occurredAt: 1_700_000_000_000,
    receivedAt: 1_700_000_000_500,
    agentId: 'atlas',
    sessionId: null,
    runtimeId: null,
    taskId: null,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    tokens: { input: 100, output: 50, cacheRead: null, cacheWrite: null, reasoning: null },
    latencyMs: 500,
    requestId: 'req_abcdefghijk',
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

const READY: QueryState<null> = { status: 'ready', data: null };

const baseProps = {
  query: READY,
  hasMore: false,
  atCap: false,
  loadingMore: false,
  loadMoreError: null,
  onLoadMore: vi.fn(),
  onRetry: vi.fn(),
  maskSecrets: true,
  windowLabel: 'All',
  locale: 'en' as const,
};

describe('AgentCallsTable', () => {
  it('shows the empty state, distinct from "unknown"', () => {
    render(<AgentCallsTable {...baseProps} calls={[]} />);
    expect(screen.getByText('No calls recorded')).toBeTruthy();
    expect(screen.queryByText('unknown')).toBeNull();
  });

  it('marks a failed call with its status and errorCode', () => {
    render(<AgentCallsTable {...baseProps} calls={[call({ status: 'rate_limit', errorCode: 'rate_limit' })]} />);
    expect(screen.getByText('rate_limit: rate_limit')).toBeTruthy();
  });

  it('tags a non-provider-reported cost with its source', () => {
    render(<AgentCallsTable {...baseProps} calls={[call({ costSource: 'estimated' })]} />);
    expect(screen.getByText(/estimated/)).toBeTruthy();
  });

  it('renders a requestId matching the redaction marker as a distinct chip, regardless of maskSecrets', () => {
    render(<AgentCallsTable {...baseProps} maskSecrets={false} calls={[call({ requestId: '[REDACTED:github_token]' })]} />);
    expect(screen.getByText('redacted')).toBeTruthy();
    expect(screen.queryByText('[REDACTED:github_token]')).toBeNull();
  });

  it('shortens requestId when maskSecrets is on, shows it in full when off', () => {
    const { rerender } = render(<AgentCallsTable {...baseProps} maskSecrets={true} calls={[call({ requestId: 'req_abcdefghijk' })]} />);
    expect(screen.getByText('req_abcdef…')).toBeTruthy();

    rerender(<AgentCallsTable {...baseProps} maskSecrets={false} calls={[call({ requestId: 'req_abcdefghijk' })]} />);
    expect(screen.getByText('req_abcdefghijk')).toBeTruthy();
  });

  it('shows the 500-row cap hint only when atCap is true', () => {
    const { rerender } = render(<AgentCallsTable {...baseProps} calls={[call()]} atCap={false} />);
    expect(screen.queryByText(/500 most recent/)).toBeNull();

    rerender(<AgentCallsTable {...baseProps} calls={[call()]} atCap={true} />);
    expect(screen.getByText(/500 most recent/)).toBeTruthy();
  });

  it('shows a loading, unavailable, unauthorized and error state distinctly', () => {
    const { rerender } = render(<AgentCallsTable {...baseProps} query={{ status: 'loading' }} calls={[]} />);
    expect(screen.getByText('Loading calls…')).toBeTruthy();

    rerender(<AgentCallsTable {...baseProps} query={{ status: 'unavailable' }} calls={[]} />);
    expect(screen.getByText(/does not expose the usage ledger/)).toBeTruthy();

    rerender(<AgentCallsTable {...baseProps} query={{ status: 'unauthorized' }} calls={[]} />);
    expect(screen.getByText(/Sign in again/)).toBeTruthy();

    rerender(<AgentCallsTable {...baseProps} query={{ status: 'error', message: 'boom' }} calls={[]} />);
    expect(screen.getByText(/Could not load calls: boom/)).toBeTruthy();
  });
});
