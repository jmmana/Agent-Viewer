import { randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { isDeepStrictEqual } from 'node:util';
import type { InstallCommand } from './args.ts';
import { CLAUDE_HOOK_EVENTS } from './claudeHook.ts';
import { stateDir } from './connection.ts';
import { formatValue, indentUnit, lineIndent, parseJsonSpans, renderAppended, renderFiltered, type JsonNode } from './jsonText.ts';
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

/** Text edit of the install: appends one group per event, creating the event lists and `hooks` as needed. */
function insertText(original: string, handler: HookHandler): string {
  // A file with Windows line endings throughout is edited with `\n` and converted back. JSON strings cannot
  // hold raw line breaks, so the conversion only touches the layout.
  const crlf = original.includes('\r\n') && original.split('\r\n').length === original.split('\n').length;
  const text = crlf ? original.replace(/\r\n/g, '\n') : original;
  const edited = insertTextLf(text, handler);
  return crlf ? edited.replace(/\n/g, '\r\n') : edited;
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

/** Plans the install: the current text (or `null` when the file is missing) and the text to write. */
export function planInstall(before: string | null, handler: HookHandler, file = 'settings.local.json'): SettingsChange {
  const original = before === null || before.trim() === '' ? {} : parseSettings(before, file);
  const existing = {
    events: isObject(original.hooks) ? CLAUDE_HOOK_EVENTS.filter((event) => Array.isArray((original.hooks as JsonObject)[event])) : [],
    hooks: isObject(original.hooks),
  };
  if (isInstalled(original, handler)) {
    return {
      file,
      before,
      after: before,
      changed: false,
      summary: `Agent Viewer hooks are already installed in ${file}; nothing to change.`,
      previousHandlers: CLAUDE_HOOK_EVENTS.length,
      existing,
    };
  }
  const indent = before ? detectIndent(before) : 2;
  const trailingNewline = before === null || before.trim() === '' ? true : before.endsWith('\n');
  // Reinstalling replaces older Agent Viewer handlers instead of adding a second copy. The lists and the
  // `hooks` object stay in place, so the new handlers land where the old ones were.
  const keepAll: Preserve = { events: CLAUDE_HOOK_EVENTS, hooks: true, root: true };
  const { settings, removed: previousHandlers } = stripAgentViewer(original, keepAll);
  if (settings.hooks !== undefined && !isObject(settings.hooks)) {
    throw new InstallError(`"hooks" in ${file} is not an object. Nothing was changed.`);
  }
  const hooks: JsonObject = isObject(settings.hooks) ? settings.hooks : {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new InstallError(`"hooks.${event}" in ${file} is not a list. Nothing was changed.`);
    }
    const group: JsonObject = { hooks: [{ ...handler, args: [...handler.args] }] };
    hooks[event] = [...(existing ?? []), group];
  }
  settings.hooks = hooks;

  // Text edit first, so the user's formatting survives; the parsed result must match the planned settings.
  let after = serialize(settings, indent, trailingNewline);
  if (before !== null && before.trim() !== '') {
    try {
      const base = stripText(before, keepAll).text;
      const edited = base === null ? null : insertText(base, handler);
      if (edited !== null && sameJson(edited, settings)) after = edited;
    } catch {
      // Unusual layout: fall back to the re-serialized file.
    }
  }
  const changed = after !== before;
  return {
    file,
    before,
    after,
    changed,
    summary: !changed
      ? `Agent Viewer hooks are already installed in ${file}; nothing to change.`
      : previousHandlers > 0
        ? `Updates the Agent Viewer hook on ${CLAUDE_HOOK_EVENTS.length} Claude Code events: ${CLAUDE_HOOK_EVENTS.join(', ')}.`
        : `Adds an Agent Viewer hook to ${CLAUDE_HOOK_EVENTS.length} Claude Code events: ${CLAUDE_HOOK_EVENTS.join(', ')}.`,
    previousHandlers,
    existing,
  };
}

/**
 * Plans the uninstall. `record` is what install noted about the file; without one, nothing that might have been
 * there before is removed: the file stays (as `{}` at worst) and so does the folder.
 */
export function planUninstall(before: string | null, file = 'settings.local.json', record?: InstallRecord): SettingsChange {
  if (before === null) {
    return { file, before, after: null, changed: false, summary: 'Agent Viewer hooks are not installed (no settings file).' };
  }
  const original = parseSettings(before, file);
  const preserve: Preserve = record
    ? { events: record.events, hooks: record.hooks, root: !record.createdFile }
    : { root: true };
  const { settings, removed } = stripAgentViewer(original, preserve);
  if (removed === 0) {
    return { file, before, after: before, changed: false, summary: 'Agent Viewer hooks are not installed in this file.' };
  }
  const expected = Object.keys(settings).length === 0 && !preserve.root ? null : settings;
  let after = expected === null ? null : serialize(settings, detectIndent(before), before.endsWith('\n'));
  try {
    const edited = stripText(before, preserve).text;
    if (sameJson(edited, expected)) after = edited;
  } catch {
    // Unusual layout: fall back to the re-serialized file.
  }
  const handlers = `${removed} Agent Viewer hook handler${removed === 1 ? '' : 's'}`;
  return {
    file,
    before,
    after,
    changed: true,
    summary: after === null ? `Removes ${handlers}, and the settings file install created.` : `Removes ${handlers}.`,
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
  return typeof value.createdFile === 'boolean' && typeof value.createdDir === 'boolean' && typeof value.hooks === 'boolean'
    && Array.isArray(value.events) && value.events.every((event) => typeof event === 'string');
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
  let change: SettingsChange;
  try {
    change = command.command === 'install'
      ? planInstall(before, buildHookHandler(command), file)
      : planUninstall(before, file, record);
  } catch (error) {
    console.error(`agent-viewer: ${error instanceof Error ? error.message : error}`);
    return 1;
  }

  if (!change.changed) {
    console.log(change.summary);
    return 0;
  }

  console.log(`${change.summary}\n`);
  console.log(`File: ${file}${before === null ? ' (new file)' : change.after === null ? ' (removed: install created it)' : ''}\n`);
  console.log(lineDiff(change.before, change.after));
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

  // The record: a first install notes what was there before; a reinstall keeps the first note; uninstall forgets it.
  try {
    if (command.command === 'uninstall') {
      writeInstallRecord(file, undefined, env);
    } else if (!change.previousHandlers) {
      writeInstallRecord(file, {
        createdFile: before === null,
        createdDir: !dirExisted,
        events: change.existing?.events ?? [],
        hooks: change.existing?.hooks ?? false,
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
  return 0;
}
