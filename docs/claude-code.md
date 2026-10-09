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

Only this leaves Claude Code: the hook event, the tool name, the subagent type, the model name on session start, durations and the resulting status. All of it goes only to the Agent Viewer server you started, on your machine by default.

Never sent: tool arguments and results (commands, file contents, search patterns), prompts, Claude's answers, file paths, the working directory, transcript paths, error output and notification texts. Session and subagent ids are replaced by short hashes. Tests with a fixture for every hook type check that none of it leaks.

**Opt-in summaries.** Install with `--include-summaries` to also send a trimmed, single-line copy (140 characters at most) of Claude's final message on `Stop` and `SubagentStop`, and of the notification text. They can contain anything Claude wrote, so turn them on only when that is fine for you. Tool arguments and prompts are never sent, with or without this option.

## Tokens and cost

The hooks carry no token or cost figures, and the hook never reads the transcript (a test checks that it does not even open it). Claude Code token figures will arrive through its native OpenTelemetry logs ([#59](https://github.com/jmmana/Agent-Viewer/issues/59) and [#60](https://github.com/jmmana/Agent-Viewer/issues/60)).

Until the totals work of 0.3.0 lands ([#55](https://github.com/jmmana/Agent-Viewer/issues/55)), the top bar of the office served by the CLI shows `0.0K` and `$0.000` for a session that only uses hooks. Read it as "not reported", not as "nothing consumed".

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

## Uninstall

```bash
npx @warlockcode/agent-viewer uninstall claude-code
```

It shows the change, asks, and removes exactly what install added: its handlers, plus the event lists, the `hooks` key, the file and the `.claude/` folder when install created them. Install edits the file as text and keeps every other byte (your spacing, line endings and key order), so after uninstall the file is byte for byte what it was, including containers that were already empty before (a file holding just `{}`, `"hooks": {}`, an empty event list or an empty `.claude/` folder).

To tell those apart, install keeps a small note of what was already there in `~/.agent-viewer/claude-code-installs.json` (or `$AGENT_VIEWER_HOME`). Without that note (another machine, or the folder was deleted), uninstall removes the handlers and the event lists and `hooks` key they leave empty, but keeps the file (as `{}` at worst) and the `.claude/` folder.

## Troubleshooting

- **Nothing shows up:** check that `agent-viewer` is running and that you started a new Claude Code session after installing; `/hooks` in Claude Code lists the hooks it loaded. Set `AGENT_VIEWER_DEBUG=1` in the environment Claude Code starts from to print hook errors to its debug log (`claude --debug`).
- **A hook error notice about a missing file:** the CLI path in `settings.local.json` no longer exists (npx cache cleaned). Run `install claude-code` again.
- **Office on another port or machine:** install with `--url http://host:port --token <token>`.
