# Usage export (issue #69)

CSV and JSONL export of the usage ledger (`#65`), with per-currency, per-cost-source reconciliation totals. This
is the answer to "does what my agents consumed match what the provider invoiced me?": a server-side, redacted,
pinned-snapshot export of every ledger row that matches your filters, plus a totals sidecar that is the same
`GET /api/v1/usage/rollup` (`#66`) aggregation reshaped, never a second sum.

- `GET /api/v1/usage/export?format=csv|jsonl` streams the rows.
- `GET /api/v1/usage/export/totals` returns the reconciliation totals (and, in CSV mode, is the *only* place those
  totals live: a footer row would break `pandas.read_csv`, `COPY FROM` and most importers).

Both sit under `/api/v1`, so they get the same Bearer auth, rate limit, query-token rejection and (with no token
configured) loopback/Host/Origin guard every other `/api/v1` route gets. See the Security table in
[README.md](../README.md#-security) for that guard's exact rules.

## Column reference (`agent-viewer.usage-export/2`)

One row per ledger row: one model call, including failed or rate-limited calls. Column order is fixed and
versioned in the `X-Agent-Viewer-Export-Schema` header and in every JSONL record's `schema` field; a future
column addition bumps the schema again rather than reordering or renaming anything here. Issue #295 bumped this
from `/1` to `/2` to append the 8 estimate columns below; the first 28 columns keep their exact names and order
from `/1`.

| # | Column | Type | Empty / `null` means | Redacted? |
|---|---|---|---|---|
| 1 | `ledgerSeq` | integer | never empty | no (numeric) |
| 2 | `eventId` | string | never empty | yes |
| 3 | `requestId` | string | not reported | yes |
| 4 | `receivedAt` | ISO 8601 UTC, ms | never empty (server clock) | no |
| 5 | `occurredAt` | ISO 8601 UTC, ms | never empty (client clock) | no |
| 6 | `status` | enum (`ok`, or an error kind such as `rate_limited`) | never empty | no (validated enum) |
| 7 | `provider` | string | never empty | yes |
| 8 | `model` | string | never empty | yes |
| 9 | `runtimeId` | string | not set | yes |
| 10 | `sessionId` | string | not set | yes |
| 11 | `agentId` | string | not set | yes |
| 12 | `taskId` | string | not set | yes |
| 13 | `traceId` | string | not set | yes |
| 14 | `parentId` | string | not set | yes |
| 15 | `toolCallId` | string | not set | yes |
| 16 | `userId` | string | not set | yes |
| 17 | `tags` | CSV: `;`-joined, escaped; JSONL: string array | no tags | yes (each tag individually) |
| 18 | `inputTokens` | integer | not reported | no (numeric) |
| 19 | `outputTokens` | integer | not reported | no (numeric) |
| 20 | `cacheReadTokens` | integer | not reported | no (numeric) |
| 21 | `cacheWriteTokens` | integer | not reported | no (numeric) |
| 22 | `reasoningTokens` | integer | not reported | no (numeric) |
| 23 | `latencyMs` | integer | not reported | no (numeric) |
| 24 | `cost` | decimal | unknown | no (numeric) |
| 25 | `currency` | ISO 4217 code | unknown | yes |
| 26 | `costSource` | `provider-reported` \| `estimated` \| `unknown` | never empty | no (validated enum) |
| 27 | `summary` | string | **always `null` today**, see below | yes |
| 28 | `redacted` | `true` \| `false` | never empty | n/a |
| 29 | `estimatedCost` | decimal | not estimable | no (numeric) |
| 30 | `estimatedCostNano` | integer, 1e-9 of the currency unit | not estimable | no (numeric) |
| 31 | `estimatedCurrency` | ISO 4217 code | not estimable | yes |
| 32 | `estimatedCostSource` | the constant `estimated`, or empty | not estimable | no (validated enum) |
| 33 | `pricingVersion` | integer | no price table version was checked (no table loaded at all) | no (numeric) |
| 34 | `estimateStatus` | enum, see below | never empty | no (validated enum) |
| 35 | `estimateRevision` | integer | never empty, `0` unless a recompute run changed this row | no (numeric) |
| 36 | `estimatedAt` | epoch ms | not estimable | no (numeric) |

A value that was never reported is an empty CSV cell or a JSON `null`, never `0`. A reported `0` is written as
`0`. Values are exported as stored: no currency conversion, no token rounding. Columns 29-36 (issue #295) are the
one exception to "no cost estimation": they are the ledger's own ingestion-time estimate (issue #84,
`server/pricing/estimate.ts`), a separate fact from `cost`/`currency`/`costSource` above, computed from a
versioned price table and never merged with what the provider or runtime reported. `estimateStatus` is one of
`estimated`, `no_price_in_force`, `no_price_for_model`, `no_price_for_component`, `missing_usage`,
`inconsistent_usage`, `failed`, or the virtual `not_estimated` (a row written before the estimate columns
existed). Every estimate cell is empty for any status other than `estimated`, except `estimateStatus` itself and
`estimateRevision` (always `0` until the recompute endpoint of a later issue ships real revision history).
`estimatedCostSource` exists only so a consumer can never confuse it with `costSource`: it is the literal string
`estimated` when `estimatedCost` is not empty, and empty otherwise. See the **Estimate basis** section below for
the `estimates`/`estimateRevision` request parameters both export routes share with calls and rollup, and
[docs/pricing.md](pricing.md#re-estimating-after-a-table-change) for how a recompute (issue #296) changes this
column.

### `summary` is always empty right now

`usage_ledger` only grew a `summary` column with this issue (migration `usage-ledger-summary`, version 10); the
table is append-only (`usage_ledger_no_update`), so a row written before that migration can never be backfilled
and keeps `summary = NULL` forever. A row written *after* this migration carries the redacted event summary. If
your deployment just upgraded, expect every row exported today to have an empty `summary` cell until enough new
traffic has landed; this is the same "legacy row has an empty cell for a field it never had" rule this release
already applies to `cacheWriteTokens`, `status` and the `#64` correlation fields.

### `redacted`

`true` when applying the `#68` redactor to any text column of this row actually changed something (a secret
pattern matched and was replaced with a `[REDACTED:...]` marker), `false` otherwise. There is no ingestion-time
redaction flag to also check here: nothing in this codebase redacts at ingestion yet (`src/integrations/redaction.ts`
ships the pure function; the export route is its first caller). Redaction runs on every export request, even for
a row that was already clean, so a rule added after a row was written still protects it retroactively.

## CSV dialect

RFC 4180, CRLF line endings, header row first. Every non-null text column is double-quoted with inner quotes
doubled (`"` becomes `""`). A null text cell and a null numeric cell are both an empty, unquoted field — there is
no way to write an empty string distinct from null in this format, and none is needed (the ledger stores an empty
string as `NULL`). Numeric columns are never quoted. `redacted` is the bare word `true` or `false`, never quoted.

```csv
ledgerSeq,eventId,requestId,receivedAt,occurredAt,status,provider,model,...,cost,currency,costSource,summary,redacted
47001,"evt_a1","req_9f2","2026-09-14T08:12:03.441Z",...,0.013,"USD","provider-reported","planner LLM usage reported",false
```

### Tag escaping (CSV only)

Tags are joined with `;`. Inside a tag, `%` becomes `%25` and `;` becomes `%3B`, in that order (escaping `%`
first keeps it reversible; escaping `;` first would make the `%` it introduces get escaped a second time). This
runs after redaction, so a tag containing a secret is redacted first and only the redacted text is escaped.
JSONL carries the exact tag array and needs none of this — prefer JSONL when exact tag values matter.

### Formula-injection guard (CSV only)

Every non-null text cell, including ids, model names and tags, is checked: if it starts with `=`, `+`, `-`, `@`,
TAB, CR, LF, or a fullwidth form of those (`＝ ＋ － ＠`), the server prefixes it with `'`. A cell starting with a
plain space is not guarded (no spreadsheet evaluates a leading space as a formula). This runs after redaction and
tag escaping, so a redaction marker can never itself create a formula, and strips cleanly: if you join an
exported id against other data, strip one leading `'` from a guarded cell first.

JSONL never gets this prefix — it is data for programs, and adding one would break round-trips.
**Do not open a `.jsonl` export directly in a spreadsheet**; use the CSV export for that.

### Decimal formatting

`cost` is written in plain decimal notation, never exponent notation (`1e-7` is written `0.0000001`). JSONL writes
the same number as a JSON number, also in plain notation — `JSON.stringify` on its own would switch to exponent
form for very small or very large magnitudes, which this export never does. `parseFloat` (CSV) or a JSON number
parser (JSONL) of any cost cell always equals the value stored in the ledger.

## Reconciliation and totals

`GET /api/v1/usage/export/totals` takes the same filters as the export, plus `afterSeq`/`asOfSeq`, and answers
with per-`(currency, costSource)` cost buckets, per-token-kind sums, and `byStatus`:

```json
{
  "schema": "agent-viewer.usage-export/2",
  "asOfSeq": 48213,
  "rowCount": 1240,
  "complete": true,
  "cost": [
    { "currency": "USD", "costSource": "provider-reported", "calls": 1198, "callsWithCost": 1198, "callsWithoutCost": 0, "knownCost": 412.0831, "cost": 412.0831 },
    { "currency": null, "costSource": "unknown", "calls": 12, "callsWithCost": 0, "callsWithoutCost": 12, "knownCost": null, "cost": null }
  ],
  "tokens": { "inputTokens": { "sum": 6120044, "callsReported": 1240, "callsNotReported": 0 }, "...": "..." },
  "byStatus": { "succeeded": 1228, "failed": 12 },
  "estimated": [{ "currency": "USD", "cost": 398.221, "calls": 1240, "pricingVersions": [1] }],
  "estimatedUnknownCalls": 0,
  "estimatedUnknownByStatus": {},
  "estimatedComplete": true,
  "comparable": [{ "currency": "USD", "calls": 1198, "reportedCost": 412.0831, "estimatedCost": 398.221, "delta": -13.8621 }],
  "estimateBasis": { "mode": "latest", "revision": null, "revisionsUsed": [0] }
}
```

### Estimate basis (issue #295)

`GET /api/v1/usage/export`, `GET /api/v1/usage/export/totals`, `GET /api/v1/usage/calls` and `GET /api/v1/usage/rollup` share one `estimates`/`estimateRevision` parameter pair, so a reconciliation run can pin exactly which estimate revision it read:

| Param | Meaning |
|---|---|
| `estimates=latest` | Default. The highest revision of each row's estimate. |
| `estimates=original` | Revision 0, the ingestion-time figure, regardless of any later recompute. |
| `estimateRevision=N` | The highest revision `<= N` (what a price table said when run `N` was newest). |

`estimates` and `estimateRevision` are mutually exclusive (`400 invalid_filter` otherwise). Every response echoes `estimateBasis: { mode, revision, revisionsUsed }`. Before any `POST /api/v1/pricing/recompute` run (issue #296) touches a row, only revision 0 exists, so every mode reads the same data and `estimateRevision` is `0`; once a recompute run writes a new revision for a row, `estimates=latest` (the default) reads that newest revision, `estimates=original` keeps reading revision 0 regardless, and `estimateRevision=N` reads the highest revision at or below `N`. For CSV, which has no per-request metadata record, `estimateBasis` is echoed as the `X-Agent-Viewer-Estimate-Basis` response header instead (JSON-encoded, also in `Access-Control-Expose-Headers`); JSONL carries it on the trailing `summary` record, same as every other response.

To reconcile against a provider invoice: match each `(currency, costSource)` bucket against the matching line on
the invoice, one currency and one cost source at a time. There is never a cross-currency total and never a total
that adds `provider-reported` to `estimated` — mixing those is exactly the kind of error this export exists to
prevent. A bucket with `callsWithoutCost > 0` has `cost: null`; its `knownCost` is the explicitly labeled partial
sum, shown as "partial", never as the total. A row with a reported cost but no currency lands in its own
`currency: null` bucket (its `cost` is a real, known number) — this is different from the `currency: null,
costSource: "unknown"` bucket for rows with no cost at all (`cost: null`, `knownCost: null`); the two are never
merged.

`complete: false` (with `incompleteReason: "evicted"` or `"retention"`) means the server knows rows in range are
missing — memory-mode eviction (`#53`) or a retention purge (`#70`) reached part of the window. Treat the figures
as a lower bound, not the whole truth, when this is set.

**One known gap inherited from `#66`:** the rollup service's SQLite-mode `coverage.complete` only started tracking
real retention cutoffs once `#238` landed (`server/usage/rollup.ts`); this export reuses that same signal
verbatim, so it is exactly as accurate as `GET /api/v1/usage/rollup` is for the same query.

### Incremental pulls with `afterSeq`

`asOfSeq` pins a snapshot (defaults to the ledger's current max `seq`, clamped if you pass one above it, echoed in
`X-Agent-Viewer-As-Of-Seq`). `afterSeq` is the lower bound: "everything with `seq > afterSeq`". Pull once with no
`afterSeq`, note the `asOfSeq` you got back, then pull again later with `afterSeq=<that value>` — the two pulls
together cover every row exactly once, with no gap and no repeat, even if ingestion kept running in between.

## `curl`, Python and TypeScript

```bash
curl -H "Authorization: Bearer $AGENT_VIEWER_API_TOKEN" \
  "http://localhost:8787/api/v1/usage/export?format=csv&from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z&provider=anthropic" \
  -o usage-2026-09.csv
```

```python
import requests

with requests.get(
    "http://localhost:8787/api/v1/usage/export",
    params={"format": "jsonl", "agentId": "planner"},
    headers={"Authorization": f"Bearer {token}"},
    stream=True,
) as response:
    response.raise_for_status()
    with open("usage.jsonl", "wb") as out:
        for chunk in response.iter_content(chunk_size=65536):
            out.write(chunk)
```

```typescript
const response = await fetch('http://localhost:8787/api/v1/usage/export?format=csv', {
  headers: { Authorization: `Bearer ${token}` },
});
if (!response.ok) throw new Error(`export failed: ${response.status}`);
const blob = await response.blob();
```

Always send the token in the `Authorization` header, never as a query-string token parameter: both export routes
reject one outright (`#71`), since a bulk-download URL is far more likely to end up in a shell history, a proxy
log or a browser's address bar than a short-lived API call.

## Guards

- `AGENT_VIEWER_EXPORT_MAX_ROWS` (default `1,000,000`): the server counts matching rows before streaming anything;
  above the limit, `422 export_too_large` with the actual count and the limit. Narrow your filters or use
  `afterSeq`/`asOfSeq` windows instead of one unbounded pull.
- `AGENT_VIEWER_EXPORT_CONCURRENCY` (default `2`): concurrent exports this process serves at once; above it,
  `429 export_busy` with `Retry-After: 5`. Does not apply to the totals sidecar.
- The server never buffers the whole result set: SQLite mode pages through the match set with keyset pagination
  on `seq`; memory mode walks the ledger it already holds. A client that disconnects mid-stream stops the server
  from reading further.

## Schema versioning

The schema id (`agent-viewer.usage-export/2` as of issue #295, was `/1`) appears in the `X-Agent-Viewer-Export-Schema`
response header, in every JSONL record (`call`, `summary` and `error`), and in the totals sidecar's `schema` field.
A future column addition, removal or type change ships as `/3`; columns are never reordered or renamed within a
version, so a consumer can safely assume a given version's column list never shifts under it.

## Out of scope for this item

Parquet, XLSX, scheduled or emailed exports, gzip of the stream, and SDK/CLI `export` helpers are all out of scope
here (see the issue's own "Out of scope" section). Cost estimation/pricing columns (issue #295) and pricing
recompute (issue #296, `POST /api/v1/pricing/recompute`, [docs/integration.md](integration.md#usage-ledger-cost-estimation-and-recompute-issues-84-296))
shipped later and are documented above and there: `estimateRevision` is `0` for a row that was never recomputed,
and the highest revision a matching recompute run wrote otherwise, selected per request with
`estimates=latest|original` / `estimateRevision=N`. The portal's own export dialog, when it ships, will be a thin
client over exactly these two endpoints: it will never sum, convert or price anything itself.
