import crypto from 'node:crypto';
import { canonicalize } from '../chain';

/**
 * Signed checkpoint wire format (issue #387). Pure: no SQLite, no Express, no env. Shared by the writer
 * (`server/audit/checkpoints.ts`) and the verifier (`server/audit/verify.ts`), and meant to be reused unchanged by
 * the offline CLI (#388). Like `server/chain.ts`, this is a permanent, versioned format: changing the signed bytes
 * needs a new domain line (`v2`), never a silent edit. `server/audit/checkpoint.schema.json` describes the body.
 *
 * Signed bytes = UTF-8 of `"agent-viewer/checkpoint/v1\n" + canonicalize(body)` (RFC 8785, `canonicalize` from
 * `server/chain.ts`). The leading line is a domain separator: these bytes can never be confused with an event
 * hash preimage or with #105's genesis/resume `checkpointHash` preimage (both of which are canonical JSON arrays
 * starting with `[`). The checkpoint digest is the lowercase hex SHA-256 of exactly those bytes, and the next
 * checkpoint commits to it as `prevCheckpointDigest`, so checkpoints form their own chain on top of the event
 * chain. The signature is pure Ed25519 (no pre-hash) over the same bytes, base64-encoded.
 */

export const CHECKPOINT_SIGNED_DOMAIN_LINE = 'agent-viewer/checkpoint/v1\n';
export const CHECKPOINT_FORMAT_VERSION = 1;

export const CHECKPOINT_REASONS = ['events', 'interval', 'shutdown', 'manual', 'key_change'] as const;
export type CheckpointReason = (typeof CHECKPOINT_REASONS)[number];

export interface CheckpointBody {
  version: 1;
  /** `audit_meta.instance_id` of the database this checkpoint was signed for. */
  instanceId: string;
  /** 1-based, contiguous position of this checkpoint in the checkpoint chain. */
  checkpointSeq: number;
  /** `events.seq` of the newest chained row covered. */
  headSeq: number;
  /** That row's `events.hash`. */
  headHash: string;
  /** Number of chained rows with `seq <= headSeq` at signing time. */
  chainedCount: number;
  createdAt: number;
  reason: CheckpointReason;
  /** `keyIdFor()` of the signing public key. */
  keyId: string;
  /** Digest of checkpoint `checkpointSeq - 1`, or `null` for the first one. */
  prevCheckpointDigest: string | null;
}

export interface SignedCheckpoint {
  body: CheckpointBody;
  digest: string;
  /** Base64 Ed25519 signature over `checkpointSignedBytes(body)`. */
  signature: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function checkpointSignedBytes(body: CheckpointBody): Buffer {
  return Buffer.from(CHECKPOINT_SIGNED_DOMAIN_LINE + canonicalize(body), 'utf8');
}

export function checkpointDigest(body: CheckpointBody): string {
  return crypto.createHash('sha256').update(checkpointSignedBytes(body)).digest('hex');
}

/** `ed25519:` + lowercase hex SHA-256 of the public key's SPKI DER encoding. Stable across PEM formatting. */
export function keyIdFor(publicKey: crypto.KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return `ed25519:${crypto.createHash('sha256').update(der).digest('hex')}`;
}

export function signCheckpoint(body: CheckpointBody, privateKey: crypto.KeyObject): SignedCheckpoint {
  const bytes = checkpointSignedBytes(body);
  return {
    body,
    digest: crypto.createHash('sha256').update(bytes).digest('hex'),
    signature: crypto.sign(null, bytes, privateKey).toString('base64'),
  };
}

/** `false` for a malformed signature, a malformed key or a non-Ed25519 key, never throws. */
export function verifyCheckpointSignature(body: CheckpointBody, signatureB64: string, publicKeyPem: string): boolean {
  try {
    const publicKey = crypto.createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    const signature = Buffer.from(signatureB64, 'base64');
    if (signature.length !== 64 || signature.toString('base64') !== signatureB64) return false;
    return crypto.verify(null, checkpointSignedBytes(body), publicKey, signature);
  } catch {
    return false;
  }
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Strict shape check, mirroring `checkpoint.schema.json` (no extra keys, every field present and typed). Returns
 * the typed body or `null`. A verifier must call this before trusting any field, since an unknown extra key
 * would otherwise be signed over but silently ignored.
 */
export function parseCheckpointBody(value: unknown): CheckpointBody | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort();
  const expected = ['chainedCount', 'checkpointSeq', 'createdAt', 'headHash', 'headSeq', 'instanceId', 'keyId', 'prevCheckpointDigest', 'reason', 'version'];
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) return null;
  if (v.version !== CHECKPOINT_FORMAT_VERSION) return null;
  if (typeof v.instanceId !== 'string' || v.instanceId.length === 0) return null;
  if (!isNonNegativeInt(v.checkpointSeq) || v.checkpointSeq < 1) return null;
  if (!isNonNegativeInt(v.headSeq) || v.headSeq < 1) return null;
  if (typeof v.headHash !== 'string' || !HEX64.test(v.headHash)) return null;
  if (!isNonNegativeInt(v.chainedCount) || v.chainedCount < 1) return null;
  if (!isNonNegativeInt(v.createdAt)) return null;
  if (typeof v.reason !== 'string' || !(CHECKPOINT_REASONS as readonly string[]).includes(v.reason)) return null;
  if (typeof v.keyId !== 'string' || !/^ed25519:[0-9a-f]{64}$/.test(v.keyId)) return null;
  if (v.prevCheckpointDigest !== null && (typeof v.prevCheckpointDigest !== 'string' || !HEX64.test(v.prevCheckpointDigest))) return null;
  if ((v.checkpointSeq === 1) !== (v.prevCheckpointDigest === null)) return null;
  return v as unknown as CheckpointBody;
}
