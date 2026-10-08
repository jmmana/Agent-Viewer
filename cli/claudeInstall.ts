import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { isDeepStrictEqual } from 'node:util';
import type { InstallCommand } from './args.ts';
import { CLAUDE_HOOK_EVENTS } from './claudeHook.ts';
import { formatValue, indentUnit, lineIndent, parseJsonSpans, renderAppended, renderFiltered, type JsonNode } from './jsonText.ts';
import { cliScriptPath } from './packageInfo.ts';

/**
 * `agent-viewer install claude-code` and `uninstall claude-code`.
 *
 * Only `<project>/.claude/settings.local.json` is ever written: the per-project, per-machine settings file
 * Claude Code keeps out of git. The user settings in `~/.claude` are never touched. The change is shown first
 * and applied only after confirmation (or `--yes`). The file is edited as text: install appends its handlers
 * and leaves every other byte alone, and uninstall removes exactly what install appended, so the file comes
 * back byte for byte. Each text edit is checked against the same change made on the parsed JSON.
 */

export interface HookHandler {
  type: 'command';
  command: string;
  args: string[];
  timeout: number;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

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
  // The hook stops itself after half a second; the timeout is only a safety net for Claude Code.
  return { type: 'command', command: options.nodePath ?? process.execPath, args, timeout: 5 };
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

/** Removes Agent Viewer handlers, and the groups, events and `hooks` key left empty by that removal. */
function stripAgentViewer(settings: JsonObject): { settings: JsonObject; removed: number } {
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
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (removed > 0 && Object.keys(hooks).length === 0) delete copy.hooks;
  return { settings: copy, removed };
}

export interface SettingsChange {
  file: string;
  before: string | null;
  /** `null` means the file is removed (uninstall of a file install created). */
  after: string | null;
  changed: boolean;
  summary: string;
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
function stripText(text: string): { text: string | null; removed: number } {
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
    if (keptGroups === 0) return { drop: true, text: '' };
    return { drop: false, text: renderFiltered(text, groups, (i) => !plans[i].drop, (i) => plans[i].text) };
  });
  if (removed === 0) return { text, removed };

  const keptEvents = renderedEvents.filter((event) => !event.drop).length;
  const dropHooks = keptEvents === 0;
  const hooksIndex = root.members.findIndex((member) => member.value === hooks);
  if (dropHooks && root.members.length === 1) return { text: null, removed };
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

/** Plans the install: the current text (or `null` when the file is missing) and the text to write. */
export function planInstall(before: string | null, handler: HookHandler, file = 'settings.local.json'): SettingsChange {
  const original = before === null || before.trim() === '' ? {} : parseSettings(before, file);
  const indent = before ? detectIndent(before) : 2;
  const trailingNewline = before === null || before.trim() === '' ? true : before.endsWith('\n');
  // Reinstalling replaces older Agent Viewer handlers instead of adding a second copy.
  const { settings } = stripAgentViewer(original);
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
      const base = stripText(before).text;
      const edited = base === null ? null : insertText(base, handler);
      if (edited !== null && sameJson(edited, settings)) after = edited;
    } catch {
      // Unusual layout: fall back to the re-serialized file.
    }
  }
  return {
    file,
    before,
    after,
    changed: after !== before,
    summary: `Adds an Agent Viewer hook to ${CLAUDE_HOOK_EVENTS.length} Claude Code events: ${CLAUDE_HOOK_EVENTS.join(', ')}.`,
  };
}

/** Plans the uninstall. When install created the file and nothing else is left, the file is removed. */
export function planUninstall(before: string | null, file = 'settings.local.json'): SettingsChange {
  if (before === null) {
    return { file, before, after: null, changed: false, summary: 'Agent Viewer hooks are not installed (no settings file).' };
  }
  const original = parseSettings(before, file);
  const { settings, removed } = stripAgentViewer(original);
  if (removed === 0) {
    return { file, before, after: before, changed: false, summary: 'Agent Viewer hooks are not installed in this file.' };
  }
  const expected = Object.keys(settings).length === 0 ? null : settings;
  let after = expected === null ? null : serialize(settings, detectIndent(before), before.endsWith('\n'));
  try {
    const edited = stripText(before).text;
    if (sameJson(edited, expected)) after = edited;
  } catch {
    // Unusual layout: fall back to the re-serialized file.
  }
  return {
    file,
    before,
    after,
    changed: true,
    summary: `Removes ${removed} Agent Viewer hook handler${removed === 1 ? '' : 's'}.`,
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

/** Writes the planned change. Creates `.claude/` when needed, and removes it again on uninstall if empty. */
export function applyChange(project: string, change: SettingsChange): void {
  const file = settingsPath(project);
  const dir = path.dirname(file);
  if (change.after === null) {
    rmSync(file, { force: true });
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    return;
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, change.after);
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

/** Runs `install claude-code` or `uninstall claude-code`. Returns the process exit code. */
export async function runInstall(command: InstallCommand): Promise<number> {
  if (!existsSync(command.project)) {
    console.error(`agent-viewer: project folder not found: ${command.project}`);
    return 1;
  }
  const file = settingsPath(command.project);
  const before = readIfExists(file);
  let change: SettingsChange;
  try {
    change = command.command === 'install'
      ? planInstall(before, buildHookHandler(command), file)
      : planUninstall(before, file);
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
    if (!process.stdin.isTTY) {
      console.error('agent-viewer: nothing was written. Run again with --yes to apply this change.');
      return 1;
    }
    const ok = await confirm('Apply this change? [y/N] ');
    if (!ok) {
      console.log('Nothing was written.');
      return 1;
    }
  }

  applyChange(command.project, change);
  if (command.command === 'install') {
    console.log(`Done. Start the office with "npx @warlockcode/agent-viewer", then use Claude Code in ${command.project}.`);
    console.log('Undo at any time with "npx @warlockcode/agent-viewer uninstall claude-code".');
  } else {
    console.log('Done. Agent Viewer hooks removed.');
  }
  return 0;
}
