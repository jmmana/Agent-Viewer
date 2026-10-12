/**
 * Tests for `PricingEditor` (issue #333, sub-issue of #88): the server pricing editor mounted in both the Model
 * Ops "pricing" tab and Settings. Exercised against a hand-built `ServerApi` (its methods mocked with `vi.fn()`)
 * rather than a stubbed `fetch`, since `PricingEditor` takes a resolved `ServerApi | null` directly (the two
 * mount points each resolve their own connection via `useServerApi`, tested separately in `useServerApi.test.ts`).
 *
 * `@testing-library/user-event` is not a project dependency, so interactions use `fireEvent` directly: every
 * input here is a controlled React input, so a single `fireEvent.change` with the final string is equivalent to
 * typing it.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PricingEditor } from '../../src/components/PricingEditor';
import type { ServerApi, PricingSnapshotResponse, ServerApiResult } from '../../src/integrations/serverApi';
import type { PriceEntry } from '../../src/integrations/pricingContract';

function priceEntry(overrides: Partial<PriceEntry> = {}): PriceEntry {
  return {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    aliases: [],
    kind: 'list',
    currency: 'USD',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
    reasoningPerMillion: null,
    reasoningBilling: null,
    source: 'api',
    estimated: false,
    sourceUrl: null,
    sourceCheckedAt: null,
    note: null,
    ...overrides,
  };
}

function snapshot(entries: PriceEntry[], overrides: Partial<PricingSnapshotResponse> = {}): PricingSnapshotResponse {
  return {
    schema: 'agent-viewer.pricing/1',
    status: 'ok',
    issues: [],
    pricingVersion: 7,
    contentHash: `sha256:${'a'.repeat(64)}`,
    createdAt: '2026-10-08T14:02:11.000Z',
    estimated: false,
    starter: { bundledAsOf: '2026-01-01', appliedAsOf: '2026-01-01', updateAvailable: false },
    readonly: false,
    fileInSync: true,
    entries,
    ...overrides,
  };
}

function ok<T>(data: T): ServerApiResult<T> {
  return { ok: true, data };
}

function makeServerApi(overrides: Partial<ServerApi> = {}): ServerApi {
  return {
    getPricing: vi.fn().mockResolvedValue({ ok: false, kind: 'network' }),
    putPricingChanges: vi.fn().mockResolvedValue({ ok: false, kind: 'network' }),
    getPricingVersions: vi.fn().mockResolvedValue(ok({ versions: [] })),
    getPricingVersionDiff: vi.fn().mockResolvedValue(ok({ added: [], removed: [], changed: [] })),
    getBudgets: vi.fn(),
    getBudget: vi.fn(),
    createBudget: vi.fn(),
    putBudget: vi.fn(),
    deleteBudget: vi.fn(),
    getBudgetRevisions: vi.fn(),
    ...overrides,
  } as unknown as ServerApi;
}

function setValue(el: HTMLElement, value: string) {
  fireEvent.change(el, { target: { value } });
}

describe('PricingEditor, demo mode', () => {
  it('shows an explanation, no editable fields and makes no request when serverApi is null', () => {
    render(<PricingEditor serverApi={null} locale="en" />);
    expect(screen.getByText('Pricing is managed on the server')).toBeTruthy();
    expect(document.querySelectorAll('input').length).toBe(0);
  });
});

describe('PricingEditor, loading rows from the server', () => {
  it('renders one row per server entry', async () => {
    const api = makeServerApi({
      getPricing: vi.fn().mockResolvedValue(ok(snapshot([priceEntry(), priceEntry({ model: 'claude-3-5-haiku', inputPerMillion: 0.8, outputPerMillion: 4 })]))),
    });
    render(<PricingEditor serverApi={api} locale="en" />);
    await waitFor(() => expect(screen.getByText('claude-3-5-sonnet')).toBeTruthy());
    expect(screen.getByText('claude-3-5-haiku')).toBeTruthy();
    expect(api.getPricing).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when the server has no priced models', async () => {
    const api = makeServerApi({ getPricing: vi.fn().mockResolvedValue(ok(snapshot([]))) });
    render(<PricingEditor serverApi={api} locale="en" />);
    await waitFor(() => expect(screen.getByText('No priced models yet. Add one below to get started.')).toBeTruthy());
  });

  it('shows "update the server" on a 404', async () => {
    const api = makeServerApi({ getPricing: vi.fn().mockResolvedValue({ ok: false, kind: 'not_found', status: 404 }) });
    render(<PricingEditor serverApi={api} locale="en" />);
    await waitFor(() => expect(screen.getByText(/does not expose the pricing API/)).toBeTruthy());
  });

  it('shows a read-only notice and no table on a 403 from the server', async () => {
    const api = makeServerApi({ getPricing: vi.fn().mockResolvedValue({ ok: false, kind: 'forbidden', status: 403 }) });
    render(<PricingEditor serverApi={api} locale="en" />);
    await waitFor(() => expect(screen.getByText(/This token can only read pricing/)).toBeTruthy());
    expect(document.querySelectorAll('table').length).toBe(0);
  });
});

describe('PricingEditor, strict price parsing', () => {
  it('saves null for an emptied field, never 0', async () => {
    const putPricingChanges = vi.fn().mockResolvedValue(ok({ changed: true, pricingVersion: 8 }));
    const api = makeServerApi({
      getPricing: vi.fn().mockResolvedValue(ok(snapshot([priceEntry()]))),
      putPricingChanges,
    });
    render(<PricingEditor serverApi={api} locale="en" />);
    const input = await screen.findByLabelText('Input price per million tokens for claude-3-5-sonnet');
    setValue(input, '');
    fireEvent.click(screen.getByRole('button', { name: 'Save pricing for claude-3-5-sonnet' }));

    await waitFor(() => expect(putPricingChanges).toHaveBeenCalledTimes(1));
    const call = putPricingChanges.mock.calls[0][0];
    expect(call.upserts[0].inputPerMillion).toBeNull();
  });

  it('saves a typed 0 as 0, not null and not skipped', async () => {
    const putPricingChanges = vi.fn().mockResolvedValue(ok({ changed: true, pricingVersion: 8 }));
    const api = makeServerApi({
      getPricing: vi.fn().mockResolvedValue(ok(snapshot([priceEntry()]))),
      putPricingChanges,
    });
    render(<PricingEditor serverApi={api} locale="en" />);
    const input = await screen.findByLabelText('Output price per million tokens for claude-3-5-sonnet');
    setValue(input, '0');
    fireEvent.click(screen.getByRole('button', { name: 'Save pricing for claude-3-5-sonnet' }));

    await waitFor(() => expect(putPricingChanges).toHaveBeenCalledTimes(1));
    const call = putPricingChanges.mock.calls[0][0];
    expect(call.upserts[0].outputPerMillion).toBe(0);
  });

  it('shows a validation error and never calls the server for an invalid number', async () => {
    const putPricingChanges = vi.fn();
    const api = makeServerApi({
      getPricing: vi.fn().mockResolvedValue(ok(snapshot([priceEntry()]))),
      putPricingChanges,
    });
    render(<PricingEditor serverApi={api} locale="en" />);
    const invalidInput = await screen.findByLabelText('Input price per million tokens for claude-3-5-sonnet');
    const otherInput = screen.getByLabelText('Output price per million tokens for claude-3-5-sonnet');
    setValue(invalidInput, 'abc');
    setValue(otherInput, '20');
    fireEvent.click(screen.getByRole('button', { name: 'Save pricing for claude-3-5-sonnet' }));

    expect(await screen.findByText('Enter a plain number (0 or greater), or leave it empty for "not priced".')).toBeTruthy();
    expect(putPricingChanges).not.toHaveBeenCalled();
  });
});

describe('PricingEditor, save semantics', () => {
  it('uses the server response: the returned pricingVersion becomes the baseline for the next save', async () => {
    const putPricingChanges = vi
      .fn()
      .mockResolvedValueOnce(ok({ changed: true, pricingVersion: 8 }))
      .mockResolvedValueOnce(ok({ changed: true, pricingVersion: 9 }));
    const api = makeServerApi({
      getPricing: vi.fn().mockResolvedValue(
        ok(snapshot([priceEntry(), priceEntry({ model: 'claude-3-5-haiku', inputPerMillion: 0.8, outputPerMillion: 4 })], { pricingVersion: 7 }))
      ),
      putPricingChanges,
    });
    render(<PricingEditor serverApi={api} locale="en" />);

    const sonnetInput = await screen.findByLabelText('Input price per million tokens for claude-3-5-sonnet');
    setValue(sonnetInput, '4');
    fireEvent.click(screen.getByRole('button', { name: 'Save pricing for claude-3-5-sonnet' }));
    await waitFor(() => expect(putPricingChanges).toHaveBeenCalledTimes(1));
    expect(putPricingChanges.mock.calls[0][0].expectedVersion).toBe(7);

    const haikuInput = await screen.findByLabelText('Input price per million tokens for claude-3-5-haiku');
    setValue(haikuInput, '1');
    fireEvent.click(screen.getByRole('button', { name: 'Save pricing for claude-3-5-haiku' }));
    await waitFor(() => expect(putPricingChanges).toHaveBeenCalledTimes(2));
    // Sequential multi-row save: the second row's save uses the version the FIRST save's response returned (8),
    // never the stale version the table was first loaded with (7).
    expect(putPricingChanges.mock.calls[1][0].expectedVersion).toBe(8);
  });

  it('a 409 conflict keeps the typed values and offers a reapply action that retries with the server version', async () => {
    const putPricingChanges = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, kind: 'conflict', status: 409, currentVersion: 9 })
      .mockResolvedValueOnce(ok({ changed: true, pricingVersion: 10 }));
    const api = makeServerApi({
      getPricing: vi.fn().mockResolvedValue(ok(snapshot([priceEntry()], { pricingVersion: 7 }))),
      putPricingChanges,
    });
    render(<PricingEditor serverApi={api} locale="en" />);

    const input = await screen.findByLabelText('Input price per million tokens for claude-3-5-sonnet');
    setValue(input, '4.5');
    fireEvent.click(screen.getByRole('button', { name: 'Save pricing for claude-3-5-sonnet' }));

    await waitFor(() => expect(screen.getByText(/Someone else changed pricing/)).toBeTruthy());
    // The typed value is kept, never reverted to the server's old value.
    expect((input as HTMLInputElement).value).toBe('4.5');

    fireEvent.click(screen.getByRole('button', { name: 'Reapply with latest version' }));
    await waitFor(() => expect(putPricingChanges).toHaveBeenCalledTimes(2));
    expect(putPricingChanges.mock.calls[1][0].expectedVersion).toBe(9);
    expect(putPricingChanges.mock.calls[1][0].upserts[0].inputPerMillion).toBe(4.5);
  });

  it('a 403 on save disables further edits and shows a read-only notice', async () => {
    const putPricingChanges = vi.fn().mockResolvedValue({ ok: false, kind: 'forbidden', status: 403 });
    const api = makeServerApi({
      getPricing: vi.fn().mockResolvedValue(ok(snapshot([priceEntry()]))),
      putPricingChanges,
    });
    render(<PricingEditor serverApi={api} locale="en" />);
    const input = await screen.findByLabelText('Input price per million tokens for claude-3-5-sonnet');
    setValue(input, '4');
    fireEvent.click(screen.getByRole('button', { name: 'Save pricing for claude-3-5-sonnet' }));

    await waitFor(() =>
      expect(
        screen.getAllByText('This token can only read pricing. Ask for a token with write access to make changes.').length
      ).toBeGreaterThan(0)
    );
    expect((input as HTMLInputElement).disabled).toBe(true);
  });
});

describe('PricingEditor, add a model', () => {
  it('adds a new priced model to the catalog', async () => {
    const putPricingChanges = vi.fn().mockResolvedValue(ok({ changed: true, pricingVersion: 8 }));
    const api = makeServerApi({
      getPricing: vi.fn().mockResolvedValue(ok(snapshot([priceEntry()], { pricingVersion: 7 }))),
      putPricingChanges,
    });
    render(<PricingEditor serverApi={api} locale="en" />);
    await screen.findByText('claude-3-5-sonnet');

    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));

    const form = screen.getByText('Add a priced model').closest('div') as HTMLElement;
    const providerInput = within(form).getAllByRole('textbox')[0];
    const modelInput = within(form).getAllByRole('textbox')[1];
    setValue(providerInput, 'OpenAI');
    setValue(modelInput, 'gpt-5');
    setValue(within(form).getByLabelText('Input ($/M)'), '5');

    fireEvent.click(within(form).getByRole('button', { name: 'Add to catalog' }));

    await waitFor(() => expect(putPricingChanges).toHaveBeenCalledTimes(1));
    const call = putPricingChanges.mock.calls[0][0];
    expect(call.upserts[0]).toMatchObject({ provider: 'openai', model: 'gpt-5', inputPerMillion: 5 });
    await waitFor(() => expect(screen.getByText('gpt-5')).toBeTruthy());
  });
});

describe('PricingEditor, version history', () => {
  it('loads and renders the version history on toggle', async () => {
    const api = makeServerApi({
      getPricing: vi.fn().mockResolvedValue(ok(snapshot([priceEntry()]))),
      getPricingVersions: vi.fn().mockResolvedValue(
        ok({
          versions: [
            { pricingVersion: 7, createdAt: '2026-10-01T00:00:00.000Z', origin: 'api', reason: 'manual edit', actor: 'juan', entryCount: 1, contentHash: `sha256:${'b'.repeat(64)}` },
          ],
        })
      ),
    });
    render(<PricingEditor serverApi={api} locale="en" />);
    await screen.findByText('claude-3-5-sonnet');

    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    await waitFor(() => expect(api.getPricingVersions).toHaveBeenCalledTimes(1));
    const entry = await screen.findByText('Version 7 · 1 models · API');
    fireEvent.click(entry);
    expect(await screen.findByText('Reason: manual edit')).toBeTruthy();
  });
});

describe('PricingEditor, immutability', () => {
  it('never mutates the server response objects while editing', async () => {
    const serverEntry = priceEntry();
    const response = snapshot([serverEntry]);
    const api = makeServerApi({ getPricing: vi.fn().mockResolvedValue(ok(response)) });
    render(<PricingEditor serverApi={api} locale="en" />);

    const input = await screen.findByLabelText('Input price per million tokens for claude-3-5-sonnet');
    setValue(input, '99');

    expect(serverEntry.inputPerMillion).toBe(3);
    expect(response.entries[0].inputPerMillion).toBe(3);
  });
});
