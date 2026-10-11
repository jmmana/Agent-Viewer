/**
 * Pricing admin API (issue #83 section 5, sub-issue #272): the 8 `/api/v1/pricing*` endpoints, built on top of
 * the contract/resolver (`src/integrations/pricingContract.ts`, issue #270) and the file store
 * (`server/pricing/store.ts`, issue #271).
 *
 * `registerPricingRoutes` is called once by `server/index.ts`, after its existing `/api/v1` middleware chain
 * (rate limiter, query-token rejection, open-mode guard, Bearer auth) is already registered, so every route here
 * gets exactly the same protection as every other `/api/v1` route. This module only adds the admin-write checks
 * `POST /pricing/changes` and `POST /pricing/reload` need on top of that (issue #83 section 5: "An API token is
 * configured", `AGENT_VIEWER_PRICING_READONLY`).
 *
 * `deps.getStore` is a thunk, not the store itself: `server/index.ts` must not call `getPricingStore()` at
 * import time (that would touch disk for every test that merely imports `app`), so this module resolves it lazily,
 * once per request, exactly like `getApiToken()`/`currentAuthMode()` are read per request.
 *
 * `usageTimestampForPricing` is the one shared helper issue #83 asks every later item (notably #84) to reuse: the
 * event's own clock, falling back to the server's receive time. `GET /pricing/coverage` below approximates it by
 * running the shared usage rollup (`server/usage/rollup.ts`, issue #66) with `timeBasis: 'occurred'`, since
 * `occurredAt` is the "event time" half of that rule; `usageTimestampForPricing` itself stays exported for #84,
 * which resolves one row's price individually rather than a grouped aggregate.
 */
import express from 'express';
import {
  PriceEntryInputSchema,
  PriceEntryKeySchema,
  parseZonedInstant,
  priceEntryNaturalKey,
  resolvePrice,
  validatePriceEntryCollection,
  type PriceEntry,
  type PriceEntryKey,
  type PricingVersion,
  type ValidationIssue,
} from '../../src/integrations/pricingContract';
import { PricingStoreUnwritableError, type PricingStore, type PricingStoreSnapshot } from './store';
import type { UsageLedgerRow } from '../usageLedger';
import type { RollupQuery, UsageRollupResponse } from '../usage/types';
import { parseRollupQuery, UsageFilterError } from '../usage/rollup';

export interface PricingApiDeps {
  /** Resolves the memoized pricing store, lazily (see module doc comment: never call this at import time). */
  getStore: () => PricingStore;
  /** `true` when `AGENT_VIEWER_API_TOKEN`/`AGENT_VIEWER_API_KEY` is configured (issue #83 section 5: writes
   * require this, reads do not). Read per request, like the rest of `/api/v1`'s auth state. */
  hasAdminToken: () => boolean;
  /** `store.rollup` of the main event store (issue #65's usage ledger), reused for `GET /pricing/coverage`
   * instead of a second, hand-rolled ledger scan. */
  usageRollup: (query: RollupQuery) => Promise<UsageRollupResponse>;
}

/** Issue #83 section 2: "event time, falling back to server receive time". `occurredAt` is always a finite
 * number on a `UsageLedgerRow` written by this codebase, but this never trusts that blindly and falls back
 * explicitly, so a row loaded from an older or hand-edited database still resolves to a timestamp. Exported so
 * #84 can reuse it unchanged for its own, per-row price resolution. */
export function usageTimestampForPricing(row: Pick<UsageLedgerRow, 'occurredAt' | 'receivedAt'>): number {
  return typeof row.occurredAt === 'number' && Number.isFinite(row.occurredAt) ? row.occurredAt : row.receivedAt;
}

function validationFailed(res: express.Response, issues: ValidationIssue[]): void {
  res.status(400).json({ error: 'validation_failed', issues });
}

function starterInfo(snapshot: PricingStoreSnapshot) {
  return {
    bundledAsOf: snapshot.starterBundledAsOf,
    appliedAsOf: snapshot.starterAsOf,
    updateAvailable: snapshot.starterAsOf !== null && snapshot.starterBundledAsOf > snapshot.starterAsOf,
  };
}

function pricingResponse(snapshot: PricingStoreSnapshot) {
  return {
    schema: snapshot.schema,
    status: snapshot.status,
    issues: snapshot.issues,
    pricingVersion: snapshot.pricingVersion,
    contentHash: snapshot.contentHash,
    createdAt: snapshot.createdAt,
    estimated: snapshot.entries.some((entry) => entry.estimated),
    starter: starterInfo(snapshot),
    readonly: snapshot.readonly,
    fileInSync: snapshot.fileInSync,
    entries: snapshot.entries,
  };
}

function versionSummary(version: PricingVersion) {
  return {
    pricingVersion: version.pricingVersion,
    createdAt: version.createdAt,
    origin: version.origin,
    reason: version.reason,
    actor: version.actor,
    entryCount: version.entries.length,
    contentHash: version.contentHash,
  };
}

export interface VersionDiffEntry {
  key: { provider: string; model: string; kind: string; effectiveFrom: string };
  before: PriceEntry;
  after: PriceEntry;
}

export interface VersionDiff {
  added: PriceEntry[];
  removed: PriceEntry[];
  changed: VersionDiffEntry[];
}

/** Pure diff of two versions' entries by natural key (issue #83 section 5, `GET /pricing/versions/:v/diff`).
 * `other` is the version named by the path (`:version`), `base` is the one named by `?against=`. */
export function diffPricingVersions(base: PricingVersion, other: PricingVersion): VersionDiff {
  const baseByKey = new Map(base.entries.map((entry) => [priceEntryNaturalKey(entry), entry]));
  const otherByKey = new Map(other.entries.map((entry) => [priceEntryNaturalKey(entry), entry]));

  const added: PriceEntry[] = [];
  const changed: VersionDiffEntry[] = [];
  for (const [key, entry] of otherByKey) {
    const before = baseByKey.get(key);
    if (!before) {
      added.push(entry);
    } else if (JSON.stringify(before) !== JSON.stringify(entry)) {
      changed.push({
        key: { provider: entry.provider, model: entry.model, kind: entry.kind, effectiveFrom: entry.effectiveFrom },
        before,
        after: entry,
      });
    }
  }
  const removed: PriceEntry[] = [];
  for (const [key, entry] of baseByKey) {
    if (!otherByKey.has(key)) removed.push(entry);
  }
  return { added, removed, changed };
}

/** A positive-integer path/query param (`:version`, `?against=`, `?beforeVersion=`), or `null` if it is not one. */
function parsePositiveInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function registerPricingRoutes(app: express.Express, deps: PricingApiDeps): void {
  const { getStore, hasAdminToken, usageRollup } = deps;

  // ---------------------------------------------------------------
  // GET /pricing
  // ---------------------------------------------------------------
  app.get('/api/v1/pricing', (_req, res) => {
    res.json(pricingResponse(getStore().getSnapshot()));
  });

  // ---------------------------------------------------------------
  // GET /pricing/versions
  // ---------------------------------------------------------------
  app.get('/api/v1/pricing/versions', (req, res) => {
    let limit = 100;
    if (req.query.limit !== undefined) {
      const raw = req.query.limit;
      const parsed = typeof raw === 'string' ? Number(raw) : NaN;
      if (typeof raw !== 'string' || !/^\d+$/.test(raw) || parsed < 1 || parsed > 500) {
        validationFailed(res, [{ path: 'limit', message: 'must be an integer between 1 and 500' }]);
        return;
      }
      limit = parsed;
    }
    let beforeVersion: number | null = null;
    if (req.query.beforeVersion !== undefined) {
      const raw = req.query.beforeVersion;
      beforeVersion = typeof raw === 'string' ? parsePositiveInt(raw) : null;
      if (beforeVersion === null) {
        validationFailed(res, [{ path: 'beforeVersion', message: 'must be a positive integer' }]);
        return;
      }
    }
    const newestFirst = [...getStore().listVersions()].reverse();
    const filtered = beforeVersion === null ? newestFirst : newestFirst.filter((v) => v.pricingVersion < beforeVersion!);
    res.json({ versions: filtered.slice(0, limit).map(versionSummary) });
  });

  // ---------------------------------------------------------------
  // GET /pricing/versions/:version/diff  (registered before the plain :version route is irrelevant in Express,
  // since the two paths have a different segment count, but kept first for readability)
  // ---------------------------------------------------------------
  app.get('/api/v1/pricing/versions/:version/diff', (req, res) => {
    const version = parsePositiveInt(req.params.version);
    const againstRaw = req.query.against;
    const against = typeof againstRaw === 'string' ? parsePositiveInt(againstRaw) : null;
    const issues: ValidationIssue[] = [];
    if (version === null) issues.push({ path: 'version', message: 'must be a positive integer' });
    if (against === null) issues.push({ path: 'against', message: 'must be a positive integer' });
    if (issues.length > 0) {
      validationFailed(res, issues);
      return;
    }
    const store = getStore();
    const other = store.getVersion(version!);
    const base = store.getVersion(against!);
    if (!other || !base) {
      res.status(404).json({ error: 'version_not_found' });
      return;
    }
    res.json(diffPricingVersions(base, other));
  });

  // ---------------------------------------------------------------
  // GET /pricing/versions/:version
  // ---------------------------------------------------------------
  app.get('/api/v1/pricing/versions/:version', (req, res) => {
    const version = parsePositiveInt(req.params.version);
    if (version === null) {
      validationFailed(res, [{ path: 'version', message: 'must be a positive integer' }]);
      return;
    }
    const found = getStore().getVersion(version);
    if (!found) {
      res.status(404).json({ error: 'version_not_found' });
      return;
    }
    res.json(found);
  });

  // ---------------------------------------------------------------
  // GET /pricing/resolve
  // ---------------------------------------------------------------
  app.get('/api/v1/pricing/resolve', (req, res) => {
    const providerRaw = req.query.provider;
    const modelRaw = req.query.model;
    const issues: ValidationIssue[] = [];
    if (typeof providerRaw !== 'string' || providerRaw.trim() === '') issues.push({ path: 'provider', message: 'is required' });
    if (typeof modelRaw !== 'string' || modelRaw.trim() === '') issues.push({ path: 'model', message: 'is required' });
    const at = parseZonedInstant(req.query.at);
    if (at === null) issues.push({ path: 'at', message: 'must be an ISO 8601 instant with an explicit zone (Z or +hh:mm)' });
    let version: number | null = null;
    if (req.query.version !== undefined) {
      const raw = req.query.version;
      version = typeof raw === 'string' ? parsePositiveInt(raw) : null;
      if (version === null) issues.push({ path: 'version', message: 'must be a positive integer' });
    }
    if (issues.length > 0) {
      validationFailed(res, issues);
      return;
    }

    const store = getStore();
    let entries: PriceEntry[];
    let pricingVersion: number;
    if (version !== null) {
      const found = store.getVersion(version);
      if (!found) {
        res.status(404).json({ error: 'version_not_found' });
        return;
      }
      entries = found.entries;
      pricingVersion = found.pricingVersion;
    } else {
      const snapshot = store.getSnapshot();
      if (snapshot.status === 'history_invalid' || snapshot.pricingVersion === null) {
        res.status(503).json({ error: 'pricing_unavailable' });
        return;
      }
      entries = snapshot.entries;
      pricingVersion = snapshot.pricingVersion;
    }

    const provider = providerRaw as string;
    const model = modelRaw as string;
    const entry = resolvePrice(entries, { provider, model, at: at as string });
    if (!entry) {
      res.status(404).json({ error: 'price_not_found', message: `No price for ${provider}/${model} at ${at}` });
      return;
    }
    res.json({ pricingVersion, entry });
  });

  // ---------------------------------------------------------------
  // GET /pricing/coverage (needs #65's usage ledger)
  // ---------------------------------------------------------------
  app.get('/api/v1/pricing/coverage', async (req, res) => {
    const issues: ValidationIssue[] = [];
    let since: string | null = null;
    if (req.query.since !== undefined) {
      since = parseZonedInstant(req.query.since);
      if (since === null) issues.push({ path: 'since', message: 'must be an ISO 8601 instant with an explicit zone (Z or +hh:mm)' });
    }
    let limit = 200;
    if (req.query.limit !== undefined) {
      const raw = req.query.limit;
      const parsed = typeof raw === 'string' ? Number(raw) : NaN;
      if (typeof raw !== 'string' || !/^\d+$/.test(raw) || parsed < 1 || parsed > 500) {
        issues.push({ path: 'limit', message: 'must be an integer between 1 and 500' });
      } else {
        limit = parsed;
      }
    }
    if (issues.length > 0) {
      validationFailed(res, issues);
      return;
    }

    const snapshot = getStore().getSnapshot();
    if (snapshot.status === 'history_invalid') {
      res.status(503).json({ error: 'pricing_unavailable' });
      return;
    }

    let rollupQuery: RollupQuery;
    try {
      rollupQuery = parseRollupQuery({
        groupBy: 'provider,model',
        sort: 'calls',
        limit: '10000',
        timeBasis: 'occurred',
        ...(since !== null ? { from: since } : {}),
      });
    } catch (error) {
      if (error instanceof UsageFilterError) {
        validationFailed(res, error.issues);
        return;
      }
      throw error;
    }

    const rollup = await usageRollup(rollupQuery);

    // Design note: a group's "is it priced" check resolves at its own `lastAt` (falling back to `firstAt`), not
    // per row. Issue #83's "usageTimestampForPricing(row)" rule is naturally per-row; this endpoint reuses the
    // already-tested grouped aggregation of `server/usage/rollup.ts` (issue #66) instead of a second hand-rolled
    // ledger scan, which means a model priced only from partway through the requested window is still reported
    // here as priced. Documented in `docs/pricing.md`.
    let withoutModelCalls = 0;
    const unpriced: Array<{ provider: string; model: string; calls: number; firstSeenAt: string | null; lastSeenAt: string | null }> = [];
    for (const group of rollup.groups) {
      const provider = group.key.provider ?? null;
      const model = group.key.model ?? null;
      if (provider === null || model === null) {
        withoutModelCalls += group.calls.total;
        continue;
      }
      const at = group.lastAt ?? group.firstAt;
      const resolved = at === null ? null : resolvePrice(snapshot.entries, { provider, model, at });
      if (!resolved) {
        unpriced.push({
          provider,
          model,
          calls: group.calls.total,
          firstSeenAt: group.firstAt === null ? null : new Date(group.firstAt).toISOString(),
          lastSeenAt: group.lastAt === null ? null : new Date(group.lastAt).toISOString(),
        });
      }
    }
    unpriced.sort((a, b) => b.calls - a.calls);
    res.json({
      pricingVersion: snapshot.pricingVersion,
      unpriced: unpriced.slice(0, limit),
      withoutModel: { calls: withoutModelCalls },
      truncated: unpriced.length > limit,
    });
  });

  // ---------------------------------------------------------------
  // POST /pricing/changes
  // ---------------------------------------------------------------
  app.post('/api/v1/pricing/changes', (req, res) => {
    if (!hasAdminToken()) {
      res.status(403).json({ error: 'admin_requires_token' });
      return;
    }
    const store = getStore();
    const snapshot = store.getSnapshot();
    if (snapshot.readonly) {
      res.status(403).json({ error: 'pricing_readonly' });
      return;
    }

    const body = req.body as Record<string, unknown> | null;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      validationFailed(res, [{ path: '', message: 'Request body must be a JSON object' }]);
      return;
    }
    const { expectedVersion, reason, actor, upserts, removals } = body;

    const issues: ValidationIssue[] = [];
    if (!Number.isInteger(expectedVersion) || (expectedVersion as number) <= 0) {
      issues.push({ path: 'expectedVersion', message: 'is required and must be a positive integer' });
    }
    if (typeof reason !== 'string' || reason.length < 1 || reason.length > 500) {
      issues.push({ path: 'reason', message: 'is required, 1 to 500 characters' });
    }
    if (actor !== undefined && actor !== null && (typeof actor !== 'string' || actor.length < 1 || actor.length > 100)) {
      issues.push({ path: 'actor', message: 'must be 1 to 100 characters when provided' });
    }
    const upsertsRaw = upserts === undefined ? [] : upserts;
    const removalsRaw = removals === undefined ? [] : removals;
    if (!Array.isArray(upsertsRaw) || upsertsRaw.length > 500) {
      issues.push({ path: 'upserts', message: 'must be an array of at most 500 items' });
    }
    if (!Array.isArray(removalsRaw) || removalsRaw.length > 500) {
      issues.push({ path: 'removals', message: 'must be an array of at most 500 items' });
    }
    if (Array.isArray(upsertsRaw) && Array.isArray(removalsRaw) && upsertsRaw.length === 0 && removalsRaw.length === 0) {
      issues.push({ path: '', message: 'At least one of "upserts" or "removals" must be non-empty' });
    }
    if (issues.length > 0) {
      validationFailed(res, issues);
      return;
    }

    const parsedUpserts: PriceEntry[] = [];
    (upsertsRaw as unknown[]).forEach((item, index) => {
      const result = PriceEntryInputSchema.safeParse(item);
      if (!result.success) {
        issues.push(...result.error.issues.map((issue) => ({ path: `upserts[${index}].${issue.path.join('.')}`, message: issue.message })));
      } else {
        // `source` is never trusted from input (issue #83 section 2): the API always forces it (section 5:
        // "source of upserted entries is forced to 'api' by the server").
        parsedUpserts.push({ ...result.data, source: 'api' } as PriceEntry);
      }
    });
    const parsedRemovals: PriceEntryKey[] = [];
    (removalsRaw as unknown[]).forEach((item, index) => {
      const result = PriceEntryKeySchema.safeParse(item);
      if (!result.success) {
        issues.push(...result.error.issues.map((issue) => ({ path: `removals[${index}].${issue.path.join('.')}`, message: issue.message })));
      } else {
        parsedRemovals.push(result.data);
      }
    });
    if (issues.length > 0) {
      validationFailed(res, issues);
      return;
    }

    const upsertKeys = new Map<string, number>();
    for (const [index, entry] of parsedUpserts.entries()) {
      const key = priceEntryNaturalKey(entry);
      if (upsertKeys.has(key)) issues.push({ path: `upserts[${index}]`, message: 'duplicate natural key within upserts' });
      else upsertKeys.set(key, index);
    }
    const removalKeySet = new Set(parsedRemovals.map(priceEntryNaturalKey));
    if ([...upsertKeys.keys()].some((key) => removalKeySet.has(key))) {
      issues.push({ path: '', message: 'A key cannot appear in both "upserts" and "removals"' });
    }
    if (issues.length > 0) {
      validationFailed(res, issues);
      return;
    }

    // Issue #83 section 5: a stale `expectedVersion`, or a broken store, is checked before touching any entry.
    if (expectedVersion !== snapshot.pricingVersion) {
      res.status(409).json({ error: 'version_conflict', currentVersion: snapshot.pricingVersion });
      return;
    }
    if (snapshot.status === 'file_invalid') {
      res.status(409).json({ error: 'pricing_file_invalid', issues: snapshot.issues });
      return;
    }
    if (snapshot.status === 'history_invalid') {
      res.status(503).json({ error: 'pricing_unavailable' });
      return;
    }

    const byKey = new Map(snapshot.entries.map((entry) => [priceEntryNaturalKey(entry), entry]));
    for (const removal of parsedRemovals) {
      const key = priceEntryNaturalKey(removal);
      if (!byKey.has(key)) {
        res.status(400).json({ error: 'removal_not_found', provider: removal.provider, model: removal.model, kind: removal.kind, effectiveFrom: removal.effectiveFrom });
        return;
      }
      byKey.delete(key);
    }
    for (const entry of parsedUpserts) byKey.set(priceEntryNaturalKey(entry), entry);
    const nextEntries = [...byKey.values()];

    const collectionIssues = validatePriceEntryCollection(nextEntries);
    if (collectionIssues.length > 0) {
      validationFailed(res, collectionIssues);
      return;
    }

    try {
      const result = store.applyApiChange(nextEntries, { reason: reason as string, actor: (actor as string | null | undefined) ?? null });
      if (!result.changed) {
        res.status(200).json({ changed: false, pricingVersion: result.snapshot.pricingVersion });
        return;
      }
      res.status(201).json({
        changed: true,
        pricingVersion: result.snapshot.pricingVersion,
        parentVersion: result.snapshot.parentVersion,
        contentHash: result.snapshot.contentHash,
        createdAt: result.snapshot.createdAt,
        fileInSync: result.snapshot.fileInSync,
      });
    } catch (error) {
      if (error instanceof PricingStoreUnwritableError) {
        res.status(503).json({ error: 'pricing_store_unwritable' });
        return;
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------
  // POST /pricing/reload
  // ---------------------------------------------------------------
  app.post('/api/v1/pricing/reload', (_req, res) => {
    if (!hasAdminToken()) {
      res.status(403).json({ error: 'admin_requires_token' });
      return;
    }
    const store = getStore();
    const before = store.getSnapshot();
    let after: PricingStoreSnapshot;
    try {
      after = store.reload();
    } catch (error) {
      if (error instanceof PricingStoreUnwritableError) {
        res.status(503).json({ error: 'pricing_store_unwritable' });
        return;
      }
      throw error;
    }
    if (after.status === 'history_invalid') {
      res.status(503).json({ error: 'pricing_unavailable' });
      return;
    }
    if (after.status === 'file_invalid') {
      validationFailed(res, after.issues);
      return;
    }
    if (after.pricingVersion !== before.pricingVersion) {
      res.status(201).json({
        changed: true,
        pricingVersion: after.pricingVersion,
        parentVersion: after.parentVersion,
        contentHash: after.contentHash,
        createdAt: after.createdAt,
        fileInSync: after.fileInSync,
      });
      return;
    }
    res.status(200).json({ changed: false, pricingVersion: after.pricingVersion });
  });
}
