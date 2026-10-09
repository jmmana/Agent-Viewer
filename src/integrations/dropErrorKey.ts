import type { EventLogParseResult } from './eventLogParser';

/**
 * Chooses which `drop.*` locale key the demo app shows after a drop that produced zero events (issue #74).
 * Before this helper, every empty result showed the generic `drop.noEvents`, so even a clear "metrics cannot
 * be replayed" issue never reached the user. Precedence (first match wins) follows the proposal: a file-level
 * OTLP issue (metrics, then traces) outranks the logs-specific ones, which outrank a per-record rejection.
 *
 * Pure and framework-free so it is unit-testable on its own, without rendering anything.
 */
export function getDropErrorKey(result: Pick<EventLogParseResult, 'events' | 'issues'>): string {
  if (result.events.length > 0) return '';
  const codes = new Set(result.issues.map((issue) => issue.code));
  if (codes.has('otlp-metrics-not-replayable')) return 'drop.otlpMetrics';
  if (codes.has('otlp-traces-not-supported')) return 'drop.otlpTraces';
  if (codes.has('otlp-no-usage-records')) return 'drop.otlpNoUsage';
  if (codes.has('otlp-record-skipped')) return 'drop.otlpRejected';
  return 'drop.noEvents';
}
