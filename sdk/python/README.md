# Agent Viewer Python SDK

Python client for [Agent Viewer](https://github.com/jmmana/Agent-Viewer), the open-source visual observability layer that shows your AI agents working in an animated virtual office.

The SDK is a single module, `agent_viewer`, built on the Python standard library. It has no third-party dependencies and supports Python 3.9 or later.

## Install

From a clone of the repository:

```bash
pip install ./sdk/python
```

You can also build a wheel and install it elsewhere:

```bash
python -m pip wheel ./sdk/python -w dist/
pip install dist/agent_viewer-0.2.0-py3-none-any.whl
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
analyst.usage("OpenAI", "gpt-4o", input_tokens=4200, output_tokens=320, cost=0.024)
analyst.message("Overview ready for review.", target_agent_name="Nova")
analyst.done("Summary delivered")
```

The agent registers itself on its first call. Requests retry with exponential backoff on network errors, `429` and `5xx` responses; other `4xx` responses raise `AgentViewerError` right away. Calling `usage()` without a `cost` reports the cost as unknown instead of zero.

## API overview

`AgentViewer(url=..., token=..., runtime_id=..., session_id=..., source=..., timeout=10.0, max_retries=3, auto_register=True)`

- `viewer.agent(id, name=None, role_title=None, provider=None, model=None, workspace=None)` returns an `AgentHandle`.
- `viewer.emit(event_type, summary, payload, ...)` and `viewer.emit_batch(events)` send canonical events directly.
- `viewer.heartbeat()`, `viewer.health()` and `viewer.snapshot()` talk to the runtime endpoints.

`AgentHandle` methods:

- Status: `idle()`, `thinking()`, `researching()`, `coding()`, `testing()`, `waiting()`, `blocked()`, `done()`, or `status(status, status_text=None)`.
- Messages: `message(text, target_agent_name=None)`.
- Tools: `tool_started(tool, input_summary=None)`, `tool_completed(tool, output_summary=None)`, `tool_failed(tool, error_summary=None)`.
- Usage: `usage(provider, model, input_tokens, output_tokens, cached_tokens=0, reasoning_tokens=0, cost=None, ...)`.

## Privacy

Send only observable states, messages, tool metadata and reported usage. Never send API keys, private system prompts or model reasoning through the event stream.

## Documentation

- [Integration guide](https://github.com/jmmana/Agent-Viewer/blob/main/docs/integration.md)
- [Changelog](https://github.com/jmmana/Agent-Viewer/blob/main/CHANGELOG.md)

## License

MIT
