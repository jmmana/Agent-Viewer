/**
 * Issue #62: one small, path-agnostic shape that the memory store, the SQLite store and the portal reducer can
 * all be projected into, so the golden fixture's figures can be compared across them without pretending their
 * native types are the same. They are not: the server's `UsageAggregate` (`server/usageAggregates.ts`) keeps a
 * `(currency, costSource)` byCurrency breakdown and counts failed calls separately; the portal's `UsageTally`
 * (`src/integrations/usageTally.ts`) buckets by `(currency, costSource)` too but never counts failed calls at
 * all (`src/integrations/eventIngestion.ts` skips `llm.failed` on purpose); the library's `OfficeUsage`
 * (`src/lib/usage.ts`) is coarser still, a single sticky-null total with no currency breakdown. `ScopeUsage`
 * here is the greatest common denominator of the first two; the library is compared separately (see
 * `reconciliation.test.mjs`, the "library" and "display rule" tests), not through this type.
 *
 * `failed: null` means "this path does not track failed calls separately", not "zero failed calls". Never
 * compare a `null` failed count against a number.
 */

export interface TokenFigure {
  /** `null` only when nothing in the bucket reported this token kind. */
  sum: number | null;
  /** Calls in the bucket that did not report this token kind. */
  unreportedCount: number;
}

export interface CostFigures {
  /** Amount per ISO 4217 currency, merged across cost sources (this fixture never mixes sources within a
   * currency, so merging loses nothing here; see the module comment above). */
  byCurrency: Record<string, number>;
  /** Calls with no valid cost at all. */
  unknownCostCalls: number;
  /** Calls with a valid cost but no valid currency. */
  missingCurrencyCalls: number;
}

export interface ScopeUsage {
  succeeded: number;
  failed: number | null;
  tokens: {
    input: TokenFigure;
    output: TokenFigure;
    cacheRead: TokenFigure;
    cacheWrite: TokenFigure;
    reasoning: TokenFigure;
  };
  cost: CostFigures;
}

export const TOKEN_KINDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const;
export type TokenKindName = (typeof TOKEN_KINDS)[number];

/** Rounds to 1e-9 so float summation order (a JS loop vs SQL arithmetic) never causes a false failure. */
export function round9(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function roundCostMap(byCurrency: Record<string, number>): Record<string, number> {
  const rounded: Record<string, number> = {};
  for (const key of Object.keys(byCurrency).sort()) rounded[key] = round9(byCurrency[key]);
  return rounded;
}

/** Normalizes a `ScopeUsage` for comparison: sorts currency keys and rounds every amount to 1e-9. */
export function normalizeScopeUsage(view: ScopeUsage): ScopeUsage {
  return {
    succeeded: view.succeeded,
    failed: view.failed,
    tokens: {
      input: { ...view.tokens.input },
      output: { ...view.tokens.output },
      cacheRead: { ...view.tokens.cacheRead },
      cacheWrite: { ...view.tokens.cacheWrite },
      reasoning: { ...view.tokens.reasoning },
    },
    cost: {
      byCurrency: roundCostMap(view.cost.byCurrency),
      unknownCostCalls: view.cost.unknownCostCalls,
      missingCurrencyCalls: view.cost.missingCurrencyCalls,
    },
  };
}

/** Builds `"<path>: <field> expected <x>, got <y>"` messages, naming exactly what diverged (acceptance criteria
 * of issue #62: a failure must name the path and the field, never just "assertion failed"). */
export function diffScopeUsage(actual: ScopeUsage, expected: ScopeUsage, path: string): string[] {
  const a = normalizeScopeUsage(actual);
  const e = normalizeScopeUsage(expected);
  const problems: string[] = [];
  const report = (field: string, got: unknown, want: unknown) => {
    problems.push(`${path}: ${field} expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };
  if (a.succeeded !== e.succeeded) report('calls.succeeded', a.succeeded, e.succeeded);
  if (e.failed !== null && a.failed !== e.failed) report('calls.failed', a.failed, e.failed);
  for (const kind of TOKEN_KINDS) {
    if (a.tokens[kind].sum !== e.tokens[kind].sum) report(`tokens.${kind}.sum`, a.tokens[kind].sum, e.tokens[kind].sum);
    if (a.tokens[kind].unreportedCount !== e.tokens[kind].unreportedCount) {
      report(`tokens.${kind}.unreportedCount`, a.tokens[kind].unreportedCount, e.tokens[kind].unreportedCount);
    }
  }
  const currencies = new Set([...Object.keys(a.cost.byCurrency), ...Object.keys(e.cost.byCurrency)]);
  for (const currency of currencies) {
    const gotAmount = a.cost.byCurrency[currency];
    const wantAmount = e.cost.byCurrency[currency];
    if (gotAmount !== wantAmount) report(`cost.byCurrency.${currency}`, gotAmount ?? null, wantAmount ?? null);
  }
  if (a.cost.unknownCostCalls !== e.cost.unknownCostCalls) {
    report('cost.unknownCostCalls', a.cost.unknownCostCalls, e.cost.unknownCostCalls);
  }
  if (a.cost.missingCurrencyCalls !== e.cost.missingCurrencyCalls) {
    report('cost.missingCurrencyCalls', a.cost.missingCurrencyCalls, e.cost.missingCurrencyCalls);
  }
  return problems;
}

export interface ReconciliationView {
  total: ScopeUsage;
  byAgent: Record<string, ScopeUsage>;
}

/** Collects every diff across `total` and every agent of `byAgent`, so one failed assertion lists everything
 * that diverged instead of stopping at the first field. */
export function diffReconciliationView(actual: ReconciliationView, expected: ReconciliationView, path: string): string[] {
  const problems = diffScopeUsage(actual.total, expected.total, `${path}: total`);
  const agentIds = new Set([...Object.keys(actual.byAgent), ...Object.keys(expected.byAgent)]);
  for (const agentId of agentIds) {
    if (!actual.byAgent[agentId]) {
      problems.push(`${path}: byAgent.${agentId} missing from actual`);
      continue;
    }
    if (!expected.byAgent[agentId]) {
      problems.push(`${path}: byAgent.${agentId} not expected but present in actual`);
      continue;
    }
    problems.push(...diffScopeUsage(actual.byAgent[agentId], expected.byAgent[agentId], `${path}: byAgent.${agentId}`));
  }
  return problems;
}
