// Issue #302 (first vertical sub-issue of #85): the pure engine in server/budgets.ts. Table-driven cases for
// window computation (day/week/month, timezones, DST gap and ambiguity, boundaries, the section 4 fixtures of
// #85), basis, unknown rules, currency rules, thresholds, float rounding, failed calls, truncated history, the
// "provably exceeded with unknowns" case, and a seeded property-style loop over random rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBudgetWindow,
  aggregateBudgetCalls,
  evaluateBudget,
  evaluationErrorStatus,
  roundBudgetAmount,
} from '../server/budgets.ts';

// -------------------------------------------------------------
// Fixture helpers
// -------------------------------------------------------------

let rowCounter = 0;
function makeRow(overrides = {}) {
  rowCounter++;
  return {
    eventType: 'llm.usage',
    receivedAt: 1_700_000_000_000 + rowCounter,
    agentId: 'agent-1',
    sessionId: 'session-1',
    model: 'claude-sonnet',
    userId: 'user-1',
    tags: [],
    cost: 1,
    currency: 'USD',
    costSource: 'provider-reported',
    estimatedCostNano: null,
    estimatedCurrency: null,
    pricingVersion: null,
    estimateStatus: null,
    ...overrides,
  };
}

function budgetFixture(overrides = {}) {
  return {
    id: 'bud_test',
    name: 'Test budget',
    scope: { type: 'all', value: null },
    period: 'month',
    timezone: 'UTC',
    currency: 'USD',
    basis: 'reported',
    limit: 10,
    warningRatio: 0.8,
    enabled: true,
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** Independent (not from the module under test) offset reader, used only to derive ground truth for the DST
 * fixtures below, the same technique the module itself uses but reimplemented so the test does not just check
 * the module against itself. */
function offsetAt(ts, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const part of formatter.formatToParts(new Date(ts))) parts[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asUtc - ts) / 60_000);
}

// -------------------------------------------------------------
// Window computation
// -------------------------------------------------------------

test('computeBudgetWindow: month in UTC matches the #85 section 4 fixture', () => {
  const now = Date.UTC(2026, 0, 10, 0, 0, 0); // 2026-01-10T00:00:00Z
  const window = computeBudgetWindow('month', 'UTC', now);
  assert.equal(window.start, 1767225600000);
  assert.equal(window.end, 1769904000000);
});

test('computeBudgetWindow: week (Monday start) in America/Mexico_City matches the #85 section 4 fixture', () => {
  const now = Date.UTC(2026, 0, 10, 0, 0, 0);
  const window = computeBudgetWindow('week', 'America/Mexico_City', now);
  assert.equal(window.start, 1767592800000);
  assert.equal(window.end, 1768197600000);
});

test('computeBudgetWindow: day in UTC is exactly 24h with no DST', () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const window = computeBudgetWindow('day', 'UTC', now);
  assert.equal(window.end - window.start, 24 * 3600 * 1000);
  assert.equal(window.start, Date.UTC(2026, 5, 15, 0, 0, 0));
  assert.equal(window.end, Date.UTC(2026, 5, 16, 0, 0, 0));
});

test('computeBudgetWindow: day window is 23h across America/New_York spring-forward (2026-03-08)', () => {
  const now = Date.UTC(2026, 2, 8, 18, 0, 0); // some instant during March 8 local
  const window = computeBudgetWindow('day', 'America/New_York', now);
  assert.equal(window.end - window.start, 23 * 3600 * 1000, 'the spring-forward day is 1 hour short');
  // Sanity: reformatting both boundaries in the zone gives 00:00:00 on consecutive calendar days.
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  assert.equal(fmt.format(new Date(window.start)), '2026-03-08 00:00:00');
  assert.equal(fmt.format(new Date(window.end)), '2026-03-09 00:00:00');
});

test('computeBudgetWindow: day window is 25h across America/New_York fall-back (2026-11-01)', () => {
  const now = Date.UTC(2026, 10, 1, 18, 0, 0);
  const window = computeBudgetWindow('day', 'America/New_York', now);
  assert.equal(window.end - window.start, 25 * 3600 * 1000, 'the fall-back day is 1 hour long');
});

test('computeBudgetWindow: a call exactly at window start is in-window, exactly at end is in the next window', () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const window = computeBudgetWindow('day', 'UTC', now);
  const budget = budgetFixture({ scope: { type: 'all', value: null } });
  const atStart = [makeRow({ receivedAt: window.start })];
  const atEnd = [makeRow({ receivedAt: window.end })];
  assert.equal(aggregateBudgetCalls(atStart, budget, window).calls.total, 1, 'start is inclusive');
  assert.equal(aggregateBudgetCalls(atEnd, budget, window).calls.total, 0, 'end is exclusive');
});

test('computeBudgetWindow: America/Santiago has a DST gap exactly at local midnight (2026-09-06)', () => {
  // Chile's DST spring-forward in 2026 lands exactly on a local midnight: 2026-09-06 00:00:00 through 00:59:59
  // never happens. The window must start at the first valid instant at or after that nominal midnight.
  const naiveUtc = Date.UTC(2026, 8, 6, 0, 0, 0);
  const offsetBefore = offsetAt(naiveUtc - 86_400_000, 'America/Santiago');
  const offsetAfter = offsetAt(naiveUtc + 86_400_000, 'America/Santiago');
  assert.notEqual(offsetBefore, offsetAfter, 'fixture sanity: a transition must straddle this day');

  const now = Date.UTC(2026, 8, 6, 12, 0, 0);
  const window = computeBudgetWindow('day', 'America/Santiago', now);

  // The returned start must be a real, self-consistent instant (not inside the gap): reading its own offset
  // back must reproduce a wall clock at or after 00:00:00, under the post-transition offset.
  assert.equal(offsetAt(window.start, 'America/Santiago'), offsetAfter);
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Santiago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const localStart = fmt.format(new Date(window.start));
  assert.ok(localStart.startsWith('2026-09-06'), `expected the gap-adjusted start to read on 2026-09-06, got ${localStart}`);
  // It must be the *first* valid instant at or after midnight, which is the transition instant itself: no
  // earlier instant on this calendar day can read a valid, self-consistent wall clock at all (that is exactly
  // what makes it a gap), so the resolved start cannot be more than a few seconds past the true transition.
  const independentTransition = (() => {
    let lo = naiveUtc - 86_400_000;
    let hi = naiveUtc + 86_400_000;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (offsetAt(mid, 'America/Santiago') === offsetBefore) lo = mid;
      else hi = mid;
    }
    return hi;
  })();
  assert.ok(Math.abs(window.start - independentTransition) <= 1000, `expected the resolved start to land within 1s of the independently bisected transition instant, got a ${window.start - independentTransition}ms difference`);
});

test('computeBudgetWindow: America/Havana has an ambiguous local midnight (2026-11-01), resolved to the earlier instant', () => {
  // Cuba's 2026 DST fall-back lands exactly on a local midnight: 2026-11-01 00:00:00 is a real wall clock
  // under both the pre- and post-transition offset (the hour before midnight repeats), unlike a transition that
  // only straddles the day without touching 00:00:00 itself.
  const naiveUtc = Date.UTC(2026, 10, 1, 0, 0, 0);
  const offsetBefore = offsetAt(naiveUtc - 86_400_000, 'America/Havana');
  const offsetAfter = offsetAt(naiveUtc + 86_400_000, 'America/Havana');
  assert.notEqual(offsetBefore, offsetAfter, 'fixture sanity: a transition must straddle this day');
  const candidateBefore = naiveUtc - offsetBefore * 60_000;
  const candidateAfter = naiveUtc - offsetAfter * 60_000;
  assert.equal(offsetAt(candidateBefore, 'America/Havana'), offsetBefore, 'fixture sanity: both candidates must be real, self-consistent instants');
  assert.equal(offsetAt(candidateAfter, 'America/Havana'), offsetAfter, 'fixture sanity: both candidates must be real, self-consistent instants');

  const now = Date.UTC(2026, 10, 1, 12, 0, 0);
  const window = computeBudgetWindow('day', 'America/Havana', now);

  // Both candidate instants are real (the wall clock 00:00:00 happens twice); the rule picks the earlier one.
  assert.equal(window.start, Math.min(candidateBefore, candidateAfter));
});

test('computeBudgetWindow: month rolls over the year boundary', () => {
  const now = Date.UTC(2026, 11, 15, 0, 0, 0); // December
  const window = computeBudgetWindow('month', 'UTC', now);
  assert.equal(window.start, Date.UTC(2026, 11, 1, 0, 0, 0));
  assert.equal(window.end, Date.UTC(2027, 0, 1, 0, 0, 0));
});

test('computeBudgetWindow: week starts on Monday even when "now" falls on a Sunday', () => {
  const sunday = Date.UTC(2026, 0, 11, 15, 0, 0); // 2026-01-11 is a Sunday
  const window = computeBudgetWindow('week', 'UTC', sunday);
  assert.equal(window.start, Date.UTC(2026, 0, 5, 0, 0, 0)); // Monday 2026-01-05
  assert.equal(window.end, Date.UTC(2026, 0, 12, 0, 0, 0));
});

// -------------------------------------------------------------
// Scope matching (rule 2)
// -------------------------------------------------------------

test('scope: "all" matches every row regardless of its own fields', () => {
  const window = { start: 0, end: 10_000_000_000_000 };
  const rows = [makeRow({ agentId: null }), makeRow({ agentId: 'a' })];
  const result = aggregateBudgetCalls(rows, budgetFixture({ scope: { type: 'all', value: null } }), window);
  assert.equal(result.calls.total, 2);
});

for (const [type, field] of [
  ['agent', 'agentId'],
  ['model', 'model'],
  ['session', 'sessionId'],
  ['user', 'userId'],
]) {
  test(`scope: "${type}" matches exactly and is case sensitive`, () => {
    const window = { start: 0, end: 10_000_000_000_000 };
    const rows = [makeRow({ [field]: 'Target' }), makeRow({ [field]: 'target' }), makeRow({ [field]: null })];
    const result = aggregateBudgetCalls(rows, budgetFixture({ scope: { type, value: 'Target' } }), window);
    assert.equal(result.calls.total, 1, 'only the exact-case match counts');
  });
}

test('scope: "tag" matches when the call tags contain the value; a call with two tags counts toward each tag budget independently', () => {
  const window = { start: 0, end: 10_000_000_000_000 };
  const rows = [makeRow({ tags: ['prod', 'eu'] })];
  const prodBudget = budgetFixture({ scope: { type: 'tag', value: 'prod' } });
  const euBudget = budgetFixture({ scope: { type: 'tag', value: 'eu' } });
  const otherBudget = budgetFixture({ scope: { type: 'tag', value: 'staging' } });
  assert.equal(aggregateBudgetCalls(rows, prodBudget, window).calls.total, 1);
  assert.equal(aggregateBudgetCalls(rows, euBudget, window).calls.total, 1);
  assert.equal(aggregateBudgetCalls(rows, otherBudget, window).calls.total, 0);
});

// -------------------------------------------------------------
// Basis and cost source rules (rule 3)
// -------------------------------------------------------------

test('basis "reported" ignores an estimated cost entirely', () => {
  const window = { start: 0, end: 10_000_000_000_000 };
  const rows = [makeRow({ cost: null, costSource: 'unknown', estimateStatus: 'estimated', estimatedCostNano: 5_000_000_000, estimatedCurrency: 'USD', pricingVersion: 1 })];
  const result = aggregateBudgetCalls(rows, budgetFixture({ basis: 'reported' }), window);
  assert.equal(result.calls.unknownCost, 1);
  assert.equal(result.calls.withCost, 0);
  assert.equal(result.estimatedSum, 0);
});

test('basis "reported_plus_estimated" uses the estimate only when no reported cost is usable, never both', () => {
  const window = { start: 0, end: 10_000_000_000_000 };
  const bothRow = makeRow({ cost: 2, currency: 'USD', costSource: 'provider-reported', estimateStatus: 'estimated', estimatedCostNano: 5_000_000_000, estimatedCurrency: 'USD', pricingVersion: 1 });
  const estimateOnlyRow = makeRow({ cost: null, costSource: 'unknown', estimateStatus: 'estimated', estimatedCostNano: 3_000_000_000, estimatedCurrency: 'USD', pricingVersion: 2 });
  const budget = budgetFixture({ basis: 'reported_plus_estimated' });
  const result = aggregateBudgetCalls([bothRow, estimateOnlyRow], budget, window);
  assert.equal(result.calls.withCost, 2);
  assert.equal(result.reportedSum, 2, 'the row with both counts as reported only, never double counted');
  assert.equal(result.estimatedSum, 3);
  assert.deepEqual(result.pricingVersions, [2], 'only the estimate that actually counted contributes a pricing version');
});

test('a numeric cost with costSource "unknown" is never trusted, under either basis', () => {
  const window = { start: 0, end: 10_000_000_000_000 };
  const rows = [makeRow({ cost: 99, currency: 'USD', costSource: 'unknown' })];
  for (const basis of ['reported', 'reported_plus_estimated']) {
    const result = aggregateBudgetCalls(rows, budgetFixture({ basis }), window);
    assert.equal(result.calls.unknownCost, 1, `basis ${basis}`);
    assert.equal(result.calls.withCost, 0, `basis ${basis}`);
  }
});

test('llm.failed without a cost is excluded from every counter; with a cost it counts like any other row', () => {
  const window = { start: 0, end: 10_000_000_000_000 };
  const failedNoCost = makeRow({ eventType: 'llm.failed', cost: null, costSource: 'unknown' });
  const failedWithCost = makeRow({ eventType: 'llm.failed', cost: 1, currency: 'USD', costSource: 'provider-reported' });
  const result = aggregateBudgetCalls([failedNoCost, failedWithCost], budgetFixture(), window);
  assert.equal(result.calls.total, 1, 'the costless failed row is invisible to every counter');
  assert.equal(result.calls.withCost, 1);
  assert.equal(result.reportedSum, 1);
});

// -------------------------------------------------------------
// Currency rules (rule 4)
// -------------------------------------------------------------

test('a cost in another currency is otherCurrency, never converted', () => {
  const window = { start: 0, end: 10_000_000_000_000 };
  const rows = [makeRow({ cost: 5, currency: 'EUR', costSource: 'provider-reported' })];
  const result = aggregateBudgetCalls(rows, budgetFixture({ currency: 'USD' }), window);
  assert.equal(result.calls.otherCurrency, 1);
  assert.equal(result.calls.withCost, 0);
  assert.equal(result.reportedSum, 0);
});

test('a cost with no currency is missingCurrency, never assumed to be the budget currency', () => {
  const window = { start: 0, end: 10_000_000_000_000 };
  const rows = [makeRow({ cost: 5, currency: null, costSource: 'provider-reported' })];
  const result = aggregateBudgetCalls(rows, budgetFixture({ currency: 'USD' }), window);
  assert.equal(result.calls.missingCurrency, 1);
  assert.equal(result.calls.withCost, 0);
});

test('calls.total always equals the sum of the four partitions', () => {
  const window = { start: 0, end: 10_000_000_000_000 };
  const rows = [
    makeRow({ cost: 1, currency: 'USD', costSource: 'provider-reported' }),
    makeRow({ cost: 1, currency: 'EUR', costSource: 'provider-reported' }),
    makeRow({ cost: 1, currency: null, costSource: 'provider-reported' }),
    makeRow({ cost: null, costSource: 'unknown' }),
  ];
  const result = aggregateBudgetCalls(rows, budgetFixture(), window);
  assert.equal(result.calls.total, result.calls.withCost + result.calls.unknownCost + result.calls.otherCurrency + result.calls.missingCurrency);
});

// -------------------------------------------------------------
// State evaluation (rules 5-8)
// -------------------------------------------------------------

function statusFor(rows, budgetOverrides, now = 1_000_000) {
  const budget = budgetFixture(budgetOverrides);
  const window = { start: 0, end: 10_000_000_000_000 };
  const aggregates = aggregateBudgetCalls(rows, budget, window);
  return evaluateBudget(budget, aggregates, now, window);
}

test('a window with zero in-scope calls and complete history is ok, spent: 0', () => {
  const status = statusFor([], { limit: 10 });
  assert.equal(status.state, 'ok');
  assert.equal(status.spent, 0);
  assert.equal(status.calls.total, 0);
});

test('any in-scope call without a usable cost makes the state unknown, never ok/warning, even near the limit', () => {
  const rows = [makeRow({ cost: 9, currency: 'USD', costSource: 'provider-reported' }), makeRow({ cost: null, costSource: 'unknown' })];
  const status = statusFor(rows, { limit: 10, warningRatio: 0.8 }); // knownSpent 9 >= 10*0.8, would be "warning" if provable
  assert.equal(status.state, 'unknown');
  assert.equal(status.spent, null);
  assert.equal(status.ratio, null);
  assert.equal(status.limitRemaining, null);
  assert.deepEqual(status.unknownReasons, ['unknown_cost']);
  assert.equal(status.knownSpent, 9);
});

test('a provable breach (knownSpent >= limit) is exceeded even while other calls are unknown', () => {
  const rows = [makeRow({ cost: 11, currency: 'USD', costSource: 'provider-reported' }), makeRow({ cost: null, costSource: 'unknown' })];
  const status = statusFor(rows, { limit: 10 });
  assert.equal(status.state, 'exceeded');
  assert.equal(status.spent, null, 'the figure stays incomplete even when the state is provably exceeded');
  assert.ok(status.unknownReasons.includes('unknown_cost'));
});

test('currency_mismatch and missing_currency each make the state unknown', () => {
  const mismatch = statusFor([makeRow({ cost: 1, currency: 'EUR' })], { limit: 10, currency: 'USD' });
  assert.equal(mismatch.state, 'unknown');
  assert.deepEqual(mismatch.unknownReasons, ['currency_mismatch']);

  const missing = statusFor([makeRow({ cost: 1, currency: null })], { limit: 10, currency: 'USD' });
  assert.equal(missing.state, 'unknown');
  assert.deepEqual(missing.unknownReasons, ['missing_currency']);
});

test('thresholds: warning at limit*warningRatio, exceeded at limit, exact equality resolves deterministically', () => {
  assert.equal(statusFor([makeRow({ cost: 7.999 })], { limit: 10, warningRatio: 0.8 }).state, 'ok');
  assert.equal(statusFor([makeRow({ cost: 8 })], { limit: 10, warningRatio: 0.8 }).state, 'warning', 'exact equality to the warning threshold is warning');
  assert.equal(statusFor([makeRow({ cost: 10 })], { limit: 10, warningRatio: 0.8 }).state, 'exceeded', 'exact equality to the limit is exceeded');
});

test('float noise does not flip a state: 0.1 + 0.2 against a limit of 0.3 is exceeded, not warning', () => {
  const rows = [makeRow({ cost: 0.1 }), makeRow({ cost: 0.2 })];
  const status = statusFor(rows, { limit: 0.3, warningRatio: 0.8 });
  assert.equal(status.state, 'exceeded');
  assert.equal(status.spent, 0.3);
});

test('warningRatio threshold itself tolerates float noise: 0.8 * 0.1-style products resolve deterministically', () => {
  // limit 0.1, warningRatio chosen so limit*warningRatio is a classic float-noise value (0.1 * 0.7 !== 0.06999...
  // in naive floating point); the rounding rule must make this land on warning, not ok, at the boundary.
  const status = statusFor([makeRow({ cost: 0.07 })], { limit: 0.1, warningRatio: 0.7 });
  assert.equal(roundBudgetAmount(0.1 * 0.7), 0.07);
  assert.equal(status.state, 'warning');
});

test('history_truncated makes the state unknown unless the breach is already provable', () => {
  const window = { start: 0, end: 10_000_000_000_000 };
  const budget = budgetFixture({ limit: 10 });
  const truncatedAggregates = { ...aggregateBudgetCalls([makeRow({ cost: 1 })], budget, window), historyTruncated: true };
  const unknownStatus = evaluateBudget(budget, truncatedAggregates, 1_000_000, window);
  assert.equal(unknownStatus.state, 'unknown');
  assert.deepEqual(unknownStatus.unknownReasons, ['history_truncated']);

  const exceededAggregates = { ...aggregateBudgetCalls([makeRow({ cost: 11 })], budget, window), historyTruncated: true };
  const exceededStatus = evaluateBudget(budget, exceededAggregates, 1_000_000, window);
  assert.equal(exceededStatus.state, 'exceeded', 'a provable breach wins even over truncated history');
  assert.deepEqual(exceededStatus.unknownReasons, ['history_truncated']);
});

test('evaluationErrorStatus: state unknown, evaluation_error, spent null', () => {
  const window = { start: 0, end: 1 };
  const status = evaluationErrorStatus(window, 1_000_000);
  assert.equal(status.state, 'unknown');
  assert.deepEqual(status.unknownReasons, ['evaluation_error']);
  assert.equal(status.spent, null);
  assert.equal(status.knownSpent, 0);
});

test('breakdown.reported + breakdown.estimated equals knownSpent, and containsEstimates reflects only the counted estimate', () => {
  const rows = [
    makeRow({ cost: 4, currency: 'USD', costSource: 'provider-reported' }),
    makeRow({ cost: null, costSource: 'unknown', estimateStatus: 'estimated', estimatedCostNano: 2_000_000_000, estimatedCurrency: 'USD', pricingVersion: 3 }),
  ];
  const status = statusFor(rows, { limit: 100, basis: 'reported_plus_estimated' });
  assert.equal(status.breakdown.reported, 4);
  assert.equal(status.breakdown.estimated, 2);
  assert.equal(status.knownSpent, 6);
  assert.ok(status.containsEstimates);
  assert.deepEqual(status.pricingVersions, [3]);
});

// -------------------------------------------------------------
// Seeded property-style loop: for random rows, the state is never ok/warning while any call is uncounted, and
// the calls partition invariant always holds.
// -------------------------------------------------------------

function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: state is never ok/warning when any call is unknownCost/otherCurrency/missingCurrency, and the partition always sums to total', () => {
  const random = mulberry32(42);
  const window = { start: 0, end: 10_000_000_000_000 };
  const currencies = ['USD', 'EUR', null];
  const costSources = ['provider-reported', 'estimated', 'unknown'];

  for (let trial = 0; trial < 200; trial++) {
    const rowCount = 1 + Math.floor(random() * 12);
    const rows = [];
    for (let i = 0; i < rowCount; i++) {
      const hasCost = random() < 0.7;
      rows.push(
        makeRow({
          eventType: random() < 0.1 ? 'llm.failed' : 'llm.usage',
          cost: hasCost ? Math.round(random() * 1000) / 100 : null,
          currency: hasCost ? currencies[Math.floor(random() * currencies.length)] : null,
          costSource: hasCost ? costSources[Math.floor(random() * costSources.length)] : 'unknown',
        })
      );
    }
    const basis = random() < 0.5 ? 'reported' : 'reported_plus_estimated';
    const budget = budgetFixture({ basis, limit: 5 });
    const aggregates = aggregateBudgetCalls(rows, budget, window);
    assert.equal(
      aggregates.calls.total,
      aggregates.calls.withCost + aggregates.calls.unknownCost + aggregates.calls.otherCurrency + aggregates.calls.missingCurrency,
      `trial ${trial}: partition invariant`
    );
    const status = evaluateBudget(budget, aggregates, 1_000_000, window);
    const hasUncounted = aggregates.calls.unknownCost + aggregates.calls.otherCurrency + aggregates.calls.missingCurrency > 0;
    if (hasUncounted) {
      assert.ok(status.state === 'unknown' || status.state === 'exceeded', `trial ${trial}: state was "${status.state}" with uncounted calls present`);
    }
  }
});
