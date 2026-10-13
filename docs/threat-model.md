# Threat model (issue #111)

This page states, in one place, what the 0.8.0 "formal audit" work (the hash chain #105, signed checkpoints
#387, chain verification #106, named and scoped keys #107/#108, chain-compatible retention and redaction
#109, and the offline-verifiable audit bundle #110) actually guarantees, who it guarantees it against, and
where that guarantee stops. Every other audit document assumes you have read this one first.

**The guarantee, in one sentence:** a hash chain proves that stored history was not altered after the fact;
it does not prove that what an agent reported is true.

Overclaiming is the main risk of this release, not a missing feature. If a sentence anywhere in the audit
guide (`docs/audit.md`), the chain format reference (`docs/audit-chain.md`) or the bundle format
(`docs/audit-bundle.md`) seems to say more than this page does, this page is the one to trust; file a bug
against the document that overclaims.

## Assets

What the chain, keys and bundle exist to protect, and what an attacker or a curious reader could get at:

- **Stored events** (`events` table, SQLite mode): the canonical history, including free-text fields
  (`summary`, `payload`) that a client may have put anything into.
- **The hash chain itself**: `prev_hash`/`hash` on every row (`server/chain.ts`), the thing that makes a
  silent edit detectable.
- **Signed checkpoints** (`audit_checkpoints`) and the **signing key** (`audit_keys`, the private half
  resolved by `AGENT_VIEWER_AUDIT_SIGNING_KEY`/`AGENT_VIEWER_AUDIT_KEY_FILE`): the external-ish anchor that
  turns a *consistent* rewrite from undetectable into a `head_mismatch`. See
  [docs/audit-chain.md#signing-key](audit-chain.md#signing-key) for exactly how the private key is resolved
  and stored, including file mode `0600`.
- **Named API keys** (`api_keys`, only a SHA-256 hash stored, never the token): the credential that attaches
  a `submitter_id` to every event. See [docs/api-keys.md](api-keys.md).
- **Exported audit bundles** (`GET /api/v1/audit/bundle`, `docs/audit-bundle.md`): a file an auditor saves
  and later checks offline. It is not a sanitized export: see "Bundle confidentiality" below.
- **The usage ledger and its export** (`docs/usage-export.md`): the record an invoice cross-check is built
  from; outside this item's own scope but part of the audit workflow end to end.

## Actors

- **A compromised or buggy agent, SDK, or hook.** It can submit anything through its own credential's
  `ingest` scope: a false usage figure, a fabricated event, or nothing at all (silence is not detectable from
  the chain's side; see "What the chain does not prove").
- **A malicious ingestion client** holding a leaked or stolen named key. Scoped to `ingest`
  ([docs/api-keys.md#scopes-issue-108](api-keys.md#scopes-issue-108)), so it can write events but cannot read
  the ledger, verify the chain, or change configuration; revoking the key stops new writes immediately but
  never retroactively changes what it already submitted.
- **A read-only auditor** holding an `audit`-scoped key. Can read and export everything (`read`, plus the
  chain/verify/checkpoints/bundle/keys routes) but can neither write an event nor change any configuration.
  This is the role this release adds; before #108 there was no way to grant read access without also granting
  write access.
- **An operator with file-system access to the SQLite database, but not the signing key.** Can edit, delete
  or reorder rows; the chain's hash links detect this on the next verification (`hash_mismatch`/
  `link_mismatch`), and a checkpoint signed before the edit also fails (`head_mismatch`), because this
  operator cannot re-sign a new, consistent checkpoint over the tampered chain.
- **An operator with both the database file and the signing private key.** Can rewrite the entire chain
  consistently (recompute every hash after an edit) and sign a brand-new checkpoint over the result, which
  then verifies cleanly against the server's own `audit_keys`/`audit_checkpoints`. This is the attacker a
  hash chain alone, and even a signed checkpoint kept only in the same database, cannot catch; see
  "Residual risks" below for the mitigation.
- **A network attacker** (on the wire, or reading a server's access logs). `Authorization: Bearer` is the
  only credential transport for `/api/v1`; no key, bootstrap token or scope is ever accepted as a `token` or
  `api_key` query-string parameter (closed in issue #71, enforced on every route). An `EventSource` client
  mints a short-lived, single-use stream ticket instead of putting a credential in a URL. TLS termination is
  the operator's own responsibility (see [.github/SECURITY.md](../.github/SECURITY.md)); nothing in this
  release encrypts traffic itself.
- **A log reader** (someone with read access to infrastructure logs, not the application). Relevant only to
  the historical query-string credential risk above, which no longer applies to a current deployment once
  issue #71's change is in effect; a log line from before that change could still contain a leaked token.

## What the chain proves

- **Events in a verified range are exactly those stored at ingestion time, in order, with none added,
  removed or edited since the covering checkpoint was signed.** `GET /api/v1/audit/verify` (issue #106)
  recomputes every hash and every link; a signed checkpoint (#387) extends that guarantee past "since the
  database was last read" to "since the checkpoint was signed". Full mechanics:
  [docs/audit-chain.md#honest-scope-what-the-chain-does-and-does-not-prove](audit-chain.md#honest-scope-what-the-chain-does-and-does-not-prove).
- **Each event was accepted under a named, specific credential, at the server's own receive time**, never
  the client's claimed timestamp. `submitter_id` names a key id, `bootstrap`, `webhook` or `anonymous`
  depending on how the request authenticated; the full resolution table is
  [docs/audit-chain.md#submitter-id](audit-chain.md#submitter-id).
- **A bundle verifies offline, with only the bundle file and a public key, on a machine with no server and
  no network.** `scripts/verify-audit-bundle.mjs` (#401) reimplements the chain, checkpoint and pricing-digest
  logic independently of the server that produced the bundle; see
  [docs/audit-bundle.md](audit-bundle.md) for its nine checks.
- **A gap, reorder or truncation in the stored sequence is detected**, not just a content edit: `link_mismatch`
  covers a deleted, inserted or reordered row, and a checkpoint behind the chain's current head, or a head
  behind the latest checkpoint, is refused rather than silently re-signed
  ([docs/audit-chain.md#when-a-checkpoint-is-signed](audit-chain.md#when-a-checkpoint-is-signed)).

## What the chain does not prove

- **That the reported tokens, costs or events are true.** The server records what it was told; it never
  independently measures a provider call. A provider invoice is the actual reference for cost, never this
  chain. See "Invoice cross-check" below.
- **That nothing was dropped before it reached the server.** An SDK queue failure, a hook that fails open
  (see each adapter's own guide), a network failure before the request arrives, or a `--record` JSONL file
  kept outside the server, all leave no trace here: the chain only covers what the server actually stored.
- **That a replay of an existing event id with different content was rejected and recorded as an attempt.**
  A duplicate id is dropped before it reaches storage (`classifyStored` returns before `insertEvent`); it is
  simply never chained, not chained-and-flagged. A different event id reporting the same `(provider,
  requestId)` pair *is* stored and chained as its own row, attributed to whoever sent it; see
  [docs/audit-chain.md#submitter-id](audit-chain.md#submitter-id) for both cases.
- **Anything about events after the last signed checkpoint, beyond their ordering relative to the chain
  head.** `scope=recent` still behaves exactly like `scope=full` today (not yet implemented as a real
  optimization); a tail with no checkpoint covering it is detectable as unsigned, not as tamper-free.
- **That a party holding both the database file and the signing private key did not rebuild the whole chain
  and re-sign it.** This is a structural limit of any self-contained chain, not a bug in this item; the
  mitigation is an external anchor (see "Residual risks").
- **Wall-clock accuracy beyond the server's own clock.** `receivedAt` is wall-clock time at the moment of
  insert and is not guaranteed monotonic; a server clock stepped backwards is not detected by the chain, and
  `seq`, never `receivedAt`, is what actually defines order
  ([docs/audit-chain.md](audit-chain.md#honest-scope-what-the-chain-does-and-does-not-prove)).
- **That the submitter identity is a specific person.** `submitter_id` names a credential (a key, the
  bootstrap token, or an unauthenticated request), which can be shared, copied or leaked like any secret.
  Treat `submittedBy` as attribution to a credential, never to a human, until that credential is revoked. See
  [docs/api-keys.md#honest-limits](api-keys.md#honest-limits).
- **Anything about events accepted with no key at all.** An open API (no `AGENT_VIEWER_API_TOKEN`
  configured) attributes events to `anonymous`; a generic webhook authenticated only by its HMAC secret
  (`AGENT_VIEWER_WEBHOOK_SECRET`, no key also sent) attributes to `webhook`. Both are real, chained,
  verifiable rows; neither one names a specific credential holder, because this release's shipped behavior
  does not require one for either path. See the full resolution table in
  [docs/audit-chain.md#submitter-id](audit-chain.md#submitter-id).
- **That verification still passes after a legitimate redaction or retention purge, today.** This is the one
  place this page corrects an assumption the rest of the audit documentation set was written against: issue
  #109's tombstone is designed to keep the chain's *links* intact (`seq`, `hash`, `prev_hash` and every header
  column stay byte-identical), and the standalone bundle verifier (`scripts/verify-audit-bundle.mjs`, #401)
  already understands this and skips the content-hash recompute for a tombstoned row. **The live
  `GET /api/v1/audit/verify` route and the `agent-viewer verify` CLI do not yet have that same logic**: they
  recompute every row's content hash unconditionally and report `hash_mismatch` at the first tombstoned row,
  indistinguishable on the wire from real tampering. This is a known, disclosed gap
  (see [docs/retention.md](retention.md#known-limits-and-pending-work)), tracked as
  [issue #408](https://github.com/jmmana/Agent-Viewer/issues/408). Until it ships, treat a `hash_mismatch`
  reported by the live verifier or CLI as requiring a manual check against `docs/retention.md`'s tombstone
  columns (or a bundle re-export, which already verifies correctly) before concluding the chain was tampered
  with.

## Memory mode

Every audit guarantee above requires `AGENT_VIEWER_STORAGE=sqlite`. In memory mode:

- There is no durable log to chain at all. `GET /api/v1/audit/chain` answers
  `{ "enabled": false, "reason": "memory_storage", "tamperEvident": false }`, and the server logs this once
  per process at startup (verified by `tests/event-store.test.mjs`, `tests/audit-verify.test.mjs`).
- `GET /api/v1/audit/verify`, `/audit/checkpoints*` and `/audit/bundle` answer `409 audit_requires_chain` /
  `409 audit_unavailable` rather than a degraded or partial result: 0.8.0's shipped behavior is to **refuse**,
  never to silently report a hollow success (tested in `tests/audit-entries.test.mjs`,
  `tests/audit-checkpoints.test.mjs`).
- Named API keys cannot be created at all: every `/api/v1/keys*` route answers `501 keys_require_sqlite`
  (`docs/api-keys.md`). The bootstrap token still works, without named-key attribution.
- The event ring buffer itself is bounded to `DEFAULT_MAX_EVENTS = 10000` (`server/store.ts`); the oldest
  event is evicted once that cap is reached, and the whole ring is lost on restart. There is no audit
  question memory mode can answer about an event older than its own retained window, independent of the
  chain question above.

In short: a server run in memory mode is not auditable, by design, and 0.8.0 makes every audit-adjacent route
say so explicitly instead of returning a shape that looks like success.

## Bundle confidentiality

An exported audit bundle (`GET /api/v1/audit/bundle`, `agent-viewer audit export`) is **not** redacted.
Secret redaction (`docs/redaction.md`) is wired into exactly one place in this release,
`GET /api/v1/usage/export`/`/export/totals`; `server/audit/bundle.ts` does not call it. A bundle's `event`
lines carry the exact stored `event_json`, including any `summary` or `payload` text a client wrote,
unredacted. If a secret was ever pasted into a free-text field, exporting a bundle exports that secret too.

A bundle never contains a credential that would let a reader forge anything: no API token, no key hash, and
only **public** signing keys (`"key"` lines never carry a private key; see
[docs/audit-bundle.md](audit-bundle.md#key)). But it does contain event content, which is confidential in the
same sense the live event stream is. Treat an exported bundle file with the same handling as you would the raw
database: store it access-controlled, and if you need to hand a redacted copy to someone who should not see raw
summaries, use `GET /api/v1/usage/export` (which does redact) for that purpose instead.

## Invoice cross-check

Cross-checking stored usage against a provider's bill uses `GET /api/v1/usage/export`/`/export/totals` (issue
#69) and `GET /api/v1/usage/rollup` (issue #66), never this audit tooling directly: the chain proves the
ledger was not altered after the fact, not that its figures are correct. Two rules never bend, here or
anywhere else in this project: **unknown is never zero** (a call with no reported cost stays `unknown`, never
a guessed `0`), and **estimated is never mixed with reported** (a server-side pricing estimate,
`costSource: "estimated"`, is always labeled as such and summed separately from a provider-reported figure;
see [docs/pricing.md](pricing.md) and the rollup/export details in
[docs/integration.md](integration.md#usage-rollup-get-apiv1usagerollup-issue-66)). This guide, and every
audit document in this set, never computes, sums or assigns a price; that is the usage ledger and pricing
table's job, not the chain's.

## Residual risks and recommended mitigations

- **A fully privileged operator (database file plus signing key) can rebuild and re-sign history
  undetectably.** Mitigation: copy `GET /api/v1/audit/checkpoints/latest` and `GET /api/v1/audit/keys`
  somewhere the database operator cannot also write (a separate log, a ticket, a second system), the same
  advice as [docs/audit-chain.md#anchoring-the-head-externally](audit-chain.md#anchoring-the-head-externally).
  An externally anchored checkpoint is what turns this residual risk into a detectable `head_mismatch`.
- **The signing key file is a single point of trust.** Keep it off any volume or backup an attacker of the
  database could also read; `docs/audit-chain.md#signing-key` documents its resolution order and the `0600`
  file mode. Rotating it (deliberately or after a suspected compromise) retires the old key but does not
  invalidate checkpoints already signed under it: they remain verifiable against the retained public key
  record in `audit_keys`.
- **A compromised ingest-scoped key can flood the log with false events** until revoked. Scope every
  credential to the minimum it needs (`ingest` only for a pipeline that never reads, `audit` only for an
  auditor who never writes); see [docs/api-keys.md#scopes-issue-108](api-keys.md#scopes-issue-108).
- **A shared bootstrap token has no identity.** Treat it as a break-glass credential, not a routine one: keep
  it out of agent runtimes and CI, and create a named key for each real client instead
  ([docs/api-keys.md#the-bootstrap-token](api-keys.md#the-bootstrap-token)).
- **Run the server behind TLS.** This release adds no transport encryption of its own; put a reverse proxy
  with TLS in front of any non-loopback deployment, per [.github/SECURITY.md](../.github/SECURITY.md).
- **Run the auditor role from a separate host or session than the one doing ingestion**, so a compromise of
  one does not also compromise the other; an `audit`-scoped key cannot write regardless, but keeping its
  holder's environment separate limits what a broader compromise of that environment could still reach.

## Non-goals

- **Not tamper-proof against a fully privileged operator.** See "What the chain does not prove" and
  "Residual risks" above; this is a design limit, stated once here and not repeated as a caveat on every
  feature that inherits it.
- **Not a legal or compliance certification.** This release makes no claim of SOC 2, ISO 27001, GDPR, or any
  other formal compliance mapping; "audit" here means "independently checkable history", nothing broader.
- **Not provider billing.** No document in this set computes, assigns or guesses a price; see "Invoice
  cross-check" above.
- **Not external timestamping or anchoring.** Publishing a checkpoint to a public, independently timestamped
  service (a blockchain, a transparency log, a notarized commit) is a stronger mitigation than "store it in a
  separate ticket", and is explicitly left for a future release; see
  [docs/audit-chain.md#anchoring-the-head-externally](audit-chain.md#anchoring-the-head-externally) for the
  manual version shipped today.
- **Not a hosted or multi-tenant audit offering.** This is a single-server, single-tenant guarantee.
EOF
