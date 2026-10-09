import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CanonicalEventInput } from '../src/integrations/canonicalTypes.ts';

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

/**
 * What a running `agent-viewer` writes so that `send` and `claude-hook` find it without flags: the URL and
 * the session token. The file lives in the user's own state folder with owner-only permissions.
 */
export interface SessionInfo {
  url: string;
  token?: string;
  pid: number;
  startedAt: number;
}

/** Folder for the session file: `AGENT_VIEWER_HOME`, or `~/.agent-viewer`. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_VIEWER_HOME || path.join(os.homedir(), '.agent-viewer');
}

export function sessionFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), 'session.json');
}

export function writeSessionFile(info: SessionInfo, env: NodeJS.ProcessEnv = process.env): string {
  if (info.token !== undefined && info.token.trim() === '') throw new Error('Refusing to write an empty token to the session file');
  const file = sessionFilePath(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows has no POSIX permissions; the file stays in the user's profile.
  }
  return file;
}

export function readSessionFile(env: NodeJS.ProcessEnv = process.env): SessionInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(sessionFilePath(env), 'utf8'));
    if (parsed && typeof parsed.url === 'string') return parsed as SessionInfo;
  } catch {
    // No running viewer, or an unreadable file: fall back to the defaults.
  }
  return undefined;
}

/** Removes the session file, but only when it still belongs to this process. */
export function removeSessionFile(pid: number, env: NodeJS.ProcessEnv = process.env): void {
  const current = readSessionFile(env);
  if (current && current.pid !== pid) return;
  rmSync(sessionFilePath(env), { force: true });
}

export interface Connection {
  url: string;
  token?: string;
}

/**
 * Where to send events. Flags win, then `AGENT_VIEWER_URL` and `AGENT_VIEWER_API_TOKEN`, then the session
 * file of a running viewer, then `http://127.0.0.1:8787` without a token.
 */
export function resolveConnection(
  flags: { url?: string; token?: string },
  env: NodeJS.ProcessEnv = process.env,
): Connection {
  const session = flags.url || env.AGENT_VIEWER_URL ? undefined : readSessionFile(env);
  const url = (flags.url || env.AGENT_VIEWER_URL || session?.url || DEFAULT_URL).replace(/\/+$/, '');
  const token = flags.token || env.AGENT_VIEWER_API_TOKEN?.trim() || session?.token || undefined;
  return { url, token };
}

export interface PostResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/** Posts events in one request: a single event to `/api/v1/events`, several to `/api/v1/events/batch`. */
export async function postEvents(
  connection: Connection,
  events: CanonicalEventInput[],
  options: { signal?: AbortSignal } = {},
): Promise<PostResult> {
  const single = events.length === 1;
  const response = await fetch(`${connection.url}/api/v1/events${single ? '' : '/batch'}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}),
    },
    body: JSON.stringify(single ? events[0] : events),
    signal: options.signal,
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON: keep the status only.
  }
  return { ok: response.ok, status: response.status, body };
}
