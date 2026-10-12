# Webhooks

This is the one canonical page for both directions of webhook traffic in Agent Viewer:

- **Inbound**: `POST /api/v1/webhooks/generic`, a flat-body intake your runtime can call directly, optionally signed.
- **Outbound**: the `budget.alert` delivery (issue #86) the server sends to a destination you configure when a
  budget ([docs/budgets.md](budgets.md)) crosses its warning or exceeded threshold.

Both use the same HMAC-SHA256 scheme, with independent secrets. Everything below is read from the merged
`server/index.ts` and `server/budgetAlertDelivery.ts`; where the code's actual behavior differs from an earlier
design note (for example, a duplicate signature answers `200`, not a separate `409`), this page documents the
real behavior.

`README.md` and `docs/integration.md` keep only a two-line summary and a link here, so there is one place to
update when this contract changes.

## Inbound: `POST /api/v1/webhooks/generic`

With no `AGENT_VIEWER_WEBHOOK_SECRET` configured, the route accepts the same Bearer token as every other
`/api/v1` route (`401 unauthorized` with no or a bad token). Setting `AGENT_VIEWER_WEBHOOK_SECRET` switches the
route to signature verification instead: the Bearer check is bypassed for `/webhooks/*` and a valid signature is
required, full stop. The two schemes are never both required.

### Headers and the signed string

| Header | Meaning |
|---|---|
| `X-Agent-Viewer-Timestamp` | Milliseconds since the Unix epoch (not seconds), generated fresh for this attempt. |
| `X-Agent-Viewer-Signature` | Hex-encoded HMAC-SHA256 of `${timestamp}.${rawBody}`, keyed with `AGENT_VIEWER_WEBHOOK_SECRET`. |

```ts
const signature = crypto
  .createHmac('sha256', secret)
  .update(`${timestamp}.${rawBody}`)
  .digest('hex');
```

`rawBody` must be the **exact bytes** the server received, not a re-serialization of the parsed JSON: the server
signs the raw body it captured while parsing (`express.json`'s own `verify` hook), and falls back to
`JSON.stringify(req.body)` only when no raw body was captured at all. A receiver (or sender) that re-serializes
the payload before hashing it will produce a signature that never matches, even when the JSON is semantically
identical (key order, spacing and number formatting all change the bytes). Send `Content-Type: application/json`;
a body sent under any other content type is never captured as raw bytes by `express.json`, so it falls back to
the stringify path and can mismatch a receiver that hashes the bytes it actually read off the wire.

### Response table

One row per distinct outcome, in the order the server can reach them. `error` values are copied verbatim from
`server/index.ts`.

| Status | `error` | When |
|---|---|---|
| `429` | `rate_limit_exceeded` | The per-IP rate limiter on `/api/v1` rejects the request, before authentication. |
| `401` | `query_token_not_supported` | A `token` or `api_key` query parameter was sent; only an `Authorization: Bearer` header or a signature is ever accepted. |
| `403` | `open_api_loopback_only` / `open_api_host_not_allowed` | No token and no webhook secret configured, and the request is not from a loopback peer, `Host` or `Origin`. |
| `401` | `unauthorized` | No `AGENT_VIEWER_WEBHOOK_SECRET` configured, and the Bearer token is missing or wrong. Signature checks below never run in this case: the route is on plain token auth. |
| `401` | `missing_webhook_signature` | A secret is configured, but `X-Agent-Viewer-Signature` or `X-Agent-Viewer-Timestamp` is missing. |
| `401` | `replay_detected_or_clock_skew` | The timestamp is not a number, or is more than 5 minutes away from the server's clock in either direction. One literal covers both an expired and a future timestamp; a timestamp sent in seconds instead of milliseconds lands here (it reads as a 1970s date, far outside the window). |
| `401` | `invalid_webhook_signature` | The signature does not match the expected HMAC, compared in constant time. |
| `400` | `bad_request` | The body is not valid JSON. |
| `413` | (Express default body) | The body exceeds the 1 MB JSON limit shared by every `/api/v1` route. There is no custom `error` literal for this case; it is Express's own `PayloadTooLargeError` response. |
| `400` | `validation_failed` | The payload does not match the webhook's own schema (`issues[]` names each bad field), **or** one of the canonical events generated from it (`agent.status.changed`, `agent.message.sent`, `tool.started`, `llm.usage`) fails canonical validation. Two different causes share this one literal; read `issues`/`message` to tell them apart. |
| `400` | `unrecognized_webhook_payload` | The body has none of `status`, `message`, `text`, `tool` or `usage`: nothing to turn into an event. |
| `400` | `invalid_idempotency_key` | A body `idempotencyKey` or `Idempotency-Key` header is present but not 1-255 printable ASCII characters. |
| `400` | `idempotency_key_mismatch` | Both a body `idempotencyKey` and an `Idempotency-Key` header are present, disagree, and no webhook secret is configured (with a secret, the signature itself is the idempotency source and this check does not apply). |
| `409` | `event_id_conflict` | The computed event id already exists with different content (the same idempotency source was reused for a different payload). |
| `200` | none (`accepted: true, duplicate: true`) | **Replay of an already-accepted signature inside the 5-minute window.** This is a success response, not an error: the server recognizes the exact same signed request and returns the original result again rather than re-processing it. There is no distinct `409` for this case. |
| `200` or `202` | none | Accepted. `202` when at least one generated event was newly stored; `200` when every one of them was already known (for example, by `(provider, requestId)` dedup) with no conflict. The body always includes `acceptedCount`, `duplicateCount` and `conflictCount`. |

### Order of checks

1. Rate limiter (`429`).
2. Query-token rejection (`401 query_token_not_supported`).
3. Open-mode guard when nothing is configured at all (`403`).
4. Bearer token, unless a webhook secret is configured, in which case this step is skipped for `/webhooks/*`.
5. Inside the route: signature headers present, then the timestamp window, then the HMAC compare.
6. Payload schema validation, then the "describes some activity" check.
7. Idempotency key resolution and its own validation.
8. Per-generated-event canonical validation.
9. **Replay cache lookup**, for a signed request only, checked before anything is written to the store. A
   request whose signature is already in the cache short-circuits here with the `200 duplicate: true` response
   above, without re-validating the payload.
10. Store append (`409 event_id_conflict` on a genuine id collision with different content).
11. Replay cache insert, only after a successful append, and SSE broadcast of newly accepted events.

The practical consequence of replay-cache-before-store-append: if a signed delivery's payload fails validation
(`400`) **after** a signature that would otherwise be remembered, the signature is not yet in the cache at that
point, so a corrected retry with the *same* timestamp and signature is still possible. But once a delivery
**succeeds**, retrying the identical bytes with the identical timestamp and signature always resolves to the
`200 duplicate: true` path: a genuine retry must use a fresh timestamp (and therefore a fresh signature), never
replay a stored one.

### The replay cache

An in-memory `Map<string, { expiresAt, eventIds }>`, per process, holding at most 10,000 remembered signatures.
Both the cache size (10,000) and the 5-minute tolerance window are hardcoded constants in `server/index.ts`;
neither has an environment variable. When the cache is full and a new signature needs to be inserted, the server
first drops every entry whose window has already expired, then, if still full, evicts entries in insertion order
until there is room. The cache is lost on restart and is never shared between server instances or processes: two
servers behind a load balancer, or a restart between a delivery and its retry, will not catch a replay the other
side already saw. This is a defense against a signature being resent verbatim inside its own validity window, not
a durable audit log.

### Idempotency key resolution

In priority order, the id a repeated delivery is recognized by: a body `idempotencyKey` field, then an
`Idempotency-Key` header (only honored when no webhook secret is set, since a configured secret makes the
signature itself the idempotency source), then the verified signature, then `usage.requestId`, then, with none of
those, a fresh random id (so two deliveries with no key of any kind are never considered duplicates of each
other). A `usage` object with a `requestId` always additionally dedupes on `(provider, requestId)`, independent of
the event id: see [docs/integration.md](integration.md#a-second-dedup-key-provider-requestid) for that mechanism,
shared with every other ingestion path.

### Sender and receiver examples

**Node, sender:**

```js
import crypto from 'node:crypto';

const secret = process.env.AGENT_VIEWER_WEBHOOK_SECRET;
const rawBody = JSON.stringify({ agent: 'atlas', status: 'coding', message: 'Writing the parser' });
const timestamp = Date.now().toString();
const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');

await fetch('http://localhost:8787/api/v1/webhooks/generic', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Agent-Viewer-Timestamp': timestamp,
    'X-Agent-Viewer-Signature': signature,
  },
  body: rawBody, // the exact string that was signed, never re-serialized
});
```

**Node, receiver** (for your own endpoint, if you proxy or mirror Agent Viewer's webhook shape):

```js
import crypto from 'node:crypto';

function verify(secret, timestamp, rawBody, signature, toleranceMs = 300_000) {
  const now = Date.now();
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > toleranceMs) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

The TypeScript SDK ships this exact check as `verifyWebhookSignature({ secret, timestamp, rawBody, signature })`
(`sdk/typescript/index.ts`), returning a plain boolean and never throwing.

**Python, sender:**

```python
import hashlib
import hmac
import json
import time
import urllib.request

body = json.dumps({"agent": "atlas", "status": "coding", "message": "Writing the parser"})
timestamp = str(int(time.time() * 1000))
signature = hmac.new(SECRET.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()

req = urllib.request.Request(
    "http://localhost:8787/api/v1/webhooks/generic",
    data=body.encode("utf-8"),
    headers={
        "Content-Type": "application/json",
        "X-Agent-Viewer-Timestamp": timestamp,
        "X-Agent-Viewer-Signature": signature,
    },
)
urllib.request.urlopen(req)
```

**Python, receiver:** use the SDK's own `verify_webhook_signature(secret, timestamp, raw_body, signature)`
(`sdk/python/agent_viewer.py`), which implements the identical check and is already covered by the SDK's test
suite; see [sdk/python/README.md](../sdk/python/README.md#verifying-an-outbound-webhook-issue-86-sub-issue-323)
for a full receiver example. Do not reimplement the comparison by hand; use `hmac.compare_digest` (or the SDK
helper) rather than `==`, which is not constant time.

**Sender guidance:** sign every attempt with a fresh `X-Agent-Viewer-Timestamp`, never resend a stored signature
to retry a failed delivery, and give two payloads that could otherwise land in the same millisecond something
that makes their bytes differ (for example, a `usage.requestId` or any other field that varies per call), since
two byte-identical bodies signed with the same timestamp produce the same signature and the second is read back
as a replay of the first, not a new delivery.

## Outbound: the `budget.alert` delivery (issue #86)

When `AGENT_VIEWER_ALERT_WEBHOOK_URL` is configured, every `budget.alert` canonical event (a budget, configured
through [docs/budgets.md](budgets.md), crossing into `warning` or `exceeded`) is `POST`ed there. With no URL
configured, the feature is off and nothing is ever sent; every alert's delivery stays `skipped`. An alert
detected for an already-closed period (`backfill: true`, for example from a re-imported history) is never
delivered, regardless of configuration.

### Headers and signature

| Header | Meaning |
|---|---|
| `X-Agent-Viewer-Event` | Always the literal `budget.alert`. |
| `X-Agent-Viewer-Delivery` | The alert id. Stable across every retry of the same alert: this is the field to dedupe on. |
| `X-Agent-Viewer-Attempt` | `1` on the first try, incrementing by one on each retry. |
| `X-Agent-Viewer-Timestamp` | Milliseconds since the epoch, generated fresh on **every** attempt, including retries. |
| `X-Agent-Viewer-Signature` | Hex HMAC-SHA256 of `${timestamp}.${rawBody}`, using `AGENT_VIEWER_ALERT_WEBHOOK_SECRET`. Omitted entirely (no header at all) when that secret is unset; the delivery is sent unsigned rather than with an empty or fake signature. |

This is the same `${timestamp}.${rawBody}` construction the inbound route verifies with, computed with a
separate secret (`AGENT_VIEWER_ALERT_WEBHOOK_SECRET`, never `AGENT_VIEWER_WEBHOOK_SECRET`): the two directions
are never interchangeable, and a server that only ever receives inbound webhooks does not need the alert secret
at all. The request body is byte-identical on every retry of the same alert (the exact bytes recorded when the
alert was created), so a receiver can safely verify the signature against the body it actually read, on any
attempt.

**Receiver verification** is the identical check as the inbound direction, just against
`AGENT_VIEWER_ALERT_WEBHOOK_SECRET` instead of `AGENT_VIEWER_WEBHOOK_SECRET`: use the same `verify` function (Node)
or `verify_webhook_signature`/`verifyWebhookSignature` SDK helper (Python/TypeScript) shown above. There is no
second scheme to learn. A retry of the same delivery still carries a fresh timestamp and therefore a fresh
signature each time (the body does not change, but the timestamp and signature do); a receiver with its own
replay cache should key it on `X-Agent-Viewer-Delivery` (stable across retries), not on the signature (which
changes every attempt), or it will treat every retry of the same alert as a new signature with nothing to compare
against for duplication.

### Payload

The JSON body is the `budget.alert` event's payload, metadata only, never a prompt, a secret or free text:

```json
{
  "alertId": "evt_budget_3f9c...",
  "budgetId": "bud_097068f1-8a60-40fe-a317-1ad21d737644",
  "budgetName": "Builder monthly",
  "scope": { "type": "agent", "value": "builder" },
  "period": { "type": "month", "start": 1790812800000, "end": 1793491200000 },
  "state": "exceeded",
  "threshold": 1,
  "limit": 30,
  "currency": "USD",
  "knownSpent": 41.2,
  "spendIsLowerBound": false,
  "calls": { "total": 1, "withCost": 1, "unknownCost": 0, "otherCurrency": 0, "missingCurrency": 0 },
  "containsEstimates": false,
  "pricingVersions": [],
  "backfill": false,
  "detectedAt": 1791767378446
}
```

`state` is `warning` or `exceeded` only (a transition into `ok` or `unknown` never raises an alert). `threshold`
is the budget's own `warningRatio` for a `warning` alert, or `1` for `exceeded`. `spendIsLowerBound` is `true`
when `knownSpent` is a provable floor rather than the complete figure (some in-scope calls were uncountable);
`containsEstimates` and `pricingVersions` carry the same meaning as the matching fields on a `BudgetStatus`
(docs/budgets.md). There is one alert per threshold crossing per period: a budget that stays `exceeded` across
several more calls in the same period does not re-fire until the window rolls over or the state changes again.

### Retries, backoff and delivery

Delivery is a background worker, not synchronous with the crossing: any `2xx` response is a success. A network
error, a timeout, `408`, `429` or any `5xx` retries; any other `4xx`, or a redirect, fails immediately with no
retry. Backoff is `min(5000ms * 2^(attempt-1), 1 hour)`, actually applied as a random value in
`[backoff/2, backoff]`; a `Retry-After` response header raises the floor (never lowers it), still capped at one
hour. After `AGENT_VIEWER_ALERT_WEBHOOK_MAX_ATTEMPTS` (default 6, 1 to 20) the delivery is left `failed` for good,
a dead letter that is never retried again; the only server log line on final failure names the alert id and the
last HTTP status, never the secret, the URL or the payload. Delivery is **at least once**: a receiver must treat
`X-Agent-Viewer-Delivery` as an idempotency key and tolerate seeing the same alert id more than once, including
out of order with respect to other alerts. In `AGENT_VIEWER_STORAGE=sqlite`, a still-`pending` delivery resumes
automatically after a restart; in `memory` mode it is lost, the same documented limitation as the rest of that
storage mode. `GET /api/v1/budget-alerts[?budgetId=&since=&limit=]` and `GET /api/v1/budget-alerts/:alertId`
(same `/api/v1` auth as every other route) let an operator read back every detected alert and its own
`delivery: { status, attempts, lastStatus, deliveredAt }`, including one still `pending` or already `failed`.

### Target URL restrictions, and a known gap

At startup, `AGENT_VIEWER_ALERT_WEBHOOK_URL` must parse as a URL with scheme `http:` or `https:` and must not
embed `user:pass@` credentials; a plain `http://` destination is refused unless the host is loopback
(`127.0.0.0/8`, `localhost`, `::1`) or `AGENT_VIEWER_ALERT_WEBHOOK_ALLOW_HTTP=1` is set. **This does not block a
non-loopback, non-public `https://` destination** (for example a cloud metadata address reachable only over
`https`): there is no general private-address or SSRF check on the `https` scheme today, only the `http`
loopback rule above. Treat the destination as operator configuration you trust, not as untrusted input, until a
stronger check ships; this is a real, current limitation, not a hypothetical one.

### Secret handling

- Configure `AGENT_VIEWER_WEBHOOK_SECRET` (inbound) and `AGENT_VIEWER_ALERT_WEBHOOK_SECRET` (outbound) as
  environment variables or your platform's secret store; never commit either to the repository and never put a
  secret in the webhook URL itself (`parseAlertWebhookConfig` already refuses a URL with embedded credentials).
- To rotate a secret with zero downtime for the direction you verify (inbound), accept both the old and the new
  secret for a short overlap window in your own verification code (try the new secret, then the old one), update
  `AGENT_VIEWER_WEBHOOK_SECRET` on the server, then drop the old secret from your verification code once you are
  sure every sender has moved. The server itself only ever holds one active secret per direction at a time; a
  rolling rotation needs this two-sided overlap on the receiving end.
- Neither secret is ever logged: the final-failure log line for an outbound delivery names only the alert id and
  the last HTTP status. Build and export tooling redacts known secret patterns from stored event text ([docs/redaction.md](redaction.md)), but a webhook secret itself is never stored as event data in the first place, so
  there is nothing for that redaction pass to find or miss here.

## Troubleshooting

**`invalid_webhook_signature`:**
- The body was re-serialized before hashing (different key order, spacing or number formatting than the bytes
  actually sent). Hash the exact bytes on the wire, not `JSON.stringify` of a parsed object.
- A proxy or gateway in front of the server rewrote the body (added a trailing newline, changed line endings,
  re-encoded the character set) between the sender signing it and the server receiving it.
- The wrong secret, or a secret with leading/trailing whitespace copied in from an environment file.

**`replay_detected_or_clock_skew`:**
- Real clock drift between sender and server past five minutes; check both clocks against NTP.
- A timestamp sent in seconds instead of milliseconds (the usual convention from other providers): this always
  reads as a date decades in the past, far outside the window.

**A retry never seems to arrive, or always comes back as a duplicate:**
- The retry reused the original timestamp and signature. Sign every attempt, including retries, with a fresh
  `X-Agent-Viewer-Timestamp`.
