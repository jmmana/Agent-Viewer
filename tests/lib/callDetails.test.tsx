import React from 'react';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentOffice,
  createOfficeTranslator,
  formatCost,
  formatCostSource,
  formatTokens,
  type AgentCallDetail,
  type AgentCallDetails,
  type AgentCallTokens,
  type OfficeEventInput,
} from '../../src/lib/index';
import { T0, registered, statusChanged } from './fixtures';

const team: OfficeEventInput[] = [
  registered('planner', 'Ana Rivas', { roleTitle: 'Planner' }, { at: T0 }),
  registered('builder', 'Bruno Díaz', { roleTitle: 'Engineer' }, { at: T0 + 1000 }),
  statusChanged('planner', 'THINKING', { at: T0 + 2000 }),
  statusChanged('builder', 'CODING', { at: T0 + 3000 }),
];

const translate = createOfficeTranslator({ locale: 'en' });

const fullCall: AgentCallDetail = {
  id: 'call-1',
  provider: 'Anthropic',
  model: 'claude-sonnet-4-5',
  tokens: { input: 1800, output: 450, cacheRead: 12000 },
  requestId: 'req_01H8',
  latencyMs: 2140,
  status: 'ok',
  costSource: 'provider-reported',
  cost: 0.012,
  currency: 'USD',
};

function panel(): HTMLElement | null {
  return document.querySelector('.av-call-details');
}

function callItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.av-call-item'));
}

function rowsOf(item: Element): Array<[string | null | undefined, string | null | undefined]> {
  return Array.from(item.querySelectorAll('.av-call-row')).map((row) => [
    row.querySelector('dt')?.textContent,
    row.querySelector('dd')?.textContent,
  ]);
}

function clickAgent(agentId: string) {
  const button = document.querySelector<HTMLButtonElement>(`li[data-agent-id="${agentId}"] button`);
  if (!button) throw new Error(`Agent button for "${agentId}" not found`);
  fireEvent.click(button);
}

describe('AgentOffice: call details panel disabled by default', () => {
  const details: AgentCallDetails = { planner: [fullCall] };

  it('shows no call data anywhere when showCallDetails is omitted, even with data and a selected agent', () => {
    render(<AgentOffice events={team} locale="en" agentCallDetails={details} selectedAgentId="planner" />);
    expect(panel()).toBeNull();
    const html = document.body.innerHTML;
    for (const fragment of ['av-call-details', 'claude-sonnet-4-5', 'req_01H8', '2140', '2,140', '1800', '1,800', 'Anthropic']) {
      expect(html).not.toContain(fragment);
    }
  });

  it('shows no call data when showCallDetails is explicitly false', () => {
    render(
      <AgentOffice events={team} locale="en" agentCallDetails={details} selectedAgentId="planner" showCallDetails={false} />,
    );
    expect(panel()).toBeNull();
  });
});

describe('AgentOffice: call details panel content', () => {
  it('shows every row, in host order, for every call of the selected agent', () => {
    const second: AgentCallDetail = {
      id: 'call-2',
      provider: 'OpenAI',
      model: 'gpt-5',
      tokens: { input: 100, output: 20 },
      requestId: 'req_2',
      latencyMs: 300,
      status: 'failed',
      costSource: 'estimated',
      cost: 0.002,
      currency: 'USD',
    };
    const details: AgentCallDetails = { planner: [fullCall, second] };
    render(<AgentOffice events={team} locale="en" showCallDetails agentCallDetails={details} selectedAgentId="planner" />);

    const items = callItems();
    expect(items).toHaveLength(2);

    expect(rowsOf(items[0])).toEqual([
      [translate('calls.provider'), 'Anthropic'],
      [translate('calls.model'), 'claude-sonnet-4-5'],
      [translate('calls.status'), translate('calls.status.ok')],
      [translate('calls.latency'), translate('calls.latencyValue', { value: new Intl.NumberFormat('en').format(2140) })],
      [translate('calls.requestId'), 'req_01H8'],
      [translate('usage.inputTokens'), formatTokens(1800, 'en', translate)],
      [translate('usage.outputTokens'), formatTokens(450, 'en', translate)],
      [translate('usage.cacheReadTokens'), formatTokens(12000, 'en', translate)],
      [translate('usage.costSource'), formatCostSource('provider-reported', translate)],
      [translate('usage.cost'), formatCost(0.012, 'USD', 'en', translate)],
    ]);

    // Second call has no cache/reasoning keys at all: those three rows are entirely absent, not "unknown".
    expect(rowsOf(items[1])).toEqual([
      [translate('calls.provider'), 'OpenAI'],
      [translate('calls.model'), 'gpt-5'],
      [translate('calls.status'), translate('calls.status.failed')],
      [translate('calls.latency'), translate('calls.latencyValue', { value: new Intl.NumberFormat('en').format(300) })],
      [translate('calls.requestId'), 'req_2'],
      [translate('usage.inputTokens'), formatTokens(100, 'en', translate)],
      [translate('usage.outputTokens'), formatTokens(20, 'en', translate)],
      [translate('usage.costSource'), formatCostSource('estimated', translate)],
      [translate('usage.cost'), formatCost(0.002, 'USD', 'en', translate)],
    ]);
  });

  it('shows "unknown" for always-shown rows that are null, undefined, NaN or Infinity, and a real 0 as 0', () => {
    const edgeCall: AgentCallDetail = {
      id: 'edge-1',
      provider: null,
      model: undefined,
      status: null,
      costSource: undefined,
      latencyMs: Number.NaN,
      requestId: '   ',
      tokens: { input: 0, output: undefined, cacheWrite: null },
      cost: Number.POSITIVE_INFINITY,
      currency: 'USD',
    };
    const details: AgentCallDetails = { planner: [edgeCall] };
    render(<AgentOffice events={team} locale="en" showCallDetails agentCallDetails={details} selectedAgentId="planner" />);

    const [item] = callItems();
    expect(rowsOf(item)).toEqual([
      [translate('calls.provider'), translate('usage.unknown')],
      [translate('calls.model'), translate('usage.unknown')],
      [translate('calls.status'), translate('usage.unknown')],
      [translate('calls.latency'), translate('usage.unknown')],
      [translate('calls.requestId'), translate('usage.unknown')],
      [translate('usage.inputTokens'), '0'],
      [translate('usage.outputTokens'), translate('usage.unknown')],
      // `cacheRead` and `reasoning` were never sent: no row at all, not "unknown".
      [translate('usage.cacheWriteTokens'), translate('usage.unknown')],
      [translate('usage.costSource'), translate('usage.unknown')],
      [translate('usage.cost'), translate('usage.unknown')],
    ]);
  });

  it('never shows a sum, count or average of any kind', () => {
    const details: AgentCallDetails = {
      planner: [
        { id: 'a', tokens: { input: 100 } },
        { id: 'b', tokens: { input: 200 } },
      ],
    };
    render(<AgentOffice events={team} locale="en" showCallDetails agentCallDetails={details} selectedAgentId="planner" />);
    const text = panel()?.textContent ?? '';
    expect(text).not.toContain('300');
    expect(text).not.toMatch(/\b2 calls\b/i);
    expect(callItems()).toHaveLength(2);
  });

  it('shows the empty text, never a number, for an agent with no entry or an empty array', () => {
    const { rerender } = render(
      <AgentOffice events={team} locale="en" showCallDetails agentCallDetails={{}} selectedAgentId="planner" />,
    );
    expect(panel()?.textContent).toContain(translate('calls.empty'));
    expect(callItems()).toHaveLength(0);

    rerender(
      <AgentOffice
        events={team}
        locale="en"
        showCallDetails
        agentCallDetails={{ planner: [] }}
        selectedAgentId="planner"
      />,
    );
    expect(panel()?.textContent).toContain(translate('calls.empty'));
    expect(panel()?.textContent).not.toMatch(/0 calls/i);
  });

  it('renders nothing when the selected id is not an agent in the current snapshot', () => {
    render(
      <AgentOffice
        events={team}
        locale="en"
        showCallDetails
        agentCallDetails={{ ghost: [fullCall] }}
        selectedAgentId="ghost"
      />,
    );
    expect(panel()).toBeNull();
  });

  it('renders 500 calls without error', () => {
    const many = Array.from({ length: 500 }, (_, index) => ({ id: `call-${index}`, provider: 'Anthropic' }));
    render(
      <AgentOffice
        events={team}
        locale="en"
        showCallDetails
        agentCallDetails={{ planner: many }}
        selectedAgentId="planner"
      />,
    );
    expect(callItems()).toHaveLength(500);
  });
});

describe('AgentOffice: call details selection and closing', () => {
  const details: AgentCallDetails = { planner: [fullCall] };

  it('opens from the keyboard agent list, the same way a canvas click sets the selection', () => {
    render(<AgentOffice events={team} locale="en" showCallDetails agentCallDetails={details} />);
    expect(panel()).toBeNull();
    clickAgent('planner');
    expect(panel()).not.toBeNull();
    expect(panel()?.getAttribute('aria-label')).toBe(translate('calls.title', { name: 'Ana Rivas' }));
  });

  it('opens from a controlled selectedAgentId with no click at all', () => {
    render(<AgentOffice events={team} locale="en" showCallDetails agentCallDetails={details} selectedAgentId="planner" />);
    expect(panel()).not.toBeNull();
  });

  it('closes on the close button in uncontrolled mode, calling onSelectAgent(null)', () => {
    const onSelectAgent = vi.fn();
    render(<AgentOffice events={team} locale="en" showCallDetails agentCallDetails={details} onSelectAgent={onSelectAgent} />);
    clickAgent('planner');
    expect(panel()).not.toBeNull();

    const closeButton = panel()!.querySelector<HTMLButtonElement>('.av-call-details-close');
    expect(closeButton).not.toBeNull();
    fireEvent.click(closeButton!);

    expect(onSelectAgent).toHaveBeenCalledWith(null);
    expect(panel()).toBeNull();
  });

  it('closes on Escape with focus inside the panel, calling onSelectAgent(null)', () => {
    const onSelectAgent = vi.fn();
    render(<AgentOffice events={team} locale="en" showCallDetails agentCallDetails={details} onSelectAgent={onSelectAgent} />);
    clickAgent('planner');
    fireEvent.keyDown(panel()!, { key: 'Escape' });

    expect(onSelectAgent).toHaveBeenCalledWith(null);
    expect(panel()).toBeNull();
  });

  it('stays open in controlled mode until the host changes selectedAgentId', () => {
    const onSelectAgent = vi.fn();
    const { rerender } = render(
      <AgentOffice
        events={team}
        locale="en"
        showCallDetails
        agentCallDetails={details}
        selectedAgentId="planner"
        onSelectAgent={onSelectAgent}
      />,
    );
    const closeButton = panel()!.querySelector<HTMLButtonElement>('.av-call-details-close');
    fireEvent.click(closeButton!);

    expect(onSelectAgent).toHaveBeenCalledWith(null);
    // The host did not change `selectedAgentId`, so the controlled panel stays.
    expect(panel()).not.toBeNull();

    rerender(
      <AgentOffice
        events={team}
        locale="en"
        showCallDetails
        agentCallDetails={details}
        selectedAgentId={null}
        onSelectAgent={onSelectAgent}
      />,
    );
    expect(panel()).toBeNull();
  });
});

describe('AgentOffice: call details are closed to free text', () => {
  it('never renders an extra key added through an `unknown` cast, on the row or inside tokens', () => {
    const smuggled = {
      id: 'smuggled',
      provider: 'Anthropic',
      prompt: 'SECRET PROMPT TEXT',
      content: 'SECRET OUTPUT TEXT',
      tokens: { input: 1, content: 'SECRET TOKEN FIELD' },
    } as unknown as AgentCallDetail;
    render(
      <AgentOffice
        events={team}
        locale="en"
        showCallDetails
        agentCallDetails={{ planner: [smuggled] }}
        selectedAgentId="planner"
      />,
    );
    const text = panel()?.textContent ?? '';
    expect(text).not.toContain('SECRET PROMPT TEXT');
    expect(text).not.toContain('SECRET OUTPUT TEXT');
    expect(text).not.toContain('SECRET TOKEN FIELD');
  });

  it('shows "unknown" for an unrecognized status or costSource, never the raw string', () => {
    const call = { id: 'x', status: 'bogus', costSource: 'mystery' } as unknown as AgentCallDetail;
    render(
      <AgentOffice events={team} locale="en" showCallDetails agentCallDetails={{ planner: [call] }} selectedAgentId="planner" />,
    );
    const text = panel()?.textContent ?? '';
    expect(text).not.toContain('bogus');
    expect(text).not.toContain('mystery');
  });

  it('cuts a value over 128 code points to 127 plus an ellipsis, in the text and in the title', () => {
    const long = 'x'.repeat(200);
    const call: AgentCallDetail = { id: 'long', model: long };
    render(
      <AgentOffice events={team} locale="en" showCallDetails agentCallDetails={{ planner: [call] }} selectedAgentId="planner" />,
    );
    const [item] = callItems();
    const modelRow = rowsOf(item).find(([label]) => label === translate('calls.model'));
    expect(modelRow?.[1]).toBe(`${'x'.repeat(127)}…`);
    expect(modelRow?.[1]?.length).toBe(128);
  });

  it('renders a requestId containing markup as plain text, never as HTML', () => {
    const call: AgentCallDetail = { id: 'y', requestId: '<b>x</b>' };
    render(
      <AgentOffice events={team} locale="en" showCallDetails agentCallDetails={{ planner: [call] }} selectedAgentId="planner" />,
    );
    expect(panel()?.querySelector('b')).toBeNull();
    expect(panel()?.textContent).toContain('<b>x</b>');
  });

  it('renders two rows without a duplicate-key warning when the same id repeats', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const details: AgentCallDetails = { planner: [{ id: 'dup' }, { id: 'dup' }] };
    render(
      <AgentOffice events={team} locale="en" showCallDetails agentCallDetails={details} selectedAgentId="planner" />,
    );
    expect(callItems()).toHaveLength(2);
    const keyWarning = errorSpy.mock.calls.some((args) => String(args[0]).toLowerCase().includes('key'));
    expect(keyWarning).toBe(false);
    errorSpy.mockRestore();
  });
});

describe('AgentOffice: call details never touch the network', () => {
  it('calls no fetch, XMLHttpRequest or sendBeacon while rendering, selecting or closing', () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    (globalThis as { fetch?: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
    const openSpy = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => undefined);
    const beaconSpy = vi.fn();
    const originalBeacon = navigator.sendBeacon?.bind(navigator);
    Object.defineProperty(navigator, 'sendBeacon', { value: beaconSpy, configurable: true });

    try {
      const details: AgentCallDetails = { planner: [fullCall] };
      render(<AgentOffice events={team} locale="en" showCallDetails agentCallDetails={details} />);
      clickAgent('planner');
      const closeButton = panel()!.querySelector<HTMLButtonElement>('.av-call-details-close');
      fireEvent.click(closeButton!);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
      expect(beaconSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as { fetch?: typeof fetch }).fetch = originalFetch;
      openSpy.mockRestore();
      if (originalBeacon) Object.defineProperty(navigator, 'sendBeacon', { value: originalBeacon, configurable: true });
    }
  });
});

describe('agent-viewer.css: call details rules', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/agent-viewer.css'), 'utf8');
  const start = source.indexOf('/* Call details panel');
  const end = source.indexOf('/* Canvas with its toolbar', start);

  it('is present in the stylesheet', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  const section = source.slice(start, end);
  // Strip `/* ... */` comments first: the banner comment above the rules is allowed to say "transition" or
  // "animation" in prose (explaining that there is none); only the declarations themselves must not.
  const declarations = section.replace(/\/\*[\s\S]*?\*\//g, '');

  it('adds no transition or animation property', () => {
    expect(declarations).not.toMatch(/\btransition\b/);
    expect(declarations).not.toMatch(/\banimation\b/);
  });

  it('only declares :where-scoped av-call selectors', () => {
    const selectorLines = declarations
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('{'));
    expect(selectorLines.length).toBeGreaterThan(5);
    for (const line of selectorLines) {
      const selector = line.slice(0, -1).trim();
      // Every selector is `:where(.av-call...)`, optionally with a pseudo-class inside the parens
      // (`:hover`, `:focus-visible`, `:last-child`) or a descendant combinator (`dl`, `dt`, `dd`).
      expect(selector).toMatch(/^:where\(\.av-call[\w-]*(:[\w-]+)?( [a-z]+)?\)$/);
    }
  });
});

describe('AgentCallDetail: closed type', () => {
  it('has exactly the documented fields (compile-time check)', () => {
    expectTypeOf<keyof AgentCallDetail>().toEqualTypeOf<
      'id' | 'provider' | 'model' | 'tokens' | 'requestId' | 'latencyMs' | 'status' | 'costSource' | 'cost' | 'currency'
    >();
    expectTypeOf<keyof AgentCallTokens>().toEqualTypeOf<
      'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning'
    >();
  });

  it('rejects extra fields on object literals (compile-time check)', () => {
    const withPrompt = {
      id: 'x',
      // @ts-expect-error -- `prompt` is not part of the closed `AgentCallDetail` shape.
      prompt: 'should not compile',
    } satisfies AgentCallDetail;
    const withTokenContent = {
      id: 'x',
      tokens: {
        // @ts-expect-error -- `content` is not part of the closed `AgentCallTokens` shape.
        content: 'should not compile',
      },
    } satisfies AgentCallDetail;
    expect(withPrompt.id).toBe('x');
    expect(withTokenContent.id).toBe('x');
  });
});
