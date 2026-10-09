/**
 * Pure formatter for UsageTally: honest figures per currency and cost source.
 * Reuses the library's formatTokens and formatCost for consistent formatting.
 */

import { formatTokens, formatCost } from '../../lib/usage';
import type { OfficeTranslate } from '../../content/officeMessages';
import { type TokenTally, type CostBucket, type UsageTally } from '../../integrations/usageTally';

export interface FormattedUsageTokens {
  value: string;
  partial: boolean;
  unknownCount?: number;
  totalCalls?: number;
}

export interface FormattedUsageCost {
  value: string;
  partial: boolean;
  unknownCount?: number;
  items?: string[];
}

/**
 * Format a token tally (e.g., input tokens, cache read tokens).
 * Returns 'unknown' when no calls reported the value.
 * Returns 'value (unknown in N of M calls)' when some calls didn't report it.
 * Otherwise returns the formatted sum.
 */
export function formatTokenTally(
  tally: TokenTally,
  totalCalls: number,
  locale: string | undefined,
  t: OfficeTranslate,
): FormattedUsageTokens {
  if (totalCalls === 0 || tally.reportedCalls === 0) {
    return {
      value: t('usage.unknown'),
      partial: false,
    };
  }

  const value = formatTokens(tally.sum, locale, t);
  if (tally.reportedCalls === totalCalls) {
    return {
      value,
      partial: false,
    };
  }

  // Partial: some calls didn't report this token kind
  const unknownCount = totalCalls - tally.reportedCalls;
  return {
    value: t('usage.partialTokens', {
      value,
      count: unknownCount,
      calls: totalCalls,
    }),
    partial: true,
    unknownCount,
    totalCalls,
  };
}

/**
 * Format cost buckets.
 * - No buckets: 'unknown'
 * - One bucket, no unknowns: formatted amount with optional prefix/suffix
 * - One bucket with unknowns: amount plus 'unknown in N calls' marker
 * - Multiple buckets: each listed, with unknowns noted
 */
export function formatCostBuckets(
  buckets: CostBucket[],
  unknownCalls: number,
  locale: string | undefined,
  t: OfficeTranslate,
): FormattedUsageCost {
  if (buckets.length === 0) {
    return {
      value: t('usage.unknown'),
      partial: unknownCalls > 0,
      unknownCount: unknownCalls,
    };
  }

  const formattedBuckets = buckets.map((bucket) => {
    let formatted = formatCost(bucket.amount, bucket.currency ?? undefined, locale, t);

    // Add source indicator
    if (bucket.source === 'estimated') {
      formatted = `${t('usage.estimatedShort')} ${formatted}`;
    } else if (bucket.source === 'unknown') {
      // Reported amount of unknown origin
      formatted = `${formatted} (${t('usage.sourceUnknown')})`;
    }

    // Add currency note if missing
    if (bucket.currency === null) {
      formatted += ` - ${t('usage.noCurrency')}`;
    }

    return formatted;
  });

  let value: string;
  if (formattedBuckets.length === 1) {
    value = formattedBuckets[0];
  } else {
    // Multiple currencies or sources
    value = formattedBuckets.join(' · ');
  }

  if (unknownCalls > 0) {
    value += ` ${t('usage.partialCost', { count: unknownCalls })}`;
  }

  return {
    value,
    partial: unknownCalls > 0 || buckets.length > 1,
    unknownCount: unknownCalls,
    items: formattedBuckets,
  };
}

/**
 * Compact cost label for views with space constraints (top bar, canvas, sidebar).
 * Returns a label when currencies or sources differ; otherwise returns the formatted value.
 */
export function getCostLabel(buckets: CostBucket[], t: OfficeTranslate): string | null {
  if (buckets.length <= 1) return null;

  // Check if currencies differ
  const currencies = new Set(buckets.map((b) => b.currency ?? 'null'));
  if (currencies.size > 1) {
    return t('usage.mixedCurrencies');
  }

  // Check if sources differ
  const sources = new Set(buckets.map((b) => b.source));
  if (sources.size > 1) {
    return t('usage.mixedSources');
  }

  return null;
}

/**
 * Format the total tokens (input + output) for display.
 * Used consistently across all surfaces.
 */
export function formatTotalTokens(
  usage: UsageTally,
  locale: string | undefined,
  t: OfficeTranslate,
): FormattedUsageTokens {
  const inputSum = usage.inputTokens.sum + usage.outputTokens.sum;
  const inputReported = usage.inputTokens.reportedCalls + usage.outputTokens.reportedCalls;

  if (usage.calls === 0 || inputReported === 0) {
    return {
      value: t('usage.unknown'),
      partial: false,
    };
  }

  const value = formatTokens(inputSum, locale, t);
  const unreportedCalls = (usage.calls * 2) - inputReported; // worst case: both input and output unreported

  if (inputReported >= usage.calls * 2) {
    // All calls reported both input and output
    return {
      value,
      partial: false,
    };
  }

  // Some calls didn't report input or output
  return {
    value: t('usage.partialTokens', {
      value,
      count: unreportedCalls,
      calls: usage.calls,
    }),
    partial: true,
  };
}
