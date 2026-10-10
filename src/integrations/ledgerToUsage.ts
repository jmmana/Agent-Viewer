/**
 * Pure mapper from a `groupBy=agent` usage rollup (issue #66, `ledgerClient.ts`) to the embeddable library's
 * `OfficeUsage` (issue #78, `src/lib/usage.ts`). Demo-app only: never imported by `src/lib` (enforced by
 * `tests/lib/libraryIsolation.test.ts`).
 *
 * Adaptation from the issue's own illustrative text: the shipped rollup response has no single `totalTokens`
 * field, only a per-kind breakdown (`tokens.input`, `tokens.output`, ...), each already summed server-side with
 * its own `unreportedCalls` count. `totalTokens` here is `input.sum + output.sum` only when BOTH are fully
 * reported for every call in the group (`unreportedCalls === 0` on each); this is not "portal arithmetic" on
 * unknown data (that is still banned: a figure missing on any call never becomes a partial sum shown as
 * complete), it is adding two fully-known totals of the same call set to get the one figure the compact badge
 * needs. Likewise `cost`/`currency` are taken only when the group's `cost.entries` has exactly one entry and
 * `unknownCostCalls` is zero: more than one entry (mixed currency or cost source) or any unknown-cost call makes
 * the figure `null`, never a cross-currency sum and never a partial total.
 */
import type { RollupGroup, RollupResponse, RollupTotals, TokenKindRollup } from './ledgerClient';
import type { OfficeUsage, UsageFigures } from '../lib/usage';

function tokenTotal(totals: RollupTotals): number | null {
  const { input, output } = totals.tokens;
  if (input.sum === null || output.sum === null) return null;
  if (input.unreportedCalls > 0 || output.unreportedCalls > 0) return null;
  return input.sum + output.sum;
}

/** One token kind (input, output, cache read, cache write, reasoning) read unchanged: `unknown` the moment any
 * call in the group did not report it, never a partial sum passed off as complete. */
function tokenKindFigure(kind: TokenKindRollup): number | null {
  if (kind.unreportedCalls > 0) return null;
  return kind.sum;
}

function costFigures(totals: RollupTotals): Pick<UsageFigures, 'cost' | 'currency' | 'costSource'> {
  if (totals.cost.entries.length !== 1 || totals.cost.unknownCostCalls > 0) {
    return { cost: null, currency: undefined, costSource: null };
  }
  const [entry] = totals.cost.entries;
  return { cost: entry.sum, currency: entry.currency ?? undefined, costSource: entry.costSource };
}

/** One rollup row (a group, or the response `totals`) as `UsageFigures`. Every value is read, never invented:
 * a field the server did not fully report stays `null`, never `0`. The per-kind breakdown (input, output, cache
 * read, cache write, reasoning) feeds the inspector, sidebar and detail-modal stat cards (issue #78); the badge
 * itself only ever reads `totalTokens`/`cost`. */
export function rollupTotalsToUsageFigures(totals: RollupTotals): UsageFigures {
  return {
    totalTokens: tokenTotal(totals),
    inputTokens: tokenKindFigure(totals.tokens.input),
    outputTokens: tokenKindFigure(totals.tokens.output),
    cacheReadTokens: tokenKindFigure(totals.tokens.cacheRead),
    cacheWriteTokens: tokenKindFigure(totals.tokens.cacheWrite),
    reasoningTokens: tokenKindFigure(totals.tokens.reasoning),
    ...costFigures(totals),
    failedCalls: totals.calls.failed > 0 ? totals.calls.failed : undefined,
  };
}

/**
 * `rollup` must come from a `groupBy=['agent']` (or `['agent', ...]`, as long as `agent` is the only dimension
 * that varies across groups for this call) request. A group whose `key.agent` is `null` or empty (calls with no
 * attributable agent) is excluded from `byAgent`; it is still folded into `total`, which is the response's own
 * `totals` field, read unchanged.
 */
export function rollupToOfficeUsage(rollup: RollupResponse): OfficeUsage {
  const byAgent: Record<string, UsageFigures> = {};
  for (const group of rollup.groups) {
    const agentId = agentKey(group);
    if (!agentId) continue;
    byAgent[agentId] = rollupTotalsToUsageFigures(group);
  }
  return { total: rollupTotalsToUsageFigures(rollup.totals), byAgent };
}

function agentKey(group: RollupGroup): string | null {
  const value = group.key.agent;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
