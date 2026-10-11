/**
 * `ToolSpendTooltip` (issue #81): opens on hover and keyboard focus, closes on blur and `Escape`, exposes its
 * content through `aria-describedby`, and renders plain children with no behavior in demo mode (`ledger: null`).
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToolSpendTooltip } from '../../src/components/usage/ToolSpendTooltip';
import type { LedgerConnection } from '../../src/components/modelOps/useModelOpsLedger';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function rollupBody(groups: unknown[] = []) {
  return {
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
  };
}

function toolGroup(tool: string) {
  return {
    key: { tool },
    attribution: { tool: 'attributed' },
    calls: { total: 4, succeeded: 4, failed: 0 },
    tokens: {
      input: { sum: 400, reportedCalls: 4, unreportedCalls: 0 },
      output: { sum: 100, reportedCalls: 4, unreportedCalls: 0 },
      cacheRead: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
      cacheWrite: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
      reasoning: { sum: null, reportedCalls: 0, unreportedCalls: 0 },
    },
    cost: { entries: [{ currency: 'USD', costSource: 'provider-reported', sum: 0.02, calls: 4 }], unknownCostCalls: 0 },
    firstAt: null,
    lastAt: null,
  };
}

const READY: LedgerConnection = { baseUrl: 'https://server.example', token: 'tok', tokenResolved: true };

describe('ToolSpendTooltip', () => {
  it('renders children unchanged in demo mode, with no behavior and no fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ToolSpendTooltip tool="web.search" agentId="ana" ledger={null} locale="en">
        <span>web.search</span>
      </ToolSpendTooltip>
    );
    expect(screen.getByText('web.search')).toBeTruthy();
    fireEvent.mouseEnter(screen.getByText('web.search').parentElement!);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('tooltip')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('opens on hover and shows the matching tool\'s figures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, rollupBody([toolGroup('web.search')]))));
    render(
      <ToolSpendTooltip tool="web.search" agentId="ana" ledger={READY} locale="en">
        <span>web.search</span>
      </ToolSpendTooltip>
    );
    fireEvent.mouseEnter(screen.getByText('web.search').closest('span')!.parentElement!);
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toContain('4'));
    vi.unstubAllGlobals();
  });

  it('shows "no figures from the server" for a chip with no matching row, never 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, rollupBody([toolGroup('other.tool')]))));
    render(
      <ToolSpendTooltip tool="web.search" agentId="bruno" ledger={READY} locale="en">
        <span>web.search</span>
      </ToolSpendTooltip>
    );
    fireEvent.mouseEnter(screen.getByText('web.search').closest('span')!.parentElement!);
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toContain('No figures from the server'));
    vi.unstubAllGlobals();
  });

  it('opens on focus and closes on blur, and exposes aria-describedby', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, rollupBody([toolGroup('web.search')]))));
    render(
      <ToolSpendTooltip tool="web.search" agentId="ana" ledger={READY} locale="en">
        <span>web.search</span>
      </ToolSpendTooltip>
    );
    const trigger = screen.getByText('web.search').parentElement!;
    fireEvent.focus(trigger);
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy());
    expect(trigger.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);

    fireEvent.blur(trigger);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('closes on Escape from anywhere while open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, rollupBody([toolGroup('web.search')]))));
    render(
      <ToolSpendTooltip tool="web.search" agentId="ana" ledger={READY} locale="en">
        <span>web.search</span>
      </ToolSpendTooltip>
    );
    fireEvent.focus(screen.getByText('web.search').parentElement!);
    await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy());
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    vi.unstubAllGlobals();
  });
});
