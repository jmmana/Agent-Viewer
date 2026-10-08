import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildHookHandler,
  isAgentViewerHandler,
  lineDiff,
  planInstall,
  planUninstall,
  InstallError,
} from '../cli/claudeInstall.ts';
import { CLAUDE_HOOK_EVENTS } from '../cli/claudeHook.ts';

// Every test works in a temporary folder. The real ~/.claude and the repository's own .claude are never used.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliEntry = path.join(repoRoot, 'cli', 'index.ts');
const handler = buildHookHandler({ nodePath: '/usr/local/bin/node', scriptPath: '/opt/av/node_modules/@warlockcode/agent-viewer/dist-cli/cli.js' });

function tempProject() {
  return mkdtempSync(path.join(os.tmpdir(), 'av-claude-'));
}

/** A settings file as Claude Code writes it: two-space JSON with a trailing newline, with other hooks in it. */
const existingSettings = `${JSON.stringify({
  permissions: { allow: ['Bash(npm test)'], deny: [] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/hooks/check.sh' }] }],
    Notification: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }],
  },
  env: { FOO: 'bar' },
}, null, 2)}\n`;

test('Claude install: the handler runs this CLI in exec form', () => {
  assert.deepEqual(handler, {
    type: 'command',
    command: '/usr/local/bin/node',
    args: ['/opt/av/node_modules/@warlockcode/agent-viewer/dist-cli/cli.js', 'claude-hook'],
    timeout: 5,
  });
  assert.equal(isAgentViewerHandler(handler), true);
  assert.equal(isAgentViewerHandler({ type: 'command', command: 'npx @warlockcode/agent-viewer claude-hook' }), true);
  assert.equal(isAgentViewerHandler({ type: 'command', command: '.claude/hooks/check.sh' }), false);
  assert.deepEqual(
    buildHookHandler({ nodePath: 'node', scriptPath: 'cli.js', includeSummaries: true, url: 'http://127.0.0.1:4871' }).args,
    ['cli.js', 'claude-hook', '--include-summaries', '--url', 'http://127.0.0.1:4871'],
  );
});

test('Claude install: adds one handler per hook event and keeps everything else', () => {
  const plan = planInstall(existingSettings, handler);
  assert.equal(plan.changed, true);
  const after = JSON.parse(plan.after);
  assert.deepEqual(after.permissions, { allow: ['Bash(npm test)'], deny: [] });
  assert.deepEqual(after.env, { FOO: 'bar' });
  assert.deepEqual(Object.keys(after.hooks).sort(), [...new Set(['PreToolUse', 'Notification', ...CLAUDE_HOOK_EVENTS])].sort());
  for (const event of CLAUDE_HOOK_EVENTS) {
    const ours = after.hooks[event].flatMap((group) => group.hooks).filter(isAgentViewerHandler);
    assert.equal(ours.length, 1, event);
  }
  // The user's own hooks come first and are untouched.
  assert.deepEqual(after.hooks.PreToolUse[0], { matcher: 'Bash', hooks: [{ type: 'command', command: '.claude/hooks/check.sh' }] });
  assert.ok(plan.after.endsWith('}\n'));
});

test('Claude install: installing twice does not duplicate, and the diff shows the additions', () => {
  const once = planInstall(existingSettings, handler);
  const twice = planInstall(once.after, handler);
  assert.equal(twice.changed, false);
  assert.equal(twice.after, once.after);
  const diff = lineDiff(existingSettings, once.after).split('\n');
  assert.ok(diff.filter((line) => line.startsWith('+ ')).length > 50);
  // At most the closing line of a list or object gains a comma.
  assert.ok(diff.filter((line) => line.startsWith('- ')).every((line) => /^-\s+[\]}]$/.test(line)));
});

test('Claude install: uninstall restores the file byte for byte', () => {
  const tabbed = JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }, null, '\t');
  for (const original of [existingSettings, '{\n  "model": "sonnet"\n}\n', tabbed, `${JSON.stringify({ a: 1 }, null, 4)}\n`]) {
    const installed = planInstall(original, handler).after;
    const removed = planUninstall(installed);
    assert.equal(removed.changed, true);
    assert.equal(removed.after, original);
  }
  // A file install created is removed again.
  const created = planInstall(null, handler);
  assert.equal(planUninstall(created.after).after, null);
});

test('Claude install: hand-formatted files keep every byte of their own text', () => {
  const originals = [
    '{\n  "permissions": {\n    "allow": ["Bash(ls)"]\n  }\n}\n',
    '{"model":"opus","env":{"A":"1"}}',
    '{\r\n  "hooks": {\r\n    "Stop": [ { "hooks": [ { "type": "command", "command": "say done" } ] } ],\r\n    "PreCompact": []\r\n  }\r\n}\r\n',
    '{\n    "theme": "dark", "hooks": {"Stop": [{"hooks": []}]}\n}\n',
  ];
  for (const original of originals) {
    const installed = planInstall(original, handler).after;
    const parsed = JSON.parse(installed);
    for (const event of CLAUDE_HOOK_EVENTS) assert.ok(parsed.hooks[event].some((group) => group.hooks.some(isAgentViewerHandler)), event);
    assert.equal(planUninstall(installed).after, original, `round trip of ${JSON.stringify(original)}`);
  }
  // Install keeps the user's own layout: the inline list stays inline, and only a comma joins the new key.
  const installed = planInstall(originals[0], handler).after;
  assert.ok(installed.startsWith('{\n  "permissions": {\n    "allow": ["Bash(ls)"]\n  },\n  "hooks": {\n    "SessionStart": ['), installed);
  // Windows line endings stay Windows line endings.
  const crlf = planInstall(originals[2], handler).after;
  assert.equal(crlf.replace(/\r\n/g, '').includes('\n'), false);
});

test('Claude install: removes its handler from a group the user extended, and nothing else', () => {
  const installed = JSON.parse(planInstall(existingSettings, handler).after);
  installed.hooks.Stop[installed.hooks.Stop.length - 1].hooks.push({ type: 'command', command: 'say finished' });
  const text = `${JSON.stringify(installed, null, 2)}\n`;
  const after = JSON.parse(planUninstall(text).after);
  assert.deepEqual(after.hooks.Stop, [{ hooks: [{ type: 'command', command: 'say finished' }] }]);
  assert.deepEqual(after.hooks.PreToolUse, JSON.parse(existingSettings).hooks.PreToolUse);
  assert.equal(JSON.stringify(after).includes('claude-hook'), false);
});

test('Claude install: uninstall leaves a file without Agent Viewer hooks alone', () => {
  const plan = planUninstall(existingSettings);
  assert.equal(plan.changed, false);
  assert.equal(plan.after, existingSettings);
  assert.equal(planUninstall(null).changed, false);
});

test('Claude install: refuses files it cannot edit safely', () => {
  assert.throws(() => planInstall('{ not json', handler), InstallError);
  assert.throws(() => planInstall('[]', handler), InstallError);
  assert.throws(() => planInstall('{"hooks": []}', handler), InstallError);
  assert.throws(() => planInstall('{"hooks": {"Stop": {}}}', handler), InstallError);
});

function run(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliEntry, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('Claude install CLI: round trip on a fresh project leaves no trace', { timeout: 30_000 }, async () => {
  const project = tempProject();
  try {
    const installed = await run(['install', 'claude-code', '--project', project, '--yes']);
    assert.equal(installed.code, 0, installed.stderr);
    assert.match(installed.stdout, /settings\.local\.json \(new file\)/);
    assert.match(installed.stdout, /^\+ /m, 'shows the change before writing');
    const settings = JSON.parse(readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
    const ours = settings.hooks.PreToolUse[0].hooks[0];
    assert.equal(ours.command, process.execPath);
    assert.deepEqual(ours.args, [cliEntry, 'claude-hook']);
    assert.deepEqual(readdirSync(path.join(project, '.claude')), ['settings.local.json'], 'writes only settings.local.json');

    const removed = await run(['uninstall', 'claude-code', '--project', project, '--yes']);
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(readdirSync(project), [], 'the project is exactly as before');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('Claude install CLI: round trip on an existing settings file is byte-identical', { timeout: 30_000 }, async () => {
  const project = tempProject();
  try {
    mkdirSync(path.join(project, '.claude'));
    writeFileSync(path.join(project, '.claude', 'settings.json'), '{"shared": true}\n');
    const file = path.join(project, '.claude', 'settings.local.json');
    writeFileSync(file, existingSettings);

    const installed = await run(['install', 'claude-code', '--project', project, '--yes', '--include-summaries']);
    assert.equal(installed.code, 0, installed.stderr);
    assert.notEqual(readFileSync(file, 'utf8'), existingSettings);
    assert.match(readFileSync(file, 'utf8'), /--include-summaries/);
    assert.equal(readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8'), '{"shared": true}\n', 'shared settings untouched');

    const removed = await run(['uninstall', 'claude-code', '--project', project, '--yes']);
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(readFileSync(file, 'utf8'), existingSettings);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('Claude install CLI: without --yes and without a terminal, nothing is written', { timeout: 30_000 }, async () => {
  const project = tempProject();
  try {
    const result = await run(['install', 'claude-code', '--project', project]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^\+ /m, 'still shows the change');
    assert.match(result.stderr, /nothing was written/i);
    assert.equal(existsSync(path.join(project, '.claude')), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
