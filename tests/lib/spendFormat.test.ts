/**
 * `spendRows`/`unknownSpendRows` (issue #81): pure formatting over a `meeting`/`tool` rollup group. Table of
 * cases from the issue's own acceptance criteria: all unknown, partial cost, partial tokens, mixed currency,
 * null currency, estimated vs. reported never merged, zero calls.
 */
import { describe, expect, it } from 'vitest';
import { appTranslate, spendRows, unknownSpendRows } from '../../src/components/usage/spendFormat';
import type { RollupTotals } from '../../src/integrations/ledgerClient';

const en = appTranslate('en');

const EMPTY_TOKEN_KIND = { sum: null, reportedCalls: 0, unreportedCalls: 0 };

function totals(overrides: Partial<RollupTotals> = {}): RollupTotals {
  return {
    calls: { total: 0, succeeded: 0, failed: 0 },
    tokens: {
      input: { ...EMPTY_TOKEN_KIND },
      output: { ...EMPTY_TOKEN_KIND },
      cacheRead: { ...EMPTY_TOKEN_KIND },
      cacheWrite: { ...EMPTY_TOKEN_KIND },
      reasoning: { ...EMPTY_TOKEN_KIND },
    },
    cost: { entries: [], unknownCostCalls: 0 },
    firstAt: null,
    lastAt: null,
    ...overrides,
  };
}

describe('spendRows', () => {
  it('shows calls, input/output tokens and "unknown" cost when nothing else was reported (zero calls)', () => {
    const rows = spendRows(totals(), 'en', en);
    expect(rows.find((r) => r.key === 'calls')?.value).toBe('0');
    expect(rows.find((r) => r.key === 'tokens.input')?.value).toBe('unknown');
    expect(rows.find((r) => r.key === 'tokens.output')?.value).toBe('unknown');
    expect(rows.find((r) => r.key === 'cost')?.value).toBe('unknown');
  });

  it('marks a token kind partial when some calls did not report it', () => {
    const rows = spendRows(
      totals({ tokens: { ...totals().tokens, input: { sum: 100, reportedCalls: 3, unreportedCalls: 2 } } }),
      'en',
      en
    );
    expect(rows.find((r) => r.key === 'tokens.input')?.value).toBe('100 (unknown in 2 of 5 calls)');
  });

  it('only shows cache/reasoning tokens when the server actually reported or attempted them', () => {
    const withoutCache = spendRows(totals(), 'en', en);
    expect(withoutCache.some((r) => r.key === 'tokens.cacheRead')).toBe(false);

    const withCache = spendRows(
      totals({ tokens: { ...totals().tokens, cacheRead: { sum: 40, reportedCalls: 1, unreportedCalls: 0 } } }),
      'en',
      en
    );
    expect(withCache.find((r) => r.key === 'tokens.cacheRead')?.value).toBe('40');
  });

  it('shows one row per currency, never a combined number, and marks each with its own cost source', () => {
    const rows = spendRows(
      totals({
        cost: {
          entries: [
            { currency: 'USD', costSource: 'provider-reported', sum: 0.04, calls: 10 },
            { currency: 'EUR', costSource: 'estimated', sum: 3.1, calls: 2 },
          ],
          unknownCostCalls: 0,
        },
      }),
      'en',
      en
    );
    const costRows = rows.filter((r) => r.key.startsWith('cost.'));
    expect(costRows).toHaveLength(2);
    expect(costRows[0].value).toContain('provider reported');
    expect(costRows[1].value).toContain('estimated');
    // Never a single merged amount: each row keeps its own currency's figure.
    expect(costRows.join(' ')).not.toMatch(/3\.14/);
  });

  it('shows a cost with no currency as a plain number, tagged "currency not reported"', () => {
    const rows = spendRows(
      totals({ cost: { entries: [{ currency: null, costSource: 'unknown', sum: 0.02, calls: 1 }], unknownCostCalls: 0 } }),
      'en',
      en
    );
    const cost = rows.find((r) => r.key.startsWith('cost.'));
    expect(cost?.value).toContain('Currency not reported');
    expect(cost?.value).not.toMatch(/[$€]/);
  });

  it('appends a partial-cost row with the count when some calls had no cost at all', () => {
    const rows = spendRows(
      totals({
        cost: { entries: [{ currency: 'USD', costSource: 'provider-reported', sum: 0.04, calls: 10 }], unknownCostCalls: 2 },
      }),
      'en',
      en
    );
    expect(rows.find((r) => r.key === 'cost.partial')?.value).toBe('+ 2 calls with unknown cost');
  });
});

describe('unknownSpendRows', () => {
  it('reads "unknown" for calls, tokens and cost, never 0', () => {
    const rows = unknownSpendRows('en');
    expect(rows.map((r) => r.value)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
  });
});
