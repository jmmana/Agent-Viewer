import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildHookHandler,
  buildOtelHeadersHelperCommand,
  buildTelemetryEnv,
  buildTelemetryWritePlan,
  checkTelemetryConflicts,
  isAgentViewerHandler,
  lineDiff,
  maskToken,
  planInstall,
  planUninstall,
  probeTelemetryReceiver,
  quoteShellArg,
  readInstallRecord,
  resolveTelemetryEndpoint,
  runInstall,
  writeFileAtomic,
  InstallError,
  TELEMETRY_CONTENT_FLAGS,
  TELEMETRY_HEADERS_KEY,
} from '../cli/claudeInstall.ts';
import { CLAUDE_HOOK_EVENTS } from '../cli/claudeHook.ts';
import http from 'node:http';

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

// --- Telemetry (issue #60): `install claude-code --telemetry`, writing Claude Code's own OpenTelemetry env ---

const ENDPOINT = 'http://127.0.0.1:8787/v1/logs';

test('Claude install telemetry: the env block pins every content flag to "0" and writes nothing else OpenTelemetry reads', () => {
  for (const token of [undefined, 'a-token']) {
    const env = buildTelemetryEnv({ endpoint: ENDPOINT, token });
    for (const flag of TELEMETRY_CONTENT_FLAGS) assert.equal(env[flag], '0', flag);
    assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
    assert.equal(env.OTEL_LOGS_EXPORTER, 'otlp');
    assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, 'http/json');
    assert.equal(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, ENDPOINT);
    for (const forbidden of ['OTEL_METRICS_EXPORTER', 'OTEL_TRACES_EXPORTER', 'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS']) {
      assert.equal(env[forbidden], undefined, forbidden);
    }
  }
});

test('Claude install telemetry: helper mode writes otelHeadersHelper and no header; static mode the reverse', () => {
  const helper = buildTelemetryWritePlan({ endpoint: ENDPOINT, nodePath: '/usr/local/bin/node', scriptPath: '/opt/av/cli.js' });
  assert.equal(helper.env[TELEMETRY_HEADERS_KEY], undefined);
  assert.match(helper.helperCommand, /otel-headers/);
  assert.match(helper.helperCommand, /--url/);

  const token = 'distinctive-long-random-token-0123456789';
  const staticPlan = buildTelemetryWritePlan({ endpoint: ENDPOINT, token });
  assert.equal(staticPlan.env[TELEMETRY_HEADERS_KEY], `Authorization=Bearer ${token}`);
  assert.equal(staticPlan.helperCommand, undefined);
});

test('Claude install telemetry: shell quoting handles spaces, $ and a single quote on POSIX and Windows', () => {
  const tricky = "/opt/agent viewer/$weird'path/cli.js";
  const posix = quoteShellArg(tricky, 'posix');
  assert.equal(posix, "'/opt/agent viewer/$weird'\\''path/cli.js'");
  assert.doesNotMatch(posix.slice(1, -1).replace(/'\\''/g, ''), /(?<!\\)\$\(|`/);
  const win = quoteShellArg('C:\\Program Files\\weird"path\\cli.js', 'win32');
  assert.equal(win, '"C:\\Program Files\\weird\\"path\\cli.js"');

  const command = buildOtelHeadersHelperCommand({ nodePath: '/usr/local/bin/node', scriptPath: '/opt/av/cli.js', url: 'http://127.0.0.1:8787', platform: 'posix' });
  assert.equal(command, "'/usr/local/bin/node' '/opt/av/cli.js' 'otel-headers' '--url' 'http://127.0.0.1:8787'");
});

test('Claude install telemetry: install writes the hooks plus the env block and otelHeadersHelper, in helper mode', () => {
  const write = { kind: 'write', ...buildTelemetryWritePlan({ endpoint: ENDPOINT, nodePath: '/n', scriptPath: '/c.js' }) };
  const plan = planInstall(null, handler, 'f', write);
  assert.equal(plan.changed, true);
  const after = JSON.parse(plan.after);
  for (const event of CLAUDE_HOOK_EVENTS) assert.ok(after.hooks[event].some((g) => g.hooks.some(isAgentViewerHandler)), event);
  assert.equal(after.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, ENDPOINT);
  assert.match(after.otelHeadersHelper, /otel-headers/);
  assert.equal(after.env[TELEMETRY_HEADERS_KEY], undefined);
});

test('Claude install telemetry: static mode writes the header and no otelHeadersHelper', () => {
  const token = 'distinctive-long-random-token-9876543210';
  const write = { kind: 'write', ...buildTelemetryWritePlan({ endpoint: ENDPOINT, token }) };
  const after = JSON.parse(planInstall(null, handler, 'f', write).after);
  assert.equal(after.env[TELEMETRY_HEADERS_KEY], `Authorization=Bearer ${token}`);
  assert.equal(after.otelHeadersHelper, undefined);
});

test('Claude install telemetry: merges into an existing env object, byte for byte, and a second install is a no-op', () => {
  const original = `${JSON.stringify({ env: { FOO: 'bar' }, model: 'opus' }, null, 2)}\n`;
  const write = { kind: 'write', ...buildTelemetryWritePlan({ endpoint: ENDPOINT, nodePath: '/n', scriptPath: '/c.js' }) };
  const once = planInstall(original, handler, 'f', write);
  assert.equal(once.changed, true);
  const afterOnce = JSON.parse(once.after);
  assert.equal(afterOnce.env.FOO, 'bar');
  assert.equal(afterOnce.model, 'opus');
  assert.equal(afterOnce.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.match(once.summary, /Telemetry: on\.$/m);

  const twice = planInstall(once.after, handler, 'f', write);
  assert.equal(twice.changed, false);
  assert.equal(twice.after, once.after);
  assert.match(twice.summary, /Telemetry: on \(unchanged\)\.$/m);
});

test('Claude install telemetry: CRLF and tab-indented files keep their own formatting', () => {
  const write = { kind: 'write', ...buildTelemetryWritePlan({ endpoint: ENDPOINT, nodePath: '/n', scriptPath: '/c.js' }) };
  const crlf = '{\r\n  "env": {\r\n    "FOO": "bar"\r\n  }\r\n}\r\n';
  const afterCrlf = planInstall(crlf, handler, 'f', write).after;
  assert.equal(afterCrlf.includes('\r\n'), true);
  assert.equal(afterCrlf.replace(/\r\n/g, '').includes('\n'), false, 'no bare \\n sneaks into a CRLF file');
  assert.deepEqual(JSON.parse(afterCrlf).env.FOO, 'bar');

  const tabbed = JSON.stringify({ env: { FOO: 'bar' } }, null, '\t');
  const afterTabbed = planInstall(tabbed, handler, 'f', write).after;
  assert.match(afterTabbed, /\n\t"env": \{\n\t\t"FOO": "bar",/);
});

test('Claude install telemetry: --no-telemetry removes only the telemetry block, keeping the hooks and the user\'s own env', () => {
  const write = { kind: 'write', ...buildTelemetryWritePlan({ endpoint: ENDPOINT, nodePath: '/n', scriptPath: '/c.js' }) };
  const installed = planInstall('{"env": {"FOO": "bar"}}\n', handler, 'f', write);
  const removal = { kind: 'remove', envKeys: Object.keys(write.env), dropHelper: true, dropEnvIfEmpty: false };
  const removed = planInstall(installed.after, handler, 'f', removal);
  assert.equal(removed.changed, true);
  const after = JSON.parse(removed.after);
  assert.deepEqual(after.env, { FOO: 'bar' });
  assert.equal(after.otelHeadersHelper, undefined);
  for (const event of CLAUDE_HOOK_EVENTS) assert.ok(after.hooks[event].some((g) => g.hooks.some(isAgentViewerHandler)), event);
  assert.match(removed.summary, /Telemetry: off\.$/m);

  // Nothing to remove a second time.
  const again = planInstall(removed.after, handler, 'f', removal);
  assert.equal(again.changed, false);
});

test('Claude install telemetry: install then remove restores the file byte for byte, env created or not, CRLF or tabs', () => {
  const write = { kind: 'write', ...buildTelemetryWritePlan({ endpoint: ENDPOINT, nodePath: '/n', scriptPath: '/c.js' }) };
  const cases = [
    { original: existingSettings, dropEnvIfEmpty: false },
    { original: '{\n  "model": "sonnet"\n}\n', dropEnvIfEmpty: true },
    { original: `${JSON.stringify({ model: 'opus' }, null, '\t')}\n`, dropEnvIfEmpty: true },
    { original: '{\r\n  "model": "sonnet"\r\n}\r\n', dropEnvIfEmpty: true },
  ];
  for (const { original, dropEnvIfEmpty } of cases) {
    const installed = planInstall(original, handler, 'f', write).after;
    const removal = { kind: 'remove', envKeys: Object.keys(write.env), dropHelper: true, dropEnvIfEmpty };
    const removed = planUninstall(installed, 'f', undefined, removal);
    assert.equal(removed.after, original, JSON.stringify(original));
  }
});

test('Claude install telemetry conflicts: refuses a managed key already set to something else in this file', () => {
  const before = JSON.stringify({ env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://elsewhere/v1/logs' } });
  const { refusals } = checkTelemetryConflicts({ before, file: 'f', project: '/p', mode: 'helper', endpoint: ENDPOINT, env: {} });
  assert.ok(refusals.some((m) => m.includes('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT')));
});

test('Claude install telemetry conflicts: refuses when content logging is already on in this file', () => {
  const before = JSON.stringify({ env: { OTEL_LOG_USER_PROMPTS: '1' } });
  const { refusals } = checkTelemetryConflicts({ before, file: 'f', project: '/p', mode: 'helper', endpoint: ENDPOINT, env: {} });
  assert.ok(refusals.some((m) => m.includes('OTEL_LOG_USER_PROMPTS')));
});

test('Claude install telemetry conflicts: refuses a foreign otelHeadersHelper and another OTLP exporter, in helper mode only', () => {
  const foreignHelper = checkTelemetryConflicts({ before: JSON.stringify({ otelHeadersHelper: 'my own script' }), file: 'f', project: '/p', mode: 'helper', endpoint: ENDPOINT, env: {} });
  assert.ok(foreignHelper.refusals.some((m) => m.includes('otelHeadersHelper')));

  const otherExporter = checkTelemetryConflicts({ before: JSON.stringify({ env: { OTEL_METRICS_EXPORTER: 'otlp' } }), file: 'f', project: '/p', mode: 'helper', endpoint: ENDPOINT, env: {} });
  assert.ok(otherExporter.refusals.some((m) => m.includes('OTLP exporter')));

  // Static mode is suggested by both messages and is itself unaffected by the metrics/traces exporter check.
  const staticOk = checkTelemetryConflicts({ before: JSON.stringify({ env: { OTEL_METRICS_EXPORTER: 'otlp' } }), file: 'f', project: '/p', mode: 'static', endpoint: ENDPOINT, env: {} });
  assert.equal(staticOk.refusals.length, 0);
});

test('Claude install telemetry conflicts: warns (does not refuse) about settings this install does not manage', () => {
  const dir = tempProject();
  try {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://other/v1/logs' } }));
    const { refusals, warnings } = checkTelemetryConflicts({ before: null, file: path.join(dir, '.claude', 'settings.local.json'), project: dir, mode: 'helper', endpoint: ENDPOINT, env: {} });
    assert.equal(refusals.length, 0);
    assert.ok(warnings.some((m) => m.includes('http://other/v1/logs')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude install telemetry conflicts: warns about a plain http endpoint to a non-loopback host in static mode', () => {
  const { refusals, warnings } = checkTelemetryConflicts({
    before: null, file: 'f', project: '/p', mode: 'static', endpoint: 'http://10.0.0.5:8787/v1/logs', env: {},
  });
  assert.equal(refusals.length, 0);
  assert.ok(warnings.some((m) => /clear text/.test(m)));
});

test('Claude install telemetry: resolveTelemetryEndpoint follows --url, then AGENT_VIEWER_URL, then the default', () => {
  // AGENT_VIEWER_HOME must point somewhere empty: without it, an unrelated `agent-viewer` actually running on
  // this machine would leave a real ~/.agent-viewer/session.json for resolveConnection to pick up instead.
  const home = tempProject();
  try {
    const env = { AGENT_VIEWER_HOME: home };
    assert.equal(resolveTelemetryEndpoint('http://host:1/', env), 'http://host:1/v1/logs');
    assert.equal(resolveTelemetryEndpoint(undefined, { ...env, AGENT_VIEWER_URL: 'http://host:2' }), 'http://host:2/v1/logs');
    assert.equal(resolveTelemetryEndpoint(undefined, env), 'http://127.0.0.1:8787/v1/logs');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('Claude install telemetry: maskToken hides the token in printed text, never in what is returned for the file', () => {
  const token = 'super-secret-token';
  const text = `Authorization=Bearer ${token}\n--token ${token}`;
  const masked = maskToken(text, token);
  assert.equal(masked.includes(token), false);
  assert.match(masked, /<token hidden>/);
  assert.equal(maskToken(text, undefined), text);
});

test('Claude install telemetry: the receiver probe reports OK, 401, 404 and not running', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') { res.writeHead(200); res.end('{}'); return; }
    if (req.url === '/unauthorized') { res.writeHead(401); res.end(); return; }
    if (req.url === '/missing') { res.writeHead(404); res.end(); return; }
    res.writeHead(500); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await probeTelemetryReceiver(`http://127.0.0.1:${port}/ok`, {}), 'Telemetry receiver OK');
    assert.match(await probeTelemetryReceiver(`http://127.0.0.1:${port}/unauthorized`, {}), /401/);
    assert.match(await probeTelemetryReceiver(`http://127.0.0.1:${port}/missing`, {}), /no OTLP receiver/);
    assert.match(await probeTelemetryReceiver(`http://127.0.0.1:${port}/boom`, {}), /answered 500/);
  } finally {
    server.close();
  }
  // Nothing listening at all: a clear "not running" message, not a thrown error.
  assert.match(await probeTelemetryReceiver('http://127.0.0.1:1/v1/logs', {}), /office not running/);
});

test('Claude install telemetry CLI: --telemetry round trip on a fresh project, helper mode', { timeout: 30_000 }, async () => {
  const project = tempProject();
  try {
    const installed = await run(['install', 'claude-code', '--project', project, '--yes', '--telemetry']);
    assert.equal(installed.code, 0, installed.stderr);
    const settings = JSON.parse(readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(settings.env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
    for (const flag of TELEMETRY_CONTENT_FLAGS) assert.equal(settings.env[flag], '0');
    assert.match(settings.otelHeadersHelper, /otel-headers/);
    assert.equal(settings.env[TELEMETRY_HEADERS_KEY], undefined);
    assert.deepEqual(readdirSync(path.join(project, '.claude')), ['settings.local.json']);

    // A plain re-install (no telemetry flag) leaves the block untouched.
    const plain = await run(['install', 'claude-code', '--project', project, '--yes']);
    assert.equal(plain.code, 0, plain.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8')), settings);

    // --no-telemetry removes only the telemetry block.
    const off = await run(['install', 'claude-code', '--project', project, '--yes', '--no-telemetry']);
    assert.equal(off.code, 0, off.stderr);
    const afterOff = JSON.parse(readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(afterOff.env, undefined);
    assert.equal(afterOff.otelHeadersHelper, undefined);
    assert.ok(afterOff.hooks, 'the hooks stay');

    const removed = await run(['uninstall', 'claude-code', '--project', project, '--yes']);
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(readdirSync(project), [], 'the project is exactly as before');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 30_000);

test('Claude install telemetry CLI: --telemetry --token never prints the token, in the diff or anywhere else', { timeout: 30_000 }, async () => {
  const project = tempProject();
  const token = `av_${'x'.repeat(48)}_distinctive`;
  try {
    const installed = await run(['install', 'claude-code', '--project', project, '--yes', '--telemetry', '--token', token]);
    assert.equal(installed.code, 0, installed.stderr);
    assert.equal(installed.stdout.includes(token), false, 'stdout never shows the token');
    assert.equal(installed.stderr.includes(token), false, 'stderr never shows the token');
    assert.match(installed.stdout, /<token hidden>/);

    const settings = JSON.parse(readFileSync(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(settings.env[TELEMETRY_HEADERS_KEY], `Authorization=Bearer ${token}`);
    assert.equal(settings.otelHeadersHelper, undefined);
    const hookArgs = settings.hooks.Stop[0].hooks[0].args;
    assert.ok(hookArgs.includes(token), 'the token is still written in full to the file');

    const removedNoTelemetry = await run(['uninstall', 'claude-code', '--project', project, '--yes']);
    assert.equal(removedNoTelemetry.code, 0, removedNoTelemetry.stderr);
    assert.equal(removedNoTelemetry.stdout.includes(token), false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}, 30_000);
