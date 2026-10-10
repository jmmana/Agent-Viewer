/**
 * `LedgerMatrixView` (issue #79): the Matrix tab's ledger-mode rendering rules, exercised directly against
 * `QueryState<RollupResponse>` fixtures so these tests never depend on `fetch` or on `useModelOpsLedger`'s own
 * timing (covered separately by `tests/lib/modelOpsLedger.test.tsx`).
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LedgerMatrixView } from '../../src/components/modelOps/LedgerMatrixView';
import type { QueryState } from '../../src/components/modelOps/useModelOpsLedger';
import type { RollupGroup, RollupResponse } from '../../src/integrations/ledgerClient';

function tokenMetric(sum: number | null, unreportedCalls = 0, reportedCalls = 0) {
  return { sum, unreportedCalls, reportedCalls };
}

function group(overrides: Partial<RollupGroup> & { key: RollupGroup['key'] }): RollupGroup {
  return {
    calls: { total: 10, succeeded: 10, failed: 0 },
    tokens: {
      input: tokenMetric(100, 0, 10),
      output: tokenMetric(50, 0, 10),
      cacheRead: tokenMetric(null),
      cacheWrite: tokenMetric(null),
      reasoning: tokenMetric(null),
    },
    cost: { entries: [{ currency: 'USD', costSource: 'provider-reported', sum: 1, calls: 10 }], unknownCostCalls: 0 },
    firstAt: 1,
    lastAt: 2,
    ...overrides,
  };
}

function rollupResponse(groups: RollupGroup[], extra: Partial<RollupResponse> = {}): QueryState<RollupResponse> {
  const totalsCalls = groups.reduce((sum, g) => sum + g.calls.total, 0);
  return {
    status: 'ready',
    data: {
      schemaVersion: '1.0',
      asOf: { ledgerSeq: 1, lastRowReceivedAt: 1, generatedAt: Date.now() },
      coverage: { storage: 'memory', complete: true, droppedRows: 0, purgedThrough: null, backfilledRows: 0, legacyContractRows: 0 },
      groupsAreAdditive: true,
      groupCount: groups.length,
      truncated: false,
      groups,
      totals: {
        calls: { total: totalsCalls, succeeded: totalsCalls, failed: 0 },
        tokens: {
          input: tokenMetric(100, 0, totalsCalls),
          output: tokenMetric(50, 0, totalsCalls),
          cacheRead: tokenMetric(null),
          cacheWrite: tokenMetric(null),
          reasoning: tokenMetric(null),
        },
        cost: { entries: [], unknownCostCalls: 0 },
        firstAt: 1,
        lastAt: 2,
      },
      ...extra,
    },
  };
}

function baseProps(modelGroups: RollupGroup[], providerGroups: RollupGroup[]) {
  return {
    locale: 'en' as const,
    modelRollup: rollupResponse(modelGroups),
    providerRollup: rollupResponse(providerGroups),
    timeRange: 'all' as const,
    onTimeRangeChange: vi.fn(),
    onRetry: vi.fn(),
    apiBase: 'https://server.example',
    agents: [],
    onFocusAgent: vi.fn(),
    onClose: vi.fn(),
  };
}

describe('LedgerMatrixView', () => {
  it('shows an agent that called two models as two separate model cards, each with its own figures', () => {
    const models = [
      group({ key: { provider: 'anthropic', model: 'claude-sonnet-4-5' }, calls: { total: 5, succeeded: 5, failed: 0 } }),
      group({ key: { provider: 'anthropic', model: 'claude-haiku-4-5' }, calls: { total: 7, succeeded: 7, failed: 0 } }),
    ];
    const providers = [group({ key: { provider: 'anthropic' }, calls: { total: 12, succeeded: 12, failed: 0 } })];
    render(<LedgerMatrixView {...baseProps(models, providers)} />);
    expect(screen.getByText('claude-sonnet-4-5')).toBeTruthy();
    expect(screen.getByText('claude-haiku-4-5')).toBeTruthy();
  });

  it('renders a metric reported as null as "n/a", never as "0"', () => {
    // cacheRead/cacheWrite/reasoning are `tokenMetric(null)` on this fixture: genuinely unreported, not a count
    // that happens to be zero (a group with zero *failed* calls still correctly shows "0" for that count).
    const models = [group({ key: { provider: 'anthropic', model: 'claude-sonnet-4-5' } })];
    render(<LedgerMatrixView {...baseProps(models, [group({ key: { provider: 'anthropic' } })])} />);
    expect(screen.getAllByText('n/a').length).toBeGreaterThan(0);
  });

  it('marks a partially reported metric and shows the unreported-call count in its title', () => {
    const models = [
      group({
        key: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
        calls: { total: 128, succeeded: 128, failed: 0 },
        tokens: {
          input: tokenMetric(100, 0, 128),
          output: tokenMetric(50, 0, 128),
          cacheRead: tokenMetric(900, 12, 116),
          cacheWrite: tokenMetric(null),
          reasoning: tokenMetric(null),
        },
      }),
    ];
    render(<LedgerMatrixView {...baseProps(models, [group({ key: { provider: 'anthropic' } })])} />);
    expect(screen.getByTitle('12 of 128 calls did not report this')).toBeTruthy();
  });

  it('shows two currencies as separate chips, never summed, and a non-provider-reported source label', () => {
    const models = [
      group({
        key: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
        cost: {
          entries: [
            { currency: 'USD', costSource: 'provider-reported', sum: 1.5, calls: 8 },
            { currency: 'EUR', costSource: 'estimated', sum: 0.9, calls: 2 },
          ],
          unknownCostCalls: 0,
        },
      }),
    ];
    render(<LedgerMatrixView {...baseProps(models, [group({ key: { provider: 'anthropic' } })])} />);
    expect(screen.getByText('$1.50')).toBeTruthy();
    expect(screen.getByText('€0.90')).toBeTruthy();
    expect(screen.getByText('(estimated)')).toBeTruthy();
  });

  it('shows the count of calls without cost, never contributing a 0 to the cost figure', () => {
    const models = [
      group({
        key: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
        cost: { entries: [{ currency: 'USD', costSource: 'provider-reported', sum: 1, calls: 8 }], unknownCostCalls: 2 },
      }),
    ];
    render(<LedgerMatrixView {...baseProps(models, [group({ key: { provider: 'anthropic' } })])} />);
    expect(screen.getByText('2 calls without cost')).toBeTruthy();
  });

  it('never shows a catalog description, context window, latency or price per 1M, even for a known catalog model id', () => {
    const models = [group({ key: { provider: 'OpenAI', model: 'gpt-4o' } })];
    render(<LedgerMatrixView {...baseProps(models, [group({ key: { provider: 'OpenAI' } })])} />);
    expect(screen.queryByText(/Context:/)).toBeNull();
    expect(screen.queryByText(/Latency:/)).toBeNull();
    expect(screen.queryByText(/\$2\.50\/1M/)).toBeNull();
    expect(screen.queryByText('Flagship multimodal model with high speed and precision')).toBeNull();
  });

  it('disables sort-by-cost, with an explanatory title, when the displayed rows mix currencies', () => {
    const models = [
      group({ key: { provider: 'anthropic', model: 'a' }, cost: { entries: [{ currency: 'USD', costSource: 'provider-reported', sum: 1, calls: 1 }], unknownCostCalls: 0 } }),
      group({ key: { provider: 'anthropic', model: 'b' }, cost: { entries: [{ currency: 'EUR', costSource: 'provider-reported', sum: 1, calls: 1 }], unknownCostCalls: 0 } }),
    ];
    render(<LedgerMatrixView {...baseProps(models, [group({ key: { provider: 'anthropic' } })])} />);
    const costButton = screen.getByRole('button', { name: 'Cost ($)' }) as HTMLButtonElement;
    expect(costButton.disabled).toBe(true);
    expect(costButton.title).toContain('mix currencies or cost sources');
  });

  it('matches the office rack provider filter "Google Gemini" to the ledger provider "google" (alias-aware)', () => {
    const models = [group({ key: { provider: 'google', model: 'gemini-2.5-pro' } })];
    const providers = [group({ key: { provider: 'google' } })];
    render(<LedgerMatrixView {...baseProps(models, providers)} initialProviderFilter="Google Gemini" />);
    expect(screen.getByText('gemini-2.5-pro')).toBeTruthy();
  });

  it('shows the truncated notice with the returned row count when the rollup was truncated', () => {
    const models = [group({ key: { provider: 'anthropic', model: 'a' } })];
    const props = baseProps(models, [group({ key: { provider: 'anthropic' } })]);
    props.modelRollup = rollupResponse(models, { truncated: true });
    render(<LedgerMatrixView {...props} />);
    expect(screen.getByText('Showing the top 1 groups by tokens.')).toBeTruthy();
  });

  it('never shows one combined "total tokens" figure', () => {
    const models = [group({ key: { provider: 'anthropic', model: 'a' } })];
    render(<LedgerMatrixView {...baseProps(models, [group({ key: { provider: 'anthropic' } })])} />);
    expect(screen.queryByText('Total tokens')).toBeNull();
  });

  it('shows the loading, unavailable, unauthorized and error states', () => {
    const props = baseProps([], []);
    const { rerender } = render(<LedgerMatrixView {...props} modelRollup={{ status: 'loading' }} />);
    expect(screen.getByRole('status')).toBeTruthy();

    rerender(<LedgerMatrixView {...props} modelRollup={{ status: 'unavailable' }} />);
    expect(screen.getByText(/does not expose the usage ledger/)).toBeTruthy();

    rerender(<LedgerMatrixView {...props} modelRollup={{ status: 'unauthorized' }} />);
    expect(screen.getByText(/requires an API token/)).toBeTruthy();

    rerender(<LedgerMatrixView {...props} modelRollup={{ status: 'error', message: 'boom' }} />);
    expect(screen.getByText(/boom/)).toBeTruthy();
  });

  it('shows the no-calls-yet empty state with copy-ready snippets when the ledger is empty', () => {
    const empty = rollupResponse([]);
    render(<LedgerMatrixView {...baseProps([], [])} modelRollup={empty} providerRollup={empty} apiBase="https://server.example" />);
    expect(screen.getByText('No model calls have been recorded yet')).toBeTruthy();
    expect(screen.getByText(/https:\/\/server\.example\/api\/v1\/events/)).toBeTruthy();
  });
});
