# Offline-verifiable audit bundle (issue #110: #400, #401, #402)

A single file an auditor, a customer, or a finance team can download once and check forever after, without
trusting this server again, without network access, and without installing Agent Viewer: every stored event in a
range, its usage-ledger row, the signed checkpoints and signing keys that cover it, any tombstone, and a footer
with reconciliation totals and a content digest. `GET /api/v1/audit/bundle` (#400) produces it;
`scripts/verify-audit-bundle.mjs` (#401) checks it with nothing but Node built-ins; `agent-viewer audit
export`/`verify` (#402) is the CLI wrapper around both. This document is normative enough to write an independent
verifier from, should the committed script ever need replacing.

Requires `AGENT_VIEWER_STORAGE=sqlite` with the hash chain (#105) enabled. Memory mode has nothing to export.

## Format: NDJSON, one JSON object per line

File extension `.avbundle.jsonl`, or `.avbundle.jsonl.gz` when gzipped (`?gzip=1`). Every line has a `kind`, in
this fixed order:

| Order | `kind` | Count | Content |
|---|---|---|---|
| 1 | `header` | 1 | Format and range metadata |
| 2 | `key` | 0 or more | Every signing public key on record (#387), never a private key |
| 3 | `pricing` | 0 or more | Each pricing version referenced by a ledger row in range, with its own digest |
| 4 | `checkpoint` | 0 or more | Signed checkpoints (#387) whose `headSeq` falls in range, ascending |
| 5 | `tombstone` | 0 or more | Redaction/retention records (#109) for a tombstoned row in range |
| 6 | `event`, each optionally followed by its `ledger` line | N events, M ledger rows | Chained events in ascending `seq`; a usage event is followed immediately by its ledger row |
| 7 | `footer` | 1 | Counts, reconciliation totals, and a content digest |

### `header`

```json
{"kind":"header","format":"agent-viewer-audit-bundle","formatVersion":1,"generatedAt":1790000000000,"instanceId":"8f7f1fbc-...","storage":"sqlite","chain":{"algorithm":"sha256","canonicalization":"JCS-RFC8785"},"range":{"fromSeq":1,"toSeq":48211,"prevHash":"<64-hex>","headHash":"<64-hex>"},"requested":{"fromSeq":null,"toSeq":null,"from":null,"to":null},"complete":true}
```

- `range.fromSeq`/`range.toSeq` are the resolved chain `seq` bounds actually exported (inclusive); `requested`
  echoes exactly what the caller asked for, before any clamping to the live chain.
- `range.prevHash` is the hash of the chained row immediately before `fromSeq` (the genesis checkpoint's own hash
  when the range starts at the very first chained row); `range.headHash` is the hash of the row at `toSeq`, or
  equal to `prevHash` for an empty range.
- `complete` is `true` only when `fromSeq` is the chain's first chained row. A partial range (an explicit
  `fromSeq` past that point) is still fully self-consistent and verifiable; it just cannot vouch for anything
  before it. `formatVersion` is an integer major: the verifier refuses an unknown one with exit code 2 and
  otherwise ignores unknown fields inside a known major, so additive changes stay compatible.

### `key`

```json
{"kind":"key","keyId":"ed25519:92e9bf87...","algorithm":"ed25519","publicKeyPem":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n","createdAt":1790000000000,"retiredAt":null,"active":true}
```

Every key that ever signed on this server (`server/audit/checkpoints.ts`'s `AuditCheckpointService.keys()`), not
only the one active today, so a checkpoint signed before a key rotation still has its signer on record. `keyId`
is `ed25519:` + lowercase hex SHA-256 of the public key's SPKI DER encoding; it is what `--trusted-key` pins
against.

### `pricing`

```json
{"kind":"pricing","pricingVersion":2,"digest":"sha256:cf1bc31a...","createdAt":"2026-10-12T19:58:46.583Z","origin":"api","entries":[{"provider":"acme","model":"acme-1","kind":"list","currency":"USD","effectiveFrom":"2026-01-01T00:00:00Z","inputPerMillion":1,"outputPerMillion":5,"...":"every PriceEntry field"}]}
```

Only versions a ledger row in this range actually estimated against (`usage_ledger.pricing_version`, joined to
the exported events). `digest` is `src/integrations/pricingContract.ts`'s existing `computeContentHash(entries)`
("sha256:" + hex SHA-256 of the canonical JSON of the sorted, key-ordered entries), recomputed from the `entries`
on the same line, so an edited entry with a stale digest is caught by the `PRICING` check without needing the
live pricing store at all.

**Honest limit, deliberate and documented, not a bug:** this digest is **not yet anchored in the hash chain**.
The pricing table (`server/pricing/store.ts`) lives in flat files that predate the hash chain by two milestones,
and issue #110 itself allows deferring that chain-commitment work to a follow-up of #83 when #83 does not already
provide it, which it does not. In practice this means: the `pricing` line proves the shipped `entries` match the
shipped `digest`, and that every `estimatedCost` in this bundle follows from those `entries` (the verifier
recomputes it), but it does not yet prove the `entries` themselves were never edited at the source. A future
`audit.pricing.activated` chained commitment event (the same pattern issue #107 uses for `audit.key.created`)
would close this gap without changing this line's shape.

### `checkpoint`

```json
{"kind":"checkpoint","body":{"version":1,"instanceId":"8f7f1fbc-...","checkpointSeq":1,"headSeq":48211,"headHash":"<64-hex>","chainedCount":48211,"createdAt":1790000000000,"reason":"manual","keyId":"ed25519:92e9bf87...","prevCheckpointDigest":null},"digest":"<64-hex>","signature":"<base64>"}
```

The exact `SignedCheckpoint` shape #387 already defines (`server/audit/checkpointFormat.ts`): `body` is signed
as `sha256("agent-viewer/checkpoint/v1\n" + canonicalize(body))`, Ed25519 over those same bytes, no pre-hash.
**Tail anchoring:** for a non-empty range, the last `checkpoint` line always has `body.headSeq === range.toSeq`.
If the newest checkpoint already on record was older than the requested `toSeq`, the exporter signs a fresh one
at exactly `toSeq` before streaming (`AuditCheckpointService.createCheckpointAt`), so a bundle whose tail is not
covered by a signature is never produced.

### `tombstone`

```json
{"kind":"tombstone","seq":42,"eventId":"evt_...","at":1790000000000,"reason":"retention","auditSeq":57,"rulesVersion":null,"contentHash":"<fingerprint, unsalted>"}
```

One per tombstoned row in range (#109). `seq`/`eventId` identify the tombstoned event itself; `auditSeq` is the
`seq` of the chained `audit.retention.purged`/`audit.redaction.applied` event (also exported, as an ordinary
`event` line) that committed the tombstone; `contentHash` is the row's preserved, unsalted content fingerprint.
The `REDACTION` check cross-references this against that audit event's own `payload.events[]` entry.

### `event`

```json
{"kind":"event","seq":1,"prevHash":"<64-hex or null>","hash":"<64-hex>","receivedAt":1790000000000,"submitterId":"key_3f9a1c7e02ab","event":{"schemaVersion":"1.0","id":"evt_1","type":"llm.usage","...":"the exact stored CanonicalEvent, as JSON.parse(event_json)"}}
```

Stored form, unredacted (the per-field redaction `GET /api/v1/usage/export` applies only touches that route's
own CSV/JSONL rows, never the raw event; see [docs/redaction.md](redaction.md)). `hash`/`prevHash` are exactly
`server/chain.ts`'s `eventHash` output; `prevHash` of the first event in the bundle equals `header.range.prevHash`.
A tombstoned event (`agent.*`/`llm.*` type, content replaced per #109) keeps its original `hash`/`prevHash`
unchanged, so the chain links still verify even though the content no longer recomputes to that hash; see
`REDACTION` below for how that specific case is checked instead. Internal `audit.*` events (key creation/
revocation, tombstone/legal-hold records) are included like any other chained row when they fall in range; they
are never broadcast live and never reach `GET /api/v1/events` by default, but they are not excluded here, since
excluding them would make the `REDACTION` check's audit-event cross-reference impossible for a tombstone near a
range boundary.

### `ledger`

```json
{"kind":"ledger","ledgerSeq":1,"eventId":"evt_1","requestId":"req_1","receivedAt":"2026-...Z","occurredAt":"2026-...Z","status":"ok","provider":"acme","model":"acme-1","inputTokens":1200,"outputTokens":400,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":null,"latencyMs":null,"cost":null,"currency":null,"costSource":"unknown","summary":"...","redacted":false,"estimatedCost":0.0096,"estimatedCostNano":9600000,"estimatedCurrency":"USD","estimatedCostSource":"estimated","pricingVersion":2,"estimateStatus":"estimated","estimateRevision":0,"estimatedAt":1790000000000}
```

Immediately follows an `llm.usage`/`llm.failed` event line: the usage-ledger row (#65) for that call, through the
same `toExportCallRecord` mapping `GET /api/v1/usage/export` uses (so its field names and redaction behavior are
identical to that route's JSONL `record:"call"` rows, just under `kind:"ledger"` instead). `null` means "not
reported" and is never written as `0`; a `0` is a real reported zero. `estimatedCost`/`estimatedCostNano` are a
separate fact from `cost`/`currency` (the provider-reported figure) and are never mixed with it.

### `footer`

```json
{"kind":"footer","counts":{"events":48211,"ledger":9120,"checkpoints":14,"tombstones":0,"pricing":2},"totals":{"calls":9120,"callsByStatus":{"ok":9000,"failed":120},"tokens":{"inputTokens":{"sum":8123456,"knownCalls":9120,"unknownCalls":0},"outputTokens":{"...":"..."},"cacheReadTokens":{"...":"..."},"cacheWriteTokens":{"...":"..."},"reasoningTokens":{"sum":null,"knownCalls":0,"unknownCalls":9120}},"reportedCost":[{"currency":"USD","knownCalls":4000,"unknownCalls":0,"cost":123.45},{"currency":null,"knownCalls":0,"unknownCalls":5120,"cost":null}],"estimatedCost":[{"currency":"USD","knownCalls":5120,"unknownCalls":0,"cost":49.2}]},"contentSha256":"<64-hex>"}
```

- `counts` must match the lines actually present; a mismatch is a `FORMAT` failure (a truncated or edited file).
- `totals` is the five token dimensions plus reported and estimated cost, summed in ascending `seq` order with
  IEEE doubles so the server and the verifier reach bit-identical sums. `sum`/`cost` is `null` exactly when
  `knownCalls` is `0`, never a fabricated `0`. `reportedCost` and `estimatedCost` are separate arrays, one group
  per currency (`currency: null` is its own group, sorted last), never summed together and never summed across
  currencies.
- `contentSha256` is the SHA-256 of every line's UTF-8 bytes plus its trailing `\n`, from the `header` line
  through the line immediately before this `footer` line; the footer's own line is never part of what it
  hashes. It detects truncation, edits and appended junk before any deeper check runs; it is not a security
  control on its own (anyone can recompute it), only the signed checkpoints and a pinned key give it
  authenticity.

## Verifying a bundle

```bash
agent-viewer audit verify bundle.avbundle.jsonl --trusted-key ed25519:92e9bf87c31a0bd350be611d630f92285b02945e6a8575970741573ae5cd1580
# or, without the CLI installed, against the downloaded release asset:
node verify-audit-bundle.mjs bundle.avbundle.jsonl --trusted-key ed25519:92e9bf87...
```

`--trusted-key` accepts either the literal `ed25519:<64-hex>` fingerprint (the same string as a bundle's own
`key.keyId`) or a path to a PEM file holding that Ed25519 public key; pin it once, out of band, the first time
you receive a key from this server (a phone call, a signed email, anywhere other than the bundle itself: the
embedded key line alone proves nothing about who holds it).

Nine checks, each reported pass/fail with the first offending `seq`/`id`:

| Check | What it verifies |
|---|---|
| `FORMAT` | Header first, footer last and exactly once, known `formatVersion`, section order, `counts` match, `contentSha256` matches |
| `CHAIN` | Every (non-tombstoned) event's hash recomputes; every `prevHash` link matches, including the first row against `header.range.prevHash` |
| `CHECKPOINTS` | Each checkpoint's signature verifies against a `key` line in the bundle, its digest matches its own body, `checkpointSeq` strictly increases, `prevCheckpointDigest` chains correctly, `headHash` matches the event at `headSeq` |
| `KEY` | With `--trusted-key`: every signing key's fingerprint matches it. Without it: unproven authenticity, reported as the `unpinned` verdict, not a failure |
| `LEDGER` | Each ledger line directly follows a matching `llm.usage`/`llm.failed` event, and its provider/model/status/token fields agree with that event's own payload |
| `PRICING` | Each pricing line's digest matches its own entries; each ledger row's `estimatedCost` recomputes from its tokens and the matching pricing version |
| `TOTALS` | The footer's `totals` recompute exactly from the ledger lines alone |
| `REDACTION` | Each tombstone is committed by its audit event, with the original hash and content hash it names |
| `EXPECT` | Only with `--expect-checkpoint <seq>:<headHash>`: that exact point is reachable in this bundle's checkpoints or chain |

Exit codes, in this precedence order (2, then 1, then 3, then 0):

| Exit | Verdict | Meaning |
|---|---|---|
| `0` | `pass` | Every check passed and every signing key matched `--trusted-key` (and `--require-complete`'s condition, if given) |
| `1` | `fail` | At least one check failed, or the range is partial and `--require-complete` was given |
| `2` | `invalid` | Unreadable file, malformed JSON line, missing/duplicate header or footer, unsupported `formatVersion`. The bundle is rejected outright, never "partially OK" |
| `3` | `unpinned` | Every check passed, but no `--trusted-key` was given (or it matched nothing to verify against): integrity is proven, authenticity is not |

`--json` prints one JSON document on stdout (`{verdict, complete, range, keys, warnings, checks, firstFailure}`)
and nothing else; human output goes to stdout as a pass/fail line per check plus a one-line verdict, with no
other machine-readable contract. Gzip is detected by magic bytes, not only the `.gz` extension.

## CLI

```bash
agent-viewer audit export --out bundle.avbundle.jsonl [--from-seq <n>] [--to-seq <n>] [--gzip] [--url <url>] [--token <token>]
agent-viewer audit verify bundle.avbundle.jsonl [--trusted-key <fingerprint|pem-file>] [--expect-checkpoint <seq>:<headHash>] [--require-complete] [--json]
```

`export` requires the `audit` scope (the bootstrap token, or a named key granted `audit`/`admin`; see
[docs/api-keys.md](api-keys.md)) and `AGENT_VIEWER_STORAGE=sqlite` on the server; `--url`/`--token` resolve the
same way as `agent-viewer send`. It streams the response straight to a temp file next to `--out` and renames it
only after a clean end, so a failed or interrupted export never leaves a file at `--out` that looks complete.

`verify` never talks to a server at all: it runs `scripts/verify-audit-bundle.mjs` as a child process (the
packaged CLI ships a copy next to `cli.js`, copied at build time) and returns its exit code unchanged, so there
is exactly one implementation of every check, not two that could drift apart.

Downloading the script directly, without installing anything, works the same way:

```bash
curl -LO https://github.com/jmmana/Agent-Viewer/releases/download/<tag>/verify-audit-bundle.mjs
curl -LO https://github.com/jmmana/Agent-Viewer/releases/download/<tag>/verify-audit-bundle.mjs.sha256
sha256sum -c verify-audit-bundle.mjs.sha256
node verify-audit-bundle.mjs bundle.avbundle.jsonl --trusted-key ed25519:...
```

The script is deliberately small, plain and dependency-free; reading it is the recommended way to confirm it
checks what this document says it checks.

## Honest limits

- **Pricing-digest chain anchoring is deferred**, as explained under `pricing` above: this bundle proves
  internal consistency (entries match their digest, estimates follow from entries), not yet that the entries
  were never edited at the source.
- **No signing key at all** (a SQLite server that never configured #387) still produces a bundle, just with zero
  `key`/`checkpoint` lines; every export is then permanently `unpinned`, with no way to upgrade that later for
  rows exported under that gap.
- **Full 1M-event-scale verification is an architectural property** (line-by-line streaming via `node:readline`,
  bounded per-line state), exercised by this repo's own tests at a few thousand events, not empirically re-run at
  that exact scale in CI for resource reasons.
- **A partial range proves nothing about what came before `fromSeq`.** `header.complete: false` and a verifier
  warning both say so explicitly; `--require-complete` turns an otherwise-clean partial bundle into a failure for
  a caller that specifically needs the full history.
