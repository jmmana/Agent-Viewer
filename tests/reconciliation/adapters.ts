/**
 * Issue #62: one adapter per path, each mapping that path's own aggregate type into the common `ScopeUsage`
 * projection (`view.ts`) used to compare the memory store, the SQLite store and the portal reducer.
 */
import type { UsageAggregate, UsageSummary } from '../../server/usageAggregates';
import type { UsageTally } from '../../src/integrations/usageTally';
import type { OfficeUsage, UsageFigures } from '../../src/lib/usage';
import { TOKEN_KINDS, type ReconciliationView, type ScopeUsage, type TokenFigure } from './view';

/** Server path (memory store or SQLite store): `snapshot().usage.total` or one entry of `.byAgent`. Both share
 * the exact same `UsageAggregate` shape, call by call, because both run the same reducer
 * (`server/usageAggregates.ts`, `server/serverState.ts`). */
export function fromServerAggregate(aggregate: UsageAggregate): ScopeUsage {
  const tokens = {} as ScopeUsage['tokens'];
  for (const kind of TOKEN_KINDS) {
    const figure = aggregate.tokens[kind];
    tokens[kind] = { sum: figure.sum, unreportedCount: figure.unreportedCount };
  }
  const byCurrency: Record<string, number> = {};
  for (const entry of aggregate.byCurrency) {
    byCurrency[entry.currency] = (byCurrency[entry.currency] ?? 0) + entry.amount;
  }
  return {
    succeeded: aggregate.calls,
    failed: aggregate.failed.calls,
    tokens,
    cost: {
      byCurrency,
      unknownCostCalls: aggregate.costMissingCount,
      missingCurrencyCalls: aggregate.currencyMissingCount,
    },
  };
}

/** Portal path: `SimulationState.usage` (the total) or one agent's `Agent.usage`. The portal never counts
 * failed calls (`llm.failed` is skipped on purpose, see `eventIngestion.ts`), so `failed` is always `null`
 * here: a path that does not track a figure must say so, never report a false `0`. */
export function fromPortalTally(tally: UsageTally): ScopeUsage {
  const fieldByKind: Record<(typeof TOKEN_KINDS)[number], keyof UsageTally> = {
    input: 'inputTokens',
    output: 'outputTokens',
    cacheRead: 'cacheReadTokens',
    cacheWrite: 'cacheWriteTokens',
    reasoning: 'reasoningTokens',
  };
  const tokens = {} as ScopeUsage['tokens'];
  for (const kind of TOKEN_KINDS) {
    const field = tally[fieldByKind[kind]] as { sum: number; reportedCalls: number };
    const figure: TokenFigure = {
      sum: field.reportedCalls > 0 ? field.sum : null,
      unreportedCount: tally.calls - field.reportedCalls,
    };
    tokens[kind] = figure;
  }
  const byCurrency: Record<string, number> = {};
  let missingCurrencyCalls = 0;
  for (const bucket of tally.cost.buckets) {
    if (bucket.currency === null) {
      missingCurrencyCalls += bucket.calls;
      continue;
    }
    byCurrency[bucket.currency] = (byCurrency[bucket.currency] ?? 0) + bucket.amount;
  }
  return {
    succeeded: tally.calls,
    failed: null,
    tokens,
    cost: {
      byCurrency,
      unknownCostCalls: tally.cost.unknownCalls,
      missingCurrencyCalls,
    },
  };
}

/** A whole `snapshot().usage` (server path): `total` plus every named agent of `byAgent` (the one `agentId:
 * null` bucket, calls with no agent, is out of scope, see the fixture README's "out of scope" note mirroring
 * issue #62 itself). */
export function toReconciliationView(summary: UsageSummary): ReconciliationView {
  const byAgent: Record<string, ScopeUsage> = {};
  for (const agent of summary.byAgent) {
    if (agent.agentId) byAgent[agent.agentId] = fromServerAggregate(agent);
  }
  return { total: fromServerAggregate(summary.total), byAgent };
}

/**
 * The display rule documented by `src/lib/usage.ts` (`summarizeUsage`/`toFigures`), applied to a `ScopeUsage`
 * instead of to raw events: tokens are shown whenever known (never zero for an unknown value), and a cost is
 * shown only when every call in the scope reported one in exactly one currency. This is a simplification valid
 * for the golden fixture (see `reference.ts`'s module comment): it treats "some calls have no currency and none
 * have a known one" as unknown too, which `summarizeUsage` itself would still price; the golden fixture never
 * exercises that edge case.
 */
export function deriveFigures(scope: ScopeUsage): UsageFigures {
  const input = scope.tokens.input.sum;
  const output = scope.tokens.output.sum;
  const totalTokens = input !== null && output !== null ? input + output : null;
  const currencies = Object.keys(scope.cost.byCurrency);
  const hasSingleKnownCost = scope.cost.unknownCostCalls === 0 && scope.cost.missingCurrencyCalls === 0 && currencies.length === 1;
  return {
    totalTokens,
    inputTokens: input,
    outputTokens: output,
    cost: hasSingleKnownCost ? scope.cost.byCurrency[currencies[0]] : null,
    currency: hasSingleKnownCost ? currencies[0] : undefined,
  };
}

export function deriveOfficeUsage(view: ReconciliationView): OfficeUsage {
  const byAgent: Record<string, UsageFigures> = {};
  for (const agentId of Object.keys(view.byAgent)) byAgent[agentId] = deriveFigures(view.byAgent[agentId]);
  return { total: deriveFigures(view.total), byAgent };
}

/** `cost`/`currency` missing from a JSON-parsed fixture and `cost`/`currency: undefined` from a freshly computed
 * `OfficeUsage` are the same value (JSON cannot hold `undefined`; `src/lib/usage.ts`'s `toFigures` returns it).
 * Normalizing both sides to `null` before `assert.deepStrictEqual` is how the issue's own expected shape
 * (`fromOfficeUsage()` note in the issue) says the comparison must work. Any other field keeps its value, so a
 * real mismatch (a wrong number, for example) still fails. */
export function normalizeOfficeUsage(usage: OfficeUsage): OfficeUsage {
  const normalizeFigures = (figures: UsageFigures | undefined): UsageFigures => ({
    totalTokens: figures?.totalTokens ?? null,
    inputTokens: figures?.inputTokens ?? null,
    outputTokens: figures?.outputTokens ?? null,
    cost: figures?.cost ?? null,
    currency: figures?.currency ?? null,
  });
  const byAgent: Record<string, UsageFigures> = {};
  for (const agentId of Object.keys(usage.byAgent ?? {})) byAgent[agentId] = normalizeFigures(usage.byAgent![agentId]);
  return { total: normalizeFigures(usage.total), byAgent };
}
