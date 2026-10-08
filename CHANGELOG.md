# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-08

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
