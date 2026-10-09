import { normalizeCanonicalEvent } from '../integrations/canonicalTypes';
import type { OfficeTranslate } from '../content/officeMessages';
import type { OfficeEventInput } from './officeStore';

/**
 * Usage figures exactly as the host knows them. The office only displays them: it never adds, prices or
 * estimates anything. A missing value is shown as "unknown", never as zero.
 */
export interface UsageFigures {
  totalTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cost?: number | null;
  /** ISO 4217 code such as `USD`. Without it the cost is shown as a plain number. */
  currency?: string | null;
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

export function formatCost(
  value: number | null | undefined,
  currency: string | null | undefined,
  locale: string | undefined,
  translate: OfficeTranslate,
): string {
  if (!isNumber(value)) return translate('usage.unknown');
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 4 }).format(value);
    } catch {
      // Unknown currency code for this runtime: fall through to a plain number.
    }
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);
}

/** The rows the usage panel shows, already formatted. Token rows appear only when the host sends them. */
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
  items.push({ label: translate('usage.cost'), value: formatCost(figures.cost, figures.currency, locale, translate) });
  return items;
}

interface UsageAccumulator {
  events: number;
  /** `null` once any counted event did not report it. */
  inputTokens: number | null;
  outputTokens: number | null;
  /** `null` once any counted event did not report a cost. */
  cost: number | null;
  /** ISO 4217 currencies of the events that reported a cost. */
  currencies: Set<string>;
  /** `true` once a reported cost came without a valid currency. */
  costWithoutCurrency: boolean;
}

/** The figures one `llm.usage` event reported. `null` means "not reported". */
interface ReportedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
  currency: string | null;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function emptyAccumulator(): UsageAccumulator {
  return { events: 0, inputTokens: 0, outputTokens: 0, cost: 0, currencies: new Set(), costWithoutCurrency: false };
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

function readReportedUsage(payload: unknown): ReportedUsage {
  const fields = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  return {
    inputTokens: reportedTokens(fields.inputTokens),
    outputTokens: reportedTokens(fields.outputTokens),
    cost: reportedCost(fields.cost),
    currency: reportedCurrency(fields.currency),
  };
}

function addFigure(current: number | null, value: number | null): number | null {
  return current === null || value === null ? null : current + value;
}

function addUsage(target: UsageAccumulator, usage: ReportedUsage): void {
  target.events += 1;
  target.inputTokens = addFigure(target.inputTokens, usage.inputTokens);
  target.outputTokens = addFigure(target.outputTokens, usage.outputTokens);
  target.cost = addFigure(target.cost, usage.cost);
  if (usage.cost !== null) {
    if (usage.currency !== null) target.currencies.add(usage.currency);
    else target.costWithoutCurrency = true;
  }
}

function toFigures(entry: UsageAccumulator): UsageFigures {
  if (entry.events === 0) {
    return { totalTokens: null, inputTokens: null, outputTokens: null, cost: null, currency: undefined };
  }
  // Costs in different currencies, or an ISO currency next to a cost without one, cannot be added.
  const unknownUnit = entry.currencies.size > 1 || (entry.currencies.size === 1 && entry.costWithoutCurrency);
  const cost = unknownUnit ? null : entry.cost;
  return {
    totalTokens: entry.inputTokens !== null && entry.outputTokens !== null ? entry.inputTokens + entry.outputTokens : null,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cost,
    // A currency label is shown only next to a known cost.
    currency: cost !== null && entry.currencies.size === 1 ? [...entry.currencies][0] : undefined,
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
 * - The same rules apply to each agent in `byAgent`, using only that agent's events.
 * - Without any `llm.usage` event, every figure is `null` and `byAgent` is empty.
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
    if (event.type !== 'llm.usage') continue;
    // Figures come from the raw payload too, so no default written by the normalizer is ever counted.
    const usage = readReportedUsage((raw as { payload?: unknown }).payload);

    addUsage(total, usage);
    const agentId = event.agentId ?? event.source.replace(/^agent:/, '');
    const entry = byAgent.get(agentId) ?? emptyAccumulator();
    addUsage(entry, usage);
    byAgent.set(agentId, entry);
  }

  return {
    total: toFigures(total),
    byAgent: Object.fromEntries([...byAgent].map(([id, entry]) => [id, toFigures(entry)])),
  };
}
