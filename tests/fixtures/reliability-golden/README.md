# Golden reliability fixture (issue #89)

Issue #89's own "Golden reconciliation (#62 suite)" line asks for "a fixture whose expected p50, p95 and failure
rate are computed by hand and committed as JSON". This follows the exact pattern the #62 golden reconciliation
suite already established (`tests/fixtures/reconciliation/`, `tests/reconciliation.test.mjs`): one hand-checked
event log, one committed `golden.expected.json` with the arithmetic written down below, and a test
(`tests/reliability-golden.test.mjs`) that feeds the raw events through the real `MemoryEventStore` and
`SQLiteEventStore` and asserts a byte-for-byte match. It is a separate, smaller fixture rather than an extension of
`tests/fixtures/reconciliation/golden.events.jsonl`, because that fixture only ever reports one `latencyMs` value
in total (by design, see its own README) and is not meant to exercise a nearest-rank percentile over a real sample
set; this fixture is scoped to `include=latency,failures` the same way the #62 fixture is scoped to tokens and
cost.

All data is synthetic: agents `ana`, `bruno`, `dana` and `erin`, provider `synthetic`, models `model-fast` and
`model-steady`, timestamps starting at `T0 = 2026-02-01T10:40:00Z` (`1769904000000`), one second apart in file
order.

## Files

- `golden.events.jsonl`: 18 lines in file order (not sorted by timestamp). Loaded with `parseEventLog`, which must
  report 0 issues and 18 events.
- `golden.expected.json`: `ingestion` (the outcome of every line) and `rollup` (the `groupBy=model,
  include=latency,failures` response's `calls`, `failedCalls`, `attempts`, `failureRate`, `failures` and `latency`
  fields, per group and in `totals`). Token and cost fields are deliberately not asserted here; that is the #62
  fixture's job.

## What each line covers

| # | id | agent, model | type | covers |
|---|---|---|---|---|
| 1 | `evt_r_001` | ana, model-fast | llm.usage | latencyMs 100 |
| 2 | `evt_r_002` | ana, model-fast | llm.usage | latencyMs 120 |
| 3 | `evt_r_003` | bruno, model-fast | llm.usage | latencyMs 110 |
| 4 | `evt_r_004` | bruno, model-fast | llm.usage | latencyMs 130 |
| 5 | `evt_r_005` | ana, model-fast | llm.usage | latencyMs 90 |
| 6 | `evt_r_006` | bruno, model-fast | llm.usage | latencyMs 1000 (a slow outlier, to make p95 bite) |
| 7 | `evt_r_007` | ana, model-fast | llm.usage | `latencyMs` not reported (absent, never `0`): counts in `missing`, not in the sample set |
| 8 | `evt_r_008` | bruno, model-fast | llm.failed | `errorKind: "timeout"` |
| 9-13 | `evt_r_009`..`evt_r_013` | dana, model-steady | llm.usage | latencyMs 200, five identical calls (a flat distribution: p50 = p95 = 200) |
| 14 | `evt_r_014` | dana, model-steady | llm.failed | `errorKind: "rate_limited"` (the one case `rateLimitCount` must count) |
| 15 | `evt_r_015` | dana, model-steady | llm.failed | `errorKind` not reported at all: falls back to the schema default `"unknown"`, which the rollup buckets as `"unspecified"` |
| 16 | `evt_r_016` | erin, no model | llm.failed | `errorKind: "rate_limited"`, no `model` field at all (a connection failure before a model was chosen, issue #59): its own `model: null` group, never dropped |
| 17 | `evt_r_001` (repeat) | ana, model-fast | llm.usage | byte-identical copy of line 1: an `event_id` duplicate, must not inflate `samples` or `calls` |
| 18 | `evt_r_017` | bruno, model-fast | llm.failed | same figures as line 8 but a new id and `requestId: "req_f8"` (line 8's own): a `request_id` duplicate on a failure, must not inflate `failedCalls`/`attempts` |

## Hand arithmetic

### `model-fast`

Succeeded calls: lines 1-7 = 7. Line 7 reports no `latencyMs`, so the raw sample set is
`[100, 120, 110, 130, 90, 1000]` (6 samples, 1 missing; `6 + 1 = 7` succeeded calls, matching the invariant).

Sorted: `[90, 100, 110, 120, 130, 1000]`, n = 6.
- p50: rank = `ceil(0.5 * 6) - 1 = 2` (0-indexed) -> `sorted[2] = 110`.
- p95: rank = `ceil(0.95 * 6) - 1 = ceil(5.7) - 1 = 5` -> `sorted[5] = 1000`.

Failed calls: line 8 only (line 18 is a `requestId` duplicate of line 8 and is never counted again) = 1,
`errorKind: "timeout"`. `attempts = 7 + 1 = 8`. `failureRate = 1 / 8 = 0.125`. `rateLimitCount = 0` (no
`rate_limited` failure on this model).

### `model-steady`

Succeeded calls: lines 9-13 = 5, every one reporting `latencyMs: 200`. Sample set `[200, 200, 200, 200, 200]`,
n = 5, 0 missing.
- p50: rank = `ceil(0.5 * 5) - 1 = 2` -> `sorted[2] = 200`.
- p95: rank = `ceil(0.95 * 5) - 1 = ceil(4.75) - 1 = 4` -> `sorted[4] = 200`.

Failed calls: line 14 (`rate_limited`) and line 15 (no `errorKind`, bucketed `unspecified`) = 2.
`attempts = 5 + 2 = 7`. `failureRate = 2 / 7 = 0.2857142857142857`. `rateLimitCount = 1`.

### `model: null` (line 16 only)

0 succeeded calls, so `latency` is `{ p50Ms: null, p95Ms: null, samples: 0, missing: 0 }` (never `0`, and never
dropped from the response for having no model). 1 failed call (`rate_limited`). `attempts = 0 + 1 = 1`.
`failureRate = 1 / 1 = 1`. `rateLimitCount = 1`.

### `totals`

Totals are computed from the raw, pooled sample set of every matching row, never by combining the groups' own
percentiles (issue #89, rule 7). Succeeded calls: `7 + 5 + 0 = 12`. Pooled samples:
`[100, 120, 110, 130, 90, 1000, 200, 200, 200, 200, 200]` (11 samples, 1 missing; `11 + 1 = 12`, matching the
invariant).

Sorted: `[90, 100, 110, 120, 130, 200, 200, 200, 200, 200, 1000]`, n = 11.
- p50: rank = `ceil(0.5 * 11) - 1 = ceil(5.5) - 1 = 5` -> `sorted[5] = 200`.
- p95: rank = `ceil(0.95 * 11) - 1 = ceil(10.45) - 1 = 10` -> `sorted[10] = 1000`.

`totals.latency.p50Ms` (200) is neither group's own p95 and differs from `model-steady`'s own p50/p95 (200
happens to coincide with `model-steady`'s flat distribution, which is expected: a flat group's own value and a
pooled value can legitimately agree). `totals.latency.p95Ms` (1000) equals `model-fast`'s own p95 only because the
single global outlier (line 6, 1000ms) is also that group's own maximum; the point of rule 7 (totals are computed
from the raw combined sample set, not from averaging or combining the groups' own percentiles) is independently
drilled with a deliberately-non-coincidental fixture in `tests/reliability-rollups.test.mjs`'s own "rule 7" test.
This fixture's job is a believable, fully hand-checked golden figure, not to re-prove that rule a second time.

Failed calls: `1 (timeout) + 2 (steady) + 1 (null model) = 4`. `attempts = 12 + 4 = 16`. `failureRate = 4 / 16 =
0.25`. `byErrorKind`: `{ timeout: 1, rate_limited: 2, unspecified: 1 }` (the two `rate_limited` failures come from
`model-steady` line 14 and the null-model line 16). `rateLimitCount = 2`.

## Updating this fixture

Any change to `golden.expected.json` must be explained in the pull request: which line changed, and why the
hand-worked numbers moved. `tests/reliability-golden.test.mjs` also re-derives `p50Ms`/`p95Ms` with its own
nearest-rank reimplementation (never importing `server/usage/reliability.ts`) directly from the sample sets written
down above, so a fixture/expected-file mismatch is caught independently of the implementation under test.

## Deferred (not in this fixture or suite)

This fixture covers the rollup route's in-process aggregation (`groupBy=model`, `include=latency,failures`) over
`MemoryEventStore` and `SQLiteEventStore` directly, the same two backends the #62 fixture exercises. It does not
add an HTTP-level run through the real Express route, a day-bucketed (`groupBy=model,day`) golden case, or a
Model Ops (demo app) component fixture; those are already covered, respectively, by `tests/integration-api.test.mjs`,
the day-bucket tests in `tests/usage-rollup.test.mjs`, and the Vitest component tests for the reliability block
(`tests/lib/reliabilityFormat.test.ts` and the Model Ops modal's own tests). Adding every one of those as a second
golden fixture would duplicate coverage those suites already have without adding a new guarantee.
