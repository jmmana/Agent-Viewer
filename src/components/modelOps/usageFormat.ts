/**
 * Shared rendering rules for the ledger-backed Model Ops tabs (issue #79): a reported-`null` metric is always
 * "n/a", never `0`; a partially reported metric carries a "partial" marker and the count of calls that did not
 * report it; cost is shown per currency and cost source, never summed across either.
 */
import { t, type Locale, type TranslationKey } from '../../i18n';
import { compactTokens } from '../../engine/modelOps';
import type { CostEntry, TokenKind } from '../../integrations/ledgerClient';

type MessageParams = Record<string, string | number>;

function tr(locale: Locale, key: TranslationKey, params?: MessageParams): string {
  return t(locale, key, params);
}

export interface TokenMetricInput {
  sum: number | null;
  reportedCalls: number;
  unreportedCalls: number;
}

export interface FormattedTokenMetric {
  /** "n/a" or the compacted token count. */
  text: string;
  isPartial: boolean;
  /** Set when `isPartial`: "N of M calls did not report this". */
  title?: string;
}

/** Renders one token metric (input, output, cache read, cache write, reasoning) of one rollup group or totals
 * row. `groupCallsTotal` is that same group's own `calls.total` (never the grand totals), since the partial
 * marker counts calls within this one row. */
export function formatTokenMetric(metric: TokenMetricInput, groupCallsTotal: number, locale: Locale): FormattedTokenMetric {
  if (metric.sum === null) {
    return { text: tr(locale, 'ops.value.na'), isPartial: false };
  }
  const text = compactTokens(metric.sum);
  if (metric.unreportedCalls > 0) {
    return {
      text,
      isPartial: true,
      title: tr(locale, 'ops.value.partialTitle', { unreported: metric.unreportedCalls, total: groupCallsTotal }),
    };
  }
  return { text, isPartial: false };
}

export interface FormattedCostEntry {
  text: string;
  /** Set for any `costSource` other than `'provider-reported'`: that chip must carry a visible source label. */
  sourceLabel?: string;
  currency: string | null;
  costSource: CostEntry['costSource'];
}

/** One chip per `(currency, costSource)` pair; entries of different currencies or sources are never merged, so
 * this is a direct 1:1 map over the server's own `cost.entries`, formatting only. */
export function formatCostEntries(entries: CostEntry[], locale: Locale): FormattedCostEntry[] {
  return entries.map((entry) => {
    const text = entry.currency
      ? new Intl.NumberFormat(locale, { style: 'currency', currency: entry.currency, maximumFractionDigits: 6 }).format(entry.sum)
      : entry.sum.toFixed(6);
    const sourceLabel =
      entry.costSource === 'provider-reported'
        ? undefined
        : entry.costSource === 'estimated'
          ? tr(locale, 'ops.cost.source.estimated')
          : tr(locale, 'ops.cost.source.unknown');
    return { text, sourceLabel, currency: entry.currency, costSource: entry.costSource };
  });
}

/** Distinct `(currency, costSource)` keys across a set of rows' cost entries: sort-by-cost is disabled whenever
 * this has more than one member (mixed currencies or mixed sources can never be summed into one ranking). */
export function distinctCostKeys(rowsCostEntries: CostEntry[][]): Set<string> {
  const keys = new Set<string>();
  for (const entries of rowsCostEntries) {
    for (const entry of entries) {
      keys.add(`${entry.currency ?? '\u0000'}|${entry.costSource}`);
    }
  }
  return keys;
}

/** `calls` + `failedCalls`, used as-is by Matrix and Agents rows. */
export interface CallCounts {
  total: number;
  failed: number;
}

export function unknownCostLabel(unknownCostCalls: number, locale: Locale): string | null {
  if (unknownCostCalls <= 0) return null;
  return tr(locale, 'ops.cost.unknownCalls', { count: unknownCostCalls });
}

/** Sort key for a token-kind metric: `null` sorts after every known value, regardless of direction, per the
 * "unknown values sort last" rule. */
export function tokenSortKey(metric: TokenMetricInput | undefined): number {
  if (!metric || metric.sum === null) return Number.NEGATIVE_INFINITY;
  return metric.sum;
}

export const TOKEN_KIND_LIST: readonly TokenKind[] = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];
