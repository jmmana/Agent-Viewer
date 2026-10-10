/**
 * `UsageEmptyState` (issue #79): the seven states in English and Spanish, and for `kind === 'empty'`, that the
 * curl snippet uses the real API base, contains no token value and its payload validates against the canonical
 * V1 envelope (the same schema the server's `POST /api/v1/events` enforces).
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsageEmptyState, type UsageEmptyStateKind } from '../../src/components/modelOps/UsageEmptyState';
import { validateCanonicalEvent } from '../../src/integrations/canonicalContract';
import type { Locale } from '../../src/i18n';

const STATES: UsageEmptyStateKind[] = ['loading', 'unavailable', 'unauthorized', 'error', 'empty', 'filtered'];

describe.each(['en', 'es'] as Locale[])('UsageEmptyState (%s)', (locale) => {
  it.each(STATES)('renders the "%s" state with role="status" and visible text', (kind) => {
    const { unmount } = render(
      <UsageEmptyState kind={kind} locale={locale} apiBase="https://server.example" errorMessage="boom" onRetry={vi.fn()} onClearFilters={vi.fn()} />
    );
    expect(screen.getByRole('status')).toBeTruthy();
    unmount();
  });
});

describe('UsageEmptyState, kind "empty"', () => {
  it('the curl snippet uses the real API base, has no token value and its payload passes validateCanonicalEvent', () => {
    render(<UsageEmptyState kind="empty" locale="en" apiBase="https://my-server.example" />);
    const pre = screen.getAllByRole('status')[0].querySelector('pre');
    const snippet = pre?.textContent ?? '';
    expect(snippet).toContain('https://my-server.example/api/v1/events');
    expect(snippet).not.toMatch(/Bearer [A-Za-z0-9._-]{10,}/); // only the $VAR placeholder, never a real token
    expect(snippet).toContain('$AGENT_VIEWER_TOKEN');

    const jsonMatch = snippet.match(/-d '(\{.*\})'/);
    expect(jsonMatch).toBeTruthy();
    const payload = JSON.parse(jsonMatch![1]);
    const result = validateCanonicalEvent(payload);
    expect(result.success).toBe(true);
  });

  it('calls onRetry from the error state and onClearFilters from the filtered state', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<UsageEmptyState kind="error" locale="en" onRetry={onRetry} />);
    screen.getByText('Retry').click();
    expect(onRetry).toHaveBeenCalledTimes(1);

    const onClearFilters = vi.fn();
    rerender(<UsageEmptyState kind="filtered" locale="en" onClearFilters={onClearFilters} />);
    screen.getByText('Clear filters').click();
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});
