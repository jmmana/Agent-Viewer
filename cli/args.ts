import path from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { AgentStatus } from '../src/types/agent.ts';
import { DEFAULT_HOST, DEFAULT_PORT } from './connection.ts';
import { normalizeStatus } from './statuses.ts';

/** A problem with the command line. The CLI prints the message and the usage, and exits with code 2. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export interface StartCommand {
  command: 'start';
  port: number;
  host: string;
  token?: string;
  demo: boolean;
  open: boolean;
  record?: string;
}

export interface SendCommand {
  command: 'send';
  agent: string;
  status: AgentStatus;
  message?: string;
  url?: string;
  token?: string;
}

export interface ClaudeHookCommand {
  command: 'claude-hook';
  url?: string;
  token?: string;
  includeSummaries: boolean;
}

export interface InstallCommand {
  command: 'install' | 'uninstall';
  target: 'claude-code';
  project: string;
  yes: boolean;
  includeSummaries: boolean;
  url?: string;
  token?: string;
}

export interface HelpCommand {
  command: 'help' | 'version';
}

export type CliCommand = StartCommand | SendCommand | ClaudeHookCommand | InstallCommand | HelpCommand;

export const USAGE = `Usage:
  agent-viewer [options]                 Start the server and open the office in live mode
  agent-viewer send --agent <id> --status <status> [--message <text>]
  agent-viewer claude-hook               Read a Claude Code hook from stdin and send it (used by the hooks)
  agent-viewer install claude-code [--project <dir>] [--yes] [--include-summaries]
  agent-viewer uninstall claude-code [--project <dir>] [--yes]

Start options:
  --port <n>           Port to listen on (default: PORT, or ${DEFAULT_PORT})
  --host <address>     Interface to bind (default: AGENT_VIEWER_HOST, or ${DEFAULT_HOST}, this machine only)
  --token <token>      API token (default: AGENT_VIEWER_API_TOKEN, or a new random token)
  --demo               Open the office with the simulated demo team; your events still show up
  --no-open            Do not open the browser
  --record <file>      Append every accepted event to a canonical JSONL V1 file

send and claude-hook:
  --url <url>          Server URL (default: the running viewer, or http://${DEFAULT_HOST}:${DEFAULT_PORT})
  --token <token>      API token (default: the running viewer's token)

  -h, --help           Show this help
  -v, --version        Show the version

Docs: https://github.com/jmmana/Agent-Viewer/blob/main/docs/cli.md`;

function parsePort(value: string, name = '--port'): number {
  if (!/^\d+$/.test(value)) throw new CliUsageError(`${name} must be a number between 0 and 65535, got "${value}"`);
  const port = Number(value);
  if (port > 65535) throw new CliUsageError(`${name} must be a number between 0 and 65535, got "${value}"`);
  return port;
}

/** A variable set to an empty or blank value counts as unset. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

function parseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw new CliUsageError(`--url must be an http or https URL, got "${value}"`);
  }
  return value.replace(/\/+$/, '');
}

function nonEmpty(name: string, value: string | undefined): string | undefined {
  if (value !== undefined && value.trim() === '') throw new CliUsageError(`${name} cannot be empty`);
  return value;
}

function parse(argv: string[], options: NonNullable<ParseArgsConfig['options']>) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: true, allowNegative: true });
  } catch (error) {
    throw new CliUsageError(error instanceof Error ? error.message : String(error));
  }
}

function rejectPositionals(positionals: string[], command: string): void {
  if (positionals.length > 0) {
    throw new CliUsageError(`Unexpected argument "${positionals[0]}" for ${command}`);
  }
}

/**
 * Parses the arguments after `agent-viewer` into a command. Throws `CliUsageError` on invalid input.
 * For start, the `PORT` and `AGENT_VIEWER_HOST` variables are the defaults of `--port` and `--host` (flags win).
 * The plain `HOST` variable is not read: some shells (tcsh) export it with the machine name, which would
 * silently expose the server to the network.
 */
export function parseCliArgs(argv: string[], cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): CliCommand {
  const [first, ...rest] = argv;

  if (first === '-h' || first === '--help' || first === 'help') return { command: 'help' };
  if (first === '-v' || first === '--version' || first === 'version') return { command: 'version' };

  if (first === 'send') {
    const { values, positionals } = parse(rest, {
      agent: { type: 'string' },
      status: { type: 'string' },
      message: { type: 'string' },
      url: { type: 'string' },
      token: { type: 'string' },
    });
    rejectPositionals(positionals, 'send');
    const agent = nonEmpty('--agent', values.agent as string | undefined);
    const rawStatus = values.status as string | undefined;
    if (!agent) throw new CliUsageError('send needs --agent <id>');
    if (!rawStatus) throw new CliUsageError('send needs --status <status>, for example --status working');
    const status = normalizeStatus(rawStatus);
    if (!status) {
      throw new CliUsageError(
        `Unknown status "${rawStatus}". Use an office status such as thinking, coding, waiting or done, or "working".`,
      );
    }
    return {
      command: 'send',
      agent,
      status,
      message: nonEmpty('--message', values.message as string | undefined),
      url: parseUrl(values.url as string | undefined),
      token: nonEmpty('--token', values.token as string | undefined),
    };
  }

  if (first === 'claude-hook') {
    const { values, positionals } = parse(rest, {
      url: { type: 'string' },
      token: { type: 'string' },
      'include-summaries': { type: 'boolean', default: false },
    });
    rejectPositionals(positionals, 'claude-hook');
    return {
      command: 'claude-hook',
      url: parseUrl(values.url as string | undefined),
      token: values.token as string | undefined,
      includeSummaries: Boolean(values['include-summaries']),
    };
  }

  if (first === 'install' || first === 'uninstall') {
    const { values, positionals } = parse(rest, {
      project: { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
      'include-summaries': { type: 'boolean', default: false },
      url: { type: 'string' },
      token: { type: 'string' },
    });
    const [target, ...extra] = positionals;
    if (target !== 'claude-code') {
      throw new CliUsageError(`${first} needs a target. Supported: claude-code (for example: agent-viewer ${first} claude-code)`);
    }
    rejectPositionals(extra, `${first} claude-code`);
    if (first === 'uninstall' && (values['include-summaries'] || values.url || values.token)) {
      throw new CliUsageError('uninstall only accepts --project and --yes');
    }
    return {
      command: first,
      target,
      project: path.resolve(cwd, (values.project as string | undefined) ?? '.'),
      yes: Boolean(values.yes),
      includeSummaries: Boolean(values['include-summaries']),
      url: parseUrl(values.url as string | undefined),
      token: nonEmpty('--token', values.token as string | undefined),
    };
  }

  const startArgs = first === 'start' ? rest : argv;
  const { values, positionals } = parse(startArgs, {
    port: { type: 'string' },
    host: { type: 'string' },
    token: { type: 'string' },
    demo: { type: 'boolean', default: false },
    open: { type: 'boolean', default: true },
    record: { type: 'string' },
  });
  if (positionals.length > 0) {
    throw new CliUsageError(`Unknown command "${positionals[0]}". Run agent-viewer --help`);
  }
  const record = nonEmpty('--record', values.record as string | undefined);
  const envPort = envValue(env, 'PORT');
  return {
    command: 'start',
    port: values.port !== undefined
      ? parsePort(values.port as string)
      : envPort !== undefined ? parsePort(envPort, 'PORT') : DEFAULT_PORT,
    host: nonEmpty('--host', values.host as string | undefined) ?? envValue(env, 'AGENT_VIEWER_HOST') ?? DEFAULT_HOST,
    token: nonEmpty('--token', values.token as string | undefined),
    demo: Boolean(values.demo),
    open: values.open !== false,
    record: record ? path.resolve(cwd, record) : undefined,
  };
}
