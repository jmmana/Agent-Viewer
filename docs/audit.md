# Auditing the hash chain (issue #388)

This is the practical companion to [docs/audit-chain.md](audit-chain.md) (which documents the chain and
checkpoint *formats* and the server routes in depth) and [docs/cli.md](cli.md#verify-the-audit-chain-issue-388)
(which documents `agent-viewer verify`, the CLI built on everything below). Read this page when you want to:
verify a chain or a checkpoint file **without** running the CLI at all, understand exactly what a signed
checkpoint contains, or decide how to store and pin a public key. It does not repeat the chain's hash format or
`GET /api/v1/audit/verify`'s full response shape; see [docs/audit-chain.md](audit-chain.md) for those.

## Mechanics, in one page

- **The hash chain** (issue #105): every SQLite-stored event's hash commits to its content, its position
  (`seq`), and the previous row's hash, so editing, deleting or reordering a stored row changes a hash every
  later row already committed to. Full format, the genesis/resume checkpoints and the honest scope of what this
  alone proves: [docs/audit-chain.md](audit-chain.md#honest-scope-what-the-chain-does-and-does-not-prove).
- **Signed checkpoints** (issue #387): the server periodically signs the current chain head with an Ed25519
  key, so a copy kept elsewhere proves what the chain looked like at that moment and turns a *consistent*
  rewrite (one that recomputes every later hash correctly) from undetectable into a `head_mismatch`. Format and
  signing schedule: [docs/audit-chain.md#signed-checkpoints-issue-387](audit-chain.md#signed-checkpoints-issue-387).
- **`GET /api/v1/audit/verify`** (issue #106) walks both of the above in one read-only pass and reports the
  first break of either kind.
- **`GET /api/v1/audit/entries/:seq`** (new in this issue): `{ "seq": 5321, "eventId": "evt_8f1c", "entryHash":
  "c0de...42", "prevHash": "b17e...90" }` for one chained row, or `404 seq_not_found`. This is the only piece of
  the live chain an exported-checkpoint cross-check needs to touch: enough to confirm a checkpoint's signed
  `headHash` still matches the chain today, one row at a time, without re-walking or re-uploading anything.
- **`agent-viewer verify`** (also this issue) wraps all of the above into one command, online or against a
  local `--db` file, with `--public-key` to pin trust and `--checkpoints <file>` to cross-check an export. See
  [docs/cli.md](cli.md#verify-the-audit-chain-issue-388) for its flags and exit codes.

## Checkpoint file format

A signed checkpoint (what `GET /api/v1/audit/checkpoints` returns, one per line in `?format=jsonl`, and what
`agent-viewer verify --checkpoints <file>` reads):

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

The committed JSON Schema is [`server/audit/checkpoint.schema.json`](../server/audit/checkpoint.schema.json)
(`$id: https://agent-viewer.dev/schemas/audit/checkpoint/v1.json`); validate an exported file against it with
any off-the-shelf validator (for example `npx ajv-cli validate -s server/audit/checkpoint.schema.json -d
checkpoint.jsonl`, one object per invocation, since the schema describes a single checkpoint, not an array).
`reason` is one of `events | interval | shutdown | manual | key_change`; `keyId` is `ed25519:` plus the hex
SHA-256 of the signing public key's SPKI DER encoding; `prevCheckpointDigest` is `null` only for
`checkpointSeq: 1`.

## Verifying a checkpoint by hand, without the CLI or the server

Three independent facts make a checkpoint trustworthy: its **signature** verifies under a public key you trust,
its **digest** matches what was actually signed, and its **`headHash`** matches the chain's real row at
`headSeq`. All three are plain `node:crypto`/`openssl`, no agent-viewer code required.

**1. Reproduce the digest and verify the signature (`node:crypto`).** The signed bytes are the UTF-8 encoding of
the literal string `"agent-viewer/checkpoint/v1\n"` followed by the RFC 8785 (JCS) canonical JSON of `body`
(object keys sorted by UTF-16 code unit at every level, no whitespace). **`JSON.stringify(body)` alone is not
canonical**: the server builds `body` with its fields in the order the schema lists them (`version`,
`instanceId`, `checkpointSeq`, ...), not alphabetically, so a plain `JSON.stringify` reproduces that
construction order, not the sorted order the signature actually covers, and the digest will not match. Every
field of a checkpoint `body` is a primitive (string, integer or `null`), never a nested object or array, so
sorting only the top level is enough here; `JSON.stringify`'s array-form replacer reorders (and filters)
properties to exactly the order given, which is the simplest correct way to get there without a full RFC 8785
implementation:

```js
import crypto from 'node:crypto';

const checkpoint = JSON.parse(line); // one line of the exported file
const canonicalBody = JSON.stringify(checkpoint.body, Object.keys(checkpoint.body).sort());
const signedBytes = Buffer.from('agent-viewer/checkpoint/v1\n' + canonicalBody, 'utf8');

const digest = crypto.createHash('sha256').update(signedBytes).digest('hex');
if (digest !== checkpoint.digest) throw new Error('digest mismatch: body was altered or re-serialized');

const publicKey = crypto.createPublicKey(fs.readFileSync('audit-public-key.pem', 'utf8'));
const ok = crypto.verify(null, signedBytes, publicKey, Buffer.from(checkpoint.signature, 'base64'));
if (!ok) throw new Error('signature does not verify under this key');
```

`Array.prototype.sort()` with no comparator compares elements as strings by UTF-16 code unit, which is exactly
the order JCS requires; this only holds because every checkpoint `body` key is plain ASCII with no surrogate
pairs. `crypto.verify(null, ...)` is correct for Ed25519 specifically: the algorithm is fixed by the key type and
Node's API takes `null` for the hash algorithm in that case (Ed25519 does not take a separate pre-hash). Do
**not** reuse this top-level-sort shortcut for the hashed *events* themselves (`docs/audit-chain.md`'s
`eventHash`), whose payload can be arbitrarily nested and needs real recursive JCS key-sorting, not a one-level
sort.

**2. The same check with `openssl` (3.0+, which added Ed25519 support to `pkeyutl`).** `jq -S` sorts object keys
recursively, which is more than this flat body needs but still produces the right bytes; `-c` keeps it on one
compact line with no extra whitespace, and `-j` suppresses jq's own trailing newline so it never leaks into the
signed bytes:

```bash
jq -cSj '.body' checkpoint.json > body.json
printf 'agent-viewer/checkpoint/v1\n' | cat - body.json > signed-bytes.bin
jq -r '.signature' checkpoint.json | base64 -d > signature.bin

openssl pkeyutl -verify -rawin -in signed-bytes.bin \
  -sigfile signature.bin -pubin -inkey audit-public-key.pem
# => "Signature Verified Successfully"
```

Confirm `sha256sum signed-bytes.bin` matches the checkpoint's own `digest` field before trusting the `openssl`
result, since a shell quoting or encoding slip here produces a confident-looking but wrong verification either
way.

**3. Chain checkpoints to each other.** Sort the file by `body.checkpointSeq` and confirm `body.checkpointSeq`
is contiguous from the first entry and that each checkpoint's `body.prevCheckpointDigest` equals the previous
line's own `digest` (and is `null` only for `checkpointSeq: 1`). A gap or a broken link here is exactly what
`agent-viewer verify --checkpoints <file>` reports as `checkpoint_missing`/`checkpoint_link_broken`.

**4. Cross-check `headHash` against the live chain.** `GET /api/v1/audit/entries/<headSeq>` (needs the `audit`
scope) returns `{ "entryHash": "..." }` for that row; compare it to the checkpoint's `headHash`. A mismatch, or
a `404 seq_not_found` for a `headSeq` the chain no longer has, means the chain has changed since this checkpoint
was signed (or, if checked offline, open the `.db` file read-only and read `SELECT hash FROM events WHERE seq =
?` yourself: `AGENT_VIEWER_SQLITE_PATH`'s file, plus its `-wal`/`-shm` siblings if present).

Doing all four steps by hand for every checkpoint in a long chain is exactly what `agent-viewer verify
--checkpoints <file>` automates; reach for the CLI for routine verification and keep this page for the one time
you want to double-check the CLI itself, or verify without installing anything at all.

## Key handling guidance

- **Treat the public key file the same as any other root of trust.** `--public-key` only protects you if the
  PEM file you point it at is a copy you obtained and stored independently of the server you are verifying; a
  key fetched from that same server at verification time (the default, unpinned path) proves nothing about a
  server that has already been fully compromised, including its own `audit_keys` table.
- **Get the key out of band, once, and keep it somewhere the thing you are auditing cannot also write to**: a
  password manager entry, a separate repository, a paper printout of the fingerprint, a ticket. `GET
  /api/v1/audit/keys` is convenient for fetching it the first time, not for re-fetching it every time you verify.
- **A key rotation is not a verification failure to silently work around.** If `agent-viewer verify
  --public-key old-key.pem` starts reporting `key_unknown` for new checkpoints, that is this tool correctly
  telling you the server started signing with a key your pinned copy does not recognize; confirm the rotation
  really happened (through a channel other than the server itself, such as a deployment log or a teammate) before
  updating which key you pin.
- **The private key never leaves the server you are auditing**, and nothing in this page or the CLI ever asks
  for it. [docs/audit-chain.md#signing-key](audit-chain.md#signing-key) documents how the server itself resolves
  and stores it (`AGENT_VIEWER_AUDIT_SIGNING_KEY`/`AGENT_VIEWER_AUDIT_KEY_FILE`, file mode `0600`); that page is
  the one to read before deploying a signer, not this one.
- **Back up a verified checkpoint export, not just the public key.** The key alone only lets you verify a
  checkpoint you are shown; keeping your own copy of checkpoints as you go is what lets a later `--checkpoints
  <file>` cross-check catch a checkpoint that quietly went missing from the server's own history.

## Honest limits

- **Pinning a key only helps if the pinned copy is genuinely independent of the thing being audited.** A public
  key fetched from the same server, at the same time, over the same connection as everything else you are
  verifying is not a pin in any meaningful sense; see "Key handling guidance" above.
- **`GET /api/v1/audit/entries/:seq` proves one row's current hash, nothing more.** It does not prove that row
  was never otherwise part of a consistent rewrite before you first checked it; a cross-check is only as good as
  how early and how often you perform it, and comparing against a checkpoint signed *before* a suspected
  incident is what actually establishes a baseline.
- **A consistent rewrite of the entire chain, by someone with full file-system access and the current signing
  key, remains undetectable by construction** (not a bug in this issue): that is exactly what an externally held
  checkpoint or recorded head is for, and why "pin a key you already trust" is this page's first piece of advice,
  not an afterthought. The chain's full honest-scope statement, including memory storage, pre-genesis coverage,
  unhashed indexed columns and power-loss behavior, is in
  [docs/audit-chain.md#honest-scope-what-the-chain-does-and-does-not-prove](audit-chain.md#honest-scope-what-the-chain-does-and-does-not-prove).
- **`--scope recent` is not yet a real optimization.** Both the server route and `agent-viewer verify --scope
  recent` fall back to a full walk today; see [docs/audit-chain.md](audit-chain.md#verification-get-apiv1auditverify).
- **Raw-event retention and redaction (issue #109) can make an old, previously valid checkpoint fail.**
  Tombstoning a row covered by a signed checkpoint changes that row's content but not its `seq`, which makes the
  checkpoint's `headHash`/`chainedCount` disagree with the current chain (`head_mismatch`/`count_mismatch`),
  exactly as if the row had been tampered with. This is expected and documented, not a false positive to
  suppress: a tombstoned row genuinely changed, for a legitimate reason recorded in its own chained
  `audit.retention.purged`/`audit.redaction.applied` event, and a checkpoint signed before that change correctly
  stops matching the chain after it.
