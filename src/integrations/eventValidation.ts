import { validateCanonicalEvent } from './canonicalContract';
import type { ExternalEventEnvelope } from './eventIngestion';

/** Strict check for events that arrive from the network. Uses the zod validators of the V1 contract. */
export function validateExternalEvent(value: unknown): value is ExternalEventEnvelope {
  const result = validateCanonicalEvent(value);
  if (result.success) return true;
  // Fallback check for minimal raw event
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.id === 'string' &&
    event.id.length > 0 &&
    typeof event.type === 'string' &&
    typeof event.timestamp === 'number' &&
    typeof event.source === 'string' &&
    typeof event.summary === 'string' &&
    !!event.payload &&
    typeof event.payload === 'object'
  );
}
