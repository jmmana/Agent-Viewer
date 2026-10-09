# Usage ledger (issue #65)

One append-only, typed row per accepted `llm.usage` or `llm.failed` event, carrying the **server** receive time.
Every later item from 0.4.0 onward that touches tokens or cost (rollups in #66, the paginated calls API in #67,
exports in #69, retention in #70, pricing in #83/#84, the hash chain in #105) reads from this table instead of
`events.payload`. `#66` and `#67` will point back here for the full column reference.

The office stays the hero view: nothing here changes the canvas or the embeddable library. The ledger lives on
the server; the library keeps getting figures only from its host.

## What a row is

- One row per accepted `llm.usage` or `llm.failed` event, written in the same SQLite transaction as the event
  itself. If the ledger write fails, the event insert rolls back too: an event can never exist without a ledger
  row or a recorded skip.
- `received_at` is the **server** clock (`Date.now()` taken once when the request arrived), always equal to the
  same event's `events.created_at`. `occurred_at` is the **client** clock (`event.timestamp`), unverified. A
  runtime with a wrong clock can misreport `occurred_at`, never `received_at`.
- `seq` is the server insertion order, never reused. `#67`'s calls API pages against it.
- `ingest_channel` records which route accepted the event: `events` (`POST /api/v1/events`), `events-batch`
  (`POST /api/v1/events/batch`), `webhook` (`POST /api/v1/webhooks/generic`), `otlp` (`POST /v1/logs`), or
  `unknown` for a backfilled row from before any server recorded its channel.
- `origin` is `live` for a row written by the request that accepted the event, or `backfill` for one written by
  the one-time migration scan or a later startup catch-up pass.
- `legacy_contract` is `1` when the event was stored by a pre-0.4.0 server (its `created_at` is strictly before
  this server's first versioned-migration run). It governs the token-zero rules below.

## NULL means unknown, never 0

Every token, cost, currency and latency column is `NULL` when the event never reported it, and the exact
reported value (including `0`) when it did. `toLedgerRow` (`server/usageLedger.ts`) never invents a number:

- A numeric column accepts only a finite, non-negative value of the right kind (an integer for token counts and
  latency, any non-negative number for cost); anything else (a string, a fraction where an integer is required, a
  negative number, `NaN`, `Infinity`) is stored as `NULL`.
- A `currency` that is not exactly 3 letters is stored as `NULL`.
- When `cost` is `NULL`, `currency` and `cost_source` are forced to `NULL` and `'unknown'`: a currency or a
  source for a missing figure means nothing. Otherwise both are stored exactly as reported, including a cost
  with no currency.
- `llm.usage` rows get `status = 'ok'` and `error_kind = NULL`. `llm.failed` rows take both `status` and
  `error_kind` from the event's `errorKind` (issue #46's enum: `rate_limited`, `overloaded`, `timeout`,
  `invalid_request`, `auth`, `server_error`, `cancelled`, `network`, `unknown`). The two columns currently always
  agree for a failed row; `status` is kept separate so a later issue can give `llm.failed` a richer status (for
  example "failed after N retries") without displacing `error_kind`.

### Legacy rules (`legacy_contract = 1`)

Resolved against the merged code, not the issue's draft text:

- The 0.2.x contract and SDKs defaulted missing `cachedTokens`/`reasoningTokens` to `0`. A legacy row with `0` in
  either one is stored as `NULL` here. A positive value is kept.
- The legacy `cachedTokens` alias maps to `cache_read_tokens` (the same alias `canonicalContract.ts`'s
  `applyCachedAlias` uses on the live path); `cache_write_tokens` stays `NULL`, because the legacy contract never
  reported it.
- The pre-0.3.0 webhook loose normalizer defaulted missing `inputTokens`/`outputTokens` to `0`. A legacy
  (`legacy_contract = 1`) row from the `webhook` channel with `0` in either one is stored as `NULL`. **This rule
  never applies to a live row**: since 0.3.0, the generic webhook's `usage` object validates through the strict
  `LlmUsagePayloadSchema`, whose `inputTokens`/`outputTokens` are required with no default, so a live webhook
  call must send an explicit value (including a real `0`) to begin with. A live webhook usage event missing
  `provider` or `model` is rejected at `400 validation_failed` for the same reason; only a backfilled pre-0.3.0
  row can have `provider`/`model` `NULL`.

## Deduplication

A request key exists only when both `provider` and `request_id` are non-`NULL` (normalized the same way as the
events table's own `(provider, requestId)` dedup from issue #48: trimmed, provider lowercased). Two rows can
never share one request key; `ux_usage_ledger_request` enforces it.

- **Live path**: by the time an event reaches the ledger as `accepted`, issues #47/#48 have already guaranteed no
  other accepted event shares its `(provider, requestId)` key at the `events` table level, using the exact same
  normalization. The ledger's own check at write time is a last line of defense, not the primary mechanism.
- **Backfill**: pre-#48 data has no such guarantee. The event with the lowest `rowid` (earliest stored) wins the
  key; a later event with the same key and the same figures becomes a `duplicate` skip, with different figures a
  `conflict` skip, both referencing `kept_event_id`. Two events with no `requestId` (for example two webhook
  retries of one call under 0.2.x, whose schema had no `requestId` and whose ids are random) are **never**
  merged by guesswork: they stay two separate rows.

## `usage_ledger_skips`

One row per accepted usage event that produced no ledger row: `reason` is `duplicate`, `conflict` or
`unparseable` (a payload that could not be read as the expected shape; only reachable from the backfill, since
live routes validate the payload first). `kept_event_id` names the row that already holds the call; `NULL` for
`unparseable`. Idempotent: re-running the backfill or the startup catch-up writes the same rows and skips.

## No foreign key, by design

Neither table has a foreign key to `events`. `node:sqlite` opens with `PRAGMA foreign_keys = 1`, and the ledger
is evidence that must outlive a pruned event (issue #70): deleting an old `events` row never touches its ledger
row.

## Backfill and startup catch-up

The migration that adds these tables (`0006-usage-ledger`) also runs the backfill once, over every already-stored
`llm.usage`/`llm.failed` event, paged by `rowid` (default 50,000 rows per page, logged per page). Every later
`SQLiteEventStore` open runs the exact same scan (`server/usageLedger.ts`'s `runUsageLedgerBackfill`), restricted
to events that have neither a ledger row nor a skip row yet; in normal operation this finds nothing and is cheap.
It exists to fill a gap left by, for example, a downgrade to a 0.3.x server (which writes events but not ledger
rows) followed by an upgrade back.

## Memory mode

`MemoryEventStore` keeps the same rows and skips in two maps plus an array, independent of the event ring:
evicting an event from the retained window never removes its ledger row or forgets its request key. The ledger
has its own cap, `AGENT_VIEWER_USAGE_LEDGER_MAX_ROWS` (default 100,000; must be a positive integer, invalid
values fall back to the default). Once it is reached, further rows are dropped, never silently: `GET
/api/v1/usage/ledger/status`'s `complete` turns `false` and stays `false` for the life of the process.

## `GET /api/v1/usage/ledger/status`

Read-only, under `/api/v1` (same auth and rate limit as the rest). Counts and time bounds only, never a sum of
tokens or cost, that is issue #66.

```json
{
  "schemaVersion": "1.0",
  "storage": "sqlite",
  "rows": 1842,
  "rowsByOrigin": { "live": 312, "backfill": 1530 },
  "legacyRows": 1530,
  "skips": { "duplicate": 14, "conflict": 2, "unparseable": 0 },
  "oldestReceivedAt": 1788000000000,
  "newestReceivedAt": 1791460803412,
  "complete": true,
  "migration": { "id": "0006_usage_ledger", "appliedAt": 1791400000000 }
}
```

`oldestReceivedAt`/`newestReceivedAt` are `null` on an empty ledger. `migration` is `null` in memory mode.
`complete` is `false` only in memory mode, once the row cap above has dropped rows; SQLite always reports `true`
(the database keeps every row).
