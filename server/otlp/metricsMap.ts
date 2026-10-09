/**
 * The metric name and `type` attribute mapping table (issue #73, section 1). Kept as one constant table so a
 * name change from the Claude Code side (the issue's own caveat: these names were not re-verified against the
 * live monitoring docs while writing the spec) is a one-line fix here instead of a hunt through the mapper.
 */

export type MetricKind = 'tokens' | 'cost';

/** Only these two OTLP metric names are stored; everything else is ignored without error. */
export const TRACKED_METRIC_NAMES: ReadonlyMap<string, MetricKind> = new Map([
  ['claude_code.token.usage', 'tokens'],
  ['claude_code.cost.usage', 'cost'],
]);

/** Reconciliation field a normalized `type` attribute maps to. Cache naming follows issue #46 (read vs write). */
export type ReconciliationTokenField = 'input' | 'output' | 'cacheRead' | 'cacheCreation';

const TOKEN_TYPE_MAP: ReadonlyMap<string, ReconciliationTokenField> = new Map([
  ['input', 'input'],
  ['output', 'output'],
  ['cacheread', 'cacheRead'],
  ['cachecreation', 'cacheCreation'],
]);

/** Lowercase, strip `_`, per issue #73 section 1 ("normalized: lowercase, no `_`"). */
export function normalizeTokenType(raw: string): string {
  return raw.toLowerCase().replaceAll('_', '');
}

/**
 * Maps a raw `type` attribute to the reconciliation field it feeds, or `null` when it is unmapped (unknown
 * value, or the attribute was missing). An unmapped type is still stored as given, just excluded from any sum.
 */
export function reconciliationFieldForType(rawType: string | undefined): ReconciliationTokenField | null {
  if (rawType === undefined) return null;
  return TOKEN_TYPE_MAP.get(normalizeTokenType(rawType)) ?? null;
}
