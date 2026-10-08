# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-08

First release of the embeddable library as the package `@warlockcode/agent-viewer`. Until it is published on npm (coming soon), it is installed from the GitHub release asset. While the package is at 0.x, its API may still change between minor versions. The guide is in [docs/library.md](docs/library.md) ([español](docs/library.es.md)).

### Added
- Library build: `npm run build:lib` writes ES modules and TypeScript declarations to `dist-lib/`. The package is ESM only, React and React DOM `^19` are peer dependencies, and `lucide-react` and `zod` are its only runtime dependencies. Modules stay in separate files so bundlers can drop what a host does not import.
- `<AgentOffice>` driven only by events: the office is derived from the `events` prop (append for live activity, pass a slice of a recorded run for replay), with optional `agents` profiles (name, role title, team, workspace, avatar color), controlled selection and a configurable bubble duration.
- Professional mode, the default: the office shows only what the events say, with no ambient life, no invented lines, no hidden second floor and no sounds. `mode="showcase"` adds simulated office life, marked as simulated.
- `OfficeStore` and `buildOfficeSnapshot` to derive the office from events without rendering it (servers, tests, exports).
- `useEventReplay` and the optional `ReplayControls` to replay a run at its original pace, with seek and speed.
- Injectable texts: `locale`, `messages` and `t` props, built-in English and Spanish catalogs (`OFFICE_MESSAGES`), and `createOfficeTranslator`, `formatMessage`, `builtInMessages` and `isOfficeMessageKey`. A host `t` wins when it returns a value, then `messages`, then the built-in catalog of the locale, then English.
- Usage display rules: `showUsage` shows only the figures the host passes in `usage` (`total` and `byAgent`), and a missing value is shown as "unknown", never as zero. Helpers `formatUsage`, `formatTokens` and `formatCost`, plus the opt-in `summarizeUsage`, which only adds up reported figures and never prices tokens.
- Isolated CSS in `@warlockcode/agent-viewer/style.css`, imported by the host: every class starts with `av-`, there is no reset and no global selector, the theme lives in `--av-*` custom properties with zero specificity, and no external fonts are loaded.
- Accessibility: a live list of agents and their statuses that opens on keyboard focus and selects agents with the keyboard, a labeled canvas, toolbar and replay controls, visible focus, and no animation under `prefers-reduced-motion`.
- Message kinds in the event contract (`MESSAGE_KINDS`, `isMessageKind`): `statement`, `proposal`, `question`, `answer`, `objection`, `critique`, `agreement`, `summary` and `decision`. `meeting.message` `type` uses them, `agent.message.sent` accepts an optional `kind`, and speech bubbles show the kind in their header.
- Optional `currency` (ISO 4217 code) in the `llm.usage` payload.
- `CanonicalEventInput` and `LegacyEventType` types, and `EVENT_TYPE_ALIASES` in the public exports.
- `computeReplaySchedule`, and new `recordReplay` options: `agents`, `mode`, `maxGapMs`, `tailMs`, `maxDurationMs`, `locale`, `messages`, `t` and `usage`.

### Changed
- Two offices on the same page never share state. The library uses no `localStorage`, no timers that invent data and no global keyboard shortcuts, and nothing runs on import.
- `recordReplay` draws on its own offscreen canvas, keeps the pacing of the original run, and never computes usage: the title and the usage figures appear only when passed.
- The `workspace` of an agent profile is its home: a new agent appears at its desk, and returns there after a meeting.
- The demo app (`npm run dev`) keeps working as before and builds separately with `npm run build`.

### Fixed
- `package-lock.json` now includes every platform binary, so `npm ci` works on a clean checkout on macOS, Linux and Windows.
- OTLP import removed: it loaded a module that did not exist. `parseEventLog` now reports that OTLP traces are not supported yet.
- Video export: `recordReplay` passed a canvas where the renderer expected a 2D context, so it failed on the first frame.
- An unknown `workspace` value in an event no longer crashes the engine; it is ignored.

### Removed
- `metadata.json`: nothing in the repository referenced it.

### Breaking changes
Compared with the previous `AgentOffice` API, which was never published:
- `mode` accepts `professional` (default) or `showcase`. The values `live`, `demo` and `replay` are gone.
- The built-in drag and drop of log files, the replay bar and the video export button were removed from `<AgentOffice>`. Use `parseEventLog`, `useEventReplay` with `ReplayControls`, and `recordReplay` instead.
- `showUsage` defaults to `false`, and the figures come only from the new `usage` prop.
- `agents` takes `AgentProfile` objects (identity only) instead of full agent state; what agents do comes from `events`.
- The `replayEvents`, `activeMeetingId` and `onVideoExport` props were removed, and `SessionReplayPlayer` is no longer exported.
- `recordReplay` no longer accepts a `canvas`, `showUsage` defaults to `false`, and there is no default title.

## [0.1.0] - 2026-10-07

Groundwork before the first release. It was never tagged or published: the library package, the lockfile and the video export it mentions were completed or fixed in 0.2.0.

### Added
- Canonical Event Contract V1 with runtime envelope and strict Zod validation.
- Real-time Server-Sent Events (SSE) streaming endpoint `/api/v1/events/stream`.
- Support for query-based token authentication (`?token=` and `?api_key=`) for standard `EventSource` clients.
- Clean live streaming mode (`mode=live`) starting with 0 seeded agents, 0 synthetic tokens, and no demo operator controls.
- Distinct presentation activity state (`presentationActivity` & `ambientBubble`) decoupled from authoritative work `status`.
- Reusable React component library `@warlockcode/agent-viewer` exporting `<AgentOffice />`.
- Packaged Python SDK (`agent-viewer`) with `pyproject.toml` and live integration test suite.
- Generic webhook ingestion `/api/v1/webhooks/generic` with Zod length validation and safe JSON error handling.
- Multi-room office layout including Director Suite, Meeting Rooms A & B, Break Room, Server Room NOC, and Secret Floor.
- Session persistence throttled writer with local storage support.

### Changed
- Switched dependency management to pure `npm ci` with clean lockfile integrity.
- Upgraded target Node.js runtime to Node 24 (`.nvmrc` and `Dockerfile`).
- Emitted SSE event frames with `data:` payload directly to enable universal browser `EventSource.onmessage` handlers.
- Updated documentation with accurate quickstart, event schemas, architecture diagrams, and honest adapter status.

### Removed
- Removed unused packages (`@google/genai`, `motion`, `autoprefixer`, `esbuild`).
- Removed obsolete `bun.lock` and legacy platform binary artifacts.
- Removed outdated previews containing platform borders.
