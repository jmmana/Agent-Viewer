/**
 * Scrape-time cache for the ledger-derived families (issue #103's "Scrape cost control"): `AGENT_VIEWER_
 * METRICS_CACHE_MS` (default 5000, `0` disables the cache), concurrent scrapes share one in-flight computation
 * regardless of the TTL, and a failing ledger query is never cached (the next scrape retries immediately).
 *
 * Kept as a small, independently testable class (constructed with plain functions, no Express or env coupling)
 * so `tests/metrics-ledger.test.mjs` can drive it with a fake clock and a fake store instead of mounting the HTTP
 * route.
 */
import type { EventStore } from '../store';
import { computeLedgerFamilies, type LedgerFamiliesResult } from './ledgerFamilies';

export interface LedgerFamiliesCacheOptions {
  getStore: () => EventStore;
  getTtlMs: () => number;
  getMaxModels: () => number;
  now?: () => number;
}

export class LedgerFamiliesCache {
  private readonly getStore: () => EventStore;
  private readonly getTtlMs: () => number;
  private readonly getMaxModels: () => number;
  private readonly now: () => number;
  private cached: { result: LedgerFamiliesResult; computedAt: number } | null = null;
  private inFlight: Promise<LedgerFamiliesResult> | null = null;

  constructor(options: LedgerFamiliesCacheOptions) {
    this.getStore = options.getStore;
    this.getTtlMs = options.getTtlMs;
    this.getMaxModels = options.getMaxModels;
    this.now = options.now ?? Date.now;
  }

  /** Current cache depth, for tests only: `0` means no computation has completed yet (or the last one failed). */
  get computedAt(): number | null {
    return this.cached?.computedAt ?? null;
  }

  async get(): Promise<LedgerFamiliesResult> {
    const ttl = this.getTtlMs();
    if (ttl > 0 && this.cached !== null && this.now() - this.cached.computedAt < ttl) {
      return this.cached.result;
    }
    if (this.inFlight !== null) return this.inFlight;

    const promise = computeLedgerFamilies(this.getStore(), this.getMaxModels());
    this.inFlight = promise;
    try {
      const result = await promise;
      // Not cached when ttl <= 0: every call recomputes, but concurrent callers still shared the one in-flight
      // promise above.
      if (ttl > 0) this.cached = { result, computedAt: this.now() };
      return result;
    } finally {
      if (this.inFlight === promise) this.inFlight = null;
    }
  }
}
