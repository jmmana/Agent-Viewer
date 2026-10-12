/**
 * Tiny display helpers shared by `AgentInspector.tsx` and `AgentDetailModal.tsx` for rendering a `BudgetView`
 * row as plain text (issue #335). Formatting a number for display (`toLocaleString`) is not the "arithmetic"
 * issue #335 rules out: no ratio, percentage or remaining-budget figure is computed anywhere here or in the
 * callers, only the server's own `limit`/`spent` numbers are shown, each already attached to its own currency.
 */
import type { BudgetState } from '../integrations/serverApi';

/** Mirrors `BudgetsPanel.tsx`'s `stateChipClasses`: `unknown` (and "no state yet") are always neutral, never
 * green/ok, even though an unevaluated budget might otherwise look harmless. */
export function budgetStateChipClasses(state: BudgetState | null): string {
  switch (state) {
    case 'ok':
      return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
    case 'warning':
      return 'bg-amber-500/20 text-amber-300 border-amber-500/40';
    case 'exceeded':
      return 'bg-red-500/20 text-red-300 border-red-500/40';
    case 'unknown':
    case null:
    default:
      return 'bg-slate-700/40 text-slate-300 border-slate-600/50';
  }
}

/** Formats a budget amount (the server's `limit` or a known `spent` figure) with two decimal places, the same
 * way `BudgetsPanel.tsx` does, so the same number reads identically in both places. */
export function formatBudgetAmount(amount: number, intlLocale: string): string {
  return amount.toLocaleString(intlLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
