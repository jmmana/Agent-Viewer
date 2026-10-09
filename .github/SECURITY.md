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
| **Webhook Ingestion** | Unauthenticated if secret unset | Set `AGENT_VIEWER_WEBHOOK_SECRET` to enforce HMAC-SHA256 signature verification (`X-Agent-Viewer-Signature`). |
| **CORS Policy** | `*` (All origins permitted) | Set `AGENT_VIEWER_CORS_ORIGIN` to your explicit frontend domain (e.g. `https://office.example.com`). A `*` value does not count as an explicit origin for the open-mode request guard below. |
| **Network Binding** | Bound to `127.0.0.1` (`AGENT_VIEWER_HOST`) | A non-loopback `AGENT_VIEWER_HOST` with no token refuses to start (`OpenApiRefusedError`, exit code 1); set `AGENT_VIEWER_API_TOKEN` first, or `AGENT_VIEWER_ALLOW_OPEN=1` to accept an open API. Even on a loopback bind, while no token is set, a request from a non-loopback remote address, `Host` or `Origin` gets `403`. Still put the server behind a reverse proxy (e.g. Nginx, Caddy, Cloudflare) with TLS terminated and rate limiting; a reverse proxy on the same host makes every request look local, so it still needs a token. |
| **Storage Engine** | In-memory | Set `AGENT_VIEWER_STORAGE=sqlite` with a secured persistent volume path `AGENT_VIEWER_SQLITE_PATH`. |

## Secret Handling

Agent Viewer does not require model API keys (OpenAI, Anthropic, Gemini, etc.) to run the viewer interface or replay events. All token usage numbers and costs are reported by external runtime callers. Never transmit raw API keys or private system prompts through the canonical event stream.
