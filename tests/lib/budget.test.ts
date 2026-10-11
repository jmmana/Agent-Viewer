import { describe, expect, it } from 'vitest';
import {
  BUDGET_STATES,
  MAX_BUDGET_LABEL_LENGTH,
  createOfficeTranslator,
  formatBudgetState,
  normalizeBudgetState,
  type AgentBudgetState,
} from '../../src/lib/index';
import { BUDGET_COLORS } from '../../src/engine/canvasRenderer';

const english = createOfficeTranslator({ locale: 'en' });
const spanish = createOfficeTranslator({ locale: 'es' });

describe('normalizeBudgetState', () => {
  it.each(BUDGET_STATES)('keeps a valid state as is (%s)', (state) => {
    expect(normalizeBudgetState({ state })).toEqual({ state });
  });

  it.each(['danger', 'over_budget', '', 'OK', 'Warning'])('reads an unrecognized state string as unknown (%s)', (state) => {
    expect(normalizeBudgetState({ state })).toEqual({ state: 'unknown' });
  });

  it.each([null, undefined, 42, 'warning', true, ['warning']])('reads a non-object entry as unknown, never ok (%p)', (input) => {
    expect(normalizeBudgetState(input)).toEqual({ state: 'unknown' });
  });

  it('reads a missing state as unknown', () => {
    expect(normalizeBudgetState({ label: 'No state here' })).toEqual({ state: 'unknown' });
    expect(normalizeBudgetState({})).toEqual({ state: 'unknown' });
  });

  it('drops extra runtime fields such as limit and spent', () => {
    const result = normalizeBudgetState({ state: 'exceeded', limit: 100, spent: 140, percent: 140, currency: 'USD', threshold: 0.8 });
    expect(result).toEqual({ state: 'exceeded' });
    expect(result).not.toHaveProperty('limit');
    expect(result).not.toHaveProperty('spent');
    expect(result).not.toHaveProperty('percent');
    expect(result).not.toHaveProperty('currency');
    expect(result).not.toHaveProperty('threshold');
  });

  it('trims a label and drops a non-string one', () => {
    expect(normalizeBudgetState({ state: 'warning', label: '  Daily budget at 82%  ' })).toEqual({
      state: 'warning',
      label: 'Daily budget at 82%',
    });
    expect(normalizeBudgetState({ state: 'warning', label: 82 })).toEqual({ state: 'warning' });
    expect(normalizeBudgetState({ state: 'warning', label: null })).toEqual({ state: 'warning' });
    expect(normalizeBudgetState({ state: 'warning', label: { toString: () => 'x' } })).toEqual({ state: 'warning' });
  });

  it('removes control characters from the label, including newlines and tabs', () => {
    const result = normalizeBudgetState({ state: 'warning', label: 'Line one\nLine\ttwo\u0000end' });
    expect(result.label).toBe('Line oneLinetwoend');
  });

  it('drops a label that is empty or only whitespace, even after trimming', () => {
    expect(normalizeBudgetState({ state: 'warning', label: '' })).toEqual({ state: 'warning' });
    expect(normalizeBudgetState({ state: 'warning', label: '   ' })).toEqual({ state: 'warning' });
    expect(normalizeBudgetState({ state: 'warning', label: '\n\t' })).toEqual({ state: 'warning' });
  });

  it(`cuts a label to ${MAX_BUDGET_LABEL_LENGTH} code points`, () => {
    const longLabel = 'a'.repeat(120);
    const result = normalizeBudgetState({ state: 'warning', label: longLabel });
    expect(result.label).toHaveLength(MAX_BUDGET_LABEL_LENGTH);
    expect(result.label).toBe('a'.repeat(MAX_BUDGET_LABEL_LENGTH));
  });

  it('cuts at the 80-code-point boundary without splitting a surrogate pair', () => {
    // A label of 79 plain characters plus one astral emoji (a surrogate pair, 2 UTF-16 code units, 1 code point).
    const label = `${'a'.repeat(79)}\u{1F600}`; // 80 code points total
    const result = normalizeBudgetState({ state: 'warning', label });
    expect(Array.from(result.label ?? '')).toHaveLength(80);
    expect(result.label).toBe(label);

    // One more character pushes the emoji out: the cut must drop the whole code point, not half of it.
    const overLabel = `${'a'.repeat(80)}\u{1F600}`;
    const overResult = normalizeBudgetState({ state: 'warning', label: overLabel });
    expect(Array.from(overResult.label ?? '')).toHaveLength(80);
    expect(overResult.label).toBe('a'.repeat(80));
    // No lone surrogate leaked through.
    expect(overResult.label).not.toMatch(/[\uD800-\uDFFF]/);
  });
});

describe('formatBudgetState', () => {
  const ok: AgentBudgetState = { state: 'ok' };
  const warningWithLabel: AgentBudgetState = { state: 'warning', label: 'Daily budget at 82%' };
  const exceeded: AgentBudgetState = { state: 'exceeded' };

  it('formats the state alone, in English and Spanish', () => {
    expect(formatBudgetState(ok, english)).toBe('Within budget');
    expect(formatBudgetState(ok, spanish)).toBe('Dentro del presupuesto');
    expect(formatBudgetState(exceeded, english)).toBe('Budget exceeded');
    expect(formatBudgetState(exceeded, spanish)).toBe('Presupuesto excedido');
  });

  it('appends the host label verbatim when present, in both locales', () => {
    expect(formatBudgetState(warningWithLabel, english)).toBe('Budget warning (Daily budget at 82%)');
    expect(formatBudgetState(warningWithLabel, spanish)).toBe('Alerta de presupuesto (Daily budget at 82%)');
  });

  it('never translates the host label', () => {
    const entry: AgentBudgetState = { state: 'warning', label: 'Presupuesto diario al 82%' };
    expect(formatBudgetState(entry, english)).toBe('Budget warning (Presupuesto diario al 82%)');
  });
});

describe('AgentBudgetState type shape (locked by tsc --noEmit, run through `npm run lint`)', () => {
  it('has no numeric field: a host cannot smuggle a limit or spend figure past the type system', () => {
    // @ts-expect-error `limit` is deliberately absent from `AgentBudgetState`: the office is never given a
    // number it could compare against a spend figure, even by a host that controls both sides of this file.
    const invalid: AgentBudgetState = { state: 'warning', limit: 10 };
    expect(invalid).toBeDefined();
  });
});

describe('BUDGET_COLORS contrast (WCAG 1.4.11, at least 3:1 against the marker plate)', () => {
  const srgb = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const luminance = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  };
  const contrast = (a: string, b: string) => {
    const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };

  it.each(['dark', 'light'] as const)('meets 3:1 for warning, exceeded and unknown in the %s theme', (theme) => {
    const { plate, warning, exceeded, unknown } = BUDGET_COLORS[theme];
    expect(contrast(warning, plate)).toBeGreaterThanOrEqual(3);
    expect(contrast(exceeded, plate)).toBeGreaterThanOrEqual(3);
    expect(contrast(unknown, plate)).toBeGreaterThanOrEqual(3);
  });
});
