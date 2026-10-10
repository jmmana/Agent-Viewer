/**
 * Portal-only display rows over a `meeting`/`tool` rollup group (issue #81). Pure formatting: no sum, no
 * conversion, no pricing. Every number already comes aggregated from the server (`server/usage/rollup.ts`,
 * issue #80); this module only turns a `RollupTotals` into labelled strings, reusing `formatTokens`/`formatCost`
 * from the library's own `src/lib/usage.ts` instead of duplicating number formatting.
 *
 * Reconciliation note (the issue's own "first task"): the pre-implementation sketch this issue was written
 * against assumed a single `tokens.total` and a per-dimension `unattributedCalls` field. The shipped server
 * (#80) reports tokens per kind (`input`/`output`/`cacheRead`/`cacheWrite`/`reasoning`, each already summed) and
 * has no time-overlap heuristic, so "calls in this meeting without a meetingId" does not exist as a concept:
 * unattributed calls are their own `meeting`-dimension group (`key.meetingId: null`), shown as its own row by
 * the caller, never folded into a specific meeting's figures. The `tool` dimension has no equivalent concept
 * scoped to one tool name either, so a tool's tooltip shows only the calls actually `attributed` to it.
 */
import type { CostEntry, RollupGroup, RollupTotals, TokenKind } from '../../integrations/ledgerClient';
import { formatCost, formatTokens } from '../../lib/usage';
import { t, type Locale, type TranslationKey } from '../../i18n';
import type { OfficeMessageKey, OfficeMessageParams } from '../../content/officeMessages';

/** Adapts the app's `t(locale, key, params)` to the `OfficeTranslate` shape `formatTokens`/`formatCost` expect.
 * Safe because every `OfficeMessageKey` is merged into the app's own `TranslationKey` union (`src/i18n.ts`). */
export function appTranslate(locale: Locale): (key: OfficeMessageKey, params?: OfficeMessageParams) => string {
  return (key, params) => t(locale, key as TranslationKey, params);
}

export interface SpendRow {
  key: string;
  label: string;
  value: string;
}

const TOKEN_KIND_LABEL: Record<TokenKind, TranslationKey> = {
  input: 'meetings.spend.inputTokens',
  output: 'meetings.spend.outputTokens',
  cacheRead: 'usage.cacheReadTokens',
  cacheWrite: 'usage.cacheWriteTokens',
  reasoning: 'usage.reasoningTokens',
};

/** Token kinds shown only when the server actually reported or attempted them; `input`/`output` always show. */
const ALWAYS_SHOWN: readonly TokenKind[] = ['input', 'output'];

function formatCostEntry(entry: CostEntry, locale: Locale, translate: ReturnType<typeof appTranslate>): string {
  const sourceLabel = entry.costSource === 'provider-reported'
    ? translate('usage.costSource.providerReported')
    : entry.costSource === 'estimated'
      ? translate('usage.costSource.estimated')
      : translate('usage.sourceUnknown');
  const amount = entry.currency
    ? formatCost(entry.sum, entry.currency, locale, translate)
    : `${new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(entry.sum)} (${translate('usage.noCurrency')})`;
  return `${amount} · ${sourceLabel}`;
}

/** The rows a meeting or tool spend panel shows for one `RollupTotals` (a group, or the response `totals`). */
export function spendRows(totals: RollupTotals, locale: Locale, t2: ReturnType<typeof appTranslate>): SpendRow[] {
  const rows: SpendRow[] = [
    { key: 'calls', label: t(locale, 'meetings.spend.calls', { count: totals.calls.total }), value: String(totals.calls.total) },
  ];

  for (const kind of Object.keys(totals.tokens) as TokenKind[]) {
    const figure = totals.tokens[kind];
    const hasData = figure.sum !== null || figure.reportedCalls > 0 || figure.unreportedCalls > 0;
    if (!ALWAYS_SHOWN.includes(kind) && !hasData) continue;
    let value = formatTokens(figure.sum, locale, t2);
    if (figure.unreportedCalls > 0) {
      value = t(locale, 'usage.partialTokens', {
        value,
        count: figure.unreportedCalls,
        calls: figure.reportedCalls + figure.unreportedCalls,
      });
    }
    rows.push({ key: `tokens.${kind}`, label: t(locale, TOKEN_KIND_LABEL[kind]), value });
  }

  if (totals.cost.entries.length === 0) {
    rows.push({ key: 'cost', label: t(locale, 'meetings.spend.cost'), value: t(locale, 'usage.unknown') });
  } else {
    for (const entry of totals.cost.entries) {
      rows.push({
        key: `cost.${entry.currency ?? 'none'}.${entry.costSource}`,
        label: t(locale, 'meetings.spend.cost'),
        value: formatCostEntry(entry, locale, t2),
      });
    }
    if (totals.cost.unknownCostCalls > 0) {
      rows.push({
        key: 'cost.partial',
        label: t(locale, 'meetings.spend.cost'),
        value: t(locale, 'usage.partialCost', { count: totals.cost.unknownCostCalls }),
      });
    }
  }

  return rows;
}

/** The portal never reads a server row's `meeting` title field as anything but the server's own value: a
 * `meetingId` with no recorded title still shows the id, never "unknown" (the link itself is known). */
export function meetingGroupTitle(group: RollupGroup): string | null {
  const title = group.key.title;
  return typeof title === 'string' && title.length > 0 ? title : null;
}
