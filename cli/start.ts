import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

/** The office URL. The token travels in the fragment, which the browser never sends to any server. */
export function officeUrl(baseUrl: string, token: string | undefined, demo: boolean): string {
  const query = demo ? '' : '?mode=live';
  return `${baseUrl}/${query}${token ? `#token=${encodeURIComponent(token)}` : ''}`;
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
  close: () => Promise<void>;
}

/** Starts the ingestion server and serves the prebuilt office from the same origin. */
export async function startViewer(command: StartCommand): Promise<RunningViewer> {
  const token = command.token ?? process.env.AGENT_VIEWER_API_TOKEN ?? `av_${randomBytes(24).toString('base64url')}`;
  // The server module reads its configuration when it is imported, so set it first.
  process.env.AGENT_VIEWER_EMBEDDED = '1';
  process.env.AGENT_VIEWER_API_TOKEN = token;
  delete process.env.AGENT_VIEWER_API_KEY;

  const [{ app, onEventAccepted, startServer }, { default: express }] = await Promise.all([
    import('../server/index.ts'),
    import('express'),
  ]);

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

  return { url, token, port, close };
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
    console.log(`  Warning: listening on ${command.host}, so other machines on the network can reach it. The token still protects /api/v1.\n`);
  }
  if (command.open) openBrowser(office);

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
