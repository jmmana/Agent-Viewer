import type { OtelHeadersCommand } from './args.ts';
import { readSessionFile } from './connection.ts';

/**
 * `agent-viewer otel-headers --url <office-url>`.
 *
 * Claude Code's `otelHeadersHelper` runs this command to get the bearer header for its OTLP logs exporter
 * (helper mode of `install claude-code --telemetry`, see claudeInstall.ts). It never contacts the network: it
 * only reads the office's own session file and compares origins, so the office's token never reaches an
 * exporter pointed at a different URL. It always prints exactly one line and exits 0, even with a corrupt
 * session file, so a problem here never breaks a Claude Code session.
 */

/** `scheme://host:port`, with the default port filled in. `undefined` for an unparsable URL. */
export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return `${parsed.protocol}//${parsed.hostname}:${port}`;
  } catch {
    return undefined;
  }
}

/**
 * The header object for `url`: the bearer token only when a running office's session file has that exact
 * origin (`localhost` and `127.0.0.1` are different origins on purpose), `{}` otherwise. `AGENT_VIEWER_API_TOKEN`
 * wins over the session token, matching `resolveConnection`'s order, but the origin still has to match.
 */
export function resolveTelemetryHeaders(url: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  try {
    const session = readSessionFile(env);
    const wantOrigin = originOf(url);
    const haveOrigin = session ? originOf(session.url) : undefined;
    if (!wantOrigin || !haveOrigin || wantOrigin !== haveOrigin) return {};
    const token = env.AGENT_VIEWER_API_TOKEN?.trim() || session?.token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

export function runOtelHeaders(command: OtelHeadersCommand, env: NodeJS.ProcessEnv = process.env): number {
  let headers: Record<string, string>;
  try {
    headers = resolveTelemetryHeaders(command.url, env);
  } catch {
    headers = {};
  }
  console.log(JSON.stringify(headers));
  return 0;
}
