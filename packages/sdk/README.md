# @warlockcode/agent-viewer-sdk

Minimal client for sending [canonical V1 events](https://github.com/jmmana/Agent-Viewer#readme) to an Agent
Viewer server from any Node runtime. No framework, no React, no `zod`, no runtime dependencies at all.

This package is the standalone extraction of what used to live only at `sdk/typescript/index.ts` (issue
#343). `sdk/typescript/index.ts` still exists and still works exactly as before: it is now a thin re-export
of this package, kept so existing imports (this repo's own tests, the example adapters under `examples/`)
never had to change.

## Install

```bash
npm install @warlockcode/agent-viewer-sdk
```

## Usage

```ts
import { AgentViewer } from '@warlockcode/agent-viewer-sdk';

const viewer = new AgentViewer({ url: 'http://localhost:8787', apiKey: process.env.AGENT_VIEWER_API_TOKEN });
const agent = viewer.agent({ id: 'triage', name: 'Triage Agent', provider: 'anthropic', model: 'claude-sonnet-4-5' });

await agent.thinking('Reading the ticket');
await agent.usage({ provider: 'anthropic', model: 'claude-sonnet-4-5', inputTokens: 1520, outputTokens: 311 });
await agent.done();
```

`AgentViewer.emit()`/`emitBatch()` accept a per-event `sessionId`, so one long-lived client can serve many
sessions (for example one process handling many LangGraph `thread_id`s). See the exported `AgentViewerOptions`,
`EmitEventInput`, `UsageOptions` and `LlmFailedOptions` types for the full surface.

## Design: no dependency on this repo's own source

Everything this package exports (`CanonicalEvent`, `CanonicalEventType`, `EventSeverity`, `LlmErrorKind`, the
`llm.usage`/`llm.failed`/`tool.*` payload shapes, `ViewerSnapshot`, `UsageSummary`, `CallRecord`, the usage
rollup types, the budget types, `UsageFigures`, ...) is a **structural copy**, not an import, of the
equivalent type in `src/integrations/*`, `server/*` or `src/lib/*`. `packages/sdk/src/index.ts` has no
runtime or type import of anything outside this directory (not even `zod`), so its published `.d.ts` never
references a file this package does not ship.

A CI type test (`tests/types/sdk-package-canonical-event.ts`, checked by the root `npm run lint`) asserts
that this package's `CanonicalEvent`, `CanonicalEventType`, `EventSeverity` and `LlmErrorKind` stay assignable
to the root contract's types in both directions, so the copy cannot silently drift from the original without
breaking the build.

## Workspace layout (read this before adding another `packages/*`)

This is the first package under the root `"workspaces": ["packages/*"]` entry, and its layout is the pattern
later packages (for example issue #100's `packages/openai-agents` adapter) should reuse:

- `package.json`: `"type": "module"`, ESM only (no CJS build), `exports` with a single `"."` entry pointing
  `types`/`import` at `./dist/index.d.ts` / `./dist/index.js`, `files: ["dist", "README.md"]`,
  `publishConfig.access: "public"`, and a `check:package` script (`publint --strict && attw --pack .`).
- `tsconfig.json`: standalone (does not extend the root `tsconfig.json`, which targets the Vite app and has
  `noEmit: true`), `rootDir: "src"`, `outDir: "dist"`, `declaration: true`, `types: ["node"]` only (no
  `vite/client`).
- `src/index.ts`: the package's whole public surface in one file (this one is ~1200 lines; that is fine).
  Every type it needs from this repo's own `src/`, `server/` or any other package's runtime source is copied
  in, never imported, so the package stays installable and type-correct completely on its own.
- Build with `npm run build` (plain `tsc -p tsconfig.json`, no bundler needed for a dependency-free ESM
  package). The root script `npm run build:packages` (`npm run build --workspaces --if-present`) builds every
  workspace package; it runs automatically before `npm run lint` and `npm test` (`prelint`/`pretest` in the
  root `package.json`), since the root `sdk/typescript/index.ts` re-export and anything else in this repo that
  imports a workspace package by name needs its `dist/` to exist first.
- Verify with `npm run check:package --workspace packages/<name>` (publint + attw, same as the root package's
  own `npm run check:package`) and a packed-tarball smoke test (see `.github/workflows/ci.yml`'s
  "packages/sdk smoke test from a packed tarball" step for the pattern: `npm pack`, install the `.tgz` into a
  throwaway ESM project, import it, assert the expected exports are functions).

## What stayed out of this package

Publishing to npm (the `release.yml` workflow changes, the version/tag check extension) is a later, separate
sub-issue of #99, not this one. This package is installable and type-checked in CI today; it is not yet
published under its own release process.
