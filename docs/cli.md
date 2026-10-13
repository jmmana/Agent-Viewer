# The `agent-viewer` command

One command starts the ingestion server and the office together, on your machine, protected by a token:

```bash
npx @warlockcode/agent-viewer
```

> Until `@warlockcode/agent-viewer` is on npm, download the `.tgz` attached to the [GitHub release](https://github.com/jmmana/Agent-Viewer/releases) and run `npx ./warlockcode-agent-viewer-<version>.tgz`, or from a clone run `npm ci && npm run build:cli && node dist-cli/cli.js`.

It prints something like this and opens the office in your browser:

```text
  Agent Viewer 0.3.0 is running

  Office  http://127.0.0.1:8787/?mode=live#token=av_x8Kq...
  API     http://127.0.0.1:8787/api/v1
  Token   av_x8Kq...

  Send a test event:

    curl -X POST http://127.0.0.1:8787/api/v1/webhooks/generic \
      -H "Authorization: Bearer av_x8Kq..." \
      -H "Content-Type: application/json" \
      -d '{"agent":"demo","status":"THINKING","message":"Hello from curl"}'
```

Paste the `curl` command in another terminal and an agent called `demo` walks into the office.

Requires Node.js 22.13 or later (the package declares it in `engines`, so npm warns on older versions); it is tested on Node 24. Stop it with `Ctrl+C`.

## Options

| Option | Default | What it does |
|---|---|---|
| `--port <n>` | `PORT`, or `8787` | Port for the office and the API. `0` picks a free port. |
| `--host <address>` | `AGENT_VIEWER_HOST`, or `127.0.0.1` | Interface to listen on. The default accepts only this machine. `0.0.0.0` exposes it to your network: `/api/v1` still needs the token, but the office page and `/health` are public, and with `AGENT_VIEWER_WEBHOOK_SECRET` set the webhooks accept a valid signature instead of the token. The plain `HOST` variable is not read, because some shells (tcsh) export it with the machine name. |
| `--token <token>` | `AGENT_VIEWER_API_TOKEN`, else the deprecated `AGENT_VIEWER_API_KEY`, else a new random token | Token for `/api/v1`. Clients send `Authorization: Bearer <token>`. An empty or blank variable counts as unset, so the CLI never runs without a token. |
| `--demo` | off | Opens the office with the simulated demo team. Your events still arrive on top of it. |
| `--no-open` | opens | Do not open the browser. |
| `--record <file>` | off | Appends every event the server accepts while the CLI runs to a [canonical JSONL V1](event-log.md) file, one JSON line per event and no duplicates, ready to replay or export to video. A new file is created readable only by you (mode 0600), because events can carry summaries. Best effort: nothing from before the CLI started, no fsync, and a write error mid-run (full disk) stops the recording with one warning while the server keeps running. A path that cannot be written stops the CLI before it starts. |
| `--metrics` | off | Enables `GET /metrics` (issue #103), a Prometheus text-exposition export. Still needs its own credential: set `AGENT_VIEWER_METRICS_TOKEN` for a stable one, or it falls back to the API token above (which the CLI regenerates every run unless `--token`/`AGENT_VIEWER_API_TOKEN` is set). This first slice exposes only `agent_viewer_build_info` and `agent_viewer_sse_clients`; the ledger-derived families (tokens, cost, calls, failures, latency) and the optional OTLP push ship in later sub-issues of #103. See the [README configuration table](../README.md#-configuration) for every `AGENT_VIEWER_METRICS*` variable. |

### Where the token travels

- **The printed office URL** carries the token in its fragment (`#token=...`). Browsers do not send the fragment to the server. As soon as the office reads it, it removes it from the address bar and from the history entry (`history.replaceState`), and keeps it in that tab's `sessionStorage` so a reload still connects. The URL stays visible in your terminal, where it was printed.
- **The browser the CLI opens** never gets the token: the command line of a process is visible to other local processes, so the CLI passes a single-use launch code instead (`#launch=...`). The office trades it for the token once (`POST /api/cli/launch`), and the code expires after two minutes. It is removed from the address bar the same way.
- **The live stream** sends the token in an `Authorization: Bearer` header over a streamed `fetch`, so it does not appear in URLs, the server's access logs or a proxy's logs. A browser whose `fetch` cannot stream (no `ReadableStream`) falls back to `EventSource`, which cannot send headers: it trades the token for a single-use, short-lived ticket first (`POST /api/v1/stream-tickets`), and opens the stream with that ticket instead. A `token` query parameter never authenticates `/api/v1`, on any route (issue #71).

### Environment

The server keeps events in memory by default, capped at `AGENT_VIEWER_MAX_EVENTS` (10,000 unless set); a retry of an event evicted from that window is still recognized as a duplicate, never double counted (issue #53). Set `AGENT_VIEWER_STORAGE=sqlite` (and optionally `AGENT_VIEWER_SQLITE_PATH`) to persist every event instead, raise `AGENT_VIEWER_MAX_EVENTS` for a bigger in-process window, or leave both and read `retention` on `GET /api/v1/snapshot` to see whether anything has been dropped. The other server variables in the [README](../README.md#-configuration) apply too (`AGENT_VIEWER_CORS_ORIGIN`, `AGENT_VIEWER_MAX_BATCH_SIZE`, `AGENT_VIEWER_RATE_LIMIT`, `AGENT_VIEWER_WEBHOOK_SECRET`), with these differences:

- `PORT` and `AGENT_VIEWER_HOST` are the defaults of `--port` and `--host`; the flags win.
- `AGENT_VIEWER_API_TOKEN` (or the deprecated `AGENT_VIEWER_API_KEY`, read with a warning) chooses the token. Unlike `npm run server`, an empty value never means "open": the CLI generates a token.
- A `.env` file in the current folder is not read: the CLI is configured by its flags and the environment.

## Send an event without writing JSON

```bash
npx @warlockcode/agent-viewer send --agent demo --status working
npx @warlockcode/agent-viewer send --agent demo --status coding --message "Writing the parser"
```

`send` posts one canonical `agent.status.changed` event, plus an `agent.message.sent` when you pass `--message`.

| Option | What it does |
|---|---|
| `--agent <id>` | Agent id (required). Unknown agents are created on the fly. |
| `--status <status>` | An office status (`thinking`, `coding`, `testing`, `waiting`, `waiting-approval`, `done`, `error`...) or an everyday word: `working`, `busy`, `ready`, `finished`, `failed`, `stopped`. |
| `--message <text>` | Optional speech bubble. |
| `--url <url>` | Server URL. Default: the running `agent-viewer`, else `http://127.0.0.1:8787`. |
| `--token <token>` | Token. Default: the running `agent-viewer`'s token. |

`send` and `claude-hook` find a running `agent-viewer` through a small session file it writes on start and removes on exit: `~/.agent-viewer/session.json` (owner-only permissions; change the folder with `AGENT_VIEWER_HOME`). `AGENT_VIEWER_URL` and `AGENT_VIEWER_API_TOKEN` override it.

The pricing table (see `docs/pricing.md`) lives next to it: `pricing.json` and `pricing-history.jsonl` under the same `AGENT_VIEWER_HOME` folder by default, so `npx agent-viewer` never writes them into the current directory. Override either path with `AGENT_VIEWER_PRICING_FILE` / `AGENT_VIEWER_PRICING_HISTORY_FILE`.

## Named API keys (issue #107)

```bash
agent-viewer keys create ci-pipeline --expires-in 30d
agent-viewer keys list
agent-viewer keys revoke key_3f9a1c7e02ab
agent-viewer keys whoami
```

Requires a viewer started with `AGENT_VIEWER_STORAGE=sqlite` (named keys must survive a restart to be
auditable); against a memory-mode viewer every subcommand fails with the server's `keys_require_sqlite` message.
`--url`/`--token` resolve the same way as `send`: flags, then `AGENT_VIEWER_URL`/`AGENT_VIEWER_API_TOKEN`, then
the session file. `--token` here is the **bootstrap** credential (`AGENT_VIEWER_API_TOKEN`), the only one that
may manage keys.

| Option | What it does |
|---|---|
| `create <name> [--expires-in <n>m\|<n>h\|<n>d]` | Creates a key. Prints the new token once to stdout (a warning that it cannot be shown again goes to stderr); it is never written to the session file and never accepted as a command-line argument, so it never shows up in the process list. |
| `list` | A table of every key: name, id, status, last used, event count. |
| `revoke <id>` | Revokes a key. Prints its new status; a second call on an already-revoked key succeeds and reports the same status. |
| `whoami` | The identity the resolved credential authenticates as. |
| `--json` | Any subcommand: the raw API response instead of the human-readable table/line. |

Docker: `docker exec <container> agent-viewer keys create ...` works against the in-container server when the
image ships the CLI; otherwise use the equivalent `curl` call (see `docs/api-keys.md`). Full reference, the
authentication resolution order, `submitter_id` attribution and the key management HTTP API:
[docs/api-keys.md](api-keys.md).

## Audit bundle (issues #400, #401, #402)

```bash
agent-viewer audit export --out bundle.avbundle.jsonl [--from-seq <n>] [--to-seq <n>] [--gzip]
agent-viewer audit verify bundle.avbundle.jsonl [--trusted-key <fingerprint|pem-file>]
                                                 [--expect-checkpoint <seq>:<headHash>] [--require-complete] [--json]
```

`export` downloads `GET /api/v1/audit/bundle` (requires the `audit` scope and `AGENT_VIEWER_STORAGE=sqlite` on
the server) to `--out`, writing to a temp file next to it and renaming only after a clean end, so a failed or
interrupted export never leaves a file at `--out`. `--url`/`--token` resolve the same way as `send`.

`verify` never talks to a server: it runs the standalone, zero-dependency `scripts/verify-audit-bundle.mjs` (the
packaged CLI ships a copy next to `cli.js`) as a child process and returns its exit code unchanged (`0` pass,
`1` fail, `2` invalid, `3` unpinned without `--trusted-key`). The same script also runs standalone, downloadable
from a GitHub release with no install at all (`curl -LO .../verify-audit-bundle.mjs{,.sha256}`). Full format
reference, the nine checks, the exit-code table and the key-pinning workflow: [docs/audit-bundle.md](audit-bundle.md).

## Verify the audit chain (issue #388)

```bash
agent-viewer verify [--url <url>] [--token <token>] [--scope full|recent] [--json]
                     [--public-key <file>] [--checkpoints <file>]
agent-viewer verify --db <file> [--public-key <file>] [--checkpoints <file>] [--scope full|recent] [--json]
```

Not to be confused with `agent-viewer audit verify <bundle-file>` above (issue #402), which checks an exported
bundle file and never talks to a server. This command verifies a **live chain** instead: by default it calls
`GET /api/v1/audit/verify` (issue #106) the same way the office itself would; `--db <file>` opens that SQLite
file read-only and runs the exact same verifier (`server/audit/verify.ts`) directly, no server involved.
`--db` cannot be combined with `--url`/`--token` (pick one mode); without `--db`, `--url`/`--token` resolve the
same way as `send` (flag, then `AGENT_VIEWER_URL`/`AGENT_VIEWER_API_TOKEN`, then the running `agent-viewer`'s
session file). Needs the `audit` scope (issue #108).

| Option | What it does |
|---|---|
| `--db <file>` | Verify this SQLite file directly instead of a running server. Keep the `-wal`/`-shm` siblings next to it, unrenamed: in WAL mode, recent commits can still be sitting there instead of in the main file, so a copy of only the `.db` file can be missing the newest rows. |
| `--scope full\|recent` | Passed through to `GET /api/v1/audit/verify`, or to the same verifier function in `--db` mode. `recent` still behaves like `full` today; this is issue #106's own documented limitation, not something this command changes. |
| `--public-key <file>` | Pin trust to this one PKCS#8/SPKI PEM public key instead of whichever key the chain's own `audit_keys` table currently reports as active. Every checkpoint is re-checked against only this key (online, by re-fetching and re-verifying the server's own checkpoint list; `--db`, by reading `audit_keys` only to resolve hashes, never to decide trust); a checkpoint signed by a key rotation this pinned copy does not know about reports `key_unknown`, by design. Sets `keyTrust` to `"pinned"` in the report regardless of the outcome. |
| `--checkpoints <file>` | Cross-check an exported checkpoints file (one JSON `SignedCheckpoint` per line, `GET /api/v1/audit/checkpoints?format=jsonl`'s own shape) against the chain just verified: each checkpoint's own signature and digest, the file's own prev-digest links, and its signed `headHash` against the chain's actual row at that `seq`, fetched one at a time through `GET /api/v1/audit/entries/:seq` (online) or read directly from `--db` — so the server (or the local file, in `--db` mode) never needs the exported file itself beyond that one hash per checkpoint. Fills `VerifyReport.exported`. A malformed line is a usage error (`2`), not an integrity failure: it means the file could not be read, not that anything was tampered with. |
| `--json` | A single `VerifyReport` JSON document on stdout; every line the human-readable form prints moves to stderr instead (so `--json | jq` never mixes in diagnostics). |

Exit codes (specific to `verify`; the general table at the bottom of this page does not apply here): `0` clean
(the chain, the checkpoints, and `--checkpoints`'s cross-check if given, all passed); `1` an integrity failure
(a chain break, a checkpoint failure, or a failure in the exported-checkpoints cross-check); `2` a usage error
(`--db` combined with `--url`/`--token`, an invalid `--scope`, or an unreadable `--public-key`/`--checkpoints`
file); `3` could not verify at all (the server is unreachable, answered `401`, is running in memory mode, or
`--db` points at a file that cannot be opened).

Example, a clean chain with a pinned signing key:

```text
storage: sqlite
instance: b7f0c6a2-4d1e-4a56-9a1c-0d6d2f3b8e11
coverage: seq 1..5321 (scope: full)
chain: 5320 checked, head seq 5321, 0 unchained
chain: ok, no break found
checkpoints: 6 checked, 6 valid, key trust: pinned
verdict: ok
```

The cross-check reads one row at a time from `GET /api/v1/audit/entries/:seq` (new in this issue): `{ "seq":
5321, "eventId": "evt_8f1c", "entryHash": "c0de...42", "prevHash": "b17e...90" }`, or `404 seq_not_found` for an
out-of-range or unchained `seq`, `409 audit_requires_chain` in memory mode. It needs the `audit` scope like
every other `/api/v1/audit/*` route, and never accepts a `token` query parameter (issue #71's rule applies here
too).

Full chain/checkpoint mechanics, the `VerifyReport` and checkpoint JSON shapes, manual `openssl`/`node:crypto`
verification without this CLI, and key-handling guidance: [docs/audit.md](audit.md). The underlying format and
the `GET /api/v1/audit/verify`/`chain` routes are documented in depth in
[docs/audit-chain.md](audit-chain.md).

## Claude Code

```bash
npx @warlockcode/agent-viewer install claude-code     # adds the hooks to this project, after asking
npx @warlockcode/agent-viewer install claude-code --telemetry     # hooks plus token and cost figures
npx @warlockcode/agent-viewer uninstall claude-code   # removes everything install added
```

| Option | What it does |
|---|---|
| `--telemetry` | Also points this project's Claude Code at the office's OpenTelemetry logs receiver, so token and cost per model call show up (opt-in; off by default). Needs a new Claude Code session to take effect. |
| `--no-telemetry` | Removes only the telemetry block; the hooks stay. |
| `--token <token>` | With `--telemetry`, a fixed token for an office on another machine or in Docker ("static mode"), instead of looking the running office's token up on every export ("helper mode", the default without `--token`). The token is masked in every diff the installer prints. |

`agent-viewer otel-headers --url <office-url>` is a small helper command Claude Code itself runs (through the `otelHeadersHelper` setting `--telemetry` writes in helper mode); it is not meant to be run by people. It never contacts the network: it prints the office's bearer token as JSON only when a running `agent-viewer` has that exact origin, `{}` otherwise, and always exits `0`.

See [Claude Code in the office](claude-code.md) for what each hook shows, what telemetry adds, and the privacy details.

## Docker

The same command, packaged:

```bash
docker run --rm -p 127.0.0.1:8787:8787 \
  -e AGENT_VIEWER_API_TOKEN="$(openssl rand -base64 32)" \
  -v agent-viewer-data:/app/data \
  ghcr.io/jmmana/agent-viewer
```

Open the office URL the container prints. The published port binds to this machine only; drop `127.0.0.1:` only to reach it from other machines, and put it behind TLS. The server listens on every interface inside the container (`AGENT_VIEWER_HOST=0.0.0.0`). The example sets a token and keeps the SQLite database in a named volume. The pricing table lands in the same volume (`/app/data/pricing.json`, `/app/data/pricing-history.jsonl`), so it survives container restarts and upgrades along with the database.

Flags after the image name are added to the image defaults, not swapped for them: `docker run --rm -p 127.0.0.1:8787:8787 ghcr.io/jmmana/agent-viewer --token my-token --demo` still listens on every interface inside the container and never tries to open a browser. Change the port with `-e PORT=9000 -p 127.0.0.1:9000:9000` (or `--port 9000`; the health check follows the port the server really uses). Other commands run as given, for example `docker run --rm ghcr.io/jmmana/agent-viewer --version`.

Images are published on every release tag:

| Tags | What runs | Token |
|---|---|---|
| `:<version>`, `:<major>.<minor>`, `:latest` | Office and API (this CLI) | `AGENT_VIEWER_API_TOKEN`, or a new token printed on every start. |
| `:<version>-api`, `:<major>.<minor>-api`, `:latest-api` | API only (`npm run server`, as in `docker/compose.yml`) | `AGENT_VIEWER_API_TOKEN`; otherwise a token generated on first start, saved in `/app/data/api-token` (kept across restarts with a volume on `/app/data`) and printed in the logs. The API image never runs open. Override the generated token's file path with `AGENT_VIEWER_TOKEN_FILE`. |

> **Maintainers:** GitHub Container Registry creates a new package as **private**, and the release workflow cannot change that. After the first image is published, make it public once, or the `docker run` above fails for everyone else: on GitHub, open the `agent-viewer` package, then **Package settings > Danger Zone > Change visibility > Public**. The release run summary shows the current visibility and a warning while it is not public.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. `claude-hook` always exits `0`. |
| `1` | The command failed (server unreachable, port in use, change not confirmed). |
| `2` | Invalid arguments. The usage is printed. |
