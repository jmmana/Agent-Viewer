# Claude Code OTLP logs fixtures

Recorded for issue #59 (`POST /v1/logs`, release 0.3.0 "true figures").

## Environment

- Claude Code version: `2.1.273` (`service.version` on every captured resource).
- Recording date: 2026-10-09.
- Host: macOS (`os.type: darwin`, `os.version: 25.5.0`, `host.arch: arm64`).
- Capture method: a throwaway Node HTTP server on `127.0.0.1` saved every `POST` body exactly as received.
  Claude Code was run in print mode (`claude -p "<prompt>"`) with:
  `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json`,
  `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:<port>/v1/logs`, `OTEL_LOGS_EXPORT_INTERVAL=1000`,
  `OTEL_METRICS_EXPORTER=none`.
- Every fixture was scrubbed before committing: `user.email`, `user.account_uuid`, `user.account_id`,
  `organization.id`, `user.id`, `session.id`, `prompt.id`, `request_id` and `client_request_id` were replaced
  with deterministic synthetic values (same real value always maps to the same synthetic value, so a
  `session.id` that repeats across two real requests still repeats, identically, across their fixtures). No
  hostnames or `vcs.*` attributes appeared in the real captures, so there was nothing to scrub there. Types,
  structure and numeric magnitudes (including `timeUnixNano`) are kept as sent.

## Which fixtures are live captures and which are not

| File | Source |
|---|---|
| `api-request.json` | Live capture. A real `claude_code.api_request` record for a `claude-sonnet-5` turn with non-zero cache tokens. |
| `api-error-http.json` | Live capture. A real `claude_code.api_error` from an invalid model name (`status_code: 404`). |
| `api-error-network.json` | Live capture. A real `claude_code.api_error` from a connection failure (`ANTHROPIC_BASE_URL` pointed at a closed port), paired with the real `claude_code.api_retries_exhausted` Claude Code emits right after it. |
| `mixed-batch.json` | Live capture. One real export batch mixing `claude_code.api_request`, `assistant_response`, `user_prompt`, `mcp_server_connection`, `hook_execution_start` and `hook_execution_complete`. |
| `api-request-subagent.json` | **Synthetic.** Built by hand from the confirmed real schema of `api-request.json`, changing `query_source` to `"subagent"` and adding `agent.name`. Not independently captured: triggering a real subagent run would have cost another paid turn, and the mapper does not read `query_source` or `agent.name` for 0.3.0 (per-subagent attribution is issue #64), so the exact string Claude Code uses for a subagent's `query_source` does not change this item's behavior. |
| `content-logging.json` | **Synthetic.** Built by hand in the confirmed real schema, with `OTEL_LOG_USER_PROMPTS`/`OTEL_LOG_ASSISTANT_RESPONSES`/`OTEL_LOG_TOOL_DETAILS`-style fields filled with sentinel strings (`SENTINEL_PROMPT_7f3a`, `SENTINEL_RESPONSE_2b9c`, `SENTINEL_TOOL_9d1e`). Not independently captured: the real captures above were taken with content logging **off**, and Claude Code redacts `prompt`/`response` to the literal string `"<REDACTED>"` by default (confirmed in the raw captures), which is a useful additional confirmation that the default is safe but means those two attributes carry no real text to scrub. Turning content logging on to capture real sentinel-bearing traffic was judged an unnecessary privacy risk (it would have recorded real conversation text) for a fixture whose only job is to prove the receiver never reads these fields; the synthetic version exercises the same code path. |
| `clear.json` | **Not produced.** `claude -p` runs one prompt and exits; it has no way to send a `/clear` mid-session, and faithfully reproducing the paired hook stdin (issue #48's identity module) would have required inventing data neither run actually produced. See "Open question 5" below: this is the one item the Context section asked fixtures to settle that is still open. The receiver does not special-case `/clear` (every record is processed by whatever `session.id` it carries, independent of how that session started), so this gap does not block the mapping logic itself, but the specific claim "the same hashed id survives a `/clear`" is unverified. Recommended follow-up: capture this in an interactive session before relying on it for cross-session dashboards. |

## Answers to the five open questions

1. **Is the OTLP `session.id` the same as the hook's `session_id`?** Not independently verified in this
   recording: the environment this was captured in has unrelated third-party hooks installed (visible as
   `hook_registered` / `plugin_loaded` events in `mixed-batch.json`), not the Agent Viewer Claude Code hook
   from issue #44, so there was no hook stdin to compare against from the same run. What is confirmed: Claude
   Code uses exactly one `session.id` value for every record of a run (`api-request.json` and
   `mixed-batch.json` come from the same real session and, after scrubbing, carry the same synthetic
   `session.id`). The docs describe `session.id` as *the* standard session attribute, and the hook and the
   telemetry are both emitted by the same running CLI process, so there is only one session concept to draw
   from. Recommended follow-up: once issue #44's hook is exercised together with telemetry in one real
   session, assert the two raw ids are byte-identical before trusting this across a dashboard that joins hook
   and telemetry data for the same agent (this item's own identity module test only proves the hash function
   is consistent given the same raw id, not that both channels send the same raw id).
2. **Where does the event name arrive?** Confirmed from real captures: `body.stringValue` always holds the
   fully qualified name (`"claude_code.api_request"`), and the `event.name` attribute always holds the short
   name without the prefix (`"api_request"`). No record in any capture had a top-level `eventName` field (the
   newer OTel logs data model field): this Claude Code version does not populate it. The parser accepts all
   three forms per the issue's design (`eventName`, then `event.name` with the prefix added, then
   `body.stringValue`), so it works whether or not a future Claude Code version starts sending `eventName`.
3. **How are numeric attributes encoded?** Confirmed mixed, by field and by event type, in the same batch:
   on `claude_code.api_request`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`,
   `cost_usd_micros`, `duration_ms`, `ttft_ms` and `event.sequence` arrive as `intValue` **JSON numbers**, and
   `cost_usd` arrives as `doubleValue`. On `claude_code.mcp_server_connection` and the `hook_execution_*`
   events, `duration_ms`, `num_hooks`, `total_duration_ms` and similar counters arrive as **decimal strings**
   under `stringValue`, not `intValue`. This confirms the issue's defensive design is necessary, not optional:
   a numeric field must accept both an `intValue` number and a numeric `stringValue`.
4. **Do standard attributes sit on the log record or the resource?** Confirmed: on the log record. Every
   capture's `resource.attributes` holds only `host.arch`, `os.type`, `os.version`, `service.name` and
   `service.version`. `session.id`, `user.id`, `user.email`, `user.account_uuid`, `user.account_id`,
   `organization.id` and `terminal.type` are attributes of every individual log record.
5. **What does `/clear` do to `session.id` on both sides?** Not answered by this recording; see `clear.json`
   above.

## Privacy note confirmed by the real captures

With content logging off (the default), Claude Code still emits `claude_code.user_prompt` and
`claude_code.assistant_response` records, but their `prompt` and `response` attributes already arrive as the
literal string `"<REDACTED>"`, not real text. The receiver drops these event types by name regardless (they
are not `api_request` or `api_error`), so this is a second, independent layer, not something this item relies
on.
