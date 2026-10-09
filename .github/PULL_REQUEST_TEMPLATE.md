## Summary

Warn operators when the ingestion API runs without a token, expose auth modes in `/health`, and alert users in live mode.

## Changes Made

- Added per-request auth state and startup warnings to the server.
- Added `/health.auth` and `/health.webhookAuth`.
- Added a live health poll, persistent open-API banner, and English / Spanish translations.
- Bound Compose ports to loopback and updated Docker/security documentation.

## Verification & Commands Executed

- `npm audit --omit=dev` - passed, 0 vulnerabilities.
- `npm run lint` - passed (`tsc --noEmit`).
- `npm test` - passed: 122 Node tests and 442 Vitest tests.
- `python3 tests/test_python_sdk.py` - passed, 3 tests.
- `npm run build` - passed (Vite reported a large-chunk advisory).
- `npm run build:lib` - passed.
- `npm run build:cli` - passed.
- `npm run check:package` - passed after `npm run build:cli`; publint and attw reported no package errors.
- `docker compose -f docker/compose.yml config --format json` - passed; API and viewer `host_ip` values are `127.0.0.1`.
- `docker build -f docker/Dockerfile -t agent-viewer-app:local .` - passed.
- `docker build -f docker/Dockerfile --target api -t agent-viewer-api:local .` - passed.
- `docker build -f docker/Dockerfile --target viewer --build-arg VITE_AGENT_VIEWER_API_URL=http://localhost:8787 -t agent-viewer-viewer:local .` - passed.
- `PORT=49387 AGENT_VIEWER_STORAGE=memory AGENT_VIEWER_API_TOKEN= AGENT_VIEWER_API_KEY= AGENT_VIEWER_WEBHOOK_SECRET= npm run dev:full` - manually verified one open-API warning and the corrected all-interface listening line.

The first `npm run check:package` attempt was before `npm run build:cli` and reported the expected missing `dist-cli/cli.js`; the check passed when rerun in CI order.

## What Is Left

- No implementation work remains. Browser-based smoke verification was unavailable because the Playwright browser transport closed; the live health hook and banner are covered by Vitest.

## Checklist

- [x] Code follows project conventions.
- [x] No secrets or real user credentials included.
- [x] Tests added or updated for all changes.
- [x] Verified on local environment.
