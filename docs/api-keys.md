# Named API keys (issue #107) and scopes (issue #108)

Replaces trusting one shared secret for every client with named, revocable credentials: every accepted event
and the hash chain (#105) record *which* credential submitted it, not just "someone with the token."

## Why this exists

Before this item, `AGENT_VIEWER_API_TOKEN` was the only credential: every SDK, hook and pipeline shared it, a
leak could not be traced to a specific machine, and revoking it meant rotating the environment variable and
breaking every other client at once. Named keys fix both: each one is independently creatable, nameable and
revocable, and every stored event records the id of the key that submitted it.

## The bootstrap token

`AGENT_VIEWER_API_TOKEN` (and the deprecated `AGENT_VIEWER_API_KEY` alias) still works exactly as before and is
now called the **bootstrap token**. It is always an implicit `admin` (see [Scopes](#scopes-issue-108)), and so is
the CLI session token `agent-viewer start` generates (it is exported as `AGENT_VIEWER_API_TOKEN`). It is the
break-glass credential: keep it out of agent runtimes and CI jobs, and create a named key for each of those
instead.

## Scopes (issue #108)

Every named key carries a list of granted scopes. A route needs exactly one scope; holding a scope that implies it
is enough.

| Scope | Allows | Implies |
|---|---|---|
| `ingest` | Writing events: `POST /events`, `/events/batch`, `/agents`, `PATCH /agents/:id`, `POST /runtimes`, the generic webhook (Bearer mode), OTLP `/v1/logs`, `/v1/metrics`, `/v1/traces`. | nothing |
| `read` | The live view: `GET /events`, `/events/stream` (and `POST /stream-tickets`), `/snapshot`, `/runtimes`, `/sessions*`, `/usage`, `/usage/calls*`, `/usage/rollup`, `/usage/duplicates`, `/usage/ledger/status`, `/otlp/stats`. | nothing |
| `audit` | Read-only evidence: `GET /usage/export`, `/usage/export/totals`, `/audit/chain`, `/audit/verify`, `/audit/checkpoints*`, `/audit/bundle`, `/keys`, `/keys/:id`. | `read` |
| `admin` | Everything else: creating, revoking and re-scoping keys, pricing, budgets, alert delivery, retention, redaction rules, creating a signed checkpoint, **and any route not listed above**. | `ingest`, `read`, `audit` |

`audit` is the read-only auditor role: it can read and export everything but can neither write an event nor
change any configuration. `ingest` deliberately does not imply `read`: a CI token that only sends events cannot
read the log back. `GET /api/v1/whoami` and `GET /api/v1/auth/whoami` accept any valid credential.

**Default deny.** The policy lives in one table (`server/auth/routePolicy.ts`) enforced for all of `/api/v1` by a
single middleware, so a route nobody remembered to classify needs `admin`, never less. The order is: rate limit,
then authentication (`401`), then scope (`403`), then the route's own body validation (`400`).

**`401` vs `403`.** A missing, unknown or wrong credential is `401`. A valid credential without the scope is:

```http
HTTP/1.1 403 Forbidden
WWW-Authenticate: Bearer error="insufficient_scope", scope="read"

{ "error": "insufficient_scope", "message": "...", "required": "read", "granted": ["ingest"] }
```

**Implicit principals.** The bootstrap/CLI session token is `{ keyId: "env-token", source: "env", granted:
["admin"] }`; its scopes cannot be set. With no token configured at all (open API), a request without a key is
`anonymous` with `admin`, exactly as open as before this issue. A named key presented in open mode is still held to
its own scopes. A redeemed stream ticket carries only `read` (minting one already requires `read`).

**Escalation rules.**

- Only `admin` creates keys or changes scopes; an admin may create another admin key.
- A key cannot change its own scopes (`403 cannot_modify_own_scopes`), even an admin one.
- While no bootstrap token is configured, the last active named `admin` key can be neither revoked nor demoted
  (`409 last_admin`); create another admin key first. With a bootstrap token configured the rule does not apply,
  since that token is always admin.
- Scopes cannot be changed on a revoked key (`409 key_revoked`).

**Query-string credentials.** No key, whatever its scopes, is ever accepted as `?token=`/`?api_key=` on `/api/v1`:
that was already rejected for every credential since issue #71 (`401 query_token_not_supported`), which more than
covers the "never in the query string for `audit`/`admin`" rule.

**Upgrading.** Migration 20 adds `api_keys.scopes` (a JSON array, default `["ingest"]`). Every key created under
#107 becomes `["ingest"]`, the least-privileged scope. **A #107 key that was also used to read** (dashboards,
scripts calling `GET /events`) now gets `403 insufficient_scope` and needs `PATCH /api/v1/keys/:id` with
`{"scopes": ["ingest", "read"]}` from an admin credential. A key created without `scopes` also gets `["ingest"]`.

## Creating and using a key

```bash
curl -s -X POST http://127.0.0.1:8787/api/v1/keys \
  -H "Authorization: Bearer $AGENT_VIEWER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"name": "ci-pipeline", "scopes": ["ingest"], "expiresIn": 2592000}'
```

```json
{
  "id": "key_3f9a1c7e02ab",
  "name": "ci-pipeline",
  "prefix": "avk_3f9a1c7e02ab",
  "token": "avk_3f9a1c7e02ab.q8Yv...",
  "createdAt": 1767225600000,
  "createdBy": "bootstrap",
  "expiresAt": 1769817600000,
  "scopes": ["ingest"]
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
| `POST` | `/api/v1/keys` | Create a key. Body: `{ "name": string, "scopes"?: string[], "expiresAt"?: number, "expiresIn"?: number }` (`scopes` non-empty, distinct, known names, default `["ingest"]`; `expiresAt` epoch ms, `expiresIn` seconds, 60 to 31536000; mutually exclusive). `admin`. |
| `GET` | `/api/v1/keys` | List every key (never the token or the hash), with `status`, `scopes`, `eventCount`, `firstEventAt`, `lastEventAt`. `audit`. |
| `GET` | `/api/v1/keys/:id` | One key by id. `404 key_not_found` for an unknown id. `audit`. |
| `PATCH` | `/api/v1/keys/:id` | Replace a key's scopes. Body: exactly `{ "scopes": string[] }`. `admin`, never on the caller's own key; `409 last_admin` / `409 key_revoked` as above; `400 env_token_scopes_immutable` for `env-token`. |
| `POST` | `/api/v1/keys/:id/revoke` | Revoke a key. Idempotent: a second call returns the same record, with the original `revokedAt`. The row is never deleted. `admin`; `409 last_admin` as above. |
| `GET` | `/api/v1/whoami` | The identity the current credential authenticates as: `{ kind, id, name? }`. Any valid credential. |
| `GET` | `/api/v1/auth/whoami` | What the current credential may do: `{ keyId, name, source, scopes, effectiveScopes }`, plus `open: true` when no bootstrap token is configured. Any valid credential. |

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
agent-viewer keys create ci-pipeline --expires-in 30d            # scopes default to ingest
agent-viewer keys create auditor --scope audit
agent-viewer keys create dashboard --scope ingest,read
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
- **Scope changes are not in the hash-chained audit trail yet.** `audit.key.created` records the initial
  `scopes`, but a later `PATCH /api/v1/keys/:id` appends no event: adding an `audit.key.scopes_changed` type
  touches the shared event contract and is left for a follow-up.
- **`/metrics` (Prometheus) does not accept named keys** at all; it keeps its own `AGENT_VIEWER_METRICS_TOKEN` /
  bootstrap-token check (issue #103).
- **Malformed JSON is still a `400` before authentication** on `/api/v1`: the global body parser runs before the
  auth middleware (pre-existing). Well-formed but invalid bodies are validated after the scope check.
- **`GET /events?includeAudit=true` is `read`**, so a `read` key can see `audit.key.*` events (names, prefixes,
  scopes; never a token or hash).
- **Pre-upgrade history is never attributed.** Events stored before this migration read back `submittedBy: null`
  forever; there is no way to reconstruct who submitted them.
- **Rate limiting stays per IP**, not per key, in this item.
- **Revocation does not close an already-open SSE connection or a webhook's HMAC trust**: see "Revocation"
  above.
