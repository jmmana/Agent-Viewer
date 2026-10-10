import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  AgentOffice,
  ReplayControls,
  useEventReplay,
  type HostTranslate,
  type OfficeEventInput,
  type OfficeUsage,
} from '../../src/lib/index';
import {
  T0,
  collectVisibleTexts,
  findEnglishLeaks,
  llmFailed,
  llmUsage,
  meetingMessage,
  meetingRequested,
  messageSent,
  registered,
  statusChanged,
} from './fixtures';

/** The visually hidden agent list: one line per agent, keyed by agent id. */
function agentLines(root: ParentNode = document): Record<string, string> {
  return Object.fromEntries(
    Array.from(root.querySelectorAll('li[data-agent-id]')).map((item) => [
      item.getAttribute('data-agent-id') ?? '',
      item.textContent ?? '',
    ]),
  );
}

function agentList(root: ParentNode = document): HTMLUListElement {
  const list = root.querySelector<HTMLUListElement>('ul[aria-live="polite"]');
  if (!list) throw new Error('The hidden agent list is missing');
  return list;
}

function listHeading(root: ParentNode = document): string {
  const id = agentList(root).getAttribute('aria-labelledby');
  return (id && document.getElementById(id)?.textContent) || '';
}

const englishTeam: OfficeEventInput[] = [
  registered('planner', 'Ana Rivas', { roleTitle: 'Planner', workspace: 'leads_area' }, { at: T0 }),
  registered('builder', 'Bruno Díaz', { roleTitle: 'Engineer', workspace: 'development' }, { at: T0 + 1000 }),
  registered('reviewer', 'Carla Méndez', {}, { at: T0 + 1500 }),
  statusChanged('planner', 'THINKING', { at: T0 + 2000 }),
  statusChanged('builder', 'CODING', { at: T0 + 3000 }),
];

// Role titles are host data and are never translated, so the Spanish scenes use Spanish titles.
const spanishTeam: OfficeEventInput[] = [
  registered('planner', 'Ana Rivas', { roleTitle: 'Planificadora', workspace: 'leads_area' }, { at: T0 }),
  registered('builder', 'Bruno Díaz', { roleTitle: 'Ingeniero', workspace: 'development' }, { at: T0 + 1000 }),
  registered('reviewer', 'Carla Méndez', {}, { at: T0 + 1500 }),
  statusChanged('planner', 'THINKING', { at: T0 + 2000 }),
  statusChanged('builder', 'CODING', { at: T0 + 3000 }),
];

describe('AgentOffice: agents from events', () => {
  it('lists agents that come only from events, with their translated status', () => {
    render(<AgentOffice events={englishTeam} />);

    expect(agentLines()).toEqual({
      planner: 'Ana Rivas, Planner: Thinking',
      builder: 'Bruno Díaz, Engineer: Coding',
      reviewer: 'Carla Méndez: Idle',
    });
    expect(listHeading()).toBe('Agents in the office');
    expect(screen.queryByText('Waiting for agent activity')).toBeNull();
  });

  it('uses the Spanish catalog when locale is "es"', () => {
    render(<AgentOffice events={spanishTeam} locale="es" />);

    expect(agentLines()).toEqual({
      planner: 'Ana Rivas, Planificadora: Pensando',
      builder: 'Bruno Díaz, Ingeniero: Programando',
      reviewer: 'Carla Méndez: En espera',
    });
    expect(listHeading()).toBe('Agentes en la oficina');
    expect(screen.getByRole('region', { name: 'Oficina de agentes' })).toBeTruthy();
  });

  it('picks the Spanish catalog for regional locales such as es-CO', () => {
    render(<AgentOffice events={spanishTeam} locale="es-CO" />);
    expect(agentLines().planner).toBe('Ana Rivas, Planificadora: Pensando');
  });

  it('shows the empty state in the requested language and no list items', () => {
    const { unmount } = render(<AgentOffice />);
    expect(screen.getByText('Waiting for agent activity')).toBeTruthy();
    expect(agentList().children).toHaveLength(0);
    unmount();

    render(<AgentOffice locale="es" />);
    expect(screen.getByText('Esperando actividad de los agentes')).toBeTruthy();
    expect(screen.queryByText('Waiting for agent activity')).toBeNull();
    expect(agentList().children).toHaveLength(0);
  });

  it('updates the list when new events are appended', () => {
    const { rerender } = render(<AgentOffice events={spanishTeam} locale="es" />);
    expect(agentLines().planner).toBe('Ana Rivas, Planificadora: Pensando');

    rerender(
      <AgentOffice events={[...spanishTeam, statusChanged('planner', 'BLOCKED', { at: T0 + 4000 })]} locale="es" />,
    );
    expect(agentLines().planner).toBe('Ana Rivas, Planificadora: Bloqueado');
    expect(agentLines().builder).toBe('Bruno Díaz, Ingeniero: Programando');
  });

  it('shows agents from the `agents` prop before their first event', () => {
    render(
      <AgentOffice
        locale="es"
        agents={[{ id: 'scout', name: 'Diego Paz', roleTitle: 'Investigador', workspace: 'research_area' }]}
      />,
    );
    expect(agentLines()).toEqual({ scout: 'Diego Paz, Investigador: En espera' });
    expect(screen.queryByText('Esperando actividad de los agentes')).toBeNull();
  });
});

describe('AgentOffice: no English text when Spanish is requested', () => {
  const usage: OfficeUsage = {
    total: { totalTokens: 9200, inputTokens: 8000, outputTokens: 1200, cost: null, currency: 'USD' },
    byAgent: { planner: { totalTokens: 4100, cost: 0.42, currency: 'USD' } },
  };
  const busyScene: OfficeEventInput[] = [
    ...spanishTeam,
    meetingRequested('planner', 'sync-1', ['planner', 'builder'], { at: T0 + 5000 }),
    meetingMessage('planner', 'sync-1', 'Propongo dividir la migración en dos fases.', 'proposal', { at: T0 + 6000 }),
    messageSent('reviewer', 'Revisé el contrato del evento.', { kind: 'answer' }, { at: T0 + 6500 }),
  ];

  function ReplayScene({ locale }: { locale: string }) {
    const replay = useEventReplay(busyScene);
    return (
      <>
        <AgentOffice events={busyScene} locale={locale} showUsage usage={usage} />
        <ReplayControls replay={replay} locale={locale} />
      </>
    );
  }

  it('renders the empty office without English catalog texts', () => {
    render(<AgentOffice locale="es" />);
    expect(findEnglishLeaks(collectVisibleTexts())).toEqual([]);
  });

  it('renders a busy office with usage and replay controls without English catalog texts', () => {
    render(<ReplayScene locale="es" />);
    // Sanity check: the scene really shows agents, the usage panel and the controls.
    expect(Object.keys(agentLines())).toHaveLength(3);
    expect(document.querySelector('dl.av-usage')).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Controles de repetición' })).toBeTruthy();

    expect(findEnglishLeaks(collectVisibleTexts())).toEqual([]);
  });

  it('detects English texts when the same scene is rendered in English (control)', () => {
    render(<ReplayScene locale="en" />);
    const leaks = findEnglishLeaks(collectVisibleTexts());
    expect(leaks.length).toBeGreaterThan(5);
    expect(leaks.join('\n')).toContain('office.agentsHeading');
  });
});

describe('AgentOffice: host texts', () => {
  it('lets `messages` override a single key and keeps the rest of the catalog', () => {
    render(<AgentOffice locale="es" messages={{ 'office.empty': 'Todavía no hay agentes conectados' }} />);

    expect(screen.getByText('Todavía no hay agentes conectados')).toBeTruthy();
    expect(screen.queryByText('Esperando actividad de los agentes')).toBeNull();
    expect(screen.getByRole('region', { name: 'Oficina de agentes' })).toBeTruthy();
    expect(listHeading()).toBe('Agentes en la oficina');
  });

  it('applies a status override from `messages` only to that status', () => {
    render(<AgentOffice events={spanishTeam} locale="es" messages={{ 'status.THINKING': 'Meditando' }} />);
    expect(agentLines().planner).toBe('Ana Rivas, Planificadora: Meditando');
    expect(agentLines().builder).toBe('Bruno Díaz, Ingeniero: Programando');
  });

  it('prefers the host translate function `t` over `messages` when it returns a value', () => {
    const t: HostTranslate = (key) => (key === 'status.THINKING' ? 'Reflexionando' : undefined);
    render(<AgentOffice events={spanishTeam} locale="es" messages={{ 'status.THINKING': 'Meditando' }} t={t} />);

    expect(agentLines().planner).toBe('Ana Rivas, Planificadora: Reflexionando');
    expect(agentLines().builder).toBe('Bruno Díaz, Ingeniero: Programando');
  });

  it('passes the placeholders to `t`', () => {
    const t: HostTranslate = (key, params) =>
      key === 'office.agentLine' ? `${params?.name} (${params?.role}) · ${params?.status}` : undefined;
    render(<AgentOffice events={spanishTeam} locale="es" t={t} />);
    expect(agentLines().planner).toBe('Ana Rivas (Planificadora) · Pensando');
  });

  it.each([
    ['the key itself', ((key: string) => key) as HostTranslate],
    ['undefined', (() => undefined) as HostTranslate],
    ['null', (() => null) as HostTranslate],
    ['an empty string', (() => '') as HostTranslate],
  ])('falls back to the catalog when `t` returns %s', (_label, t) => {
    render(<AgentOffice events={spanishTeam} locale="es" t={t} />);
    expect(agentLines().planner).toBe('Ana Rivas, Planificadora: Pensando');
    expect(listHeading()).toBe('Agentes en la oficina');
  });
});

describe('AgentOffice: usage privacy', () => {
  const usage: OfficeUsage = {
    total: { totalTokens: 48210, inputTokens: 40000, outputTokens: 8210, cost: 12.5, currency: 'USD' },
    byAgent: { planner: { totalTokens: 1000, cost: 2.25, currency: 'USD' } },
  };

  function expectNoUsageAnywhere() {
    const html = document.body.innerHTML;
    const text = document.body.textContent ?? '';
    expect(document.querySelector('.av-usage')).toBeNull();
    for (const fragment of ['$', '12.5', '12,5', '2.25', '2,25', '48,210', '48210', '48.210']) {
      expect(html).not.toContain(fragment);
    }
    for (const label of ['Tokens', 'Cost', 'Costo', 'Usage', 'Consumo']) {
      expect(text).not.toContain(label);
    }
  }

  it('hides the usage figures when showUsage is omitted', () => {
    render(<AgentOffice events={englishTeam} usage={usage} />);
    expectNoUsageAnywhere();
    expect(agentLines().planner).toBe('Ana Rivas, Planner: Thinking');
  });

  it('hides the usage figures when showUsage is false', () => {
    render(<AgentOffice events={englishTeam} usage={usage} showUsage={false} />);
    expectNoUsageAnywhere();
  });

  it('shows the host figures, formatted for the locale, when showUsage is true', () => {
    render(<AgentOffice events={englishTeam} usage={usage} showUsage />);

    const panel = screen.getByLabelText('Usage');
    expect(panel.tagName).toBe('DL');
    const rows = Array.from(panel.querySelectorAll('dt')).map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ]);
    expect(rows).toEqual([
      ['Tokens', '48,210'],
      ['Input tokens', '40,000'],
      ['Output tokens', '8,210'],
      ['Cost', '$12.50'],
    ]);
    // The per-agent figures reach the screen reader line of that agent only.
    expect(agentLines().planner).toBe('Ana Rivas, Planner: Thinking. Tokens: 1,000, Cost: $2.25');
    expect(agentLines().builder).toBe('Bruno Díaz, Engineer: Coding');
  });

  it('formats the cost with Intl in the requested locale', () => {
    render(<AgentOffice events={spanishTeam} usage={usage} showUsage locale="es" />);

    const panel = screen.getByLabelText('Consumo');
    const cost = Array.from(panel.querySelectorAll('dt')).find((term) => term.textContent === 'Costo');
    const expected = new Intl.NumberFormat('es', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(12.5);
    expect(cost?.nextElementSibling?.textContent).toBe(expected);
    expect(expected).toContain('12,50');
    expect(panel.textContent).not.toContain('12.5');
  });

  it.each([
    ['en', 'Cost', 'unknown'],
    ['es', 'Costo', 'desconocido'],
  ])('shows a missing cost as unknown, never as zero (%s)', (locale, costLabel, unknown) => {
    render(
      <AgentOffice
        events={englishTeam}
        locale={locale}
        showUsage
        usage={{ total: { totalTokens: 3400, cost: null, currency: 'USD' } }}
      />,
    );
    const panel = document.querySelector('dl.av-usage');
    expect(panel).not.toBeNull();
    const cost = Array.from(panel!.querySelectorAll('dt')).find((term) => term.textContent === costLabel);
    expect(cost?.nextElementSibling?.textContent).toBe(unknown);
    expect(panel!.textContent).not.toMatch(/\$|US\$|\b0([.,]0+)?\b/);
  });

  it('shows an omitted cost as unknown too', () => {
    render(<AgentOffice events={englishTeam} showUsage usage={{ total: { totalTokens: 3400 } }} />);
    const values = Array.from(document.querySelectorAll('dl.av-usage dd')).map((value) => value.textContent);
    expect(values).toEqual(['3,400', 'unknown']);
  });

  it('never adds up llm.usage events itself', () => {
    const events: OfficeEventInput[] = [
      ...englishTeam,
      llmUsage('planner', { provider: 'OpenAI', model: 'gpt-x', inputTokens: 1200, outputTokens: 300, cost: 0.75, currency: 'USD' }, { at: T0 + 4000 }),
      llmUsage('builder', { provider: 'Anthropic', model: 'claude-x', inputTokens: 900, outputTokens: 600, cost: 1.25, currency: 'USD' }, { at: T0 + 5000 }),
    ];
    render(<AgentOffice events={events} showUsage />);

    expect(document.querySelector('.av-usage')).toBeNull();
    const html = document.body.innerHTML;
    for (const fragment of ['$', '0.75', '1.25', '2.00', '3,000', '3000', '1,500']) {
      expect(html).not.toContain(fragment);
    }
    expect(document.body.textContent).not.toMatch(/Tokens|Cost/);
    expect(agentLines().planner).toBe('Ana Rivas, Planner: Thinking');
  });

  it('never adds up llm.failed events or changes the status they report', () => {
    const events: OfficeEventInput[] = [
      ...englishTeam,
      llmFailed('planner', {
        provider: 'OpenAI',
        model: 'gpt-x',
        errorKind: 'timeout',
        httpStatus: 504,
        inputTokens: 1200,
        outputTokens: 300,
        cost: 0.75,
        costSource: 'provider-reported',
        currency: 'USD',
      }, { at: T0 + 4000 }),
      llmFailed('builder', {
        provider: 'Anthropic',
        model: 'claude-x',
        errorKind: 'rate_limited',
        httpStatus: 429,
        inputTokens: 900,
        outputTokens: 600,
        cost: 1.25,
        currency: 'USD',
      }, { at: T0 + 5000 }),
    ];
    render(<AgentOffice events={events} showUsage />);
    const lines = agentLines();

    expect(document.querySelector('.av-usage')).toBeNull();
    const html = document.body.innerHTML;
    for (const fragment of ['$', '0.75', '1.25', '2.00', '3,000', '3000', '1,500', '1200', '1,200']) {
      expect(html).not.toContain(fragment);
    }
    expect(document.body.textContent).not.toMatch(/Tokens|Cost|Error/);
    expect(lines).toEqual({
      planner: 'Ana Rivas, Planner: Thinking',
      builder: 'Bruno Díaz, Engineer: Coding',
      reviewer: 'Carla Méndez: Idle',
    });
  });
});

describe('AgentOffice: usage badges', () => {
  const byAgentUsage: OfficeUsage = {
    byAgent: { planner: { totalTokens: 1_000, cost: 2.25, currency: 'USD' } },
  };

  it('puts no usage figure in the DOM when showUsageBadges is omitted, even with usage.byAgent set', () => {
    render(<AgentOffice events={englishTeam} usage={byAgentUsage} />);
    expect(document.querySelector('.av-usage')).toBeNull();
    expect(agentLines().planner).toBe('Ana Rivas, Planner: Thinking');
  });

  it('puts no usage figure in the DOM when showUsageBadges is false', () => {
    render(<AgentOffice events={englishTeam} usage={byAgentUsage} showUsageBadges={false} />);
    expect(agentLines().planner).toBe('Ana Rivas, Planner: Thinking');
  });

  it('feeds the accessible agent list from showUsageBadges alone, without showing the total panel', () => {
    render(<AgentOffice events={englishTeam} usage={byAgentUsage} showUsageBadges />);
    expect(document.querySelector('.av-usage')).toBeNull(); // total panel needs showUsage, not showUsageBadges
    expect(agentLines().planner).toBe('Ana Rivas, Planner: Thinking. Tokens: 1,000, Cost: $2.25');
    // Builder has no byAgent entry: no usage text is added for it.
    expect(agentLines().builder).toBe('Bruno Díaz, Engineer: Coding');
  });

  it('shows the same figures whether showUsage or showUsageBadges turned them on', () => {
    const { unmount } = render(<AgentOffice events={englishTeam} usage={byAgentUsage} showUsage />);
    const withShowUsage = agentLines().planner;
    unmount();
    render(<AgentOffice events={englishTeam} usage={byAgentUsage} showUsageBadges />);
    expect(agentLines().planner).toBe(withShowUsage);
  });

  it('never adds up llm.usage or llm.failed events itself when showUsageBadges is on', () => {
    const events: OfficeEventInput[] = [
      ...englishTeam,
      llmUsage('planner', { provider: 'OpenAI', model: 'gpt-x', inputTokens: 1200, outputTokens: 300, cost: 0.75, currency: 'USD' }, { at: T0 + 4000 }),
      llmFailed('builder', { provider: 'Anthropic', model: 'claude-x', errorKind: 'timeout', inputTokens: 900, outputTokens: 600, cost: 1.25, currency: 'USD' }, { at: T0 + 5000 }),
    ];
    render(<AgentOffice events={events} showUsageBadges usage={byAgentUsage} />);
    const html = document.body.innerHTML;
    for (const fragment of ['0.75', '1.25', '2.00', '1,500', '2,100']) {
      expect(html).not.toContain(fragment);
    }
  });
});

describe('AgentOffice: independent instances', () => {
  it('keeps two offices on the same page apart', () => {
    const north: OfficeEventInput[] = [
      registered('n-1', 'Elena Soto', { roleTitle: 'Analyst' }, { at: T0 }),
      registered('n-2', 'Fabio Ruiz', { roleTitle: 'Writer' }, { at: T0 + 100 }),
      statusChanged('n-1', 'RESEARCHING', { at: T0 + 200 }),
    ];
    const south: OfficeEventInput[] = [
      registered('s-1', 'Gina Lara', { roleTitle: 'Tester' }, { at: T0 }),
      statusChanged('s-1', 'TESTING', { at: T0 + 300 }),
    ];

    const { rerender } = render(
      <>
        <AgentOffice ariaLabel="North team" events={north} />
        <AgentOffice ariaLabel="South team" events={south} />
      </>,
    );

    const northOffice = screen.getByRole('region', { name: 'North team' });
    const southOffice = screen.getByRole('region', { name: 'South team' });
    expect(agentLines(northOffice)).toEqual({
      'n-1': 'Elena Soto, Analyst: Researching',
      'n-2': 'Fabio Ruiz, Writer: Idle',
    });
    expect(agentLines(southOffice)).toEqual({ 's-1': 'Gina Lara, Tester: Testing' });

    // Each list is labelled by its own heading.
    const northLabel = agentList(northOffice).getAttribute('aria-labelledby');
    const southLabel = agentList(southOffice).getAttribute('aria-labelledby');
    expect(northLabel).toBeTruthy();
    expect(northLabel).not.toBe(southLabel);

    // New events for one office do not reach the other.
    rerender(
      <>
        <AgentOffice ariaLabel="North team" events={north} />
        <AgentOffice
          ariaLabel="South team"
          events={[...south, registered('n-1', 'Elena Soto (copy)', {}, { at: T0 + 400 })]}
        />
      </>,
    );
    expect(agentLines(screen.getByRole('region', { name: 'North team' }))).toEqual({
      'n-1': 'Elena Soto, Analyst: Researching',
      'n-2': 'Fabio Ruiz, Writer: Idle',
    });
    expect(within(screen.getByRole('region', { name: 'South team' })).getByText('Elena Soto (copy): Idle')).toBeTruthy();
  });
});

describe('AgentOffice: theme tokens', () => {
  it('declares the theme once on the office root so host overrides reach the toolbar', () => {
    const { container } = render(<AgentOffice theme="light" />);
    const root = container.querySelector('.av-office');
    const canvasRoot = container.querySelector('.av-canvas-root');
    expect(root?.classList.contains('av-theme-light')).toBe(true);
    expect(canvasRoot).not.toBeNull();
    expect(canvasRoot?.className).not.toMatch(/av-theme-/);
  });
});

describe('AgentOffice: keyboard selection', () => {
  const events: OfficeEventInput[] = [
    registered('ana', 'Ana Rivas', { roleTitle: 'Planner', workspace: 'leads_area' }, { at: T0 }),
    registered('bruno', 'Bruno Díaz', { roleTitle: 'Engineer', workspace: 'development' }, { at: T0 + 10 }),
  ];

  it('offers one focusable button per agent with a Spanish name', () => {
    render(<AgentOffice events={events} locale="es" />);
    const buttons = screen.getAllByRole('button', { name: /Ana Rivas|Bruno Díaz/ });
    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('selects an agent and reports it, and a second press clears the selection', () => {
    const selections: Array<string | null> = [];
    render(<AgentOffice events={events} onSelectAgent={(id) => selections.push(id)} />);
    fireEvent.click(screen.getByRole('button', { name: /Ana Rivas/ }));
    expect(selections).toEqual(['ana']);
    expect(screen.getByRole('button', { name: /Ana Rivas/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Ana Rivas/ }));
    expect(selections).toEqual(['ana', null]);
  });

  it('follows a controlled selection', () => {
    render(<AgentOffice events={events} selectedAgentId="bruno" />);
    expect(screen.getByRole('button', { name: /Bruno Díaz/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Ana Rivas/ }).getAttribute('aria-pressed')).toBe('false');
  });
});
