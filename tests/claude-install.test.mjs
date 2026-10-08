import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildHookHandler,
  isAgentViewerHandler,
  lineDiff,
  planInstall,
  planUninstall,
  readInstallRecord,
  runInstall,
  writeFileAtomic,
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
    timeout: 1,
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
  // A file install created is removed again, when the install record says so.
  const created = planInstall(null, handler);
  assert.equal(planUninstall(created.after, 'f', { createdFile: true, createdDir: true, events: [], hooks: false }).after, null);
});

test('Claude install: the hook timeout is 1 second on every event, below the SessionEnd budget', () => {
  const after = JSON.parse(planInstall(null, buildHookHandler()).after);
  for (const event of CLAUDE_HOOK_EVENTS) {
    const ours = after.hooks[event].flatMap((group) => group.hooks).filter(isAgentViewerHandler);
    assert.equal(ours[0].timeout, 1, event);
  }
});

test('Claude install: a second install is a no-op with empty containers and inline empty hooks', () => {
  const originals = [
    '{\n  "hooks": {\n    "Stop": []\n  }\n}\n',
    '{"hooks": {}}',
    '{"hooks":{"SessionEnd":[],"Stop":[]},"model":"opus"}\n',
    '{}\n',
    '{}',
    '',
  ];
  for (const original of originals) {
    const once = planInstall(original, handler);
    assert.equal(once.changed, true, JSON.stringify(original));
    const twice = planInstall(once.after, handler);
    assert.equal(twice.changed, false, `second install of ${JSON.stringify(original)}`);
    assert.equal(twice.after, once.after);
    assert.match(twice.summary, /already installed.*nothing to change/);
    assert.doesNotMatch(twice.summary, /Adds/);
  }
  // An older handler (another path) is replaced in place, keeping the event order.
  const old = buildHookHandler({ nodePath: '/old/node', scriptPath: '/old/agent-viewer/dist-cli/cli.js' });
  const oldText = planInstall('{"hooks": {"Stop": []}}\n', old).after;
  const updated = planInstall(oldText, handler);
  assert.equal(updated.changed, true);
  assert.match(updated.summary, /^Updates/);
  assert.deepEqual(Object.keys(JSON.parse(updated.after).hooks), Object.keys(JSON.parse(oldText).hooks));
  assert.equal(planInstall(updated.after, handler).changed, false);
});

test('Claude install: uninstall keeps what existed before install, as the record says', () => {
  const cases = [
    { original: '{}\n', record: { createdFile: false, createdDir: false, events: [], hooks: false } },
    { original: '{"hooks": {}}\n', record: { createdFile: false, createdDir: false, events: [], hooks: true } },
    { original: '{\n  "hooks": {\n    "Stop": []\n  }\n}\n', record: { createdFile: false, createdDir: false, events: ['Stop'], hooks: true } },
  ];
  for (const { original, record } of cases) {
    const installed = planInstall(original, handler);
    assert.deepEqual(installed.existing, { events: record.events, hooks: record.hooks });
    const removed = planUninstall(installed.after, 'f', record);
    assert.equal(removed.after, original, `round trip of ${JSON.stringify(original)}`);
    assert.doesNotMatch(removed.summary, /install created/);
  }
  // Without a record nothing that may have been there before is deleted: the file stays.
  const created = planInstall(null, handler);
  const kept = planUninstall(created.after);
  assert.equal(kept.changed, true);
  assert.deepEqual(JSON.parse(kept.after), {});
});

test('Claude install: writes go through a temporary file and keep links and permissions', () => {
  const dir = tempProject();
  try {
    const real = path.join(dir, 'real.json');
    const link = path.join(dir, 'link.json');
    writeFileSync(real, '{}\n');
    if (process.platform !== 'win32') chmodSync(real, 0o600);
    symlinkSync(real, link);
    writeFileAtomic(link, '{"a": 1}\n');
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'the link stays a link');
    assert.equal(readFileSync(real, 'utf8'), '{"a": 1}\n');
    if (process.platform !== 'win32') assert.equal(statSync(real).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir).sort(), ['link.json', 'real.json'], 'no temporary file is left');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude install: a file edited while the prompt waits is not overwritten', async () => {
  const project = tempProject();
  const home = tempProject();
  const file = path.join(project, '.claude', 'settings.local.json');
  const log = console.log;
  const error = console.error;
  const errors = [];
  console.log = () => {};
  console.error = (message) => { errors.push(String(message)); };
  try {
    mkdirSync(path.join(project, '.claude'));
    writeFileSync(file, '{"model": "opus"}\n');
    const command = { command: 'install', target: 'claude-code', project, yes: false, includeSummaries: false };
    const code = await runInstall(command, {
      env: { AGENT_VIEWER_HOME: home },
      confirm: async () => {
        writeFileSync(file, '{"model": "sonnet"}\n');
        return true;
      },
    });
    assert.equal(code, 1);
    assert.equal(readFileSync(file, 'utf8'), '{"model": "sonnet"}\n', 'the edit made during the prompt survives');
    assert.match(errors.join('\n'), /changed while waiting/);
    assert.equal(readInstallRecord(file, { AGENT_VIEWER_HOME: home }), undefined, 'no record without a write');

    // Confirmed with no edit in between: written, and the record notes what was there.
    assert.equal(await runInstall(command, { env: { AGENT_VIEWER_HOME: home }, confirm: async () => true }), 0);
    assert.match(readFileSync(file, 'utf8'), /claude-hook/);
    assert.deepEqual(readInstallRecord(file, { AGENT_VIEWER_HOME: home }), { createdFile: false, createdDir: false, events: [], hooks: false });
    assert.deepEqual(readdirSync(path.join(project, '.claude')), ['settings.local.json'], 'no temporary file is left');
  } finally {
    console.log = log;
    console.error = error;
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
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

// The install record goes to AGENT_VIEWER_HOME: a temporary folder, never the real ~/.agent-viewer.
const stateHome = mkdtempSync(path.join(os.tmpdir(), 'av-state-'));
test.after(() => rmSync(stateHome, { recursive: true, force: true }));

function run(args, cwd) {
  return new Promise((resolve) => {
    const env = { ...process.env, AGENT_VIEWER_HOME: stateHome };
    const child = spawn(process.execPath, [cliEntry, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

test('Claude install CLI: a second install says there is nothing to change', { timeout: 30_000 }, async () => {
  const project = tempProject();
  try {
    assert.equal((await run(['install', 'claude-code', '--project', project, '--yes'])).code, 0);
    const file = path.join(project, '.claude', 'settings.local.json');
    const first = readFileSync(file, 'utf8');
    const again = await run(['install', 'claude-code', '--project', project, '--yes']);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /already installed.*nothing to change/);
    assert.doesNotMatch(again.stdout, /Adds an Agent Viewer hook/);
    assert.equal(readFileSync(file, 'utf8'), first);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('Claude install CLI: uninstall keeps a settings file and a .claude folder that existed before', { timeout: 30_000 }, async () => {
  const emptyDir = tempProject();
  const emptyFile = tempProject();
  try {
    mkdirSync(path.join(emptyDir, '.claude'));
    assert.equal((await run(['install', 'claude-code', '--project', emptyDir, '--yes'])).code, 0);
    const removedFile = await run(['uninstall', 'claude-code', '--project', emptyDir, '--yes']);
    assert.equal(removedFile.code, 0, removedFile.stderr);
    assert.match(removedFile.stdout, /removed: install created it/);
    assert.deepEqual(readdirSync(emptyDir), ['.claude'], 'the empty .claude folder that was there stays');
    assert.deepEqual(readdirSync(path.join(emptyDir, '.claude')), []);

    mkdirSync(path.join(emptyFile, '.claude'));
    const file = path.join(emptyFile, '.claude', 'settings.local.json');
    writeFileSync(file, '{}\n');
    assert.equal((await run(['install', 'claude-code', '--project', emptyFile, '--yes'])).code, 0);
    const kept = await run(['uninstall', 'claude-code', '--project', emptyFile, '--yes']);
    assert.equal(kept.code, 0, kept.stderr);
    assert.doesNotMatch(kept.stdout, /install created it/);
    assert.equal(readFileSync(file, 'utf8'), '{}\n', 'the file that was there comes back byte for byte');
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
    rmSync(emptyFile, { recursive: true, force: true });
  }
});
