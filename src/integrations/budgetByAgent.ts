/**
 * Portal-side reduction of `useBudgetState`'s (issue #334) flat `GET /api/v1/budgets` list into the shapes the
 * office canvas and the agent panels need (issue #335, sub-issue of #88). The library (`AgentOffice`,
 * `OfficeCanvas`, `canvasRenderer.ts`, issue #87) already knows how to tint a desk or badge from a
 * `ReadonlyMap<string, AgentBudgetState>`; this module is the only place in the portal that decides what goes
 * into that map, and it never touches `src/lib/`.
 */
import type { BudgetView, BudgetState as ServerBudgetState } from './serverApi';
import type { AgentBudgetState } from '../lib/budget';

/**
 * Severity order fixed by issue #335: `exceeded > warning > unknown > ok`. `unknown` outranking `ok` is what
 * makes an agent with one `ok` and one `unknown` enabled budget land on `unknown` overall (passed through as
 * absent below), never on the reassuring `ok`.
 */
const SEVERITY_RANK: Record<ServerBudgetState, number> = { ok: 0, unknown: 1, warning: 2, exceeded: 3 };

/**
 * Reduces `budgets` to one verdict per agent id, for `OfficeCanvas`'s `budgetByAgent` prop.
 *
 * Only budgets with `scope.type === 'agent'` and `enabled: true` are considered: a budget scoped to
 * `all`/`model`/`session`/`user`/`tag` never contributes an entry here, even when it is the only budget
 * configured for the account (issue #335's "out of scope": those stay Budgets-tab-only and never tint a desk or
 * an agent).
 *
 * When more than one enabled agent-scoped budget targets the same agent (for example a daily and a monthly
 * budget on the same agent), the most severe of their states wins, by `exceeded > warning > unknown > ok`. A
 * budget that has never been evaluated yet (`status: null`) counts as `unknown` for this ranking.
 *
 * An agent whose most severe state resolves to `unknown` is left out of the returned map entirely: `unknown` is
 * passed through as an absent entry, never as `{ state: 'ok' }` or `{ state: 'unknown' }`, so the office draws no
 * marker at all for "cannot tell" instead of a reassuring or alarming one it cannot back up.
 */
export function reduceBudgetStateByAgent(budgets: readonly BudgetView[]): ReadonlyMap<string, AgentBudgetState> {
  const bestByAgent = new Map<string, ServerBudgetState>();

  for (const budget of budgets) {
    if (!budget.enabled || budget.scope.type !== 'agent') continue;
    const agentId = budget.scope.value;
    if (!agentId) continue;

    const state: ServerBudgetState = budget.status?.state ?? 'unknown';
    const current = bestByAgent.get(agentId);
    if (current === undefined || SEVERITY_RANK[state] > SEVERITY_RANK[current]) {
      bestByAgent.set(agentId, state);
    }
  }

  const result = new Map<string, AgentBudgetState>();
  for (const [agentId, state] of bestByAgent) {
    if (state === 'unknown') continue;
    result.set(agentId, { state });
  }
  return result;
}

/**
 * Every budget (enabled or not) whose scope targets `agentId` directly, in the order the server returned them.
 * Used by `AgentInspector` and `AgentDetailModal` (issue #335) to show the operator the raw row(s) behind a
 * tint: name, period, limit, currency, basis, spent-or-unknown and state, read as is, with no ratio or
 * percentage computed here or by the callers.
 *
 * Disabled budgets are included (the caller marks them as disabled): they are still configured and relevant to
 * an operator even though `reduceBudgetStateByAgent` above ignores them for tinting the office.
 */
export function agentBudgetRows(budgets: readonly BudgetView[], agentId: string): BudgetView[] {
  return budgets.filter((budget) => budget.scope.type === 'agent' && budget.scope.value === agentId);
}
