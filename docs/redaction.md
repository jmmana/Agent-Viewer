# Secret redaction (issue #68)

A pure, dependency-free module (`src/integrations/redaction.ts`) that finds secret-shaped text and
replaces it with a deterministic `[REDACTED:<rule>]` marker. The server, the portal and the library all
import this one file, so the three never disagree on what a secret looks like. This page documents the
module as merged: what it catches, where it actually runs today, how to check it yourself, and the honest
limits of a regex-based baseline.

## What is redacted

`BUILTIN_REDACTION_RULES` (policy id `builtin-1`) is the active rule set. Every rule requires a minimum
body length so short, ordinary words never match, and tolerates a 60- or 140-character truncation (a
trimmed summary, a flattened log line) so a cut-off secret is still caught by its surviving prefix.

| Rule | Catches | Example shape |
|---|---|---|
| `anthropic_api_key` | Anthropic API keys | `sk-ant-...` |
| `openai_api_key` | OpenAI API keys, including `proj-`, `svcacct-`, `admin-` and `or-v1-` variants | `sk-...`, `sk-proj-...` |
| `google_api_key` | Google API keys | `AIza...` |
| `huggingface_token` | Hugging Face tokens | `hf_...` |
| `groq_api_key` | Groq API keys | `gsk_...` |
| `slack_token` | Slack tokens (bot, user, app, etc.) | `xoxb-...`, `xoxp-...` |
| `stripe_key` | Stripe secret and restricted keys, live or test | `sk_live_...`, `rk_test_...` |
| `gitlab_token` | GitLab personal access tokens | `glpat-...` |
| `npm_token` | npm access tokens | `npm_...` |
| `github_token` | GitHub tokens (personal, OAuth, server-to-server, refresh) and fine-grained PATs | `ghp_...`, `github_pat_...` |
| `aws_access_key_id` | AWS access key ids | `AKIA...`, `ASIA...` |
| `aws_secret_access_key` | AWS secret access keys, found by the `aws_secret_access_key=`/`secretAccessKey:` assignment that precedes them | the value only, not the key name |
| `azure_storage_key` | Azure storage account keys, found by the `AccountKey=` prefix in a connection string | the value only |
| `bearer_token` | The token half of an `Authorization: Bearer <token>` header | keeps the literal `Bearer ` prefix |
| `basic_auth_header` | The credential half of an `Authorization: Basic <value>` header | keeps the literal `Basic ` prefix |
| `jwt` | JSON Web Tokens (header and payload segments; signature is optional so a truncated token still matches) | `eyJ...eyJ...` |
| `private_key_block` | PEM private key blocks, `-----BEGIN ... PRIVATE KEY-----` through its `END` marker or to the end of a truncated string | |
| `connection_string_password` | The password segment of a `scheme://user:password@host` URL, or a `password=`/`pwd=` assignment | keeps `scheme://user:@host` |
| `secret_assignment` | A generic `key: value` or `key=value` pair whose key looks like a secret (`password`, `secret`, `api_key`, `access_token`, `auth_token`, and the `-`/`_` spellings of each) | the value only, 8+ characters, not purely numeric so a token-count field is never mistaken for one |

Plus one rule a server can add at runtime, not part of the built-in set:

- `own_secret`: the server's own configured secrets (its `AGENT_VIEWER_API_TOKEN`, a webhook secret), passed
  to `compileRedactionPolicy({ ownSecrets: [...] })` as exact literals of 8 or more characters. It runs
  before the provider-shaped rules, so the server's own token is labelled `own_secret` even where it would
  otherwise also match `bearer_token`.

A masked placeholder such as `********` or `xxxxxxxx` is never treated as a secret by the
group-based rules (key-value dumps, bearer/basic headers, connection strings): the fixed-prefix provider
key rules do not need this guard, because their charset already excludes a repeated character run.

Every match becomes `[REDACTED:<rule name>]`, for example `[REDACTED:anthropic_api_key]`. The marker never
contains the matched text, and redacting an already-redacted string always reports `count: 0`
(`redactText` is idempotent): a rule can never match its own marker, and running redaction twice never
produces a different result than running it once.

## Where it runs today

**Only at export time.** `GET /api/v1/usage/export` and `GET /api/v1/usage/export/totals`
(see [docs/usage-export.md](usage-export.md)) are, as merged, the only caller of this module in the
server. Every text column of an exported row (`eventId`, `requestId`, `provider`, `model`, `runtimeId`,
`sessionId`, `agentId`, `taskId`, `traceId`, `parentId`, `toolCallId`, `userId`, each tag individually,
`currency` and `summary`) is passed through `redactText` on every export request, even for a row that was
already clean when it was stored. The export's own `redacted` column reports, per row, whether anything
changed. Because this runs on read, not on write, a rule added after a row was written still protects that
row retroactively, every time it is exported again.

**Nowhere else, yet.** This is the honest state of the merged code, not a simplification:

- The `usage_ledger.summary` column, `events.payload`/`events` free text, the live SSE stream, replayed
  history (`GET /api/v1/events`), webhook payloads and the demo app's own stored state are all **not**
  redacted. They hold exactly what the client sent. If a client puts a secret in a `summary` or a message
  field, that secret is stored and streamed as-is, and only disappears from the one place that redacts:
  an export of the usage ledger.
- `GET /api/v1/usage/calls` never has this problem by a different mechanism: it is an explicit allow-list
  of ledger columns (see [docs/integration.md](integration.md#usage-calls-get-apiv1usagecalls-issue-67))
  that never includes `summary`, `payload`, prompt, completion, message or tool text in the first place, so
  there is nothing free-text to redact there.
- There is no `AGENT_VIEWER_REDACTION*` environment variable and no `GET /api/v1/redaction/policy`
  endpoint in this release. `compileRedactionPolicy()`'s `extra` (operator-supplied patterns), `disable`
  (turning off a built-in rule) and `ownSecrets` options exist in the module's TypeScript API and are
  fully tested (`tests/redaction.test.mjs`), but nothing in `server/index.ts` reads an environment variable
  and calls them: the export route always redacts with `defaultRedactionPolicy()`, the built-ins only, no
  `disable`, no `extra`, no `ownSecrets`. Wiring ingestion-time redaction, a redaction policy endpoint, the
  three environment variables, the `CanonicalEvent.redaction` contract field, the SDK's `redactions`
  pass-through and the portal's "mask secrets" toggle are tracked as follow-up work under issue #68, not
  shipped in 0.4.0.

If your threat model requires that a secret never reaches storage at all, do not rely on this module yet:
keep secrets out of what you send to `usage()`, `message()` and every other free-text field, the same
guidance the SDKs and [.github/SECURITY.md](../.github/SECURITY.md) already give.

## Verifying it yourself

The fastest check is the one the export route itself runs. Send an event whose `summary` contains a
secret-shaped string, then export it and look at the `redacted` column and the marker in the output:

```bash
curl -s -X POST http://localhost:8787/api/v1/webhooks/generic \
  -H "Authorization: Bearer $AGENT_VIEWER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"agent":"demo","status":"THINKING","message":"token sk-ant-0000000000000000000000 leaked in a log"}'

curl -s -H "Authorization: Bearer $AGENT_VIEWER_API_TOKEN" \
  "http://localhost:8787/api/v1/usage/export?format=jsonl&agentId=demo" | tail -1
```

A row whose `summary` contained that string comes back with
`"summary": "token [REDACTED:anthropic_api_key] leaked in a log"` and `"redacted": true`.

To check a pattern directly, without a server, call the module the same way `tests/redaction.test.mjs`
does:

```ts
import { redactText } from './src/integrations/redaction.ts';

const { text, count, byRule } = redactText('Authorization: Bearer sk-test-not-a-real-secret-value-00');
console.log(text);   // "Authorization: Bearer [REDACTED:bearer_token]"
console.log(count);  // 1
console.log(byRule); // { bearer_token: 1 }
```

`tests/redaction.test.mjs` carries a true-positive and false-positive fixture for every built-in rule
(built by runtime string concatenation, never a literal secret, so the repository itself stays clean for
push protection and gitleaks), plus idempotency, determinism, truncation and the identifier guard
(`findSecretsInIdentifiers`, which flags but never rewrites a secret that lands in an id field such as
`agentId`, `requestId` or `provider`, fields that are never free-text scanned because rewriting an
identifier would break deduplication and lookups).

## The honest limit

This is a best-effort baseline, not a guarantee that no secret survives:

- It is regex pattern matching against known shapes. A secret format not in the built-in list, a secret
  pasted with unusual spacing or encoding, or a brand-new provider key prefix will not be caught until a
  rule is added for it.
- A high-entropy value that happens to look like ordinary text (a UUID, a long hex id, a base64 blob with
  no recognizable prefix) is never flagged: the rules key off provider-specific prefixes and key-value
  context, not entropy.
- It only ever runs where it is wired in (export, today). Anything not redacted at read time because it
  was never passed through this module (the raw ledger row, the live stream, a webhook replay) keeps
  whatever text the client originally sent.
- `own_secret` only protects secrets the caller explicitly lists; the export route today passes no
  `ownSecrets`, so the server's own API token or webhook secret is not specially labelled there (it would
  still be caught as `bearer_token` if it appears after `Bearer `, like any other value of that shape).

Extending or disabling a rule is possible in code today (`compileRedactionPolicy({ extra, disable,
ownSecrets })`), but not yet through server configuration; see "Where it runs today" above. Until
ingestion-time redaction ships, treat every event you send as if it will be stored and streamed verbatim,
and keep secrets out of it in the first place.

See also [docs/retention.md](retention.md) for how long data (redacted or not) stays on disk, and
[.github/SECURITY.md](../.github/SECURITY.md) for the production hardening checklist.
