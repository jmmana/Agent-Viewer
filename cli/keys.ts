import type { KeysCommand } from './args.ts';
import { resolveConnection } from './connection.ts';

/** `<n>m|<n>h|<n>d` (minutes/hours/days) to seconds, for the API's `expiresIn`. */
function parseExpiresIn(raw: string): number {
  const match = /^(\d+)([mhd])$/.exec(raw.trim());
  if (!match) throw new Error(`--expires-in must look like 30m, 12h or 7d, got "${raw}"`);
  const amount = Number(match[1]);
  const unitSeconds = { m: 60, h: 3600, d: 86400 }[match[2] as 'm' | 'h' | 'd'];
  return amount * unitSeconds;
}

async function call(
  connection: { url: string; token?: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${connection.url}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  let json: any = null;
  try {
    json = await response.json();
  } catch {
    // Not JSON: keep the status only.
  }
  return { status: response.status, json };
}

function describeError(status: number, json: any): string {
  if (status === 501) return 'the viewer is not running with AGENT_VIEWER_STORAGE=sqlite (named keys need SQLite)';
  if (status === 403) return 'only the bootstrap token (AGENT_VIEWER_API_TOKEN) may manage keys';
  if (status === 404) return 'no key with that id';
  if (status === 409) return 'a key with that name already exists';
  if (status === 401) return 'the server wants a valid token: pass --token, or set AGENT_VIEWER_API_TOKEN';
  return json?.message || json?.error || `server answered ${status}`;
}

function formatTable(keys: any[]): string {
  if (keys.length === 0) return 'No API keys.';
  const rows = keys.map((k) => [
    k.name,
    k.id,
    k.status,
    k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : 'never',
    String(k.eventCount),
  ]);
  const header = ['NAME', 'ID', 'STATUS', 'LAST USED', 'EVENTS'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(header), ...rows.map(line)].join('\n');
}

/** Runs `agent-viewer keys ...`. Returns the process exit code: 0 success, 1 server/network failure. */
export async function runKeys(command: KeysCommand): Promise<number> {
  const connection = resolveConnection(command);

  if (command.action === 'create') {
    let expiresIn: number | undefined;
    if (command.expiresIn) {
      try {
        expiresIn = parseExpiresIn(command.expiresIn);
      } catch (error) {
        console.error(`agent-viewer: ${error instanceof Error ? error.message : error}`);
        return 1;
      }
    }
    const { status, json } = await call(connection, 'POST', '/api/v1/keys', {
      name: command.name,
      ...(expiresIn !== undefined ? { expiresIn } : {}),
    });
    if (status !== 201) {
      console.error(`agent-viewer: could not create the key: ${describeError(status, json)}`);
      return 1;
    }
    if (command.json) {
      console.log(JSON.stringify(json));
      return 0;
    }
    // The token is never written to the session file and never accepted as a CLI argument (it would show in
    // the process list); it is shown exactly once, here.
    console.log(json.token);
    console.error(`agent-viewer: key "${json.name}" (${json.id}) created. Save this token now: it cannot be shown again.`);
    return 0;
  }

  if (command.action === 'list') {
    const { status, json } = await call(connection, 'GET', '/api/v1/keys');
    if (status !== 200) {
      console.error(`agent-viewer: could not list keys: ${describeError(status, json)}`);
      return 1;
    }
    console.log(command.json ? JSON.stringify(json) : formatTable(json.keys));
    return 0;
  }

  if (command.action === 'revoke') {
    const { status, json } = await call(connection, 'POST', `/api/v1/keys/${encodeURIComponent(command.id!)}/revoke`);
    if (status !== 200) {
      console.error(`agent-viewer: could not revoke the key: ${describeError(status, json)}`);
      return 1;
    }
    console.log(command.json ? JSON.stringify(json) : `Key ${json.id} (${json.name}) is ${json.status}.`);
    return 0;
  }

  // whoami
  const { status, json } = await call(connection, 'GET', '/api/v1/whoami');
  if (status !== 200) {
    console.error(`agent-viewer: could not resolve identity: ${describeError(status, json)}`);
    return 1;
  }
  console.log(command.json ? JSON.stringify(json) : `${json.kind}${json.name ? ` (${json.name})` : ''}: ${json.id}`);
  return 0;
}
