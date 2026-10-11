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
library's import graph never reaches `pricingContract.ts`, `server/pricing/` or the starter file). No endpoint
here computes an estimated cost or writes it onto a ledger row: that is issue #84.

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
