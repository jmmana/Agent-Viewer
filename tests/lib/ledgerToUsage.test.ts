/**
 * Tests for the rollup-to-`OfficeUsage` mapper (issue #78): pass-through of known figures, "unknown" (never `0`,
 * never a partial sum) for anything the server did not fully report, and exclusion of rows with no agent key.
 */
import { describe, expect, it } from 'vitest';
import { rollupToOfficeUsage, rollupTotalsToUsageFigures } from '../../src/integrations/ledgerToUsage';
import type { RollupGroup, RollupResponse, RollupTotals } from '../../src/integrations/ledgerClient';

function tokenMetric(sum: number | null, reportedCalls: number, unreportedCalls: number) {
  return { sum, reportedCalls, unreportedCalls };
}

function totals(overrides: Partial<RollupTotals> = {}): RollupTotals {
  return {
    calls: { total: 10, succeeded: 9, failed: 1 },
    tokens: {
      input: tokenMetric(100, 10, 0),
      output: tokenMetric(50, 10, 0),
      cacheRead: tokenMetric(null, 0, 10),
      cacheWrite: tokenMetric(null, 0, 10),
      reasoning: tokenMetric(null, 0, 10),
    },
    cost: { entries: [{ currency: 'USD', costSource: 'provider-reported', sum: 1.5, calls: 9 }], unknownCostCalls: 0 },
    firstAt: 100,
    lastAt: 200,
    ...overrides,
  };
}

function rollup(groups: RollupGroup[], totalsRow: RollupTotals = totals()): RollupResponse {
  return {
    schemaVersion: '1.0',
    asOf: { ledgerSeq: 1, lastRowReceivedAt: 200, generatedAt: 300 },
    coverage: { storage: 'memory', complete: true, droppedRows: 0, purgedThrough: null, backfilledRows: 0, legacyContractRows: 0 },
    groupsAreAdditive: true,
    groupCount: groups.length,
    truncated: false,
    groups,
    totals: totalsRow,
  };
}

function group(key: Record<string, string | null>, overrides: Partial<RollupTotals> = {}): RollupGroup {
  return { ...totals(overrides), key };
}

describe('rollupTotalsToUsageFigures', () => {
  it('sums input and output tokens only when both are fully reported', () => {
    expect(rollupTotalsToUsageFigures(totals()).totalTokens).toBe(150);
  });

  it('is unknown (not a partial sum) when a token kind has any unreported call', () => {
    const row = totals({ tokens: { ...totals().tokens, output: tokenMetric(50, 9, 1) } });
    expect(rollupTotalsToUsageFigures(row).totalTokens).toBeNull();
  });

  it('is unknown when a token kind sum is null', () => {
    const row = totals({ tokens: { ...totals().tokens, input: tokenMetric(null, 0, 10) } });
    expect(rollupTotalsToUsageFigures(row).totalTokens).toBeNull();
  });

  it('a guard fixture: input + output would differ from what a naive "totalTokens" field might say, proving this reads the two kinds, never invents a third number', () => {
    const row = totals({
      tokens: { ...totals().tokens, input: tokenMetric(100, 10, 0), output: tokenMetric(50, 10, 0) },
    });
    const figures = rollupTotalsToUsageFigures(row);
    expect(figures.totalTokens).toBe(row.tokens.input.sum! + row.tokens.output.sum!);
  });

  it('reads a single cost entry with no unknown-cost calls as the known cost', () => {
    const figures = rollupTotalsToUsageFigures(totals());
    expect(figures.cost).toBe(1.5);
    expect(figures.currency).toBe('USD');
    expect(figures.costSource).toBe('provider-reported');
  });

  it('is unknown cost with zero entries', () => {
    const row = totals({ cost: { entries: [], unknownCostCalls: 0 } });
    const figures = rollupTotalsToUsageFigures(row);
    expect(figures.cost).toBeNull();
    expect(figures.currency).toBeUndefined();
  });

  it('is unknown cost with more than one currency/source entry, never summed across them', () => {
    const row = totals({
      cost: {
        entries: [
          { currency: 'USD', costSource: 'provider-reported', sum: 1, calls: 5 },
          { currency: 'EUR', costSource: 'provider-reported', sum: 2, calls: 4 },
        ],
        unknownCostCalls: 0,
      },
    });
    expect(rollupTotalsToUsageFigures(row).cost).toBeNull();
  });

  it('is unknown cost when any call has an unreported cost, even with a single entry', () => {
    const row = totals({ cost: { entries: [{ currency: 'USD', costSource: 'provider-reported', sum: 1.5, calls: 9 }], unknownCostCalls: 1 } });
    expect(rollupTotalsToUsageFigures(row).cost).toBeNull();
  });

  it('reads each token kind (input, output, cache read, cache write, reasoning) independently (issue #78)', () => {
    const figures = rollupTotalsToUsageFigures(totals());
    expect(figures.inputTokens).toBe(100);
    expect(figures.outputTokens).toBe(50);
    // cacheRead/cacheWrite/reasoning in the shared `totals()` fixture have zero reported calls (all unreported).
    expect(figures.cacheReadTokens).toBeNull();
    expect(figures.cacheWriteTokens).toBeNull();
    expect(figures.reasoningTokens).toBeNull();
  });

  it('is unknown for a token kind with any unreported call, even when its sibling kinds are fully known', () => {
    const row = totals({ tokens: { ...totals().tokens, cacheRead: tokenMetric(80, 9, 1) } });
    const figures = rollupTotalsToUsageFigures(row);
    expect(figures.cacheReadTokens).toBeNull();
    expect(figures.inputTokens).toBe(100);
  });

  it('reads a token kind as its sum once every call reported it, including a fully-reported cache/reasoning kind', () => {
    const row = totals({
      tokens: {
        ...totals().tokens,
        cacheRead: tokenMetric(40, 10, 0),
        cacheWrite: tokenMetric(10, 10, 0),
        reasoning: tokenMetric(5, 10, 0),
      },
    });
    const figures = rollupTotalsToUsageFigures(row);
    expect(figures.cacheReadTokens).toBe(40);
    expect(figures.cacheWriteTokens).toBe(10);
    expect(figures.reasoningTokens).toBe(5);
  });

  it('never reports failedCalls as 0: omitted when there are none', () => {
    const row = totals({ calls: { total: 5, succeeded: 5, failed: 0 } });
    expect(rollupTotalsToUsageFigures(row).failedCalls).toBeUndefined();
  });

  it('reports a positive failedCalls as-is', () => {
    expect(rollupTotalsToUsageFigures(totals()).failedCalls).toBe(1);
  });
});

describe('rollupToOfficeUsage', () => {
  it('maps groups keyed by agent into byAgent, and totals into total', () => {
    const response = rollup([group({ agent: 'atlas' }), group({ agent: 'juno' }, { calls: { total: 1, succeeded: 1, failed: 0 } })]);
    const usage = rollupToOfficeUsage(response);
    expect(Object.keys(usage.byAgent ?? {}).sort()).toEqual(['atlas', 'juno']);
    expect(usage.byAgent?.atlas.totalTokens).toBe(150);
    expect(usage.total?.totalTokens).toBe(150);
  });

  it('excludes a group with no agent key from byAgent, but still reflects it in total', () => {
    const response = rollup([group({ agent: null })]);
    const usage = rollupToOfficeUsage(response);
    expect(usage.byAgent).toEqual({});
    expect(usage.total?.totalTokens).toBe(150);
  });

  it('an agent with no group row is absent from byAgent entirely (no entry, not a zero or unknown one)', () => {
    const response = rollup([group({ agent: 'atlas' })]);
    const usage = rollupToOfficeUsage(response);
    expect(usage.byAgent).not.toHaveProperty('juno');
  });
});
