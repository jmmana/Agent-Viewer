/**
 * Type-level checks of the server usage aggregates. They live in a `.ts` file so `npm run lint` (tsc) checks
 * them: `.mjs` suites are not type-checked. The runtime assertions only keep Vitest from reporting an empty
 * file; the runtime behavior is covered by tests/usage-aggregates.test.mjs and tests/event-store.test.mjs.
 */
import { describe, expect, it } from 'vitest';
import type { AgentProfileInput, AgentRecord, EventStore, ViewerSnapshot } from '../../server/store';
import { createUsageReducer, type TokenFigure, type UsageSummary } from '../../server/usageAggregates';
import type { AgentViewer, UsageSummary as SdkUsageSummary, ViewerSnapshot as SdkViewerSnapshot } from '../../sdk/typescript/index';

/** `true` only when both types are exactly the same. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** Compiles only when the argument is the literal type `true`. */
function assertType<T extends true>(value: T): T {
  return value;
}

const contract = [
  // Unknown is never zero: the legacy single-number costs can be null.
  assertType<Equal<ViewerSnapshot['totalCost'], number | null>>(true),
  assertType<Equal<AgentRecord['cost'], number | null>>(true),
  assertType<Equal<ViewerSnapshot['usage'], UsageSummary>>(true),
  assertType<Equal<TokenFigure['sum'], number | null>>(true),
  // The SDK re-exports the server types instead of keeping a copy.
  assertType<Equal<SdkUsageSummary, UsageSummary>>(true),
  assertType<Equal<SdkViewerSnapshot, ViewerSnapshot>>(true),
  assertType<Equal<ReturnType<AgentViewer['snapshot']>, Promise<ViewerSnapshot>>>(true),
  assertType<Equal<ReturnType<AgentViewer['usageSummary']>, Promise<UsageSummary>>>(true),
  // upsertAgent cannot receive usage figures.
  assertType<Equal<Extract<keyof AgentProfileInput, 'tokensInput' | 'tokensOutput' | 'cachedTokens' | 'reasoningTokens' | 'cost'>, never>>(true),
];

/** Never called: it only has to compile. */
export function upsertAgentRejectsUsageFields(store: EventStore): void {
  // @ts-expect-error usage figures only come from stored llm.usage events
  void store.upsertAgent({ id: 'agent', cost: 99 });
  // @ts-expect-error usage figures only come from stored llm.usage events
  void store.upsertAgent({ id: 'agent', tokensInput: 99 });
  void store.upsertAgent({ id: 'agent', name: 'Agent', model: 'gpt-5' });
}

describe('server usage types', () => {
  it('compiles the type assertions', () => {
    expect(contract.every(Boolean)).toBe(true);
    expect(createUsageReducer().summary().total.tokens.input.sum).toBeNull();
  });
});
