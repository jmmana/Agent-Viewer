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

Before opening a pull request:

```bash
npm run lint
npm test
npm run build
```

All three checks should pass.

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
