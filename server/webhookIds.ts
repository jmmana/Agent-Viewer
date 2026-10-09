import crypto from 'node:crypto';

/**
 * Deterministic event ID for webhook deliveries.
 * Uses SHA-256 hash to ensure the same delivery always gets the same ID,
 * while hiding the key and signature in the ID.
 *
 * @param kind Event kind: 'status', 'msg', 'tool', or 'usage'
 * @param keySource Source of the idempotency key
 * @param key The idempotency key value
 * @returns Event ID with format `evt_wh_{kind}_{32-char-hex}`
 */
export function webhookEventId(
  kind: 'status' | 'msg' | 'tool' | 'usage',
  keySource: 'body' | 'header' | 'signature' | 'requestId',
  key: string
): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(['agent-viewer:webhook:v1', keySource, key, kind]))
    .digest('hex');
  return `evt_wh_${kind}_${digest.slice(0, 32)}`;
}

/**
 * Deterministic event ID for llm.usage when a requestId is present.
 * Uses the provider and requestId to ensure the same call is counted once
 * even across different deliveries or retries.
 *
 * @param provider The LLM provider name
 * @param requestId The provider-reported request ID
 * @returns Event ID with format `evt_wh_usage_{32-char-hex}`
 */
export function webhookUsageRequestEventId(provider: string, requestId: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(['agent-viewer:webhook:v1', 'usage-request', provider, requestId]))
    .digest('hex');
  return `evt_wh_usage_${digest.slice(0, 32)}`;
}
