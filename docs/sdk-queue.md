# SDK durable queue (local spool): shared spec for Python and TypeScript

This document is the joint source of truth for the optional, on-disk, bounded spool that both SDKs
(`sdk/python/agent_viewer.py`, issue #101, and `sdk/typescript/index.ts`, issue #102) implement against
the same ingestion server (`server/index.ts`, `server/store.ts`). It was written together with the Python
implementation (#101) and is what #102's TypeScript implementation conforms to, not the other way around:
where this document and a later TypeScript PR disagree, this document wins unless it is updated here first.

The companion file `tests/fixtures/sdk-queue-scenarios.json` holds the exact vectors (transient
classification, overflow eviction order, drain response handling, spool file naming) that both SDKs' test
suites load, so the two implementations cannot quietly drift apart the way two independent rewrites of the
same rules would.

Full background, motivation and the current-behavior audit live in issue #101. This document only states
the contract both languages must honor.

## Scope and guarantees

Opt-in; default is unchanged, raising behavior. With the spool enabled:

1. A transient failure never raises into the host agent.
2. Events are delivered **at least once, in enqueue order, with the original `id` and `timestamp`**; the
   server's idempotency by `id` (`server/store.ts`) makes that effectively exactly once.
3. Anything the spool cannot keep is **counted**, never silently lost.
4. Neither SDK prices, sums or defaults usage. The spool stores each event verbatim as the SDK built it: a
   missing `cost` or token field stays absent in the stored JSON, never `0`. Every counter defined below
   counts **events**, never tokens or money.
5. No server, contract or library change. The spool only uses endpoints and responses that already exist.

## Public API (same shape, each language's own casing)

Constructor options (Python snake_case / TypeScript camelCase; identical defaults):

| Python | TypeScript | Default | Meaning |
|---|---|---|---|
| `spool_dir` | `spoolDir` | `None` / `undefined` (disabled) | Directory for the spool file. Falls back to `AGENT_VIEWER_SPOOL_DIR` when unset. |
| `spool_max_events` | `spoolMaxEvents` | `10000` | Max rows kept in `spool` (not `rejected`). |
| `spool_max_bytes` | `spoolMaxBytes` | `50 * 1024 * 1024` (50 MiB) | Max total `size_bytes` kept in `spool`. |
| `spool_overflow` | `spoolOverflow` | `"drop_oldest"` | `"drop_oldest"` \| `"drop_newest"`. |
| `spool_batch_size` | `spoolBatchSize` | `50` | Replay chunk size, `1..100`. |
| `spool_background` | `spoolBackground` | `true` when spool enabled | Drain on a background thread/timer. |
| `spool_probe_interval` | `spoolProbeInterval` | `2.0` seconds | First backoff delay after a failed probe. |
| `spool_max_probe_interval` | `spoolMaxProbeInterval` | `60.0` seconds | Backoff cap. |

Invalid values (non-positive caps, an unknown `spool_overflow`/`spoolOverflow`, a batch size outside
`1..100`) raise at construction time (`ValueError` in Python, a thrown `Error` in TypeScript), the only
place the spool logic is allowed to raise.

Methods, same names and semantics in both languages (`flush`/`close` keep their own language's casing for
the method name itself since both are already single words):

```text
flush(timeoutSeconds = 30.0)      -> FlushResult   # drain now, blocking up to timeout; never raises/throws on transient errors
spoolStats() / spool_stats()      -> SpoolStats     # snapshot of counters, see below
spoolRejected(limit=100) / spool_rejected(limit=100) -> list of dead-letter rows, newest first
close(timeoutSeconds = 5.0)       -> void           # final bounded flush attempt, stop the drainer; usable as a context manager / disposable
```

`FlushResult` fields: `delivered` (events acknowledged by the server in this call), `remaining` (still in
the spool), `rejected` (moved to the dead letter in this call), `timedOut`/`timed_out` (bool), `state`
(same values as `SpoolStats.state`). With the spool disabled, `flush()` returns all zeros with
`state: "disabled"` and `spoolStats()` returns all counters at `0` with `state: "disabled"`, so callers
never need to branch on whether the spool is on.

`emit()`/`emit()` return value when an event is queued instead of delivered:

```json
{ "accepted": false, "queued": true, "duplicate": false, "id": "evt_3f9a1c2b7d10" }
```

`emitBatch()`/`emit_batch()`, when queued, enqueues each normalized event individually (each keeps its own
`id`, in list order) and returns:

```json
{ "accepted": false, "queued": true, "total": 3, "ids": ["evt_...", "evt_...", "evt_..."] }
```

A delivered single event or batch still returns the server body unchanged. Re-emitting an `event_id`
already in the spool is a no-op that returns the same queued body: the id is the idempotency key, so this
is neither an overflow drop nor an error.

A single event whose serialized size alone exceeds `spool_max_bytes` can never fit and is never queued:
`emit()` returns `{ "accepted": false, "queued": false, "dropped": true, "id": "evt_..." }` for it (never
mixed into the `queued: true` shape above), and it is counted once in `dropped_overflow_total` (plus the
usage variant for `llm.usage`/`llm.failed`). `emitBatch()`/`emit_batch()` still enqueues every other event
of the same call and lists only the queued ones in `ids`.

A process exit runs one bounded final flush attempt (`atexit` in Python, `process.on('exit'/'beforeExit')`
plus the common signal handlers in TypeScript) so a short script gets one last delivery attempt; anything
left stays on disk for the next run.

## State machine

```
         live send succeeds
   ┌─────────────────────────────┐
   │                             ▼
┌──────┐   transient failure   ┌─────────────┐   drain succeeds, spool empty   ┌──────┐
│ idle │ ─────────────────────>│ server_down │ ───────────────────────────────>│ idle │
└──────┘                       └─────────────┘                                 └──────┘
   ▲                                  │  probe succeeds, backlog non-empty          │
   │                                  ▼                                             │
   │                           ┌───────────┐   drain succeeds, spool empty          │
   │                           │ draining  │ ───────────────────────────────────────┘
   │                           └───────────┘
   │                                  │ 401/403 on a drain request
   │                                  ▼
   │                           ┌─────────────┐  flush() or long probe interval elapses, retried
   │                           │ auth_failed │ ───────────────────────────────────────────────> draining
   │                           └─────────────┘
   └──────────────────────────────────────────────────────────────────────────────────────────────
                     (spool disabled: state is always "disabled")
```

- `idle`: spool empty, no known outage. New `emit()` calls go straight to the normal retrying live send.
- `server_down`: the spool is non-empty, or the last live attempt failed transiently. New events are
  appended to the spool (never sent live) so a later status can never overtake an earlier one; `emit()`
  returns immediately without waiting out the retry/timeout budget.
- `draining`: a drain pass is in progress (background thread/timer, or a foreground `flush()`).
- `auth_failed`: the last drain request answered `401`/`403`. Every event is kept; draining stops until the
  next `flush()` call or until `spool_max_probe_interval` has elapsed, whichever comes first, since a wrong
  token must never eat the spool.

## Enqueue rules

- Try the live send first, with the normal retry loop. If it succeeds and the spool was already empty,
  nothing is written.
- A **transient** failure enqueues the event and moves to `server_down`. Transient means (see
  `tests/fixtures/sdk-queue-scenarios.json`'s `transientClassification` vectors for the exact list):
  a network/connection error (connection refused, reset, timed out, closed early by the peer), and HTTP
  `408`, `429`, or any `5xx`.
- **Not transient** (the server received the request and said no): any other `4xx` keeps raising exactly as
  without a spool, and is never stored: replaying it could never succeed. `401`/`403` on a *live* send (as
  opposed to a drain request) is not transient either: the caller's token is wrong right now, and that is
  the caller's bug to fix before anything is queued.
- A single event whose serialized size alone exceeds `spool_max_bytes` can never fit: it is refused (not
  stored) and counted as an overflow drop (`dropped_overflow_total`, plus the usage variant when the type is
  `llm.usage`).
- Order is global per spool file: while the spool is non-empty, or the state is `server_down`/`draining`,
  every new event is appended behind the backlog, never sent live ahead of it.
- Auto-registration (`agent.registered`) goes through the same path: a queued registration counts as
  registered locally, so it is not emitted twice, and it keeps its position ahead of the agent's later
  events.

## Spool storage

One file per destination. **File naming is shared across both languages so the scheme is externally
verifiable and so an operator looking at a data directory recognizes the pattern regardless of which SDK
wrote it** (the two languages still keep separate files; nothing here shares a single file between
processes of different languages):

```
<spool_dir>/spool-<sha256(url + "|" + runtime_id)[:12]>.sqlite3
```

`runtime_id` is the empty string when not set. Vectors for this hash are in
`tests/fixtures/sdk-queue-scenarios.json`'s `spoolFileNaming` array; both SDKs' test suites assert their own
hash matches those vectors exactly.

Directory mode `0700`, file mode `0600` (best effort on platforms without POSIX permission bits). The API
token is never written to the spool file; headers are rebuilt at send time from the live client
configuration. The spool holds event summaries and messages (whatever the SDK would have sent) in clear
text on disk; both SDKs' README must say so.

```sql
CREATE TABLE spool (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,  -- replay order
  event_id   TEXT NOT NULL UNIQUE,               -- original id, never regenerated
  event_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,                   -- UTF-8 byte length of event_json
  enqueued_at INTEGER NOT NULL,                  -- local ms, diagnostics only
  attempts   INTEGER NOT NULL DEFAULT 0,
  event_json TEXT NOT NULL                       -- the exact serialized event; replay never rebuilds it
);
CREATE TABLE rejected (                          -- dead letter, capped to the latest 100 rows
  seq INTEGER PRIMARY KEY, event_id TEXT, event_type TEXT, rejected_at INTEGER,
  status_code INTEGER, reason TEXT, event_json TEXT
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- schema_version, counters, drain lease
```

`event_json` must be byte-identical to what a live send would have POSTed for that one event (the exact
bytes the SDK serialized when it first tried to send it, not a value rebuilt from the row's other columns).
The batch replay body is built by joining the stored `event_json` strings
(`{"events":[<json>,<json>, ...]}`), never by re-parsing and re-dumping them, so a byte-level difference in
JSON formatting (key order, number formatting, a dropped `cost`) can never creep in on replay.

`schema_version` lives in `meta`. A spool file with a newer `schema_version` than the running SDK
understands is left untouched and the SDK logs and disables the spool for that run (`state: "disabled"`)
rather than risk corrupting it.

## Overflow and drop counters

When storing a new row would exceed `spool_max_events` or `spool_max_bytes`:

- `drop_oldest` (default): evict the oldest **non-usage** rows first (status, message, heartbeat, tool
  events), then the oldest `llm.usage` rows, until the new row fits. `llm.failed` is protected on the same
  terms as `llm.usage` once it exists as a type. See `tests/fixtures/sdk-queue-scenarios.json`'s
  `overflowEvictionOrder` vectors for worked examples.
- `drop_newest`: the new event is refused and not stored.

Counters (identical names in both languages' `SpoolStats`, snake_case in Python / camelCase in TypeScript;
shown here snake_case), persisted in `meta` so they survive a restart, each updated in the same transaction
as the row change it describes:

```text
state                              "idle" | "draining" | "server_down" | "auth_failed" | "disabled"
pending_events, pending_bytes      current backlog size
oldest_pending_age_s               seconds, null when the spool is empty
enqueued_total                     every event ever written to `spool` (including ones later evicted)
replayed_total                     delivered and acknowledged as new (not `duplicate`)
duplicates_acked_total             delivered and acknowledged as `duplicate` (already stored server side)
dropped_overflow_total             evicted or refused because of a cap
dropped_overflow_usage_total       same, restricted to `llm.usage` (and `llm.failed`)
dropped_spool_error_total          disk full, I/O error, or any write failure
dropped_spool_error_usage_total    same, restricted to `llm.usage` (and `llm.failed`)
rejected_total                     moved to the dead letter because the server said 4xx for that one event
rejected_usage_total               same, restricted to `llm.usage` (and `llm.failed`)
rejected_evicted_total             dead-letter rows pushed out by its own 100-row cap
corrupt_spool_total                spool files quarantined and replaced
last_error                         string or null
last_success_at                    ms epoch or null
```

No figure here is ever a token count or a money amount; these are strictly event counts. A `warning`-level
log line (not gated by a debug flag) fires on the first drop of an episode and then at most once per 60
seconds with running totals; one `info` summary log fires when the spool drains back to empty.

## Replay (drain) algorithm

A background drainer (disabled with `spool_background: false`, in which case `flush()` and the next `emit`
call after the probe interval do the work) sends chunks of `spool_batch_size` to
`POST /api/v1/events/batch`, in `seq` order. Full per-response-code table, with exact expected state
transitions and counter deltas, is `tests/fixtures/sdk-queue-scenarios.json`'s `drainResponseHandling`
array; the summary:

| Server response | Action |
|---|---|
| Network error, `5xx`, `408` | Stop this pass, keep every row, back off (see below). |
| `429` | Stop this pass, keep every row; honor `Retry-After` (seconds) when present, capped at `spool_max_probe_interval`; otherwise use the normal backoff. |
| `200`/`202` with `results[]` | Delete every acknowledged id (whether `duplicate` is `true` or `false`) **after** the response is read, so a crash mid-flush only causes a harmless resend. Count `duplicate: true` rows in `duplicates_acked_total`, the rest in `replayed_total`. |
| `413` | Halve the chunk size (never below 1) and retry the same backlog immediately. At chunk size 1, a `413` means that one event alone is too large: move it to `rejected` with the status and reason, and continue with the rest. |
| `400` with `errors: [{ index, ... }]` | Move exactly the listed indices to `rejected` (status, issue text), count them, and resend the remaining events of the chunk. |
| `400` without indices | Bisect the chunk down to single events to isolate the offender; the isolated one goes to `rejected`, the rest replay normally. |
| `401`/`403` | Move to `auth_failed`; keep every row; stop draining until `flush()` or the long probe interval elapses; log once. |

Backoff between failed probes doubles from `spool_probe_interval` to `spool_max_probe_interval`, with
jitter. A probe (the first request after entering `server_down`) uses no retry loop of its own and a
timeout of `min(client_timeout, 2.0)` seconds, so a probe never blocks the host past that bound; the normal
retry budget applies only to a live (non-spooled) send. While draining, new `emit()` calls keep enqueuing
behind the backlog; once the spool is empty the SDK returns to live sends (`idle`).

A single drainer per spool file is enforced with a lease row in `meta` (owner process id and expiry,
renewed while draining) so two processes sharing one spool directory do not interleave drain passes; if
both somehow drain at once anyway, server-side idempotency absorbs the overlap without double-counting.

## Fork / process-model safety (Python-specific detail, noted for parity)

The Python SDK re-creates its SQLite connection per `(thread, pid)` pair and restarts the drainer thread
lazily after `os.fork()`, so a forking host (gunicorn, `multiprocessing`) never shares a connection or
loses its drainer in the child. TypeScript has no equivalent of `fork()` to guard against (Node's
`cluster`/`child_process` workers are separate processes with separate module state), so #102 has no
matching requirement here; this section exists only so the asymmetry is documented, not accidentally
"matched" by adding meaningless fork handling to the TypeScript side.

## Out of scope (both languages)

Same as issue #101's "Out of scope": no server/contract/library change, no cross-language shared spool
file, no encryption at rest, no compression, no non-SQLite backend, no tamper evidence.
