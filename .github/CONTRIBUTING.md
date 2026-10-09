# Contributing to Agent Viewer

Thanks for helping improve Agent Viewer.

## Before you start

For non-trivial changes, open or claim a focused issue first. Keep each branch aligned to one issue whenever practical.

Recommended branch names:

- `feature/av-123-short-description`
- `fix/av-123-short-description`
- `docs/av-123-short-description`

## Development setup

Use Node.js 24.

```bash
npm ci
npm run dev
```

## Required checks

CI (`.github/workflows/ci.yml`) runs these checks on every push and pull request. Run them locally before opening a pull request:

```bash
npm audit --omit=dev            # security audit of runtime dependencies
npm run lint                    # typecheck (tsc --noEmit)
npm test                        # node:test suites and Vitest
npm run test:golden             # golden reconciliation suite (issue #62; also part of npm test)
python3 tests/test_python_sdk.py   # Python SDK tests
python3 -m pip wheel ./sdk/python -w /tmp/wheels   # Python SDK wheel builds...
python3 -m pip install /tmp/wheels/*.whl          # ...installs...
(cd /tmp && python3 -c "import agent_viewer")      # ...and imports
npm run build                   # demo app
npm run build:lib               # embeddable library
npm run check:package           # publint and attw on the package
docker build -f docker/Dockerfile .                    # API image (default target)
docker build -f docker/Dockerfile --target viewer .    # office image
```

All of them should pass. Install the wheel in a virtual environment so it does not touch your system Python. If you do not have Docker locally, CI still runs the image builds; mention it in the pull request.

Any change to usage or cost math, in any layer (the memory store, the SQLite store, the portal reducer, the embeddable library), must keep `npm run test:golden` green (`tests/fixtures/reconciliation/`, issue #62). Adding a new usage case (a new currency shape, a new way a figure can be missing, a new kind of duplicate) starts with a new line in `tests/fixtures/reconciliation/golden.events.jsonl` and the matching hand-worked numbers in `golden.expected.json`, explained in the pull request.

## Pull requests

A useful PR should include:

- the issue it addresses
- a concise implementation summary
- screenshots for visible office/UI changes
- tests for logic changes
- documentation updates when behavior or integration contracts change

Avoid combining unrelated refactors with feature work.

## Product rules

Agent Viewer is an observability layer, not a chain-of-thought viewer.

Do not add features that require or expose private model reasoning. Prefer observable statuses, explicit messages, tool metadata, outputs, task state and usage telemetry.

Keep ambient social dialogue clearly distinguishable from real runtime messages.

## Internationalization

English is the canonical source locale. Spanish is the first secondary locale.

Semantic IDs, event names, provider IDs, model IDs and runtime states must remain language-neutral.

## Integration changes

External event contracts are versioned. Breaking changes require a new major schema version or a compatibility layer.

## Code style

- TypeScript first
- small, focused modules
- keep simulation state separate from presentation-only animation
- avoid silently treating unknown telemetry as zero when the distinction matters
