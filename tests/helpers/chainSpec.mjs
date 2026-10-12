// Independent recompute helper for the issue #105 hash-chain format: its own SHA-256 call and its own
// canonicalization, written from the spec in `docs/audit-chain.md` / the issue text rather than imported from
// `server/chain.ts`, so a test using this can never pass merely because the module under test agrees with
// itself. Reused by `tests/chain.test.mjs`, `tests/event-store.test.mjs` and `tests/chain-concurrency.test.mjs`.
import crypto from 'node:crypto';

function hasLoneSurrogate(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function specSerialize(value) {
  if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError('not representable');
  if (typeof value === 'bigint') throw new TypeError('not representable');
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('not representable');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) throw new TypeError('not representable');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : specSerialize(item))).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${specSerialize(value[key])}`).join(',')}}`;
}

export function specCanonicalize(value) {
  if (value === undefined) throw new TypeError('not representable');
  return specSerialize(value);
}

export function specSha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function specEventHash({ seq, prevHash, receivedAt, submitterId, event }) {
  return specSha256Hex(specCanonicalize(['agent-viewer/chain/v1', seq, prevHash, receivedAt, submitterId, event]));
}

export function specCheckpointHash({ kind, prevHash, unchainedCount, unchainedDigest, firstEventId, lastEventId, createdAt }) {
  return specSha256Hex(
    specCanonicalize(['agent-viewer/checkpoint/v1', kind, prevHash, unchainedCount, unchainedDigest, firstEventId, lastEventId, createdAt])
  );
}
