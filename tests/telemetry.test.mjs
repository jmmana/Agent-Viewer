// Pure math for OTLP metric telemetry (issue #73): the series key and the delta/cumulative total a single
// series resolves to, including windowed queries, plus grouping into a per-session summary. No store, no
// network: everything here is `server/telemetry.ts` called directly with hand-built or randomly generated
// point arrays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sumSeriesValue, sumTelemetryBySession, computeSeriesKey } from '../server/telemetry.ts';

const SECRET = Buffer.alloc(32, 3);

function point(overrides) {
  return {
    seriesKey: 'series-a',
    temporality: 'delta',
    metricKind: 'tokens',
    tokenType: 'input',
    currency: null,
    sessionId: 'session-1',
    runtimeId: 'claude-code',
    startTimeUnixNano: '0',
    timeUnixNano: '1000',
    timeMs: 1,
    value: 0,
    ...overrides,
  };
}

// -------------------------------------------------------------
// computeSeriesKey
// -------------------------------------------------------------

test('computeSeriesKey: deterministic, keyed by the secret, and order-independent on attributes', () => {
  const a = computeSeriesKey(SECRET, 'claude_code.token.usage', [{ key: 'service.name', value: { stringValue: 'claude-code' } }], [
    { key: 'session.id', value: { stringValue: 's' } },
    { key: 'type', value: { stringValue: 'input' } },
  ]);
  const b = computeSeriesKey(SECRET, 'claude_code.token.usage', [{ key: 'service.name', value: { stringValue: 'claude-code' } }], [
    { key: 'type', value: { stringValue: 'input' } },
    { key: 'session.id', value: { stringValue: 's' } },
  ]);
  assert.equal(a, b, 'attribute order must not change the key');
  assert.match(a, /^[0-9a-f]{64}$/);

  const otherSecret = computeSeriesKey(Buffer.alloc(32, 4), 'claude_code.token.usage', [], [{ key: 'session.id', value: { stringValue: 's' } }]);
  assert.notEqual(a, otherSecret);

  const otherMetric = computeSeriesKey(SECRET, 'claude_code.cost.usage', [{ key: 'service.name', value: { stringValue: 'claude-code' } }], [
    { key: 'session.id', value: { stringValue: 's' } },
    { key: 'type', value: { stringValue: 'input' } },
  ]);
  assert.notEqual(a, otherMetric);
});

// -------------------------------------------------------------
// sumSeriesValue
// -------------------------------------------------------------

test('sumSeriesValue: delta sums every point; a repeated identical point (already deduped by the store) still just adds its value once per row', () => {
  const points = [point({ timeMs: 10, value: 5 }), point({ timeMs: 20, value: 7 }), point({ timeMs: 30, value: 3 })];
  assert.deepEqual(sumSeriesValue(points), { value: 15, mixedTemporality: false });
});

test('sumSeriesValue: delta with a window only sums points inside [since, until]', () => {
  const points = [point({ timeMs: 10, value: 5 }), point({ timeMs: 20, value: 7 }), point({ timeMs: 30, value: 3 })];
  assert.equal(sumSeriesValue(points, { since: 15, until: 25 }).value, 7);
  assert.equal(sumSeriesValue(points, { since: 10, until: 30 }).value, 15);
  assert.equal(sumSeriesValue(points, { since: 31 }).value, 0);
});

test('sumSeriesValue: cumulative takes the latest value per counter lifetime, not the sum of points', () => {
  const points = [
    point({ temporality: 'cumulative', startTimeUnixNano: 'epoch1', timeMs: 10, value: 100 }),
    point({ temporality: 'cumulative', startTimeUnixNano: 'epoch1', timeMs: 20, value: 150 }),
    point({ temporality: 'cumulative', startTimeUnixNano: 'epoch1', timeMs: 30, value: 220 }),
  ];
  assert.equal(sumSeriesValue(points).value, 220);
});

test('sumSeriesValue: a counter reset (new startTimeUnixNano, lower value) adds the new epoch total and never goes negative', () => {
  const points = [
    point({ temporality: 'cumulative', startTimeUnixNano: 'epoch1', timeMs: 10, value: 500 }),
    // Process restart: new lifetime starting lower than the old one ended.
    point({ temporality: 'cumulative', startTimeUnixNano: 'epoch2', timeMs: 20, value: 80 }),
  ];
  const total = sumSeriesValue(points);
  assert.equal(total.value, 580);
  assert.ok(total.value >= 0);
});

test('sumSeriesValue: windowed cumulative contributes the windowed difference per group, clamped at 0', () => {
  const points = [
    point({ temporality: 'cumulative', startTimeUnixNano: 'epoch1', timeMs: 10, value: 100 }),
    point({ temporality: 'cumulative', startTimeUnixNano: 'epoch1', timeMs: 20, value: 150 }),
    point({ temporality: 'cumulative', startTimeUnixNano: 'epoch1', timeMs: 30, value: 220 }),
  ];
  // [15, 25]: baseline is the latest point strictly before 15 (value 100), target is the latest at-or-before 25
  // (value 150): windowed contribution is 50.
  assert.equal(sumSeriesValue(points, { since: 15, until: 25 }).value, 50);
  // A window entirely before the series started: baseline and target resolve to the same (nonexistent) point, 0.
  assert.equal(sumSeriesValue(points, { since: 1, until: 5 }).value, 0);
  // A window entirely after the series' last point: both baseline and target are the last point, contributing 0.
  assert.equal(sumSeriesValue(points, { since: 40, until: 50 }).value, 0);
});

test('sumSeriesValue: a series mixing delta and cumulative points is flagged and excluded (value null)', () => {
  const points = [point({ temporality: 'delta', timeMs: 10, value: 5 }), point({ temporality: 'cumulative', timeMs: 20, value: 100 })];
  assert.deepEqual(sumSeriesValue(points), { value: null, mixedTemporality: true });
});

test('sumSeriesValue: an empty series totals 0, not null', () => {
  assert.deepEqual(sumSeriesValue([]), { value: 0, mixedTemporality: false });
});

// -------------------------------------------------------------
// sumTelemetryBySession
// -------------------------------------------------------------

test('sumTelemetryBySession: groups by session and field, sums across series, and tracks unmapped types', () => {
  const points = [
    point({ seriesKey: 'k1', sessionId: 'sess-a', tokenField: 'input', timeMs: 10, value: 100 }),
    point({ seriesKey: 'k2', sessionId: 'sess-a', metricKind: 'tokens', tokenField: 'output', timeMs: 10, value: 40 }),
    point({ seriesKey: 'k3', sessionId: 'sess-a', metricKind: 'tokens', tokenType: 'future_kind', tokenField: null, timeMs: 10, value: 1 }),
    point({ seriesKey: 'k4', sessionId: 'sess-a', metricKind: 'cost', tokenType: null, tokenField: null, currency: 'USD', timeMs: 10, value: 0.5 }),
    point({ seriesKey: 'k5', sessionId: 'sess-b', tokenField: 'input', timeMs: 10, value: 7 }),
  ];
  const summaries = sumTelemetryBySession(points);
  const sessA = summaries.find((s) => s.sessionId === 'sess-a');
  assert.equal(sessA.tokens.input.value, 100);
  assert.equal(sessA.tokens.output.value, 40);
  assert.equal(sessA.tokens.cacheRead.value, null);
  assert.equal(sessA.cost.value, 0.5);
  assert.equal(sessA.cost.currency, 'USD');
  assert.deepEqual(sessA.unmappedTypes, ['future_kind']);

  const sessB = summaries.find((s) => s.sessionId === 'sess-b');
  assert.equal(sessB.tokens.input.value, 7);

  // Ordered by sessionId ascending.
  assert.deepEqual(summaries.map((s) => s.sessionId), ['sess-a', 'sess-b']);
});

test('sumTelemetryBySession: points with a null sessionId are never attributed to any session', () => {
  const points = [point({ sessionId: null, tokenField: 'input', value: 999 })];
  assert.deepEqual(sumTelemetryBySession(points), []);
});

test('sumTelemetryBySession: cost is only counted for currency USD', () => {
  const points = [
    point({ seriesKey: 'k1', sessionId: 'sess-a', metricKind: 'cost', tokenField: null, currency: 'EUR', value: 5 }),
  ];
  const summary = sumTelemetryBySession(points)[0];
  assert.equal(summary.cost.value, null);
  assert.equal(summary.cost.currency, null);
});

// -------------------------------------------------------------
// Property-style tests against a straightforward, independently-written reference implementation (issue #73's
// test plan: "for random sequences of cumulative points with resets, the computed total equals a
// straightforward reference implementation; the same for random delta sequences with duplicated points").
// -------------------------------------------------------------

/** A small, seedable PRNG so a failure is reproducible (mulberry32). */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function referenceDeltaSum(points, since, until) {
  let total = 0;
  for (const p of points) {
    if (p.timeMs >= (since ?? -Infinity) && p.timeMs <= (until ?? Infinity)) total += p.value;
  }
  return total;
}

function referenceCumulativeSum(points, since, until) {
  const groups = new Map();
  for (const p of points) {
    if (!groups.has(p.startTimeUnixNano)) groups.set(p.startTimeUnixNano, []);
    groups.get(p.startTimeUnixNano).push(p);
  }
  let total = 0;
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.timeMs - b.timeMs);
    let baseline = 0;
    let target = 0;
    for (const p of sorted) {
      if (p.timeMs < (since ?? -Infinity)) baseline = p.value;
      if (p.timeMs <= (until ?? Infinity)) target = p.value;
    }
    total += Math.max(0, target - baseline);
  }
  return total;
}

test('property: random delta sequences (with duplicated timestamps) match the reference sum, with and without a window', () => {
  const rng = mulberry32(12345);
  for (let trial = 0; trial < 200; trial++) {
    const pointCount = 1 + Math.floor(rng() * 20);
    const points = [];
    for (let i = 0; i < pointCount; i++) {
      // Timestamps are drawn from a small range so duplicates happen often, on purpose.
      const timeMs = Math.floor(rng() * 10) * 100;
      points.push(point({ temporality: 'delta', timeMs, value: Math.floor(rng() * 1000) }));
    }
    const since = rng() < 0.5 ? undefined : Math.floor(rng() * 1000);
    const until = rng() < 0.5 ? undefined : Math.floor(rng() * 1000);

    const actual = sumSeriesValue(points, { since, until }).value;
    const expected = referenceDeltaSum(points, since, until);
    assert.equal(actual, expected, `trial ${trial}: since=${since} until=${until}`);
  }
});

test('property: random cumulative sequences with resets match the reference sum, with and without a window', () => {
  const rng = mulberry32(67890);
  for (let trial = 0; trial < 200; trial++) {
    const epochCount = 1 + Math.floor(rng() * 4);
    const points = [];
    let globalTime = 0;
    for (let epoch = 0; epoch < epochCount; epoch++) {
      const startTimeUnixNano = `epoch-${epoch}`;
      const stepCount = 1 + Math.floor(rng() * 6);
      let runningValue = Math.floor(rng() * 50);
      for (let step = 0; step < stepCount; step++) {
        // A counter only ever increases within one lifetime (that is what "monotonic Sum" means).
        runningValue += Math.floor(rng() * 100);
        globalTime += 1 + Math.floor(rng() * 5);
        points.push(point({ temporality: 'cumulative', startTimeUnixNano, timeMs: globalTime, value: runningValue }));
      }
    }
    const since = rng() < 0.5 ? undefined : Math.floor(rng() * globalTime);
    const until = rng() < 0.5 ? undefined : Math.floor(rng() * globalTime);

    const actual = sumSeriesValue(points, { since, until }).value;
    const expected = referenceCumulativeSum(points, since, until);
    assert.equal(actual, expected, `trial ${trial}: since=${since} until=${until}`);
    assert.ok(actual >= 0, `trial ${trial}: total must never be negative`);
  }
});
