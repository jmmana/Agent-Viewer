// Health check of the office + API image. It asks the running `agent-viewer` where it listens (the session
// file it writes in AGENT_VIEWER_HOME), so the check follows `--port` too, and falls back to PORT.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The /health URL of the server in this container. */
export function healthUrl(env = process.env) {
  const home = env.AGENT_VIEWER_HOME || '/app/data';
  try {
    const session = JSON.parse(readFileSync(path.join(home, 'session.json'), 'utf8'));
    const port = new URL(session.url).port;
    if (port) return `http://127.0.0.1:${port}/health`;
  } catch {
    // Not started yet, or no session file: use the configured port.
  }
  return `http://127.0.0.1:${env.PORT || 8787}/health`;
}

async function main() {
  try {
    const response = await fetch(healthUrl(), { signal: AbortSignal.timeout(4000) });
    process.exit(response.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
