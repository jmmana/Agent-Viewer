/**
 * Ledger-derived Prometheus families (issue #348, second sub-issue of #103): tokens, cost, calls, failures,
 * latency and the two ledger gauges, computed at scrape time from the usage ledger (#65). Deliberately built on
 * the two primitives `GET /api/v1/usage/rollup` (#66) and `GET /api/v1/usage/export` (#69) already share
 * (`store.rollup()` for the ledger's current end-of-seq and global first/last `received_at`, `store.
 * iterateExportRows()` for the row stream, both already identical across memory and SQLite mode), instead of a
 * second, looser aggregation path: the one new piece of logic here is the per-`(provider, model)` grouping these
 * families need (rollup groups by dimension, not by an arbitrary label tuple with a cardinality cap) and the
 * latency histogram's fixed buckets, neither of which `computeMemoryRollup`/`computeSqliteRollup` compute today.
 *
 * `store.iterateExportRows()` already streams the ledger strictly ascending by `seq` (insertion order), which is
 * exactly "first appearance order" (issue #103's cardinality-cap rule: "the first N distinct (provider, model)
 * pairs by first appearance ... ordering by first appearance keeps series stable across scrapes"): the `Map` built
 * below preserves JS insertion order, so its key order *is* first-appearance order with no separate tracking.
 *
 * Label hygiene: `provider`/`model` are sanitized (`sanitizeLabelValue`, `server/metrics.ts`) before the grouping
 * key is built, so two raw values that collapse to the same sanitized string already merge into one series here,
 * never two (issue #103's "sanitizing is applied before grouping" rule). A `null` provider or model (never
 * reported) becomes the literal label `"unknown"`, mirroring the issue's own `currency="unknown"` convention for
 * a missing dimension.
 */
import type { EventStore } from '../store';
import { emptyUsageFilters } from '../usage/types';
import type { UsageLedgerRow } from '../usageLedger';
import { isLlmErrorKind } from '../../src/integrations/canonicalTypes';
import { nanoToDecimalCost } from '../pricing/estimate';
import { sanitizeLabelValue, type MetricFamily, type MetricSample } from '../metrics';

export const DEFAULT_METRICS_MAX_MODELS = 100;

/** The 10 finite bucket bounds in seconds (issue #103's own list); `+Inf` is implicit, one slot past the last. */
export const LATENCY_BUCKET_BOUNDS_SECONDS: readonly number[] = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];
export const LATENCY_BUCKET_LE_LABELS: readonly string[] = [
  '0.1', '0.25', '0.5', '1', '2.5', '5', '10', '30', '60', '120', '+Inf',
];

const OTHER_LABEL = '__other__';
const UNKNOWN_LABEL = 'unknown';

type TokenKindLabel = 'input' | 'output' | 'cache_read' | 'cache_write' | 'reasoning';
const TOKEN_KIND_FIELDS: ReadonlyArray<{ label: TokenKindLabel; field: keyof UsageLedgerRow }> = [
  { label: 'input', field: 'inputTokens' },
  { label: 'output', field: 'outputTokens' },
  { label: 'cache_read', field: 'cacheReadTokens' },
  { label: 'cache_write', field: 'cacheWriteTokens' },
  { label: 'reasoning', field: 'reasoningTokens' },
];
const TOKEN_KIND_LABELS: readonly TokenKindLabel[] = TOKEN_KIND_FIELDS.map((f) => f.label);

interface GroupAcc {
  provider: string;
  model: string;
  tokenSum: Record<TokenKindLabel, number>;
  tokenReported: Record<TokenKindLabel, number>;
  tokenUnreported: Record<TokenKindLabel, number>;
  /** Sum of reported (`costSource==='provider-reported'`) cost, per currency. */
  costReported: Map<string, number>;
  /** Sum of the ledger's own nano-integer estimate, per currency; converted to decimal once at output time
   * (never per row), matching `nanoToDecimalCost`'s own "running integer sum" contract. */
  costEstimatedNano: Map<string, number>;
  /** Successful (`status=ok`) calls only, per issue #103's own rule for this family. */
  costUnknownCalls: { reported: number; estimated: number };
  callsOk: number;
  callsFailed: number;
  failuresByKind: Map<string, number>;
  /** Non-cumulative counts per bucket index (0..9 finite, 10 = +Inf only); rendered cumulative at output time. */
  latencyBucketCounts: number[];
  latencySumSeconds: number;
  latencyCount: number;
}

function emptyGroup(provider: string, model: string): GroupAcc {
  return {
    provider,
    model,
    tokenSum: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 },
    tokenReported: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 },
    tokenUnreported: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 },
    costReported: new Map(),
    costEstimatedNano: new Map(),
    costUnknownCalls: { reported: 0, estimated: 0 },
    callsOk: 0,
    callsFailed: 0,
    failuresByKind: new Map(),
    latencyBucketCounts: new Array(LATENCY_BUCKET_LE_LABELS.length).fill(0),
    latencySumSeconds: 0,
    latencyCount: 0,
  };
}

function addToMap(map: Map<string, number>, key: string, delta: number): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

function mergeGroupInto(target: GroupAcc, source: GroupAcc): void {
  for (const kind of TOKEN_KIND_LABELS) {
    target.tokenSum[kind] += source.tokenSum[kind];
    target.tokenReported[kind] += source.tokenReported[kind];
    target.tokenUnreported[kind] += source.tokenUnreported[kind];
  }
  for (const [currency, sum] of source.costReported) addToMap(target.costReported, currency, sum);
  for (const [currency, nano] of source.costEstimatedNano) addToMap(target.costEstimatedNano, currency, nano);
  target.costUnknownCalls.reported += source.costUnknownCalls.reported;
  target.costUnknownCalls.estimated += source.costUnknownCalls.estimated;
  target.callsOk += source.callsOk;
  target.callsFailed += source.callsFailed;
  for (const [kind, count] of source.failuresByKind) addToMap(target.failuresByKind, kind, count);
  for (let i = 0; i < target.latencyBucketCounts.length; i++) target.latencyBucketCounts[i]! += source.latencyBucketCounts[i]!;
  target.latencySumSeconds += source.latencySumSeconds;
  target.latencyCount += source.latencyCount;
}

/** First finite bucket whose bound the value does not exceed, or the `+Inf` slot (last index) when it exceeds
 * every finite bound. */
function bucketIndexFor(seconds: number): number {
  for (let i = 0; i < LATENCY_BUCKET_BOUNDS_SECONDS.length; i++) {
    if (seconds <= LATENCY_BUCKET_BOUNDS_SECONDS[i]!) return i;
  }
  return LATENCY_BUCKET_BOUNDS_SECONDS.length;
}

function accumulateRow(group: GroupAcc, row: UsageLedgerRow): void {
  const isOk = row.eventType === 'llm.usage';
  if (isOk) group.callsOk++;
  else group.callsFailed++;

  for (const { label, field } of TOKEN_KIND_FIELDS) {
    const value = row[field] as number | null;
    if (value !== null) {
      group.tokenSum[label] += value;
      group.tokenReported[label]++;
    } else {
      group.tokenUnreported[label]++;
    }
  }

  // "a row with a cost but costSource=unknown is not summed into cost_reported" (issue #103).
  if (row.cost !== null && row.costSource === 'provider-reported') {
    addToMap(group.costReported, row.currency ?? UNKNOWN_LABEL, row.cost);
  }

  const estimateStatus = row.estimateStatus ?? 'not_estimated';
  const isEstimated = estimateStatus === 'estimated' && row.estimatedCostNano !== null && row.estimatedCurrency !== null;
  if (isEstimated) {
    addToMap(group.costEstimatedNano, row.estimatedCurrency!, row.estimatedCostNano!);
  }

  // "Successful (status=ok) rows for which that cost kind is unknown" (issue #103): only ok rows count here.
  if (isOk) {
    if (row.cost === null || row.costSource === 'unknown') group.costUnknownCalls.reported++;
    if (!isEstimated) group.costUnknownCalls.estimated++;
  }

  if (!isOk) {
    const kind = isLlmErrorKind(row.errorKind) ? row.errorKind : 'unknown';
    addToMap(group.failuresByKind, kind, 1);
  }

  if (row.latencyMs !== null) {
    const seconds = row.latencyMs / 1000;
    group.latencyBucketCounts[bucketIndexFor(seconds)]!++;
    group.latencySumSeconds += seconds;
    group.latencyCount++;
  }
}

function labelFor(value: string | null): string {
  if (value === null) return UNKNOWN_LABEL;
  const sanitized = sanitizeLabelValue(value);
  return sanitized.length > 0 ? sanitized : UNKNOWN_LABEL;
}

export interface LedgerGaugeSnapshot {
  /** Unix seconds of the oldest retained ledger row (`received_at`), `null` on an empty ledger. */
  retainedSinceSeconds: number | null;
  /** Unix seconds of the newest ledger row (`received_at`), `null` on an empty ledger. */
  lastUsageTimestampSeconds: number | null;
}

export interface LedgerFamiliesResult {
  families: MetricFamily[];
  gauges: LedgerGaugeSnapshot;
}

const EXPORT_SCOPE_GROUP_BY = ['agent'] as const;

/**
 * Computes every ledger-derived family (issue #103's "Ledger-derived" table) plus the two ledger gauges, in one
 * pass over the ledger. `maxModels` is the cardinality cap (`AGENT_VIEWER_METRICS_MAX_MODELS`); the caller reads
 * the env var (`server/index.ts`, same pattern as every other per-request env read in that file).
 */
export async function computeLedgerFamilies(store: EventStore, maxModels: number = DEFAULT_METRICS_MAX_MODELS): Promise<LedgerFamiliesResult> {
  const filters = emptyUsageFilters();
  // Minimal rollup call, same pattern `server/usage/export.ts` uses to pin a snapshot before streaming: `groupBy`
  // and `limit` are irrelevant here, only `asOf.ledgerSeq` (the streaming upper bound) and `totals.firstAt`/
  // `totals.lastAt` (received-time basis, the default) are read.
  const seed = await store.rollup({ groupBy: [...EXPORT_SCOPE_GROUP_BY], filters, sort: 'key', limit: 1, include: [] });
  const ledgerSeq = seed.asOf.ledgerSeq;

  const groups = new Map<string, GroupAcc>();
  if (ledgerSeq !== null) {
    for await (const row of store.iterateExportRows(filters, ledgerSeq)) {
      const provider = labelFor(row.provider);
      const model = labelFor(row.model);
      const key = `${provider}\u0000${model}`;
      let group = groups.get(key);
      if (!group) {
        group = emptyGroup(provider, model);
        groups.set(key, group);
      }
      accumulateRow(group, row);
    }
  }

  // Cardinality cap (issue #103): first `maxModels` keys by insertion order (= first appearance, since rows were
  // streamed strictly ascending by seq) keep their own series; the rest fold into one `__other__` pair.
  const entries = [...groups.values()];
  const kept = entries.slice(0, Math.max(0, maxModels));
  const overflow = entries.slice(Math.max(0, maxModels));
  if (overflow.length > 0) {
    const other = emptyGroup(OTHER_LABEL, OTHER_LABEL);
    for (const group of overflow) mergeGroupInto(other, group);
    kept.push(other);
  }

  const families: MetricFamily[] = [
    buildTokensFamily(kept),
    buildTokenUnreportedFamily(kept),
    buildCostReportedFamily(kept),
    buildCostEstimatedFamily(kept),
    buildCostUnknownFamily(kept),
    buildCallsFamily(kept),
    buildFailuresFamily(kept),
    buildLatencyFamily(kept),
  ];

  return {
    families,
    gauges: {
      retainedSinceSeconds: seed.totals.firstAt !== null ? seed.totals.firstAt / 1000 : null,
      lastUsageTimestampSeconds: seed.totals.lastAt !== null ? seed.totals.lastAt / 1000 : null,
    },
  };
}

function baseLabels(group: GroupAcc): { provider: string; model: string } {
  return { provider: group.provider, model: group.model };
}

function buildTokensFamily(groups: readonly GroupAcc[]): MetricFamily {
  const samples: MetricSample[] = [];
  for (const group of groups) {
    for (const kind of TOKEN_KIND_LABELS) {
      if (group.tokenReported[kind] > 0) {
        samples.push({ labels: { ...baseLabels(group), kind }, value: group.tokenSum[kind] });
      }
    }
  }
  return {
    name: 'agent_viewer_tokens_total',
    help: 'Tokens reported by model calls, by kind. Summed only over rows that reported that kind; see agent_viewer_token_kind_unreported_calls_total for the rest.',
    type: 'counter',
    samples,
  };
}

function buildTokenUnreportedFamily(groups: readonly GroupAcc[]): MetricFamily {
  const samples: MetricSample[] = [];
  for (const group of groups) {
    for (const kind of TOKEN_KIND_LABELS) {
      if (group.tokenUnreported[kind] > 0) {
        samples.push({ labels: { ...baseLabels(group), kind }, value: group.tokenUnreported[kind] });
      }
    }
  }
  return {
    name: 'agent_viewer_token_kind_unreported_calls_total',
    help: 'Calls where a token kind was not reported (null), so a dashboard can show "unknown" instead of a misleading 0.',
    type: 'counter',
    samples,
  };
}

function buildCostReportedFamily(groups: readonly GroupAcc[]): MetricFamily {
  const samples: MetricSample[] = [];
  for (const group of groups) {
    for (const [currency, sum] of group.costReported) {
      samples.push({ labels: { ...baseLabels(group), currency }, value: sum });
    }
  }
  return {
    name: 'agent_viewer_cost_reported_total',
    help: 'Provider-reported cost, per currency. Never summed across currencies.',
    type: 'counter',
    samples,
  };
}

function buildCostEstimatedFamily(groups: readonly GroupAcc[]): MetricFamily {
  const samples: MetricSample[] = [];
  for (const group of groups) {
    for (const [currency, nanoSum] of group.costEstimatedNano) {
      samples.push({ labels: { ...baseLabels(group), currency }, value: nanoToDecimalCost(nanoSum) });
    }
  }
  return {
    name: 'agent_viewer_cost_estimated_total',
    help: "The ledger's own ingestion-time cost estimate, per currency. Never added to agent_viewer_cost_reported_total.",
    type: 'counter',
    samples,
  };
}

function buildCostUnknownFamily(groups: readonly GroupAcc[]): MetricFamily {
  const samples: MetricSample[] = [];
  for (const group of groups) {
    if (group.costUnknownCalls.reported > 0) {
      samples.push({ labels: { ...baseLabels(group), cost_kind: 'reported' }, value: group.costUnknownCalls.reported });
    }
    if (group.costUnknownCalls.estimated > 0) {
      samples.push({ labels: { ...baseLabels(group), cost_kind: 'estimated' }, value: group.costUnknownCalls.estimated });
    }
  }
  return {
    name: 'agent_viewer_cost_unknown_calls_total',
    help: 'Successful calls with no known cost of that kind. Never folded into a cost sum as a 0.',
    type: 'counter',
    samples,
  };
}

function buildCallsFamily(groups: readonly GroupAcc[]): MetricFamily {
  const samples: MetricSample[] = [];
  for (const group of groups) {
    if (group.callsOk > 0) samples.push({ labels: { ...baseLabels(group), status: 'ok' }, value: group.callsOk });
    if (group.callsFailed > 0) samples.push({ labels: { ...baseLabels(group), status: 'failed' }, value: group.callsFailed });
  }
  return {
    name: 'agent_viewer_llm_calls_total',
    help: 'Model calls, one per ledger row (already deduplicated by requestId at ingestion time).',
    type: 'counter',
    samples,
  };
}

function buildFailuresFamily(groups: readonly GroupAcc[]): MetricFamily {
  const samples: MetricSample[] = [];
  for (const group of groups) {
    for (const [errorKind, count] of group.failuresByKind) {
      samples.push({ labels: { ...baseLabels(group), error_kind: errorKind }, value: count });
    }
  }
  return {
    name: 'agent_viewer_llm_failures_total',
    help: 'Failed calls by error_kind. The sum over error_kind equals agent_viewer_llm_calls_total{status="failed"} for each (provider, model).',
    type: 'counter',
    samples,
  };
}

function buildLatencyFamily(groups: readonly GroupAcc[]): MetricFamily {
  const samples: MetricSample[] = [];
  for (const group of groups) {
    if (group.latencyCount === 0) continue;
    let cumulative = 0;
    for (let i = 0; i < LATENCY_BUCKET_LE_LABELS.length; i++) {
      cumulative += group.latencyBucketCounts[i]!;
      samples.push({ labels: { ...baseLabels(group), le: LATENCY_BUCKET_LE_LABELS[i]! }, value: cumulative, suffix: '_bucket' });
    }
    samples.push({ labels: baseLabels(group), value: group.latencySumSeconds, suffix: '_sum' });
    samples.push({ labels: baseLabels(group), value: group.latencyCount, suffix: '_count' });
  }
  return {
    name: 'agent_viewer_llm_latency_seconds',
    help: 'Model-call latency from the reported latencyMs. Only calls with a reported latencyMs are observed, so _count can be lower than agent_viewer_llm_calls_total.',
    type: 'histogram',
    samples,
  };
}

/** Builds the two ledger gauge families from a `LedgerGaugeSnapshot`. Separate from `computeLedgerFamilies` so a
 * cache wrapper can store the cheap gauge values without re-running the per-group families (not needed today,
 * since both come from the same pass, but keeps the shape ready for a future split). */
export function buildLedgerGaugeFamilies(gauges: LedgerGaugeSnapshot): MetricFamily[] {
  return [
    {
      name: 'agent_viewer_ledger_retained_since_seconds',
      help: 'Unix time of the oldest retained ledger row. Omitted on an empty ledger.',
      type: 'gauge',
      samples: gauges.retainedSinceSeconds !== null ? [{ labels: {}, value: gauges.retainedSinceSeconds }] : [],
    },
    {
      name: 'agent_viewer_ledger_last_usage_timestamp_seconds',
      help: 'Unix time of the newest ledger row. Omitted on an empty ledger, never a false 0.',
      type: 'gauge',
      samples: gauges.lastUsageTimestampSeconds !== null ? [{ labels: {}, value: gauges.lastUsageTimestampSeconds }] : [],
    },
  ];
}
