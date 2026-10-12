# Named API keys (issue #107)

Replaces trusting one shared secret for every client with named, revocable credentials: every accepted event
and the hash chain (#105) record *which* credential submitted it, not just "someone with the token."

## Why this exists

Before this item, `AGENT_VIEWER_API_TOKEN` was the only credential: every SDK, hook and pipeline shared it, a
leak could not be traced to a specific machine, and revoking it meant rotating the environment variable and
breaking every other client at once. Named keys fix both: each one is independently creatable, nameable and
revocable, and every stored event records the id of the key that submitted it.

## The bootstrap token

`AGENT_VIEWER_API_TOKEN` (and the deprecated `AGENT_VIEWER_API_KEY` alias) still works exactly as before and is
now called the **bootstrap token**: it is the only credential that can create, list or revoke keys (`GET
/api/v1/whoami` is the one exception every credential may call). It is the break-glass credential: keep it out
of agent runtimes and CI jobs, and create a named key for each of those instead.

## Creating and using a key

```bash
curl -s -X POST http://127.0.0.1:8787/api/v1/keys \
  -H "Authorization: Bearer $AGENT_VIEWER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "ci-pipeline", "expiresIn": 2592000}'
```

```json
{
  "id": "key_3f9a1c7e02ab",
  "name": "ci-pipeline",
  "prefix": "avk_3f9a1c7e02ab",
  "token": "avk_3f9a1c7e02ab.q8Yv...",
  "createdAt": 1767225600000,
  "createdBy": "bootstrap",
  "expiresAt": 1769817600000
}
```

**`token` is shown exactly once, in this response.** Only a SHA-256 hash of its secret half is ever stored; if
it is lost, revoke the key and create a new one. Use the new token exactly like the bootstrap token, as a
Bearer credential:

```bash
curl -s http://127.0.0.1:8787/api/v1/whoami -H "Authorization: Bearer avk_3f9a1c7e02ab.q8Yv..."
# {"kind":"key","id":"key_3f9a1c7e02ab","name":"ci-pipeline"}
```

Requires `AGENT_VIEWER_STORAGE=sqlite`: keys must survive a restart to be auditable, so every `/api/v1/keys*`
route answers `501 keys_require_sqlite` in memory mode. The bootstrap token keeps working in memory mode, just
without named keys.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/v1/keys` | Create a key. Body: `{ "name": string, "expiresAt"?: number, "expiresIn"?: number }` (`expiresAt` epoch ms, `expiresIn` seconds, 60 to 31536000; mutually exclusive). Bootstrap only. |
| `GET` | `/api/v1/keys` | List every key (never the token or the hash), with `status`, `eventCount`, `firstEventAt`, `lastEventAt`. Bootstrap only. |
| `GET` | `/api/v1/keys/:id` | One key by id. `404 key_not_found` for an unknown id. Bootstrap only. |
| `POST` | `/api/v1/keys/:id/revoke` | Revoke a key. Idempotent: a second call returns the same record, with the original `revokedAt`. The row is never deleted. Bootstrap only. |
| `GET` | `/api/v1/whoami` | The identity the current credential authenticates as: `{ kind, id, name? }`. Any valid credential. |

A key name is unique (case-insensitively, across active and revoked keys), 1 to 64 characters after trimming,
with no control or format characters; a duplicate answers `409 key_name_taken`.

## Authentication resolution

The `Authorization: Bearer <value>` header is resolved in this order:

1. **Shaped like `avk_<12 hex id>.<43 char secret>`**: looked up by id, secret compared in constant time
   (`crypto.timingSafeEqual`, always running one comparison even for an unknown id, so a probe learns nothing
   about which ids exist from timing alone). A match on a **revoked** or **expired** key answers `401
   key_revoked` / `401 key_expired` specifically, so a legitimate holder can diagnose it; an unknown id or a
   wrong secret falls through to step 2.
2. **Compared against the bootstrap token** (`AGENT_VIEWER_API_TOKEN`). A bootstrap token that happens to be
   `avk_`-shaped still authenticates this way.
3. **No token configured at all** (open API) and nothing matched: `anonymous`.

Only the `Authorization` header is read for a key; a key-shaped value sent as a `token` or `api_key` query
parameter is rejected the same way every query-string credential is (issue #71).

## `submitter_id`: who submitted what

Every physically stored event row, and the usage ledger row it may also create, records a `submitter_id` (the
same column #105's hash chain already added and hashes): a key's id (`key_...`), `bootstrap`, `webhook` (a
generic-webhook event authenticated only by its HMAC signature, no key also sent) or `anonymous`. See
[audit-chain.md](audit-chain.md#submitter-id) for the full table, including server-generated events and the
generic webhook's attribution rule when a key is sent alongside the signature.

`GET /api/v1/events` returns it as `submittedBy` on every event (`null` for a row stored before this item, never
back-filled) and accepts `?submittedBy=<id>` as a filter. Live SSE frames carry it too; a reconnect's *replayed*
frames do not yet (a known gap of this item). `audit.key.created`/`audit.key.revoked` events (below) also carry
it, as the identity that made the change.

## Revocation

Revoking a key is immediate on the next request: the key lookup runs on every request, with no cache. It does
**not** retroactively affect events the key already submitted, and it does not delete the key row (so every
`submitter_id` in the historical log still resolves to a name through `GET /api/v1/keys/:id`). An open SSE
connection authenticated by a key is not actively closed when the key is revoked or expires (a documented gap
of this item; the connection keeps streaming until the client disconnects).

## Audit trail of the keys themselves

Creating or revoking a key appends an internal `audit.key.created` / `audit.key.revoked` event, attributed to
the identity that made the change, with a payload of `{ keyId, name, prefix, expiresAt? }` (never the token or
the hash). These two types are deliberately **not** part of the public event contract
(`CANONICAL_EVENT_TYPES`): a client-submitted event of either type is rejected with `400 validation_failed`, the
same as any other unrecognized type. They still enter the stored log, and therefore the hash chain (#105), like
any other event, but are never broadcast over SSE and never reach an `onEventAccepted` listener (so `--record`
JSONL files stay canonical V1). `GET /api/v1/events` omits them by default; pass `includeAudit=true`, or filter
on `type=audit.key.created` (or `audit.key.revoked`) explicitly, to see them.

## CLI

```bash
agent-viewer keys create ci-pipeline --expires-in 30d
agent-viewer keys list
agent-viewer keys revoke key_3f9a1c7e02ab
agent-viewer keys whoami
```

`create` prints the new token once to stdout (a warning that it cannot be shown again goes to stderr); it is
never written to `~/.agent-viewer/session.json` and never accepted as a command-line argument (a secret on the
command line would show up in the process list, the same reason `send`/`claude-hook` never take one either). Add
`--json` to any subcommand for the raw API response instead of the human-readable table/line. `--url`/`--token`
resolve the same way as `agent-viewer send`: flags, then `AGENT_VIEWER_URL`/`AGENT_VIEWER_API_TOKEN`, then the
session file of a running `agent-viewer start`. See [cli.md](cli.md) for the full flag reference.

## Honest limits

- **Credential, not identity.** A named key proves "whoever holds this key", not a specific person: it can be
  shared, copied or leaked like any secret. Treat `submittedBy` as attribution to a credential, which a compromised
  machine can still misuse until the key is revoked.
- **Scopes are not here yet.** Every named key can ingest and read exactly like the bootstrap token today; it
  cannot (yet) create, list or revoke other keys. Role-based scopes (`ingest`/`read`/`audit`/`admin`) and a
  read-only auditor role are issue #108.
- **Pre-upgrade history is never attributed.** Events stored before this migration read back `submittedBy: null`
  forever; there is no way to reconstruct who submitted them.
- **Rate limiting stays per IP**, not per key, in this item.
- **Revocation does not close an already-open SSE connection or a webhook's HMAC trust**: see "Revocation"
  above.
