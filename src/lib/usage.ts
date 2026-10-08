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

/**
 * Opt-in helper for hosts that have no usage service of their own: adds up the figures reported by
 * `llm.usage` events. It never prices tokens. If any event lacks a reported cost, or currencies differ,
 * the total cost is `null` (shown as "unknown") instead of a misleading partial sum.
 */
export function summarizeUsage(events: readonly OfficeEventInput[]): OfficeUsage {
  const total = { inputTokens: 0, outputTokens: 0, cost: 0 as number | null, currency: undefined as string | undefined };
  const byAgent: Record<string, { inputTokens: number; outputTokens: number; cost: number | null; currency?: string }> = {};
  let currencies = new Set<string>();

  for (const raw of events) {
    const event = normalizeCanonicalEvent(raw);
    if (event.type !== 'llm.usage') continue;
    const payload = event.payload;
    const input = isNumber(payload.inputTokens) ? payload.inputTokens : 0;
    const output = isNumber(payload.outputTokens) ? payload.outputTokens : 0;
    const cost = isNumber(payload.cost) ? payload.cost : null;
    const currency = typeof payload.currency === 'string' ? payload.currency : undefined;
    if (currency) currencies.add(currency);

    total.inputTokens += input;
    total.outputTokens += output;
    total.cost = total.cost === null || cost === null ? null : total.cost + cost;

    const agentId = event.agentId ?? event.source.replace(/^agent:/, '');
    const entry = byAgent[agentId] ?? { inputTokens: 0, outputTokens: 0, cost: 0 };
    entry.inputTokens += input;
    entry.outputTokens += output;
    entry.cost = entry.cost === null || cost === null ? null : entry.cost + cost;
    if (currency) entry.currency = currency;
    byAgent[agentId] = entry;
  }

  if (currencies.size > 1) {
    total.cost = null;
    currencies = new Set();
  }
  const currency = currencies.size === 1 ? [...currencies][0] : undefined;

  return {
    total: {
      totalTokens: total.inputTokens + total.outputTokens,
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      cost: total.cost,
      currency,
    },
    byAgent: Object.fromEntries(
      Object.entries(byAgent).map(([id, entry]) => [
        id,
        {
          totalTokens: entry.inputTokens + entry.outputTokens,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cost: entry.cost,
          currency: entry.currency ?? currency,
        },
      ]),
    ),
  };
}
