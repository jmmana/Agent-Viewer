/**
 * `SimulatorTab` (issue #79): the permanent banner, a catalog-only model list, `calculateModelCost` returning
 * `null` for an unknown model, and that firing a burst is a pure callback, never a `fetch` call (isolation is
 * verified at the `ModelOpsModal`/`App` wiring level: the simulator only ever calls `onFire`).
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SimulatorTab } from '../../src/components/modelOps/SimulatorTab';
import { calculateModelCost, MODEL_CATALOG } from '../../src/engine/modelOps';

function renderTab(overrides: Partial<React.ComponentProps<typeof SimulatorTab>> = {}) {
  const props: React.ComponentProps<typeof SimulatorTab> = {
    locale: 'en',
    selectedModel: Object.keys(MODEL_CATALOG)[0],
    onSelectedModelChange: vi.fn(),
    selectedPreset: 'custom',
    onApplyPreset: vi.fn(),
    inputTokens: 1000,
    onInputTokensChange: vi.fn(),
    outputTokens: 200,
    onOutputTokensChange: vi.fn(),
    cacheHitRatio: 0.2,
    onFire: vi.fn(),
    ...overrides,
  };
  return { ...render(<SimulatorTab {...props} />), props };
}

describe('SimulatorTab', () => {
  it('shows the permanent simulation banner unconditionally', () => {
    renderTab();
    expect(screen.getByText(/These calls are not sent to any model/)).toBeTruthy();
  });

  it('offers only demo-catalog models, by id', () => {
    renderTab();
    const select = screen.getByLabelText('Target LLM model:') as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).toEqual(Object.keys(MODEL_CATALOG));
  });

  it('fires with the current model, provider and preset through onFire, never a network call', () => {
    const onFire = vi.fn();
    renderTab({ onFire, selectedModel: 'gpt-4o' });
    fireEvent.click(screen.getByRole('button', { name: /Fire live inference/ }));
    expect(onFire).toHaveBeenCalledWith('gpt-4o', 'OpenAI', 'custom');
  });

  it('calculateModelCost returns null for a model the demo catalog does not know', () => {
    expect(calculateModelCost('some-unknown-model', 1000, 200)).toBeNull();
  });
});
