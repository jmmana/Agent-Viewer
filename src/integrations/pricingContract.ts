/**
 * Versioned server pricing table (issue #83, sub-issue: contract, resolver and starter table).
 *
 * This module is the shared, canonical schema for AQA/Agent-Viewer server-side pricing (ADR-style: the
 * source of truth lives here, server and portal both import it; NOT re-exported by `src/lib/index.ts`,
 * see `tests/lib/pricingIsolation.test.ts`). It defines:
 *
 *  - `PriceEntry` / `PricingVersion`: the data model (issue #83 section 2).
 *  - Strict zod schemas for both (unknown keys are rejected everywhere).
 *  - `resolvePrice`: pure, no-I/O resolution against one version's entries (issue #83 section 2, "Resolution").
 *  - `computeContentHash`: canonical JSON hash of a version's entries (order-independent).
 *  - `validatePriceEntryCollection`: cross-entry rules (duplicate natural key, alias collisions, max count)
 *    that a single entry's schema cannot express on its own.
 *
 * No fallback, ever: `resolvePrice` returns an entry or `null`. There is no default price, no prefix or
 * fuzzy model match, no provider-wide price, no currency conversion. A missing price must stay unknown
 * downstream (issue #84), never be silently treated as zero.
 *
 * The file-based store (append-only history, lifecycle, reload) and the HTTP API are out of scope here;
 * they are later sub-issues of #83 and will import this module rather than duplicate its rules.
 */
import { z } from 'zod';
import { sha256Hex } from './sha256';

// -------------------------------------------------------------
// Constants
// -------------------------------------------------------------

export const PRICING_SCHEMA = 'agent-viewer.pricing/1';

export const PRICE_KINDS = ['list', 'override'] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

export const REASONING_BILLING_MODES = ['included_in_output', 'separate'] as const;
export type ReasoningBilling = (typeof REASONING_BILLING_MODES)[number];

export const PRICE_SOURCES = ['starter', 'file', 'api'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];

export const VERSION_ORIGINS = ['starter', 'file', 'api'] as const;
export type VersionOrigin = (typeof VERSION_ORIGINS)[number];

/** Per issue #83 section 2: "At most 5,000 entries per version." */
export const MAX_ENTRIES_PER_VERSION = 5000;

const MAX_ALIASES_PER_ENTRY = 20;
const MAX_PROVIDER_LENGTH = 100;
const MAX_MODEL_LENGTH = 200;
const MAX_URL_LENGTH = 500;
const MAX_NOTE_LENGTH = 500;
const MAX_PRICE_VALUE = 1_000_000;

// -------------------------------------------------------------
// Shared validation primitives
// -------------------------------------------------------------

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Maps a zod `safeParse` failure to the project's existing `{ error, issues }` wire shape (see `canonicalContract.ts`). */
function issuesFromZodError(error: z.ZodError, pathPrefix = ''): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: pathPrefix + issue.path.join('.'),
    message: issue.message,
  }));
}

/**
 * Trims a string and enforces a length bound (checked on the trimmed value, per issue #83 section 2: "stored
 * trimmed and lower-case, 1..N chars"), then lower-cases it. Used for `provider`, `model` and alias entries.
 */
function normalizedKey(maxLength: number, label: string) {
  return z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(1, `${label} must not be empty`)
        .max(maxLength, `${label} must be at most ${maxLength} characters`),
    )
    .transform((value) => value.toLowerCase());
}

/** ISO 4217, same rule as `canonicalContract.ts:30`. */
const currencySchema = z.string().regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 currency code');

/**
 * An ISO 8601 instant with an explicit zone (`Z` or `+hh:mm`/`-hh:mm`). A string with no zone is rejected
 * (issue #83 section 2: "effectiveFrom must be an ISO 8601 instant with an explicit Z or offset"), then
 * normalized to UTC milliseconds via `new Date(x).toISOString()`.
 */
const ZONED_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function zonedInstantSchema(label: string) {
  return z
    .string()
    .refine((value) => ZONED_INSTANT_PATTERN.test(value), `${label} must be an ISO 8601 instant with an explicit zone (Z or +hh:mm)`)
    .refine((value) => !Number.isNaN(Date.parse(value)), `${label} must be a valid date`)
    .transform((value) => new Date(value).toISOString());
}

/** A finite price `>= 0` and `<= 1,000,000`, or `null` for "unknown" (never a default, never 0 for "not found"). */
const priceFieldSchema = z
  .number()
  .finite('Price must be a finite number')
  .min(0, 'Price cannot be negative')
  .max(MAX_PRICE_VALUE, `Price cannot exceed ${MAX_PRICE_VALUE}`)
  .nullable();

/** Default to `null` ("unknown"), never `0`, when the field is omitted from input (file or API). */
const optionalPriceFieldSchema = priceFieldSchema.default(null);

const httpsUrlSchema = z
  .string()
  .max(MAX_URL_LENGTH, `sourceUrl must be at most ${MAX_URL_LENGTH} characters`)
  .refine((value) => /^https:\/\//.test(value), 'sourceUrl must start with https://')
  .refine((value) => {
    try {
      // eslint-disable-next-line no-new
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }, 'sourceUrl must be a valid URL')
  .nullable();

const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date (YYYY-MM-DD)')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'Expected a valid calendar date')
  .nullable();

const noteSchema = z.string().max(MAX_NOTE_LENGTH, `note must be at most ${MAX_NOTE_LENGTH} characters`).nullable();

const aliasSchema = normalizedKey(MAX_MODEL_LENGTH, 'alias');
const aliasesSchema = z.array(aliasSchema).max(MAX_ALIASES_PER_ENTRY, `aliases must have at most ${MAX_ALIASES_PER_ENTRY} entries`);

// -------------------------------------------------------------
// PriceEntry
// -------------------------------------------------------------

export interface PriceEntry {
  provider: string;
  model: string;
  aliases: string[];
  kind: PriceKind;
  currency: string;
  effectiveFrom: string;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  reasoningPerMillion: number | null;
  reasoningBilling: ReasoningBilling | null;
  source: PriceSource;
  estimated: boolean;
  sourceUrl: string | null;
  sourceCheckedAt: string | null;
  note: string | null;
}

/**
 * Cross-field checks shared by the stored schema and the input schema: at least one price must be known,
 * and `reasoningBilling` must agree with `reasoningPerMillion` (issue #83 section 2 and acceptance criteria).
 */
function checkPriceEntryInvariants(
  value: {
    inputPerMillion: number | null;
    outputPerMillion: number | null;
    cacheReadPerMillion: number | null;
    cacheWritePerMillion: number | null;
    reasoningPerMillion: number | null;
    reasoningBilling: ReasoningBilling | null;
  },
  ctx: z.RefinementCtx,
): void {
  const allNull =
    value.inputPerMillion === null
    && value.outputPerMillion === null
    && value.cacheReadPerMillion === null
    && value.cacheWritePerMillion === null
    && value.reasoningPerMillion === null;
  if (allNull) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: 'At least one price (inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion or reasoningPerMillion) must be non-null',
    });
  }

  if (value.reasoningBilling === 'separate' && value.reasoningPerMillion === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['reasoningPerMillion'],
      message: "reasoningPerMillion is required when reasoningBilling is 'separate'",
    });
  }
  if (value.reasoningBilling === 'included_in_output' && value.reasoningPerMillion !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['reasoningPerMillion'],
      message: "reasoningPerMillion must be null when reasoningBilling is 'included_in_output'",
    });
  }
  if (value.reasoningBilling === null && value.reasoningPerMillion !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['reasoningBilling'],
      message: 'reasoningBilling must be set (separate or included_in_output) when reasoningPerMillion is provided',
    });
  }
}

const priceEntryFields = {
  provider: normalizedKey(MAX_PROVIDER_LENGTH, 'provider'),
  model: normalizedKey(MAX_MODEL_LENGTH, 'model'),
  aliases: aliasesSchema,
  kind: z.enum(PRICE_KINDS),
  currency: currencySchema,
  effectiveFrom: zonedInstantSchema('effectiveFrom'),
  inputPerMillion: priceFieldSchema,
  outputPerMillion: priceFieldSchema,
  cacheReadPerMillion: priceFieldSchema,
  cacheWritePerMillion: priceFieldSchema,
  reasoningPerMillion: priceFieldSchema,
  reasoningBilling: z.enum(REASONING_BILLING_MODES).nullable(),
  source: z.enum(PRICE_SOURCES),
  estimated: z.boolean(),
  sourceUrl: httpsUrlSchema,
  sourceCheckedAt: calendarDateSchema,
  note: noteSchema,
};

/** The complete, stored entry (as it appears in `pricing.json`, a history line, or an API response). Strict: an unknown key (e.g. a typo) is rejected. */
export const PriceEntrySchema = z.strictObject(priceEntryFields).superRefine(checkPriceEntryInvariants);

/**
 * The shape accepted from an operator-edited `pricing.json` or a `POST /pricing/changes` upsert (issue #83
 * section 2, "Input defaults"). `source` is intentionally not part of this schema: it is never trusted from
 * input, the store/API (a later sub-issue) always forces it (`'file'` or `'api'`). Everything else that is
 * optional in input defaults exactly as specified: `aliases` to `[]`, `sourceUrl`/`sourceCheckedAt`/`note`
 * to `null`, `estimated` to `true`, a price field to `null`, `reasoningBilling` to `null`.
 */
export const PriceEntryInputSchema = z
  .strictObject({
    provider: priceEntryFields.provider,
    model: priceEntryFields.model,
    aliases: aliasesSchema.default([]),
    kind: priceEntryFields.kind,
    currency: priceEntryFields.currency,
    effectiveFrom: priceEntryFields.effectiveFrom,
    inputPerMillion: optionalPriceFieldSchema,
    outputPerMillion: optionalPriceFieldSchema,
    cacheReadPerMillion: optionalPriceFieldSchema,
    cacheWritePerMillion: optionalPriceFieldSchema,
    reasoningPerMillion: optionalPriceFieldSchema,
    reasoningBilling: priceEntryFields.reasoningBilling.default(null),
    estimated: z.boolean().default(true),
    sourceUrl: priceEntryFields.sourceUrl.default(null),
    sourceCheckedAt: priceEntryFields.sourceCheckedAt.default(null),
    note: priceEntryFields.note.default(null),
  })
  .superRefine(checkPriceEntryInvariants);

export type PriceEntryInput = z.input<typeof PriceEntryInputSchema>;

// -------------------------------------------------------------
// PricingVersion
// -------------------------------------------------------------

export interface PricingVersion {
  pricingVersion: number;
  parentVersion: number | null;
  createdAt: string;
  origin: VersionOrigin;
  reason: string;
  actor: string | null;
  starterAsOf: string | null;
  contentHash: string;
  entries: PriceEntry[];
}

const positiveIntSchema = z.number().int().positive();

export const PricingVersionSchema = z.strictObject({
  pricingVersion: positiveIntSchema,
  parentVersion: positiveIntSchema.nullable(),
  createdAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'createdAt must be a valid ISO 8601 date'),
  origin: z.enum(VERSION_ORIGINS),
  reason: z.string().min(1, 'reason must not be empty').max(500, 'reason must be at most 500 characters'),
  actor: z.string().min(1).max(100).nullable(),
  starterAsOf: calendarDateSchema,
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'contentHash must be "sha256:" followed by 64 hex characters'),
  entries: z.array(PriceEntrySchema).max(MAX_ENTRIES_PER_VERSION, `A version can have at most ${MAX_ENTRIES_PER_VERSION} entries`),
});

// -------------------------------------------------------------
// Natural key and canonical ordering
// -------------------------------------------------------------

function naturalKey(entry: Pick<PriceEntry, 'provider' | 'model' | 'kind' | 'effectiveFrom'>): string {
  return `${entry.provider}\u0000${entry.model}\u0000${entry.kind}\u0000${entry.effectiveFrom}`;
}

/** Sorts entries by `(provider, model, kind, effectiveFrom)`, per issue #83 section 2. Does not mutate the input. */
export function sortPriceEntries(entries: readonly PriceEntry[]): PriceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
    if (a.model !== b.model) return a.model < b.model ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? -1 : 1;
    return 0;
  });
}

// -------------------------------------------------------------
// Cross-entry validation (duplicate natural key, alias collisions)
// -------------------------------------------------------------

/**
 * Validates a whole set of already-schema-valid entries against the collection-level rules from issue #83
 * section 2 that `PriceEntrySchema` cannot express on its own:
 *
 *  - at most `MAX_ENTRIES_PER_VERSION` entries;
 *  - the natural key `(provider, model, kind, effectiveFrom)` is unique;
 *  - for one provider, an alias maps to exactly one model (an alias must not equal the `model` id or an
 *    alias of a different model of the same provider, in either `kind`); entries of the same
 *    `(provider, model)` may repeat the same alias, since the model's alias set is the union over its
 *    entries.
 *
 * Entries are expected to already be the normalized output of `PriceEntrySchema`/`PriceEntryInputSchema`
 * (so `provider`/`model`/aliases are trimmed and lower-cased).
 */
export function validatePriceEntryCollection(entries: readonly PriceEntry[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (entries.length > MAX_ENTRIES_PER_VERSION) {
    issues.push({ path: 'entries', message: `A version can have at most ${MAX_ENTRIES_PER_VERSION} entries` });
  }

  const seenKeys = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = naturalKey(entry);
    const firstIndex = seenKeys.get(key);
    if (firstIndex !== undefined) {
      issues.push({
        path: `entries[${index}]`,
        message: `Duplicate entry for provider "${entry.provider}", model "${entry.model}", kind "${entry.kind}", effectiveFrom "${entry.effectiveFrom}" (already defined at entries[${firstIndex}])`,
      });
    } else {
      seenKeys.set(key, index);
    }
  });

  // Per provider: model id -> the set of entry indices that declare it as `model` (not alias).
  const modelOwners = new Map<string, Map<string, number[]>>();
  for (const [index, entry] of entries.entries()) {
    const byModel = modelOwners.get(entry.provider) ?? new Map<string, number[]>();
    byModel.set(entry.model, [...(byModel.get(entry.model) ?? []), index]);
    modelOwners.set(entry.provider, byModel);
  }

  // Per provider: alias -> the set of distinct models it is declared for.
  const aliasToModels = new Map<string, Map<string, Set<string>>>();
  entries.forEach((entry, index) => {
    const byAlias = aliasToModels.get(entry.provider) ?? new Map<string, Set<string>>();
    for (const alias of entry.aliases) {
      const models = byAlias.get(alias) ?? new Set<string>();
      models.add(entry.model);
      byAlias.set(alias, models);
      if (modelOwners.get(entry.provider)?.has(alias)) {
        issues.push({
          path: `entries[${index}].aliases`,
          message: `Alias "${alias}" for provider "${entry.provider}" collides with the model id of another entry of the same provider`,
        });
      }
    }
    aliasToModels.set(entry.provider, byAlias);
  });

  for (const [provider, byAlias] of aliasToModels) {
    for (const [alias, models] of byAlias) {
      if (models.size > 1) {
        issues.push({
          path: 'entries',
          message: `Alias "${alias}" for provider "${provider}" is declared for more than one model (${[...models].sort().join(', ')})`,
        });
      }
    }
  }

  return issues;
}

/** Parses and validates a full set of stored entries (schema plus cross-entry rules) in one call. */
export function parsePriceEntries(
  rawEntries: unknown,
): { success: true; entries: PriceEntry[] } | { success: false; issues: ValidationIssue[] } {
  if (!Array.isArray(rawEntries)) {
    return { success: false, issues: [{ path: 'entries', message: 'entries must be an array' }] };
  }

  const issues: ValidationIssue[] = [];
  const parsed: PriceEntry[] = [];
  rawEntries.forEach((raw, index) => {
    const result = PriceEntrySchema.safeParse(raw);
    if (!result.success) {
      issues.push(...issuesFromZodError(result.error, `entries[${index}].`));
    } else {
      parsed.push(result.data);
    }
  });

  if (issues.length > 0) return { success: false, issues };

  const collectionIssues = validatePriceEntryCollection(parsed);
  if (collectionIssues.length > 0) return { success: false, issues: collectionIssues };

  return { success: true, entries: parsed };
}

// -------------------------------------------------------------
// Content hash (order-independent)
// -------------------------------------------------------------

/**
 * Canonical JSON for one entry: object keys in alphabetical order, no whitespace. `JSON.stringify` already
 * writes numbers without a redundant ".0" (so `1.0` and `1` serialize identically), and already omits
 * whitespace with no `space` argument.
 */
function canonicalEntryObject(entry: PriceEntry): Record<string, unknown> {
  return {
    aliases: entry.aliases,
    cacheReadPerMillion: entry.cacheReadPerMillion,
    cacheWritePerMillion: entry.cacheWritePerMillion,
    currency: entry.currency,
    effectiveFrom: entry.effectiveFrom,
    estimated: entry.estimated,
    inputPerMillion: entry.inputPerMillion,
    kind: entry.kind,
    model: entry.model,
    note: entry.note,
    outputPerMillion: entry.outputPerMillion,
    provider: entry.provider,
    reasoningBilling: entry.reasoningBilling,
    reasoningPerMillion: entry.reasoningPerMillion,
    source: entry.source,
    sourceCheckedAt: entry.sourceCheckedAt,
    sourceUrl: entry.sourceUrl,
  };
}

/**
 * `"sha256:" + hex` of the canonical JSON of `entries`, sorted by natural key first so that reordering the
 * input entries (or the keys within one, which `canonicalEntryObject` fixes regardless of caller order)
 * never changes the hash (issue #83 section 2 and acceptance criteria).
 */
export function computeContentHash(entries: readonly PriceEntry[]): string {
  const canonical = sortPriceEntries(entries).map(canonicalEntryObject);
  return `sha256:${sha256Hex(JSON.stringify(canonical))}`;
}

// -------------------------------------------------------------
// resolvePrice (issue #83 section 2, "Resolution")
// -------------------------------------------------------------

export interface ResolvePriceQuery {
  provider: string;
  model: string;
  /** Required instant (ISO 8601 string or epoch milliseconds) the price must be effective at or before. */
  at: string | number;
}

/**
 * Pure function, no I/O: resolves a price out of one version's `entries`. Takes the `entries` of the
 * version to resolve against directly; picking *which* version ("current" or a pinned `version`) is the
 * job of the store/API built in a later sub-issue of #83, not of this function.
 *
 * Algorithm (issue #83 section 2):
 *  1. Normalize `provider` and `model` (trim, lower-case).
 *  2. Find the canonical model: the entry whose `model` equals the normalized id, or whose alias set
 *     contains it, scoped to that provider. None found: return `null`.
 *  3. Candidates: entries of that `(provider, canonical model)` with `effectiveFrom <= at`.
 *  4. If any candidate is an `override`, keep only overrides and take the greatest `effectiveFrom`;
 *     otherwise take the greatest `effectiveFrom` among `list` entries.
 *  5. No candidate: return `null`. Never substitutes another model's price, never returns `0` for "not found".
 */
export function resolvePrice(entries: readonly PriceEntry[], query: ResolvePriceQuery): PriceEntry | null {
  const provider = query.provider.trim().toLowerCase();
  const modelId = query.model.trim().toLowerCase();
  const atMs = typeof query.at === 'number' ? query.at : Date.parse(query.at);
  if (Number.isNaN(atMs)) return null;

  const providerEntries = entries.filter((entry) => entry.provider === provider);
  if (providerEntries.length === 0) return null;

  // Exact match on `model` wins; otherwise fall back to an entry whose alias set contains the id. Matching
  // is exact text only (case-insensitive via normalization above), never prefix or fuzzy.
  const canonicalModel = providerEntries.some((entry) => entry.model === modelId)
    ? modelId
    : (providerEntries.find((entry) => entry.aliases.includes(modelId))?.model ?? null);
  if (canonicalModel === null) return null;

  const candidates = providerEntries.filter(
    (entry) => entry.model === canonicalModel && Date.parse(entry.effectiveFrom) <= atMs,
  );
  if (candidates.length === 0) return null;

  const overrides = candidates.filter((entry) => entry.kind === 'override');
  const pool = overrides.length > 0 ? overrides : candidates.filter((entry) => entry.kind === 'list');
  if (pool.length === 0) return null;

  return pool.reduce((latest, entry) =>
    Date.parse(entry.effectiveFrom) > Date.parse(latest.effectiveFrom) ? entry : latest);
}
