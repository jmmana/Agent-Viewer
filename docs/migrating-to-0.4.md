# Migrating to 0.4.0

0.4.0 turns Agent Viewer from a live counter into something a team can audit: a durable usage ledger with
the server receive time (issue #65), grouped rollups (#66), a calls API (#67), secret redaction at export
(#68), CSV/JSONL export with reconciliation totals (#69), retention (#70), an API that no longer runs open
by accident and no longer accepts a token in the query string (#71), the portal loading full history on
open (#72), and OTLP metrics ingestion plus OTLP file import (#73, #74). Full detail on each piece lives in
[docs/usage-ledger.md](usage-ledger.md), [docs/usage-export.md](usage-export.md),
[docs/retention.md](retention.md), [docs/redaction.md](redaction.md) and [docs/otlp.md](otlp.md); this page
is only what changes for someone upgrading from 0.3.0.

**There is exactly one breaking change in this release: a `token` or `api_key` query parameter no longer
authenticates anything.** Everything else below is additive or informational.

## Breaking change: no more token in the URL

Since issue #71, `/api/v1/*` and `/v1/logs` reject **any** request that carries `token=` or `api_key=` in
the query string, in any mode, even when the value is correct:

```json
{
  "error": "query_token_not_supported",
  "message": "Send the token in an Authorization: Bearer header. EventSource clients use POST /api/v1/stream-tickets."
}
```

HTTP `401`. This is checked before the webhook HMAC bypass and before the Bearer check, so a URL that
*also* has a correct `Authorization` header is still rejected if it carries `?token=`: fix the client to
stop sending it, a valid header alone is not enough to bypass this check. The same rejection applies to
`POST /api/v1/webhooks/generic` when no webhook secret is configured (that route falls back to the same
token check as everything else under `/api/v1` in that case).

| Client | 0.3.x | 0.4.0 |
|---|---|---|
| `curl` / any raw HTTP client | `curl "http://host:8787/api/v1/events?token=$TOKEN"` worked | Send `curl -H "Authorization: Bearer $TOKEN" "http://host:8787/api/v1/events"`. The query form now answers `401 query_token_not_supported`. |
| Browser `EventSource` | `new EventSource('.../api/v1/events/stream?token=' + token)` | `EventSource` still cannot send headers, so it now needs a short-lived ticket first: `POST /api/v1/stream-tickets` with `Authorization: Bearer <token>` returns `{ "ticket": "...", "expiresAt": ... }`; open the stream as `new EventSource('.../api/v1/events/stream?ticket=' + ticket)` instead. The ticket is single-use and expires after `AGENT_VIEWER_STREAM_TICKET_TTL_MS` (default 30 s). |
| `connectEventStream` (`@warlockcode/agent-viewer`) | Sent `token` as an `Authorization: Bearer` header over a streamed `fetch`, with `?token=` only as a fallback for a browser whose `fetch` cannot stream | No code change needed: when `fetch` can stream, behavior is unchanged (Bearer header). Where it cannot, the client now calls `POST /api/v1/stream-tickets` itself before every connect and reconnect and opens `EventSource` with the ticket, instead of putting the token in the URL. With a token and no streaming `fetch` at all (very old browser), the connection now stops with status `error` instead of ever putting the token in a URL. |
| TypeScript SDK (`AgentViewer`) | Already sent the token only in the `Authorization` header | No change. |
| Python SDK (`AgentViewer`) | Already sent the token only in the `Authorization` header | No change. |
| Demo app / CLI office page | Reads its own token from the page URL (`#token=...` fragment, or a `?token=` query parameter a user pastes into the address bar) to seed the browser tab, then uses it as a Bearer header (or trades it for a stream ticket) | **Kept, unchanged.** This `?token=`/`#token=` is the demo app's own page parameter for telling the browser which token to use locally; it is read by `src/integrations/liveConnection.ts` and is never sent to the server as a query parameter on `/api/v1/*`. Do not confuse it with the server-side query auth that was removed. |

**What to change:** any script, cron job, bookmark, or integration that calls an `/api/v1` or `/v1/logs`
URL with `?token=` or `?api_key=` in it. Move the token into an `Authorization: Bearer` header; for a
browser `EventSource` you cannot add a header to, mint a ticket first.

## Changed: the server refuses to run open by accident

`npm run server` and a direct `startServer()` call now default to binding `127.0.0.1`
(`AGENT_VIEWER_HOST`), not every interface. Binding anything else (for example `AGENT_VIEWER_HOST=0.0.0.0`)
with no `AGENT_VIEWER_API_TOKEN` configured now makes the process print one line to stderr and **exit with
code 1** instead of starting open:

```
[agent-viewer] Refusing to listen on 0.0.0.0:8787 without AGENT_VIEWER_API_TOKEN: anyone on the network
could read and write the usage ledger. Set AGENT_VIEWER_API_TOKEN, or bind 127.0.0.1 (AGENT_VIEWER_HOST),
or set AGENT_VIEWER_ALLOW_OPEN=1 to accept an open API.
```

To keep the previous (open) behavior on purpose, set `AGENT_VIEWER_ALLOW_OPEN=1`. The `agent-viewer` CLI
and the Docker images are unaffected: they already always ran with a token.

Separately, even on a loopback bind with no token configured, a request that does not look local is now
rejected: a non-loopback remote address gets `403 { "error": "open_api_loopback_only" }`, a non-loopback
`Host` header gets `403 { "error": "open_api_host_not_allowed" }`, and an `Origin` header whose host is
neither loopback nor in an explicit `AGENT_VIEWER_CORS_ORIGIN` list gets
`403 { "error": "open_api_origin_not_allowed" }` (a bare `*` does not count as an explicit list). A request
with no `Origin` header at all (`curl`, both SDKs, the CLI) is unaffected, and a signed webhook still works
regardless of where it comes from. If you run a reverse proxy in front of the server, every request already
looks local to it, so a proxied deployment needs `AGENT_VIEWER_API_TOKEN` set regardless of this change.

## Added: SQLite schema migration

If you use `AGENT_VIEWER_STORAGE=sqlite`, the first start of a 0.4.0 server runs five new migrations in
order (`server/db/migrations/0006` through `0010`): the usage ledger table and its one-time backfill over
every already-stored `llm.usage`/`llm.failed` event, the calls-API indexes, retention's own tables, the
rollup indexes, and a `summary` column for export. Migrations run automatically at startup; the default
`AGENT_VIEWER_SQLITE_BACKUP=auto` writes a `.bak` file beside your database first. **Back up your database
yourself before upgrading too**, especially for a large file where you want an independent copy. There is
no downgrade path: a 0.4.0 server raises the database's schema version, and a 0.3.x server refuses to open
a database with a schema version newer than its own. If you need to roll back, stop the server and restore
the `.bak` file (or your own backup) before starting the older version.

The backfill is logged once, for example
`usage_ledger: scanned=1546 inserted=1530 duplicate=14 conflict=2 unparseable=0 (backfill)`, and is safe to
re-run (every later startup repeats the scan, restricted to events with no ledger row yet; in the normal
case this finds nothing). See [docs/usage-ledger.md](usage-ledger.md#backfill-and-startup-catch-up) for the
full rules, including how pre-0.4.0 rows are marked `legacy_contract = 1` so an old "unknown reported as 0"
value is read back as unknown, not zero.

Memory mode needs no migration: the ledger is a separate, independent structure kept alongside the existing
event ring, capped by the new `AGENT_VIEWER_USAGE_LEDGER_MAX_ROWS` (default 100,000).

## Added: OTLP metrics and OTLP file import

- `POST /v1/metrics` (issue #73) now accepts Claude Code's OTLP metrics export (`claude_code.token.usage`,
  `claude_code.cost.usage`), stored as its own evidence, deliberately kept apart from the usage ledger and
  every rollup. Both `/v1/logs` and `/v1/metrics` now also accept `Content-Type: application/x-protobuf`.
  Point Claude Code's OTLP exporter at the same office your logs telemetry already uses; see
  [docs/otlp.md](otlp.md) and [docs/claude-code.md](claude-code.md#tokens-and-cost) for the exact
  environment variables `agent-viewer install claude-code --telemetry` writes.
- `parseEventLog` (issue #74) now also reads a saved OTLP/JSON export file, not only canonical JSONL:
  `resourceLogs` records convert to `llm.usage`/`llm.failed` events through the same mapper the live
  receiver uses; `resourceMetrics` returns a clear issue instead of inventing per-call figures (metrics are
  pre-aggregated counters, not replayable calls); `resourceSpans` is still not supported. See
  [docs/event-log.md](event-log.md#otlp-files).

Neither of these removes or changes any existing behavior; both are purely additive.

## Added: the usage ledger, rollup, calls, export and retention APIs

All new in 0.4.0, all read-only except the ledger write path itself (which runs automatically on every
accepted `llm.usage`/`llm.failed` event, no new write call required on your side):

| Endpoint | Reference |
|---|---|
| `GET /api/v1/usage/ledger/status` | [docs/usage-ledger.md](usage-ledger.md) |
| `GET /api/v1/usage/rollup` | [docs/integration.md](integration.md#usage-rollup-get-apiv1usagerollup-issue-66) |
| `GET /api/v1/usage/calls` | [docs/integration.md](integration.md#usage-calls-get-apiv1usagecalls-issue-67) |
| `GET /api/v1/usage/export`, `/export/totals` | [docs/usage-export.md](usage-export.md) |
| `GET /api/v1/admin/retention` | [docs/retention.md](retention.md) |
| `POST /api/v1/stream-tickets` | [docs/integration.md](integration.md), above |

Nothing about the embeddable library's contract changed: it still only receives figures from host props,
never computes or sums anything itself, and `showUsage` still defaults to off.

## Upgrade checklist

1. Read the breaking change above; search your own scripts, cron jobs and integrations for `?token=` or
   `?api_key=` against this server and move them to an `Authorization: Bearer` header (or a stream ticket
   for `EventSource`).
2. If you run with `AGENT_VIEWER_HOST` set to a non-loopback address, make sure `AGENT_VIEWER_API_TOKEN` is
   also set, or the server will refuse to start; set `AGENT_VIEWER_ALLOW_OPEN=1` only if you really intend
   an open API.
3. If you use `AGENT_VIEWER_STORAGE=sqlite`, back up `agent-viewer.db` yourself before the first 0.4.0
   start, in addition to the automatic `.bak` file.
4. Upgrade the npm package / Docker image / Python SDK together: a 0.4.0 server works with 0.3.x SDKs
   (the new correlation fields and ledger are additive), but a 0.4.0 SDK's `usage_rollup()`/`list_calls()`
   helpers need a 0.4.0 server.
5. Start the server once and watch the startup log for the `usage_ledger: scanned=... (backfill)` line
   (SQLite mode) confirming the one-time backfill ran.
6. Decide on retention: both `AGENT_VIEWER_RETENTION_DAYS` and `AGENT_VIEWER_USAGE_RETENTION_DAYS` default
   to keep forever, so no action is required, but a production deployment that must bound disk usage should
   set them now. See [docs/retention.md](retention.md).
7. If you want tokens and cost for Claude Code's own API calls (not only your orchestrator's), add
   `--telemetry` to `agent-viewer install claude-code` to also forward OTLP metrics.
8. Re-run your own smoke test against `/api/v1/usage/rollup` or `/api/v1/usage/calls` to confirm the
   figures you expect show up.
9. If you call `/v1/logs` or `/v1/metrics` behind a proxy that rewrites `Content-Type`, confirm it still
   sends either `application/json` or `application/x-protobuf` unchanged.
10. Re-read [.github/SECURITY.md](../.github/SECURITY.md): the API token row and the open-by-default
    behavior changed; the retention and redaction rows are new.

## How to tell it worked

`GET /health` reports the server's own package `version` (`"0.4.0"` once you have upgraded) and a separate
`schemaVersion`, which is the **event contract** version (`"1.0"`), not a database version; it does not
change in this release and proves nothing about the database migration.

To confirm the database migration itself ran, use `GET /ready` in SQLite mode, which carries
`database.schemaVersion`, `database.latestKnownSchemaVersion` and `database.appliedAt`. After a successful
upgrade, `database.schemaVersion` equals `database.latestKnownSchemaVersion` and both are `10`. In memory
mode there is no database schema to check; `GET /api/v1/usage/ledger/status`'s `migration` field is `null`
there, by design (see [docs/usage-ledger.md](usage-ledger.md#get-apiv1usageledgerstatus)).
