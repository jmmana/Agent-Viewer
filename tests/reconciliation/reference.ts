/**
 * Issue #62: an independent sanity oracle, written from the fixture's own written rules (see the acceptance
 * table in `tests/fixtures/reconciliation/README.md`), never by importing `server/usageAggregates.ts` or
 * `src/integrations/usageTally.ts`. Its only job is to catch a hand-arithmetic mistake in
 * `golden.expected.json`: `tests/reconciliation.test.mjs` asserts `reference(accepted)` equals the `ScopeUsage`
 * projection of `golden.expected.json`'s `server.final`. If someone adds a fixture line and only updates one of
 * the two, this test is what notices.
 *
 * Deliberately simpler than the production reducers: it merges cost purely by currency (production also splits
 * by `costSource`), and it has no idea of `byModel`. Both are fine for this fixture, where a currency never
 * carries two different cost sources; see `view.ts` for why `ScopeUsage` itself makes that same simplification.
 */
import type { CanonicalEvent } from '../../src/integrations/canonicalContract';
import { TOKEN_KINDS, type ReconciliationView, type ScopeUsage, type TokenFigure } from './view';

const TOKEN_FIELD: Record<(typeof TOKEN_KINDS)[number], string> = {
  input: 'inputTokens',
  output: 'outputTokens',
  cacheRead: 'cacheReadTokens',
  cacheWrite: 'cacheWriteTokens',
  reasoning: 'reasoningTokens',
};

interface Accumulator {
  succeeded: number;
  failed: number;
  sums: Record<string, number>;
  reported: Record<string, number>;
  total: number;
  byCurrency: Map<string, number>;
  unknownCostCalls: number;
  missingCurrencyCalls: number;
}

function freshAccumulator(): Accumulator {
  return {
    succeeded: 0,
    failed: 0,
    sums: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    reported: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    total: 0,
    byCurrency: new Map(),
    unknownCostCalls: 0,
    missingCurrencyCalls: 0,
  };
}

function isReported(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function fold(acc: Accumulator, event: CanonicalEvent): void {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (event.type === 'llm.failed') {
    acc.failed += 1;
    return;
  }
  if (event.type !== 'llm.usage') return;
  acc.succeeded += 1;
  acc.total += 1;

  for (const kind of TOKEN_KINDS) {
    const raw = payload[TOKEN_FIELD[kind]];
    if (isReported(raw)) {
      acc.sums[kind] += raw;
      acc.reported[kind] += 1;
    }
  }

  const cost = payload.cost;
  if (!isReported(cost)) {
    acc.unknownCostCalls += 1;
    return;
  }
  const currency = payload.currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    acc.missingCurrencyCalls += 1;
    return;
  }
  acc.byCurrency.set(currency, (acc.byCurrency.get(currency) ?? 0) + cost);
}

function toScopeUsage(acc: Accumulator): ScopeUsage {
  const tokens = {} as ScopeUsage['tokens'];
  for (const kind of TOKEN_KINDS) {
    const unreportedCount = acc.total - acc.reported[kind];
    const figure: TokenFigure = {
      sum: acc.reported[kind] > 0 ? acc.sums[kind] : null,
      unreportedCount,
    };
    tokens[kind] = figure;
  }
  const byCurrency: Record<string, number> = {};
  for (const [currency, amount] of acc.byCurrency) byCurrency[currency] = amount;
  return {
    succeeded: acc.succeeded,
    failed: acc.failed,
    tokens,
    cost: { byCurrency, unknownCostCalls: acc.unknownCostCalls, missingCurrencyCalls: acc.missingCurrencyCalls },
  };
}

/** Resolves the same way the server and the portal do: `agentId`, else `source` without its `agent:` prefix. */
function agentIdOf(event: CanonicalEvent): string | undefined {
  if (event.agentId) return event.agentId;
  if (typeof event.source === 'string' && event.source.startsWith('agent:')) return event.source.slice('agent:'.length);
  return undefined;
}

/** Folds every `llm.usage` and `llm.failed` event in `events` into a total and a per-agent breakdown,
 * independently of the production reducers. */
export function reference(events: readonly CanonicalEvent[]): ReconciliationView {
  const total = freshAccumulator();
  const byAgent = new Map<string, Accumulator>();

  for (const event of events) {
    if (event.type !== 'llm.usage' && event.type !== 'llm.failed') continue;
    fold(total, event);
    const agentId = agentIdOf(event);
    if (!agentId) continue;
    const acc = byAgent.get(agentId) ?? freshAccumulator();
    fold(acc, event);
    byAgent.set(agentId, acc);
  }

  const byAgentView: Record<string, ScopeUsage> = {};
  for (const [agentId, acc] of byAgent) byAgentView[agentId] = toScopeUsage(acc);
  return { total: toScopeUsage(total), byAgent: byAgentView };
}
