/**
 * Pure formatting rules for the Matrix tab's latency/failure-rate figures (issue #286): no samples never reads
 * "0 ms", no attempts never reads "0 %", a tiny-but-real failure rate is "< 0.1 %" instead of a misleading
 * "0.0 %", and a low sample count is flagged without hiding the figure.
 */
import { describe, expect, it } from 'vitest';
import {
  LOW_SAMPLE_THRESHOLD,
  errorKindBreakdown,
  formatFailureRate,
  formatLatencySummary,
} from '../../src/components/modelOps/reliabilityFormat';
import type { ReliabilityFailures, ReliabilityLatency } from '../../src/integrations/ledgerClient';

function latency(overrides: Partial<ReliabilityLatency> = {}): ReliabilityLatency {
  return { p50Ms: 820, p95Ms: 2310, samples: 1102, missing: 78, method: 'nearest-rank', ...overrides };
}

describe('LOW_SAMPLE_THRESHOLD', () => {
  it('is 20', () => {
    expect(LOW_SAMPLE_THRESHOLD).toBe(20);
  });
});

describe('formatLatencySummary', () => {
  it('renders p50/p95 with the sample size and missing-latency count', () => {
    const result = formatLatencySummary(latency(), 'en');
    expect(result.text).toBe('p50 820 ms · p95 2,310 ms (n = 1,102, 78 without latency)');
    expect(result.lowConfidence).toBe(false);
  });

  it('never renders "0 ms" when there are no samples: "No latency reported" instead', () => {
    const result = formatLatencySummary(latency({ p50Ms: null, p95Ms: null, samples: 0, missing: 12 }), 'en');
    expect(result.text).toBe('No latency reported');
    expect(result.text).not.toContain('0 ms');
    expect(result.lowConfidence).toBe(false);
  });

  it('flags low confidence when samples < LOW_SAMPLE_THRESHOLD, without hiding the figure', () => {
    const result = formatLatencySummary(latency({ samples: 19, missing: 0 }), 'en');
    expect(result.lowConfidence).toBe(true);
    expect(result.text).toContain('820');
  });

  it('does not flag low confidence at exactly the threshold', () => {
    const result = formatLatencySummary(latency({ samples: 20 }), 'en');
    expect(result.lowConfidence).toBe(false);
  });

  it('renders in Spanish', () => {
    const result = formatLatencySummary(latency(), 'es');
    expect(result.text).toContain('sin latencia');
  });
});

describe('formatFailureRate', () => {
  it('renders "No data" for a null rate, never "0 %"', () => {
    expect(formatFailureRate(null, 'en')).toBe('No data');
  });

  it('renders a real zero rate as "0.0 %" (there were attempts, none failed)', () => {
    expect(formatFailureRate(0, 'en')).toBe('0.0 %');
  });

  it('renders a tiny but real rate as "< 0.1 %", never a rounded-down "0.0 %"', () => {
    expect(formatFailureRate(0.0001, 'en')).toBe('< 0.1 %');
  });

  it('rounds an ordinary rate to one decimal place', () => {
    expect(formatFailureRate(0.0234, 'en')).toBe('2.3 %');
  });
});

describe('errorKindBreakdown', () => {
  it('sorts entries by count, descending', () => {
    const failures: ReliabilityFailures = { byErrorKind: { timeout: 3, rate_limited: 9, unspecified: 1 }, rateLimitCount: 9 };
    expect(errorKindBreakdown(failures)).toEqual([
      { kind: 'rate_limited', count: 9 },
      { kind: 'timeout', count: 3 },
      { kind: 'unspecified', count: 1 },
    ]);
  });

  it('returns an empty list when there are no failures', () => {
    expect(errorKindBreakdown({ byErrorKind: {}, rateLimitCount: 0 })).toEqual([]);
  });
});
