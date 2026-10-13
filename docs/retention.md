# Retention (issue #70)

A scheduled purge job that bounds how long two things stay on disk: raw `events` (the operational log) and the
usage ledger (`#65`'s audit record of tokens and cost). Both default to keeping everything forever; an operator
opts in to a window per table, independently, through `server/.env.example`. This is the honest baseline the
0.8.0 tamper-evident work builds on ("What this is not" below), not that work itself.

## What gets deleted, and by what clock

- `AGENT_VIEWER_RETENTION_DAYS` purges `events` rows whose **server receive time** is older than that many days.
- `AGENT_VIEWER_USAGE_RETENTION_DAYS` purges `usage_ledger` rows the same way, independently. It defaults to keep
  forever: the product rule is that the consumption record should normally outlive the raw event stream, not the
  other way around.
- The clock is always the server's own receive time (`events.created_at`, `usage_ledger.received_at`), never the
  client-reported `timestamp`. A replayed JSONL log (a legitimate use, see [event-log.md](event-log.md)) can carry
  old `timestamp` values; it is not purged the moment it is freshly ingested, because age is measured from when
  *this* server accepted it, not from when the event claims to have happened.
- A row exactly at the cutoff survives; the purge deletes strictly older rows (`created_at < cutoff`).

## What never gets deleted

- `runtimes`, `sessions` and `agents` rows, and their counters (`eventsCount`, token and cost totals). A purge
  never recomputes or rewinds them: they count what was *received*, not what is still *retained*. If you need an
  event's content after its retention window, export it first (`#69`, planned).
- The purge audit log itself keeps a lifetime summary (`purgedBefore`, `deletedTotal` below) even though the
  detailed run history is capped (see "Run history" below): deleting data never also deletes the record that it
  was deleted.

## The two windows never interact

Nothing cascades between `events` and `usage_ledger`: there is no foreign key from one to the other, on purpose
(see the comment at the top of `server/db/migrations/0008-retention.ts`), and the SQLite driver here enables
`PRAGMA foreign_keys`, so a foreign key would have made deleting an old event fail, or forced its ledger row to
be deleted with it. Concretely:

- Purging `events` never changes a single `usage_ledger` row, a ledger-based rollup, or any running total.
- Purging `usage_ledger` never touches `events`.
- A ledger row can end up pointing at an event id that `events` no longer has. That is expected, not a bug: the
  calls API (`#67`) reports `eventAvailable: false` for those rows instead of erroring.
- Re-sending an event id whose `events` row was purged is accepted again at the storage level (there is nothing
  left there to recognize it by), but its ledger row, if the ledger window is longer or unset, is still
  recognized by its `(provider, requestId)` key (or, failing that, by its own id) and is never duplicated; the
  resend's tokens and cost are never added to any total a second time. This is exercised directly in
  `tests/retention-store.test.mjs`.

## Coverage signals: `purgedBefore` and `deletedTotal`

`GET /api/v1/admin/retention` (behind the same token and rate limit as every other `/api/v1` route) reports, per
table:

- `purgedBefore`: the largest cutoff under which rows were ever actually deleted. `null` until the first
  deletion. It is set in its own transaction *before* the first delete batch of a run that has anything to
  remove, so a crash partway through a purge never under-reports it: a reader of the rollups can always tell
  whether data older than this instant might be missing.
- `deletedTotal`: the lifetime count of rows this job has deleted for that table. A real `0` is a real zero, not
  a stand-in for "never ran"; `windowDays: null` (and `policy: "keep"`) is how "never configured" is actually
  spelled.
- `lastCutoffMs` / `lastDeleted`: the cutoff and count of the most recent *finished* run that had this table's
  window configured. `null` until one has finished.
- `totalDeletedSinceStart`: the same idea, but per process (resets on restart) and `null` when that table's
  window is not configured for this process at all.

Both counters, and the full run history below, survive a restart (SQLite mode) and the run history's own
pruning: they live in `retention_state`, a separate table from `retention_runs`.

## Run history

Every non-skipped run writes one row to `retention_runs` (`id`, `started_at`, `finished_at`, `trigger`
(`'startup'` or `'schedule'`), `status`, the window/cutoff/deleted count for each table, and a short `error` on
failure) and one console line with the same counts, for example:

```
[agent-viewer] retention: deleted 1204 events older than 30 days (cutoff 2026-09-08T10:00:00.000Z); usage ledger: kept (no window)
```

Neither the log line nor the stored row ever includes event ids, payloads or summaries. Only the newest 500 rows
are kept (self-pruning, the one exception to "retention never deletes audit information": a 0.8.0 item will chain
this table too). At the default one-hour interval that is about three weeks of history; `deletedTotal` and
`purgedBefore` above are exactly what survives past that window.

A run still `status: "running"` when the server starts is the mark of a process that died mid-purge: it is
closed as `status: "error"`, `error: "interrupted"` on the next open, so the audit log never silently claims a
run is still in flight.

## Scheduling and shutdown

The job runs once about 30 seconds after the server starts (`trigger: "startup"`), then every
`AGENT_VIEWER_RETENTION_INTERVAL_MINUTES` (default 60, `trigger: "schedule"`). If both windows are unset, no
timer is ever created: an unconfigured server pays nothing for this feature. A `node:sqlite` delete is
synchronous, so a purge larger than 5000 rows runs in batches, each its own transaction, yielding to the event
loop between batches so the SSE heartbeat and everything else keep working while it runs. If a run is already in
progress when the next tick fires, that tick is skipped and recorded as `status: "skipped"` instead of running a
second purge in parallel. A failed run is logged and recorded as `status: "error"`; it never crashes the server,
and the next tick tries again.

On shutdown, the job is stopped (waiting for a batch already in progress) before the store is closed: a direct
run (`npm run server`, the Docker `api` image) does this itself on `SIGTERM`/`SIGINT`; the embedded CLI does it
from its own `close()` after it closes the HTTP server, since it owns the one process both run in.

## Manual `VACUUM`

A purge runs `PRAGMA wal_checkpoint(TRUNCATE)` after a run that deleted anything, which lets SQLite reuse the
freed pages for new rows. It never runs `VACUUM`: that would shrink the file on disk, but it holds an exclusive
lock for as long as it takes to rewrite the whole database, which this job will never do automatically. Run it
yourself, offline, if you need the file size to actually drop: `sqlite3 agent-viewer.db 'VACUUM;'`.

## Docker and Compose

The three variables work exactly like every other `AGENT_VIEWER_*` setting: pass them with `docker run -e` to the
`app` image, or set them before `docker compose -f docker/compose.yml up` (they are forwarded to the `api`
service; empty means "keep" for a window or the default interval, which the parser accepts the same as unset).

## What this is not

This is the honest baseline, not a tamper-evident one. An operator with access to the SQLite file can delete or
edit rows, including `retention_runs` and `retention_state` themselves, without leaving any trace: there is no
hash chain, no signed checkpoint, nothing that would let a third party prove after the fact that the history is
intact. `retention_runs` and `retention_state` are ordinary tables, exactly like `events` and `usage_ledger`.

Making deletion (and tampering) detectable and provable is deliberately out of scope here, and planned for 0.8.0:

- A hash chain over the ledger (`#105`).
- Verification and signed checkpoints (`#106`).
- Chain-compatible retention and redaction, so a chained ledger can still honor a retention window without
  breaking the chain (`#109`).
- An offline-verifiable audit bundle (`#110`).

Until then, retention here is what it is for most products at this stage: a configuration a trusted operator
turns on, not a control that survives an untrusted one.

## Chain-compatible tombstones (issue #109)

A chained row is never deleted by the routes below. It is **tombstoned**: its `summary` becomes `[removed]`, its
`payload` `{}`, and its `event_json` is rewritten the same way plus a server-assigned `tombstone` object
(`at`, `reason`, `auditEventId`, `rulesVersion`, `contentHash`). Content is removed as a whole, never field by
field. `seq`, `hash`, `prev_hash`, `submitter_id`, `content_hash`, `created_at` and every header column
(`type`, `timestamp`, `runtime_id`, `session_id`, `agent_id`, `task_id`, `severity`, the request-key columns)
stay byte-identical, so the chain's links keep matching. `content_salt` is set to `NULL` (crypto-shredding; see
the limits below). Migration 20 adds the columns (all nullable, `NULL` means unknown, never `0`), an index on
`tombstoned_at`, the `legal_holds` table, and replaces the `events_immutable` trigger with one that allows
exactly that transition and nothing else: an already-tombstoned row and every `audit.*` row stay frozen.

Each batch (`AGENT_VIEWER_RETENTION_BATCH_SIZE` rows, default 5000) is one `BEGIN IMMEDIATE` transaction that:
reads the legal hold, selects the eligible rows (`tombstoned_at IS NULL AND type NOT LIKE 'audit.%'`), appends one
chained `audit.retention.purged` or `audit.redaction.applied` event whose payload lists every affected row's `id`,
`seq`, original `hash` and `content_hash` (never its content), and tombstones those rows pointing back at that
audit event's `seq` (`tombstone_audit_seq`). The event loop is yielded between batches.

### Legal hold

`POST /api/v1/audit/legal-hold` with `{ "action": "place" | "release", "reason": "..." }` writes a chained
`audit.legal_hold.changed` event and its `legal_holds` row in one transaction. `legal_holds` is a convenience
projection; the chained events are the evidence. While a hold is active, purge and redact answer `423
legal_hold_active`, and the hold is re-read inside every batch's own write transaction: a hold placed mid-run
stops the run cleanly (`stoppedByHold: true`; batches already committed stay). The scheduled #70 job also checks
the hold inside each delete batch and deletes nothing while it is active.

### Routes

All under `/api/v1/audit`, checked in this order: `401` (no valid credential), `403 admin_token_required` (no
`AGENT_VIEWER_API_TOKEN` configured: an open API never destroys anything), `403 admin_required` (a named key, not
the bootstrap token), `409 audit_requires_sqlite`, `400` (bad body), then `423` (active hold; not for the hold
route itself, since releasing must stay possible).

- `GET /retention`: `storage`, `policy` (`eventsWindowDays`, `intervalMinutes`, `batchSize`, `scheduledJobMode`,
  `destructiveRoutesEnabled`), `legalHold` (`active`, `current`, `history`), `lastRun`, `tombstones` (`total`,
  `byReason`, `lastAt`), `redactionRulesVersion` (`null` until a rules engine exists) and
  `rowsByRedactionRulesVersion` (`unknown` for rows with none). `409` in memory mode.
- `POST /retention/purge` `{ "before": <ms epoch> }`: tombstones every eligible event received before `before`.
- `POST /redact` `{ "eventIds": [...], "rulesVersion"?: "..." }`: tombstones the named events (`reason: redaction`).
- `POST /legal-hold`: see above. `409 legal_hold_already_active` / `no_active_legal_hold` when nothing changes.

Clients can never forge any of this: `POST /api/v1/events` and `/events/batch` answer `400 reserved_type` for any
`audit.*` type and `400 reserved_field` for a body carrying `tombstone` or `redactionRulesVersion`, checked on the
raw body before validation (a batch is refused whole).

### Known limits and pending work

- **`GET /api/v1/audit/verify` does not understand tombstones yet.** It recomputes each row's hash from
  `event_json`, which a tombstone necessarily changes, so it reports `hash_mismatch` at the first tombstoned row.
  The accounting a verifier needs is in place (links unchanged; the original `hash` and `content_hash` committed
  by a chained, still-recomputable audit event that `tombstone_audit_seq` points to; see `tombstoneAwareWalk` in
  `tests/audit-retention.test.mjs`), but `server/audit/verify.ts` itself is not changed by this item.
- **Crypto-shredding is structural only.** The v1 chain (`server/chain.ts`) hashes the raw event and
  `content_hash` is an unsalted fingerprint, so the stored hashes still commit to the removed content: low-entropy
  content could be confirmed by guessing. `content_salt` exists and is destroyed on tombstone, but nothing writes
  or uses a salt yet; real shredding needs a chain format that commits to a salted content hash (a new domain tag).
- **The scheduled #70 job still deletes rows physically**, chained ones included (it now honors a legal hold).
  Moving it onto tombstones is pending.
- Derived in-memory state (agents, tasks, the SSE replay a client already received) is not scrubbed until the next
  restart rebuilds it from the tombstoned rows.
- Pattern-based redaction (selecting events by the `src/integrations/redaction.ts` rules) is not implemented; only
  explicit ids. The `actor` on every audit event is fixed to `{ "kind": "api", "name": "api-token" }` for now.
- Memory mode: `EventStore.tombstone` rewrites the RAM window only (no chain, no hold); the routes answer `409`.
