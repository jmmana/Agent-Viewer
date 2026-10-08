import { describe, expect, it } from 'vitest';
import {
  createOfficeTranslator,
  formatCost,
  formatTokens,
  formatUsage,
  summarizeUsage,
  type CanonicalEventInput,
} from '../../src/lib/index';
import { T0, llmUsage, makeEvent, registered } from './fixtures';

const en = createOfficeTranslator({ locale: 'en' });
const es = createOfficeTranslator({ locale: 'es' });

describe('summarizeUsage', () => {
  it('adds up the reported tokens and costs per run and per agent', () => {
    const usage = summarizeUsage([
      registered('ana', 'Ana Rivas', {}, { at: T0 }),
      llmUsage('ana', { inputTokens: 1200, outputTokens: 300, cost: 0.0125, currency: 'USD' }, { at: T0 + 1 }),
      llmUsage('bruno', { inputTokens: 800, outputTokens: 200, cost: 0.0075, currency: 'USD' }, { at: T0 + 2 }),
      llmUsage('ana', { inputTokens: 100, outputTokens: 50, cost: 0.001, currency: 'USD' }, { at: T0 + 3 }),
      makeEvent('tool.completed', 'ana', { outputSummary: 'done' }, { at: T0 + 4 }),
    ]);

    expect(usage.total).toMatchObject({ inputTokens: 2100, outputTokens: 550, totalTokens: 2650, currency: 'USD' });
    expect(usage.total?.cost).toBeCloseTo(0.021, 10);
    expect(usage.byAgent?.ana).toMatchObject({ inputTokens: 1300, outputTokens: 350, totalTokens: 1650, currency: 'USD' });
    expect(usage.byAgent?.ana.cost).toBeCloseTo(0.0135, 10);
    expect(usage.byAgent?.bruno).toMatchObject({ totalTokens: 1000, cost: 0.0075, currency: 'USD' });
  });

  it('makes the total cost unknown when any event lacks a cost', () => {
    const usage = summarizeUsage([
      llmUsage('ana', { inputTokens: 1000, outputTokens: 100, cost: 0.5, currency: 'USD' }, { at: T0 }),
      llmUsage('bruno', { inputTokens: 400, outputTokens: 40 }, { at: T0 + 1 }),
    ]);

    expect(usage.total?.cost).toBeNull();
    expect(usage.total?.totalTokens).toBe(1540);
    expect(usage.byAgent?.ana.cost).toBe(0.5);
    expect(usage.byAgent?.bruno.cost).toBeNull();
  });

  it('keeps the total cost unknown once a costless event is seen, whatever comes after', () => {
    const usage = summarizeUsage([
      llmUsage('ana', { inputTokens: 10, outputTokens: 1 }, { at: T0 }),
      llmUsage('ana', { inputTokens: 10, outputTokens: 1, cost: 0.2, currency: 'USD' }, { at: T0 + 1 }),
    ]);
    expect(usage.total?.cost).toBeNull();
    expect(usage.byAgent?.ana.cost).toBeNull();
  });

  it('makes the total cost unknown when currencies differ', () => {
    const usage = summarizeUsage([
      llmUsage('ana', { inputTokens: 100, outputTokens: 10, cost: 1, currency: 'USD' }, { at: T0 }),
      llmUsage('bruno', { inputTokens: 100, outputTokens: 10, cost: 2, currency: 'EUR' }, { at: T0 + 1 }),
    ]);
    expect(usage.total?.cost).toBeNull();
    expect(usage.total?.currency).toBeUndefined();
    expect(usage.byAgent?.ana).toMatchObject({ cost: 1, currency: 'USD' });
    expect(usage.byAgent?.bruno).toMatchObject({ cost: 2, currency: 'EUR' });
  });

  // Bug: src/lib/usage.ts:96-97 adds an agent's costs without comparing currencies and keeps the last
  // currency, so 1 USD + 2 EUR is reported as `{ cost: 3, currency: 'EUR' }` for that agent.
  it('makes an agent cost unknown when that agent reports different currencies', () => {
    const usage = summarizeUsage([
      llmUsage('ana', { inputTokens: 100, outputTokens: 10, cost: 1, currency: 'USD' }, { at: T0 }),
      llmUsage('ana', { inputTokens: 100, outputTokens: 10, cost: 2, currency: 'EUR' }, { at: T0 + 1 }),
    ]);
    expect(usage.total?.cost).toBeNull();
    expect(usage.byAgent?.ana.cost).toBeNull();
  });

  it('never prices tokens that come without a cost', () => {
    const usage = summarizeUsage([
      llmUsage('ana', { provider: 'OpenAI', model: 'gpt-x', inputTokens: 50_000, outputTokens: 5_000 }, { at: T0 }),
    ]);
    expect(usage.total).toMatchObject({ totalTokens: 55_000, cost: null, currency: undefined });
    expect(usage.byAgent?.ana.cost).toBeNull();
  });

  it('does not parse a cost sent as text', () => {
    const usage = summarizeUsage([llmUsage('ana', { inputTokens: 10, outputTokens: 1, cost: '0.5', currency: 'USD' }, { at: T0 })]);
    expect(usage.total?.cost).toBeNull();
  });

  it('reports unknown figures, never zero, when no usage event arrived', () => {
    const usage = summarizeUsage([]);
    expect(usage.total).toMatchObject({ totalTokens: null, cost: null });
    expect(usage.byAgent).toEqual({});
  });

  it('keeps a reported cost of zero as zero', () => {
    const usage = summarizeUsage([llmUsage('local', { inputTokens: 900, outputTokens: 90, cost: 0, currency: 'USD' }, { at: T0 })]);
    expect(usage.total?.cost).toBe(0);
  });

  it('reads the agent from the source when agentId is missing', () => {
    const usage = summarizeUsage([
      {
        id: 'u-1',
        type: 'llm.usage',
        timestamp: T0,
        source: 'agent:scout',
        payload: { inputTokens: 5, outputTokens: 5, cost: 0.01, currency: 'USD' },
      } satisfies CanonicalEventInput,
    ]);
    expect(Object.keys(usage.byAgent ?? {})).toEqual(['scout']);
  });
});

describe('formatUsage', () => {
  it('formats tokens and cost for the locale', () => {
    expect(formatTokens(48210, 'en', en)).toBe('48,210');
    expect(formatCost(12.5, 'USD', 'en', en)).toBe('$12.50');
    expect(formatCost(0.0125, 'USD', 'en', en)).toBe('$0.0125');
    expect(formatCost(12.5, 'EUR', 'es', es)).toBe(
      new Intl.NumberFormat('es', { style: 'currency', currency: 'EUR', maximumFractionDigits: 4 }).format(12.5),
    );
  });

  it('shows a cost without a valid currency code as a plain number', () => {
    expect(formatCost(12.5, undefined, 'en', en)).toBe('12.5');
    expect(formatCost(12.5, 'usd', 'en', en)).toBe('12.5');
    expect(formatCost(12.5, 'dollars', 'en', en)).toBe('12.5');
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])('shows %s as unknown, never as zero', (value) => {
    expect(formatCost(value, 'USD', 'en', en)).toBe('unknown');
    expect(formatCost(value, 'USD', 'es', es)).toBe('desconocido');
    expect(formatTokens(value, 'es', es)).toBe('desconocido');
  });

  it('adds input and output rows only when the host sends them', () => {
    expect(formatUsage({ totalTokens: 10, cost: 1, currency: 'USD' }, 'en', en)).toEqual([
      { label: 'Tokens', value: '10' },
      { label: 'Cost', value: '$1.00' },
    ]);
    expect(formatUsage({ inputTokens: 7, outputTokens: null }, 'es', es)).toEqual([
      { label: 'Tokens', value: 'desconocido' },
      { label: 'Tokens de entrada', value: '7' },
      { label: 'Tokens de salida', value: 'desconocido' },
      { label: 'Costo', value: 'desconocido' },
    ]);
  });
});
