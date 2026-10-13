# Audit hash chain (issue #105)

Every event stored in SQLite mode joins a SHA-256 hash chain, written in the same transaction as its insert. A
later edit, deletion or reordering of a chained row changes a hash that every later row already committed to,
so the damage is detectable by recomputing the chain. This item only *produces* the chain: walking it to find a
broken link (`GET /api/v1/audit/verify`, issue #106) is documented in its own section below; signed checkpoints,
named submitters, scoped keys, retention and an offline audit bundle are separate items (#387 to #111) that
build on the format documented here.

## Honest scope: what the chain does and does not prove

A hash chain alone is **tamper-evident**, not tamper-proof, against one specific threat: someone who edits a
stored row without being able to recompute every hash after it. It is **not** a defense against an attacker who
has write access to the database file and is willing to rewrite the whole suffix of the chain consistently after
their edit; that attacker can make an edited chain look perfectly valid on its own. Closing that gap needs an
external anchor: a signed checkpoint copied off the server (#387), or the chain head (`GET /api/v1/audit/chain`)
recorded somewhere the attacker cannot also write. Treat the chain as *evidence an editor left nothing to find by
accident, or by editing without also rewriting everything after*, not as a guarantee against a determined
attacker with full file access and no external witness.

Also out of scope here, by construction:

- **Memory storage is not tamper-evident at all.** There is no durable log to chain. `GET /api/v1/audit/chain`
  answers `{ "enabled": false, "reason": "memory_storage", "tamperEvident": false }`, and the server logs
  `memory storage: audit hash chain disabled, history is not tamper-evident` once per process.
- **Pre-genesis history is covered only as a single digest, not row by row.** Rows stored before this migration
  ran are never rewritten and never get fabricated hashes; the migration instead computes one digest over all of
  them (see "Genesis checkpoint" below) and commits to "everything before this moment" as a whole. Editing one of
  those rows after the migration changes the chain state from that point forward (because new rows link to the
  genesis hash, and the genesis hash is unaffected by edits to rows it already covers, so verification of *new*
  chained rows is unaffected); detecting an edit to a pre-genesis row itself needs a saved copy of the genesis
  digest from before the edit, compared by recomputing it over the current rows.
- **The indexed columns (`agent_id`, `session_id`, etc.) are not separately hashed.** The hash covers the stored
  `event_json`; if a future bug or a direct SQL edit changes only an indexed column without touching `event_json`,
  queries that filter on that column can disagree with the hashed content without the hash itself changing. A
  verifier should cross-check the indexed columns against the parsed `event_json` (this is what #106's
  `column_mismatch` check does; it is not part of this item).
- **A power loss can lose the tail of the chain.** SQLite runs with `PRAGMA synchronous = NORMAL` in WAL mode
  (unchanged by this item): after a crash or power loss, the most recently committed transactions can disappear
  with no corruption and no sign in the remaining chain. An external anchor (checkpoint or recorded head) is the
  only way to detect a lost tail, the same as for a consistent rewrite.
- **`receivedAt` is not guaranteed monotonic.** It is wall-clock time at the moment of insert; a clock step
  backwards is possible. `seq`, never `receivedAt`, defines chain order. A verifier must not require `receivedAt`
  to be non-decreasing across the chain.

## Hash format (versioned)

Pure functions in `server/chain.ts`, with no Express or SQLite import; never bundled into the embedded library
(`@warlockcode/agent-viewer`), which never receives, computes or displays chain data.

**`canonicalize(value)`** implements the JSON Canonicalization Scheme ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)):
object keys sorted by UTF-16 code unit at every level, no whitespace, ES6 number serialization. A bare top-level
`undefined`, `NaN`, `Infinity`, a function, a symbol, a `BigInt` or a lone (unpaired) UTF-16 surrogate all throw.
An `undefined` *value of a present object key* is dropped and an `undefined` array element is written as `null`,
matching `JSON.stringify` exactly: this is the "optional field is absent" idiom used throughout the server's own
event objects, not a bug, and `JSON.parse` would never have produced an `undefined` there in the first place.

**`eventHash(input)`** returns lowercase hex SHA-256 of the UTF-8 bytes of:

```
canonicalize(["agent-viewer/chain/v1", seq, prevHash, receivedAt, submitterId, event])
```

- `seq` is the row's position, the same durable, gapless, monotonically increasing counter the server already
  uses for SSE reconnect replay (issue #54) and the startup rebuild (issue #52); it is not reset to 1 by this
  item on an existing database, only on a fresh one.
- `prevHash` is the previous chained row's `hash`, or the current chain head's checkpoint hash when there is no
  earlier chained row yet (a fresh database's genesis checkpoint, or the newest checkpoint after a resume, see
  below).
- `receivedAt` is the server's own receive time (epoch ms), read exactly once per event, inside the same
  transaction as the insert.
- `submitterId` is the stable, non-secret id of who submitted the event (see "Submitter id" below).
- `event` is the parsed, stored event exactly as accepted: the hash never normalizes it, fills a default, or
  re-derives anything. A missing `cost` stays missing in the hashed event.

**`checkpointHash(input)`** (the genesis/resume checkpoints of this item, a different thing from #106's signed
periodic checkpoints) is the same construction over
`["agent-viewer/checkpoint/v1", kind, prevHash, unchainedCount, unchainedDigest, firstEventId, lastEventId, createdAt]`.
`serverVersion` is informational only and is not part of the hashed bytes.

A golden test-vector file, `tests/fixtures/chain-vectors.json`, ships canonicalization, `eventHash` and
`checkpointHash` cases covering key order, float formatting edge cases (`1e-7`, `-0`, large exponents), unicode
(including astral characters) and nesting, so an independent verifier in any language can be checked against the
same expected outputs. **Float formatting is the sharpest cross-language pitfall**: JavaScript's `Number`-to-string
rules (what `canonicalize` uses) do not match every other language's default float formatting byte for byte
(for example, Python's `repr`/`json.dumps` can render the same IEEE-754 double differently at certain magnitudes).
A verifier written in another language must reproduce JavaScript's exact number-to-string algorithm, not its own
language's default, or it will compute a different hash for the same logical number. The same file also documents
that integers above 2<sup>53</sup> are lossy through `JSON.parse` in any JavaScript verifier.

## Schema (migration 17, `event-hash-chain`)

Added to `events`: `prev_hash`, `hash` (both `TEXT`, lowercase hex SHA-256) and `submitter_id` (`TEXT`). The
existing `seq` column (migration 4) is reused directly as the chain's position; it is not reset or duplicated.
`created_at` (exposed over the API as `receivedAt`) is the already-existing server receive time column, now also
part of the hashed preimage.

A new table:

```sql
CREATE TABLE chain_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('genesis', 'resume')),
  prev_hash TEXT,
  unchained_count INTEGER NOT NULL,
  unchained_digest TEXT NOT NULL,
  first_event_id TEXT,
  last_event_id TEXT,
  created_at INTEGER NOT NULL,
  server_version TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  hash TEXT NOT NULL
);
```

A unique index on `chain_checkpoints(kind) WHERE kind = 'genesis'` guarantees a single genesis row even if two
processes race to apply the migration on the same fresh file (the migration runner's own version gate already
prevents the race from reaching the migration body twice in practice; the index is defense in depth).

A trigger stops accidental or casual edits of a chained row:

```sql
CREATE TRIGGER events_immutable BEFORE UPDATE ON events
WHEN OLD.hash IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'chained events are immutable'); END;
```

This is **defense in depth, not a security boundary**: anyone who can run arbitrary SQL against the file can
`DROP TRIGGER events_immutable` first. It stops accidents and casual tooling, nothing more. There is intentionally
no delete trigger: retention (issue #70) deletes old rows, and making that chain-compatible is #109's job, not
this item's.

## Genesis checkpoint

Existing rows, at the moment migration 17 runs, are **not rewritten** and never get a fabricated `seq`, `prev_hash`
or `hash`; they keep those columns `NULL` forever. Instead, the migration streams every such row **ordered by
`id` with the default BINARY collation** (not by `rowid` or `seq`, so the result is reproducible even after a
`VACUUM` renumbers rowids), and for each one computes `sha256Hex(canonicalize(event))`, feeding
`"<id>\n<eventDigest>\n"` into one running SHA-256. The final hex digest, the row count, and the first/last event
id in that same order become the `genesis` checkpoint. A fresh database (zero pre-chain rows) gets
`unchained_count = 0` and the digest of the empty input,
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. The first chained event after the genesis
checkpoint uses the genesis hash as its `prevHash`.

A row whose stored columns cannot be parsed into an event at all (neither `event_json` nor the legacy column
fallback succeeds; this is the same "unparseable" row class the startup rebuild already skips and logs) still
contributes to the digest, through a stable sentinel built from its `id` and raw stored text, so the genesis
digest never silently shrinks its coverage and the migration never crashes on a corrupt row.

### Resume checkpoint (downgrade protection)

If an older server (one that predates this item, or one pointed at the file with a migration list that stops
before migration 17) appends rows directly to the file after the genesis checkpoint exists, those rows arrive
with no chain columns set at all. The next time a chain-aware server starts, it detects any row with `hash IS
NULL` whose `seq` is past the most recent checkpoint's coverage, and writes a `resume` checkpoint over exactly
those rows, the same way the genesis checkpoint covers the original backlog: `prevHash` is the **current chain
head** at that moment (which may itself already be a checkpoint, if several downgrade/upgrade cycles happened
with no ordinary chained row in between), not simply the previous checkpoint's own hash. The next newly chained
event links to the resume checkpoint's hash. Starting again with nothing new since the last checkpoint writes no
further checkpoint: this is what prevents an older server's writes from being silently "laundered" into looking
like they were always part of the chain.

## Submitter id

`submitter_id` is derived from *how* the request authenticated, never from the token or secret itself. Since
issue #107 (named API keys), it names a specific credential, not just "the shared token":

| Request | `submitter_id` |
|---|---|
| A valid, active named API key (`avk_...`) | the key's id, `key_<12 hex>` |
| Bearer token matched the configured `AGENT_VIEWER_API_TOKEN` (the bootstrap credential) | `bootstrap` |
| No token configured (open API) and no key matched | `anonymous` |
| Generic webhook with `AGENT_VIEWER_WEBHOOK_SECRET` set and the HMAC signature verified, no (or no valid) key also sent | `webhook` |
| Generic webhook with `AGENT_VIEWER_WEBHOOK_SECRET` set, HMAC verified, and a valid named key also sent as Bearer | the key's id |
| Generic webhook with no secret configured (goes through the normal auth check) | same resolution as any other route: key id, `bootstrap` or `anonymous` |
| A server-generated event (`POST /api/v1/agents`, `PATCH /api/v1/agents/:id`, `POST /api/v1/runtimes`) | the submitter of the request that triggered it |
| `store.append`/`appendBatch` called with no context at all (tests, internal callers) | `unattributed` |
| A `budget.alert` event the server emits itself | `system` |

See [api-keys.md](api-keys.md) for key management, revocation and the full identity model.

A duplicate id resent under the same request never advances the chain or gets a new hash: `classifyStored`
returns before `insertEvent` is ever called for it. A *request-id* duplicate (issue #48: a different event id
reporting the same `(provider, requestId)` as an already-stored call) is still a genuinely new, physically stored
row, so it is chained like any other row, with the submitter id of whoever sent that particular request.

## Server API

`GET /api/v1/audit/chain` (same auth and rate limit as the rest of `/api/v1`, read-only):

```json
{
  "enabled": true,
  "version": 1,
  "algorithm": "sha256",
  "canonicalization": "JCS-RFC8785",
  "genesis": {
    "hash": "9f2c...e1",
    "createdAt": 1791460800000,
    "unchainedCount": 1204,
    "unchainedDigest": "4ab7...09",
    "serverVersion": "0.8.0"
  },
  "checkpoints": 1,
  "chainedCount": 5321,
  "head": { "seq": 5321, "eventId": "evt_8f1c", "hash": "c0de...42", "receivedAt": 1791547200123 }
}
```

`checkpoints` counts every row of `chain_checkpoints` (genesis plus any resume checkpoints); `head` is `null`
while `chainedCount` is `0`. In memory mode: `{ "enabled": false, "reason": "memory_storage", "tamperEvident":
false }`. A database opened against a migration list that stops before migration 17 (some test fixtures do this
deliberately) answers the same shape with `"reason": "schema_not_migrated"`.

`GET /api/v1/events?include=chain` keeps `events` byte-identical to the same request without `include`, and adds
a sibling map keyed by event id (an id with no chained row, including every pre-genesis row, is simply absent):

```json
{
  "schemaVersion": "1.0",
  "count": 1,
  "events": [{ "id": "evt_8f1c", "type": "llm.usage" }],
  "chain": {
    "evt_8f1c": {
      "seq": 5321, "prevHash": "b17e...90", "hash": "c0de...42",
      "receivedAt": 1791547200123, "submitterId": "shared-token"
    }
  }
}
```

Ingestion responses carry an optional receipt, SQLite mode only, absent for a duplicate: `POST /api/v1/events`
202 gains `"chain": { "seq": 5321, "hash": "c0de...42", "receivedAt": 1791547200123 }`; each accepted item of
`POST /api/v1/events/batch`'s `results[]` gets the same shape. `GET /ready` adds `"chain": "enabled" |
"disabled"`. Every existing field and status code is unchanged; all of this is additive.

## Verification (`GET /api/v1/audit/verify`)

Issue #106 (first sub-issue): walks the chain in one read-only pass and reports the first broken link, if any.
Same auth and rate limit as the rest of `/api/v1`; `?scope=full|recent` (default `full`). `scope=recent` still
always behaves like `full` (anchoring it to the latest signed checkpoint is not implemented yet). Without a signed
checkpoint, a *consistent* rewrite (someone who edits a row and correctly recomputes every later hash) is
undetectable by design, not a bug: the `no_checkpoints` warning says so. The chain by itself only proves that
nothing has changed *since the database was last read*; signed checkpoints (see "Signed checkpoints" below) are
what extend that to "nothing covered by a checkpoint has changed since it was signed".

```json
{
  "ok": false,
  "storage": "sqlite",
  "instanceId": "b7f0c6a2-4d1e-4a56-9a1c-0d6d2f3b8e11",
  "verifiedAt": 1791547300000,
  "durationMs": 42,
  "coverage": { "fromSeq": 1, "toSeq": 5321, "scope": "full" },
  "chain": { "checked": 5320, "headSeq": 5321, "headHash": "c0de...42", "chainStartSeq": 1, "unchained": 0 },
  "firstBreak": {
    "kind": "hash_mismatch",
    "seq": 4102,
    "eventId": "evt_7c3a",
    "expectedHash": "7c1e44...a901",
    "storedHash": "03aa91...77de",
    "message": "The stored hash does not match the event content at seq 4102."
  },
  "checkpoints": { "checked": 0, "valid": 0, "firstFailure": null },
  "exported": null,
  "keyTrust": "server-reported",
  "warnings": [{ "code": "no_checkpoints", "message": "No signed checkpoint exists; a consistent rewrite of the entire chain would not be detected." }]
}
```

A clean report has the same shape with `"ok": true` and `"firstBreak": null`. Every `BreakKind` this slice can
produce: `hash_mismatch` (the event content changed), `link_mismatch` (a row was deleted, inserted or reordered,
or the first chained row's link to the genesis checkpoint was tampered with), `unparseable_event` (`event_json`
is not valid JSON), `column_mismatch` (an indexed column such as `agent_id` was edited directly, bypassing
`event_json`; the message names the column, never its value), and `missing_hash` (a row past every recorded
checkpoint's coverage has no hash at all). `seq_gap` is reserved for a later, checkpoint-aware slice; deleting a
row is reported as `link_mismatch` instead. Legacy rows (before the chain started, or interleaved via a
`resume` checkpoint) are counted in `chain.unchained` with a `legacy_rows` warning, never individually walked:
their integrity is a separate, lighter guarantee (the genesis/resume digest), not this walk's job. `checkpoints`
reports the signed checkpoint verification described below (`ok` is `false` when either `firstBreak` or
`checkpoints.firstFailure` is set); `exported` stays `null` until #388's CLI cross-checks an exported file, and
`keyTrust` stays `server-reported` until that CLI can pin a public key. In memory mode: the same `{ "enabled": false, ... }` shape `GET /api/v1/audit/chain`
already uses, not a `409` (this is a read about availability, not a write the server refuses).

## Signed checkpoints (issue #387)

SQLite mode periodically signs the current chain head with an Ed25519 key, so a copy of a checkpoint kept
elsewhere proves what the chain looked like at that moment, and a later consistent rewrite of any covered row is
detected (`head_mismatch`).

### Signing key

Resolved once at startup, first match wins:

1. `AGENT_VIEWER_AUDIT_SIGNING_KEY`: a PKCS#8 PEM Ed25519 private key (a single line with `\n` escapes works).
2. `AGENT_VIEWER_AUDIT_KEY_FILE`: a path to such a file; generated (mode `0600`, never overwriting) when missing.
3. Default: `audit-signing-key.pem` in the database's directory, generated (mode `0600`) on first start.
4. `AGENT_VIEWER_SQLITE_PATH=:memory:` with neither variable set: an ephemeral in-memory key, with a warning.

Setting both variables, a non-Ed25519 key or an unparseable file stops startup; no message ever contains key
material. An existing key file readable by group/other loads with a warning. Keep the key file **off** the volume
an attacker of the database could also read: anyone holding the private key can sign forged checkpoints.

`audit_keys` (migration 20) records every public key that ever signed here. Starting with a different key than the
active one retires it (`retired_at`), inserts the new one, and immediately signs a `key_change` checkpoint if the
head advanced since the latest checkpoint. A server whose key is no longer the active one refuses to sign.

### Format

```json
{
  "body": {
    "version": 1,
    "instanceId": "b7f0c6a2-4d1e-4a56-9a1c-0d6d2f3b8e11",
    "checkpointSeq": 6,
    "headSeq": 5321,
    "headHash": "c0de...42",
    "chainedCount": 5321,
    "createdAt": 1791547200123,
    "reason": "events",
    "keyId": "ed25519:4f1a...9b",
    "prevCheckpointDigest": "77d2...c1"
  },
  "digest": "9a0e...3f",
  "signature": "base64 Ed25519 signature (64 bytes)"
}
```

The signed bytes are the UTF-8 encoding of `"agent-viewer/checkpoint/v1\n"` followed by the RFC 8785 canonical
JSON of `body` (the same `canonicalize` as the event hashes). `digest` is the hex SHA-256 of those bytes, and the
signature is pure Ed25519 over them. `prevCheckpointDigest` (`null` only for checkpoint 1) chains checkpoints
together. `keyId` is `ed25519:` plus the hex SHA-256 of the public key's SPKI DER encoding. `reason` is one of
`events`, `interval`, `shutdown`, `manual`, `key_change`. The JSON Schema is committed at
[`server/audit/checkpoint.schema.json`](../server/audit/checkpoint.schema.json).

### When a checkpoint is signed

Every `AGENT_VIEWER_CHECKPOINT_EVERY_EVENTS` chained events (default `1000`), every
`AGENT_VIEWER_CHECKPOINT_INTERVAL_MS` (default one hour, an `unref()`ed timer), on graceful shutdown, on a key
change, and on `POST /api/v1/audit/checkpoints`. Each one is skipped when the head has not advanced since the
latest checkpoint. A head *behind* the latest checkpoint (rows removed from the tail) is refused and logged, never
signed, so a truncation is never laundered into a fresh checkpoint. `audit_checkpoints` is append-only through
triggers, and an `audit_keys` row can only be retired once.

### Routes

All under `/api/v1` (same auth and rate limit), `Cache-Control: no-store`, and `409 { "error":
"audit_unavailable", "reason": "memory_storage" }` in memory mode:

- `GET /api/v1/audit/checkpoints`: `{ "checkpoints": [...], "nextAfterSeq": 6 | null }`, oldest first;
  `?afterSeq=` (default `0`), `?limit=` (`1` to `1000`, default `100`), `?format=jsonl` for one checkpoint per
  line (`application/x-ndjson`, next cursor in `X-Next-After-Seq`).
- `GET /api/v1/audit/checkpoints/latest`: `{ "checkpoint": {...} }`, or `404 checkpoint_not_found`.
- `POST /api/v1/audit/checkpoints`: `201 { "created": true, "checkpoint" }`; `200 { "created": false, "reason":
  "chain_empty" | "head_unchanged", "checkpoint" }`; `409 checkpoint_refused` when signing was refused.
- `GET /api/v1/audit/keys`: `{ "activeKeyId", "keys": [{ "keyId", "algorithm", "publicKeyPem", "source",
  "createdAt", "retiredAt", "active" }] }`.

### Verification

`GET /api/v1/audit/verify` checks every checkpoint in order and reports the lowest failing one in
`checkpoints.firstFailure`: `signature_invalid` (malformed body, bad signature or a stored digest that disagrees),
`key_unknown` (no recorded public key hashes to `keyId`), `checkpoint_missing` (numbering gap),
`checkpoint_link_broken`, `instance_mismatch`, `seq_beyond_head` (the chain is shorter than a signed head),
`head_mismatch` (the row at `headSeq` is gone or has another hash) and `count_mismatch`. The `no_checkpoints`
warning is only emitted when there is no checkpoint at all.

Honest limits of this slice: public keys come from the same database (`keyTrust: "server-reported"`), so someone
who controls the file *and* replaces `audit_keys` and every checkpoint with their own key is only caught by
comparing against a checkpoint or public key kept elsewhere (pinning is #388's CLI). Rows appended after the
latest checkpoint, and deleting the newest checkpoints together with the rows they cover, are not detectable
without such an external copy. Raw-event retention (`AGENT_VIEWER_RETENTION_DAYS`) deleting chained rows makes
older checkpoints fail (`head_mismatch`/`count_mismatch`), the same way it already breaks the chain walk.

## Upgrading to 0.8.0

Back up the `.db` and the SQLite `-wal`/`-shm` files before upgrading, the same advice as any schema migration
(`AGENT_VIEWER_SQLITE_BACKUP=auto`, the default, already does this automatically). The migration is a single
pass over the existing `events` table and is normally fast; a very large table makes the genesis digest scan
take proportionally longer, one time, at the first 0.8.0 startup.

## Anchoring the head externally

Because a hash chain alone cannot detect a consistent rewrite by someone with full file access (see "Honest
scope" above), the practical next step for real tamper evidence is to copy `GET /api/v1/audit/chain`'s `head`
(or, better, `GET /api/v1/audit/checkpoints/latest` and `GET /api/v1/audit/keys`) somewhere the operator of the database cannot also write: a separate
log, a ticket, a second system. Comparing a later chain walk (`GET /api/v1/audit/verify`, issue #106) against
that recorded head is what actually proves nothing changed since the moment it was recorded.
