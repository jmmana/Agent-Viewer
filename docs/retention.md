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
(see the comment at the top of `server/db/migrations/0007-retention.ts`), and the SQLite driver here enables
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

Every non-skipped run writes one row to `retention_runs` (`id`, `started_at`, `finished_at`, `trigger` —
`'startup'` or `'schedule'` —, `status`, the window/cutoff/deleted count for each table, and a short `error` on
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
