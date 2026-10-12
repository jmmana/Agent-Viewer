import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, openSync, type WriteStream } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { StartCommand } from './args.ts';
import { removeSessionFile, stateDir, writeSessionFile } from './connection.ts';
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

/**
 * The `--metrics` banner hint (issue #103). The CLI generates a random, throwaway API token on every run
 * (`resolveStartToken`'s `generated` source); printing that as a "scrape this with Prometheus" credential would
 * suggest a long-lived secret where there is none. The hint only appears when the operator supplied a stable
 * credential: an explicit `AGENT_VIEWER_METRICS_TOKEN`, or an API token that came from `--token` or the
 * environment rather than being generated this run.
 */
export function metricsHintLines(baseUrl: string, env: NodeJS.ProcessEnv = process.env, apiTokenSource?: 'flag' | 'env' | 'legacy-env' | 'generated'): string[] {
  const metricsTokenSet = Boolean(envToken(env, 'AGENT_VIEWER_METRICS_TOKEN'));
  const stableCredential = metricsTokenSet || (apiTokenSource !== undefined && apiTokenSource !== 'generated');
  if (!stableCredential) {
    return [
      '  Metrics  /metrics is enabled, but no stable credential is configured (the API token above is',
      '           regenerated every run). Set AGENT_VIEWER_METRICS_TOKEN to scrape it with Prometheus.',
      '',
    ];
  }
  return [`  Metrics  ${baseUrl}/metrics (needs its own token; see README "Metrics")`, ''];
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

/**
 * Opens the `--record` file before the server listens, so a path that cannot be written stops the CLI with a
 * clear message instead of failing later. A new file is readable only by its owner: events can carry summaries.
 */
export function openRecording(file: string): WriteStream {
  let fd: number;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    fd = openSync(file, 'a', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    throw new Error(`Cannot write the --record file ${file} (${code}).`);
  }
  return createWriteStream(file, { fd, flags: 'a' });
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
  // Issue #103: --metrics is the only way to turn GET /metrics on under the CLI (AGENT_VIEWER_METRICS is not a
  // documented CLI flag's env equivalent otherwise); the server module itself re-reads this same variable.
  if (command.metrics) process.env.AGENT_VIEWER_METRICS = '1';
  // Issue #271: without this, the pricing store would default to `./data/pricing.json` relative to wherever
  // `npx agent-viewer` was run. Keep it under the same state folder as the session file and, in the Docker app
  // image, the same `/app/data` volume as the SQLite database.
  if (!process.env.AGENT_VIEWER_PRICING_FILE || process.env.AGENT_VIEWER_PRICING_FILE.trim() === '') {
    process.env.AGENT_VIEWER_PRICING_FILE = path.join(stateDir(), 'pricing.json');
  }

  const [{ app, onEventAccepted, startServer, shutdown }, { default: express }] = await Promise.all([
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
  // `metrics$` is excluded (issue #103) so a disabled or enabled GET /metrics always reaches the real route
  // registered by server/index.ts instead of this fallback serving the office's index.html for it.
  app.get(/^\/(?!api\/|health$|ready$|metrics$).*/, (_req, res) => {
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
    recorder = openRecording(command.record);
    // A write error mid-run (full disk, removed volume) stops the recording, never the server.
    recorder.once('error', (error: NodeJS.ErrnoException) => {
      stopRecording?.();
      stopRecording = undefined;
      recorder = undefined;
      console.warn(`agent-viewer: --record stopped: ${error.code ?? error.message}`);
    });
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
        // Stops the retention job (issue #70) and closes the store, after the HTTP server itself is closed: the
        // embedded server installs no SIGTERM/SIGINT handler of its own (server/index.ts), so this is the only
        // place its store ever gets closed.
        void shutdown().finally(() => {
          if (recorder) recorder.end(() => resolve());
          else resolve();
        });
      });
    });
    return closing;
  };

  return { url, token, port, issueLaunchCode: () => launchCodes.issue(), close };
}

/** What a non-loopback bind exposes, for the start banner. */
export function exposureWarning(host: string, webhookSecret: boolean, metricsEnabled = false): string {
  const webhooks = webhookSecret ? ' Webhooks accept a valid AGENT_VIEWER_WEBHOOK_SECRET signature instead of the token.' : '';
  // Issue #103: /metrics is opt-in and needs its own credential (or the API token), so it is not covered by
  // "the office page and /health are public" below.
  const metrics = metricsEnabled ? ' /metrics needs its own token (or the API token) too.' : '';
  return `Warning: listening on ${host}, so other machines on the network can reach it. /api/v1 needs the token above.${webhooks}${metrics} The office page and /health are public.`;
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
    ...(command.metrics ? metricsHintLines(viewer.url, process.env, resolveStartToken(command.token).source) : []),
    '  Press Ctrl+C to stop.',
    '',
  ];
  console.log(lines.join('\n'));
  if (!LOOPBACK.has(command.host)) {
    console.log(`  ${exposureWarning(command.host, Boolean(process.env.AGENT_VIEWER_WEBHOOK_SECRET), command.metrics)}\n`);
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
