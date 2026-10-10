import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResyncNotice } from '../../src/components/ResyncNotice';

describe('ResyncNotice', () => {
  it.each([
    ['en', 'Stream resynced', '5 events could not be replayed'],
    ['es', 'Transmisión resincronizada', 'no se pudieron reenviar 5 eventos'],
  ] as const)('renders the %s notice with a known missed count', (locale, title, bodyFragment) => {
    render(<ResyncNotice locale={locale} missed={5} onDismiss={() => {}} />);
    expect(screen.getByRole('status').textContent).toContain(title);
    expect(screen.getByRole('status').textContent).toContain(bodyFragment);
  });

  it.each(['en', 'es'] as const)('never shows 0 for an unknown missed count in %s', (locale) => {
    render(<ResyncNotice locale={locale} missed={null} onDismiss={() => {}} />);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).not.toContain('0');
  });

  it('calls onDismiss when the dismiss button is activated', () => {
    const onDismiss = vi.fn();
    render(<ResyncNotice locale="en" missed={3} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
