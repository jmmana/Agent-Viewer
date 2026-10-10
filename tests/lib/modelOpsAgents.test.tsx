/**
 * `AgentsTab` (issue #79): per-agent-per-model rows in `ledger` mode, "No usage reported" for an office agent
 * with no ledger rows, an unattributed row for a `null` agentId, and the model `<select>`/`onChangeAgentModel`
 * existing only in `simulated` mode.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentsTab } from '../../src/components/modelOps/AgentsTab';
import type { QueryState } from '../../src/components/modelOps/useModelOpsLedger';
import type { RollupResponse } from '../../src/integrations/ledgerClient';
import type { Agent } from '../../src/types/agent';
import { INITIAL_AGENTS } from '../../src/engine/officeModel';

function ready(groups: RollupResponse['groups']): QueryState<RollupResponse> {
  return {
    status: 'ready',
    data: {
      schemaVersion: '1.0',
      asOf: { ledgerSeq: 1, lastRowReceivedAt: 1, generatedAt: Date.now() },
      coverage: { storage: 'memory', complete: true, droppedRows: 0, purgedThrough: null, backfilledRows: 0, legacyContractRows: 0 },
      groupsAreAdditive: true,
      groupCount: groups.length,
      truncated: false,
      groups,
      totals: {
        calls: { total: 0, succeeded: 0, failed: 0 },
        tokens: {
          input: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
          output: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
          cacheRead: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
          cacheWrite: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
          reasoning: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
        },
        cost: { entries: [], unknownCostCalls: 0 },
        firstAt: null,
        lastAt: null,
      },
    },
  };
}

function row(overrides: Partial<RollupResponse['groups'][number]> & { key: RollupResponse['groups'][number]['key'] }): RollupResponse['groups'][number] {
  return {
    calls: { total: 3, succeeded: 3, failed: 0 },
    tokens: {
      input: { sum: 10, reportedCalls: 3, unreportedCalls: 0 },
      output: { sum: 5, reportedCalls: 3, unreportedCalls: 0 },
      cacheRead: { sum: null, reportedCalls: 0, unreportedCalls: 3 },
      cacheWrite: { sum: null, reportedCalls: 0, unreportedCalls: 3 },
      reasoning: { sum: null, reportedCalls: 0, unreportedCalls: 3 },
    },
    cost: { entries: [{ currency: 'USD', costSource: 'provider-reported', sum: 0.5, calls: 3 }], unknownCostCalls: 0 },
    firstAt: 1,
    lastAt: 2,
    ...overrides,
  };
}

const agents: Agent[] = INITIAL_AGENTS.slice(0, 2);

describe('AgentsTab, ledger mode', () => {
  function baseProps() {
    return {
      mode: 'ledger' as const,
      locale: 'en' as const,
      agents,
      onFocusAgent: vi.fn(),
      onClose: vi.fn(),
      onRetry: vi.fn(),
      agentRollup: ready([]),
      allModels: [],
      onChangeAgentModel: vi.fn(),
    };
  }

  it('shows one row per agent and model, with calls/failed/tokens/cost', () => {
    const rows = [row({ key: { agent: agents[0].id, model: 'claude-sonnet-4-5', provider: 'anthropic' } })];
    render(<AgentsTab {...baseProps()} agentRollup={ready(rows)} />);
    expect(screen.getByText(agents[0].name)).toBeTruthy();
    expect(screen.getByText('claude-sonnet-4-5')).toBeTruthy();
  });

  it('shows "No usage reported" for an office agent absent from the ledger rows', () => {
    render(<AgentsTab {...baseProps()} agentRollup={ready([])} />);
    expect(screen.getAllByText('No usage reported').length).toBe(agents.length);
  });

  it('shows an "Unattributed" row for a null agentId', () => {
    const rows = [row({ key: { agent: null, model: 'claude-sonnet-4-5', provider: 'anthropic' } })];
    render(<AgentsTab {...baseProps()} agentRollup={ready(rows)} />);
    expect(screen.getByText('Unattributed')).toBeTruthy();
  });

  it('has no model <select> and never calls onChangeAgentModel', () => {
    const rows = [row({ key: { agent: agents[0].id, model: 'claude-sonnet-4-5', provider: 'anthropic' } })];
    render(<AgentsTab {...baseProps()} agentRollup={ready(rows)} />);
    expect(screen.queryAllByRole('combobox').length).toBe(0);
  });
});

describe('AgentsTab, simulated mode', () => {
  it('keeps the model <select> for interactive reassignment', () => {
    render(
      <AgentsTab
        mode="simulated"
        locale="en"
        agents={agents}
        onFocusAgent={vi.fn()}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        agentRollup={{ status: 'idle' }}
        allModels={[{ provider: 'OpenAI', model: 'gpt-4o' }]}
        onChangeAgentModel={vi.fn()}
      />
    );
    expect(screen.getAllByRole('combobox').length).toBe(agents.length);
  });
});
