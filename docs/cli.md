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

Requires Node.js 24 or later, the version it is tested on. Stop it with `Ctrl+C`.

## Options

| Option | Default | What it does |
|---|---|---|
| `--port <n>` | `8787` | Port for the office and the API. `0` picks a free port. |
| `--host <address>` | `127.0.0.1` | Interface to listen on. The default accepts only this machine. `0.0.0.0` exposes it to your network (the token still protects `/api/v1`). |
| `--token <token>` | `AGENT_VIEWER_API_TOKEN`, or a new random token | Token for `/api/v1`. Clients send `Authorization: Bearer <token>`. |
| `--demo` | off | Opens the office with the simulated demo team. Your events still arrive on top of it. |
| `--no-open` | opens | Do not open the browser. |
| `--record <file>` | off | Appends every accepted event to a [canonical JSONL V1](event-log.md) file, ready to replay or export to video. |

The office URL carries the token in its fragment (`#token=...`). Browsers never send the fragment to a server, so it does not end up in logs.

The server keeps events in memory. Set `AGENT_VIEWER_STORAGE=sqlite` (and optionally `AGENT_VIEWER_SQLITE_PATH`) to persist them. The other server variables in the [README](../README.md#-configuration) apply too. A `.env` file in the current folder is not read: the CLI is configured by its flags and the environment.

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
npx @warlockcode/agent-viewer uninstall claude-code   # removes them
```

See [Claude Code in the office](claude-code.md).

## Docker

The same command, packaged:

```bash
docker run --rm -p 8787:8787 ghcr.io/jmmana/agent-viewer
```

Open the office URL the container prints. Inside the container the server listens on every interface so the published port works; `-p 127.0.0.1:8787:8787` keeps it on your machine. Set `-e AGENT_VIEWER_API_TOKEN=...` to choose the token, and mount `/app/data` to keep the SQLite database. Images are published on every release tag: `:<version>` and `:latest` (office and API), `:<version>-api` and `:latest-api` (API only, as in `docker/compose.yml`).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. `claude-hook` always exits `0`. |
| `1` | The command failed (server unreachable, port in use, change not confirmed). |
| `2` | Invalid arguments. The usage is printed. |
