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
import { USAGE_VECTORS } from './usageVectors';

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

  it('makes an agent cost unknown when that agent reports different currencies', () => {
    const usage = summarizeUsage([
      llmUsage('ana', { inputTokens: 100, outputTokens: 10, cost: 1, currency: 'USD' }, { at: T0 }),
      llmUsage('ana', { inputTokens: 100, outputTokens: 10, cost: 2, currency: 'EUR' }, { at: T0 + 1 }),
    ]);
    expect(usage.total?.cost).toBeNull();
    expect(usage.byAgent?.ana.cost).toBeNull();
    expect(usage.byAgent?.ana.currency).toBeUndefined();
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

describe('summarizeUsage: deduplication', () => {
  it('ignores a repeated event id in the total and per agent', () => {
    const usage = summarizeUsage([
      llmUsage('ana', { inputTokens: 100, outputTokens: 10, cost: 1, currency: 'USD' }, { id: 'u-1', at: T0 }),
      llmUsage('ana', { inputTokens: 100, outputTokens: 10, cost: 1, currency: 'USD' }, { id: 'u-1', at: T0 }),
      llmUsage('bruno', { inputTokens: 50, outputTokens: 5, cost: 2, currency: 'USD' }, { id: 'u-2', at: T0 + 1 }),
    ]);
    expect(usage.total).toEqual({ inputTokens: 150, outputTokens: 15, totalTokens: 165, cost: 3, currency: 'USD' });
    expect(usage.byAgent?.ana).toEqual({ inputTokens: 100, outputTokens: 10, totalTokens: 110, cost: 1, currency: 'USD' });
    expect(usage.byAgent?.bruno).toEqual({ inputTokens: 50, outputTokens: 5, totalTokens: 55, cost: 2, currency: 'USD' });
  });

  it('keeps the first occurrence when a repeated id carries a different payload or agent', () => {
    const usage = summarizeUsage([
      llmUsage('ana', { inputTokens: 100, outputTokens: 10, cost: 1, currency: 'USD' }, { id: 'u-1', at: T0 }),
      llmUsage('ana', { inputTokens: 999, outputTokens: 99, cost: 9, currency: 'USD' }, { id: 'u-1', at: T0 + 1 }),
      llmUsage('bruno', { inputTokens: 500, outputTokens: 50, cost: 5, currency: 'EUR' }, { id: 'u-1', at: T0 + 2 }),
    ]);
    expect(usage.total).toEqual({ inputTokens: 100, outputTokens: 10, totalTokens: 110, cost: 1, currency: 'USD' });
    expect(usage.byAgent).toEqual({
      ana: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cost: 1, currency: 'USD' },
    });
  });

  it('registers ids of non usage events too', () => {
    const usage = summarizeUsage([
      makeEvent('tool.completed', 'ana', { outputSummary: 'done' }, { id: 'x', at: T0 }),
      llmUsage('ana', { inputTokens: 100, outputTokens: 10, cost: 1, currency: 'USD' }, { id: 'x', at: T0 + 1 }),
      llmUsage('ana', { inputTokens: 20, outputTokens: 2, cost: 1, currency: 'USD' }, { id: 'y', at: T0 + 2 }),
    ]);
    expect(usage.total).toEqual({ inputTokens: 20, outputTokens: 2, totalTokens: 22, cost: 1, currency: 'USD' });
    expect(Object.keys(usage.byAgent ?? {})).toEqual(['ana']);
  });

  it('counts events without an id, but the same object only once', () => {
    const withoutId = (payload: Record<string, unknown>, id?: unknown): CanonicalEventInput =>
      ({
        ...(id === undefined ? {} : { id }),
        type: 'llm.usage',
        agentId: 'ana',
        timestamp: T0,
        source: 'agent:ana',
        payload,
      }) as unknown as CanonicalEventInput;
    const first = withoutId({ inputTokens: 10, outputTokens: 1, cost: 1, currency: 'USD' });
    const twin = withoutId({ inputTokens: 10, outputTokens: 1, cost: 1, currency: 'USD' });
    const emptyId = withoutId({ inputTokens: 10, outputTokens: 1, cost: 1, currency: 'USD' }, '');
    const numericId = withoutId({ inputTokens: 10, outputTokens: 1, cost: 1, currency: 'USD' }, 7);
    const sameNumericId = withoutId({ inputTokens: 10, outputTokens: 1, cost: 1, currency: 'USD' }, 7);

    const usage = summarizeUsage([first, twin, first, emptyId, emptyId, numericId, sameNumericId]);
    expect(usage.total).toEqual({ inputTokens: 50, outputTokens: 5, totalTokens: 55, cost: 5, currency: 'USD' });
    expect(usage.byAgent?.ana).toEqual(usage.total);
  });

  it('uses the id of the raw input, not the one the normalizer makes up', () => {
    const event = { type: 'llm.usage', agentId: 'ana', timestamp: T0, payload: { inputTokens: 1, outputTokens: 1 } };
    const usage = summarizeUsage([event, event] as unknown as CanonicalEventInput[]);
    expect(usage.total).toMatchObject({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  });
});

describe('summarizeUsage: currencies', () => {
  it('makes the cost unknown when a USD cost is mixed with a cost without currency', () => {
    const sameAgent = summarizeUsage([
      llmUsage('ana', { inputTokens: 10, outputTokens: 1, cost: 1, currency: 'USD' }, { at: T0 }),
      llmUsage('ana', { inputTokens: 10, outputTokens: 1, cost: 2 }, { at: T0 + 1 }),
    ]);
    expect(sameAgent.total).toMatchObject({ cost: null, currency: undefined, totalTokens: 22 });
    expect(sameAgent.byAgent?.ana).toMatchObject({ cost: null, currency: undefined });

    const twoAgents = summarizeUsage([
      llmUsage('ana', { inputTokens: 10, outputTokens: 1, cost: 1, currency: 'USD' }, { at: T0 }),
      llmUsage('bruno', { inputTokens: 10, outputTokens: 1, cost: 2, currency: null }, { at: T0 + 1 }),
    ]);
    expect(twoAgents.total).toMatchObject({ cost: null, currency: undefined });
    expect(twoAgents.byAgent?.ana).toMatchObject({ cost: 1, currency: 'USD' });
    expect(twoAgents.byAgent?.bruno).toMatchObject({ cost: 2, currency: undefined });
  });

  it('makes the cost unknown when USD and EUR are mixed', () => {
    const usage = summarizeUsage([
      llmUsage('ana', { inputTokens: 100, outputTokens: 10, cost: 1, currency: 'USD' }, { at: T0 }),
      llmUsage('ana', { inputTokens: 100, outputTokens: 10, cost: 2, currency: 'EUR' }, { at: T0 + 1 }),
      llmUsage('bruno', { inputTokens: 100, outputTokens: 10, cost: 3, currency: 'EUR' }, { at: T0 + 2 }),
    ]);
    expect(usage.total).toMatchObject({ cost: null, currency: undefined, totalTokens: 330 });
    expect(usage.byAgent?.ana).toMatchObject({ cost: null, currency: undefined });
    expect(usage.byAgent?.bruno).toMatchObject({ cost: 3, currency: 'EUR' });
  });

  it('adds costs that all lack a currency and shows them as a plain number', () => {
    const usage = summarizeUsage([
      llmUsage('ana', { inputTokens: 10, outputTokens: 1, cost: 1 }, { at: T0 }),
      llmUsage('bruno', { inputTokens: 10, outputTokens: 1, cost: 2 }, { at: T0 + 1 }),
    ]);
    expect(usage.total).toMatchObject({ cost: 3, currency: undefined });
    const rows = formatUsage(usage.total ?? {}, 'en', en);
    expect(rows.find((row) => row.label === 'Cost')?.value).toBe('3');
    expect(rows.map((row) => row.value).join(' ')).not.toMatch(/[$€£]|USD/);
  });

  it.each(['usd', 'dollars', '', 'US', 'USDT'])('treats a non ISO 4217 currency as missing (%j)', (currency) => {
    const usage = summarizeUsage([
      llmUsage('ana', { inputTokens: 10, outputTokens: 1, cost: 1, currency: 'USD' }, { at: T0 }),
      llmUsage('ana', { inputTokens: 10, outputTokens: 1, cost: 1, currency }, { at: T0 + 1 }),
    ]);
    expect(usage.total).toMatchObject({ cost: null, currency: undefined });
    expect(usage.byAgent?.ana).toMatchObject({ cost: null, currency: undefined });

    const alone = summarizeUsage([llmUsage('ana', { inputTokens: 10, outputTokens: 1, cost: 1, currency }, { at: T0 })]);
    expect(alone.total).toMatchObject({ cost: 1, currency: undefined });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '0.5', null])(
    'treats a negative, infinite or text cost as not reported (%s)',
    (cost) => {
      const usage = summarizeUsage([
        llmUsage('ana', { inputTokens: 10, outputTokens: 1, cost: 1, currency: 'USD' }, { at: T0 }),
        llmUsage('ana', { inputTokens: 10, outputTokens: 1, cost, currency: 'USD' }, { at: T0 + 1 }),
      ]);
      expect(usage.total).toMatchObject({ cost: null, currency: undefined, totalTokens: 22 });
      expect(usage.byAgent?.ana).toMatchObject({ cost: null, currency: undefined });
    },
  );
});

describe('summarizeUsage: tokens', () => {
  it('makes input tokens unknown when an event does not report them', () => {
    const usage = summarizeUsage([
      llmUsage('ana', { inputTokens: 100, outputTokens: 10, cost: 1, currency: 'USD' }, { at: T0 }),
      llmUsage('ana', { outputTokens: 5, cost: 1, currency: 'USD' }, { at: T0 + 1 }),
      llmUsage('bruno', { inputTokens: 40, outputTokens: 4, cost: 1, currency: 'USD' }, { at: T0 + 2 }),
    ]);
    expect(usage.total).toEqual({ inputTokens: null, outputTokens: 19, totalTokens: null, cost: 3, currency: 'USD' });
    expect(usage.byAgent?.ana).toEqual({ inputTokens: null, outputTokens: 15, totalTokens: null, cost: 2, currency: 'USD' });
    expect(usage.byAgent?.bruno).toEqual({ inputTokens: 40, outputTokens: 4, totalTokens: 44, cost: 1, currency: 'USD' });
  });

  it('makes output tokens unknown when an event does not report them', () => {
    const usage = summarizeUsage([
      llmUsage('ana', { inputTokens: 100, outputTokens: 10 }, { at: T0 }),
      llmUsage('ana', { inputTokens: 50, outputTokens: null }, { at: T0 + 1 }),
      llmUsage('bruno', { inputTokens: 40, outputTokens: 4 }, { at: T0 + 2 }),
    ]);
    expect(usage.total).toMatchObject({ inputTokens: 190, outputTokens: null, totalTokens: null });
    expect(usage.byAgent?.ana).toMatchObject({ inputTokens: 150, outputTokens: null, totalTokens: null });
    expect(usage.byAgent?.bruno).toMatchObject({ inputTokens: 40, outputTokens: 4, totalTokens: 44 });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '100'])('ignores negative, fractional and text token counts (%s)', (value) => {
    const usage = summarizeUsage([
      llmUsage('ana', { inputTokens: 100, outputTokens: 10 }, { at: T0 }),
      llmUsage('ana', { inputTokens: value, outputTokens: 10 }, { at: T0 + 1 }),
      llmUsage('bruno', { inputTokens: 100, outputTokens: value }, { at: T0 + 2 }),
    ]);
    expect(usage.total).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null });
    expect(usage.byAgent?.ana).toMatchObject({ inputTokens: null, outputTokens: 20, totalTokens: null });
    expect(usage.byAgent?.bruno).toMatchObject({ inputTokens: 100, outputTokens: null, totalTokens: null });
  });

  it('reports unknown figures when there are no usage events', () => {
    const unknown = { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, currency: undefined };
    expect(summarizeUsage([])).toEqual({ total: unknown, byAgent: {} });
    expect(
      summarizeUsage([
        registered('ana', 'Ana Rivas', {}, { at: T0 }),
        makeEvent('tool.completed', 'ana', { outputSummary: 'done', inputTokens: 10, outputTokens: 1, cost: 1 }, { at: T0 + 1 }),
      ]),
    ).toEqual({ total: unknown, byAgent: {} });
  });

  it('keeps reported zero tokens as zero', () => {
    const usage = summarizeUsage([llmUsage('local', { inputTokens: 0, outputTokens: 0, cost: 0, currency: 'USD' }, { at: T0 })]);
    expect(usage.total).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, currency: 'USD' });
  });
});

describe('summarizeUsage: shared vectors', () => {
  it.each(USAGE_VECTORS.map((vector) => [vector.name, vector] as const))('returns the expected figures for %s', (_name, vector) => {
    expect(summarizeUsage(vector.events)).toEqual(vector.expected);
  });

  it('an exact duplicate of any event never changes the result', () => {
    for (const vector of USAGE_VECTORS) {
      const expected = summarizeUsage(vector.events);
      vector.events.forEach((event, index) => {
        const copies = [event, { ...event, payload: { ...(event as { payload?: object }).payload } }] as const;
        for (const copy of copies) {
          const appended = [...vector.events, copy];
          const inserted = [...vector.events.slice(0, index + 1), copy, ...vector.events.slice(index + 1)];
          expect(summarizeUsage(appended), `${vector.name}: event ${index} appended`).toEqual(expected);
          expect(summarizeUsage(inserted), `${vector.name}: event ${index} inserted`).toEqual(expected);
        }
      });
    }
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
