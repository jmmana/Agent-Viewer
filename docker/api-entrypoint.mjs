// Entry point of the API image (ghcr.io/jmmana/agent-viewer:<version>-api). Inside a container the server
// listens on every interface, so it never starts without a token:
//   1. AGENT_VIEWER_API_TOKEN (or the deprecated AGENT_VIEWER_API_KEY), when set to a non-blank value;
//   2. else the token saved in AGENT_VIEWER_TOKEN_FILE (default /app/data/api-token), so it survives restarts
//      when /app/data is a volume;
//   3. else a new random token, saved there with owner-only permissions and printed once on start.
// Then it runs the ingestion server (server/index.ts through tsx) and forwards stop signals to it.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_TOKEN_FILE = '/app/data/api-token';

function nonBlank(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The token the server runs with, and where it came from. Blank variables count as unset, so they never turn
 * authentication off. `source` is `env`, `legacy-env`, `file` or `generated`; `saved` is false when a
 * generated token could not be written (it then changes on every restart).
 */
export function resolveApiToken(env = process.env) {
  const fromEnv = nonBlank(env.AGENT_VIEWER_API_TOKEN);
  if (fromEnv) return { token: fromEnv, source: 'env', saved: true };
  const legacy = nonBlank(env.AGENT_VIEWER_API_KEY);
  if (legacy) return { token: legacy, source: 'legacy-env', saved: true };

  const file = nonBlank(env.AGENT_VIEWER_TOKEN_FILE) ?? DEFAULT_TOKEN_FILE;
  try {
    const saved = nonBlank(readFileSync(file, 'utf8'));
    if (saved) return { token: saved, source: 'file', file, saved: true };
  } catch {
    // No saved token yet.
  }

  const token = `av_${randomBytes(24).toString('base64url')}`;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
    return { token, source: 'generated', file, saved: true };
  } catch {
    return { token, source: 'generated', file, saved: false };
  }
}

/** Lines printed on start. The token is shown only when the operator did not choose it. */
export function startBanner(resolved) {
  if (resolved.source === 'env') return [];
  if (resolved.source === 'legacy-env') {
    return ['[agent-viewer] AGENT_VIEWER_API_KEY is deprecated; rename it to AGENT_VIEWER_API_TOKEN.'];
  }
  const origin = resolved.source === 'file'
    ? `It was read from ${resolved.file}.`
    : resolved.saved
      ? `It was generated and saved in ${resolved.file}; it stays the same across restarts while that folder is kept.`
      : `It was generated but could not be saved in ${resolved.file}, so it changes on every restart.`;
  return [
    `[agent-viewer] API token: ${resolved.token}`,
    `[agent-viewer] /api/v1 needs it (Authorization: Bearer <token>). ${origin}`,
    '[agent-viewer] Set AGENT_VIEWER_API_TOKEN to choose it.',
  ];
}

function main() {
  const resolved = resolveApiToken(process.env);
  for (const line of startBanner(resolved)) console.log(line);

  const root = fileURLToPath(new URL('..', import.meta.url));
  const env = { ...process.env, AGENT_VIEWER_API_TOKEN: resolved.token };
  delete env.AGENT_VIEWER_API_KEY;
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'server', 'index.ts')], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 0 : 1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
