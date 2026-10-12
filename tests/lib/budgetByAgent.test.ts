/**
 * Tests for the portal's per-agent budget reduction (issue #335, sub-issue of #88): `reduceBudgetStateByAgent`
 * turns `useBudgetState`'s flat budget list into the `ReadonlyMap<string, AgentBudgetState>` `OfficeCanvas`
 * expects, and `agentBudgetRows` picks the raw row(s) an agent panel shows as text.
 */
import { describe, expect, it } from 'vitest';
import { agentBudgetRows, reduceBudgetStateByAgent } from '../../src/integrations/budgetByAgent';
import type { BudgetState, BudgetStatus, BudgetView } from '../../src/integrations/serverApi';

/** Minimal valid `BudgetView`, overridable per test. `status` defaults to `null` (never evaluated). */
function budgetView(overrides: Partial<BudgetView> & { id: string }): BudgetView {
  return {
    name: overrides.id,
    scope: { type: 'agent', value: null },
    period: 'month',
    timezone: 'UTC',
    currency: 'USD',
    basis: 'reported',
    limit: 100,
    warningRatio: 0.8,
    enabled: true,
    revision: 1,
    createdAt: 1000,
    updatedAt: 1000,
    status: null,
    ...overrides,
  };
}

function statusWithState(state: BudgetState): BudgetStatus {
  return {
    state,
    window: { start: 0, end: 1 },
    spent: 10,
    spentComplete: true,
    knownSpent: 10,
    breakdown: { reported: 10, estimated: 0 },
    containsEstimates: false,
    limitRemaining: 90,
    ratio: 0.1,
    calls: { total: 1, withCost: 1, unknownCost: 0, otherCurrency: 0, missingCurrency: 0 },
    unknownReasons: [],
    pricingVersions: [1],
    evaluatedAt: 1000,
  };
}

describe('reduceBudgetStateByAgent', () => {
  it('produces one entry per agent from agent-scoped, enabled budgets', () => {
    const budgets = [
      budgetView({ id: 'b-backend', scope: { type: 'agent', value: 'backend-agent' }, status: statusWithState('warning') }),
      budgetView({ id: 'b-qa', scope: { type: 'agent', value: 'qa-agent' }, status: statusWithState('exceeded') }),
    ];

    const map = reduceBudgetStateByAgent(budgets);

    expect(map.get('backend-agent')).toEqual({ state: 'warning' });
    expect(map.get('qa-agent')).toEqual({ state: 'exceeded' });
    expect(map.size).toBe(2);
  });

  it('picks the most severe state when several enabled agent-scoped budgets target the same agent: exceeded beats unknown', () => {
    const budgets = [
      budgetView({ id: 'b1', scope: { type: 'agent', value: 'backend-agent' }, status: statusWithState('exceeded') }),
      budgetView({ id: 'b2', scope: { type: 'agent', value: 'backend-agent' }, status: null }), // never evaluated -> unknown
    ];

    const map = reduceBudgetStateByAgent(budgets);

    expect(map.get('backend-agent')).toEqual({ state: 'exceeded' });
  });

  it('ok + unknown resolves to unknown, which is passed through as absent, never as ok', () => {
    const budgets = [
      budgetView({ id: 'b1', scope: { type: 'agent', value: 'backend-agent' }, status: statusWithState('ok') }),
      budgetView({ id: 'b2', scope: { type: 'agent', value: 'backend-agent' }, status: null }), // unknown
    ];

    const map = reduceBudgetStateByAgent(budgets);

    expect(map.has('backend-agent')).toBe(false);
  });

  it('an agent-scoped budget alone at unknown never appears in the map', () => {
    const budgets = [budgetView({ id: 'b1', scope: { type: 'agent', value: 'solo-agent' }, status: statusWithState('unknown') })];

    const map = reduceBudgetStateByAgent(budgets);

    expect(map.has('solo-agent')).toBe(false);
    expect(map.size).toBe(0);
  });

  it('ignores disabled agent-scoped budgets entirely', () => {
    const budgets = [
      budgetView({ id: 'b1', scope: { type: 'agent', value: 'backend-agent' }, enabled: false, status: statusWithState('exceeded') }),
    ];

    expect(reduceBudgetStateByAgent(budgets).size).toBe(0);
  });

  it('never lets global or model scoped budgets affect the map, even when exceeded', () => {
    const budgets = [
      budgetView({ id: 'b-global', scope: { type: 'all', value: null }, status: statusWithState('exceeded') }),
      budgetView({ id: 'b-model', scope: { type: 'model', value: 'gpt-4' }, status: statusWithState('exceeded') }),
      budgetView({ id: 'b-session', scope: { type: 'session', value: 's1' }, status: statusWithState('exceeded') }),
      budgetView({ id: 'b-user', scope: { type: 'user', value: 'u1' }, status: statusWithState('exceeded') }),
      budgetView({ id: 'b-tag', scope: { type: 'tag', value: 't1' }, status: statusWithState('exceeded') }),
    ];

    expect(reduceBudgetStateByAgent(budgets).size).toBe(0);
  });

  it('returns an empty map for an empty budget list', () => {
    expect(reduceBudgetStateByAgent([]).size).toBe(0);
  });
});

describe('agentBudgetRows', () => {
  it('returns only the budgets scoped to the given agent, including disabled ones', () => {
    const backendBudget = budgetView({ id: 'b-backend', scope: { type: 'agent', value: 'backend-agent' } });
    const disabledBackendBudget = budgetView({
      id: 'b-backend-2',
      scope: { type: 'agent', value: 'backend-agent' },
      enabled: false,
    });
    const qaBudget = budgetView({ id: 'b-qa', scope: { type: 'agent', value: 'qa-agent' } });
    const globalBudget = budgetView({ id: 'b-global', scope: { type: 'all', value: null } });

    const rows = agentBudgetRows([backendBudget, disabledBackendBudget, qaBudget, globalBudget], 'backend-agent');

    expect(rows).toEqual([backendBudget, disabledBackendBudget]);
  });

  it('returns an empty array when no budget targets the agent', () => {
    const qaBudget = budgetView({ id: 'b-qa', scope: { type: 'agent', value: 'qa-agent' } });
    expect(agentBudgetRows([qaBudget], 'backend-agent')).toEqual([]);
  });
});
