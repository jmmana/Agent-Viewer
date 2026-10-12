/**
 * Tests for `BudgetsPanel` (issue #334): the panel never computes `spent / limit` or classifies a `state`
 * itself, so these tests feed it server responses directly (including contradictory `spent`/`limit`/`state`
 * combinations, issue #88's own acceptance criterion) and assert only on what was rendered, never on a value
 * the component derived on its own. Create/edit/delete requests, the "no state yet" and "unknown spent" cases,
 * and the cost-basis label are all covered here; the fetch/refresh/throttle timing lives in
 * `tests/lib/useBudgetState.test.tsx`.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { BudgetsPanel } from '../../src/components/modelOps/BudgetsPanel';
import { createServerApi, type ServerApi } from '../../src/integrations/serverApi';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function statusFixture(overrides: Record<string, unknown> = {}) {
  return {
    state: 'ok',
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
    evaluatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function budgetView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    name: 'Monthly ceiling',
    scope: { type: 'all', value: null },
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

function budgetsBody(budgets: unknown[] = []) {
  return { schemaVersion: '1.0', generatedAt: 5000, count: budgets.length, budgets };
}

interface RecordedCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  idempotencyKey: string | undefined;
}

function makeApi(initialBudgets: unknown[]): { api: ServerApi; calls: RecordedCall[]; store: { budgets: unknown[] } } {
  const calls: RecordedCall[] = [];
  const store = { budgets: initialBudgets };

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const parsed = new URL(url);
    calls.push({ method, path: parsed.pathname, body, idempotencyKey: headers['Idempotency-Key'] });

    if (method === 'GET' && parsed.pathname === '/api/v1/budgets') {
      return jsonResponse(200, budgetsBody(store.budgets));
    }
    if (method === 'POST' && parsed.pathname === '/api/v1/budgets') {
      const created = budgetView({ ...body, id: 'new-budget' });
      store.budgets = [...store.budgets, created];
      return jsonResponse(200, created);
    }
    if (method === 'PUT' && parsed.pathname.startsWith('/api/v1/budgets/')) {
      const id = decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
      const updated = budgetView({ ...body, id });
      store.budgets = store.budgets.map((b) => ((b as { id: string }).id === id ? updated : b));
      return jsonResponse(200, updated);
    }
    if (method === 'DELETE' && parsed.pathname.startsWith('/api/v1/budgets/')) {
      const id = decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
      store.budgets = store.budgets.filter((b) => (b as { id: string }).id !== id);
      return jsonResponse(204, null);
    }
    return jsonResponse(404, { error: 'not_found' });
  });

  const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => 'tok', fetchImpl: fetchMock as unknown as typeof fetch });
  return { api, calls, store };
}

describe('BudgetsPanel', () => {
  it('shows a dedicated message and makes no request when serverApi is null (demo mode)', () => {
    render(<BudgetsPanel locale="en" serverApi={null} />);
    expect(screen.getByText(/require a live server connection/)).toBeTruthy();
  });

  it('a budget with no matching state entry shows "No state yet", a neutral chip, never a spent figure', async () => {
    const { api } = makeApi([budgetView({ status: null })]);
    render(<BudgetsPanel locale="en" serverApi={api} />);
    await screen.findByText('Monthly ceiling');
    // Two occurrences: the state column chip and the spent column (no status to read a figure from).
    expect(screen.getAllByText('No state yet').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/^\$?0(\.00)?$/)).toBeNull();
  });

  it('spent: null renders the translated "Unknown" with a tooltip, never 0', async () => {
    const { api } = makeApi([budgetView({ status: statusFixture({ spent: null, ratio: null }) })]);
    render(<BudgetsPanel locale="en" serverApi={api} />);
    await screen.findByText('Monthly ceiling');
    const unknown = screen.getByText('Unknown');
    expect(unknown.getAttribute('title')).toMatch(/could not determine/);
    expect(screen.queryByText('0.00')).toBeNull();
  });

  it('the cost basis label is shown next to the spent figure', async () => {
    const { api } = makeApi([budgetView({ basis: 'reported_plus_estimated', status: statusFixture({ spent: 42 }) })]);
    render(<BudgetsPanel locale="en" serverApi={api} />);
    await screen.findByText('Monthly ceiling');
    expect(screen.getByText('(reported + estimated)')).toBeTruthy();
    expect(screen.getByText(/42\.00/)).toBeTruthy();
  });

  it('follows the server state even when spent/limit would imply a different one (issue #88 acceptance criterion)', async () => {
    const { api } = makeApi([
      // Spent (500) far exceeds limit (10), yet the server says "ok": the chip must say OK, not Exceeded.
      budgetView({ id: 'contradictory-ok', name: 'Looks blown but server says OK', limit: 10, status: statusFixture({ state: 'ok', spent: 500, ratio: 50 }) }),
      // Spent (1) is trivial against a 1000 limit, yet the server says "exceeded": the chip must say Exceeded.
      budgetView({ id: 'contradictory-exceeded', name: 'Looks fine but server says Exceeded', limit: 1000, status: statusFixture({ state: 'exceeded', spent: 1, ratio: 0.001 }) }),
    ]);
    render(<BudgetsPanel locale="en" serverApi={api} />);
    await screen.findByText('Looks blown but server says OK');

    const okRow = screen.getByText('Looks blown but server says OK').closest('tr') as HTMLElement;
    expect(within(okRow).getByText('OK')).toBeTruthy();
    expect(within(okRow).queryByText('Exceeded')).toBeNull();

    const exceededRow = screen.getByText('Looks fine but server says Exceeded').closest('tr') as HTMLElement;
    expect(within(exceededRow).getByText('Exceeded')).toBeTruthy();
    expect(within(exceededRow).queryByText('OK')).toBeNull();
  });

  it('creates a budget: fills the form and sends a POST with the entered fields and an Idempotency-Key', async () => {
    const { api, calls } = makeApi([]);
    render(<BudgetsPanel locale="en" serverApi={api} />);
    await waitFor(() => expect(screen.getByText('No budgets configured yet.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /New budget/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Daily cap' } });
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const postCall = calls.find((c) => c.method === 'POST')!;
    expect(postCall.body?.name).toBe('Daily cap');
    expect(postCall.body?.limit).toBe(25);
    expect(postCall.idempotencyKey).toBeTruthy();
    await screen.findByText('Daily cap');
  });

  it('a failed submit keeps the same Idempotency-Key on the next attempt, so a retry cannot create a duplicate', async () => {
    let postAttempts = 0;
    const { api: baseApi } = makeApi([]);
    void baseApi;
    const capturedKeys: Array<string | undefined> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      const parsed = new URL(url);
      if (method === 'GET') return jsonResponse(200, budgetsBody([]));
      if (method === 'POST') {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        capturedKeys.push(headers['Idempotency-Key']);
        postAttempts += 1;
        if (postAttempts === 1) return jsonResponse(500, { error: 'boom' });
        return jsonResponse(200, budgetView({ id: 'new-budget', name: 'Retry budget', limit: 25 }));
      }
      return jsonResponse(404, { error: 'not_found' });
    });
    const api = createServerApi({ apiBase: 'https://server.example', getToken: async () => 'tok', fetchImpl: fetchMock as unknown as typeof fetch });

    render(<BudgetsPanel locale="en" serverApi={api} />);
    await waitFor(() => expect(screen.getByText('No budgets configured yet.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /New budget/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Retry budget' } });
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // The second attempt succeeds: the form closes (its "Name" field is gone).
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull());

    expect(capturedKeys).toHaveLength(2);
    expect(capturedKeys[0]).toBeTruthy();
    expect(capturedKeys[0]).toBe(capturedKeys[1]);
  });

  it('rejects an invalid limit client-side and never sends a request', async () => {
    const { api, calls } = makeApi([]);
    render(<BudgetsPanel locale="en" serverApi={api} />);
    await waitFor(() => expect(screen.getByText('No budgets configured yet.')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /New budget/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bad budget' } });
    fireEvent.change(screen.getByLabelText('Limit'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/greater than 0/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('edits an existing budget: the form is pre-filled, and saving sends a PUT to that budget id', async () => {
    const { api, calls } = makeApi([budgetView({ id: 'b-edit', name: 'Editable budget', limit: 50 })]);
    render(<BudgetsPanel locale="en" serverApi={api} />);
    await screen.findByText('Editable budget');

    fireEvent.click(screen.getByRole('button', { name: /Edit Editable budget/ }));
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    expect(nameInput.value).toBe('Editable budget');
    const limitInput = screen.getByLabelText('Limit') as HTMLInputElement;
    expect(limitInput.value).toBe('50');

    fireEvent.change(limitInput, { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/api/v1/budgets/b-edit')).toBe(true));
    const putCall = calls.find((c) => c.method === 'PUT')!;
    expect(putCall.body?.limit).toBe(75);
  });

  it('deleting a budget asks for confirmation, and only sends DELETE once confirmed', async () => {
    const { api, calls } = makeApi([budgetView({ id: 'b-delete', name: 'Deletable budget' })]);
    render(<BudgetsPanel locale="en" serverApi={api} />);
    await screen.findByText('Deletable budget');

    fireEvent.click(screen.getByRole('button', { name: /Delete Deletable budget/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Deletable budget/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Delete Deletable budget/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete budget' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/api/v1/budgets/b-delete')).toBe(true));
    await waitFor(() => expect(screen.queryByText('Deletable budget')).toBeNull());
  });

  it('shows a progress bar only when ratio is not null', async () => {
    const { api } = makeApi([
      budgetView({ id: 'with-ratio', name: 'Has ratio', status: statusFixture({ ratio: 0.5 }) }),
      budgetView({ id: 'no-ratio', name: 'No ratio', status: statusFixture({ ratio: null }) }),
    ]);
    render(<BudgetsPanel locale="en" serverApi={api} />);
    await screen.findByText('Has ratio');

    const withRatioRow = screen.getByText('Has ratio').closest('tr') as HTMLElement;
    expect(within(withRatioRow).getByRole('progressbar')).toBeTruthy();

    const noRatioRow = screen.getByText('No ratio').closest('tr') as HTMLElement;
    expect(within(noRatioRow).queryByRole('progressbar')).toBeNull();
  });
});
