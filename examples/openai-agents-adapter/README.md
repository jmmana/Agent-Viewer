# OpenAI Agents SDK tracing processor (issue #100)

Plugs Agent Viewer into `@openai/agents`'s own tracing pipeline. Instead of calling a callback at every step
(the old `examples/openai-agents-adapter.ts`, removed), register `AgentViewerTracingProcessor` once and every
agent run, handoff, tool call and model generation is captured automatically.

```ts
import { Agent, run } from '@openai/agents';
import { instrumentOpenAIAgents } from './processor';

const { shutdown } = instrumentOpenAIAgents({
  url: process.env.AGENT_VIEWER_URL,
  apiKey: process.env.AGENT_VIEWER_API_TOKEN,
  runtimeId: 'openai-agents',
});

const assistant = new Agent({ name: 'Assistant', instructions: '...' });
await run(assistant, 'hello');
await shutdown(); // flush before a short script exits
```

Or register it alongside other processors yourself:

```ts
import { addTraceProcessor } from '@openai/agents';
import { AgentViewerTracingProcessor } from './processor';

addTraceProcessor(new AgentViewerTracingProcessor({ runtimeId: 'openai-agents' }));
```

Pass `exclusive: true` to `instrumentOpenAIAgents()` to replace every processor (including OpenAI's own
default exporter) via `setTraceProcessors()`. Without it, OpenAI's own exporter keeps running alongside this
one: if your run has an OpenAI API key and tracing is not otherwise disabled, OpenAI still receives full
traces (prompts, tool IO) at its own trace backend. That is the existing behavior of your own setup, not
something this adapter adds, but it means `exclusive: false` (the default) does not, by itself, stop that
other export path.

## Not a published package yet

This lives in `examples/` rather than `packages/openai-agents/`. Publishing as
`@warlockcode/agent-viewer-openai-agents` needs the shared `packages/sdk/` npm workspace extraction that issue
#343 is building in parallel (the same workspace `#99`'s LangGraph adapter will also use). A follow-up
sub-issue moves this module into that workspace, wires `publint`/`attw` and the release workflow, and adds a
peer dependency on `@openai/agents`. Until then, it is tested in CI against a real, pinned `@openai/agents`
devDependency, and imports the SDK by relative path (`../../sdk/typescript/index`), exactly like every other
example in this repository.

## Step 0 findings

The issue's original mapping table was written from memory of the SDK and flagged as unverified. These are the
differences found by reading the installed `@openai/agents@0.20.0` (`@openai/agents-core`,
`@openai/agents-openai`) type declarations and span-creation source directly:

- **Usage requires full tracing data.** Neither `model` nor `usage` is a stable, always-present field on a
  `response` span (Responses API): both live inside `spanData._response`, the raw OpenAI `Response` object,
  which `@openai/agents-openai` only attaches when the run's `traceIncludeSensitiveData` is `true` (the SDK
  default). The same flag also gates the full `input`/`output`. For `generation` spans (Chat Completions),
  `spanData.model` is always present, but `spanData.usage` is only populated on a couple of failure/truncation
  paths; the normal success path's usage instead lives in `spanData.output[0].usage` (the raw Chat Completions
  response), again gated by `traceIncludeSensitiveData`. **Practical consequence: if a host sets
  `traceIncludeSensitiveData: false` for privacy, this adapter (and OpenAI's own trace exporter) loses model
  usage entirely** for the built-in OpenAI model providers. This adapter reads only `.model`, `.usage` and
  `.id` off that larger object and never touches `.output`/`.instructions`, but it cannot separate "give me
  usage" from "give me everything" upstream of the SDK itself; this is documented here rather than silently
  producing no usage events.
- **Tokens are snake_case**, not camelCase as the issue speculated: `input_tokens`/`output_tokens`,
  `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens` (Responses API), or
  `prompt_tokens`/`completion_tokens` with `..._details.cached_tokens`/`reasoning_tokens` (Chat Completions,
  the shape `toResponseUsage()` normalizes into). The extractor in `processor.ts` tries both families.
- **No generic span around every model call.** `generation`/`response` spans are created inside the concrete
  model class (`OpenAIResponsesModel`/`OpenAIChatCompletionsModel`), not by the generic `Runner`. A custom
  `Model` implementation (a stub for testing, or a non-OpenAI provider wired through `@openai/agents`'s
  `ModelProvider` interface) produces no `generation`/`response` span at all unless it creates one itself. This
  is why the test suite exercises the mapping with directly-constructed spans (`createGenerationSpan` /
  `createResponseSpan` with hand-set `spanData`) rather than a fully offline run through a fake `Model`: a fake
  `Model` would prove nothing about the usage mapping, since no span resembling a real one would ever be
  created.
- **`llm.failed` has no free-text message field in the current contract** (`LlmFailedPayloadSchema`): the
  issue's mapping table mentions a "truncated message (200 chars)", but the schema's own doc comment is
  explicit that this is deliberate ("provider messages can echo prompts or credentials"). This adapter reports
  `provider`, `model` (when known), `errorKind` (currently always `'unknown'`: OpenAI span errors do not expose
  a structured status code) and `latencyMs`, never a message body.
- **`NODE_ENV=test` disables tracing by default** (confirmed in `@openai/agents-core`'s `config.js`): any test
  that exercises the real pipeline must call `setTracingDisabled(false)` first.

## Mapping

| OpenAI span / hook | Canonical event(s) |
|---|---|
| Trace start/end | No event by itself. Session id = `trace.groupId ?? trace.traceId`; `taskId` from the `taskId` option (literal or a function of the trace). At trace end, the agent whose span ended last gets `DONE` unless it last reported `ERROR`. |
| `agent` span start | `agent.registered` (once per agent id for the life of the processor) and `agent.status.changed` `THINKING`. `model` is always `'Custom'`: the agent span has no model, and the real model is reported per call on `llm.usage`. |
| `agent` span end | `agent.status.changed` `IDLE` or `ERROR`, only once every concurrent span of that agent has ended (a per-agent active-span counter, not a shared "current agent"). |
| `function` span (tool) | `tool.started` at start, `tool.completed`/`tool.failed` at end. `toolCallId` is the span id (the SDK gives function spans no separate call id); `durationMs` from the span's own timestamps. After a tool starts or ends, the owning agent's status is re-emitted as `USING_TOOL` (if another tool is still in flight) or `THINKING`, so the server's own `tool.completed -> IDLE` behavior never hides a still-running agent. |
| `handoff` span | `agent.message.sent` from the source agent with the fixed text `Handoff to <name>` (never a model-authored reason) and a `THINKING` status hint for the target (registered if new). |
| `generation`/`response` span, success | `llm.usage`, built from the extraction rules above. A field the SDK did not report is omitted, never `0`; a missing model is the literal `'unknown'`. `cost` is always `null` with `costSource: 'unknown'`: OpenAI does not return a price, and this adapter never estimates one. |
| `generation`/`response` span, error | `llm.failed` (see "Step 0 findings" for what is and is not included). No `llm.usage` is emitted for the same call. |
| `guardrail`, `custom`, `task`, `turn`, and every other span type | Ignored (no event). |

Owning-agent resolution walks `parentId` up through a bounded, trace-scoped span map to the nearest `agent`
span; a model call made outside any agent span (or whose ancestor was evicted) is attributed to a fixed
"unattributed" fallback agent and is never dropped for lack of attribution.

## Privacy

By default the processor reads only span type, agent/tool/model names, ids, timestamps, error presence and the
narrow usage fields above. It never reads `spanData.input`/`spanData.output` (function spans), the raw
`_response`/`_input` beyond `.model`/`.usage`/`.id`, or anything resembling instructions or a handoff reason.
`includeToolInputSummary: true` opts into a 120-character truncated summary of a tool's input and output; it is
`false` by default.

## Delivery

Processor callbacks never await the network: they validate and enqueue, then return. A periodic, unref'd timer
flushes in batches of up to 100 events via the TypeScript SDK's own `emitBatch` (which already retries
429/5xx). The queue is bounded (`maxQueueSize`, default 1000); when full, the oldest non-`llm.usage`/`llm.failed`
event is dropped first, and a usage/failure event is only dropped once nothing else is left to drop. `stats()`
reports `{ queued, sent, duplicates, dropped, droppedUsage, rejected, noUsageCalls }` so loss is observable, not
silent. `shutdown(timeoutMs)`/`forceFlush()` await a full flush cycle (chained onto any flush already in
progress) and never throw.

**Deferred** (see the parent issue's section 4): per-batch partial-rejection handling (removing just the
invalid event out of a rejected batch by reading the server's `errors[].index`) and HTTP 413 batch-size
halving. A batch that fails after the SDK's own retries is currently dropped whole and counted in
`stats().dropped`/`droppedUsage`.

## Known limitations

- One `AgentViewer` instance is kept per distinct session id (capped at 1000, oldest evicted) instead of a
  single instance with a per-event `sessionId`, because the shared SDK does not have that field yet (it is
  being added in parallel for issue #99/#343). A consequence: `agent.registered` is only ever sent once, under
  whichever session first needed that agent, even though agents are a global concept in the office, not a
  per-session one.
- `errorKind` on `llm.failed` is always `'unknown'`: the OpenAI Agents SDK's `SpanError` has no structured
  status code today.
- No Python equivalent (the `openai-agents` Python package has the same tracing processor concept; out of
  scope for this item, see the parent issue).
