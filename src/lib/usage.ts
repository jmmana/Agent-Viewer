import { normalizeCanonicalEvent } from '../integrations/canonicalTypes';
import type { OfficeTranslate } from '../content/officeMessages';
import type { OfficeEventInput } from './officeStore';

/** Where a reported cost came from. An unrecognized value is treated as `'unknown'`. */
export type UsageCostSource = 'provider-reported' | 'estimated' | 'unknown';

/**
 * Usage figures exactly as the host knows them. The office only displays them: it never adds, prices or
 * estimates anything. A missing value is shown as "unknown", never as zero.
 */
export interface UsageFigures {
  totalTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Input tokens served from a provider cache instead of processed fresh. */
  cacheReadTokens?: number | null;
  /** Input tokens written to a provider cache for later reuse. */
  cacheWriteTokens?: number | null;
  /** Hidden "thinking" tokens some providers bill as output. */
  reasoningTokens?: number | null;
  cost?: number | null;
  /** ISO 4217 code such as `USD`. Without it the cost is shown as a plain number. */
  currency?: string | null;
  /** Where the cost figure came from. `null` or an unrecognized value is shown as unknown. */
  costSource?: UsageCostSource | null;
  /** Count of failed model call attempts. */
  failedCalls?: number | null;
}

export interface OfficeUsage {
  total?: UsageFigures;
  byAgent?: Record<string, UsageFigures>;
}

export interface FormattedUsageItem {
  label: string;
  value: string;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatTokens(value: number | null | undefined, locale: string | undefined, translate: OfficeTranslate): string {
  return isNumber(value) ? new Intl.NumberFormat(locale).format(value) : translate('usage.unknown');
}

function formatCurrencyNumber(
  value: number,
  currency: string | null | undefined,
  locale: string | undefined,
  maximumFractionDigits: number,
): string {
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits }).format(value);
    } catch {
      // Unknown currency code for this runtime: fall through to a plain number.
    }
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}

export function formatCost(
  value: number | null | undefined,
  currency: string | null | undefined,
  locale: string | undefined,
  translate: OfficeTranslate,
): string {
  if (!isNumber(value)) return translate('usage.unknown');
  return formatCurrencyNumber(value, currency, locale, 4);
}

/** A `costSource` outside the three known literals (including `null` or missing) is shown as unknown. */
function formatCostSource(value: UsageCostSource | null | undefined, translate: OfficeTranslate): string {
  if (value === 'provider-reported') return translate('usage.costSource.providerReported');
  if (value === 'estimated') return translate('usage.costSource.estimated');
  return translate('usage.unknown');
}

/**
 * The rows the usage panel shows, already formatted. Token and breakdown rows appear only when the host
 * sends that key; a key sent as `null` reads `unknown`, never omitted and never shown as `0`.
 */
export function formatUsage(figures: UsageFigures, locale: string | undefined, translate: OfficeTranslate): FormattedUsageItem[] {
  const items: FormattedUsageItem[] = [
    { label: translate('usage.tokens'), value: formatTokens(figures.totalTokens, locale, translate) },
  ];
  if (figures.inputTokens !== undefined) {
    items.push({ label: translate('usage.inputTokens'), value: formatTokens(figures.inputTokens, locale, translate) });
  }
  if (figures.outputTokens !== undefined) {
    items.push({ label: translate('usage.outputTokens'), value: formatTokens(figures.outputTokens, locale, translate) });
  }
  if (figures.cacheReadTokens !== undefined) {
    items.push({ label: translate('usage.cacheReadTokens'), value: formatTokens(figures.cacheReadTokens, locale, translate) });
  }
  if (figures.cacheWriteTokens !== undefined) {
    items.push({ label: translate('usage.cacheWriteTokens'), value: formatTokens(figures.cacheWriteTokens, locale, translate) });
  }
  if (figures.reasoningTokens !== undefined) {
    items.push({ label: translate('usage.reasoningTokens'), value: formatTokens(figures.reasoningTokens, locale, translate) });
  }
  items.push({ label: translate('usage.cost'), value: formatCost(figures.cost, figures.currency, locale, translate) });
  if (figures.costSource !== undefined) {
    items.push({ label: translate('usage.costSource'), value: formatCostSource(figures.costSource, translate) });
  }
  if (figures.failedCalls !== undefined) {
    items.push({ label: translate('usage.failedCalls'), value: formatTokens(figures.failedCalls, locale, translate) });
  }
  return items;
}

/** A compact badge summary of usage figures: display only, never a figure the host did not send. */
export interface UsageBadge {
  /** Compact total tokens, for example `"9,840"` or `"12.3K"`, or `usage.unknown`. */
  tokens: string;
  /** Formatted cost, for example `"$0.42"` or `"<$0.01"`, or `usage.unknown`. */
  cost: string;
  /** `cost` plus the `est.` mark when `costSource === 'estimated'`; otherwise same as `cost`. */
  costLabel: string;
  /** `true` when `costSource === 'estimated'`. */
  estimated: boolean;
  /** A `"N failed"` chip, only when `failedCalls` is a finite number greater than 0. */
  failed: string | null;
  /** Accessible text with the exact figures, for the screen-reader agent list. */
  text: string;
}

/** Tokens under 10,000 are exact; from 10,000 up they use a locale-aware compact notation (`12.3K`, `12,3 mil`). */
function formatBadgeTokens(value: number | null | undefined, locale: string | undefined, translate: OfficeTranslate): string {
  if (!isNumber(value)) return translate('usage.unknown');
  if (Math.abs(value) < 10_000) return new Intl.NumberFormat(locale).format(value);
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/**
 * A positive cost that rounds to zero at 2 decimals (below 0.005) is shown as `<$0.01` (or plain `<0.01`
 * without a currency), never `$0.00`. A reported `0` is `$0.00` (or `0`): a real value, not "too small".
 */
function formatBadgeCost(
  value: number | null | undefined,
  currency: string | null | undefined,
  locale: string | undefined,
  translate: OfficeTranslate,
): string {
  if (!isNumber(value)) return translate('usage.unknown');
  if (value > 0 && value < 0.005) {
    return translate('usage.badge.lessThan', { value: formatCurrencyNumber(0.01, currency, locale, 2) });
  }
  return formatCurrencyNumber(value, currency, locale, 2);
}

/**
 * The compact figures drawn on an agent card: the canvas receives only these pre-formatted strings, never a
 * number, so the renderer has nothing left to add up or price. The full exact figures stay in `text`.
 */
export function formatUsageBadge(figures: UsageFigures, locale: string | undefined, translate: OfficeTranslate): UsageBadge {
  const tokens = formatBadgeTokens(figures.totalTokens, locale, translate);
  const cost = formatBadgeCost(figures.cost, figures.currency, locale, translate);
  const estimated = figures.costSource === 'estimated';
  const costLabel = estimated ? `${cost} ${translate('usage.badge.estimatedMark')}` : cost;
  const failed = isNumber(figures.failedCalls) && figures.failedCalls > 0
    ? translate('usage.badge.failed', { count: figures.failedCalls })
    : null;
  const text = formatUsage(figures, locale, translate).map((item) => `${item.label}: ${item.value}`).join(', ');
  return { tokens, cost, costLabel, estimated, failed, text };
}

/** Sum and count of an optional breakdown field (cache read/write, reasoning) across counted events. */
interface OptionalSum {
  sum: number;
  reportedCount: number;
}

function emptyOptionalSum(): OptionalSum {
  return { sum: 0, reportedCount: 0 };
}

interface UsageAccumulator {
  events: number;
  /** `null` once any counted event did not report it. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: OptionalSum;
  cacheWriteTokens: OptionalSum;
  reasoningTokens: OptionalSum;
  /** `null` once any counted event did not report a cost. */
  cost: number | null;
  /** ISO 4217 currencies of the events that reported a cost. */
  currencies: Set<string>;
  /** `true` once a reported cost came without a valid currency. */
  costWithoutCurrency: boolean;
  /** Effective (defaulted) `costSource` of every counted event, tracked only once some event sent the key. */
  costSources: Set<UsageCostSource>;
  /** `true` once some counted event explicitly sent a `costSource` key (valid or not). */
  costSourceSent: boolean;
  /** Count of `llm.failed` events, counted independently of `events` (which tracks `llm.usage` only). */
  failedCalls: number;
}

/** The figures one `llm.usage` event reported. `null` means "not reported". */
interface ReportedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  cost: number | null;
  currency: string | null;
  /** Effective value: `'unknown'` when absent or not one of the three literals. */
  costSource: UsageCostSource;
  /** Whether the raw payload carried a `costSource` key at all, whatever its value. */
  costSourceSent: boolean;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function emptyAccumulator(): UsageAccumulator {
  return {
    events: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: emptyOptionalSum(),
    cacheWriteTokens: emptyOptionalSum(),
    reasoningTokens: emptyOptionalSum(),
    cost: 0,
    currencies: new Set(),
    costWithoutCurrency: false,
    costSources: new Set(),
    costSourceSent: false,
    failedCalls: 0,
  };
}

/** A token count counts as reported only when it is a non-negative integer, as the contract requires. */
function reportedTokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** A cost counts as reported only when it is a finite, non-negative number. */
function reportedCost(value: unknown): number | null {
  return isNumber(value) && value >= 0 ? value : null;
}

/** Only an ISO 4217 code counts as a currency. No case folding and no conversion. */
function reportedCurrency(value: unknown): string | null {
  return typeof value === 'string' && CURRENCY_PATTERN.test(value) ? value : null;
}

/** Effective `costSource`: an absent or unrecognized value counts as `'unknown'`, as the contract normalizes it. */
function reportedCostSource(value: unknown): UsageCostSource {
  return value === 'provider-reported' || value === 'estimated' ? value : 'unknown';
}

function readReportedUsage(payload: unknown): ReportedUsage {
  const fields = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  // Deprecated alias: `cachedTokens` is read as `cacheReadTokens` when the new field is absent, mirroring
  // `applyCachedAlias` in the strict contract.
  const cacheRead = fields.cacheReadTokens !== undefined ? fields.cacheReadTokens : fields.cachedTokens;
  return {
    inputTokens: reportedTokens(fields.inputTokens),
    outputTokens: reportedTokens(fields.outputTokens),
    cacheReadTokens: reportedTokens(cacheRead),
    cacheWriteTokens: reportedTokens(fields.cacheWriteTokens),
    reasoningTokens: reportedTokens(fields.reasoningTokens),
    cost: reportedCost(fields.cost),
    currency: reportedCurrency(fields.currency),
    costSource: reportedCostSource(fields.costSource),
    costSourceSent: fields.costSource !== undefined,
  };
}

function addFigure(current: number | null, value: number | null): number | null {
  return current === null || value === null ? null : current + value;
}

function addOptionalField(target: OptionalSum, value: number | null): void {
  if (value !== null) {
    target.sum += value;
    target.reportedCount += 1;
  }
}

function addUsage(target: UsageAccumulator, usage: ReportedUsage): void {
  target.events += 1;
  target.inputTokens = addFigure(target.inputTokens, usage.inputTokens);
  target.outputTokens = addFigure(target.outputTokens, usage.outputTokens);
  addOptionalField(target.cacheReadTokens, usage.cacheReadTokens);
  addOptionalField(target.cacheWriteTokens, usage.cacheWriteTokens);
  addOptionalField(target.reasoningTokens, usage.reasoningTokens);
  target.cost = addFigure(target.cost, usage.cost);
  if (usage.cost !== null) {
    if (usage.currency !== null) target.currencies.add(usage.currency);
    else target.costWithoutCurrency = true;
  }
  if (usage.costSourceSent) target.costSourceSent = true;
  target.costSources.add(usage.costSource);
}

/** `undefined` when no counted event reported the key, the sum when every one did, `null` when only some did. */
function optionalField(field: OptionalSum, events: number): number | null | undefined {
  if (field.reportedCount === 0) return undefined;
  return field.reportedCount === events ? field.sum : null;
}

function toFigures(entry: UsageAccumulator): UsageFigures {
  const failedCalls = entry.failedCalls > 0 ? entry.failedCalls : undefined;
  if (entry.events === 0) {
    return { totalTokens: null, inputTokens: null, outputTokens: null, cost: null, currency: undefined, failedCalls };
  }
  // Costs in different currencies, or an ISO currency next to a cost without one, cannot be added.
  const unknownUnit = entry.currencies.size > 1 || (entry.currencies.size === 1 && entry.costWithoutCurrency);
  const cost = unknownUnit ? null : entry.cost;
  // `costSource` is tracked only once some event explicitly sent the key; otherwise the host never addressed
  // it and the field stays omitted, matching every other breakdown field here.
  const costSource: UsageCostSource | null | undefined = entry.costSourceSent
    ? (entry.costSources.size === 1 ? [...entry.costSources][0] : null)
    : undefined;
  return {
    totalTokens: entry.inputTokens !== null && entry.outputTokens !== null ? entry.inputTokens + entry.outputTokens : null,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: optionalField(entry.cacheReadTokens, entry.events),
    cacheWriteTokens: optionalField(entry.cacheWriteTokens, entry.events),
    reasoningTokens: optionalField(entry.reasoningTokens, entry.events),
    cost,
    // A currency label is shown only next to a known cost.
    currency: cost !== null && entry.currencies.size === 1 ? [...entry.currencies][0] : undefined,
    costSource,
    failedCalls,
  };
}

/**
 * Opt-in helper for hosts that have no usage service of their own: adds up the figures reported by
 * `llm.usage` events. It never prices, estimates or converts anything, and a figure that was not reported
 * stays unknown (`null`) instead of becoming a zero or a partial sum.
 *
 * - Events are deduplicated by their `id`, as the office store and the server do: the first event with a
 *   given id wins, whatever its type or agent, and later events with that id are ignored. An event without
 *   a string id cannot be matched, so each one is counted, but the same object passed twice counts once.
 * - `inputTokens` (or `outputTokens`) is `null` once any counted event does not report it as a
 *   non-negative integer. `totalTokens` is their sum only when both are known.
 * - `cost` is `null` when any event lacks a finite, non-negative cost, when events report different
 *   ISO 4217 currencies, or when an ISO currency is mixed with a cost that has no valid currency. Costs
 *   that all come without a currency are added and returned without one.
 * - `currency` is set only when `cost` is known.
 * - `cacheReadTokens`, `cacheWriteTokens` and `reasoningTokens` follow the input/output rule but with a third
 *   state: omitted when no counted event reports the key at all, the sum when every one does, `null` when
 *   only some do. The deprecated `cachedTokens` field is read as `cacheReadTokens` when that key is absent.
 * - `costSource` is omitted when no counted event sends the key; once some event does, a missing or
 *   unrecognized value on any event counts as `'unknown'` (as the canonical contract normalizes it), and the
 *   figure is the common value when every event agrees, `null` when they do not.
 * - `failedCalls` is the count of `llm.failed` events, independent of `llm.usage`; omitted when it is zero.
 * - The same rules apply to each agent in `byAgent`, using only that agent's events.
 * - Without any `llm.usage` event, every figure is `null` and `byAgent` is empty (an agent that only has
 *   `llm.failed` events still gets an entry, with every other figure `null` and `failedCalls` set).
 */
export function summarizeUsage(events: readonly OfficeEventInput[]): OfficeUsage {
  const total = emptyAccumulator();
  const byAgent = new Map<string, UsageAccumulator>();
  const seenIds = new Set<string>();
  const seenObjects = new Set<object>();

  for (const raw of events) {
    // The id comes from the raw input: the normalizer makes up a random one when it is missing.
    const id = (raw as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    } else {
      if (seenObjects.has(raw)) continue;
      seenObjects.add(raw);
    }

    const event = normalizeCanonicalEvent(raw);
    if (event.type === 'llm.usage') {
      // Figures come from the raw payload too, so no default written by the normalizer is ever counted.
      const usage = readReportedUsage((raw as { payload?: unknown }).payload);
      addUsage(total, usage);
      const agentId = event.agentId ?? event.source.replace(/^agent:/, '');
      const entry = byAgent.get(agentId) ?? emptyAccumulator();
      addUsage(entry, usage);
      byAgent.set(agentId, entry);
    } else if (event.type === 'llm.failed') {
      total.failedCalls += 1;
      const agentId = event.agentId ?? event.source.replace(/^agent:/, '');
      const entry = byAgent.get(agentId) ?? emptyAccumulator();
      entry.failedCalls += 1;
      byAgent.set(agentId, entry);
    }
  }

  return {
    total: toFigures(total),
    byAgent: Object.fromEntries([...byAgent].map(([id, entry]) => [id, toFigures(entry)])),
  };
}
