/**
 * Usage test vectors: synthetic event lists and the figures `summarizeUsage` must return for them.
 * They are kept apart from the tests so the portal totals (#55) and the golden reconciliation suite (#62)
 * can reuse them. Every name and figure here is invented. Costs are whole numbers so results compare exactly.
 */
import type { OfficeEventInput, OfficeUsage } from '../../src/lib/index';
import { T0, llmUsage, makeEvent, registered } from './fixtures';

export interface UsageVector {
  name: string;
  events: OfficeEventInput[];
  expected: Required<OfficeUsage>;
}

const UNKNOWN = { totalTokens: null, inputTokens: null, outputTokens: null, cost: null, currency: undefined };

export const USAGE_VECTORS: readonly UsageVector[] = [
  {
    name: 'a repeated id, a missing output count and a cost without currency',
    events: [
      llmUsage('ana', { provider: 'openai', model: 'm', inputTokens: 100, outputTokens: 10, cost: 1, currency: 'USD' }, { id: 'u-1', at: T0 }),
      llmUsage('ana', { provider: 'openai', model: 'm', inputTokens: 100, outputTokens: 10, cost: 1, currency: 'USD' }, { id: 'u-1', at: T0 }),
      llmUsage('bruno', { provider: 'local', model: 'm', inputTokens: 50, cost: 2 }, { id: 'u-2', at: T0 + 1 }),
    ],
    expected: {
      total: { inputTokens: 150, outputTokens: null, totalTokens: null, cost: null, currency: undefined },
      byAgent: {
        ana: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cost: 1, currency: 'USD' },
        bruno: { inputTokens: 50, outputTokens: null, totalTokens: null, cost: 2, currency: undefined },
      },
    },
  },
  {
    name: 'a USD cost next to a cost without currency',
    events: [
      llmUsage('ana', { inputTokens: 10, outputTokens: 1, cost: 1, currency: 'USD' }, { id: 'mix-1', at: T0 }),
      llmUsage('ana', { inputTokens: 20, outputTokens: 2, cost: 2 }, { id: 'mix-2', at: T0 + 1 }),
    ],
    expected: {
      total: { inputTokens: 30, outputTokens: 3, totalTokens: 33, cost: null, currency: undefined },
      byAgent: { ana: { inputTokens: 30, outputTokens: 3, totalTokens: 33, cost: null, currency: undefined } },
    },
  },
  {
    name: 'USD and EUR',
    events: [
      llmUsage('ana', { inputTokens: 100, outputTokens: 10, cost: 1, currency: 'USD' }, { id: 'cur-1', at: T0 }),
      llmUsage('bruno', { inputTokens: 100, outputTokens: 10, cost: 2, currency: 'EUR' }, { id: 'cur-2', at: T0 + 1 }),
    ],
    expected: {
      total: { inputTokens: 200, outputTokens: 20, totalTokens: 220, cost: null, currency: undefined },
      byAgent: {
        ana: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cost: 1, currency: 'USD' },
        bruno: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cost: 2, currency: 'EUR' },
      },
    },
  },
  {
    name: 'costs that all come without a currency',
    events: [
      llmUsage('ana', { inputTokens: 5, outputTokens: 5, cost: 1 }, { id: 'plain-1', at: T0 }),
      llmUsage('ana', { inputTokens: 5, outputTokens: 5, cost: 2 }, { id: 'plain-2', at: T0 + 1 }),
    ],
    expected: {
      total: { inputTokens: 10, outputTokens: 10, totalTokens: 20, cost: 3, currency: undefined },
      byAgent: { ana: { inputTokens: 10, outputTokens: 10, totalTokens: 20, cost: 3, currency: undefined } },
    },
  },
  {
    name: 'one agent that does not report input tokens',
    events: [
      llmUsage('ana', { outputTokens: 7, cost: 1, currency: 'USD' }, { id: 'tok-1', at: T0 }),
      llmUsage('bruno', { inputTokens: 40, outputTokens: 4, cost: 1, currency: 'USD' }, { id: 'tok-2', at: T0 + 1 }),
    ],
    expected: {
      total: { inputTokens: null, outputTokens: 11, totalTokens: null, cost: 2, currency: 'USD' },
      byAgent: {
        ana: { inputTokens: null, outputTokens: 7, totalTokens: null, cost: 1, currency: 'USD' },
        bruno: { inputTokens: 40, outputTokens: 4, totalTokens: 44, cost: 1, currency: 'USD' },
      },
    },
  },
  {
    name: 'a reported zero cost and zero tokens',
    events: [llmUsage('local', { inputTokens: 0, outputTokens: 0, cost: 0, currency: 'USD' }, { id: 'zero-1', at: T0 })],
    expected: {
      total: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, currency: 'USD' },
      byAgent: { local: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, currency: 'USD' } },
    },
  },
  {
    name: 'a non usage event that takes the id of a later usage event',
    events: [
      registered('ana', 'Ana Rivas', {}, { id: 'reg-1', at: T0 }),
      makeEvent('tool.completed', 'ana', { outputSummary: 'done' }, { id: 'shared-1', at: T0 + 1 }),
      llmUsage('ana', { inputTokens: 10, outputTokens: 1, cost: 1, currency: 'USD' }, { id: 'shared-1', at: T0 + 2 }),
    ],
    expected: { total: UNKNOWN, byAgent: {} },
  },
  {
    name: 'no events',
    events: [],
    expected: { total: UNKNOWN, byAgent: {} },
  },
];
