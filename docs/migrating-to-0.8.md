# Migrating to 0.8.0

0.8.0 ("formal audit") adds a hash chain over stored events (issue #105), chain verification and signed
checkpoints (#106/#387), named ingestion keys with a submitter identity (#107), a read-only auditor role
(#108), chain-compatible retention and redaction (#109) and an offline-verifiable audit bundle (#110). Full
detail on each piece lives in [docs/audit-chain.md](audit-chain.md), [docs/audit.md](audit.md),
[docs/api-keys.md](api-keys.md), [docs/audit-bundle.md](audit-bundle.md) and
[docs/threat-model.md](threat-model.md); this page is only what changes for someone who runs today's single
shared `AGENT_VIEWER_API_TOKEN` world and wants the practical runbook for moving onto named keys.

**Nothing breaks by upgrading alone.** Every credential below keeps authenticating exactly as it did before;
the chain, checkpoints and named keys are additive. The sections after "What changes" are a recommended
migration, not a requirement.

## What changes for each existing credential

| Credential | What changes |
|---|---|
| `AGENT_VIEWER_API_TOKEN` | Nothing functional. It is now called the **bootstrap token** and is always an implicit `admin` principal (see [Scopes](api-keys.md#scopes-issue-108)), so it keeps full read/write/admin access exactly like before #107/#108 existed. The deprecated `AGENT_VIEWER_API_KEY` alias still works the same way, with its existing one-line deprecation warning. |
| The CLI's generated session token (`agent-viewer start`) | Nothing functional. It is exported as `AGENT_VIEWER_API_TOKEN` for the session, so it is also an implicit `admin` bootstrap credential. `agent-viewer keys` subcommands (create/list/revoke/whoami) are new in 0.8.0 and need `AGENT_VIEWER_STORAGE=sqlite`; the CLI defaults to memory storage, so set it explicitly to use named keys from the CLI. |
| The Docker `api` image's `/app/data/api-token` file (`AGENT_VIEWER_TOKEN_FILE`) | Nothing functional. `docker/api-entrypoint.mjs` resolves the same way it always has (`AGENT_VIEWER_API_TOKEN`, then the deprecated alias, then the saved file, then a newly generated one) and whatever it resolves to is still the bootstrap token, still implicit `admin`. |
| `AGENT_VIEWER_WEBHOOK_SECRET` | Unaffected. It is still HMAC-only authentication for `/api/v1/webhooks*`, never a key: a webhook accepted this way records `submitter_id: "webhook"` on its stored events (and on the hash chain), not a key id. Rotating it is unchanged; see [docs/api-keys.md](api-keys.md#submitter_id-who-submitted-what) for the full submitter-identity table. |

## Step by step

1. **Back up the SQLite file first**, if you run `AGENT_VIEWER_STORAGE=sqlite`. The default
   `AGENT_VIEWER_SQLITE_BACKUP=auto` already writes a `.bak` copy on the first start of a server that runs a
   migration, but back up yourself too, especially for a database you care about independently. The database
   runs in WAL mode: a copy of just the `.db` file can miss recent commits, so stop the server (or use the
   shipped backup, which snapshots correctly) rather than copying `agent-viewer.db` alone while it is running;
   copy the `-wal` and `-shm` files alongside it if you copy by hand at all. There is no downgrade path: a
   0.8.0 server raises the database's schema version, and an older server refuses to open a newer one.
2. **Upgrade and start the server.** The first start against an existing database runs the new migrations
   (17 through 22: the hash chain, `audit-meta`, named keys, key scopes, tombstones/legal hold, and signed
   checkpoints) automatically, once, in order.
3. **Confirm the bootstrap token still works** exactly as before:
   ```bash
   curl -s http://127.0.0.1:8787/api/v1/whoami -H "Authorization: Bearer $AGENT_VIEWER_API_TOKEN"
   # {"kind":"bootstrap","id":"bootstrap"}
   ```
4. **Create one named ingest key per client** (CLI, Claude Code hook, each SDK, webhook sender that should
   carry its own identity instead of relying on HMAC alone) so a future leak or rotation touches one client,
   not every client sharing the bootstrap token:
   ```bash
   agent-viewer keys create claude-code-hook --scope ingest
   agent-viewer keys create python-sdk-prod --scope ingest
   ```
   Requires `AGENT_VIEWER_STORAGE=sqlite` (named keys answer `501 keys_require_sqlite` in memory mode). See
   [docs/api-keys.md](api-keys.md#creating-and-using-a-key) for the full request/response shape and the CLI
   reference.
5. **Create an auditor key** for whoever needs to read and export the ledger and the chain without ever being
   able to write an event or change configuration:
   ```bash
   agent-viewer keys create auditor --scope audit
   ```
6. **Switch each client over** to its own new key (set that client's `AGENT_VIEWER_API_TOKEN` to its
   `avk_...` token instead of the shared bootstrap value) and confirm it still authenticates and still has the
   access it needs (`agent-viewer keys whoami` against the new token, or `GET /api/v1/auth/whoami`).
7. **Retire routine use of the bootstrap token.** Keep it only as the break-glass credential (out of agent
   runtimes and CI jobs), the same recommendation [docs/api-keys.md](api-keys.md#the-bootstrap-token) already
   gives independently of this migration. Nothing stops you from continuing to use it; the point of the keys
   created above is that a single leaked or rotated key no longer affects every other client.

## Rows stored before the hash chain existed

Migration 17 (`event-hash-chain`) is the first 0.8.0 migration to touch the `events` table: it adds
`prev_hash`, `hash` and `submitter_id` columns and starts chaining every row inserted from that point on. Rows
that were already in the table before that migration ran (everything stored by a pre-0.8.0 server) are **never
individually hashed or walked**. Instead, they are covered once by a single `genesis` checkpoint recording
their count and a digest over all of them together (`unchainedCount`/`unchainedDigest` in
`GET /api/v1/audit/chain`'s response); see [docs/audit-chain.md](audit-chain.md#honest-scope-what-the-chain-does-and-does-not-prove)
for the exact mechanics.

Both `GET /api/v1/audit/verify` and `agent-viewer verify` report these rows the same way: counted in
`chain.unchained`, with a `legacy_rows` warning (`{"code": "legacy_rows", "message": "N unchained row(s) are
counted but not individually verified by this walk."}`). This is **not** a status that says the data is
unverifiable or suspect; a clean report with pre-chain rows present still reads `"ok": true,
"firstBreak": null`, exactly like one with none. There is no separate "pre-chain" field or status string in
the API or CLI output: `chain.unchained` plus the `legacy_rows` warning is the complete, documented shape. A
pre-chain row is never silently reported as individually chain-verified, and a tampered pre-chain row is
detectable only insofar as it changes the genesis digest, which this walk does not re-check row by row (see
[docs/audit-chain.md#verification-get-apiv1auditverify](audit-chain.md#verification-get-apiv1auditverify) and
[docs/threat-model.md](threat-model.md) for the full, honest scope of what the genesis checkpoint does and
does not prove about history from before the upgrade).

## What does not change

- **The event contract.** `CanonicalEvent` (schema `1.0`) is unchanged; nothing about this migration adds,
  removes or reshapes a field a client sends.
- **SDK `usage()` signatures.** Both the TypeScript and Python SDKs keep the same `usage()` call shape; 0.8.0
  adds a new `whoami()` method (from #107) alongside it, it does not change the existing one.
- **The library API and props.** The embedded `<AgentOffice>` receives no audit data, verifies no chain and
  never computes, sums or prices usage, exactly as before; see [docs/library.md](library.md#usage-figures).

## See also

- [docs/api-keys.md](api-keys.md): full key lifecycle (create, list, rotate scopes, revoke), scopes and
  escalation rules.
- [docs/audit-chain.md](audit-chain.md): the hash chain and checkpoint formats, and what they do and do not
  prove on their own.
- [docs/audit.md](audit.md) and [docs/audit-bundle.md](audit-bundle.md): verifying a live chain or an exported
  bundle, with or without the CLI.
- [docs/threat-model.md](threat-model.md): the full actor-by-actor statement of what 0.8.0's guarantees cover,
  including memory-mode limits and residual risks.
