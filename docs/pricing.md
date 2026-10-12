# Server pricing table

Issue #83 ("Versioned server pricing table", milestone v0.6.0, implemented across #270, #271 and #272). This is
the one place the full design lives; the three sub-issues built it in order:

- #270: `src/integrations/pricingContract.ts` (the data model, strict Zod schemas, `resolvePrice`,
  `computeContentHash`) and the bundled starter table, `server/pricing/starter.json`.
- #271: `server/pricing/store.ts` (the file-plus-history store, lifecycle rules, atomic writes) and the CLI
  wiring in `cli/start.ts`.
- #272: the 8 `GET`/`POST /api/v1/pricing*` endpoints in `server/pricing/api.ts`, and this document.

Prices live only on the server. The embeddable library (`@warlockcode/agent-viewer`) never receives, stores or
applies a price, and gains no props from this item (`tests/lib/pricingIsolation.test.ts` enforces this: the
library's import graph never reaches `pricingContract.ts`, `server/pricing/` or the starter file). Turning a price
table entry into an actual estimated cost on a ledger row is issue #84, built on top of this table
(`server/pricing/estimate.ts`); see [How a row gets an estimate](#how-a-row-gets-an-estimate-84) below.

## Reported, estimated, unknown

Every ledger row's cost carries one of three `costSource` values. This table is the full, binding definition
(the same one [docs/usage-semantics.md](usage-semantics.md#5-costsource-meanings) gives); it is repeated here
because an estimate is meaningless without it.

| `costSource` | Who produced the number | Can it differ from your invoice? | Shown in the portal as |
|---|---|---|---|
| `provider-reported` | Your runtime, from the provider's own response or billing API. | Agent Viewer never verifies it against your invoice; treat it as the provider's own figure, as reliable as what your runtime actually forwarded. | "Reported" |
| `estimated` | This server's versioned pricing table (this document), resolved against the call's own tokens, **or** a runtime/adapter that computed its own estimate before reporting it (for example Claude Code's own on-machine `cost_usd`). | Always, by construction: tax, discounts, committed-use and provider-side rounding are never modeled. See [What is never assumed](#what-is-never-assumed). | "Estimated" |
| `unknown` | Nobody. The default whenever nothing else is stated. | N/A: there is no figure. | "Unknown" (never shown as `0` or blended into a total) |

**Estimated and provider-reported cost are never combined into one number.** A `costSource` is part of the bucket
key everywhere a cost is summed or totaled (the rollup API, the export totals, a budget's `breakdown`): a
`provider-reported` USD total and an `estimated` USD total are two separate figures, always, with no "best
available" blended column anywhere in this product. The portal shows both, side by side, never merged (issues
#84, #88).

## File format

Two files, by default next to the SQLite database (`./data/pricing.json`, `/app/data/pricing.json` in the Docker
images):

| Env var | Default | Meaning |
|---|---|---|
| `AGENT_VIEWER_PRICING_FILE` | `pricing.json` next to `AGENT_VIEWER_SQLITE_PATH` | Operator-editable current table. |
| `AGENT_VIEWER_PRICING_HISTORY_FILE` | `pricing-history.jsonl` next to the pricing file | Append-only log, one `PricingVersion` JSON object per line. Never edit this file by hand. |
| `AGENT_VIEWER_PRICING_READONLY` | unset | `1` disables `POST /api/v1/pricing/changes` (file-only management). `POST /api/v1/pricing/reload` still works. |

The CLI (`agent-viewer start`) sets `AGENT_VIEWER_PRICING_FILE` under its own state directory when the variable
is not set, so it never writes into the current folder; see [cli.md](cli.md).

`pricing.json` shape (the server writes this; `basedOnVersion` is informational):

```json
{
  "schema": "agent-viewer.pricing/1",
  "basedOnVersion": 3,
  "entries": [
    {
      "provider": "anthropic",
      "model": "example-model",
      "aliases": [],
      "kind": "list",
      "currency": "USD",
      "effectiveFrom": "2026-01-01T00:00:00.000Z",
      "inputPerMillion": 1.0,
      "outputPerMillion": 5.0,
      "cacheReadPerMillion": 0.1,
      "cacheWritePerMillion": 1.25,
      "reasoningPerMillion": null,
      "reasoningBilling": "included_in_output",
      "source": "file",
      "estimated": false,
      "sourceUrl": "https://example.com/pricing",
      "sourceCheckedAt": "2026-10-01",
      "note": null
    }
  ]
}
```

(The numbers above are placeholders, not real prices.) A price field left out of a hand-written entry defaults to
`null` ("unknown"), never `0`. `estimated` defaults to `true` (unconfirmed) unless you set it to `false`. `source`
in a hand-written file is ignored: the server always writes `"file"` for a new or changed entry and keeps the
previous `source` for an entry that did not actually change (so a starter entry you never touched stays
`"starter"` across a reload).

## Defaults and the starter table

On first boot, with no `pricing.json` and no history yet, the server seeds the bundled starter table
(`server/pricing/starter.json`) as version 1 (`origin: "starter"`). The starter covers `openai`, `anthropic` and
`google` (the exact provider key spelling an event's `provider` field normalizes to: trimmed, lower-cased), with
at least three models per provider, each entry `source: "starter"`, `estimated: true`, and an `https` `sourceUrl`
plus the calendar date (`sourceCheckedAt`) the price was copied from the provider's public pricing page. No local
or self-hosted model is included: a zero price is always an explicit operator override, never a starter default.

A newer bundled starter (shipped with a later release of this project) is never applied automatically, since a
silent price change would silently change every later estimate. `GET /api/v1/pricing` reports
`starter: { bundledAsOf, appliedAsOf, updateAvailable }`; when `updateAvailable` is `true`, update manually: open
the new release's `server/pricing/starter.json`, copy the entries you want into your own `pricing.json`, and call
`POST /api/v1/pricing/reload` (or restart).

If you already have a `pricing.json` before the first boot (for example you wrote it from a template, or you are
restoring a backup), the server adopts it as version 1 with `origin: "file"` and never applies the starter at all.

## Versions

Every accepted change (`POST /api/v1/pricing/changes`), every reload that actually changes the table
(`POST /api/v1/pricing/reload`, or an operator edit picked up at the next reload or restart), and the very first
seed all create the next, strictly increasing `pricingVersion`. Old versions are immutable and kept forever in
`pricing-history.jsonl`: `GET /api/v1/pricing/versions/:version` returns the exact entries active when that
version was created, so an estimate computed from `pricingVersion: 7` (issue #84) can always be reproduced, even
after prices later change many times. `GET /api/v1/pricing/versions/:version/diff?against=:other` shows what
changed between any two versions (`added`, `removed`, `changed`).

## Overrides

Every entry is `kind: "list"` or `kind: "override"`. For a given `(provider, model)` and time, an override beats
every `list` entry, and it is a complete replacement: a price left `null` in the override is unknown, never
filled in from the `list` entry underneath it (no field-by-field merge). An override has no end date: once
created, it keeps winning over every later `list` entry (even a brand-new one) until it is removed with
`POST /api/v1/pricing/changes`'s `removals`, or superseded by a newer override for the same model. Use an
override for a negotiated discount or a contract price that should not be reverted by the next starter or
list-price update.

## Resolution and alias rules

`GET /api/v1/pricing/resolve?provider=&model=&at=[&version=]` and the pure function it wraps
(`resolvePrice` in `src/integrations/pricingContract.ts`) apply, in order:

1. Normalize `provider` and `model`: trim, lower-case.
2. Find the canonical model for that provider: an entry whose `model` equals the normalized id, or whose
   `aliases` list contains it. No match: unpriced.
3. Among that `(provider, canonical model)`'s entries with `effectiveFrom <= at`, prefer any `override` (the one
   with the greatest `effectiveFrom`); otherwise take the `list` entry with the greatest `effectiveFrom`.
4. No candidate: unpriced.

Matching is exact text only, case-insensitive after normalization. `claude-sonnet-4-5-20250929` resolves only if
it is declared as an alias of some entry; there is no prefix, substring or fuzzy match, and no provider-wide
price. This is deliberate: a dated snapshot id you have not explicitly aliased must stay unpriced rather than
silently borrow another model's number.

## No-fallback policy

Resolution returns an entry or nothing. There is no default price, no "closest" model, no provider-wide rate and
no currency conversion. An unpriced model stays unpriced; it is never treated as free (`0`) or billed at another
model's rate. `GET /api/v1/pricing/coverage` is the operator-facing view of exactly which `(provider, model)`
pairs the ledger has seen but the current table cannot price.

## Provider key spelling

An event's `payload.provider` is a free string (for example `"Google"`, `"anthropic"`, `"OpenAI "`); the usage
ledger stores it trimmed and lower-cased (`server/requestKey.ts`'s `normalizeProvider`), and pricing entries use
the identical normalization. If an integration sends a different spelling for the same provider (for example
`"google gemini"` instead of `"google"`), it resolves to nothing: either make the integration send the table's
key, or add a `list`/`override` entry (or a model alias) under the spelling it actually sends.
`GET /api/v1/pricing/coverage` surfaces exactly this kind of mismatch, since it reports real ledger
`(provider, model)` pairs that resolve to no price.

## Updating prices

1. Edit `pricing.json` by hand (add, change or remove entries), or send `POST /api/v1/pricing/changes` with
   `upserts`/`removals`, a `reason`, and the current `expectedVersion` (from `GET /api/v1/pricing`).
2. If you edited the file by hand, call `POST /api/v1/pricing/reload` (or restart the server) to pick it up.
   A no-op edit (same content, any formatting) creates no new version.
3. Check `GET /api/v1/pricing` afterwards: `status` must be `"ok"`. `"file_invalid"` means the last good version
   is still being served and the file needs a fix (see `issues`); `"history_invalid"` means the whole store is
   unavailable until `pricing-history.jsonl` is repaired or restored from backup (a corrupted or torn-but-not-final
   line in that file, for example from an interrupted write that was never fixed by a later clean write).

`POST /api/v1/pricing/changes` and `POST /api/v1/pricing/reload` both require that an API token is configured on
the server (`AGENT_VIEWER_API_TOKEN`); on an open server they answer `403 admin_requires_token`, because pricing
must never be editable by anyone who can merely reach the server. `AGENT_VIEWER_PRICING_READONLY=1` additionally
disables `POST /api/v1/pricing/changes` (file-only management): reload keeps working, so an operator who manages
`pricing.json` through their own deployment pipeline can still apply it.

## Backup and single-writer rule

Back up `pricing.json` and `pricing-history.jsonl` together; the history is what makes a past estimate
reproducible, and restoring only the current file loses every earlier version. Exactly one server process should
ever point at one pricing data directory: this item adds no file locking, so two processes writing the same
`pricing.json`/`pricing-history.jsonl` concurrently is unsupported (it is already true of the rest of this
project's file-backed state). A single process's own concurrent requests are safe: writes are serialized
in-process.

## Security note

Until issue #107/#108 ship named admins and a read-only role, any valid API token can change prices through
`POST /api/v1/pricing/changes`, exactly like it can call any other `/api/v1` route. `GET /api/v1/pricing` and
`GET /api/v1/pricing/versions*` also expose `kind: "override"` entries to any valid token holder, which may
reveal a negotiated price; keep that in mind before sharing a token with a wider audience than you would trust
with your contract pricing.

## Coverage endpoint design note

`GET /api/v1/pricing/coverage` reuses the existing, already-tested grouped usage aggregation
(`GET /api/v1/usage/rollup`, issue #66) rather than a second, hand-rolled ledger scan: it groups the ledger by
`(provider, model)` and checks whether the *group's* most recent call (falling back to its first, if the group
has no later timestamp) resolves to a price in the current table. This means a model that only started being
priced partway through the requested `since` window is reported as priced for the whole group, not row by row.
Issue #84's own per-row price resolution (which this document's `usageTimestampForPricing` helper exists for)
does not have this limitation, since it resolves one ledger row at a time against the version active when that
row's own timestamp occurred.

## How a row gets an estimate (#84)

Every accepted `llm.usage`/`llm.failed` event gets an estimate computed in the same step as its ledger write
(`server/pricing/estimate.ts`), from the pricing table above. The estimate is a second, independent fact: the
event's own reported `cost`/`currency`/`costSource` are never read by the estimator and never changed by it.

**Lookup key and effective date.** The estimator resolves `(provider, model)` exactly as described in
[Resolution and alias rules](#resolution-and-alias-rules), at `usageTimestampForPricing(row)`: the call's own
clock (`occurredAt`, the client-reported timestamp), falling back to the server's receive time only when
`occurredAt` is missing or not a finite number. The server receive time is never preferred over a call's own
timestamp when one was reported: a call reported late, after a price change, is still priced at what was in
force when it actually happened, not when the server happened to ingest it.

**The formula**, worked for one call priced against an entry with `inputPerMillion: 1`, `outputPerMillion: 1`,
`cacheReadPerMillion: 0.5`, `cacheWritePerMillion: 2`, `reasoningBilling: 'included_in_output'`, and a reported
`inputTokens: 1000, cacheReadTokens: 100, cacheWriteTokens: 50, outputTokens: 0`:

1. **Uncached input** = `inputTokens - cacheReadTokens - cacheWriteTokens` = `1000 - 100 - 50` = `850` (the
   canonical contract always reports `inputTokens` inclusive of both cache directions, so this subtraction is
   universal, never configured per provider or per entry).
2. Each token class is priced on its own rate and **summed before rounding**: `850 * 1 + 100 * 0.5 + 50 * 2` =
   `850 + 50 + 100` = `1000` currency units per million tokens priced.
3. A reasoning token class billed `'separate'` is priced on `reasoningPerMillion` in addition to the above; one
   billed `'included_in_output'` (as here) is never priced a second time, since it is already inside
   `outputTokens`.
4. The total is converted to nano-currency-units (`1e-9` of the entry's own currency, matching the ledger's
   `estimatedCostNano` column) and **rounded half-even exactly once**, after every component has been summed:
   `costNano = 1_000_000` here, i.e. `$0.001` at `currency: "USD"`. Every intermediate step is exact `BigInt`
   arithmetic; only the rate-to-nano conversion and the single final rounding ever touch a non-integer. See
   `tests/pricing-estimate.test.mjs`, `'cache read and write are priced separately from uncached input'` for this
   exact case, and `'rounding is half-even at an exact .5 nano boundary'` for the rounding rule itself.
5. A component whose rate is `null` on the resolved entry blocks the whole estimate (`no_price_for_component`)
   only when that component's own token count is greater than zero; a `null` rate paired with a `0` count never
   blocks anything, since there is nothing to price.

An estimate this is computed for is written to five columns next to the existing ones, **never over them**:
`estimated_cost_nano`, `estimated_currency`, `pricing_version` (the exact version that priced the row, so the
computation is reproducible later even after the table changes many more times), `estimate_status`, and
`estimated_at`. `GET /api/v1/usage/calls`, the rollup and the CSV/JSONL export expose these as `estimatedCost`,
`estimatedCostNano`, `estimatedCurrency`, `estimatedCostSource` (always the literal `"estimated"`, never confused
with the reported `costSource`), `pricingVersion`, `estimateStatus`, `estimateRevision` and `estimatedAt`
(issue #295; see [docs/usage-export.md](usage-export.md#column-reference-agent-viewerusage-export2) for the full
column reference).

## What is never assumed

- **No default price.** An unknown model, an unknown provider or a date outside every entry's range gives
  `estimateStatus: "no_price_for_model"` or `"no_price_in_force"` (cost `null`), never a neighbor model's price.
  `src/engine/modelOps.ts`'s `getModelSpec` (the demo app's own simulated-mode catalog, unrelated to the server
  pricing table) states the same rule for its own lookup, explicitly, in its own doc comment: "No fallback."
  Test: `tests/ledger-estimates.test.mjs`, `"sqlite: a model with no price entry gets no_price_for_model, never the gpt-4o or any other fallback price"`.
- **No currency conversion.** The estimated `currency` is always exactly the resolved price entry's own
  currency; there is no conversion step anywhere in the estimator, so a table entry priced in EUR produces EUR
  estimates only, and a call with no resolvable entry gets `currency: null`, never a guessed `"USD"`.
  Test: `tests/pricing-resolve.test.mjs`, `"resolvePrice never returns 0 for \"not found\": no match is null, not a zero-priced entry"`.
- **No zero for a missing token count the price needs.** A `null` count for a component with a non-null rate
  gives `estimateStatus: "missing_usage"` (cost `null`), never a `0` substituted for the missing count.
  Test: `tests/pricing-estimate.test.mjs`, `"a null token count the price needs gives missing_usage, never 0"`.
- **A provider-reported cost is never overwritten by an estimate, and vice versa.** The reported `cost`,
  `currency` and `costSource` on a ledger row are byte-for-byte identical before and after estimation, on every
  ingestion path, including when the estimator itself throws.
  Test: `tests/ledger-estimates.test.mjs`, `"a priced call gets an estimate in the same step as its ledger row; reported fields untouched"` (run for both the memory and SQLite backends), and `"an estimator exception stores estimate_status \"failed\" and the event is still accepted"`.
- **An explicit `0` price is a real price, not "not found".** A model you have explicitly priced at `0` (a local
  or self-hosted model) estimates to an exact `0`, distinguishable from `null` (unpriced); the starter table never
  ships a `0` price for any model, since a zero price is always an explicit operator decision.
  Test: `tests/pricing-estimate.test.mjs`, `"a zero-price local model gives an exact 0, never null"`.
- **Estimates are not invoices.** Tax, discounts, batch pricing, committed-use pricing and provider-side rounding
  are not modeled anywhere in this estimator; it is a list-price approximation from tokens, nothing more. This is
  a design boundary stated in the module's own doc comment (`server/pricing/estimate.ts`), not a single assertion
  one test can check; the "never assumed" items above are what is actually enforced in code.
- **Prices are never fetched from the internet.** The pricing table is entirely file- and API-managed
  (see [Updating prices](#updating-prices)); no provider key is read or required anywhere in this feature, and no
  network call is ever made to price a call.

## Re-estimating after a table change

Changing the pricing table (an edit, an API change, a reload) never touches a row's existing estimate by itself:
an estimate is computed once, at ingestion time, against the table version active at the call's own timestamp,
and stays exactly as computed until something explicitly asks for it to be recomputed.

`POST /api/v1/pricing/recompute` (issue #296) is that explicit action: an operator who corrected a mistake in the
table re-runs the estimator against a corrected or pinned price-table version, over a filtered set of rows. A run
never touches revision 0 (the original ingestion-time estimate) or the canonical event; it only ever adds a new,
later revision. Full endpoint reference, request/response shapes and every field:
[docs/integration.md](integration.md#usage-ledger-cost-estimation-and-recompute-issues-84-296).

What an auditor sees: `GET /api/v1/usage/calls/:id/estimates` returns **every** revision of one call's estimate,
oldest first, each with its own `pricingVersion` and a `components` breakdown that sums exactly to that
revision's cost, so a past figure is never lost, only superseded. `GET /api/v1/usage/calls`, the rollup and the
export choose which revision to read with `estimates=latest` (the default, the newest revision), `estimates=original`
(always revision 0, ignoring any recompute) or `estimateRevision=N` (the highest revision at or below `N`); the
response always echoes which one it used (`estimateBasis`). A recompute run never changes a row's reported cost,
currency or `costSource` under any mode: those columns have no revision concept at all, because nothing ever
rewrites them.

## Reconciling with an invoice

1. Export the window your invoice covers: `GET /api/v1/usage/export?format=csv&from=...&to=...` (see
   [docs/usage-export.md](usage-export.md) for every filter).
2. Group by `currency` and `costSource` before comparing anything: match your invoice, which is in one currency,
   against the rows where `costSource = "provider-reported"` and `currency` equals it. Never sum a `provider-reported`
   row together with an `estimated` one, and never sum two different currencies.
3. The columns that matter for this comparison: `cost`/`currency`/`costSource` (what was actually reported),
   `estimatedCost`/`estimatedCurrency`/`pricingVersion` (this server's own approximation, for the calls your
   provider did not report a cost for, or as a sanity check against what it did), and `requestId` (to find the
   exact call on the provider's own side, if you need to dig into one row). `GET /api/v1/usage/export/totals`
   gives the same per-currency, per-`costSource` sums pre-aggregated, plus a `comparable` section (`reported` vs.
   `estimated`, same-currency rows only, `delta = estimatedCost - reportedCost`, never computed across a row
   missing one side).
4. A row with `costSource: "unknown"` and no usable `estimatedCost` either is a gap in your own instrumentation,
   not a gap this server can fill: trace it back to the runtime or adapter that reported the call with no cost.

## For embedders

The embeddable library (`@warlockcode/agent-viewer`) never prices anything, never receives a price, and never
imports any part of this feature (`tests/lib/pricingIsolation.test.ts`). It only ever displays the usage figures
your host app passes it through props, exactly as computed server-side: see
[docs/library.md](library.md#usage-figures) for the full set of display rules, including `costSource` and how an
unknown figure is always shown as "unknown", never `0`.

## Upgrade note

Coming from a 0.5.x server: migrations run automatically on startup (issue #45), with no manual step. The first
start of a 0.6.0 server with no existing `pricing.json` seeds the bundled starter table as version 1, exactly as
described in [Defaults and the starter table](#defaults-and-the-starter-table); a server that already has a
`pricing.json` from an earlier 0.6.0 pre-release keeps it unchanged. Every usage ledger row written before this
upgrade keeps whatever `costSource` it already had (`provider-reported` or `unknown`); it gets no automatic
estimate, since the five estimate columns are populated only going forward, at ingestion time, or by an explicit
`POST /api/v1/pricing/recompute` run an operator chooses to make (issue #296's row filters can target exactly this
kind of backlog, for example with `filter.onlyUnestimated: true`).
