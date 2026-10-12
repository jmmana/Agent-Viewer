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
  /** Issue #103. Sets AGENT_VIEWER_METRICS=1 before the server module loads, enabling GET /metrics. */
  metrics: boolean;
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
  /** true: write or refresh the telemetry block; false: remove it; undefined: leave it as it is. */
  telemetry?: boolean;
}

export interface OtelHeadersCommand {
  command: 'otel-headers';
  /** Origin the headers are for. The token is printed only if the running office has this exact origin. */
  url: string;
}

/** Issue #107: `agent-viewer keys create|list|revoke|whoami`, against a running viewer started with
 * `AGENT_VIEWER_STORAGE=sqlite` (key management requires SQLite). Reuses `resolveConnection`, so the bootstrap
 * token comes from `--token`, `AGENT_VIEWER_API_TOKEN` or the session file, the same way `send` resolves it. */
export interface KeysCommand {
  command: 'keys';
  action: 'create' | 'list' | 'revoke' | 'whoami';
  /** `create` only: the new key's name. */
  name?: string;
  /** `revoke` only: the key id to revoke. */
  id?: string;
  /** `create` only: raw `<n>m|<n>h|<n>d` (minutes/hours/days), converted to `expiresIn` seconds for the API. */
  expiresIn?: string;
  /** `create` only (issue #108): comma-separated scopes, for example `ingest,read`; the server validates them. */
  scopes?: string[];
  json: boolean;
  url?: string;
  token?: string;
}

export interface HelpCommand {
  command: 'help' | 'version';
}

export type CliCommand =
  | StartCommand
  | SendCommand
  | ClaudeHookCommand
  | InstallCommand
  | OtelHeadersCommand
  | KeysCommand
  | HelpCommand;

export const USAGE = `Usage:
  agent-viewer [options]                 Start the server and open the office in live mode
  agent-viewer send --agent <id> --status <status> [--message <text>]
  agent-viewer claude-hook               Read a Claude Code hook from stdin and send it (used by the hooks)
  agent-viewer install claude-code [--project <dir>] [--yes] [--include-summaries]
                                   [--telemetry | --no-telemetry] [--url <url>] [--token <token>]
  agent-viewer uninstall claude-code [--project <dir>] [--yes]
  agent-viewer otel-headers --url <office-url>
                                          Print the bearer header for that office as JSON (used by Claude
                                          Code's otelHeadersHelper, not meant to be run by people)
  agent-viewer keys create <name> [--scope ingest,read,audit,admin] [--expires-in <n>m|<n>h|<n>d] [--json]
                                 [--url <url>] [--token <token>]
  agent-viewer keys list [--json] [--url <url>] [--token <token>]
  agent-viewer keys revoke <id> [--json] [--url <url>] [--token <token>]
  agent-viewer keys whoami [--json] [--url <url>] [--token <token>]
                                          Named API keys (issue #107); requires a viewer started with
                                          AGENT_VIEWER_STORAGE=sqlite. --token is the bootstrap credential
                                          (AGENT_VIEWER_API_TOKEN), as on send. create prints the new token
                                          once to stdout; it is never written to the session file.

Start options:
  --port <n>           Port to listen on (default: PORT, or ${DEFAULT_PORT})
  --host <address>     Interface to bind (default: AGENT_VIEWER_HOST, or ${DEFAULT_HOST}, this machine only)
  --token <token>      API token (default: AGENT_VIEWER_API_TOKEN, or a new random token)
  --demo               Open the office with the simulated demo team; your events still show up
  --no-open            Do not open the browser
  --record <file>      Append every accepted event to a canonical JSONL V1 file
  --metrics            Enable GET /metrics (Prometheus export, opt-in, token-protected; see README "Metrics")

send and claude-hook:
  --url <url>          Server URL (default: the running viewer, or http://${DEFAULT_HOST}:${DEFAULT_PORT})
  --token <token>      API token (default: the running viewer's token)

install claude-code:
  --telemetry           Send Claude Code's own token and cost figures (OpenTelemetry logs) to the office
  --no-telemetry        Remove the telemetry block, keep the hooks
  --token <token>       Static mode: a fixed office token, for an office on another machine or in Docker

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
      // No `default`: an absent flag must stay `undefined`, never `false`, so a plain install never touches an
      // existing telemetry block. `allowNegative` (set on the parser above) turns `--no-telemetry` into `false`.
      telemetry: { type: 'boolean' },
    });
    const [target, ...extra] = positionals;
    if (target !== 'claude-code') {
      throw new CliUsageError(`${first} needs a target. Supported: claude-code (for example: agent-viewer ${first} claude-code)`);
    }
    rejectPositionals(extra, `${first} claude-code`);
    if (first === 'uninstall' && (values['include-summaries'] || values.url || values.token || values.telemetry !== undefined)) {
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
      telemetry: values.telemetry as boolean | undefined,
    };
  }

  if (first === 'keys') {
    const [action, ...actionRest] = rest;
    if (action !== 'create' && action !== 'list' && action !== 'revoke' && action !== 'whoami') {
      throw new CliUsageError('keys needs an action: create, list, revoke or whoami (for example: agent-viewer keys list)');
    }
    const { values, positionals } = parse(actionRest, {
      'expires-in': { type: 'string' },
      scope: { type: 'string' },
      json: { type: 'boolean', default: false },
      url: { type: 'string' },
      token: { type: 'string' },
    });
    const common: Omit<KeysCommand, 'name' | 'id' | 'expiresIn' | 'scopes'> = {
      command: 'keys',
      action,
      json: Boolean(values.json),
      url: parseUrl(values.url as string | undefined),
      token: nonEmpty('--token', values.token as string | undefined),
    };
    if (action === 'create') {
      const [name, ...extra] = positionals;
      rejectPositionals(extra, 'keys create');
      if (!name) throw new CliUsageError('keys create needs a name (for example: agent-viewer keys create ci-pipeline)');
      const scopeFlag = values.scope as string | undefined;
      const scopes = scopeFlag === undefined ? undefined : scopeFlag.split(',').map((s) => s.trim()).filter((s) => s !== '');
      return { ...common, name, expiresIn: values['expires-in'] as string | undefined, ...(scopes ? { scopes } : {}) };
    }
    if (action === 'revoke') {
      const [id, ...extra] = positionals;
      rejectPositionals(extra, 'keys revoke');
      if (!id) throw new CliUsageError('keys revoke needs a key id (for example: agent-viewer keys revoke key_3f9a1c7e02ab)');
      return { ...common, id };
    }
    rejectPositionals(positionals, `keys ${action}`);
    return common;
  }

  if (first === 'otel-headers') {
    const { values, positionals } = parse(rest, { url: { type: 'string' } });
    rejectPositionals(positionals, 'otel-headers');
    const raw = nonEmpty('--url', values.url as string | undefined);
    if (!raw) throw new CliUsageError('otel-headers needs --url <office-url>');
    const url = parseUrl(raw);
    if (!url) throw new CliUsageError('otel-headers needs --url <office-url>');
    return { command: 'otel-headers', url };
  }

  const startArgs = first === 'start' ? rest : argv;
  const { values, positionals } = parse(startArgs, {
    port: { type: 'string' },
    host: { type: 'string' },
    token: { type: 'string' },
    demo: { type: 'boolean', default: false },
    open: { type: 'boolean', default: true },
    record: { type: 'string' },
    metrics: { type: 'boolean', default: false },
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
    metrics: Boolean(values.metrics),
  };
}
