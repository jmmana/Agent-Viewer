import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AuditCommand } from './args.ts';
import { resolveConnection } from './connection.ts';
import { verifyScriptPath } from './packageInfo.ts';

/**
 * `agent-viewer audit export`/`agent-viewer audit verify` (issue #402), built on `GET /api/v1/audit/bundle`
 * (#400) and `scripts/verify-audit-bundle.mjs` (#401). `export` is an ordinary authenticated download, same
 * URL/token resolution as `send`/`keys`; `verify` never talks to a server at all, it runs the standalone script
 * as a child process against a local file and returns its exit code unchanged, so this module is never a second
 * implementation of any check the script already does.
 */

function describeExportError(status: number, json: unknown): string {
  const body = json as { error?: string; message?: string } | null;
  if (status === 401) return 'the server wants a valid token: pass --token, or set AGENT_VIEWER_API_TOKEN';
  if (status === 403) return body?.message || 'this credential lacks the "audit" scope this route requires';
  if (status === 409) return body?.message || 'audit bundles need AGENT_VIEWER_STORAGE=sqlite with the hash chain enabled';
  if (status === 400) return body?.message || 'invalid range';
  if (status === 503) return body?.message || 'too many audit bundle exports are already running; try again shortly';
  return body?.message || body?.error || `server answered ${status}`;
}

async function runExport(command: AuditCommand): Promise<number> {
  const connection = resolveConnection(command);
  const params = new URLSearchParams();
  if (command.fromSeq !== undefined) params.set('fromSeq', String(command.fromSeq));
  if (command.toSeq !== undefined) params.set('toSeq', String(command.toSeq));
  if (command.gzip) params.set('gzip', '1');
  const query = params.toString();
  const url = `${connection.url}/api/v1/audit/bundle${query ? `?${query}` : ''}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: connection.token ? { Authorization: `Bearer ${connection.token}` } : {},
    });
  } catch (error) {
    console.error(`agent-viewer: could not reach ${connection.url}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (!response.ok || !response.body) {
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // Not JSON: keep the status only.
    }
    console.error(`agent-viewer: audit export failed: ${describeExportError(response.status, json)}`);
    return 1;
  }

  const out = path.resolve(command.out!);
  // Written to a temp name next to --out and renamed only after a clean response end, so a failed or interrupted
  // export never leaves a file that looks complete at --out itself (the issue's own requirement).
  const tempFile = `${out}.tmp-${process.pid}`;
  let fileHandle: fs.WriteStream | undefined;
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fileHandle = fs.createWriteStream(tempFile);
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise<void>((resolve, reject) => {
        fileHandle!.write(value, (error) => (error ? reject(error) : resolve()));
      });
    }
    await new Promise<void>((resolve, reject) => {
      fileHandle!.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    try {
      fileHandle?.destroy();
    } catch {
      // Already gone.
    }
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Never existed, or already removed.
    }
    console.error(`agent-viewer: audit export failed mid-stream: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  fs.renameSync(tempFile, out);
  console.error(`agent-viewer: wrote ${out}`);
  return 0;
}

function runVerify(command: AuditCommand): number {
  const args = [command.file!];
  if (command.trustedKey) args.push('--trusted-key', command.trustedKey);
  if (command.expectCheckpoint) args.push('--expect-checkpoint', command.expectCheckpoint);
  if (command.requireComplete) args.push('--require-complete');
  if (command.json) args.push('--json');

  const scriptPath = verifyScriptPath();
  const result = spawnSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit' });
  if (result.error) {
    console.error(`agent-viewer: could not run the verifier at ${scriptPath}: ${result.error.message}`);
    return 2;
  }
  // The script always exits with one of 0/1/2/3 (see scripts/verify-audit-bundle.mjs); a null status means it
  // was killed by a signal, which this CLI reports the same way an uncaught failure would be.
  return result.status ?? 2;
}

export async function runAudit(command: AuditCommand): Promise<number> {
  if (command.action === 'export') return runExport(command);
  return runVerify(command);
}
