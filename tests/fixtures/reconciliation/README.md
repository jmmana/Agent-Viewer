# Golden reconciliation fixture (issue #62)

One hand-checked event log, with one set of hand-worked expected figures, run through four paths that each
aggregate usage on their own: the memory store, the SQLite store across a restart, the portal reducer
(`applyExternalEvent`) and the embeddable library's `summarizeUsage`. The suite that runs it is
`tests/reconciliation.test.mjs` (`npm run test:golden`).

All data is synthetic: agents `ana`, `bruno` and `dana`, provider `synthetic`, models `model-alpha`,
`model-beta`, `model-gamma` and `model-delta`, timestamps starting at `T0 = 2026-01-15T14:00:00Z`
(`1768485600000`), one second apart in file order.

## Files

- `golden.events.jsonl`: the 11 fixture lines below, in file order (not sorted by timestamp). Loaded with
  `parseEventLog`, which must report 0 issues and 11 events.
- `golden.webhook-canonical.json`: the canonical `llm.usage` event a webhook delivery would decode to (`dana`,
  `model-gamma`, `req_d1`), appended directly by the store-level runs as `evt_g_w01`. This PR does not spin up
  the real webhook route (see "Deferred" below), so this is the simplification: the canonical event the route
  would have produced, not the HTTP delivery itself.
- `golden.accepted.jsonl`: the events a host actually sees after every duplicate, conflict and failure is
  resolved, in this order: lines 1-6, the webhook event (as `evt_g_w01`), then line 10 (the failed call). This is
  the input for the portal and library runs, which never see the raw duplicates or the conflict: they only
  process what a real server would have broadcast.
- `golden.expected.json`: `ingestion` (the outcome of every line), `server.checkpointAfterLine6` and
  `server.final` (the exact `UsageSummary` shape of `server/usageAggregates.ts`, for the memory and SQLite
  stores), `portal` (the exact `UsageTally` shape of `src/integrations/usageTally.ts`, for the total and for
  `ana`/`bruno`/`dana`) and `library` (the `OfficeUsage` shape of `src/lib/usage.ts`).

## What each line covers

| # | id | agent | type | covers |
|---|---|---|---|---|
| 1 | `evt_g_001` | ana, model-alpha | llm.usage | baseline: input 1000, output 200, cacheRead 300, USD 0.0120 |
| 2 | `evt_g_002` | ana, model-alpha | llm.usage | cache write: cacheWrite 50, USD 0.0060 |
| 3 | `evt_g_003` | bruno, model-beta | llm.usage | a different currency (EUR) and reasoning tokens (120) |
| 4 | `evt_g_004` | bruno, model-beta | llm.usage | missing cost (`cost: null`, `costSource: "unknown"`) |
| 5 | `evt_g_005` | ana, model-alpha | llm.usage | a cost with no currency |
| 6 | `evt_g_006` | ana, model-delta | llm.usage | missing cache/reasoning fields entirely (not sent as `0`), and a model switch |
| 7 | `evt_g_001` | ana | llm.usage | byte-identical copy of line 1: an `event_id` duplicate |
| 8 | `evt_g_002` | ana | llm.usage | copy of line 2 with `outputTokens: 999`: a conflicting duplicate |
| 9 | `evt_g_009` | ana | llm.usage | same figures as line 1, new id, `requestId: "req_a1"` (line 1's own): a `request_id` duplicate |
| 10 | `evt_g_010` | bruno, model-beta | llm.failed | a failed call (`errorKind: "rate_limited"`), no tokens, no cost |
| 11 | `evt_g_011` | bruno | llm.failed | copy of line 10 with a new id, same `requestId`: a `request_id` duplicate on a failure |

Lines 1-5 and the webhook event carry every cache and reasoning field explicitly (as `0` where the table says
0), so that only line 6 is "not reported" for those fields. This is what makes `cacheRead`, `cacheWrite` and
`reasoning` show exactly 1 unreported call each in the final figures.

## Hand arithmetic (`server.final.total`, before rounding)

Successful calls: lines 1-6 and the webhook event = 7. Failed calls: line 10 = 1 (lines 7-9 and 11 are
duplicates and are never counted a second time).

- `input`: 1000+500+800+300+200+100+400 = **3300**, every call reported it (`unreportedCount: 0`).
- `output`: 200+100+400+50+20+10+80 = **860**, `unreportedCount: 0`.
- `cacheRead`: 300 (line 1 only; every other call reports an explicit `0` except line 6) = **300**,
  `unreportedCount: 1` (line 6).
- `cacheWrite`: 50 (line 2 only) = **50**, `unreportedCount: 1` (line 6).
- `reasoning`: 120 (line 3 only) = **120**, `unreportedCount: 1` (line 6).
- Cost: USD = 0.0120 + 0.0060 + 0.0005 (lines 1, 2, 6) + 0.0040 (webhook) = **0.0225**; EUR = **0.0200** (line 3).
  `unknownCostCalls: 1` (line 4). `missingCurrencyCalls: 1` (line 5, which has a valid cost but no currency).

Per agent: `ana` = lines 1, 2, 5, 6 (4 calls, input 1800, output 330, USD 0.0185, 1 call with no currency).
`bruno` = lines 3, 4 successful plus line 10 failed (input 1100, output 450, reasoning 120, EUR 0.0200, 1 call
with unknown cost). `dana` = the webhook event only (input 400, output 80, USD 0.0040).

Per model: `model-alpha` = lines 1, 2, 5 (input 1700, output 320, cacheRead 300, cacheWrite 50, USD 0.0180, 1
call with no currency). `model-delta` = line 6 (input 100, output 10, cache and reasoning unreported, USD
0.0005). `model-beta` = lines 3, 4 succeeded, line 10 failed (input 1100, output 450, reasoning 120, EUR 0.0200,
1 call with unknown cost). `model-gamma` = the webhook event (input 400, output 80, USD 0.0040).

The `portal` and `library` figures follow the same arithmetic over `golden.accepted.jsonl` (8 events, the
duplicates and the conflict already resolved); see `reference.ts` for the library's display-rule derivation and
`tests/reconciliation.test.mjs` for the exact assertions. No figure is ever folded in as `0`: a value no call
reported stays in its own `unreportedCount`, `unknownCostCalls` or `missingCurrencyCalls` counter, and a cost
with no currency is never added into any `byCurrency` entry.

## Updating this fixture

Any change to `golden.expected.json` must be explained in the pull request: which line changed, and why the
hand-worked numbers moved. The `reference(fixture)` oracle (`tests/reconciliation/reference.ts`) is an
independent re-derivation of the same rules; if it stops agreeing with `golden.expected.json`, one of the two is
wrong.

## Deferred (not in this fixture or suite)

This PR ships the fixture and four reconciliation paths: the memory store, the SQLite store across a restart,
the portal reducer and the library. The full issue #62 also describes:

- A `memory-evicting` run (`MemoryEventStore` with a small retained window).
- An `http` run through the real Express app, including the real webhook route with HMAC-signed retries
  (`golden.webhooks.json`, W1/W2/W3) and the `PATCH /api/v1/agents/:id` rejection path (`golden.patch.json`).
- A separate `http-signed` process for the webhook secret case.
- A Vitest `library-privacy` suite for `<AgentOffice>`'s rendering rules.

None of these are blocked on a missing dependency: issues #47, #48, #49, #50, #52, #53, #55 and #56 are all
already on `main`. This is a scope cut to ship a complete, green vertical slice rather than a half-built one; see
the pull request for the reasoning. A follow-up PR can add the HTTP-level fixtures and runs on top of this same
`golden.expected.json` without changing the figures already here.
