import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { StartCommand } from './args.ts';
import { removeSessionFile, writeSessionFile } from './connection.ts';
import { packageInfo } from './packageInfo.ts';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const ANY = new Set(['0.0.0.0', '::']);

/** Address to use in URLs: the loopback address stands in for "every interface", IPv6 gets brackets. */
export function displayHost(host: string): string {
  if (ANY.has(host)) return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * The office URL. The token travels in the fragment, which the browser never sends to any server, and the
 * office removes it from the address bar as soon as it has read it.
 */
export function officeUrl(baseUrl: string, token: string | undefined, demo: boolean): string {
  const query = demo ? '' : '?mode=live';
  return `${baseUrl}/${query}${token ? `#token=${encodeURIComponent(token)}` : ''}`;
}

/** The URL handed to the browser: a single-use launch code instead of the token, so argv never holds it. */
export function launchUrl(baseUrl: string, code: string, demo: boolean): string {
  const query = demo ? '' : '?mode=live';
  return `${baseUrl}/${query}#launch=${encodeURIComponent(code)}`;
}

/** Path where the office trades a launch code for the session token. Outside /api/v1, so it needs no token. */
export const LAUNCH_PATH = '/api/cli/launch';
const LAUNCH_TTL_MS = 120_000;

/**
 * Single-use launch codes. The CLI opens the browser with a code instead of the token: the code shows up in
 * the process list and in the browser history, but it works once, for two minutes, and only on this server.
 */
export function createLaunchCodes(token: string, now: () => number = Date.now) {
  const codes = new Map<string, number>();
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return {
    issue(): string {
      const code = randomBytes(18).toString('base64url');
      codes.set(code, now() + LAUNCH_TTL_MS);
      return code;
    },
    redeem(code: unknown): string | undefined {
      if (typeof code !== 'string' || code === '') return undefined;
      const wanted = digest(code);
      for (const [candidate, expiresAt] of codes) {
        if (timingSafeEqual(digest(candidate), wanted)) {
          codes.delete(candidate);
          return expiresAt >= now() ? token : undefined;
        }
      }
      return undefined;
    },
  };
}

/** A token from the environment. Empty or blank values count as unset, so they never disable the token. */
function envToken(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * The session token: `--token`, then `AGENT_VIEWER_API_TOKEN`, then the deprecated `AGENT_VIEWER_API_KEY`, then
 * a new random token. Never empty: an empty variable would otherwise turn authentication off.
 */
export function resolveStartToken(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): { token: string; source: 'flag' | 'env' | 'legacy-env' | 'generated' } {
  if (flag !== undefined && flag.trim() !== '') return { token: flag, source: 'flag' };
  const fromEnv = envToken(env, 'AGENT_VIEWER_API_TOKEN');
  if (fromEnv) return { token: fromEnv, source: 'env' };
  const legacy = envToken(env, 'AGENT_VIEWER_API_KEY');
  if (legacy) return { token: legacy, source: 'legacy-env' };
  return { token: `av_${randomBytes(24).toString('base64url')}`, source: 'generated' };
}

/** A test command for the printed banner: the generic webhook builds the events from a flat body. */
export function curlExample(baseUrl: string, token: string | undefined): string {
  const auth = token ? ` \\\n  -H "Authorization: Bearer ${token}"` : '';
  return `curl -X POST ${baseUrl}/api/v1/webhooks/generic${auth} \\\n  -H "Content-Type: application/json" \\\n  -d '{"agent":"demo","status":"THINKING","message":"Hello from curl"}'`;
}

export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {
      console.log('Could not open a browser; open the office URL above yourself.');
    });
    child.unref();
  } catch {
    console.log('Could not open a browser; open the office URL above yourself.');
  }
}

export interface RunningViewer {
  url: string;
  token: string;
  port: number;
  /** A new single-use code that the office trades for the token (see `launchUrl`). */
  issueLaunchCode: () => string;
  close: () => Promise<void>;
}

/** Starts the ingestion server and serves the prebuilt office from the same origin. */
export async function startViewer(command: StartCommand): Promise<RunningViewer> {
  const { token, source } = resolveStartToken(command.token);
  if (source === 'legacy-env') {
    console.warn('agent-viewer: AGENT_VIEWER_API_KEY is deprecated; rename it to AGENT_VIEWER_API_TOKEN.');
  }
  // The server module reads its configuration when it is imported, so set it first.
  process.env.AGENT_VIEWER_EMBEDDED = '1';
  process.env.AGENT_VIEWER_API_TOKEN = token;
  delete process.env.AGENT_VIEWER_API_KEY;

  const [{ app, onEventAccepted, startServer }, { default: express }] = await Promise.all([
    import('../server/index.ts'),
    import('express'),
  ]);

  const launchCodes = createLaunchCodes(token);
  app.post(LAUNCH_PATH, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const granted = launchCodes.redeem((req.body as { code?: unknown } | undefined)?.code);
    if (!granted) {
      res.status(404).json({ error: 'launch_code_invalid', message: 'Unknown, used or expired launch code' });
      return;
    }
    res.json({ token: granted });
  });

  const viewerDir = path.join(packageInfo().root, 'dist-cli', 'viewer');
  const hasViewer = existsSync(path.join(viewerDir, 'index.html'));
  if (hasViewer) {
    app.use(express.static(viewerDir, {
      index: false,
      setHeaders: (res, file) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }));
  }
  // Single page app: every other GET outside the API gets the office (or a note when it was not built).
  app.get(/^\/(?!api\/|health$|ready$).*/, (_req, res) => {
    if (!hasViewer) {
      res.status(503).type('text/plain').send('The office is not built. Run "npm run build:cli" in the repository, then restart.');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(viewerDir, 'index.html'));
  });

  let recorder: WriteStream | undefined;
  let stopRecording: (() => void) | undefined;
  if (command.record) {
    mkdirSync(path.dirname(command.record), { recursive: true });
    recorder = createWriteStream(command.record, { flags: 'a' });
    stopRecording = onEventAccepted((event) => {
      recorder?.write(`${JSON.stringify(event)}\n`);
    });
  }

  const server = startServer(command.port, command.host);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Port ${command.port} is already in use on ${command.host}. Try --port ${command.port + 1}.`));
      } else if (error.code === 'EADDRNOTAVAIL' || error.code === 'ENOTFOUND') {
        reject(new Error(`Cannot listen on ${command.host}: this machine has no such address.`));
      } else {
        reject(error);
      }
    });
  });

  const port = (server.address() as AddressInfo).port;
  const url = `http://${displayHost(command.host)}:${port}`;
  const pid = process.pid;
  let sessionWritten = false;
  try {
    writeSessionFile({ url, token, pid, startedAt: Date.now() });
    sessionWritten = true;
    // Also on any other way out of the process (an uncaught error, process.exit).
    process.once('exit', () => removeSessionFile(pid));
  } catch {
    // Without the session file, send and claude-hook need --url and --token.
  }

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= new Promise<void>((resolve) => {
      stopRecording?.();
      if (sessionWritten) removeSessionFile(pid);
      server.closeAllConnections?.();
      server.close(() => {
        if (recorder) recorder.end(() => resolve());
        else resolve();
      });
    });
    return closing;
  };

  return { url, token, port, issueLaunchCode: () => launchCodes.issue(), close };
}

/** What a non-loopback bind exposes, for the start banner. */
export function exposureWarning(host: string, webhookSecret: boolean): string {
  const webhooks = webhookSecret ? ' Webhooks accept a valid AGENT_VIEWER_WEBHOOK_SECRET signature instead of the token.' : '';
  return `Warning: listening on ${host}, so other machines on the network can reach it. /api/v1 needs the token above.${webhooks} The office page and /health are public.`;
}

/** Runs `agent-viewer` (start). Resolves when the server stops. */
export async function runStart(command: StartCommand): Promise<number> {
  let viewer: RunningViewer;
  try {
    viewer = await startViewer(command);
  } catch (error) {
    console.error(`agent-viewer: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  const office = officeUrl(viewer.url, viewer.token, command.demo);
  const lines = [
    '',
    `  Agent Viewer ${packageInfo().version} is running${command.demo ? ' (demo team)' : ''}`,
    '',
    `  Office  ${office}`,
    `  API     ${viewer.url}/api/v1`,
    `  Token   ${viewer.token}`,
    ...(command.record ? [`  Record  ${command.record}`] : []),
    '',
    '  Send a test event:',
    '',
    ...curlExample(viewer.url, viewer.token).split('\n').map((line) => `    ${line}`),
    '',
    '  Or without JSON:  npx @warlockcode/agent-viewer send --agent demo --status working',
    '  Claude Code:      npx @warlockcode/agent-viewer install claude-code',
    '',
    '  Press Ctrl+C to stop.',
    '',
  ];
  console.log(lines.join('\n'));
  if (!LOOPBACK.has(command.host)) {
    console.log(`  ${exposureWarning(command.host, Boolean(process.env.AGENT_VIEWER_WEBHOOK_SECRET))}\n`);
  }
  // The browser gets a single-use launch code, not the token: argv is visible to other local processes.
  if (command.open) openBrowser(launchUrl(viewer.url, viewer.issueLaunchCode(), command.demo));

  await new Promise<void>((resolve) => {
    // The handlers stay installed while closing: npx forwards Ctrl+C to the child on top of the terminal's own
    // signal, and an unhandled second SIGINT would end the process before it cleans up.
    let signals = 0;
    const stop = () => {
      signals += 1;
      if (signals === 1) void viewer.close().then(resolve);
      else if (signals > 2) process.exit(130);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}
