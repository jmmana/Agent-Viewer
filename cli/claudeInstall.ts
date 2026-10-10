import { randomBytes } from 'node:crypto';
import os from 'node:os';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { isDeepStrictEqual } from 'node:util';
import { OTLP_LOGS_PATH } from '../src/integrations/otelConstants.ts';
import type { InstallCommand } from './args.ts';
import { CLAUDE_HOOK_EVENTS } from './claudeHook.ts';
import { resolveConnection, stateDir } from './connection.ts';
import { formatValue, indentUnit, lineIndent, parseJsonSpans, renderAppended, renderFiltered, type JsonNode } from './jsonText.ts';
import { resolveTelemetryHeaders } from './otelHeaders.ts';
import { cliScriptPath } from './packageInfo.ts';

/**
 * `agent-viewer install claude-code` and `uninstall claude-code`.
 *
 * In the project, only `<project>/.claude/settings.local.json` is ever written: the per-project, per-machine
 * settings file Claude Code keeps out of git. The user settings in `~/.claude` are never touched. The change is
 * shown first and applied only after confirmation (or `--yes`), and only if the file did not change meanwhile;
 * the write goes through a temporary file and a rename, so the file is never left half written. The file is
 * edited as text: install appends its handlers and leaves every other byte alone, and uninstall removes exactly
 * what install appended, so the file comes back byte for byte. Each text edit is checked against the same
 * change made on the parsed JSON.
 *
 * What uninstall cannot tell from the file alone (whether install created the file or the `.claude/` folder,
 * and which empty event lists were there before) is kept in a small record in the Agent Viewer state folder
 * (`~/.agent-viewer/claude-code-installs.json`). Without that record, uninstall keeps the file and the folder.
 */

export interface HookHandler {
  type: 'command';
  command: string;
  args: string[];
  timeout: number;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** Hook timeout, in seconds as Claude Code reads it. */
export const HOOK_TIMEOUT_SECONDS = 1;

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

export function settingsPath(project: string): string {
  return path.join(project, '.claude', 'settings.local.json');
}

/** The handler install writes: this Node binary running this CLI, in exec form so paths need no quoting. */
export function buildHookHandler(options: {
  nodePath?: string;
  scriptPath?: string;
  includeSummaries?: boolean;
  url?: string;
  token?: string;
} = {}): HookHandler {
  const args = [options.scriptPath ?? cliScriptPath(), 'claude-hook'];
  if (options.includeSummaries) args.push('--include-summaries');
  if (options.url) args.push('--url', options.url);
  if (options.token) args.push('--token', options.token);
  // Claude Code reads `timeout` in seconds. The hook stops itself after 400 ms, so 1 second is only a safety
  // net, and it stays below Claude Code's default budget for SessionEnd hooks instead of raising it.
  return { type: 'command', command: options.nodePath ?? process.execPath, args, timeout: HOOK_TIMEOUT_SECONDS };
}

/**
 * `install claude-code --telemetry`: Claude Code's own OpenTelemetry logs, carrying token and cost figures
 * per model call (see docs/claude-code.md, "Tokens and cost"). Only `settings.local.json` is touched, through
 * the same byte-preserving text edit as the hooks, and only the `env` keys below plus `otelHeadersHelper` (or,
 * in static mode, `OTEL_EXPORTER_OTLP_LOGS_HEADERS`) are ever written. No metrics or traces exporter is ever
 * configured: that is #73 and #97.
 */

/** Content flags Claude Code reads. The installer always pins every one of them to `"0"`. */
export const TELEMETRY_CONTENT_FLAGS = [
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOG_ASSISTANT_RESPONSES',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_TOOL_CONTENT',
  'OTEL_LOG_RAW_API_BODIES',
] as const;

/** `env` keys the installer writes in every mode, the content flags included. */
export const TELEMETRY_ENV_KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_LOGS_EXPORTER',
  'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  ...TELEMETRY_CONTENT_FLAGS,
] as const;

/** Static mode only: the header carrying the fixed token, scoped to the logs exporter alone. */
export const TELEMETRY_HEADERS_KEY = 'OTEL_EXPORTER_OTLP_LOGS_HEADERS';

/** A value counts as on unless its trimmed, lowercased text is empty, `0`, `false`, `no` or `off`. */
export function isTruthyFlag(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

/** Resolves the full endpoint URL (including the logs path) the same way `send` and `claude-hook` resolve a
 * server: `--url`, then `AGENT_VIEWER_URL`, then the running office's session file, then the local default. */
export function resolveTelemetryEndpoint(url: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const { url: base } = resolveConnection({ url }, env);
  return `${base}${OTLP_LOGS_PATH}`;
}

/** Quotes one argument for a shell command line: POSIX single-quoting, Windows double-quoting. */
export function quoteShellArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `"${arg.replace(/"/g, '\\"')}"`;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** The `otelHeadersHelper` command line: this Node binary running `agent-viewer otel-headers --url <office>`. */
export function buildOtelHeadersHelperCommand(options: {
  nodePath?: string;
  scriptPath?: string;
  url: string;
  platform?: NodeJS.Platform;
}): string {
  const platform = options.platform ?? process.platform;
  const parts = [options.nodePath ?? process.execPath, options.scriptPath ?? cliScriptPath(), 'otel-headers', '--url', options.url];
  return parts.map((part) => quoteShellArg(part, platform)).join(' ');
}

/** The `env` block (and, in helper mode, the `otelHeadersHelper` command) `--telemetry` writes. */
export interface TelemetryWritePlan {
  env: Record<string, string>;
  /** Helper mode only: the command Claude Code runs to fetch the bearer header at export time. */
  helperCommand?: string;
}

export function buildTelemetryEnv(options: { endpoint: string; token?: string }): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: options.endpoint,
    OTEL_LOG_USER_PROMPTS: '0',
    OTEL_LOG_ASSISTANT_RESPONSES: '0',
    OTEL_LOG_TOOL_DETAILS: '0',
    OTEL_LOG_TOOL_CONTENT: '0',
    OTEL_LOG_RAW_API_BODIES: '0',
  };
  if (options.token) env[TELEMETRY_HEADERS_KEY] = `Authorization=Bearer ${options.token}`;
  return env;
}

/** Builds the write plan for `--telemetry`: helper mode without `--token`, static mode with it. */
export function buildTelemetryWritePlan(options: {
  endpoint: string;
  token?: string;
  nodePath?: string;
  scriptPath?: string;
  platform?: NodeJS.Platform;
}): TelemetryWritePlan {
  const env = buildTelemetryEnv(options);
  if (options.token) return { env };
  return {
    env,
    helperCommand: buildOtelHeadersHelperCommand({
      nodePath: options.nodePath, scriptPath: options.scriptPath, url: options.endpoint.replace(new RegExp(`${OTLP_LOGS_PATH}$`), ''), platform: options.platform,
    }),
  };
}

/** Masks a known token in text meant for the screen (a diff, a note). The file on disk keeps the real value. */
export function maskToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join('<token hidden>');
}

/** Masks every known token: `--token` for the write about to happen, and whatever static-mode token is already
 * in the file (read straight from it, since the install record never stores the real value). Covers uninstall
 * and `--no-telemetry` too, where there is no `--token` flag to mask by. */
function maskTokens(text: string, tokens: Array<string | undefined>): string {
  return tokens.reduce<string>((acc, token) => maskToken(acc, token), text);
}

function extractExistingTelemetryToken(before: string | null): string | undefined {
  if (before === null || before.trim() === '') return undefined;
  try {
    const parsed = parseSettings(before, 'settings.local.json');
    const header = isObject(parsed.env) ? parsed.env[TELEMETRY_HEADERS_KEY] : undefined;
    const prefix = 'Authorization=Bearer ';
    return typeof header === 'string' && header.startsWith(prefix) ? header.slice(prefix.length) : undefined;
  } catch {
    return undefined;
  }
}

/** True for a handler this CLI wrote, whatever version or path wrote it. */
export function isAgentViewerHandler(handler: unknown): boolean {
  if (!handler || typeof handler !== 'object') return false;
  const h = handler as Record<string, unknown>;
  if (h.type !== 'command') return false;
  if (Array.isArray(h.args)) return h.args.includes('claude-hook') && h.args.some((arg) => typeof arg === 'string' && /agent-viewer|cli[\\/](index\.ts)|dist-cli/.test(arg));
  return typeof h.command === 'string' && /agent-viewer/.test(h.command) && /\bclaude-hook\b/.test(h.command);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Indentation used by the file, so the rewritten file keeps it. Defaults to two spaces. */
function detectIndent(text: string): string | number {
  const match = /^[ \t]+(?=")/m.exec(text);
  if (!match) return 2;
  return match[0].includes('\t') ? '\t' : match[0].length;
}

function serialize(value: JsonObject, indent: string | number, trailingNewline: boolean): string {
  return `${JSON.stringify(value, null, indent)}${trailingNewline ? '\n' : ''}`;
}

function parseSettings(text: string, file: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InstallError(`${file} is not valid JSON (${error instanceof Error ? error.message : error}). Fix it first; nothing was changed.`);
  }
  if (!isObject(parsed)) throw new InstallError(`${file} must hold a JSON object. Nothing was changed.`);
  return parsed;
}

/**
 * What a strip keeps when the removal leaves it empty: the listed event lists (as `[]`), the `hooks` object
 * (as `{}`) and the file itself (as `{}`). Everything else left empty by the removal goes.
 */
export interface Preserve {
  events?: readonly string[];
  hooks?: boolean;
  root?: boolean;
}

/** Removes Agent Viewer handlers, and the groups, events and `hooks` key left empty by that removal. */
function stripAgentViewer(settings: JsonObject, preserve: Preserve = {}): { settings: JsonObject; removed: number } {
  const copy = structuredClone(settings);
  let removed = 0;
  if (!isObject(copy.hooks)) return { settings: copy, removed };
  const hooks = copy.hooks;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept: Json[] = [];
    let touched = false;
    for (const group of groups) {
      if (isObject(group) && Array.isArray(group.hooks)) {
        const handlers = group.hooks.filter((handler) => !isAgentViewerHandler(handler));
        const dropped = group.hooks.length - handlers.length;
        if (dropped > 0) {
          removed += dropped;
          touched = true;
          if (handlers.length === 0) continue;
          kept.push({ ...group, hooks: handlers });
          continue;
        }
      }
      kept.push(group);
    }
    if (!touched) continue;
    if (kept.length === 0 && !preserve.events?.includes(event)) delete hooks[event];
    else hooks[event] = kept;
  }
  if (removed > 0 && Object.keys(hooks).length === 0 && !preserve.hooks) delete copy.hooks;
  return { settings: copy, removed };
}

export interface SettingsChange {
  file: string;
  before: string | null;
  /** `null` means the file is removed (uninstall of a file install created). */
  after: string | null;
  changed: boolean;
  summary: string;
  /** Install only: Agent Viewer handlers already in the file, replaced by this install. */
  previousHandlers?: number;
  /** Install only: hook events that already had a list, and whether `hooks` was there, before the install. */
  existing?: { events: string[]; hooks: boolean };
}

type Container = JsonNode & { kind: 'object' | 'array' };

function isContainer(node: JsonNode | undefined): node is Container {
  return node !== undefined && (node.kind === 'object' || node.kind === 'array');
}

function memberValue(node: JsonNode, key: string): JsonNode | undefined {
  return node.kind === 'object' ? node.members.find((member) => member.key === key)?.value : undefined;
}

/** Indentation for a new element of `node`, as `renderAppended` places it. */
function childIndent(text: string, node: Container, unit: string): string {
  const first = node.kind === 'object' ? node.members[node.members.length - 1]?.keyStart : node.items[node.items.length - 1]?.start;
  return first === undefined ? lineIndent(text, node.start) + unit : lineIndent(text, first);
}

/** Text edit of `stripAgentViewer`. Returns `null` text when nothing is left of the root object. */
function stripText(text: string, preserve: Preserve = {}): { text: string | null; removed: number } {
  const root = parseJsonSpans(text);
  const hooks = memberValue(root, 'hooks');
  if (root.kind !== 'object' || !hooks || hooks.kind !== 'object') return { text, removed: 0 };
  let removed = 0;
  const verbatim = (node: JsonNode) => text.slice(node.start, node.end);

  // Per event: which groups go, and how the kept groups are written.
  const renderedEvents = hooks.members.map((member) => {
    const groups = member.value;
    if (groups.kind !== 'array') return { drop: false, text: verbatim(groups) };
    const plans = groups.items.map((group) => {
      const handlers = memberValue(group, 'hooks');
      if (!handlers || handlers.kind !== 'array') return { drop: false, text: verbatim(group) };
      const ours = handlers.items.map((handler) => isAgentViewerHandler(JSON.parse(verbatim(handler))));
      const count = ours.filter(Boolean).length;
      removed += count;
      if (count === 0) return { drop: false, text: verbatim(group) };
      if (count === handlers.items.length) return { drop: true, text: '' };
      const groupNode = group as Container;
      return {
        drop: false,
        text: renderFiltered(text, groupNode, () => true, (index) => {
          const value = (groupNode.kind === 'object' ? groupNode.members[index].value : groupNode.items[index]);
          return value === handlers ? renderFiltered(text, handlers, (i) => !ours[i], (i) => verbatim(handlers.items[i])) : verbatim(value);
        }),
      };
    });
    const touched = plans.some((plan, index) => plan.text !== verbatim(groups.items[index]));
    if (!touched) return { drop: false, text: verbatim(groups) };
    const keptGroups = plans.filter((plan) => !plan.drop).length;
    if (keptGroups === 0) {
      return preserve.events?.includes(member.key)
        ? { drop: false, text: renderFiltered(text, groups, () => false, () => '') }
        : { drop: true, text: '' };
    }
    return { drop: false, text: renderFiltered(text, groups, (i) => !plans[i].drop, (i) => plans[i].text) };
  });
  if (removed === 0) return { text, removed };

  const keptEvents = renderedEvents.filter((event) => !event.drop).length;
  const dropHooks = keptEvents === 0 && !preserve.hooks;
  const hooksIndex = root.members.findIndex((member) => member.value === hooks);
  if (dropHooks && root.members.length === 1) {
    return preserve.root ? { text: `${text.slice(0, root.start)}{}${text.slice(root.end)}`, removed } : { text: null, removed };
  }
  const renderedRoot = renderFiltered(
    text,
    root,
    (index) => !(dropHooks && index === hooksIndex),
    (index) => index === hooksIndex
      ? renderFiltered(text, hooks, (i) => !renderedEvents[i].drop, (i) => renderedEvents[i].text)
      : verbatim(root.members[index].value),
  );
  return { text: text.slice(0, root.start) + renderedRoot + text.slice(root.end), removed };
}

/**
 * Runs an edit that adds new formatting bytes (fresh `\n` from `formatValue`/`renderAppended`) on text converted
 * to `\n` line endings when the file is consistently `\r\n`, then converts the result back. JSON strings cannot
 * hold raw line breaks, so the conversion only touches the layout. An edit that only removes bytes (`stripText`,
 * `stripTelemetryText`) never needs this: it never fabricates a new line ending.
 */
function withLfLineEndings(original: string, edit: (text: string) => string): string {
  const crlf = original.includes('\r\n') && original.split('\r\n').length === original.split('\n').length;
  const text = crlf ? original.replace(/\r\n/g, '\n') : original;
  const edited = edit(text);
  return crlf ? edited.replace(/\n/g, '\r\n') : edited;
}

/** Text edit of the install: appends one group per event, creating the event lists and `hooks` as needed. */
function insertText(original: string, handler: HookHandler): string {
  return withLfLineEndings(original, (text) => insertTextLf(text, handler));
}

function insertTextLf(text: string, handler: HookHandler): string {
  const root = parseJsonSpans(text);
  if (root.kind !== 'object') throw new InstallError('The settings file must hold a JSON object.');
  const unit = indentUnit(text);
  const verbatim = (node: JsonNode) => text.slice(node.start, node.end);
  const group = () => ({ hooks: [{ ...handler, args: [...handler.args] }] });
  const hooks = memberValue(root, 'hooks');

  let renderedRoot: string;
  if (!hooks) {
    const indent = childIndent(text, root, unit);
    const value = Object.fromEntries(CLAUDE_HOOK_EVENTS.map((event) => [event, [group()]]));
    renderedRoot = renderAppended(text, root, [`"hooks": ${formatValue(value, indent, unit)}`], (i) => verbatim(root.members[i].value), unit);
  } else {
    if (hooks.kind !== 'object') throw new InstallError('"hooks" is not an object.');
    const hooksIndent = childIndent(text, hooks, unit);
    const missing = CLAUDE_HOOK_EVENTS.filter((event) => !hooks.members.some((member) => member.key === event));
    const renderedHooks = renderAppended(
      text,
      hooks,
      missing.map((event) => `${JSON.stringify(event)}: ${formatValue([group()], hooksIndent, unit)}`),
      (index) => {
        const member = hooks.members[index];
        if (!(CLAUDE_HOOK_EVENTS as readonly string[]).includes(member.key)) return verbatim(member.value);
        if (!isContainer(member.value) || member.value.kind !== 'array') throw new InstallError(`"hooks.${member.key}" is not a list.`);
        const groups = member.value;
        return renderAppended(text, groups, [formatValue(group(), childIndent(text, groups, unit), unit)], (i) => verbatim(groups.items[i]), unit);
      },
      unit,
    );
    renderedRoot = renderAppended(text, root, [], (i) => (root.members[i].value === hooks ? renderedHooks : verbatim(root.members[i].value)), unit);
  }
  return text.slice(0, root.start) + renderedRoot + text.slice(root.end);
}

/** What `--telemetry` or `--no-telemetry` does to the file, decided before the diff is shown. */
export type TelemetryAction =
  | { kind: 'write'; env: Record<string, string>; helperCommand?: string }
  | { kind: 'remove'; envKeys: string[]; dropHelper: boolean; dropEnvIfEmpty: boolean };

/**
 * Adds or overwrites flat string members of an object node, keeping every other byte. A key that is not there
 * yet is appended; a key that is there with a different value is overwritten in place, without moving it; a key
 * already holding the same value is left completely untouched.
 */
function setStringMembers(text: string, node: Container & { kind: 'object' }, assignments: Record<string, string>, unit: string): string {
  const verbatim = (n: JsonNode) => text.slice(n.start, n.end);
  const overwrite = new Map<JsonNode, string>();
  const append: string[] = [];
  for (const [key, value] of Object.entries(assignments)) {
    const raw = JSON.stringify(value);
    const member = node.members.find((m) => m.key === key);
    if (!member) {
      append.push(`${JSON.stringify(key)}: ${raw}`);
    } else if (verbatim(member.value) !== raw) {
      overwrite.set(member.value, raw);
    }
  }
  if (overwrite.size === 0 && append.length === 0) return verbatim(node);
  return renderAppended(text, node, append, (i) => overwrite.get(node.members[i].value) ?? verbatim(node.members[i].value), unit);
}

/** Text edit of a telemetry write: merges `write.env` into `env` (creating it if needed) and sets
 * `otelHeadersHelper` in helper mode, exactly like `insertTextLf` nests the hooks edit inside the root edit. */
function insertTelemetryWriteText(original: string, write: TelemetryWritePlan): string {
  return withLfLineEndings(original, (text) => insertTelemetryWriteTextLf(text, write));
}

function insertTelemetryWriteTextLf(text: string, write: TelemetryWritePlan): string {
  const root = parseJsonSpans(text);
  if (root.kind !== 'object') throw new InstallError('The settings file must hold a JSON object.');
  const unit = indentUnit(text);
  const verbatim = (node: JsonNode) => text.slice(node.start, node.end);
  const envNode = memberValue(root, 'env');

  let envText: string;
  if (!envNode) {
    envText = formatValue(write.env, childIndent(text, root, unit), unit);
  } else {
    if (envNode.kind !== 'object') throw new InstallError('"env" in the settings file is not an object.');
    envText = setStringMembers(text, envNode, write.env, unit);
  }

  const rootAppend: string[] = [];
  if (!envNode) rootAppend.push(`"env": ${envText}`);
  const helperRaw = write.helperCommand !== undefined ? JSON.stringify(write.helperCommand) : undefined;
  if (helperRaw !== undefined && !memberValue(root, 'otelHeadersHelper')) rootAppend.push(`"otelHeadersHelper": ${helperRaw}`);

  const renderedRoot = renderAppended(text, root, rootAppend, (index) => {
    const member = root.members[index];
    if (member.key === 'env') return envText;
    if (member.key === 'otelHeadersHelper' && helperRaw !== undefined) return helperRaw;
    return verbatim(member.value);
  }, unit);
  return text.slice(0, root.start) + renderedRoot + text.slice(root.end);
}

/** Text edit of a telemetry removal (`--no-telemetry` or uninstall): drops exactly the `env` keys and the
 * `otelHeadersHelper` key the plan names, and nothing else. Mirrors `stripText`'s object-only case. */
function stripTelemetryText(text: string, remove: TelemetryAction & { kind: 'remove' }): { text: string; removedAny: boolean } {
  const root = parseJsonSpans(text);
  if (root.kind !== 'object') return { text, removedAny: false };
  const verbatim = (n: JsonNode) => text.slice(n.start, n.end);
  const envNode = memberValue(root, 'env');

  let envText: string | undefined;
  let dropEnvEntirely = false;
  let removedAny = false;
  if (envNode && envNode.kind === 'object' && remove.envKeys.length > 0) {
    const toDrop = new Set(remove.envKeys.filter((key) => envNode.members.some((m) => m.key === key)));
    if (toDrop.size > 0) {
      removedAny = true;
      const remaining = envNode.members.length - toDrop.size;
      dropEnvEntirely = remaining === 0 && remove.dropEnvIfEmpty;
      if (!dropEnvEntirely) {
        envText = renderFiltered(text, envNode, (i) => !toDrop.has(envNode.members[i].key), (i) => verbatim(envNode.members[i].value));
      }
    }
  }
  const dropHelperNow = remove.dropHelper && Boolean(memberValue(root, 'otelHeadersHelper'));
  if (dropHelperNow) removedAny = true;
  if (!removedAny) return { text, removedAny: false };

  const renderedRoot = renderFiltered(
    text,
    root,
    (index) => {
      const member = root.members[index];
      if (member.key === 'env' && dropEnvEntirely) return false;
      if (member.key === 'otelHeadersHelper' && dropHelperNow) return false;
      return true;
    },
    (index) => {
      const member = root.members[index];
      return member.key === 'env' && envText !== undefined ? envText : verbatim(member.value);
    },
  );
  return { text: text.slice(0, root.start) + renderedRoot + text.slice(root.end), removedAny: true };
}

/** True once every key `write.env` and (in helper mode) `otelHeadersHelper` already holds that exact value. */
function isTelemetryInstalled(settings: JsonObject, write: TelemetryWritePlan): boolean {
  const env = isObject(settings.env) ? settings.env : {};
  const envOk = Object.entries(write.env).every(([key, value]) => env[key] === value);
  const helperOk = write.helperCommand === undefined || settings.otelHeadersHelper === write.helperCommand;
  return envOk && helperOk;
}

function sameJson(text: string | null, expected: JsonObject | null): boolean {
  if (text === null || expected === null) return text === null && expected === null;
  try {
    return isDeepStrictEqual(JSON.parse(text), expected);
  } catch {
    return false;
  }
}

/** True when every hook event has exactly this handler, once, and no other Agent Viewer handler is left. */
function isInstalled(settings: JsonObject, handler: HookHandler): boolean {
  if (!isObject(settings.hooks)) return false;
  const hooks = settings.hooks;
  const oursIn = (groups: Json | undefined) => (Array.isArray(groups)
    ? groups.flatMap((group) => (isObject(group) && Array.isArray(group.hooks) ? group.hooks.filter(isAgentViewerHandler) : []))
    : []);
  let total = 0;
  for (const event of Object.keys(hooks)) total += oursIn(hooks[event]).length;
  if (total !== CLAUDE_HOOK_EVENTS.length) return false;
  return CLAUDE_HOOK_EVENTS.every((event) => {
    const ours = oursIn(hooks[event]);
    return ours.length === 1 && isDeepStrictEqual(ours[0], handler);
  });
}

/**
 * Plans the install: the current text (or `null` when the file is missing) and the text to write. `telemetry`
 * is `undefined` for a plain install (an existing telemetry block is left exactly as it is), a `'write'` action
 * for `--telemetry`, or a `'remove'` action for `--no-telemetry`.
 */
export function planInstall(before: string | null, handler: HookHandler, file = 'settings.local.json', telemetry?: TelemetryAction): SettingsChange {
  const original = before === null || before.trim() === '' ? {} : parseSettings(before, file);
  const existing = {
    events: isObject(original.hooks) ? CLAUDE_HOOK_EVENTS.filter((event) => Array.isArray((original.hooks as JsonObject)[event])) : [],
    hooks: isObject(original.hooks),
  };
  const indent = before ? detectIndent(before) : 2;
  const trailingNewline = before === null || before.trim() === '' ? true : before.endsWith('\n');

  let settings: JsonObject;
  let after: string;
  let changed: boolean;
  let previousHandlers: number;
  let summary: string;

  if (isInstalled(original, handler)) {
    settings = original;
    // `isInstalled` is only true once the file already exists with text (an empty or missing file has no
    // handlers), so `before` is a string here.
    after = before as string;
    changed = false;
    previousHandlers = CLAUDE_HOOK_EVENTS.length;
    summary = `Agent Viewer hooks are already installed in ${file}; nothing to change.`;
  } else {
    // Reinstalling replaces older Agent Viewer handlers instead of adding a second copy. The lists and the
    // `hooks` object stay in place, so the new handlers land where the old ones were.
    const keepAll: Preserve = { events: CLAUDE_HOOK_EVENTS, hooks: true, root: true };
    const stripped = stripAgentViewer(original, keepAll);
    settings = stripped.settings;
    previousHandlers = stripped.removed;
    if (settings.hooks !== undefined && !isObject(settings.hooks)) {
      throw new InstallError(`"hooks" in ${file} is not an object. Nothing was changed.`);
    }
    const hooks: JsonObject = isObject(settings.hooks) ? settings.hooks : {};
    for (const event of CLAUDE_HOOK_EVENTS) {
      const existingList = hooks[event];
      if (existingList !== undefined && !Array.isArray(existingList)) {
        throw new InstallError(`"hooks.${event}" in ${file} is not a list. Nothing was changed.`);
      }
      const group: JsonObject = { hooks: [{ ...handler, args: [...handler.args] }] };
      hooks[event] = [...(existingList ?? []), group];
    }
    settings.hooks = hooks;

    // Text edit first, so the user's formatting survives; the parsed result must match the planned settings.
    after = serialize(settings, indent, trailingNewline);
    if (before !== null && before.trim() !== '') {
      try {
        const base = stripText(before, keepAll).text;
        const edited = base === null ? null : insertText(base, handler);
        if (edited !== null && sameJson(edited, settings)) after = edited;
      } catch {
        // Unusual layout: fall back to the re-serialized file.
      }
    }
    changed = after !== before;
    summary = !changed
      ? `Agent Viewer hooks are already installed in ${file}; nothing to change.`
      : previousHandlers > 0
        ? `Updates the Agent Viewer hook on ${CLAUDE_HOOK_EVENTS.length} Claude Code events: ${CLAUDE_HOOK_EVENTS.join(', ')}.`
        : `Adds an Agent Viewer hook to ${CLAUDE_HOOK_EVENTS.length} Claude Code events: ${CLAUDE_HOOK_EVENTS.join(', ')}.`;
  }

  if (!telemetry) {
    return { file, before, after, changed, summary, previousHandlers, existing };
  }

  let telemetryChanged = false;
  let finalAfter = after;
  if (telemetry.kind === 'write') {
    telemetryChanged = !isTelemetryInstalled(settings, telemetry);
    if (telemetryChanged) {
      const currentEnv = isObject(settings.env) ? settings.env : {};
      const finalSettings: JsonObject = {
        ...settings,
        env: { ...currentEnv, ...telemetry.env },
        ...(telemetry.helperCommand !== undefined ? { otelHeadersHelper: telemetry.helperCommand } : {}),
      };
      try {
        const edited = insertTelemetryWriteText(after, telemetry);
        finalAfter = sameJson(edited, finalSettings) ? edited : serialize(finalSettings, indent, trailingNewline);
      } catch {
        finalAfter = serialize(finalSettings, indent, trailingNewline);
      }
    }
  } else {
    const { text: stripped, removedAny } = stripTelemetryText(after, telemetry);
    telemetryChanged = removedAny;
    if (removedAny) {
      const finalSettings: JsonObject = structuredClone(settings);
      if (isObject(finalSettings.env)) {
        for (const key of telemetry.envKeys) delete finalSettings.env[key];
        if (telemetry.dropEnvIfEmpty && Object.keys(finalSettings.env).length === 0) delete finalSettings.env;
      }
      if (telemetry.dropHelper) delete finalSettings.otelHeadersHelper;
      finalAfter = sameJson(stripped, finalSettings) ? stripped : serialize(finalSettings, indent, trailingNewline);
    }
  }

  const finalChanged = changed || telemetryChanged;
  const telemetryNote = telemetry.kind === 'write'
    ? (telemetryChanged ? 'Telemetry: on.' : 'Telemetry: on (unchanged).')
    : (telemetryChanged ? 'Telemetry: off.' : undefined);
  return {
    file,
    before,
    after: finalChanged ? finalAfter : after,
    changed: finalChanged,
    summary: telemetryNote ? `${summary}\n${telemetryNote}` : summary,
    previousHandlers,
    existing,
  };
}

/**
 * Plans the uninstall. `record` is what install noted about the file; without one, nothing that might have been
 * there before is removed: the file stays (as `{}` at worst) and so does the folder. `telemetry`, when given,
 * is applied on top: uninstall always removes the telemetry block together with the hooks.
 */
export function planUninstall(before: string | null, file = 'settings.local.json', record?: InstallRecord, telemetry?: TelemetryAction & { kind: 'remove' }): SettingsChange {
  if (before === null) {
    return { file, before, after: null, changed: false, summary: 'Agent Viewer hooks are not installed (no settings file).' };
  }
  const original = parseSettings(before, file);
  const preserve: Preserve = record
    ? { events: record.events, hooks: record.hooks, root: !record.createdFile }
    : { root: true };
  const { settings, removed } = stripAgentViewer(original, preserve);
  const hooksRemoved = removed > 0;
  const workingSettings: JsonObject = hooksRemoved ? settings : original;
  let after: string | null = hooksRemoved
    ? (Object.keys(workingSettings).length === 0 && !preserve.root ? null : serialize(workingSettings, detectIndent(before), before.endsWith('\n')))
    : before;
  if (hooksRemoved) {
    try {
      const edited = stripText(before, preserve).text;
      if (sameJson(edited, after === null ? null : workingSettings)) after = edited;
    } catch {
      // Unusual layout: fall back to the re-serialized file.
    }
  }

  let telemetryChanged = false;
  if (telemetry && after !== null) {
    const { text: stripped, removedAny } = stripTelemetryText(after, telemetry);
    telemetryChanged = removedAny;
    if (removedAny) {
      const finalSettings: JsonObject = structuredClone(workingSettings);
      if (isObject(finalSettings.env)) {
        for (const key of telemetry.envKeys) delete finalSettings.env[key];
        if (telemetry.dropEnvIfEmpty && Object.keys(finalSettings.env).length === 0) delete finalSettings.env;
      }
      if (telemetry.dropHelper) delete finalSettings.otelHeadersHelper;
      after = sameJson(stripped, finalSettings) ? stripped : serialize(finalSettings, detectIndent(before), before.endsWith('\n'));
    }
  }

  if (!hooksRemoved && !telemetryChanged) {
    return { file, before, after: before, changed: false, summary: 'Agent Viewer hooks are not installed in this file.' };
  }
  const handlers = `${removed} Agent Viewer hook handler${removed === 1 ? '' : 's'}`;
  const parts = [hooksRemoved ? `Removes ${handlers}.` : undefined, telemetryChanged ? 'Removes the telemetry block.' : undefined].filter(Boolean);
  return {
    file,
    before,
    after,
    changed: true,
    summary: after === null ? `Removes ${handlers}, and the settings file install created.` : parts.join(' '),
  };
}

/** A small line diff (longest common subsequence), enough to show a settings change before writing it. */
export function lineDiff(before: string | null, after: string | null): string {
  const a = before === null ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === null ? [] : after.replace(/\n$/, '').split('\n');
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push(`+ ${b[j]}`);
      j++;
    } else {
      out.push(`- ${a[i]}`);
      i++;
    }
  }
  return out.join('\n');
}

function readIfExists(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/**
 * Writes a file through a temporary file in the same folder and a rename, so a reader never sees half a file.
 * A symbolic link is followed (the link stays a link) and the file keeps its permissions.
 */
export function writeFileAtomic(file: string, text: string): void {
  let target = file;
  try {
    target = realpathSync(file);
  } catch {
    // New file.
  }
  let mode: number | undefined;
  try {
    mode = statSync(target).mode & 0o777;
  } catch {
    // New file: the usual permissions.
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, text, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    if (mode !== undefined) chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** What install noted about a settings file, so uninstall removes only what install added. */
export interface InstallRecord {
  /** The settings file did not exist before the install. */
  createdFile: boolean;
  /** The `.claude/` folder did not exist before the install. */
  createdDir: boolean;
  /** Hook events that already had a list (possibly empty) before the install. */
  events: string[];
  /** The `hooks` object was there before the install. */
  hooks: boolean;
  /** Present once `--telemetry` has installed the block at least once. Absent for records from before 0.3.0. */
  telemetry?: {
    /** The `env` object existed before telemetry was installed. */
    envExisted: boolean;
    /** Managed env keys (and `otelHeadersHelper`) that already held exactly the value install would write: kept by uninstall, not treated as ours. */
    preexistingKeys: string[];
    /** Keys and the helper command Agent Viewer wrote, with the values it wrote. The token itself is never
     * stored: the header key's value is the sentinel `"<secret>"`, matched by key (and prefix) on removal. */
    written: Record<string, string>;
  };
}

export function installRecordsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), 'claude-code-installs.json');
}

function readInstallRecords(env: NodeJS.ProcessEnv): Record<string, InstallRecord> {
  try {
    const parsed = JSON.parse(readFileSync(installRecordsPath(env), 'utf8'));
    return isObject(parsed) && isObject(parsed.installs) ? (parsed.installs as unknown as Record<string, InstallRecord>) : {};
  } catch {
    return {};
  }
}

function isInstallRecord(value: unknown): value is InstallRecord {
  if (!isObject(value)) return false;
  if (!(typeof value.createdFile === 'boolean' && typeof value.createdDir === 'boolean' && typeof value.hooks === 'boolean'
    && Array.isArray(value.events) && value.events.every((event) => typeof event === 'string'))) return false;
  if (value.telemetry === undefined) return true;
  const telemetry = value.telemetry;
  return isObject(telemetry) && typeof telemetry.envExisted === 'boolean'
    && Array.isArray(telemetry.preexistingKeys) && telemetry.preexistingKeys.every((k) => typeof k === 'string')
    && isObject(telemetry.written) && Object.values(telemetry.written).every((v) => typeof v === 'string');
}

export function readInstallRecord(file: string, env: NodeJS.ProcessEnv = process.env): InstallRecord | undefined {
  const record = readInstallRecords(env)[path.resolve(file)];
  return isInstallRecord(record) ? record : undefined;
}

/** Saves (or, with `undefined`, forgets) the record of one settings file. Owner-only permissions. */
export function writeInstallRecord(file: string, record: InstallRecord | undefined, env: NodeJS.ProcessEnv = process.env): void {
  const records = readInstallRecords(env);
  const key = path.resolve(file);
  if (record) records[key] = record;
  else if (key in records) delete records[key];
  else return;
  const target = installRecordsPath(env);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!existsSync(target)) writeFileSync(target, '', { mode: 0o600 });
  writeFileAtomic(target, `${JSON.stringify({ version: 1, installs: records }, null, 2)}\n`);
}

/** Writes the planned change. Creates `.claude/` when needed; removes it on uninstall only if install created it. */
export function applyChange(project: string, change: SettingsChange, record?: InstallRecord): void {
  const file = settingsPath(project);
  const dir = path.dirname(file);
  if (change.after === null) {
    rmSync(file, { force: true });
    if (record?.createdDir && existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    return;
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileAtomic(file, change.after);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export interface InstallDeps {
  /** Asks the question and resolves to the answer. Default: a prompt on the terminal, when there is one. */
  confirm?: (question: string) => Promise<boolean>;
  /** Environment for the state folder (`AGENT_VIEWER_HOME`). Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Overrides the probe's fetch, for tests. Default: the global `fetch`. */
  fetch?: typeof fetch;
}

function readJsonObjectIfExists(file: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** What install records about a freshly written telemetry block, so uninstall removes only what it wrote. */
function computeTelemetryRecordSnapshot(before: string | null, write: TelemetryWritePlan): NonNullable<InstallRecord['telemetry']> {
  let original: JsonObject = {};
  if (before !== null && before.trim() !== '') {
    try {
      original = parseSettings(before, 'settings.local.json');
    } catch {
      // Already rejected earlier in runInstall; keep the snapshot empty rather than throw twice.
    }
  }
  const originalEnv = isObject(original.env) ? original.env : {};
  const preexistingKeys: string[] = [];
  const written: Record<string, string> = {};
  for (const [key, value] of Object.entries(write.env)) {
    if (originalEnv[key] === value) preexistingKeys.push(key);
    else written[key] = key === TELEMETRY_HEADERS_KEY ? '<secret>' : value;
  }
  if (write.helperCommand !== undefined) {
    if (original.otelHeadersHelper === write.helperCommand) preexistingKeys.push('otelHeadersHelper');
    else written.otelHeadersHelper = write.helperCommand;
  }
  return { envExisted: isObject(original.env), preexistingKeys, written };
}

/** What `--no-telemetry` or `uninstall` should remove, from the record when there is one, conservatively without. */
function computeTelemetryRemoval(before: string | null, record?: InstallRecord): TelemetryAction & { kind: 'remove' } {
  const none: TelemetryAction & { kind: 'remove' } = { kind: 'remove', envKeys: [], dropHelper: false, dropEnvIfEmpty: false };
  if (before === null || before.trim() === '') return none;
  let original: JsonObject;
  try {
    original = parseSettings(before, 'settings.local.json');
  } catch {
    return none;
  }
  const originalEnv = isObject(original.env) ? original.env : {};
  const envKeys: string[] = [];
  if (record?.telemetry) {
    for (const [key, expected] of Object.entries(record.telemetry.written)) {
      if (key === 'otelHeadersHelper') continue;
      const current = originalEnv[key];
      const ok = expected === '<secret>'
        ? typeof current === 'string' && current.startsWith('Authorization=Bearer ')
        : current === expected;
      if (ok) envKeys.push(key);
    }
    const helperExpected = record.telemetry.written.otelHeadersHelper;
    return {
      kind: 'remove',
      envKeys,
      dropHelper: helperExpected !== undefined && original.otelHeadersHelper === helperExpected,
      dropEnvIfEmpty: record.telemetry.envExisted === false,
    };
  }
  // Without a record (another machine, or the record was deleted): only the mode- and endpoint-independent
  // constants are safe to recognize as ours. The endpoint, the header and the helper are install-specific, so
  // they are left alone rather than guessed at.
  const invariant: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    ...Object.fromEntries(TELEMETRY_CONTENT_FLAGS.map((flag) => [flag, '0'])),
  };
  for (const [key, expected] of Object.entries(invariant)) {
    if (originalEnv[key] === expected) envKeys.push(key);
  }
  return { kind: 'remove', envKeys, dropHelper: false, dropEnvIfEmpty: false };
}

export interface TelemetryConflicts {
  refusals: string[];
  warnings: string[];
}

/**
 * The safety checks of Proposal 4: run before the diff is shown, with everything the installer is ever allowed
 * to read (this file, the project's shared settings, the user's settings, `process.env`), never written. A
 * refusal stops the install; a warning is shown above the diff and still asks for confirmation.
 */
export function checkTelemetryConflicts(options: {
  before: string | null;
  file: string;
  project: string;
  mode: 'helper' | 'static';
  endpoint: string;
  env: NodeJS.ProcessEnv;
  record?: InstallRecord;
}): TelemetryConflicts {
  const refusals: string[] = [];
  const warnings: string[] = [];
  const localSettings = options.before !== null && options.before.trim() !== ''
    ? (() => { try { return parseSettings(options.before as string, options.file); } catch { return undefined; } })()
    : undefined;
  const sharedFile = path.join(options.project, '.claude', 'settings.json');
  const userFile = path.join(os.homedir(), '.claude', 'settings.json');
  const shared = readJsonObjectIfExists(sharedFile);
  const user = readJsonObjectIfExists(userFile);
  const localEnv = isObject(localSettings?.env) ? localSettings.env : {};
  const sharedEnv = isObject(shared?.env) ? shared.env : {};
  const userEnv = isObject(user?.env) ? user.env : {};
  const written = options.record?.telemetry?.written ?? {};
  const preexisting = new Set(options.record?.telemetry?.preexistingKeys ?? []);

  // Refuse: a managed key already in settings.local.json with a different value install did not write.
  for (const key of TELEMETRY_ENV_KEYS) {
    const current = localEnv[key];
    if (current === undefined) continue;
    const ours = written[key];
    const recognizedAsOurs = preexisting.has(key) || (ours !== undefined && (ours === '<secret>' || ours === current));
    if (!recognizedAsOurs) refusals.push(`"env.${key}" is already set to a different value in ${options.file}. Remove it, or run "uninstall claude-code" first.`);
  }

  // Refuse: prompt or content logging is already on in the file install is about to edit.
  for (const flag of TELEMETRY_CONTENT_FLAGS) {
    if (isTruthyFlag(localEnv[flag])) {
      refusals.push(`prompt or content logging is on in ${options.file} ("env.${flag}"); Agent Viewer will not export telemetry with it.`);
    }
  }

  if (options.mode === 'helper') {
    // Refuse: a helper is already configured by someone else (not a previous Agent Viewer install).
    const existingHelper = localSettings?.otelHeadersHelper ?? shared?.otelHeadersHelper ?? user?.otelHeadersHelper ?? options.env.otelHeadersHelper;
    if (typeof existingHelper === 'string' && existingHelper !== written.otelHeadersHelper && !preexisting.has('otelHeadersHelper')) {
      refusals.push('"otelHeadersHelper" is already set outside Agent Viewer. Use --token instead, or remove it first.');
    }
    // Refuse: another OTLP exporter would also receive the helper's headers (they are not signal-scoped).
    const otherExporter = (value: unknown) => typeof value === 'string' && value.toLowerCase().includes('otlp');
    const metricsExporter = localEnv.OTEL_METRICS_EXPORTER ?? sharedEnv.OTEL_METRICS_EXPORTER ?? userEnv.OTEL_METRICS_EXPORTER ?? options.env.OTEL_METRICS_EXPORTER;
    const tracesExporter = localEnv.OTEL_TRACES_EXPORTER ?? sharedEnv.OTEL_TRACES_EXPORTER ?? userEnv.OTEL_TRACES_EXPORTER ?? options.env.OTEL_TRACES_EXPORTER;
    if (otherExporter(metricsExporter) || otherExporter(tracesExporter)) {
      refusals.push('another OTLP exporter (metrics or traces) is already configured; its backend would also receive the office token through the shared helper headers. Use --token instead.');
    }
  }

  // Warn: a logs exporter or endpoint already points somewhere else in settings this install does not manage.
  // The endpoint, when there is one, names the message; otherwise the exporter name alone is still worth a note.
  const elsewhereEndpoint = sharedEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? userEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
    ?? sharedEnv.OTEL_EXPORTER_OTLP_ENDPOINT ?? userEnv.OTEL_EXPORTER_OTLP_ENDPOINT;
  const elsewhereExporter = sharedEnv.OTEL_LOGS_EXPORTER ?? userEnv.OTEL_LOGS_EXPORTER;
  if (typeof elsewhereEndpoint === 'string' && elsewhereEndpoint.trim() !== '') {
    warnings.push(`Claude Code logs for this project will go to the office instead of "${elsewhereEndpoint}" (set outside settings.local.json).`);
  } else if (typeof elsewhereExporter === 'string' && elsewhereExporter.trim() !== '' && elsewhereExporter.toLowerCase() !== 'otlp') {
    warnings.push(`Claude Code already has the "${elsewhereExporter}" logs exporter configured outside settings.local.json; this project overrides it.`);
  }

  // Warn: a content flag is on in settings this install's pin overrides, but the user should know it is there.
  for (const flag of TELEMETRY_CONTENT_FLAGS) {
    if (isTruthyFlag(sharedEnv[flag]) || isTruthyFlag(userEnv[flag]) || isTruthyFlag(options.env[flag])) {
      warnings.push(`"${flag}" is on outside settings.local.json; this project pins it to "0", so the export will not carry it.`);
    }
  }

  if (options.mode === 'static') {
    try {
      const endpointUrl = new URL(options.endpoint);
      const loopback = endpointUrl.hostname === '127.0.0.1' || endpointUrl.hostname === 'localhost' || endpointUrl.hostname === '::1';
      if (endpointUrl.protocol === 'http:' && !loopback) {
        warnings.push(`the endpoint is plain http to ${endpointUrl.hostname}; the token travels in clear text on that network.`);
      }
    } catch {
      // Already validated as a URL by `resolveTelemetryEndpoint`; ignore here.
    }
  }

  return { refusals, warnings };
}

/** Sends one empty OTLP export so `install --telemetry` can tell the user whether an office is listening. */
export async function probeTelemetryReceiver(
  endpoint: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ resourceLogs: [] }),
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok) return 'Telemetry receiver OK';
    if (response.status === 401) return 'Telemetry: the office answered 401, check the token';
    if (response.status === 404 || response.status === 405) return `Telemetry: no OTLP receiver at ${endpoint} (office older than 0.3.0?)`;
    return `Telemetry: the office answered ${response.status}`;
  } catch {
    return 'Telemetry: office not running; start it before your next Claude Code session';
  }
}

/** Runs `install claude-code` or `uninstall claude-code`. Returns the process exit code. */
export async function runInstall(command: InstallCommand, deps: InstallDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  if (!existsSync(command.project)) {
    console.error(`agent-viewer: project folder not found: ${command.project}`);
    return 1;
  }
  const file = settingsPath(command.project);
  const dirExisted = existsSync(path.dirname(file));
  const before = readIfExists(file);
  const record = readInstallRecord(file, env);
  // Every token a diff could possibly show: the one `--token` is about to write, and whatever static-mode token
  // is already in the file (read straight from it; the install record never keeps the real value). Covers
  // uninstall and `--no-telemetry` too, which take no `--token` flag of their own.
  const knownTokens = [command.token, extractExistingTelemetryToken(before)];
  const mask = (text: string) => maskTokens(text, knownTokens);

  let telemetryWrite: TelemetryWritePlan | undefined;
  let telemetryEndpoint: string | undefined;
  let telemetryMode: 'helper' | 'static' | undefined;
  let telemetryRemoval: (TelemetryAction & { kind: 'remove' }) | undefined;
  let telemetryWarnings: string[] = [];

  if (command.command === 'install' && command.telemetry === true) {
    telemetryEndpoint = resolveTelemetryEndpoint(command.url, env);
    telemetryMode = command.token ? 'static' : 'helper';
    const conflicts = checkTelemetryConflicts({
      before, file, project: command.project, mode: telemetryMode, endpoint: telemetryEndpoint, env, record,
    });
    if (conflicts.refusals.length > 0) {
      for (const message of conflicts.refusals) console.error(mask(`agent-viewer: ${message}`));
      console.error('Nothing was changed.');
      return 1;
    }
    telemetryWarnings = conflicts.warnings;
    telemetryWrite = buildTelemetryWritePlan({ endpoint: telemetryEndpoint, token: command.token });
  } else if (command.command === 'install' && command.telemetry === false) {
    telemetryRemoval = computeTelemetryRemoval(before, record);
  } else if (command.command === 'uninstall') {
    telemetryRemoval = computeTelemetryRemoval(before, record);
  }

  let change: SettingsChange;
  try {
    change = command.command === 'install'
      ? planInstall(before, buildHookHandler(command), file, telemetryWrite ? { kind: 'write', ...telemetryWrite } : telemetryRemoval)
      : planUninstall(before, file, record, telemetryRemoval);
  } catch (error) {
    console.error(`agent-viewer: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  // One empty OTLP export, so the user learns right away whether the office will actually receive anything. It
  // never changes the exit code; it runs after a write and also when telemetry was already on (the "nothing to
  // change" path below).
  const runProbe = async () => {
    if (!telemetryEndpoint || !telemetryMode) return;
    const headers = telemetryMode === 'static' && command.token
      ? { Authorization: `Bearer ${command.token}` }
      : resolveTelemetryHeaders(telemetryEndpoint, env);
    console.log(await probeTelemetryReceiver(telemetryEndpoint, headers, deps.fetch ?? fetch));
    console.log('Start a new Claude Code session for the telemetry variables to take effect.');
  };

  if (!change.changed) {
    console.log(mask(change.summary));
    await runProbe();
    return 0;
  }

  if (telemetryWarnings.length > 0) {
    console.log('Telemetry notes:');
    for (const message of telemetryWarnings) console.log(`- ${mask(message)}`);
    console.log('');
  }
  console.log(`${mask(change.summary)}\n`);
  console.log(`File: ${file}${before === null ? ' (new file)' : change.after === null ? ' (removed: install created it)' : ''}\n`);
  console.log(mask(lineDiff(change.before, change.after)));
  console.log('');
  if (command.command === 'install' && command.token) {
    console.log('Note: the token is stored in this file. Claude Code keeps settings.local.json out of git, check that yours does too.\n');
  }

  if (!command.yes) {
    const ask = deps.confirm ?? (process.stdin.isTTY ? confirm : undefined);
    if (!ask) {
      console.error('agent-viewer: nothing was written. Run again with --yes to apply this change.');
      return 1;
    }
    const ok = await ask('Apply this change? [y/N] ');
    if (!ok) {
      console.log('Nothing was written.');
      return 1;
    }
  }

  // The plan was made from the text read above. If the file changed meanwhile (an editor, Claude Code itself),
  // writing the plan would undo that change, so nothing is written.
  let current: string | null;
  try {
    current = readIfExists(file);
  } catch (error) {
    console.error(`agent-viewer: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  if (current !== before) {
    console.error(`agent-viewer: ${file} changed while waiting for confirmation. Nothing was written; run the command again.`);
    return 1;
  }

  try {
    applyChange(command.project, change, command.command === 'uninstall' ? record : undefined);
  } catch (error) {
    console.error(`agent-viewer: could not write ${file}: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  // The record: a first install notes what was there before; a reinstall keeps the first note; uninstall forgets
  // it. Telemetry's own "what was there before" is captured the first time `--telemetry` installs the block,
  // independently of the hooks note, and kept the same way across telemetry reinstalls.
  const hooksFirstInstall = command.command === 'install' && !change.previousHandlers;
  const telemetryFirstInstall = Boolean(telemetryWrite) && !record?.telemetry;
  const telemetryCleared = Boolean(telemetryRemoval) && Boolean(record?.telemetry) && command.command !== 'uninstall';
  try {
    if (command.command === 'uninstall') {
      writeInstallRecord(file, undefined, env);
    } else if (hooksFirstInstall || telemetryFirstInstall || telemetryCleared) {
      writeInstallRecord(file, {
        createdFile: hooksFirstInstall ? before === null : (record?.createdFile ?? false),
        createdDir: hooksFirstInstall ? !dirExisted : (record?.createdDir ?? false),
        events: hooksFirstInstall ? (change.existing?.events ?? []) : (record?.events ?? []),
        hooks: hooksFirstInstall ? (change.existing?.hooks ?? false) : (record?.hooks ?? false),
        telemetry: telemetryCleared
          ? undefined
          : telemetryFirstInstall && telemetryWrite
            ? computeTelemetryRecordSnapshot(before, telemetryWrite)
            : record?.telemetry,
      }, env);
    }
  } catch {
    if (command.command === 'install') {
      console.log(`Note: could not save the install record in ${installRecordsPath(env)}; uninstall will keep ${file}.`);
    }
  }

  if (command.command === 'install') {
    console.log(`Done. Start the office with "npx @warlockcode/agent-viewer", then use Claude Code in ${command.project}.`);
    console.log('Undo at any time with "npx @warlockcode/agent-viewer uninstall claude-code".');
  } else {
    console.log('Done. Agent Viewer hooks removed.');
  }

  await runProbe();
  return 0;
}
