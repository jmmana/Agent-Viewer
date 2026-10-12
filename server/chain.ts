import crypto from 'node:crypto';

/**
 * Pure hash-chain primitives for the 0.8.0 formal-audit theme (issue #105). No Express or SQLite imports, and
 * never bundled into `dist-lib`: the embedded library component never receives, computes or displays chain
 * data. This module is a permanent, versioned format; changing the preimage of `eventHash`/`checkpointHash` is a
 * breaking change and needs a new domain tag (the `v1` suffix below), never a silent edit.
 */

/** Domain tag mixed into every event hash, so a hash can never be replayed as a checkpoint hash or vice versa. */
export const EVENT_HASH_DOMAIN = 'agent-viewer/chain/v1';
/** Domain tag mixed into every checkpoint digest (issue #105's "unchained" digest, not #106's signed checkpoint). */
export const CHECKPOINT_HASH_DOMAIN = 'agent-viewer/checkpoint/v1';

/** SHA-256 of the empty string, lowercase hex: the `unchained_digest` of a fresh database's genesis checkpoint. */
export const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** True when `value` contains a UTF-16 code unit in the surrogate range that is not part of a valid pair.
 * Converting such a string to UTF-8 bytes is lossy (Node replaces it with U+FFFD) and language-dependent, so
 * `canonicalize` rejects it outright rather than letting two verifiers silently disagree on its bytes. */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // `charCodeAt` past the end of the string returns `NaN`, and every `<`/`>` comparison against `NaN` is
      // `false`, so a lone high surrogate at the very end of the string needs its own explicit check.
      const next = value.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function serializeString(value: string): string {
  if (hasLoneSurrogate(value)) {
    throw new TypeError('canonicalize: string contains an unpaired UTF-16 surrogate, which has no stable UTF-8 encoding');
  }
  return JSON.stringify(value);
}

/** `JSON.stringify` itself treats `undefined` this way: dropped as an object member, written as `null` as an
 * array element, and refused (returns the `undefined` value, not a string) at the top level. `canonicalize`
 * mirrors that rather than throwing on every `undefined`, because the common "optional field absent" idiom
 * throughout this codebase is a present key whose value is `undefined`, exactly as `JSON.parse` would have left
 * it missing; only a bare top-level `undefined` (nothing to canonicalize at all) is refused outright. */
function serialize(value: unknown, ancestors: Set<object>): string {
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`canonicalize: ${typeof value} is not representable in JSON`);
  }
  if (typeof value === 'bigint') throw new TypeError('canonicalize: BigInt is not representable in JSON');
  if (value === null) return 'null';

  switch (typeof value) {
    case 'number': {
      if (!Number.isFinite(value)) throw new TypeError('canonicalize: NaN and Infinity are not representable in JSON');
      // ES6 number-to-string serialization (JSON.stringify delegates to Number#toString for the digits), and
      // -0 already renders as "0" under JSON.stringify, matching JCS.
      return JSON.stringify(value);
    }
    case 'string':
      return serializeString(value);
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      break;
  }

  const object = value as object;
  if (ancestors.has(object)) throw new TypeError('canonicalize: circular structure is not representable in JSON');
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      const items = object.map((item) => (item === undefined ? 'null' : serialize(item, ancestors)));
      return `[${items.join(',')}]`;
    }
    // Keys sorted by UTF-16 code unit (the default Array#sort order for strings), per RFC 8785. A member whose
    // value is `undefined` is dropped, matching `JSON.stringify`.
    const record = object as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${serializeString(key)}:${serialize(record[key], ancestors)}`);
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(object);
  }
}

/**
 * JSON Canonicalization Scheme (RFC 8785): object keys sorted by UTF-16 code unit at every level, no whitespace,
 * ES6 number serialization. A bare top-level `undefined`, `NaN`, `Infinity`, a function, a symbol, a `BigInt`
 * and a lone surrogate all throw, since every real input is already-parsed JSON (or shaped like it) and any of
 * those would be a bug, not data; `undefined` nested inside an object or array is instead dropped/nulled exactly
 * as `JSON.stringify` already does, since "this optional field is absent" is a present key set to `undefined`
 * throughout this codebase, not a bug.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) throw new TypeError('canonicalize: undefined is not representable in JSON');
  return serialize(value, new Set());
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `text`. */
export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface EventHashInput {
  seq: number;
  prevHash: string;
  receivedAt: number;
  submitterId: string;
  event: unknown;
}

/**
 * The hash committed by one chained event row. `event` must be exactly the parsed, stored `event_json`: the
 * hash never re-derives or normalizes it. Order is a JSON array, not string concatenation, so no field boundary
 * is ever ambiguous.
 */
export function eventHash(input: EventHashInput): string {
  return sha256Hex(
    canonicalize([EVENT_HASH_DOMAIN, input.seq, input.prevHash, input.receivedAt, input.submitterId, input.event])
  );
}

export interface CheckpointHashInput {
  kind: 'genesis' | 'resume';
  prevHash: string | null;
  unchainedCount: number;
  unchainedDigest: string;
  firstEventId: string | null;
  lastEventId: string | null;
  createdAt: number;
}

/** The hash of one `chain_checkpoints` row (issue #105). `serverVersion` is informational and is not hashed. */
export function checkpointHash(input: CheckpointHashInput): string {
  return sha256Hex(
    canonicalize([
      CHECKPOINT_HASH_DOMAIN,
      input.kind,
      input.prevHash,
      input.unchainedCount,
      input.unchainedDigest,
      input.firstEventId,
      input.lastEventId,
      input.createdAt,
    ])
  );
}

/**
 * The running digest committed by a genesis or resume checkpoint over the rows it covers (issue #105 section 3):
 * SHA-256 of the UTF-8 bytes of `"<id>\n<eventDigest>\n"` for every covered row, concatenated in ascending `id`
 * order (default BINARY collation), where `eventDigest = sha256Hex(canonicalize(event))`. Call `update()` once
 * per covered row, in order, then `digest()`; an empty input (a fresh database) yields `EMPTY_DIGEST`.
 */
export class UnchainedDigest {
  private readonly hash = crypto.createHash('sha256');
  private count = 0;

  update(eventId: string, event: unknown): void {
    const eventDigest = sha256Hex(canonicalize(event));
    this.hash.update(`${eventId}\n${eventDigest}\n`, 'utf8');
    this.count++;
  }

  digest(): string {
    return this.count === 0 ? EMPTY_DIGEST : this.hash.digest('hex');
  }
}
