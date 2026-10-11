/**
 * Versioned server pricing table (issue #83, sub-issue: file store, lifecycle and CLI wiring, issue #271).
 *
 * This module is the only place that touches the pricing files on disk. It owns:
 *
 *  - `createPricingStore({ pricingFile, historyFile, readonly, now })`: builds one store bound to a pair of
 *    files, with an injectable clock for tests.
 *  - `getPricingStore()`: a memoized singleton resolved from env vars (`AGENT_VIEWER_PRICING_FILE`,
 *    `AGENT_VIEWER_PRICING_HISTORY_FILE`, `AGENT_VIEWER_PRICING_READONLY`), the one `server/index.ts` uses.
 *  - The full lifecycle from issue #83 section 3: first-start seeding from the bundled starter table, a
 *    pre-written `pricing.json`, reload (re-reading `pricing.json`, source forcing, no-op and stale-file
 *    detection), invalid-file and invalid-history handling, and the atomic write order for a new version.
 *
 * Nothing here is called at module import: `createPricingStore` only touches disk once one of the returned
 * methods runs (`getSnapshot`/`reload`), and `getPricingStore` is a plain function nobody calls just by
 * importing this file. That keeps `server/index.ts` free of file writes at import time (issue #83 acceptance
 * criteria), while `startServer()` calls `getPricingStore()` once at boot so a broken data directory shows up
 * in the server log immediately instead of on the first pricing request.
 *
 * The HTTP endpoints (`GET /pricing`, `POST /pricing/changes`, `/versions`, `/resolve`, `/coverage`) are the
 * next sub-issue of #83 and are not implemented here; this module only exposes what they need to build on.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PRICING_SCHEMA,
  PriceEntrySchema,
  PriceEntryInputSchema,
  PricingVersionSchema,
  computeContentHash,
  parsePriceEntries,
  sortPriceEntries,
  validatePriceEntryCollection,
  type PriceEntry,
  type PriceSource,
  type PricingVersion,
  type ValidationIssue,
  type VersionOrigin,
} from '../../src/integrations/pricingContract';
// Bundled, not read from `server/` at runtime, so `scripts/build-cli.mjs` inlines it into `dist-cli/cli.js`
// (issue #83 section 3). This is the import that makes the starter table reachable from the CLI bundle.
import starter from './starter.json' with { type: 'json' };

export type PricingStoreStatus = 'ok' | 'file_invalid' | 'history_invalid';

/** The store's current, read-only view: the active version plus operational status (issue #83 section 5). */
export interface PricingStoreSnapshot {
  schema: string;
  status: PricingStoreStatus;
  pricingVersion: number | null;
  parentVersion: number | null;
  contentHash: string | null;
  createdAt: string | null;
  origin: VersionOrigin | null;
  starterAsOf: string | null;
  entries: PriceEntry[];
  issues: ValidationIssue[];
  readonly: boolean;
  /** `false` only right after a rename failure left `pricing.json` behind the committed history (section 3). */
  fileInSync: boolean;
  /** `asOf` of the starter table bundled in this build, regardless of whether it was ever applied. */
  starterBundledAsOf: string;
}

export interface PricingStoreOptions {
  pricingFile: string;
  historyFile: string;
  readonly?: boolean;
  /** Epoch milliseconds; defaults to `Date.now`. Injected by tests for deterministic `createdAt` values. */
  now?: () => number;
}

/**
 * Thrown when a write cannot be persisted: the temp file could not be written, or the history line could not
 * be appended and fsynced (issue #83 section 3). The caller (the API sub-issue) maps this to
 * `503 pricing_store_unwritable`. A rename failure after the history line is durable does NOT throw this: the
 * new version is already authoritative, so that case returns normally with `fileInSync: false` instead.
 */
export class PricingStoreUnwritableError extends Error {
  readonly code: 'pricing_store_unwritable' = 'pricing_store_unwritable';
  constructor(message: string) {
    super(message);
    this.name = 'PricingStoreUnwritableError';
  }
}

/** Result of `PricingStore.applyApiChange` (issue #83 section 5, sub-issue #272, `POST /pricing/changes`). */
export interface PricingChangeResult {
  changed: boolean;
  snapshot: PricingStoreSnapshot;
}

export interface PricingStore {
  /** The current snapshot, loading (seeding or ingesting `pricing.json`) on the very first call. */
  getSnapshot(): PricingStoreSnapshot;
  /** Re-reads `pricing.json` from disk and reconciles it against the active version. */
  reload(): PricingStoreSnapshot;
  /** One full historical version by number, or `null` if it does not exist. */
  getVersion(version: number): PricingVersion | null;
  /** Every version recorded so far, oldest first. */
  listVersions(): readonly PricingVersion[];
  /**
   * Commits `entries` (already validated as a whole collection by the caller) as a brand-new version with
   * `origin: 'api'` (issue #83 section 5, `POST /pricing/changes`): a no-op (`changed: false`, no new version)
   * when the resulting content hash is unchanged from the active version. Throws `PricingStoreUnwritableError` on
   * a write failure, exactly like `reload()`. The route is responsible for every HTTP-shaped decision before
   * calling this (admin token, `readonly`, `status`, `expectedVersion`): this method only knows how to commit.
   */
  applyApiChange(entries: PriceEntry[], meta: { reason: string; actor: string | null }): PricingChangeResult;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Loads and validates the append-only history (issue #83 section 3, "History problems"). A final line with no
 * trailing newline that fails to parse is a torn write from a crash: it is dropped and the file truncated in
 * place, with a warning, and loading continues with the remaining lines. Any other problem (bad JSON, a schema
 * failure, a `contentHash` mismatch, or a broken `pricingVersion`/`parentVersion` sequence) is NOT recoverable:
 * the whole history is reported `history_invalid`.
 */
function loadHistory(historyFile: string): { ok: true; versions: PricingVersion[] } | { ok: false; issues: ValidationIssue[] } {
  if (!fs.existsSync(historyFile)) return { ok: true, versions: [] };
  const raw = fs.readFileSync(historyFile, 'utf8');
  if (raw.trim() === '') return { ok: true, versions: [] };

  const endsWithNewline = raw.endsWith('\n');
  let lines = endsWithNewline ? raw.split('\n').slice(0, -1) : raw.split('\n');

  if (!endsWithNewline && lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    let parses = true;
    try {
      JSON.parse(lastLine);
    } catch {
      parses = false;
    }
    if (!parses) {
      lines = lines.slice(0, -1);
      const rewritten = lines.length > 0 ? `${lines.join('\n')}\n` : '';
      try {
        fs.writeFileSync(historyFile, rewritten);
      } catch (error) {
        console.error(`[agent-viewer] pricing: could not truncate the torn line out of ${historyFile}: ${describeError(error)}`);
      }
      console.warn(`[agent-viewer] pricing: dropped a torn final line in ${historyFile} (an interrupted write from a crash)`);
    }
  }

  const issues: ValidationIssue[] = [];
  const versions: PricingVersion[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === '') {
      issues.push({ path: `history[${index}]`, message: 'Empty history line' });
      return;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch (error) {
      issues.push({ path: `history[${index}]`, message: `Line is not valid JSON: ${describeError(error)}` });
      return;
    }
    const result = PricingVersionSchema.safeParse(parsedJson);
    if (!result.success) {
      issues.push(...result.error.issues.map((issue) => ({ path: `history[${index}].${issue.path.join('.')}`, message: issue.message })));
      return;
    }
    const expectedHash = computeContentHash(result.data.entries);
    if (expectedHash !== result.data.contentHash) {
      issues.push({ path: `history[${index}].contentHash`, message: 'contentHash does not match the entries recorded for this version' });
      return;
    }
    versions.push(result.data);
  });
  if (issues.length > 0) return { ok: false, issues };

  for (const [index, version] of versions.entries()) {
    const expectedVersion = index + 1;
    if (version.pricingVersion !== expectedVersion) {
      return {
        ok: false,
        issues: [{ path: `history[${index}].pricingVersion`, message: `Expected version ${expectedVersion}, found ${version.pricingVersion}` }],
      };
    }
    const expectedParent = index === 0 ? null : expectedVersion - 1;
    if (version.parentVersion !== expectedParent) {
      return {
        ok: false,
        issues: [{ path: `history[${index}].parentVersion`, message: `Expected parentVersion ${expectedParent}, found ${version.parentVersion}` }],
      };
    }
  }

  return { ok: true, versions };
}

export function createPricingStore(options: PricingStoreOptions): PricingStore {
  const { pricingFile, historyFile } = options;
  const now = options.now ?? Date.now;
  const readonly = Boolean(options.readonly);

  let loaded = false;
  let versions: PricingVersion[] = [];
  let status: PricingStoreStatus = 'ok';
  let issues: ValidationIssue[] = [];
  let fileInSync = true;

  function activeVersion(): PricingVersion | null {
    return versions.length > 0 ? versions[versions.length - 1] : null;
  }

  function tempFilePath(): string {
    return `${pricingFile}.tmp-${process.pid}-${now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Appends one history line and fsyncs it (issue #83 section 3, write step 2). On failure, truncates back to
   * the size the file had before this call, so a partial line never survives. */
  function appendHistoryLine(version: PricingVersion): void {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    const priorSize = fs.existsSync(historyFile) ? fs.statSync(historyFile).size : 0;
    const line = `${JSON.stringify(version)}\n`;
    let fd: number;
    try {
      fd = fs.openSync(historyFile, 'a');
    } catch (error) {
      throw new PricingStoreUnwritableError(`Cannot open the pricing history file ${historyFile} for append: ${describeError(error)}`);
    }
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } catch (error) {
      try {
        fs.closeSync(fd);
      } catch {
        // already in an error path; nothing more to do with the descriptor
      }
      try {
        fs.truncateSync(historyFile, priorSize);
      } catch {
        // best effort: a failure here still leaves the write-failed error below as the primary signal
      }
      throw new PricingStoreUnwritableError(`Cannot append to the pricing history file ${historyFile}: ${describeError(error)}`);
    }
    fs.closeSync(fd);
  }

  /** Writes `entries` to `pricing.json` through a temp file plus rename (write step 1 and 3). Returns whether
   * the rename succeeded; a failed rename never throws, since by the time this runs the caller has already
   * decided the content is correct (either the just-committed version, or the unchanged active one). */
  function writePricingFile(forVersion: number, entries: readonly PriceEntry[]): boolean {
    fs.mkdirSync(path.dirname(pricingFile), { recursive: true });
    const temp = tempFilePath();
    const content = { schema: PRICING_SCHEMA, basedOnVersion: forVersion, entries };
    try {
      fs.writeFileSync(temp, `${JSON.stringify(content, null, 2)}\n`);
    } catch (error) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // the write itself failed, there may be nothing to remove
      }
      throw new PricingStoreUnwritableError(`Cannot write the pricing file ${pricingFile}: ${describeError(error)}`);
    }
    try {
      fs.renameSync(temp, pricingFile);
      return true;
    } catch (error) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // leave it; the next write or reload creates a fresh temp file anyway
      }
      console.error(`[agent-viewer] pricing: wrote ${pricingFile}'s content but could not rename it into place: ${describeError(error)}`);
      return false;
    }
  }

  /** Commits a brand-new version: write step 1, then step 2 (which durably activates it in memory even if step
   * 3 below fails), then step 3. This is the only place `versions` grows. */
  function commitVersion(entries: readonly PriceEntry[], meta: {
    origin: VersionOrigin;
    reason: string;
    actor: string | null;
    starterAsOf: string | null;
  }): PricingVersion {
    const parent = activeVersion();
    const pricingVersion = (parent?.pricingVersion ?? 0) + 1;
    const sorted = sortPriceEntries(entries);
    const version: PricingVersion = {
      pricingVersion,
      parentVersion: parent?.pricingVersion ?? null,
      createdAt: new Date(now()).toISOString(),
      origin: meta.origin,
      reason: meta.reason,
      actor: meta.actor,
      starterAsOf: meta.starterAsOf,
      contentHash: computeContentHash(sorted),
      entries: sorted,
    };

    fs.mkdirSync(path.dirname(pricingFile), { recursive: true });
    const temp = tempFilePath();
    const content = { schema: PRICING_SCHEMA, basedOnVersion: pricingVersion, entries: sorted };
    try {
      fs.writeFileSync(temp, `${JSON.stringify(content, null, 2)}\n`);
    } catch (error) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // nothing to clean up if the write itself never created the file
      }
      throw new PricingStoreUnwritableError(`Cannot write the pricing file ${pricingFile}: ${describeError(error)}`);
    }

    try {
      appendHistoryLine(version);
    } catch (error) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // best effort cleanup of the orphaned temp file
      }
      throw error;
    }

    // The history line is durable: the version is authoritative from here on, independent of the rename below.
    versions = [...versions, version];
    try {
      fs.renameSync(temp, pricingFile);
      fileInSync = true;
    } catch (error) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // leave it; the next write or reload creates a fresh temp file
      }
      fileInSync = false;
      console.error(
        `[agent-viewer] pricing: committed version ${pricingVersion} to history but could not rename it into ${pricingFile}: ${describeError(error)}; will retry on the next write or reload`,
      );
    }

    status = 'ok';
    issues = [];
    return version;
  }

  /** Rewrites `pricing.json` from an already-active version, without creating a new one (regeneration after a
   * delete, or recovery from a stale file). Never throws: a failure here just leaves `fileInSync: false`. */
  function rewriteFileFromVersion(version: PricingVersion): void {
    const ok = writePricingFileSafely(version.pricingVersion, version.entries);
    fileInSync = ok;
  }

  function writePricingFileSafely(forVersion: number, entries: readonly PriceEntry[]): boolean {
    try {
      return writePricingFile(forVersion, entries);
    } catch (error) {
      console.error(`[agent-viewer] pricing: could not rewrite ${pricingFile}: ${describeError(error)}`);
      return false;
    }
  }

  /**
   * Source forcing (issue #83 section 3): an entry whose non-source fields exactly match an entry of the
   * current version (same natural key) keeps that entry's `source`; anything new or changed gets `'file'`.
   */
  function resolveSource(entry: Omit<PriceEntry, 'source'>, current: PricingVersion | null): PriceSource {
    if (!current) return 'file';
    const match = current.entries.find(
      (existing) =>
        existing.provider === entry.provider
        && existing.model === entry.model
        && existing.kind === entry.kind
        && existing.effectiveFrom === entry.effectiveFrom
        && JSON.stringify(existing.aliases) === JSON.stringify(entry.aliases)
        && existing.currency === entry.currency
        && existing.inputPerMillion === entry.inputPerMillion
        && existing.outputPerMillion === entry.outputPerMillion
        && existing.cacheReadPerMillion === entry.cacheReadPerMillion
        && existing.cacheWritePerMillion === entry.cacheWritePerMillion
        && existing.reasoningPerMillion === entry.reasoningPerMillion
        && existing.reasoningBilling === entry.reasoningBilling
        && existing.estimated === entry.estimated
        && existing.sourceUrl === entry.sourceUrl
        && existing.sourceCheckedAt === entry.sourceCheckedAt
        && existing.note === entry.note,
    );
    return match ? match.source : 'file';
  }

  /**
   * Parses and validates `pricing.json` as operator input: each entry goes through `PriceEntryInputSchema`
   * (so a `source` key present in the file, written there by the server itself for readability, is stripped
   * and never trusted), then gets its `source` forced against `current`, then the whole set is validated as a
   * collection (duplicate keys, alias collisions).
   */
  function readOperatorFile(current: PricingVersion | null): { ok: true; entries: PriceEntry[] } | { ok: false; issues: ValidationIssue[] } {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
    } catch (error) {
      return { ok: false, issues: [{ path: '', message: `pricing.json is not valid JSON: ${describeError(error)}` }] };
    }
    if (!isPlainObject(raw)) {
      return { ok: false, issues: [{ path: '', message: 'pricing.json must be a JSON object' }] };
    }
    const entriesRaw = raw.entries;
    if (!Array.isArray(entriesRaw)) {
      return { ok: false, issues: [{ path: 'entries', message: 'entries must be an array' }] };
    }

    const issuesFound: ValidationIssue[] = [];
    const inputs: Array<Omit<PriceEntry, 'source'>> = [];
    entriesRaw.forEach((item, index) => {
      if (!isPlainObject(item)) {
        issuesFound.push({ path: `entries[${index}]`, message: 'Each entry must be an object' });
        return;
      }
      const { source: _ignoredSource, ...rest } = item;
      const result = PriceEntryInputSchema.safeParse(rest);
      if (!result.success) {
        issuesFound.push(...result.error.issues.map((issue) => ({ path: `entries[${index}].${issue.path.join('.')}`, message: issue.message })));
        return;
      }
      inputs.push(result.data as Omit<PriceEntry, 'source'>);
    });
    if (issuesFound.length > 0) return { ok: false, issues: issuesFound };

    const withSource: PriceEntry[] = inputs.map((entry) => ({ ...entry, source: resolveSource(entry, current) }) as PriceEntry);
    const collectionIssues = validatePriceEntryCollection(withSource);
    if (collectionIssues.length > 0) return { ok: false, issues: collectionIssues };

    return { ok: true, entries: sortPriceEntries(withSource) };
  }

  /**
   * Detects a file left stale by a rename that failed after its history line was already durable (issue #83
   * section 3): the file is parsed with the full, source-trusting schema (it is, after all, content the
   * server itself produced for some earlier version) and accepted as stale only if its `basedOnVersion` names
   * an older version whose recorded `contentHash` matches exactly.
   */
  function detectStaleFile(current: PricingVersion): boolean {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
    } catch {
      return false;
    }
    if (!isPlainObject(raw)) return false;
    const basedOnVersion = raw.basedOnVersion;
    if (typeof basedOnVersion !== 'number' || !Number.isInteger(basedOnVersion) || basedOnVersion >= current.pricingVersion) return false;
    const referenced = versions.find((version) => version.pricingVersion === basedOnVersion);
    if (!referenced) return false;
    if (!Array.isArray(raw.entries)) return false;

    const asWritten: PriceEntry[] = [];
    for (const item of raw.entries) {
      const result = PriceEntrySchema.safeParse(item);
      if (!result.success) return false;
      asWritten.push(result.data);
    }
    return computeContentHash(asWritten) === referenced.contentHash;
  }

  /** Reconciles `pricing.json` against the active version (or seeds one if there is none yet). Used both for
   * the very first load and for an explicit `reload()`. May throw `PricingStoreUnwritableError`. */
  function reconcile(): void {
    const current = activeVersion();

    if (current === null) {
      if (!fs.existsSync(pricingFile)) {
        const starterResult = parsePriceEntries(starter.entries);
        if (!starterResult.success) {
          // The bundled starter failing its own schema is a build defect, not an operator mistake: surface it
          // loudly rather than silently reporting `file_invalid` for a file that does not even exist.
          throw new Error(`The bundled starter pricing table is invalid: ${starterResult.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
        }
        commitVersion(starterResult.entries, {
          origin: 'starter',
          reason: 'Bundled starter table',
          actor: null,
          starterAsOf: starter.starter.asOf,
        });
        return;
      }
      const parsed = readOperatorFile(null);
      if (!parsed.ok) {
        status = 'file_invalid';
        issues = parsed.issues;
        return;
      }
      commitVersion(parsed.entries, { origin: 'file', reason: 'Loaded from pricing.json', actor: null, starterAsOf: null });
      return;
    }

    if (!fs.existsSync(pricingFile)) {
      rewriteFileFromVersion(current);
      status = 'ok';
      issues = [];
      return;
    }

    if (detectStaleFile(current)) {
      rewriteFileFromVersion(current);
      status = 'ok';
      issues = [];
      return;
    }

    const parsed = readOperatorFile(current);
    if (!parsed.ok) {
      status = 'file_invalid';
      issues = parsed.issues;
      return;
    }
    const candidateHash = computeContentHash(parsed.entries);
    if (candidateHash === current.contentHash) {
      status = 'ok';
      issues = [];
      // Usually a true no-op: nothing to write. But if an earlier rename failure left `fileInSync: false`, the
      // file on disk may still carry a stale `basedOnVersion` even though source forcing reconstructed exactly
      // the current entries (the content matches, but the file was never actually rewritten for this version).
      // Heal it now rather than reporting `fileInSync: true` without the file actually reflecting it.
      if (!fileInSync) rewriteFileFromVersion(current);
      else fileInSync = true;
      return;
    }
    commitVersion(parsed.entries, {
      origin: 'file',
      reason: 'Loaded from pricing.json',
      actor: null,
      starterAsOf: current.starterAsOf,
    });
  }

  function ensureLoaded(): void {
    if (loaded) return;
    const history = loadHistory(historyFile);
    if (!history.ok) {
      status = 'history_invalid';
      issues = history.issues;
      versions = [];
      loaded = true;
      return;
    }
    versions = history.versions;
    reconcile();
    loaded = true;
  }

  function getSnapshot(): PricingStoreSnapshot {
    ensureLoaded();
    const current = activeVersion();
    return {
      schema: PRICING_SCHEMA,
      status,
      pricingVersion: current?.pricingVersion ?? null,
      parentVersion: current?.parentVersion ?? null,
      contentHash: current?.contentHash ?? null,
      createdAt: current?.createdAt ?? null,
      origin: current?.origin ?? null,
      starterAsOf: current?.starterAsOf ?? null,
      entries: current?.entries ?? [],
      issues,
      readonly,
      fileInSync,
      starterBundledAsOf: starter.starter.asOf,
    };
  }

  function reload(): PricingStoreSnapshot {
    ensureLoaded();
    // `history_invalid` is terminal for this process (issue #83 section 3: "the module never guesses"): only a
    // restart, after the history file is fixed by hand, can clear it.
    if (status !== 'history_invalid') reconcile();
    return getSnapshot();
  }

  function getVersion(version: number): PricingVersion | null {
    ensureLoaded();
    return versions.find((candidate) => candidate.pricingVersion === version) ?? null;
  }

  function listVersions(): readonly PricingVersion[] {
    ensureLoaded();
    return versions;
  }

  function applyApiChange(entries: PriceEntry[], meta: { reason: string; actor: string | null }): PricingChangeResult {
    ensureLoaded();
    const current = activeVersion();
    const candidateHash = computeContentHash(entries);
    if (current && candidateHash === current.contentHash) {
      return { changed: false, snapshot: getSnapshot() };
    }
    commitVersion(entries, { origin: 'api', reason: meta.reason, actor: meta.actor, starterAsOf: current?.starterAsOf ?? null });
    return { changed: true, snapshot: getSnapshot() };
  }

  return { getSnapshot, reload, getVersion, listVersions, applyApiChange };
}

/** Same default as `server/store.ts`'s SQLite path, so the pricing file lands next to the database by default. */
function defaultSqlitePath(env: NodeJS.ProcessEnv): string {
  return env.AGENT_VIEWER_SQLITE_PATH || './data/agent-viewer.db';
}

/** `AGENT_VIEWER_PRICING_FILE`, or `pricing.json` next to the (possibly default) SQLite path. */
export function resolvePricingFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AGENT_VIEWER_PRICING_FILE?.trim();
  if (explicit) return explicit;
  return path.join(path.dirname(defaultSqlitePath(env)), 'pricing.json');
}

/** `AGENT_VIEWER_PRICING_HISTORY_FILE`, or `pricing-history.jsonl` next to the pricing file. */
export function resolveHistoryFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AGENT_VIEWER_PRICING_HISTORY_FILE?.trim();
  if (explicit) return explicit;
  return path.join(path.dirname(resolvePricingFilePath(env)), 'pricing-history.jsonl');
}

export function isPricingReadonly(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_VIEWER_PRICING_READONLY?.trim() === '1';
}

let memoizedStore: PricingStore | null = null;

/**
 * The store `server/index.ts` uses, resolved from env vars and memoized so every call (the boot-time check in
 * `startServer()`, and later the HTTP handlers of the next sub-issue) shares one instance.
 */
export function getPricingStore(): PricingStore {
  if (!memoizedStore) {
    memoizedStore = createPricingStore({
      pricingFile: resolvePricingFilePath(),
      historyFile: resolveHistoryFilePath(),
      readonly: isPricingReadonly(),
    });
  }
  return memoizedStore;
}

/** Test-only: forgets the memoized singleton so the next `getPricingStore()` call re-reads env vars. */
export function resetPricingStoreForTests(): void {
  memoizedStore = null;
}
