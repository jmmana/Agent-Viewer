# Claude Code in the office

Watch your own Claude Code sessions work: the main agent at its desk, each subagent as its own character, every tool call as it happens, and a clear sign when Claude is waiting for you.

It uses Claude Code's official [hooks](https://code.claude.com/docs/en/hooks). Claude Code runs `agent-viewer claude-hook` on each hook event; the hook turns the event into [canonical V1 events](integration.md) and sends them to the office on your machine.

## Set it up in 3 steps

**1. Start the office** (leave it running):

```bash
npx @warlockcode/agent-viewer
```

**2. Add the hooks to your project.** From the project folder:

```bash
npx @warlockcode/agent-viewer install claude-code
```

It shows the exact change to `.claude/settings.local.json` and asks before writing. Pass `--project <dir>` for another folder, or `--yes` to skip the question.

**3. Use Claude Code as usual** in that project: start a new session and watch the office. Type `/hooks` in Claude Code to see the installed hooks.

**4. Optional: tokens and cost.** The hooks above carry no token or cost figures. To see them, add `--telemetry`:

```bash
npx @warlockcode/agent-viewer install claude-code --telemetry
```

It shows the same kind of diff, pointing Claude Code's own OpenTelemetry logs at the office. Start a new Claude Code session afterwards: telemetry variables are read at startup. See [Tokens and cost](#tokens-and-cost) below for what it sends, what it means and its limits before turning it on.

> Until the package is on npm, use the release `.tgz` with `npx ./warlockcode-agent-viewer-<version>.tgz`. See [the CLI guide](cli.md).

## What you see

| Claude Code hook | In the office |
|---|---|
| `SessionStart` | The session's main agent ("Claude Code ab12") registers and sits in Architecture. |
| `UserPromptSubmit` | The main agent starts working (`THINKING`). |
| `PreToolUse` | Tool started: the agent shows the tool name (`Bash`, `Edit`, `mcp__github__create_issue`...). Starting a subagent (`Agent`) also marks the main agent as `DELEGATING`. |
| `PostToolUse` | Tool completed, with its duration, and the agent goes back to work. |
| `PostToolUseFailure` | Tool failed (only "failed" or "interrupted", never the error text). |
| `Notification` | `WAITING_APPROVAL` when Claude asks for permission, `WAITING` when it waits for your input. |
| `SubagentStart` | The subagent joins as its own character ("Explore 3f2a"), managed by the main agent, in a room that fits its type (Explore in the Research Library, reviewers in the QA Lab). The main agent hands off to it with a speech bubble. |
| `SubagentStop` | The subagent reports back with a bubble and is `DONE`; the main agent reviews the result. |
| `Stop` | The turn is finished: `DONE`. |
| `StopFailure` | `ERROR` with the API error kind (`rate_limit`, `overloaded`...). |
| `SessionEnd` | The main agent goes `OFFLINE`. |

Tool calls made inside a subagent are shown on the subagent, not on the main agent. Each session gets its own agents, so two Claude Code windows show up as two teams.

## Privacy

Only this leaves Claude Code through the hooks: the hook event, the tool name, the subagent type, the model name on session start, durations and the resulting status. All of it goes only to the Agent Viewer server you started, on your machine by default.

Never sent by the hooks: tool arguments and results (commands, file contents, search patterns), prompts, Claude's answers, file paths, the working directory, transcript paths, error output and notification texts. Session and subagent ids are replaced by short hashes. Tests with a fixture for every hook type check that none of it leaks.

**Opt-in summaries.** Install with `--include-summaries` to also send a trimmed, single-line copy (140 characters at most) of Claude's final message on `Stop` and `SubagentStop`, and of the notification text. They can contain anything Claude wrote, so turn them on only when that is fine for you. Tool arguments and prompts are never sent, with or without this option.

**With `--telemetry` on** (off by default), Claude Code itself sends more, straight to the office: token counts, the model name, cost, `request_id` and the *raw* `session.id`, `user.id` and `prompt.id` (not hashed, unlike the hooks above). It still goes only to the office endpoint you configured. The installer always pins `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` and `OTEL_LOG_RAW_API_BODIES` to `"0"`, so prompts, answers, tool details, tool content and raw API bodies are never exported, whatever your own Claude Code settings say; the office is also expected to drop the raw identity fields on receipt (see [#59](https://github.com/jmmana/Agent-Viewer/issues/59)).

## Tokens and cost

The hooks above carry no token or cost figures, and the hook never reads the transcript (a test checks that it does not even open it). `install claude-code --telemetry` points Claude Code's own [OpenTelemetry](https://code.claude.com/docs/en/monitoring-usage) logs at the office instead, which is where the real numbers live.

**Turning it on:**

```bash
npx @warlockcode/agent-viewer install claude-code --telemetry
```

Start a new Claude Code session afterwards; telemetry variables are only read at startup. Two modes:

- **Helper mode (default, no `--token`).** The installer writes an `otelHeadersHelper` command that looks the running office's token up on every export, so restarting the office with a new random token does not break it.
- **Static mode (`--telemetry --token <token>`).** A fixed token, written straight into the file, for an office on another machine or in Docker. Claude Code caches a helper's headers for a while (`CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS`, see the troubleshooting note below), so after an office restart with a new random token, static mode or a stable `AGENT_VIEWER_API_TOKEN` avoids a stretch of failed exports.

`--no-telemetry` removes only the telemetry block; the hooks stay. `uninstall claude-code` removes both.

**What arrives, per model call:** the model name, input, output, cache read and cache creation tokens, the call's duration, its `request_id` and `cost_usd`. Exports leave in batches every few seconds, so figures show up with a short delay, not instantly.

**The cost is Claude Code's own estimate**, computed on your machine from its own price table. The office records it as `costSource: "estimated"`: it can differ from your Anthropic invoice or Console, it is notional on a subscription plan, and Claude Code sends it as `0` whenever it cannot price a call. The office is expected to show that as unknown, never as a real zero (see [#46](https://github.com/jmmana/Agent-Viewer/issues/46) and [#59](https://github.com/jmmana/Agent-Viewer/issues/59)): a reported `0` next to non-zero tokens means "not priced", not "free".

**Subagent calls are attributed to the main agent.** As of Claude Code 2.1.273, the `api_request` telemetry event carries no subagent id (subagent ids exist only on trace spans, which this does not use), so a session's total includes everything its subagents used, and there is no separate per-subagent figure. Real subagent attribution from traces is tracked as [#64](https://github.com/jmmana/Agent-Viewer/issues/64) and [#97](https://github.com/jmmana/Agent-Viewer/issues/97).

**Figures cover only what the office actually received:** calls made before you ran `install --telemetry`, while the office was not running, or in a Claude Code session started before the install, are not recorded. Treat the totals as what the office saw, not necessarily everything the session used.

Until the totals work of 0.3.0 lands fully ([#55](https://github.com/jmmana/Agent-Viewer/issues/55), [#59](https://github.com/jmmana/Agent-Viewer/issues/59)), a session that only uses the hooks (no `--telemetry`) still shows `0.0K` and `$0.000` in the top bar. Read it as "not reported", not as "nothing consumed".

## It never slows Claude Code down

The hook writes nothing to stdout and always exits with code `0`. It gives itself 400 ms from process start: if the office is not running or does not answer, it stops quietly within that time. When the office is up, a hook takes well under 100 ms on a typical laptop. Each handler also sets Claude Code's own `timeout` to 1 second (Claude Code reads it in seconds) only as a safety net. It stays below the short budget Claude Code gives `SessionEnd` hooks when it exits, so installing Agent Viewer never makes Claude Code slower to quit.

## What install writes

Only `<project>/.claude/settings.local.json`, the per-project file Claude Code keeps out of git. Your user settings in `~/.claude` and the shared `.claude/settings.json` are never touched. Each event gets one handler that runs the Node binary and the CLI you installed with, in exec form:

```json
{
  "type": "command",
  "command": "/usr/local/bin/node",
  "args": ["/path/to/@warlockcode/agent-viewer/dist-cli/cli.js", "claude-hook"],
  "timeout": 1
}
```

Installing again replaces the handlers instead of adding a second copy; when they are already up to date it says so and writes nothing. The change is written only if the file did not change while you were reading the prompt (otherwise nothing is written and you run the command again), and it goes through a temporary file and a rename, so the file is never left half written. Options: `--include-summaries`, and `--url` / `--token` to point the hook at a fixed server. Without them the hook finds the running `agent-viewer` on its own.

**If you pass `--token`, it is stored in plain text in `<project>/.claude/settings.local.json`.** Claude Code keeps that file out of git by default, but check your own ignore rules (`git check-ignore .claude/settings.local.json`) and never commit or share that file.

The handler uses the path of the CLI you ran. If you clean the npx cache, run `install claude-code` again; or install the package globally (`npm install -g @warlockcode/agent-viewer`) for a stable path.

**With `--telemetry`**, install also writes an `env` block (`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_LOGS_EXPORTER`, the logs protocol and endpoint, and the five `OTEL_LOG_*` flags pinned to `"0"`) and, in helper mode, an `otelHeadersHelper` command; in static mode (`--token`), an `OTEL_EXPORTER_OTLP_LOGS_HEADERS` entry instead. The endpoint is resolved once, at install time (`--url`, then `AGENT_VIEWER_URL`, then the running office's own URL, then the local default); if the office later starts on another port, run `install claude-code --telemetry` again, or fix the port with `--port` when you start the office. Nothing is written to `~/.claude` or to the shared `.claude/settings.json` by `--telemetry` either, and the diff always masks a `--token` value as `<token hidden>` before it is shown, even though the file itself holds it in full. After writing (or when telemetry was already on), install tries one empty export against the endpoint and reports whether an office answered.

**Before writing**, `--telemetry` refuses outright, naming the file and the setting, rather than silently overwriting it, when: a managed key already holds a different value install did not write; prompt or content logging is already on in `settings.local.json`; an `otelHeadersHelper` not from a previous Agent Viewer install is already configured (helper mode); or another OTLP metrics/traces exporter is already configured (helper mode, since its headers are not scoped to one signal). It only warns, and still asks before writing, when: your own `~/.claude/settings.json` or the project's shared `.claude/settings.json` already points logs somewhere else (the project's pin wins, Claude Code's own settings precedence applies); a content flag is on outside `settings.local.json`; or (`--token` only) the endpoint is plain `http://` to a non-loopback host, so the token would travel in clear text.

## Uninstall

```bash
npx @warlockcode/agent-viewer uninstall claude-code
```

It shows the change, asks, and removes exactly what install added: its handlers, the telemetry block when `--telemetry` installed one, plus the event lists, the `hooks` key, the file and the `.claude/` folder when install created them. Install edits the file as text and keeps every other byte (your spacing, line endings and key order), so after uninstall the file is byte for byte what it was, including containers that were already empty before (a file holding just `{}`, `"hooks": {}`, an empty event list, an empty `env` object or an empty `.claude/` folder). `install claude-code --no-telemetry` does the same for the telemetry block alone, keeping the hooks.

To tell those apart, install keeps a small note of what was already there in `~/.agent-viewer/claude-code-installs.json` (or `$AGENT_VIEWER_HOME`), the telemetry block included; the real value of a `--token` is never written to that note, only the key it belongs to. Without that note (another machine, or the folder was deleted), uninstall removes the handlers and the event lists and `hooks` key they leave empty, and recognizes only the telemetry values that cannot have come from anywhere but Agent Viewer (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, the fixed protocol, and the `OTEL_LOG_*` pins), but keeps the file (as `{}` at worst), the `.claude/` folder, and the endpoint, the header and the helper, since those are install-specific and cannot be told apart from something you configured yourself.

## Troubleshooting

- **Nothing shows up:** check that `agent-viewer` is running and that you started a new Claude Code session after installing; `/hooks` in Claude Code lists the hooks it loaded. Set `AGENT_VIEWER_DEBUG=1` in the environment Claude Code starts from to print hook errors to its debug log (`claude --debug`).
- **A hook error notice about a missing file:** the CLI path in `settings.local.json` no longer exists (npx cache cleaned). Run `install claude-code` again.
- **Office on another port or machine:** install with `--url http://host:port --token <token>`.
- **Telemetry exports start failing with 401 after an office restart:** helper mode looks the token up again, but Claude Code caches a helper's headers for a while (`CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS`; the exact default for your Claude Code version is not yet recorded here, see the note below). A new Claude Code session, or a fixed `AGENT_VIEWER_API_TOKEN` / `--telemetry --token`, clears it.
- **The office moved to another port:** run `install claude-code --telemetry` again to re-resolve the endpoint, or start the office with a fixed `--port` so it never needs to.
- **Managed settings override the project's OpenTelemetry variables:** Claude Code's settings precedence can let `managed-settings.json` or another higher tier win over `settings.local.json`; `--telemetry` can only warn about `~/.claude/settings.json` and the shared `.claude/settings.json`, not about settings it cannot read.
- **The receiver probe after install:** `Telemetry receiver OK` means an office answered; `...401, check the token` a wrong or stale token; `...no OTLP receiver... (office older than 0.3.0?)` an office without the logs endpoint of [#59](https://github.com/jmmana/Agent-Viewer/issues/59); `...office not running...` nothing answered at all. It never stops the install: the exit code is unaffected either way.

> **Known gap in this PR:** the measured default of `CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS` against a real Claude Code 2.1.x session, and the manual check that an installed project's real session reaches the office through [#59](https://github.com/jmmana/Agent-Viewer/issues/59), need a Claude Code binary and a merged #59 to run; both are recorded as follow-ups in the PR rather than guessed at here.
