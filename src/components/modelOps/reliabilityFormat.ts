/**
 * Pure formatting helpers for the Matrix tab's per-model latency/failure-rate figures (issue #286, the UI half
 * of #89; the server's own aggregation lives in `server/usage/reliability.ts` and is never reimplemented here,
 * only formatted: these functions take numbers the server already computed and decide how to print them).
 *
 * `engine/modelOps.ts` is part of the embeddable library bundle and must never gain ledger-only logic (see its
 * own doc comment), so these helpers live here instead, alongside `usageFormat.ts`.
 */
import { t, type Locale, type TranslationKey } from '../../i18n';
import type { ReliabilityFailures, ReliabilityLatency } from '../../integrations/ledgerClient';

type MessageParams = Record<string, string | number>;

function tr(locale: Locale, key: TranslationKey, params?: MessageParams): string {
  return t(locale, key, params);
}

/** Below this many latency samples, a p50/p95 is still shown (a low sample count is still the only figure
 * there is) but flagged, visually and in text, as low-confidence (issue #286, rule 4). */
export const LOW_SAMPLE_THRESHOLD = 20;

export interface FormattedLatency {
  /** "No latency reported" when `samples === 0`, never "0 ms"; otherwise the p50/p95/sample-size summary. */
  text: string;
  /** `true` exactly when `0 < samples < LOW_SAMPLE_THRESHOLD`. Never true at `samples === 0`: that case has its
   * own text and no percentile to flag. */
  lowConfidence: boolean;
}

/** `p50Ms`/`p95Ms` are `null` only when `samples === 0` (`server/usage/reliability.ts`'s `summarizeLatency`), so
 * the `?? na` fallback below is defensive, not a path this contract can actually reach with `samples > 0`. */
export function formatLatencySummary(latency: ReliabilityLatency, locale: Locale): FormattedLatency {
  if (latency.samples === 0) {
    return { text: tr(locale, 'ops.reliability.noLatency'), lowConfidence: false };
  }
  const na = tr(locale, 'ops.value.na');
  const text = tr(locale, 'ops.reliability.latencySummary', {
    p50: latency.p50Ms === null ? na : latency.p50Ms.toLocaleString(locale),
    p95: latency.p95Ms === null ? na : latency.p95Ms.toLocaleString(locale),
    samples: latency.samples.toLocaleString(locale),
    missing: latency.missing.toLocaleString(locale),
  });
  return { text, lowConfidence: latency.samples < LOW_SAMPLE_THRESHOLD };
}

/** `failureRate` is an unrounded fraction (0..1) from the server, `null` only when `attempts === 0`. Display
 * rounds to one decimal place, except a genuine but tiny rate (`0 < rate < 0.05%`) which would otherwise round
 * down to a misleading "0.0 %": that one case renders "< 0.1 %" instead (issue #286, rule 5). `null` always
 * renders "No data", never "0 %". */
export function formatFailureRate(failureRate: number | null, locale: Locale): string {
  if (failureRate === null) return tr(locale, 'ops.reliability.noData');
  const percent = failureRate * 100;
  if (failureRate > 0 && percent < 0.05) return tr(locale, 'ops.reliability.failureRateTiny');
  return tr(locale, 'ops.reliability.failureRatePercent', {
    value: percent.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  });
}

export interface ErrorKindEntry {
  kind: string;
  count: number;
}

/** Sorted desc by count, for the textual error-kind breakdown. A pure reshape of `byErrorKind`: no bucket is
 * invented or dropped, `'unspecified'`/`'rate_limited'` included like any other key the server sent. */
export function errorKindBreakdown(failures: ReliabilityFailures): ErrorKindEntry[] {
  return Object.entries(failures.byErrorKind)
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);
}
