/**
 * Ledger-row cost estimator (issue #84). Pure, synchronous, no I/O: given one call's token figures and a
 * pricing-table snapshot (issue #83's `PriceEntry[]` plus the active table's version number), computes a
 * list-price approximation of what that call would cost, or explains why it could not.
 *
 * The estimate is a separate fact from the reported `cost` on the same ledger row (`server/usageLedger.ts`):
 * this module never reads a reported cost and the caller must never let the two mix. "Unknown" is always a
 * `null` cost plus an `EstimateStatus` reason, never a `0` (the repo's own rule, README.md:719).
 *
 * Deviation from the issue's literal text, recorded here because the issue told the implementer to reconcile
 * it: section "Assumptions about the dependencies" asks #83 to declare a per-entry `inputIncludesCache` flag
 * (OpenAI-style true, Anthropic-style false) so this estimator knows whether to subtract cache tokens out of
 * `inputTokens`. #83, as actually merged (`src/integrations/pricingContract.ts`), has no such field. Instead,
 * the canonical contract fixes this globally for every provider, one layer up, before a row ever reaches a
 * `PriceEntry`: `LlmUsagePayloadSchema`'s own doc comment states "`inputTokens` includes `cacheReadTokens` and
 * `cacheWriteTokens`; `outputTokens` includes `reasoningTokens` when the provider bills them as output"
 * (`src/integrations/canonicalContract.ts:191-193`), and `checkCacheFields` rejects a payload where
 * `cacheReadTokens + cacheWriteTokens > inputTokens`. So every ledger row this server ever stores already uses
 * the OpenAI-style convention, by construction; there is nothing left for a per-entry flag to disambiguate.
 * This module always derives "uncached input" as `inputTokens - cacheReadTokens - cacheWriteTokens`. The one
 * piece of #83 that *does* vary by model, whether reasoning tokens are billed separately or already counted in
 * `outputTokens`, is exactly what `PriceEntry.reasoningBilling` (`'separate' | 'included_in_output'`) already
 * declares, so that half of the issue's request is met as-is.
 *
 * Rate precision: the issue's proposal assumes `PriceEntry` rates are decimal strings with up to 9 decimal
 * places, so a price can be converted to an exact integer with no floating-point step at all. The schema #83
 * actually shipped stores every rate as a plain JS `number` (`priceFieldSchema`), so some of that precision is
 * already gone before this module ever sees the value; nothing here can recover it. What this module guarantees
 * is that from that point on, every arithmetic step (scaling the rate, multiplying by tokens, summing every
 * component, rounding) is exact `BigInt` math with a single half-even rounding at the very end, so the
 * well-known floating-point drift from repeated `Number` arithmetic never gets a chance to appear on top of the
 * input's own precision.
 */
import { resolvePrice, type PriceEntry } from '../../src/integrations/pricingContract';

export const ESTIMATE_STATUSES = [
  'estimated',
  'no_price_in_force',
  'no_price_for_model',
  'no_price_for_component',
  'missing_usage',
  'inconsistent_usage',
  'failed',
] as const;

export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

export function isEstimateStatus(value: unknown): value is EstimateStatus {
  return typeof value === 'string' && (ESTIMATE_STATUSES as readonly string[]).includes(value);
}

/** The token/identity figures `estimateCall` needs from a call. A structural subset of `UsageLedgerRow` /
 * `LedgerRowInputBase` (`server/usageLedger.ts`): anything with these fields can be estimated. */
export interface EstimateCallInput {
  provider: string | null;
  model: string | null;
  /** Client clock (`event.timestamp`); the instant the price must be effective at or before. */
  occurredAt: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}

/** One pricing-table snapshot to estimate against: the entries of the version currently active (or pinned, for
 * a future recompute run), plus that version's own number for reproducibility. `pricingVersion: null` means no
 * version has ever been committed (a brand-new, never-seeded store, or `file_invalid`/`history_invalid`). */
export interface EstimatePricingSnapshot {
  pricingVersion: number | null;
  entries: readonly PriceEntry[];
}

export interface EstimateCallResult {
  /** 1e-9 of the currency unit, rounded half-even once. `null` unless `status === 'estimated'`. */
  costNano: number | null;
  /** The resolved entry's own currency (never converted). `null` unless `status === 'estimated'`. */
  currency: string | null;
  status: EstimateStatus;
}

/** `Number.MAX_SAFE_INTEGER`, as a `bigint`: a per-row estimate above this many nano-units is reported `failed`
 * rather than silently truncated (the issue's own rule; only a rollup's summed total is expected to exceed it). */
const MAX_SAFE_NANO = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Converts a decimal rate (currency units per 1,000,000 tokens, as stored on `PriceEntry`) to an integer count
 * of nano-currency-units per million tokens (`rate * 1e9`, rounded to the nearest integer). This is the one
 * place this module still touches floating point, and only because the rate itself already arrived as a JS
 * `number` (see the module doc comment); every rate real pricing data uses has far fewer significant digits
 * than `Number` can hold exactly at this magnitude (`priceFieldSchema` caps a rate at 1,000,000, so the scaled
 * value here is at most 1e15, well inside `Number.isSafeInteger`'s range).
 */
function ratePerMillionToNano(rate: number): bigint {
  return BigInt(Math.round(rate * 1_000_000_000));
}

/** Integer division of two non-negative `bigint`s, rounded half-even (banker's rounding), so a run of exact
 * `.5` boundaries does not all round the same direction and quietly bias a large sum. */
function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twiceRemainder = remainder * 2n;
  if (twiceRemainder < denominator) return quotient;
  if (twiceRemainder > denominator) return quotient + 1n;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** True when `entries` declares a price for `(provider, model)` at all, regardless of `effectiveFrom`: used
 * only to tell `no_price_for_model` (the model is simply not in the table) apart from `no_price_in_force` (the
 * model is in the table, but every entry for it starts after `occurredAt`). Mirrors `resolvePrice`'s own
 * provider/model/alias matching (`src/integrations/pricingContract.ts`) without its date filter. */
function tableKnowsModel(entries: readonly PriceEntry[], provider: string, model: string): boolean {
  const normalizedProvider = normalize(provider);
  const normalizedModel = normalize(model);
  const providerEntries = entries.filter((entry) => entry.provider === normalizedProvider);
  if (providerEntries.length === 0) return false;
  return providerEntries.some((entry) => entry.model === normalizedModel || entry.aliases.includes(normalizedModel));
}

interface PriceComponent {
  /** Billable token count for this component; always a finite, non-negative integer by the time it is built. */
  tokens: number;
  /** `null` means "this price is not known"; a `0`-token component never looks at it. */
  ratePerMillion: number | null;
}

/**
 * Resolves one call against one pricing snapshot, purely in memory. Never falls back to another model, another
 * provider or a default rate: every "I do not know" case returns `costNano: null` with a specific
 * `EstimateStatus`, never `0`. See the module doc comment for the cache/reasoning semantics this relies on.
 */
export function estimateCall(row: EstimateCallInput, pricing: EstimatePricingSnapshot): EstimateCallResult {
  try {
    if (row.provider === null || row.model === null) {
      // No provider/model at all: there is no table lookup to even attempt. Grouped with "the model is not in
      // the table" rather than invented as its own status, since an auditor's remedy is the same either way:
      // the call cannot be matched to a price entry.
      return { costNano: null, currency: null, status: 'no_price_for_model' };
    }

    if (pricing.pricingVersion === null) {
      return { costNano: null, currency: null, status: 'no_price_in_force' };
    }

    const entry = resolvePrice(pricing.entries, { provider: row.provider, model: row.model, at: row.occurredAt });
    if (!entry) {
      const known = tableKnowsModel(pricing.entries, row.provider, row.model);
      return { costNano: null, currency: null, status: known ? 'no_price_in_force' : 'no_price_for_model' };
    }

    if (row.inputTokens === null || row.outputTokens === null || row.cacheReadTokens === null || row.cacheWriteTokens === null) {
      return { costNano: null, currency: null, status: 'missing_usage' };
    }
    const reasoningNeeded = entry.reasoningBilling === 'separate';
    if (reasoningNeeded && row.reasoningTokens === null) {
      return { costNano: null, currency: null, status: 'missing_usage' };
    }

    // Global convention (see module doc comment): `inputTokens` already includes both cache directions.
    const uncachedInput = row.inputTokens - row.cacheReadTokens - row.cacheWriteTokens;
    if (uncachedInput < 0) {
      return { costNano: null, currency: null, status: 'inconsistent_usage' };
    }

    const components: PriceComponent[] = [
      { tokens: uncachedInput, ratePerMillion: entry.inputPerMillion },
      { tokens: row.outputTokens, ratePerMillion: entry.outputPerMillion },
      { tokens: row.cacheReadTokens, ratePerMillion: entry.cacheReadPerMillion },
      { tokens: row.cacheWriteTokens, ratePerMillion: entry.cacheWritePerMillion },
    ];
    if (reasoningNeeded) {
      components.push({ tokens: row.reasoningTokens as number, ratePerMillion: entry.reasoningPerMillion });
    }

    // A component with a real, positive count but no known rate makes the whole call unpriceable; a component
    // whose count is exactly 0 never needs a rate (its contribution is 0 either way).
    if (components.some((component) => component.tokens > 0 && component.ratePerMillion === null)) {
      return { costNano: null, currency: null, status: 'no_price_for_component' };
    }

    // Sum every component's contribution first, in a currency-unit scale 1,000,000x larger than nano (so the
    // division below is the only rounding step), then round once, half-even.
    let scaledSum = 0n;
    for (const component of components) {
      if (component.tokens === 0 || component.ratePerMillion === null) continue;
      scaledSum += BigInt(component.tokens) * ratePerMillionToNano(component.ratePerMillion);
    }
    const costNano = divRoundHalfEven(scaledSum, 1_000_000n);
    if (costNano > MAX_SAFE_NANO) {
      return { costNano: null, currency: null, status: 'failed' };
    }

    return { costNano: Number(costNano), currency: entry.currency, status: 'estimated' };
  } catch {
    return { costNano: null, currency: null, status: 'failed' };
  }
}

/** The five `usage_ledger` columns this feature adds (issue #84), ready to spread onto a ledger row. */
export interface LedgerEstimateFields {
  estimatedCostNano: number | null;
  estimatedCurrency: string | null;
  pricingVersion: number | null;
  estimateStatus: EstimateStatus;
  estimatedAt: number;
}

/**
 * `estimateCall` plus the bookkeeping every ledger row needs alongside it: which pricing version was checked
 * (recorded even when it held no entry for this model, so a later audit can tell "no version was loaded" apart
 * from "a version was loaded but had nothing for this model") and the server time the estimate was computed.
 * The one function every ledger-row insertion path (`server/store.ts`, `server/usageLedger.ts`) calls.
 */
export function estimateLedgerRow(
  row: EstimateCallInput,
  pricing: EstimatePricingSnapshot,
  now: () => number = Date.now
): LedgerEstimateFields {
  const result = estimateCall(row, pricing);
  return {
    estimatedCostNano: result.costNano,
    estimatedCurrency: result.currency,
    pricingVersion: pricing.pricingVersion,
    estimateStatus: result.status,
    estimatedAt: now(),
  };
}
