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

### Where the token travels

- **The printed office URL** carries the token in its fragment (`#token=...`). Browsers do not send the fragment to the server. As soon as the office reads it, it removes it from the address bar and from the history entry (`history.replaceState`), and keeps it in that tab's `sessionStorage` so a reload still connects. The URL stays visible in your terminal, where it was printed.
- **The browser the CLI opens** never gets the token: the command line of a process is visible to other local processes, so the CLI passes a single-use launch code instead (`#launch=...`). The office trades it for the token once (`POST /api/cli/launch`), and the code expires after two minutes. It is removed from the address bar the same way.
- **The live stream** sends the token in an `Authorization: Bearer` header over a streamed `fetch`, so it does not appear in URLs, the server's access logs or a proxy's logs. Only a browser whose `fetch` cannot stream (no `ReadableStream`) falls back to `EventSource`, which cannot send headers: the token then goes in the `?token=` query parameter of `/api/v1/events/stream`, where an access log in front of the server can record it.

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

Open the office URL the container prints. The published port binds to this machine only; drop `127.0.0.1:` only to reach it from other machines, and put it behind TLS. The server listens on every interface inside the container (`AGENT_VIEWER_HOST=0.0.0.0`). The example sets a token and keeps the SQLite database in a named volume.

Flags after the image name are added to the image defaults, not swapped for them: `docker run --rm -p 127.0.0.1:8787:8787 ghcr.io/jmmana/agent-viewer --token my-token --demo` still listens on every interface inside the container and never tries to open a browser. Change the port with `-e PORT=9000 -p 127.0.0.1:9000:9000` (or `--port 9000`; the health check follows the port the server really uses). Other commands run as given, for example `docker run --rm ghcr.io/jmmana/agent-viewer --version`.

Images are published on every release tag:

| Tags | What runs | Token |
|---|---|---|
| `:<version>`, `:<major>.<minor>`, `:latest` | Office and API (this CLI) | `AGENT_VIEWER_API_TOKEN`, or a new token printed on every start. |
| `:<version>-api`, `:<major>.<minor>-api`, `:latest-api` | API only (`npm run server`, as in `docker/compose.yml`) | `AGENT_VIEWER_API_TOKEN`; otherwise a token generated on first start, saved in `/app/data/api-token` (kept across restarts with a volume on `/app/data`) and printed in the logs. The API image never runs open. |

> **Maintainers:** GitHub Container Registry creates a new package as **private**, and the release workflow cannot change that. After the first image is published, make it public once, or the `docker run` above fails for everyone else: on GitHub, open the `agent-viewer` package, then **Package settings > Danger Zone > Change visibility > Public**. The release run summary shows the current visibility and a warning while it is not public.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. `claude-hook` always exits `0`. |
| `1` | The command failed (server unreachable, port in use, change not confirmed). |
| `2` | Invalid arguments. The usage is printed. |
