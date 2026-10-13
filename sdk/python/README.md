# Agent Viewer Python SDK

Python client for [Agent Viewer](https://github.com/jmmana/Agent-Viewer), the open-source visual observability layer that shows your AI agents working in an animated virtual office.

The SDK is a single module, `agent_viewer`, built on the Python standard library. It has no third-party dependencies and supports Python 3.9 or later.

## Install

```bash
pip install agent-viewer
```

From a clone of the repository instead:

```bash
pip install ./sdk/python
```

You can also build a wheel and install it elsewhere:

```bash
python -m pip wheel ./sdk/python -w dist/
pip install dist/agent_viewer-0.8.0-py3-none-any.whl
```

## Quick start

Start the Agent Viewer ingestion server (`npm run server`, listening on `http://localhost:8787` by default), then:

```python
import os

from agent_viewer import AgentViewer

viewer = AgentViewer(
    url="http://localhost:8787",
    token=os.getenv("AGENT_VIEWER_API_TOKEN"),
    runtime_id="my-crew",
)
analyst = viewer.agent("analyst", name="Iris", role_title="Market analyst", workspace="research_area")

analyst.researching("Reading the quarterly filings")
analyst.tool_started("filing_fetcher", input_summary="Form 10-K")
analyst.tool_completed("filing_fetcher", output_summary="42 pages retrieved")
analyst.usage("OpenAI", "gpt-4o", input_tokens=4200, output_tokens=320, cost=0.024, cost_source="provider-reported", currency="USD")
analyst.message("Overview ready for review.", target_agent_name="Nova")
analyst.done("Summary delivered")
```

The agent registers itself on its first call. Requests retry with exponential backoff on network errors, `429` and `5xx` responses; other `4xx` responses raise `AgentViewerError` right away.

## Event ids and conflicts

An event sent without `event_id` (or a batch item without `id`) gets `evt_<32 hex characters>`, the full 128 bits of `uuid.uuid4()`. The id is the idempotency key, so one id must name exactly one event. The server answers a true retry (same id, same content) as a duplicate, and rejects the same id with different content with HTTP 409. `AgentViewerError` has `status_code` and `code`, the `error` field of the response body:

```python
from agent_viewer import AgentViewerError

try:
    viewer.emit("tool.started", "Searching", {"tool": "search"}, agent_id="analyst", event_id="evt_call_42")
except AgentViewerError as err:
    if err.code == "conflicting_duplicate":
        # Another event already uses this id. It was not applied, and the SDK does not retry a 409.
        ...
```

`emit_batch()` returns the server response: it answers 202 even when some items were not applied, so read `conflicts` and each item's `status` (`"accepted"`, `"duplicate"` or `"conflict"`) in `results`. To retry, resend the identical event, with the same `timestamp`.

`usage()` sends only the figures you give it. A token count you leave out (or pass as `None`) is left out of the event, never sent as `0`; an explicit `0` is kept. Calling `usage()` without a `cost` reports the cost as unknown instead of zero. The SDK never decides where a cost comes from: pass `cost_source="provider-reported"` when the provider returned the cost, or `"estimated"` when you computed it. A cost passed without `cost_source` is sent as `costSource="unknown"`, and the client logs one warning on the `agent_viewer` logger (once per `AgentViewer` instance). Any other `cost_source` value raises `ValueError` before anything is sent. `currency` is forwarded as given, with no default, and `task_id` links the call to a task through the event's `taskId`.

## API overview

`AgentViewer(url=..., token=..., runtime_id=..., session_id=..., source=..., timeout=10.0, max_retries=3, auto_register=True, spool_dir=None, spool_max_events=10_000, spool_max_bytes=50*1024*1024, spool_overflow="drop_oldest", spool_batch_size=50, spool_background=True, spool_probe_interval=2.0, spool_max_probe_interval=60.0)`. The `spool_*` arguments configure the optional durable queue, see [below](#durable-queue); `spool_dir=None` (the default) disables it and keeps every other behavior unchanged.

- `viewer.agent(id, name=None, role_title=None, provider=None, model=None, workspace=None)` returns an `AgentHandle`.
- `viewer.emit(event_type, summary, payload, ...)` and `viewer.emit_batch(events)` send canonical events directly.
- `viewer.heartbeat()`, `viewer.health()` and `viewer.snapshot()` talk to the runtime endpoints.
- `viewer.usage_summary()` returns the server's usage aggregates (`GET /api/v1/usage`) as a dict: totals by agent and by `(provider, model)`, with failed calls under `failed`. A token `sum` may be `None` (no call reported that kind, never zero), and costs are listed per currency and cost source in `byCurrency`, never summed together. In `viewer.snapshot()`, `totalCost` is `None` unless every call reported one single currency.

`AgentHandle` methods:

- Status: `idle()`, `thinking()`, `researching()`, `coding()`, `testing()`, `waiting()`, `blocked()`, `done()`, or `status(status, status_text=None)`.
- Messages: `message(text, target_agent_name=None)`.
- Tools: `tool_started(tool, input_summary=None, *, tool_call_id=None)`, `tool_completed(tool, output_summary=None, *, tool_call_id=None)`, `tool_failed(tool, error_summary=None, *, tool_call_id=None)`.
- Usage: `usage(provider, model, input_tokens, output_tokens, cached_tokens=None, reasoning_tokens=None, cost=None, cost_source=None, latency_ms=None, request_id=None, *, cache_read_tokens=None, cache_write_tokens=None, currency=None, task_id=None, trace_id=None, parent_id=None, tool_call_id=None, meeting_id=None, user_id=None, tags=None)`. `cached_tokens` is deprecated: pass `cache_read_tokens` and `cache_write_tokens` instead.
- `llm_failed(provider, model=None, error_kind=None, *, http_status=None, retryable=None, request_id=None, provider_error_code=None, attempts=None, latency_ms=None, input_tokens=None, output_tokens=None, cache_read_tokens=None, cache_write_tokens=None, reasoning_tokens=None, cost=None, cost_source=None, currency=None, task_id=None, trace_id=None, parent_id=None, tool_call_id=None, meeting_id=None, user_id=None, tags=None)` reports one failed model call attempt. There is no free-text error field on purpose.
- `viewer.llm_usage(agent_id, provider, model, input_tokens, output_tokens, ...)` is the legacy helper. It takes the same arguments (including the correlation keywords below) and follows the same rules.

### `latency_ms` is measured, never invented (issue #89)

`latency_ms` (on `usage()` and `llm_failed()`) must be the real wall-clock latency of that call, as your own code measured it. Pass nothing (leave it `None`) when you did not measure it: the SDK never defaults it to `0`, and the server's latency percentiles (`GET /api/v1/usage/rollup?include=latency`) would otherwise read an unmeasured call as an impossibly fast one.

### Correlation fields (issue #64)

`trace_id`, `parent_id`, `tool_call_id`, `meeting_id`, `user_id` and `tags` (on `usage()`, `llm_failed()` and `llm_usage()`) link a call to a trace, a tool call, a meeting or a user. Each is `None` by default, which means "not reported"; an id must be 1 to 128 characters with no control characters and no leading or trailing whitespace, and `tags` holds at most 20 items of 1 to 64 characters each. A value that breaks a rule raises `ValueError` naming the argument before anything is sent; a non-string id, or `tags` given as a `str` or `bytes` (which would otherwise be split into one tag per character), raises `TypeError`. `tool_call_id` on `tool_started`/`tool_completed`/`tool_failed` is sent as `payload.toolCallId`. These fields need a 0.4.0 or later Agent Viewer server to be kept: an older server accepts the event and silently drops them. Full rules: [docs/integration.md](../../docs/integration.md#correlation-and-attribution-fields-issue-64).

### Verifying an outbound webhook (issue #86, sub-issue #323)

If you receive Agent Viewer's outbound `budget.alert` webhook (issue #86's sub-issue #321), `verify_webhook_signature` checks it with the same HMAC-SHA256 scheme the server itself uses to verify an inbound webhook: a hex digest of `f"{timestamp}.{raw_body}"`. It returns a plain `bool`, never raises, and also rejects a timestamp more than `tolerance_ms` (default 300000, 5 minutes) away from now in either direction, so a replayed or clock-skewed delivery is refused too. It never builds or sends a `budget.alert` event itself: that type is reserved to the server. Full reference for both webhook directions: [docs/webhooks.md](../../docs/webhooks.md).

```python
from agent_viewer import verify_webhook_signature

# Inside your webhook endpoint, with the exact raw request body bytes (never re-serialized):
signature = request.headers["X-Agent-Viewer-Signature"]
timestamp = request.headers["X-Agent-Viewer-Timestamp"]
raw_body = request.get_data()  # bytes, exactly as received

if not verify_webhook_signature(WEBHOOK_SECRET, timestamp, raw_body, signature):
    return "invalid signature", 401

event = json.loads(raw_body)
# ... handle event, e.g. event["type"] == "budget.alert"
```

`raw_body` must be the exact bytes (or string) the sender signed; re-encoding a parsed JSON body can reorder keys or change whitespace and would make a genuine signature fail to verify.

## Durable queue

By default (`spool_dir=None`), a transient failure after the normal retries raises `AgentViewerError` into your code, exactly as in 0.2.x (the only change is that a connection reset, a closed-early response and HTTP `408` are now correctly retried instead of escaping as a raw exception or failing with no retry at all, issue #101). Pass `spool_dir` (or set `AGENT_VIEWER_SPOOL_DIR`) to add an optional, bounded, on-disk spool backed by `sqlite3` from the standard library, no third-party dependency:

```python
viewer = AgentViewer(
    url="http://localhost:8787",
    token=os.getenv("AGENT_VIEWER_API_TOKEN"),
    runtime_id="my-crew",
    spool_dir="/var/lib/my-crew/agent-viewer-spool",
)
```

With the spool enabled, a transient failure (the server down, `408`, `429`, any `5xx`) never raises: `emit()`/`emit_batch()` return `{"accepted": False, "queued": True, ...}` instead, the event is written to disk with its original `id` and `timestamp`, and a background thread replays it once the server returns, in the original order, through `POST /api/v1/events/batch`. The server's own idempotency by `id` means a replay is delivered at least once and counted exactly once. A conclusive rejection (any other `4xx`) still raises immediately and is never queued, since replaying it could never succeed.

```python
viewer.flush(timeout=30.0)   # FlushResult(delivered, remaining, rejected, timed_out, state); drains now, never raises
stats = viewer.spool_stats() # SpoolStats: pending_events, pending_bytes, every drop/replay counter, state, ...
dead_letters = viewer.spool_rejected(limit=100)  # events the server rejected outright during replay, newest first
viewer.close(timeout=5.0)    # final bounded flush attempt; also usable as `with AgentViewer(...) as viewer:`
```

A short-lived script gets one last delivery attempt at interpreter exit (`atexit`); anything still queued stays on disk for the next run to pick up. Every counter in `SpoolStats` is an event count, never a token or money figure: the spool never sums, prices or defaults usage, and it stores each event's JSON exactly as the SDK built it (a missing `cost` stays absent, never `0`). When the backlog hits `spool_max_events`/`spool_max_bytes`, `spool_overflow="drop_oldest"` (the default) evicts the oldest non-`llm.usage` row first and only touches usage rows once nothing else is left; `"drop_newest"` refuses the incoming event instead. Every drop and every server-side rejection is counted, never silent; a poison event (the server answers `400` for just that one item during a batch replay) is isolated into a 100-row dead letter (`spool_rejected()`) instead of blocking the events behind it.

**The spool holds your event data in clear text on disk**: the same summaries, messages and tags the SDK would otherwise have sent over the network, nothing more, and never the API token (headers are rebuilt from the live client at send time). Treat the spool directory (`0700`, files `0600`) like any other local credential-adjacent data: on `/var/lib/...` on a server, with its own file permissions, not in a repo. One caveat: an in-memory server (`AGENT_VIEWER_STORAGE=memory`, the default; set it to `sqlite` to persist to `AGENT_VIEWER_SQLITE_PATH` instead) forgets ids past 10000 events, so replaying a very long outage against a memory-mode server could in principle double-count a very old id; SQLite-mode servers have no such limit.

Full cross-language contract (shared with the TypeScript SDK): [docs/sdk-queue.md](../../docs/sdk-queue.md).

## LangGraph callback handler (issue #345)

```bash
pip install "agent-viewer[langgraph]"
```

```python
from agent_viewer_langgraph import AgentViewerCallbackHandler

handler = AgentViewerCallbackHandler(url="http://localhost:8787", runtime_id="research-graph")
graph.invoke(inputs, config={"callbacks": [handler]})
print(handler.stats())  # enqueued, sent, dropped, failed, callback_errors
```

Each graph node becomes an agent (`agentId` is the node name, `sessionId` is the `thread_id`). Node start, end and error map to `agent.status.changed`; tool callbacks to `tool.started`/`tool.completed`/`tool.failed`; model calls to `llm.usage`/`llm.failed`. Event ids are deterministic, `lg:<runtimeId>:<runId>:<eventKind>`, so a replayed callback is an idempotent duplicate.

Only names, token counts and timings are sent: prompts, completions, tool inputs and outputs and error messages never are. Callback metadata is limited to `langgraph_node`, `thread_id`, `ls_provider`, `ls_model_name` and `ls_model_type`.

The handler never raises into the graph (`raise_error=False`). Events go through a bounded queue to a daemon thread; a full queue drops the event and counts it. Pass `on_error=lambda err, event: ...` to observe failures. Pending events are flushed at exit, or call `handler.flush(timeout)` / `handler.close()` yourself.

## Privacy

Send only observable states, messages, tool metadata and reported usage. Never send API keys, private system prompts or model reasoning through the event stream.

## Documentation

- [Integration guide](https://github.com/jmmana/Agent-Viewer/blob/main/docs/integration.md)
- [Changelog](https://github.com/jmmana/Agent-Viewer/blob/main/CHANGELOG.md)

## License

MIT
