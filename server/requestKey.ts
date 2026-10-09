/**
 * The second deduplication key for `llm.usage` and `llm.failed`: `(provider, requestId)`. See issue #48.
 *
 * Kept in its own module, with no dependency on either store, so a later ingestion path (for example OTLP,
 * see #59) can build the same key from its own payload shape without importing store internals.
 */
import type { CanonicalEvent } from '../src/integrations/canonicalContract';

const DEDUPABLE_TYPES = new Set(['llm.usage', 'llm.failed']);

export function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

export function normalizeRequestId(requestId: string): string {
  return requestId.trim();
}

/** Joins the two normalized parts into one map key. Never shown to a client. */
export function requestKeyString(provider: string, requestId: string): string {
  return `${normalizeProvider(provider)}\u0000${normalizeRequestId(requestId)}`;
}

export interface RequestKeyInfo {
  /** Normalized (trimmed, lowercased). */
  provider: string;
  /** Normalized (trimmed). */
  requestId: string;
  /** `requestKeyString(provider, requestId)`, ready to use as a map key. */
  key: string;
}

/**
 * The request key of one event, or null when the event cannot be deduplicated this way: not `llm.usage` or
 * `llm.failed`, or `requestId` missing, not a string, or blank after trimming. `provider` is required and
 * non-empty by the contract, so it needs no extra guard here beyond the type check.
 */
export function requestKeyFor(event: Pick<CanonicalEvent, 'type' | 'payload'>): RequestKeyInfo | null {
  if (!DEDUPABLE_TYPES.has(event.type)) return null;
  const payload = event.payload as Record<string, unknown> | undefined;
  const providerRaw = payload?.provider;
  const requestIdRaw = payload?.requestId;
  if (typeof providerRaw !== 'string' || typeof requestIdRaw !== 'string') return null;
  const provider = normalizeProvider(providerRaw);
  const requestId = normalizeRequestId(requestIdRaw);
  if (!provider || !requestId) return null;
  return { provider, requestId, key: requestKeyString(provider, requestId) };
}

/**
 * The usage-relevant fields compared between a request-id duplicate and its original: `type`, `model`, every
 * token field, `cost`, `currency` and `costSource`. Comparison must be null-safe (see `fingerprintFieldsMatch`):
 * unknown is never equal to zero, but absent on both sides is equal.
 */
export interface UsageFingerprintFields {
  type: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  cost: number | null;
  currency: string | null;
  costSource: string | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function extractUsageFingerprintFields(event: Pick<CanonicalEvent, 'type' | 'payload'>): UsageFingerprintFields {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  return {
    type: event.type,
    model: stringOrNull(payload.model),
    inputTokens: numberOrNull(payload.inputTokens),
    outputTokens: numberOrNull(payload.outputTokens),
    cacheReadTokens: numberOrNull(payload.cacheReadTokens),
    cacheWriteTokens: numberOrNull(payload.cacheWriteTokens),
    reasoningTokens: numberOrNull(payload.reasoningTokens),
    cost: numberOrNull(payload.cost),
    currency: stringOrNull(payload.currency),
    costSource: stringOrNull(payload.costSource),
  };
}

/** `undefined` and `null` both mean "absent" and are equal to each other, but never equal to `0` or `""`. */
function sameOrBothAbsent(a: unknown, b: unknown): boolean {
  const normalize = (value: unknown): unknown => (value === undefined || value === null ? null : value);
  return normalize(a) === normalize(b);
}

/** True when every usage-relevant field of `a` and `b` is equal under `sameOrBothAbsent`. */
export function fingerprintFieldsMatch(a: UsageFingerprintFields, b: UsageFingerprintFields): boolean {
  return (Object.keys(a) as Array<keyof UsageFingerprintFields>).every((key) => sameOrBothAbsent(a[key], b[key]));
}
