/**
 * Pure latency-percentile and failure-rate summarizers for the usage rollup endpoint's `include=latency,failures`
 * extension (issue #89). Kept here, with no dependency on either store backend, so the memory and SQLite rollup
 * paths (`server/usage/rollup.ts`) can never diverge on how a raw sample set turns into a p50/p95 or a failure
 * rate: both call these same functions over the rows they each fetch.
 *
 * Naming note, resolved against the real shipped code rather than this issue's own illustrative text: the issue's
 * response example calls the provider rate-limit error kind `'rate_limit'`, but the enum actually shipped by issue
 * #46 (`LLM_ERROR_KINDS`, `src/integrations/canonicalTypes.ts`) names it `'rate_limited'`. `RATE_LIMIT_ERROR_KIND`
 * below uses the real value.
 */

export type ReliabilityMethod = 'nearest-rank';

export interface ReliabilityLatency {
  p50Ms: number | null;
  p95Ms: number | null;
  samples: number;
  missing: number;
  method: ReliabilityMethod;
}

export interface ReliabilityFailures {
  byErrorKind: Record<string, number>;
  rateLimitCount: number;
}

/** The one `errorKind` (`LLM_ERROR_KINDS`) issue #89 calls a "provider rate limit". */
export const RATE_LIMIT_ERROR_KIND = 'rate_limited';

/**
 * The ledger's own sentinel for "no `errorKind` reported or recognized": `toLedgerRow` (issue #46/#65) never
 * actually stores `NULL` in `usage_ledger.error_kind` for a `llm.failed` row, nor does `normalizeCanonicalEvent`
 * leave an unrecognized value in the payload; both resolve it to the literal string `'unknown'` before the row
 * ever reaches storage, so a genuinely-missing `errorKind` and an explicitly-reported `'unknown'` are already
 * indistinguishable by the time a rollup query sees them. This issue's API calls that bucket `unspecified`; a
 * literal `null` is also mapped here, as defense in depth, in case a future ledger version ever stores one.
 */
export function failureErrorKindKey(errorKind: string | null): string {
  return errorKind === null || errorKind === 'unknown' ? 'unspecified' : errorKind;
}

/**
 * Nearest-rank percentile (issue #89, rule 4): `value = sorted[ceil(p * n) - 1]`. Deterministic and always
 * returns an observed value, never an interpolated one. `samples` must be non-empty; every caller here only ever
 * invokes this once it has checked that (see `summarizeLatency`), since an empty sample set has no observed value
 * to return (`p50Ms`/`p95Ms: null`, not a thrown error, is the honest answer for that case).
 */
export function nearestRankPercentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) {
    throw new Error('nearestRankPercentile: samples must be non-empty (an empty sample set has no percentile)');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index]!;
}

/**
 * Builds the `latency` object (issue #89, section 2) from one group's (or `totals`') raw latency samples. A
 * sample is only ever a succeeded (`llm.usage`) row's reported `latencyMs`, already guaranteed by the ledger
 * (`toLedgerRow`) to be a finite integer >= 0; `missing` is the count of succeeded calls that had none. A `0` is
 * a real sample (`samples` counts it, `p50Ms`/`p95Ms` can be `0`); an empty sample set returns `null` percentiles,
 * never `0`.
 */
export function summarizeLatency(samples: readonly number[], missing: number): ReliabilityLatency {
  if (samples.length === 0) {
    return { p50Ms: null, p95Ms: null, samples: 0, missing, method: 'nearest-rank' };
  }
  return {
    p50Ms: nearestRankPercentile(samples, 0.5),
    p95Ms: nearestRankPercentile(samples, 0.95),
    samples: samples.length,
    missing,
    method: 'nearest-rank',
  };
}

/** Builds the `failures` object from a per-`errorKind` count map whose keys are already `failureErrorKindKey`
 * output (so `'unspecified'` is the only bucket a missing/unrecognized kind can ever land in). */
export function summarizeFailures(byErrorKind: Readonly<Record<string, number>>): ReliabilityFailures {
  return { byErrorKind: { ...byErrorKind }, rateLimitCount: byErrorKind[RATE_LIMIT_ERROR_KIND] ?? 0 };
}

/** `failureRate` (issue #89, rule 5): unrounded (rounding for display is a UI concern), `null` when there were no
 * attempts at all (never a false `0`), `0` when there were attempts and none failed. */
export function computeFailureRate(failedCalls: number, attempts: number): number | null {
  return attempts === 0 ? null : failedCalls / attempts;
}
