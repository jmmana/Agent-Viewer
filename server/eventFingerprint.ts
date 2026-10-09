import crypto from 'node:crypto';
import type { CanonicalEvent } from '../src/integrations/canonicalContract';

/** Prefix of every fingerprint, so the algorithm can change later without ambiguity. */
export const FINGERPRINT_PREFIX = 'sha256:';

/** True for values that `JSON.stringify` leaves out of an object and writes as `null` inside an array. */
function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

function serialize(value: unknown, ancestors: Set<object>): string {
  // Same as JSON.stringify: an object may define how it is serialized (Date does).
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    value = (value as { toJSON: () => unknown }).toJSON();
  }

  if (value === null || isOmitted(value)) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      // JSON rules: 1 and 1.0 are the same text, -0 is written as 0, NaN and Infinity as null.
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      throw new TypeError('canonicalJson cannot serialize a BigInt');
    default:
      break;
  }

  const object = value as object;
  if (ancestors.has(object)) throw new TypeError('canonicalJson cannot serialize a circular structure');
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      // Arrays keep their order; a missing or undefined item is written as null.
      const items: string[] = [];
      for (let index = 0; index < object.length; index++) {
        items.push(serialize(object[index], ancestors));
      }
      return `[${items.join(',')}]`;
    }

    // Keys are sorted by UTF-16 code units (the default sort). The text is built straight from the own keys,
    // so a key named "__proto__" is hashed like any other key instead of being swallowed by an assignment.
    const record = object as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const member = record[key];
      if (isOmitted(member)) continue;
      members.push(`${JSON.stringify(key)}:${serialize(member, ancestors)}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(object);
  }
}

/**
 * Deterministic JSON: object keys sorted recursively (UTF-16 code unit order), undefined object values dropped,
 * undefined array items written as null (same as JSON.stringify), arrays keep their order.
 * `canonicalJson(JSON.parse(JSON.stringify(value)))` equals `canonicalJson(value)` for any JSON-compatible value.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

/** "sha256:<64 lowercase hex>" over canonicalJson(event), where event is the CanonicalEvent exactly as the store persists it. */
export function eventFingerprint(event: CanonicalEvent): string {
  return `${FINGERPRINT_PREFIX}${crypto.createHash('sha256').update(canonicalJson(event), 'utf8').digest('hex')}`;
}
