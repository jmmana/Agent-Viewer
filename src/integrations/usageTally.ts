/**
 * Usage tally for the portal: honest figures per currency and cost source.
 *
 * Rules that every figure follows:
 * - Unknown is never zero. A token kind or cost that a call did not report is counted in a separate counter.
 * - Amounts in different currencies, or with a different `costSource`, are never added together.
 * - Nothing is priced, estimated or converted here.
 *
 * This module is pure TypeScript with no React, and is importable by the server the same way
 * the server imports from canonicalContract.
 */

export type CostSource = 'provider-reported' | 'estimated' | 'unknown';

/** Sum over the calls that reported this figure. Calls that did not are unknown, never zero. */
export interface TokenTally {
  sum: number; // non-negative integer
  reportedCalls: number; // calls that carried a finite value
}

/** One currency and one cost source. Buckets are never added together. */
export interface CostBucket {
  currency: string | null; // ISO 4217, or null when the call reported a cost without a currency
  source: CostSource; // estimated and billed cost never share a bucket
  amount: number;
  calls: number;
}

export interface UsageTally {
  calls: number; // llm.usage events counted (after dedup)
  inputTokens: TokenTally;
  outputTokens: TokenTally;
  cacheReadTokens: TokenTally;
  cacheWriteTokens: TokenTally;
  reasoningTokens: TokenTally;
  cost: {
    buckets: CostBucket[]; // sorted by currency (null last), then source; deterministic for tests and diffs
    unknownCalls: number; // calls with cost null or missing
  };
}

export interface UsageCall {
  // one normalized llm.usage payload, already read
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  cost: number | null;
  currency: string | null;
  costSource: CostSource;
}

export function emptyUsageTally(): UsageTally {
  return {
    calls: 0,
    inputTokens: { sum: 0, reportedCalls: 0 },
    outputTokens: { sum: 0, reportedCalls: 0 },
    cacheReadTokens: { sum: 0, reportedCalls: 0 },
    cacheWriteTokens: { sum: 0, reportedCalls: 0 },
    reasoningTokens: { sum: 0, reportedCalls: 0 },
    cost: { buckets: [], unknownCalls: 0 },
  };
}

/** Reads one normalized llm.usage payload. The only place that maps contract fields to the tally. */
export function readUsageCall(payload: Record<string, unknown>): UsageCall {
  const inputTokens = readTokenCount(payload.inputTokens);
  const outputTokens = readTokenCount(payload.outputTokens);
  const cacheReadTokens = readTokenCount(payload.cacheReadTokens);
  const cacheWriteTokens = readTokenCount(payload.cacheWriteTokens);
  const reasoningTokens = readTokenCount(payload.reasoningTokens);

  const cost = readCost(payload.cost);
  const currency = readCurrency(payload.currency);
  let costSource: CostSource = 'unknown';
  if (typeof payload.costSource === 'string' && ['provider-reported', 'estimated', 'unknown'].includes(payload.costSource)) {
    costSource = payload.costSource as CostSource;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    cost,
    currency,
    costSource,
  };
}

function readTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readCurrency(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && /^[A-Z]{3}$/.test(value)) return value;
  return null;
}

export function addUsageCall(tally: UsageTally, call: UsageCall): void {
  tally.calls++;

  // Add tokens
  addTokenCount(tally.inputTokens, call.inputTokens);
  addTokenCount(tally.outputTokens, call.outputTokens);
  addTokenCount(tally.cacheReadTokens, call.cacheReadTokens);
  addTokenCount(tally.cacheWriteTokens, call.cacheWriteTokens);
  addTokenCount(tally.reasoningTokens, call.reasoningTokens);

  // Add cost
  if (call.cost !== null) {
    const bucketKey = `${call.currency ?? 'null'}:${call.costSource}`;
    let bucket = tally.cost.buckets.find(
      (b) => b.currency === call.currency && b.source === call.costSource
    );
    if (!bucket) {
      bucket = {
        currency: call.currency,
        source: call.costSource,
        amount: 0,
        calls: 0,
      };
      tally.cost.buckets.push(bucket);
    }
    bucket.amount += call.cost;
    bucket.calls++;
  } else {
    tally.cost.unknownCalls++;
  }
}

function addTokenCount(tally: TokenTally, value: number | null): void {
  if (value !== null) {
    tally.sum += value;
    tally.reportedCalls++;
  }
}

/** Sort cost buckets deterministically: by currency (null last), then by source. */
function sortCostBuckets(buckets: CostBucket[]): void {
  buckets.sort((a, b) => {
    if (a.currency === null && b.currency !== null) return 1;
    if (a.currency !== null && b.currency === null) return -1;
    if (a.currency !== b.currency) return (a.currency ?? '').localeCompare(b.currency ?? '');
    return a.source.localeCompare(b.source);
  });
}

export function mergeUsageTally(a: UsageTally, b: UsageTally): UsageTally {
  const result = emptyUsageTally();
  result.calls = a.calls + b.calls;
  mergeTokenTally(result.inputTokens, a.inputTokens, b.inputTokens);
  mergeTokenTally(result.outputTokens, a.outputTokens, b.outputTokens);
  mergeTokenTally(result.cacheReadTokens, a.cacheReadTokens, b.cacheReadTokens);
  mergeTokenTally(result.cacheWriteTokens, a.cacheWriteTokens, b.cacheWriteTokens);
  mergeTokenTally(result.reasoningTokens, a.reasoningTokens, b.reasoningTokens);

  // Merge cost buckets
  const bucketMap = new Map<string, CostBucket>();
  for (const bucket of [...a.cost.buckets, ...b.cost.buckets]) {
    const key = `${bucket.currency ?? 'null'}:${bucket.source}`;
    const existing = bucketMap.get(key);
    if (existing) {
      existing.amount += bucket.amount;
      existing.calls += bucket.calls;
    } else {
      bucketMap.set(key, { ...bucket });
    }
  }
  result.cost.buckets = Array.from(bucketMap.values());
  sortCostBuckets(result.cost.buckets);
  result.cost.unknownCalls = a.cost.unknownCalls + b.cost.unknownCalls;

  return result;
}

function mergeTokenTally(result: TokenTally, a: TokenTally, b: TokenTally): void {
  result.sum = a.sum + b.sum;
  result.reportedCalls = a.reportedCalls + b.reportedCalls;
}

export function cloneUsageTally(tally: UsageTally): UsageTally {
  return {
    calls: tally.calls,
    inputTokens: { ...tally.inputTokens },
    outputTokens: { ...tally.outputTokens },
    cacheReadTokens: { ...tally.cacheReadTokens },
    cacheWriteTokens: { ...tally.cacheWriteTokens },
    reasoningTokens: { ...tally.reasoningTokens },
    cost: {
      buckets: tally.cost.buckets.map((b) => ({ ...b })),
      unknownCalls: tally.cost.unknownCalls,
    },
  };
}

export function isUsageTally(value: unknown): value is UsageTally {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  if (typeof obj.calls !== 'number' || obj.calls < 0) return false;

  // Check token tallies
  if (!isTokenTally(obj.inputTokens)) return false;
  if (!isTokenTally(obj.outputTokens)) return false;
  if (!isTokenTally(obj.cacheReadTokens)) return false;
  if (!isTokenTally(obj.cacheWriteTokens)) return false;
  if (!isTokenTally(obj.reasoningTokens)) return false;

  // Check cost
  if (typeof obj.cost !== 'object' || obj.cost === null) return false;
  const costObj = obj.cost as Record<string, unknown>;
  if (!Array.isArray(costObj.buckets)) return false;
  for (const bucket of costObj.buckets) {
    if (!isCostBucket(bucket)) return false;
  }
  if (typeof costObj.unknownCalls !== 'number' || costObj.unknownCalls < 0) return false;

  return true;
}

function isTokenTally(value: unknown): value is TokenTally {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.sum === 'number' &&
    obj.sum >= 0 &&
    typeof obj.reportedCalls === 'number' &&
    obj.reportedCalls >= 0
  );
}

function isCostBucket(value: unknown): value is CostBucket {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    (obj.currency === null || (typeof obj.currency === 'string' && /^[A-Z]{3}$/.test(obj.currency))) &&
    (obj.source === 'provider-reported' || obj.source === 'estimated' || obj.source === 'unknown') &&
    typeof obj.amount === 'number' &&
    obj.amount >= 0 &&
    typeof obj.calls === 'number' &&
    obj.calls > 0
  );
}
