import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { checkpointDigest, keyIdFor, parseCheckpointBody, verifyCheckpointSignature } from './checkpointFormat';
import type { CheckpointFailure, CheckpointFailureKind, CheckpointResult } from './verify';

/**
 * Signed checkpoint verification (issue #387), called by `verifyChain` (`server/audit/verify.ts`) on the same
 * read-only connection. Every checkpoint is checked, in `checkpointSeq` order; `firstFailure` is the lowest one
 * that fails. Per checkpoint, in this order (the first failing check is the one reported):
 *
 * - `signature_invalid`: `body_json` is not a valid v1 body, the signature does not verify, or the stored digest
 *   column disagrees with the digest recomputed from the body.
 * - `key_unknown`: no `audit_keys` row has this `keyId` with a public key that actually hashes to it.
 * - `checkpoint_missing`: the checkpoint numbering skips (a checkpoint row was deleted from the middle).
 * - `checkpoint_link_broken`: `prevCheckpointDigest` is not the previous checkpoint's recomputed digest.
 * - `instance_mismatch`: signed for another database (`audit_meta.instance_id`).
 * - `seq_beyond_head`: covers a `headSeq` past the current chain head (rows removed from the tail).
 * - `head_mismatch`: the chained row at `headSeq` is missing or its hash differs from the signed `headHash`
 *   (this is what catches a *consistent* rewrite of the chain up to a signed checkpoint).
 * - `count_mismatch`: the number of chained rows up to `headSeq` differs from the signed `chainedCount`.
 *
 * Trust: public keys come from the same database (`keyTrust: 'server-reported'`). An attacker with file access
 * *and* the private key, or who replaces `audit_keys` and re-signs every checkpoint with a key of their own, is
 * not detected here; pinning a known public key is #388's job.
 */

export function hasSignedCheckpointTables(db: DatabaseSync): boolean {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('audit_checkpoints', 'audit_keys')")
    .all() as Array<{ name: string }>;
  return rows.length === 2;
}

interface Row {
  seq: number;
  digest: string;
  body_json: string;
  signature: string;
}

/**
 * `trustedKeyPem`, PKCS#8/SPKI PEM of a public key (issue #388, `agent-viewer verify --public-key`): when given,
 * only *that* key is ever trusted, regardless of what `audit_keys` records. A checkpoint signed by any other key,
 * server-reported key rotation included, reports `key_unknown` exactly as an actually-unknown key would: pinning
 * means the auditor's own copy decides who is trusted, not the database being verified. The caller (`verifyChain`)
 * sets `VerifyReport.keyTrust` to `'pinned'` whenever this parameter is passed, independent of the outcome.
 */
export function verifySignedCheckpoints(
  db: DatabaseSync,
  instanceId: string,
  chainHeadSeq: number | null,
  trustedKeyPem?: string
): CheckpointResult {
  const result: CheckpointResult = { checked: 0, valid: 0, firstFailure: null };
  if (!hasSignedCheckpointTables(db)) return result;

  const keys = new Map<string, string>();
  if (trustedKeyPem !== undefined) {
    try {
      const keyId = keyIdFor(crypto.createPublicKey(trustedKeyPem));
      keys.set(keyId, trustedKeyPem);
    } catch {
      // An unparseable --public-key file trusts nothing: every checkpoint reports key_unknown, which is the
      // correct outcome (the caller cannot verify against a key it cannot even parse).
    }
  } else {
    const keyRows = db.prepare('SELECT key_id, public_key_pem FROM audit_keys').all() as Array<{ key_id: string; public_key_pem: string }>;
    for (const row of keyRows) {
      try {
        if (keyIdFor(crypto.createPublicKey(row.public_key_pem)) === row.key_id) keys.set(row.key_id, row.public_key_pem);
      } catch {
        // An unparseable key row is simply not a usable key: checkpoints signed by it report `key_unknown`.
      }
    }
  }

  const page = db.prepare('SELECT seq, digest, body_json, signature FROM audit_checkpoints WHERE seq > ? ORDER BY seq LIMIT 1000');
  const headRow = db.prepare('SELECT hash FROM events WHERE seq = ? AND hash IS NOT NULL');
  const countRange = db.prepare('SELECT COUNT(*) AS c FROM events WHERE hash IS NOT NULL AND seq > ? AND seq <= ?');

  let cursor = 0;
  let expectedSeq = 1;
  let prevDigest: string | null = null;
  let prevHeadSeq = 0;
  let runningCount = 0;

  const fail = (kind: CheckpointFailureKind, checkpoint: number, seq: number, message: string): false => {
    if (!result.firstFailure) result.firstFailure = { kind, checkpoint, seq, message } satisfies CheckpointFailure;
    return false;
  };

  while (true) {
    const rows = page.all(cursor) as unknown as Row[];
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = Number(row.seq);
      result.checked++;
      const ok = ((): boolean => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.body_json);
        } catch {
          parsed = null;
        }
        const body = parseCheckpointBody(parsed);
        if (!body || body.checkpointSeq !== cursor) {
          prevDigest = null;
          return fail('signature_invalid', cursor, 0, `Checkpoint ${cursor} has a malformed signed body.`);
        }
        const digest = checkpointDigest(body);
        const linkPrev = prevDigest;
        const linkExpectedSeq = expectedSeq;
        // The next checkpoint links to *this* one's recomputed digest whatever happens below, so one failure is
        // reported once instead of cascading into a link failure on every later checkpoint.
        prevDigest = digest;
        expectedSeq = cursor + 1;

        const pem = keys.get(body.keyId);
        if (!pem) return fail('key_unknown', cursor, body.headSeq, `Checkpoint ${cursor} is signed by unknown key ${body.keyId}.`);
        if (!verifyCheckpointSignature(body, row.signature, pem)) {
          return fail('signature_invalid', cursor, body.headSeq, `Checkpoint ${cursor} has an invalid signature.`);
        }
        if (row.digest !== digest) {
          return fail('signature_invalid', cursor, body.headSeq, `Checkpoint ${cursor}'s stored digest does not match its signed body.`);
        }
        if (cursor !== linkExpectedSeq) {
          return fail('checkpoint_missing', linkExpectedSeq, body.headSeq, `Checkpoint ${linkExpectedSeq} is missing (found ${cursor} next).`);
        }
        if (body.prevCheckpointDigest !== linkPrev) {
          return fail('checkpoint_link_broken', cursor, body.headSeq, `Checkpoint ${cursor} does not link to the previous checkpoint's digest.`);
        }
        if (body.instanceId !== instanceId) {
          return fail('instance_mismatch', cursor, body.headSeq, `Checkpoint ${cursor} was signed for another database instance.`);
        }
        if (chainHeadSeq === null || body.headSeq > chainHeadSeq) {
          return fail('seq_beyond_head', cursor, body.headSeq, `Checkpoint ${cursor} covers seq ${body.headSeq}, past the current chain head.`);
        }
        const stored = headRow.get(body.headSeq) as { hash: string } | undefined;
        if (!stored || stored.hash !== body.headHash) {
          return fail('head_mismatch', cursor, body.headSeq, `The chained row at seq ${body.headSeq} does not match checkpoint ${cursor}'s signed head hash.`);
        }
        if (body.headSeq > prevHeadSeq) {
          runningCount += Number((countRange.get(prevHeadSeq, body.headSeq) as { c: number }).c);
          prevHeadSeq = body.headSeq;
        }
        if (runningCount !== body.chainedCount) {
          return fail('count_mismatch', cursor, body.headSeq, `Checkpoint ${cursor} signed ${body.chainedCount} chained rows up to seq ${body.headSeq}; ${runningCount} exist.`);
        }
        return true;
      })();
      if (ok) result.valid++;
    }
  }
  return result;
}
