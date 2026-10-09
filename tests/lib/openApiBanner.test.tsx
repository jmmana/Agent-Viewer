import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OpenApiBanner } from '../../src/components/OpenApiBanner';
import { TopBar } from '../../src/components/TopBar';
import { t } from '../../src/i18n';

describe('OpenApiBanner', () => {
  it.each([
    ['en', 'This server has no API token', 'How to set a token'],
    ['es', 'Este servidor no tiene token de API', 'Cómo definir un token'],
  ] as const)('renders the persistent %s warning', (locale, title, linkText) => {
    render(<OpenApiBanner locale={locale} />);
    expect(screen.getByRole('alert').textContent).toContain(title);
    expect(screen.getByText(linkText).getAttribute('href')).toBe('https://github.com/jmmana/Agent-Viewer#-security');
    expect(screen.getByText(linkText).getAttribute('target')).toBe('_blank');
    expect(screen.getByText(linkText).getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('TopBar open API pill', () => {
  const props = {
    currentTab: 'office' as const,
    onTabChange: () => {},
    isPlayingDemo: false,
    demoStepIndex: 0,
    totalDemoSteps: 1,
    playbackSpeed: 1,
    onTogglePlayDemo: () => {},
    onStepForward: () => {},
    onResetDemo: () => {},
    onChangeSpeed: () => {},
    totalTokens: { input: 0, output: 0 },
    totalCost: 0,
    theme: 'dark' as const,
    onToggleTheme: () => {},
    onOpenSettings: () => {},
    onOpenNewTask: () => {},
    activeMeetingCount: 0,
    onChangeLocale: () => {},
    isLiveMode: true,
    isLiveConnected: true,
  };

  it.each([
    ['en', 'OPEN API'],
    ['es', 'API ABIERTA'],
  ] as const)('shows the %s open indicator only when the API is open', (locale, label) => {
    const { rerender } = render(<TopBar {...props} locale={locale} openApi />);
    const openLabel = screen.getByText(label);
    expect(openLabel.parentElement?.textContent).toContain(t(locale, 'live.badge'));
    expect(openLabel.parentElement?.className).toContain('border-amber');

    rerender(<TopBar {...props} locale={locale} openApi={false} />);
    expect(screen.queryByText(label)).toBeNull();
  });

  it('keeps the connecting pill while the stream is disconnected even when the API is open', () => {
    render(<TopBar {...props} locale="en" isLiveConnected={false} openApi />);
    expect(screen.getByText('CONNECTING')).toBeTruthy();
    expect(screen.queryByText('OPEN API')).toBeNull();
  });
});
