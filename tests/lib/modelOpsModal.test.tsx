import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ModelOpsModal } from '../../src/components/ModelOpsModal';
import { INITIAL_AGENTS } from '../../src/engine/officeModel';
import type { SimulatedCall } from '../../src/engine/modelOps';
import type { Agent } from '../../src/types/agent';

// `claude-3-7-sonnet` (the tech lead in INITIAL_AGENTS) is not in MODEL_CATALOG: a real demo agent whose
// model the catalog does not know, exactly the "unknown model" scenario this issue fixes.
const UNKNOWN_MODEL = 'claude-3-7-sonnet';

function baseProps(overrides: Partial<React.ComponentProps<typeof ModelOpsModal>> = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    agents: INITIAL_AGENTS,
    onFocusAgent: vi.fn(),
    onSimulateCall: vi.fn(),
    simulatedCalls: [] as SimulatedCall[],
    onChangeAgentModel: vi.fn(),
    locale: 'en' as const,
    isLiveMode: false,
    ...overrides,
  };
}

function openTab(name: RegExp) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

describe('ModelOpsModal', () => {
  it('the fixture includes an agent on a model the demo catalog does not know', () => {
    expect(INITIAL_AGENTS.some((a) => a.model === UNKNOWN_MODEL)).toBe(true);
  });

  it('renders with no fabricated seed content from the old hard-coded feed rows', () => {
    render(<ModelOpsModal {...baseProps()} />);
    // Marks unique to the removed seed rows: the invented endpoint and status badges.
    expect(screen.queryByText(/POST \/v1\/chat\/completions/)).toBeNull();
    expect(screen.queryByText('CACHED')).toBeNull();
    expect(screen.queryByText('200 OK')).toBeNull();
  });

  it('shows the raw model id and "not in the demo catalog" for an uncatalogued model, never GPT-4o', () => {
    render(<ModelOpsModal {...baseProps()} />);
    const row = screen.getByText(UNKNOWN_MODEL).closest('.space-y-3') as HTMLElement;
    expect(row).toBeTruthy();
    expect(within(row).getByText('Not in the demo catalog')).toBeTruthy();
    // This exact row never borrows GPT-4o's catalog name, even though other, real gpt-4o rows do show it.
    expect(within(row).queryByText('GPT-4o (Omni)')).toBeNull();
  });

  it('shows "Unknown" instead of a borrowed per-1M price for the uncatalogued model row', () => {
    render(<ModelOpsModal {...baseProps()} />);
    const row = screen.getByText(UNKNOWN_MODEL).closest('.space-y-3') as HTMLElement;
    // Input, output and cache rate cells for the uncatalogued row all fall back to "Unknown", never a price.
    expect(within(row).getAllByText('Unknown').length).toBeGreaterThanOrEqual(3);
  });

  it('the simulator shows "Rate: unknown" for an uncatalogued model and records a null-cost call when fired', () => {
    const onSimulateCall = vi.fn();
    render(<ModelOpsModal {...baseProps({ onSimulateCall })} />);
    openTab(/LLM traffic simulator/);

    fireEvent.change(screen.getByLabelText('Target LLM model:'), { target: { value: UNKNOWN_MODEL } });
    expect(screen.getByText('Rate: unknown')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Fire live inference/ }));
    expect(onSimulateCall).toHaveBeenCalledTimes(1);
    const call = onSimulateCall.mock.calls[0][0] as SimulatedCall;
    expect(call.simulated).toBe(true);
    expect(call.estimatedCost).toBeNull();
    expect(call.currency).toBeNull();
    expect(call.model).toBe(UNKNOWN_MODEL);
  });

  it('the simulator fire button records a call with simulated: true and a numeric estimate for a known model', () => {
    const onSimulateCall = vi.fn();
    render(<ModelOpsModal {...baseProps({ onSimulateCall })} />);
    openTab(/LLM traffic simulator/);
    fireEvent.click(screen.getByRole('button', { name: /Fire live inference/ }));
    expect(onSimulateCall).toHaveBeenCalledTimes(1);
    const call = onSimulateCall.mock.calls[0][0] as SimulatedCall;
    expect(call.simulated).toBe(true);
    expect(typeof call.estimatedCost).toBe('number');
  });

  it('firing a simulated call never mutates the agents it was given and never reassigns a model', () => {
    const onSimulateCall = vi.fn();
    const onChangeAgentModel = vi.fn();
    const agentsSnapshotBefore = JSON.parse(JSON.stringify(INITIAL_AGENTS)) as Agent[];
    render(<ModelOpsModal {...baseProps({ onSimulateCall, onChangeAgentModel })} />);
    openTab(/LLM traffic simulator/);
    fireEvent.click(screen.getByRole('button', { name: /Fire live inference/ }));

    expect(INITIAL_AGENTS).toEqual(agentsSnapshotBefore);
    expect(onChangeAgentModel).not.toHaveBeenCalled();
  });

  it('the Feed tab shows the empty hint with no simulated calls, and the SIMULATED badge once one exists', () => {
    const { rerender } = render(<ModelOpsModal {...baseProps()} />);
    openTab(/Inference feed/);
    expect(screen.getByText(/Run the simulator to see example calls here/)).toBeTruthy();
    expect(screen.queryByText('SIMULATED')).toBeNull();

    const call: SimulatedCall = {
      id: 'sim-1',
      simulated: true,
      timestamp: Date.now(),
      provider: 'OpenAI',
      model: 'gpt-4o',
      agentId: null,
      preset: 'custom',
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 0,
      estimatedCost: 0.001,
      currency: 'USD',
      latencyMs: 500,
    };
    rerender(<ModelOpsModal {...baseProps({ simulatedCalls: [call] })} />);
    expect(screen.getAllByText('SIMULATED').length).toBeGreaterThan(0);
  });

  it('in live mode, hides the four invented-usage trigger buttons but keeps the simulator working', () => {
    render(<ModelOpsModal {...baseProps({ isLiveMode: true })} />);
    expect(screen.queryByText('Inject quick request (+1.9K t)')).toBeNull();
    expect(screen.queryByText('Simulate inference')).toBeNull();
    expect(screen.queryByText('Quick request')).toBeNull();

    openTab(/Inference feed/);
    expect(screen.queryByText('Send request')).toBeNull();

    openTab(/LLM traffic simulator/);
    expect(screen.getByText(/Simulation\. These calls are not sent to any model/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Fire live inference/ })).toBeTruthy();
  });

  it('in live mode, the Agents tab model select is disabled; in demo mode it stays enabled', () => {
    const { rerender } = render(<ModelOpsModal {...baseProps({ isLiveMode: true })} />);
    openTab(/Agent assignment/);
    for (const select of screen.getAllByRole('combobox')) {
      expect((select as HTMLSelectElement).disabled).toBe(true);
    }

    rerender(<ModelOpsModal {...baseProps({ isLiveMode: false })} />);
    for (const select of screen.getAllByRole('combobox')) {
      expect((select as HTMLSelectElement).disabled).toBe(false);
    }
  });

  it('shows the active-nodes chip as the real provider count, not a hard-coded 4', () => {
    render(<ModelOpsModal {...baseProps()} />);
    const providerCount = new Set(INITIAL_AGENTS.map((a) => a.provider)).size;
    expect(screen.getByText(`${providerCount} active nodes`)).toBeTruthy();
  });
});
