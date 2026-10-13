# Security Policy

## Reporting a Vulnerability

Please do **not** open a public issue for any security vulnerability that could expose credentials, authentication tokens, session data, or remote execution risk.

To report a vulnerability:
1. Use GitHub's [Private Vulnerability Reporting](https://github.com/jmmana/Agent-Viewer/security/advisories/new).
2. Alternatively, email the maintainer privately at `jmmana@gmail.com` with the subject `[SECURITY] Agent-Viewer Vulnerability`.

Please include:
- Affected version, commit hash, or SDK release
- Step-by-step reproduction instructions or proof-of-concept
- Observed impact and suggested mitigation if known

We will acknowledge receipt within 48 hours and work with you on a coordinated fix.

## Default Configurations & Production Hardening

Agent Viewer is configured by default for zero-friction local development. In production deployments, configure the following environment variables to ensure security:

| Area | Default (Development) | Production Recommendation |
|---|---|---|
| **API Ingestion Token** | Unset (unauthenticated `/api/v1/*`) | Set `AGENT_VIEWER_API_TOKEN` to a high-entropy secret. Clients must supply `Authorization: Bearer <token>`. A `token` or `api_key` query parameter never authenticates, on any route; `EventSource` clients mint a short-lived, single-use ticket with `POST /api/v1/stream-tickets` instead. |
| **Webhook Ingestion** | Unauthenticated if secret unset | Set `AGENT_VIEWER_WEBHOOK_SECRET` to enforce HMAC-SHA256 signature verification (`X-Agent-Viewer-Signature`). The outbound `budget.alert` delivery (issue #86) is signed the same way with its own, separate `AGENT_VIEWER_ALERT_WEBHOOK_SECRET`; neither secret is ever logged. Full reference, including every response code and the replay cache: [docs/webhooks.md](../docs/webhooks.md). |
| **CORS Policy** | `*` (All origins permitted) | Set `AGENT_VIEWER_CORS_ORIGIN` to your explicit frontend domain (e.g. `https://office.example.com`). A `*` value does not count as an explicit origin for the open-mode request guard below. |
| **Network Binding** | Bound to `127.0.0.1` (`AGENT_VIEWER_HOST`) | A non-loopback `AGENT_VIEWER_HOST` with no token refuses to start (`OpenApiRefusedError`, exit code 1); set `AGENT_VIEWER_API_TOKEN` first, or `AGENT_VIEWER_ALLOW_OPEN=1` to accept an open API. Even on a loopback bind, while no token is set, a request from a non-loopback remote address, `Host` or `Origin` gets `403`. Still put the server behind a reverse proxy (e.g. Nginx, Caddy, Cloudflare) with TLS terminated and rate limiting; a reverse proxy on the same host makes every request look local, so it still needs a token. |
| **Storage Engine** | In-memory | Set `AGENT_VIEWER_STORAGE=sqlite` with a secured persistent volume path `AGENT_VIEWER_SQLITE_PATH`. |
| **Retention** | Keeps `events` and the usage ledger forever | Set `AGENT_VIEWER_RETENTION_DAYS` and, independently, `AGENT_VIEWER_USAGE_RETENTION_DAYS` to bound how long data stays on disk. This is a honest baseline, not tamper-evident: an operator with disk access can still delete or edit rows, including the purge audit log itself, without leaving a trace. See [docs/retention.md](../docs/retention.md). |
| **Redaction** | Built-in secret patterns applied only to `GET /api/v1/usage/export` and `/export/totals` | Redaction is not yet applied at ingestion, to the live stream, to `GET /api/v1/events`, or to webhook replays: a secret put in a free-text field (a `summary`, a message) is stored and streamed as sent, and is only masked in a usage-ledger export. Keep secrets out of event text; do not rely on redaction to scrub data already in transit or at rest. See [docs/redaction.md](../docs/redaction.md). |

**Data exfiltration surface:** the bootstrap API token (`AGENT_VIEWER_API_TOKEN`) is always an implicit `admin` credential, with read access to the entire usage ledger (`GET /api/v1/usage/export`), including every call's correlation ids and redacted text. Since issue #108, a named key can instead be scoped to exactly what it needs: `ingest` only (default), `read`, or the read-only `audit` scope for an auditor who should never be able to write an event or change configuration. Create a scoped named key for each client instead of sharing the bootstrap token; see [docs/api-keys.md](../docs/api-keys.md). Treat whichever credential has `admin` or `audit` scope as equivalent in sensitivity to read access over your whole consumption history, not only write access to the event stream.

## Audit and Key Management

Issues #105 through #110 (0.8.0) add a hash chain over stored events, signed checkpoints, named and scoped API keys, chain-compatible retention and redaction, and an offline-verifiable audit bundle. Read [docs/threat-model.md](../docs/threat-model.md) before relying on any of it: it states exactly what the chain proves, what it does not (including that it never proves a reported figure is true), and the residual risk of an operator who holds both the database file and the signing key. Key creation, scopes, rotation and revocation: [docs/api-keys.md](../docs/api-keys.md). Verification and the checkpoint format: [docs/audit.md](../docs/audit.md) and [docs/audit-chain.md](../docs/audit-chain.md).

## Secret Handling

Agent Viewer does not require model API keys (OpenAI, Anthropic, Gemini, etc.) to run the viewer interface or replay events. All token usage numbers and costs are reported by external runtime callers. Never transmit raw API keys or private system prompts through the canonical event stream; see [docs/redaction.md](../docs/redaction.md) for what the built-in secret redactor actually catches and where it runs today.
