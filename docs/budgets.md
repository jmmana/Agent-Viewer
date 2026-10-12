# Budgets

Issue #85 ("Budgets engine: per agent, model, session, user or tag, with server-computed state"), milestone
v0.6.0, implemented across five sub-issues: #302 (pure evaluation engine), #303 (storage), #304 (CRUD API plus
the `snapshot.budgets` field), #305 (live SSE transitions) and #306 (SDK `budgets()` helpers). This document and
the performance benchmark are #307, the last sub-issue, which closes #85 itself.

A budget answers one question reliably, computed once on the server from the same usage ledger an auditor can
export: for this agent, model, session, user or tag, over this day, week or month, is spend `ok`, `warning`,
`exceeded` or `unknown`? The embeddable library never computes this itself (README.md's own privacy rule); it
only ever receives an already-computed state through host props (`showBudget`/`budgetStateByAgent`, [the library
guide](library.md#budget-state), [español](library.es.md#estado-de-presupuesto)).

## Concepts

### Scope

A budget's `scope` picks which calls in the ledger count toward it:

| `scope.type` | Matches | `scope.value` |
|---|---|---|
| `all` | Every in-scope call. | Must be `null`. |
| `agent` | The event's `agentId`. | The agent id, exactly, case sensitive. |
| `model` | The reported model id. | The model id, exactly, case sensitive. |
| `session` | The event's `sessionId`. | The session id, exactly, case sensitive. |
| `user` | The attribution user (issue #64). | The user id, exactly, case sensitive. |
| `tag` | A call whose tags contain the value. | The tag, exactly, case sensitive. |

Matching never trims or case-folds the stored value. A call with several tags counts toward every tag budget
whose value it carries: budgets are independent views over the ledger, not a partition, so overlapping budgets
(an agent budget and a tag budget both covering the same call) are expected and both update independently.

### Period, timezone and the window

`period` is `day`, `week` (ISO, Monday 00:00 start) or `month` (calendar month). `timezone` is any IANA name
`Intl.DateTimeFormat` accepts (default `UTC`) and decides where that day, week or month starts and ends in wall
clock time: `window.start`/`window.end` in every response are the epoch milliseconds of that boundary, computed
correctly across a daylight-saving change (a day can be 23, 24 or 25 hours long in a timezone that observes DST;
a wall clock that does not exist at a spring-forward gap resolves to the first valid instant at or after it, one
that happens twice at a fall-back resolves to the earlier instant). A call belongs to a window by the **server
receive time** stored in the ledger, never by the client-supplied `timestamp`: an event whose clock is a year off
still lands in the window the server received it in.

### Basis: reported vs. estimated

`basis` decides which cost column of the ledger a budget reads:

- `reported`: only the provider-reported cost (`costSource: 'provider-reported'`). A call with no reported cost
  is an unknown-cost call for this budget, even if the ledger's own ingestion-time price estimate (issue #84)
  could have covered it.
- `reported_plus_estimated`: the reported cost when the call has one, otherwise the ledger's own estimated cost.
  A call is never counted twice: when both exist, only the reported figure counts. A call with neither is still
  an unknown-cost call.

A numeric `cost` column with `costSource: 'unknown'` is never trusted under either basis (an event can report a
number and still mark it unknown; this engine takes that label at face value). The response always labels how
much of `knownSpent` came from each source: `breakdown.reported` and `breakdown.estimated`, and
`containsEstimates` is `true` whenever any part of the figure is an estimate, so a UI can flag it rather than
present an estimate as a confirmed bill.

### The four states, and `unknownReason`

| `state` | Meaning |
|---|---|
| `ok` | The known spend is below `limit * warningRatio`, and every in-scope call was countable. |
| `warning` | The known spend is at or above `limit * warningRatio` but below `limit`, and every in-scope call was countable. |
| `exceeded` | The known spend alone is already at or above `limit` (costs are never negative, so this is provable even while other calls remain unknown), or the fully known spend is at or above `limit` with nothing unknown. |
| `unknown` | At least one in-scope call could not be counted, and the known spend alone does not already prove `exceeded`. |

A budget is **never** `ok` or `warning` because an incomplete figure happens to look small: the rule "an unknown
figure is never shown as zero" (README.md's own usage rule) applies here too. When `state` is `unknown`,
`spent`/`ratio`/`limitRemaining` are all `null` (never a guessed number), while `knownSpent` is always a real,
non-null lower bound and `calls` says exactly why the figure is incomplete.

`unknownReasons` is a list, so more than one can apply at once:

| `unknownReason` | Why |
|---|---|
| `unknown_cost` | At least one in-scope call has no usable cost under the chosen `basis`. |
| `currency_mismatch` | At least one in-scope call's cost is in a currency other than the budget's own. No conversion ever happens. |
| `missing_currency` | At least one in-scope call has a cost with no currency at all. Never assumed to be the budget's own currency. |
| `history_truncated` | The ledger cannot prove it holds every row inside the window: the memory store's row cap dropped some, or the window starts before the point the ledger is known to be complete from. |
| `evaluation_error` | The underlying ledger query itself failed. Logged server side with the budget id; the response still answers `200` with this budget `unknown`, never a `5xx` for one bad budget. |

`exceeded` can still carry non-empty `unknownReasons`: the engine reports a provable breach even while some calls
remain uncountable, rather than waiting for a complete figure that will only ever confirm what is already true.

### Arithmetic

Every sum and every threshold comparison (including `limit * warningRatio`) is rounded to 8 decimal places before
being compared, so float noise on a long sum of small costs can never flip a state at the boundary.

## The CRUD API

All six routes are under `/api/v1`, behind the same Bearer token check as every other route (see the Security
table in the main [README](../README.md)). Every write accepts an optional `X-Agent-Viewer-Actor` header (1 to
120 characters, free text, not a verified identity until scoped keys exist, issue #108) and records both it and
whether the token check was active (`auth`: `"token"` or `"open"`) in the revision log.

### `POST /api/v1/budgets`

Required: `name` (1-120 chars), `scope`, `period`, `currency` (3-letter ISO 4217), `basis`, `limit` (finite, `> 0`,
`<= 1e12`, in `currency`). Optional: `timezone` (default `"UTC"`), `warningRatio` (default `0.8`, must be strictly
between 0 and 1), `enabled` (default `true`), `id` (normally generated as `"bud_" + UUID`; an explicit one lets a
script pin a deterministic id). Unknown fields are rejected, not stored. At most 500 non-deleted budgets at once.

Request and the real response (captured against the running server; the `"..."` in `status` is filled from the
ledger at creation time, here zero spend on a brand-new budget):

```json
// POST /api/v1/budgets
{
  "name": "Builder monthly",
  "scope": { "type": "agent", "value": "builder" },
  "period": "month",
  "currency": "USD",
  "basis": "reported_plus_estimated",
  "limit": 50
}
```

```json
// 201
{
  "id": "bud_097068f1-8a60-40fe-a317-1ad21d737644",
  "name": "Builder monthly",
  "scope": { "type": "agent", "value": "builder" },
  "period": "month",
  "timezone": "UTC",
  "currency": "USD",
  "basis": "reported_plus_estimated",
  "limit": 50,
  "warningRatio": 0.8,
  "enabled": true,
  "revision": 1,
  "createdAt": 1791767378412,
  "updatedAt": 1791767378412,
  "status": {
    "state": "ok",
    "window": { "start": 1790812800000, "end": 1793491200000 },
    "spent": 0, "spentComplete": true, "knownSpent": 0,
    "breakdown": { "reported": 0, "estimated": 0 },
    "containsEstimates": false,
    "limitRemaining": 50, "ratio": 0,
    "calls": { "total": 0, "withCost": 0, "unknownCost": 0, "otherCurrency": 0, "missingCurrency": 0 },
    "unknownReasons": [], "pricingVersions": [],
    "evaluatedAt": 1791767378412
  }
}
```

A bad body gets `400 validation_failed` with one entry per bad field (real response, for a body with an empty
`name`, a `scope.value` on `type: "all"`, a lowercase `currency` and a negative `limit`):

```json
{
  "error": "validation_failed",
  "issues": [
    { "path": "name", "message": "must be 1 to 120 characters" },
    { "path": "scope.value", "message": "must be null when scope.type is \"all\"" },
    { "path": "currency", "message": "must be a 3 letter uppercase ISO 4217 code" },
    { "path": "limit", "message": "must be finite, greater than 0 and at most 1e12" }
  ]
}
```

A repeated `id`, including the id of a budget already soft-deleted (ids are never reused, so the revision history
stays coherent), is `409 { "error": "budget_exists" }`.

### `GET /api/v1/budgets`

Optional query filters: `state` (one of the four states; a disabled budget has no state, so this always excludes
it), `scopeType`, `scopeValue`. An invalid filter value is `400 validation_failed`. Real response after ingesting
one reported call for `builder` and a mixed reported/unknown pair for `gpt-4o` (two budgets, one `warning`, one
`unknown`):

```json
{
  "schemaVersion": "1.0",
  "generatedAt": 1791767378441,
  "count": 2,
  "budgets": [
    {
      "id": "bud_097068f1-8a60-40fe-a317-1ad21d737644",
      "name": "Builder monthly",
      "scope": { "type": "agent", "value": "builder" },
      "period": "month", "timezone": "UTC", "currency": "USD",
      "basis": "reported_plus_estimated", "limit": 50, "warningRatio": 0.8,
      "enabled": true, "revision": 1,
      "createdAt": 1791767378412, "updatedAt": 1791767378412,
      "status": {
        "state": "warning",
        "window": { "start": 1790812800000, "end": 1793491200000 },
        "spent": 41.2, "spentComplete": true, "knownSpent": 41.2,
        "breakdown": { "reported": 41.2, "estimated": 0 },
        "containsEstimates": false,
        "limitRemaining": 8.8, "ratio": 0.8240000000000001,
        "calls": { "total": 1, "withCost": 1, "unknownCost": 0, "otherCurrency": 0, "missingCurrency": 0 },
        "unknownReasons": [], "pricingVersions": [],
        "evaluatedAt": 1791767378440
      }
    },
    {
      "id": "bud_3b01f849-d90b-4322-b35e-18fcc739dcbd",
      "name": "gpt-4o weekly (reported only)",
      "scope": { "type": "model", "value": "gpt-4o" },
      "period": "week", "timezone": "America/Mexico_City", "currency": "USD",
      "basis": "reported", "limit": 20, "warningRatio": 0.8,
      "enabled": true, "revision": 1,
      "createdAt": 1791767378433, "updatedAt": 1791767378433,
      "status": {
        "state": "unknown",
        "window": { "start": 1791180000000, "end": 1791784800000 },
        "spent": null, "spentComplete": false, "knownSpent": 12.3,
        "breakdown": { "reported": 12.3, "estimated": 0 },
        "containsEstimates": false,
        "limitRemaining": null, "ratio": null,
        "calls": { "total": 2, "withCost": 1, "unknownCost": 1, "otherCurrency": 0, "missingCurrency": 0 },
        "unknownReasons": ["unknown_cost"], "pricingVersions": [],
        "evaluatedAt": 1791767378440
      }
    }
  ]
}
```

`GET /api/v1/budgets?state=unknown` against the same two budgets returns only the second one, same shape, with
`count: 1`.

### `GET /api/v1/budgets/:id`

One `BudgetView`, same shape as one entry above. `404 { "error": "budget_not_found" }` if the id does not exist
or was deleted.

### `PUT /api/v1/budgets/:id`

Replaces the whole configuration (same body as `POST`; an `id` in the body must be absent or equal to the URL
id). `revision` increments by one and a new revision row is written, unless the submitted configuration is
byte-for-byte identical to the current one, in which case it is a no-op: `200` with the unchanged view, no new
revision. `404` if the budget does not exist or is deleted.

Lowering `limit` from 50 to 30 against the budget above, with its known spend still 41.2, flips it straight to
`exceeded` (real response):

```json
{
  "id": "bud_097068f1-8a60-40fe-a317-1ad21d737644",
  "name": "Builder monthly",
  "scope": { "type": "agent", "value": "builder" },
  "period": "month", "timezone": "UTC", "currency": "USD",
  "basis": "reported_plus_estimated", "limit": 30, "warningRatio": 0.8,
  "enabled": true, "revision": 2,
  "createdAt": 1791767378412, "updatedAt": 1791767378446,
  "status": {
    "state": "exceeded",
    "window": { "start": 1790812800000, "end": 1793491200000 },
    "spent": 41.2, "spentComplete": true, "knownSpent": 41.2,
    "breakdown": { "reported": 41.2, "estimated": 0 },
    "containsEstimates": false,
    "limitRemaining": -11.2, "ratio": 1.3733333333333335,
    "calls": { "total": 1, "withCost": 1, "unknownCost": 0, "otherCurrency": 0, "missingCurrency": 0 },
    "unknownReasons": [], "pricingVersions": [],
    "evaluatedAt": 1791767378446
  }
}
```

### `DELETE /api/v1/budgets/:id`

Soft delete: `204` with no body, one `action: "delete"` revision written. `404` if the budget does not exist or
is already deleted. The budget and its revisions are kept, just excluded from `GET`/`GET list` from then on; a
later `GET /api/v1/budgets/:id` for it is `404`.

### `GET /api/v1/budgets/:id/revisions`

The append-only change history, oldest first, including a deleted budget's. `404` only for an id that never
existed at all. Real response for the budget above after its one `PUT`:

```json
[
  {
    "revision": 1, "action": "create", "changedAt": 1791767378412,
    "actor": null, "auth": "token",
    "config": {
      "id": "bud_097068f1-8a60-40fe-a317-1ad21d737644", "name": "Builder monthly",
      "scope": { "type": "agent", "value": "builder" }, "period": "month", "timezone": "UTC",
      "currency": "USD", "basis": "reported_plus_estimated", "limit": 50, "warningRatio": 0.8,
      "enabled": true, "revision": 1, "createdAt": 1791767378412, "updatedAt": 1791767378412
    }
  },
  {
    "revision": 2, "action": "update", "changedAt": 1791767378446,
    "actor": null, "auth": "token",
    "config": {
      "id": "bud_097068f1-8a60-40fe-a317-1ad21d737644", "name": "Builder monthly",
      "scope": { "type": "agent", "value": "builder" }, "period": "month", "timezone": "UTC",
      "currency": "USD", "basis": "reported_plus_estimated", "limit": 30, "warningRatio": 0.8,
      "enabled": true, "revision": 2, "createdAt": 1791767378412, "updatedAt": 1791767378446
    }
  }
]
```

`actor` is `null` here because the demo never sent `X-Agent-Viewer-Actor`; `auth` is `"token"` because the demo
server had `AGENT_VIEWER_API_TOKEN` configured. On a server with no token configured at all, every write is
`auth: "open"`, which is also why `/health` and the startup log warn about an open server (see the main
[README](../README.md)'s security notes): anyone who can reach that server can raise or lower a limit.

## `GET /api/v1/snapshot`: the `budgets` field

`snapshot.budgets` is an array of the same `BudgetView` shape as `GET /api/v1/budgets`, additive to the existing
snapshot (`schemaVersion` stays `"1.0"`; an older client that does not know this field simply ignores it). A
disabled budget appears with `status: null`; with no budgets configured at all, the field is `[]`. Real example,
one enabled budget after the `PUT` above:

```json
[
  {
    "id": "bud_097068f1-8a60-40fe-a317-1ad21d737644",
    "name": "Builder monthly",
    "scope": { "type": "agent", "value": "builder" },
    "period": "month", "timezone": "UTC", "currency": "USD",
    "basis": "reported_plus_estimated", "limit": 30, "warningRatio": 0.8,
    "enabled": true, "revision": 2,
    "createdAt": 1791767378412, "updatedAt": 1791767378446,
    "status": {
      "state": "exceeded",
      "window": { "start": 1790812800000, "end": 1793491200000 },
      "spent": 41.2, "spentComplete": true, "knownSpent": 41.2,
      "breakdown": { "reported": 41.2, "estimated": 0 },
      "containsEstimates": false,
      "limitRemaining": -11.2, "ratio": 1.3733333333333335,
      "calls": { "total": 1, "withCost": 1, "unknownCost": 0, "otherCurrency": 0, "missingCurrency": 0 },
      "unknownReasons": [], "pricingVersions": [],
      "evaluatedAt": 1791767378449
    }
  }
]
```

## Live updates: the `event: budget` SSE frame and `onBudgetTransition`

A state change (a matching usage event, a configuration change, or a window rollover at midnight/week
start/month start) pushes a **named** SSE frame on `GET /api/v1/events/stream`:

```
event: budget
data: {"schemaVersion":"1.0","budgetId":"bud_...","budgetName":"Builder monthly","scope":{"type":"agent","value":"builder"},"period":"month","timezone":"UTC","currency":"USD","limit":30,"warningRatio":0.8,"from":"warning","to":"exceeded","direction":"up","threshold":1,"window":{"start":...,"end":...},"status":{...},"previousStatus":{...},"trigger":"ledger_event","detectedAt":...}

```

This frame carries no `id:` line on purpose: it is a live, derived signal, never stored and never replayed on
reconnect (`Last-Event-ID` never moves because of it), unlike a canonical event. A client that reconnects, or was
never connected when a transition happened, recovers the current truth with a plain `GET /api/v1/budgets/:id`;
there is nothing to "catch up" on for a value that is always computed fresh. The bundled client
(`src/integrations/realtimeClient.ts`) never surfaces this frame through `onmessage` or a `CANONICAL_EVENT_TYPES`
listener, since `budget` is deliberately not one of those types.

`previous` is `null` only for the very first evaluation of a budget (nothing to diff against yet); `direction` is
`"up"` when the new state is at least as severe as the old one on the `unknown < ok < warning < exceeded` ladder,
`"down"` otherwise (a window rollover resetting a budget back to `ok` is `"down"`). `trigger` is `"ledger_event"`
for a usage event that moved the needle, or `"window_rollover"` for the unref'd background sweep that notices a
budget falling back to `ok` purely because its window reset, even with zero new matching calls near the
boundary.

For server-side integrations (budget alert delivery, issue #86, built on top of this), `onBudgetTransition(listener)`
(exported from `server/budgets.ts`) subscribes to the exact same transitions in-process, with no HTTP or SSE
involved; a failing listener is caught and logged, never allowed to break another subscriber or the SSE
broadcast.

## SDKs

Both SDKs expose a read-only `budgets()` next to `snapshot()`. There is no write helper in either SDK: a budget
is an operator action, not something an agent should be able to change about itself.

```python
# Python
budgets = viewer.budgets(state="warning")  # state is optional
```

```ts
// TypeScript
const { budgets } = await viewer.budgets({ state: 'warning' }); // state is optional
```

Both call `GET /api/v1/budgets`, forward the Bearer token the client was built with, and parse the same
`BudgetsResponse` shape documented above (`schemaVersion`, `generatedAt`, `count`, `budgets: BudgetView[]`); the
TypeScript SDK also exports the `Budget`, `BudgetView`, `BudgetStatus`, `BudgetScope`, `BudgetScopeType`,
`BudgetPeriod`, `BudgetBasis`, `BudgetState`, `BudgetUnknownReason`, `BudgetWindow` and `BudgetCallCounts` types.

## Alerts delivery (#86)

A `budget.alert` canonical event is emitted, server side only, the moment a budget's live evaluation transitions
into `warning` or `exceeded` (never into `ok` or `unknown`): see [`onBudgetTransition`](#live-updates-the-event-budget-sse-frame-and-onbudgettransition) above, which this feature subscribes to directly, with no HTTP or SSE in
between. There is exactly one alert per threshold crossing per period: a budget that stays `exceeded` across many
more calls in the same period does not re-fire, and it re-arms only once the period rolls over or the state
genuinely changes again. A crossing detected for an already-closed period (`backfill: true`, for example from a
re-imported history) is recorded but **never** queued for delivery.

**Delivery** is an optional outbound webhook: set `AGENT_VIEWER_ALERT_WEBHOOK_URL` to enable it; with no URL, the
feature is off and every alert's delivery stays `skipped`. Every attempt is signed with its own secret
(`AGENT_VIEWER_ALERT_WEBHOOK_SECRET`, independent of the inbound `AGENT_VIEWER_WEBHOOK_SECRET`), retried on a
network error, a timeout, `429` or a `5xx` with exponential backoff capped at one hour, and left `failed` for good
after `AGENT_VIEWER_ALERT_WEBHOOK_MAX_ATTEMPTS` (default 6). Delivery is **at least once**, so a receiver must
treat the alert id (`X-Agent-Viewer-Delivery`) as an idempotency key. Full reference, including every header, the
exact payload shape, the retry and backoff rule, the target-URL restrictions and a receiver verification snippet
in Node and Python: **[docs/webhooks.md](webhooks.md)**.

**Payload.** Metadata only, never a prompt, a tool argument or a secret: `alertId`, `budgetId`, `budgetName`,
`scope`, `period`, `state` (`warning` or `exceeded`), `threshold` (the crossed ratio), `limit`, `currency`,
`knownSpent`, `spendIsLowerBound`, `calls` (the same `BudgetCallCounts` shape as a `BudgetStatus`),
`containsEstimates`, `pricingVersions` and `detectedAt`. These are exactly the `BudgetStatus` fields this
document already defines above; the alert never invents a second vocabulary for the same figures.

**Reading alerts back.** `GET /api/v1/budget-alerts[?budgetId=&since=&limit=]` and
`GET /api/v1/budget-alerts/:alertId` (same `/api/v1` auth as every other route) list every detected alert with its
own `delivery: { status, attempts, lastStatus, deliveredAt }` and a `webhook: { configured, signed }` summary
derived only from whether the URL/secret are set, never the URL or the secret itself. There is no create, edit or
manual redeliver endpoint: an alert is a pure, read-only consequence of spend crossing a threshold.

## Portal (#88)

The demo app's Model Ops console gets a **Budgets** tab (the server-driven list: create, edit, enable/disable and
delete a budget, with its live state) and a **Pricing** tab (the price table editor described in
[docs/pricing.md](pricing.md)), both built on the typed REST client in `src/integrations/serverApi.ts`. Every
figure shown there is read, not computed: the portal never sums a budget's spend or decides a threshold itself,
it only renders the `BudgetView`/`BudgetStatus` this document already defines, exactly as the server returns it,
including an `unknown` state drawn as neutral, never as a guessed `ok`. The embedded office canvas (not the
portal) also reads this same state through the library's host-provided `showBudget`/`budgetStateByAgent` props;
see [Library](#library-87) below for how little the office itself is told.

> Screenshots of the Budgets and Pricing screens, in English and Spanish, are expected at
> `docs/assets/budgets-en.png`, `budgets-es.png`, `pricing-en.png` and `pricing-es.png`. They are not included in
> this change; capturing them against a running portal with sample data is tracked as a follow-up so this guide
> does not block on image generation.

## Library (#87)

The embeddable library never evaluates a budget, never sums spend and never compares against a limit: it only
ever draws a verdict your host already computed and passed in through `budgetStateByAgent`, hidden unless you set
`showBudget` (off by default, exactly like `showUsage`). The prop shape is intentionally thin:

```ts
type AgentBudgetState = { state: 'ok' | 'warning' | 'exceeded' | 'unknown'; label?: string };
```

There is no `limit`, `spent`, `percent`, `currency` or `threshold` field on this type, on purpose: the office
cannot compare spend against a limit because it is never given either number. An `unknown` state draws a neutral
grey marker with a `?` glyph and a dashed outline, never green and never the quiet "nothing to show" of a healthy
`ok` budget: an incomplete figure must never look the same as a confirmed healthy one. Full reference, with every
drawn state, the accessible text equivalent and the exact message keys in English and Spanish:
[docs/library.md#budget-state](library.md#budget-state) ([español](library.es.md#estado-de-presupuesto)).

## Latency and errors (#89)

Alongside cost, the same usage ledger backs measured call latency percentiles and failure rates, read with
`GET /api/v1/usage/rollup?groupBy=provider,model&include=latency,failures`. Percentiles (p50, p95) are computed by
the nearest-rank method over every reported `latencyMs` value for that group; a call with no reported latency is
excluded from the percentile but still counted in the group's own sample size, so `n = 1,102, 78 without latency`
means exactly that, never a silently smaller denominator. With zero latency samples the figure reads "No latency
reported", never `0`; with zero attempts at all it reads "No data". The failure rate comes from `llm.failed`
events (issue #46) divided by total attempts for that group, with the same "never a bare `0.0%` for a real but
tiny rate" rule the rest of this project applies (a rate strictly between 0% and 0.05% reads "< 0.1 %" instead of
rounding down to a misleading zero). There is no separate budgets-specific reliability API: this is the same
rollup endpoint budgets themselves read for cost, with two additional opt-in fields. Full reference, including the
minimum sample size below which a percentile is flagged as low-confidence rather than hidden, and the golden
fixture that hand-checks the math: [docs/integration.md](integration.md#usage-rollup-get-apiv1usagerollup-issue-66),
under "Latency and failure rates".

## Limits and honesty notes

**Budgets are monitoring, not a gate.** Agent Viewer is not a proxy: it never sits between your runtime and a
model provider, so a budget can never block, delay or reject a call, however far over its limit it already is.
Exceeding a budget changes what this product shows and, with alerts configured, what it sends you; it changes
nothing about whether the next call happens.

**Alerts depend on events arriving.** A budget's state, and therefore whether an alert fires, is only ever as
current as the usage ledger it reads. A runtime that reports a call late, or out of order, can move a budget's
state backward after the fact (a call that arrives after its period's alert already fired can still raise a
budget that briefly looked `ok` back to `warning` or `exceeded`, after the fact, with no further alert if that
combination already fired once for that period) or raise a state that had settled back down. This is the usage
ledger's own ordering guarantee (issue #65), not a budgets-specific limitation.

In `AGENT_VIEWER_STORAGE=memory`, budgets, their revisions and the last evaluated state all live in `Map`s and are
lost on restart, the same limitation the rest of memory mode already has. More importantly, the memory store caps
the retained usage ledger (`AGENT_VIEWER_USAGE_LEDGER_MAX_ROWS`, default 100,000): once a budget's window reaches
back further than what the store still holds, its state is `unknown` with `history_truncated` rather than a
silently incomplete number. `GET /ready`'s `storage` field always tells you which mode is running.

## Performance

Issue #85's own acceptance criteria set two targets, measured by an opt-in benchmark (`tests/budgets-bench.test.mjs`,
gated on `AGENT_VIEWER_BENCH=1` so it never runs in default CI): evaluating 100 enabled budgets spread across every
scope type over a 1,000,000-row SQLite ledger should take under 1.5 s cold, and a subsequent `GET /api/v1/budgets`
should answer in under 250 ms warm. Run it yourself with:

```sh
AGENT_VIEWER_BENCH=1 npx tsx --test tests/budgets-bench.test.mjs
```

As measured against the code this issue found already merged (sub-issues #302-#306), neither target is currently
met: a cold pass over 100 budgets took roughly 9 s, and a warm pass roughly 6-7 s, both well past the targets. The
root cause, visible directly in `server/budgets.ts`'s own code comments, is that two optimizations were
deliberately deferred to this issue rather than spent speculatively: `evaluateBudgetView` calls the full
`store.rollup()` (eight separate aggregate SQL statements: token sums, cost sums per currency, estimate and
comparable sums, latency/failure sidecars) on every budget just to read its `asOf.ledgerSeq`/`coverage.complete`,
and the registry's own exact-key evaluation cache (`getCachedStatus`/`setCachedStatus`) is wired for the live
SSE-transition path (`evaluateBudgetLive`, sub-issue #305) but never consulted by the plain read path
(`evaluateBudgetView`, used by both `GET /api/v1/budgets` and `snapshot.budgets`). Closing this gap (a
lighter-weight coverage/asOf read, a scope-matched pre-filter, or wiring the existing cache into the read path)
is out of this documentation-and-benchmark issue's own scope (no server production code changes); it is tracked
as a follow-up. The real numbers from the run that produced this document are in the pull request that added it.
