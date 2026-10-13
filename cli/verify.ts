import fs from 'node:fs';
import type { VerifyCommand } from './args.ts';
import { resolveConnection } from './connection.ts';
import type { VerifyReport, CheckpointResult } from '../server/audit/verify.ts';

/**
 * `agent-viewer verify` (issue #388, second sub-issue of the chain-verification theme started by #106/#387).
 * Online mode calls `GET /api/v1/audit/verify`; `--db <file>` runs the same verifier (`server/audit/verify.ts`,
 * `verifyChain`) directly against a local SQLite file, no server involved. `--checkpoints <file>` additionally
 * cross-checks an exported checkpoint file against whichever chain was just verified, filling
 * `VerifyReport.exported`; the check is lighter than the main walk (issue #388's own scope: proving the file's
 * checkpoints are genuine and match the live chain one `seq` at a time, via `GET /api/v1/audit/entries/:seq` in
 * online mode, never a full re-walk over the network).
 *
 * Exit codes: `0` clean, `1` integrity failure, `2` usage error, `3` could not verify (unreachable, `401`,
 * memory storage, unreadable file).
 */

function readPemOrFingerprint(path: string): string {
  return fs.readFileSync(path, 'utf8');
}

function printReport(report: VerifyReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report));
    return;
  }
  console.log(`storage: ${report.storage}`);
  console.log(`instance: ${report.instanceId}`);
  console.log(`coverage: seq ${report.coverage.fromSeq}..${report.coverage.toSeq} (scope: ${report.coverage.scope})`);
  console.log(`chain: ${report.chain.checked} checked, head seq ${report.chain.headSeq ?? 'none'}, ${report.chain.unchained} unchained`);
  if (report.firstBreak) {
    console.error(`FIRST BREAK: ${report.firstBreak.kind} at seq ${report.firstBreak.seq}: ${report.firstBreak.message}`);
  } else {
    console.log('chain: ok, no break found');
  }
  console.log(`checkpoints: ${report.checkpoints.checked} checked, ${report.checkpoints.valid} valid, key trust: ${report.keyTrust}`);
  if (report.checkpoints.firstFailure) {
    console.error(
      `FIRST CHECKPOINT FAILURE: ${report.checkpoints.firstFailure.kind} at checkpoint ${report.checkpoints.firstFailure.checkpoint} (seq ${report.checkpoints.firstFailure.seq}): ${report.checkpoints.firstFailure.message}`
    );
  }
  if (report.exported) {
    console.log(`exported checkpoints: ${report.exported.checked} checked, ${report.exported.valid} valid`);
    if (report.exported.firstFailure) {
      console.error(
        `FIRST EXPORTED-CHECKPOINT FAILURE: ${report.exported.firstFailure.kind} at checkpoint ${report.exported.firstFailure.checkpoint} (seq ${report.exported.firstFailure.seq}): ${report.exported.firstFailure.message}`
      );
    }
  }
  for (const warning of report.warnings) console.error(`warning (${warning.code}): ${warning.message}`);
  console.log(`verdict: ${report.ok && (!report.exported || report.exported.firstFailure === null) ? 'ok' : 'failed'}`);
}

function isClean(report: VerifyReport): boolean {
  return report.ok && (!report.exported || report.exported.firstFailure === null);
}

async function crossCheckOnline(
  report: VerifyReport,
  command: VerifyCommand,
  connection: { url: string; token?: string }
): Promise<CheckpointResult> {
  const { crossCheckExportedCheckpoints, parseExportedCheckpointsFile } = await import('../server/audit/verify.ts');
  const text = fs.readFileSync(command.checkpoints!, 'utf8');
  const checkpoints = parseExportedCheckpointsFile(text);

  let trustedKeyPem: string | undefined;
  if (command.publicKey) trustedKeyPem = readPemOrFingerprint(command.publicKey);
  let knownKeys: Map<string, string> | undefined;
  if (!trustedKeyPem) {
    const keysResponse = await fetch(`${connection.url}/api/v1/audit/keys`, {
      headers: connection.token ? { Authorization: `Bearer ${connection.token}` } : {},
    });
    if (keysResponse.ok) {
      const body = (await keysResponse.json()) as { keys: Array<{ keyId: string; publicKeyPem: string }> };
      knownKeys = new Map(body.keys.map((k) => [k.keyId, k.publicKeyPem]));
    }
  }

  return crossCheckExportedCheckpoints(checkpoints, {
    trustedKeyPem,
    knownKeys,
    getHashAtSeq: async (seq) => {
      const response = await fetch(`${connection.url}/api/v1/audit/entries/${seq}`, {
        headers: connection.token ? { Authorization: `Bearer ${connection.token}` } : {},
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { entryHash: string };
      return body.entryHash;
    },
  });
}

/** Fetches every checkpoint the server has (paged, `format=jsonl`) and re-verifies all of them against
 * `trustedKeyPem` via `crossCheckExportedCheckpoints`, using `GET /api/v1/audit/entries/:seq` for the head-hash
 * cross-check exactly like `--checkpoints <file>` does. Used only when `--public-key` is given online, since the
 * server's own `GET /api/v1/audit/verify` always trusts its own `audit_keys` table (`server-reported`). */
async function crossCheckLiveCheckpointsAgainstPinnedKey(
  connection: { url: string; token?: string },
  trustedKeyPem: string
): Promise<CheckpointResult> {
  const { crossCheckExportedCheckpoints } = await import('../server/audit/verify.ts');
  const { parseCheckpointBody } = await import('../server/audit/checkpointFormat.ts');
  const headers: Record<string, string> = connection.token ? { Authorization: `Bearer ${connection.token}` } : {};
  const checkpoints: Array<{ body: ReturnType<typeof parseCheckpointBody>; digest: string; signature: string }> = [];
  let afterSeq = 0;
  while (true) {
    const response = await fetch(`${connection.url}/api/v1/audit/checkpoints?afterSeq=${afterSeq}&limit=1000`, { headers });
    if (!response.ok) break;
    const body = (await response.json()) as { checkpoints: Array<{ body: unknown; digest: string; signature: string }>; nextAfterSeq: number | null };
    for (const raw of body.checkpoints) checkpoints.push({ body: parseCheckpointBody(raw.body), digest: raw.digest, signature: raw.signature });
    if (body.nextAfterSeq === null) break;
    afterSeq = body.nextAfterSeq;
  }
  const valid = checkpoints.filter((c): c is { body: NonNullable<typeof c.body>; digest: string; signature: string } => c.body !== null);
  return crossCheckExportedCheckpoints(valid, {
    trustedKeyPem,
    getHashAtSeq: async (seq) => {
      const response = await fetch(`${connection.url}/api/v1/audit/entries/${seq}`, { headers });
      if (!response.ok) return null;
      const body = (await response.json()) as { entryHash: string };
      return body.entryHash;
    },
  });
}

async function crossCheckOffline(command: VerifyCommand): Promise<CheckpointResult> {
  const { crossCheckExportedCheckpoints, parseExportedCheckpointsFile } = await import('../server/audit/verify.ts');
  const { DatabaseSync } = await import('node:sqlite');
  const text = fs.readFileSync(command.checkpoints!, 'utf8');
  const checkpoints = parseExportedCheckpointsFile(text);
  const trustedKeyPem = command.publicKey ? readPemOrFingerprint(command.publicKey) : undefined;

  const db = new DatabaseSync(command.db!, { readOnly: true });
  try {
    let knownKeys: Map<string, string> | undefined;
    if (!trustedKeyPem) {
      const hasKeysTable = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_keys'").get() as { name: string } | undefined) !== undefined;
      if (hasKeysTable) {
        const rows = db.prepare('SELECT key_id, public_key_pem FROM audit_keys').all() as Array<{ key_id: string; public_key_pem: string }>;
        knownKeys = new Map(rows.map((r) => [r.key_id, r.public_key_pem]));
      }
    }
    return await crossCheckExportedCheckpoints(checkpoints, {
      trustedKeyPem,
      knownKeys,
      getHashAtSeq: async (seq) => {
        const row = db.prepare('SELECT hash FROM events WHERE seq = ? AND hash IS NOT NULL').get(seq) as { hash: string } | undefined;
        return row?.hash ?? null;
      },
    });
  } finally {
    db.close();
  }
}

export async function runVerify(command: VerifyCommand): Promise<number> {
  if (command.db && (command.url || command.token)) {
    console.error('agent-viewer: --db cannot be combined with --url or --token (pick one mode)');
    return 2;
  }

  let trustedKeyPem: string | undefined;
  if (command.publicKey) {
    try {
      trustedKeyPem = readPemOrFingerprint(command.publicKey);
    } catch (error) {
      console.error(`agent-viewer: could not read --public-key: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  let report: VerifyReport;
  let connection: { url: string; token?: string } | undefined;
  if (command.db) {
    const { verifyChain } = await import('../server/audit/verify.ts');
    try {
      report = await verifyChain({ dbPath: command.db, scope: command.scope, trustedKeyPem });
    } catch (error) {
      console.error(`agent-viewer: could not verify ${command.db}: ${error instanceof Error ? error.message : String(error)}`);
      return 3;
    }
  } else {
    connection = resolveConnection(command);
    const params = new URLSearchParams();
    if (command.scope) params.set('scope', command.scope);
    const query = params.toString();
    let response: Response;
    try {
      response = await fetch(`${connection.url}/api/v1/audit/verify${query ? `?${query}` : ''}`, {
        headers: connection.token ? { Authorization: `Bearer ${connection.token}` } : {},
      });
    } catch (error) {
      console.error(`agent-viewer: could not reach ${connection.url}: ${error instanceof Error ? error.message : String(error)}`);
      return 3;
    }
    if (!response.ok) {
      console.error(`agent-viewer: verify failed: server answered ${response.status}`);
      return 3;
    }
    const body = (await response.json()) as VerifyReport | { enabled: false; reason: string; tamperEvident: false };
    if ('enabled' in body && body.enabled === false) {
      // Memory storage (or a schema predating the hash chain): GET /api/v1/audit/verify answers the same
      // disabled shape GET /api/v1/audit/chain uses, not an error status, so there is nothing to verify at all.
      if (command.json) console.log(JSON.stringify(body));
      else console.error(`agent-viewer: nothing to verify: ${body.reason} (tamperEvident: ${body.tamperEvident})`);
      return 3;
    }
    // Excluded above: `body` can only be a real VerifyReport here (VerifyReport itself never has `enabled`).
    report = body as VerifyReport;
    if (trustedKeyPem) {
      // GET /api/v1/audit/verify never accepts --public-key (it never sees the file, and the route is shared
      // with every other credential): pin here instead, by re-checking every one of the server's own checkpoints
      // against the pinned key, reusing the same cross-check logic --checkpoints uses against a local file, with
      // the server's live checkpoint list standing in for the file.
      const pinnedCheckpoints = await crossCheckLiveCheckpointsAgainstPinnedKey(connection, trustedKeyPem);
      report = {
        ...report,
        keyTrust: 'pinned',
        checkpoints: pinnedCheckpoints,
        // report.ok was computed server-side against the server-reported checkpoint result; it must be
        // recomputed now that checkpoints was just replaced with the pinned-key cross-check's own result.
        ok: report.firstBreak === null && pinnedCheckpoints.firstFailure === null,
      };
    }
  }

  if (command.checkpoints) {
    try {
      report.exported = command.db ? await crossCheckOffline(command) : await crossCheckOnline(report, command, connection!);
    } catch (error) {
      console.error(`agent-viewer: could not read --checkpoints: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  printReport(report, command.json);
  if (!isClean(report)) return 1;
  return 0;
}
