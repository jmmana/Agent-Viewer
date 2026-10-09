import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translateClaudeHook, sessionIdentity, trimSummary } from '../cli/claudeHook.ts';
import { validateCanonicalEvent } from '../src/integrations/canonicalContract.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const fixturesDir = path.join(repoRoot, 'tests', 'fixtures', 'claude-code');
const cliEntry = path.join(repoRoot, 'cli', 'index.ts');

function fixture(name) {
  return JSON.parse(readFileSync(path.join(fixturesDir, `${name}.json`), 'utf8'));
}

let counter = 0;
const translate = (input, options = {}) => translateClaudeHook(input, { now: 1_767_225_600_000, newId: () => `id${++counter}`, ...options });

test('Claude hook: every fixture translates to valid canonical V1 events', () => {
  const names = readdirSync(fixturesDir).filter((file) => file.endsWith('.json')).map((file) => file.replace(/\.json$/, ''));
  assert.ok(names.length >= 14, 'one fixture per hook type');
  for (const name of names) {
    const events = translate(fixture(name));
    assert.ok(events.length > 0, `${name} produces events`);
    for (const event of events) {
      const result = validateCanonicalEvent(event);
      assert.equal(result.success, true, `${name}: ${JSON.stringify(result.issues)}`);
      assert.equal(event.runtimeId, 'claude-code');
      assert.match(event.sessionId, /^claude-code-[0-9a-f]{12}$/);
    }
  }
});

test('Claude hook: no arguments, prompts, paths, outputs or ids leave the machine by default', () => {
  const names = readdirSync(fixturesDir).filter((file) => file.endsWith('.json'));
  for (const file of names) {
    const input = JSON.parse(readFileSync(path.join(fixturesDir, file), 'utf8'));
    const serialized = JSON.stringify(translate(input));
    assert.doesNotMatch(serialized, /SECRET/, `${file} leaked: ${serialized}`);
    assert.ok(!serialized.includes(input.session_id), `${file} leaked the raw session id`);
  }
});

test('Claude hook: --include-summaries adds only a trimmed final message and notification text', () => {
  const alwaysPrivate = [
    'sk-SECRET', 'SECRET prompt', 'SECRET-passwd', 'SECRET description', 'SECRET instructions', 'SECRET_PATTERN',
    'const SECRET', 'SECRETSESSION', 'SECRET-scratch', 'SECRET-project', 'Cannot find module', '429 Too Many',
    'SECRET title', 'SECRET task', 'agent-SECRET', 'transcript',
  ];
  for (const file of readdirSync(fixturesDir).filter((name) => name.endsWith('.json'))) {
    const input = JSON.parse(readFileSync(path.join(fixturesDir, file), 'utf8'));
    const serialized = JSON.stringify(translate(input, { includeSummaries: true }));
    for (const marker of alwaysPrivate) {
      assert.ok(!serialized.includes(marker), `${file} leaked "${marker}" with summaries on`);
    }
  }

  const stop = translate(fixture('stop'), { includeSummaries: true });
  const message = stop.find((event) => event.type === 'agent.message.sent');
  assert.ok(message, 'Stop sends the final message when summaries are on');
  assert.equal(message.payload.text, 'SECRET final answer with code: rm -rf SECRET');
  assert.equal(translate(fixture('stop')).some((event) => event.type === 'agent.message.sent'), false);

  const long = trimSummary(`${'word '.repeat(100)}\n\nend`);
  assert.ok(long.length <= 140);
  assert.ok(long.endsWith('...'));
  assert.doesNotMatch(long, /\n/);
});

test('Claude hook: maps each hook to the expected office activity', () => {
  const ids = sessionIdentity(fixture('stop').session_id);
  const types = (name) => translate(fixture(name)).map((event) => `${event.type}:${event.payload.status ?? event.payload.tool ?? ''}`);

  assert.deepEqual(types('session-start'), ['agent.registered:AVAILABLE']);
  assert.deepEqual(types('user-prompt-submit'), ['agent.updated:', 'agent.status.changed:THINKING']);
  assert.deepEqual(types('pre-tool-use'), ['tool.started:Bash']);
  assert.deepEqual(types('pre-tool-use-agent'), ['tool.started:Agent', 'agent.status.changed:DELEGATING']);
  assert.deepEqual(types('post-tool-use'), ['tool.completed:Write', 'agent.status.changed:THINKING']);
  assert.deepEqual(types('post-tool-use-failure'), ['tool.failed:Bash']);
  assert.deepEqual(types('notification'), ['agent.status.changed:WAITING_APPROVAL']);
  assert.deepEqual(types('notification-idle'), ['agent.status.changed:WAITING']);
  assert.deepEqual(types('subagent-start'), ['agent.registered:THINKING', 'agent.message.sent:', 'agent.status.changed:THINKING']);
  assert.deepEqual(types('subagent-stop'), ['agent.message.sent:', 'agent.status.changed:DONE', 'agent.status.changed:THINKING']);
  assert.deepEqual(types('stop'), ['agent.status.changed:DONE']);
  assert.deepEqual(types('stop-failure'), ['agent.status.changed:ERROR']);
  assert.deepEqual(types('session-end'), ['agent.status.changed:OFFLINE']);

  // Timings travel; the failure text does not.
  const done = translate(fixture('post-tool-use'))[0];
  assert.equal(done.payload.durationMs, 12);
  assert.equal(done.payload.toolCallId, 'toolu_01WRITE');
  assert.equal(translate(fixture('post-tool-use-failure'))[0].payload.error, 'failed');

  // The main agent owns session events; tool calls inside a subagent belong to the subagent.
  const start = translate(fixture('session-start'))[0];
  assert.equal(start.agentId, ids.mainAgentId);
  assert.equal(start.payload.model, 'claude-opus-5');
  const subTool = translate(fixture('subagent-tool-use'))[0];
  const subId = ids.subagentId(fixture('subagent-tool-use').agent_id);
  assert.equal(subTool.agentId, subId);
  assert.notEqual(subId, ids.mainAgentId);

  // A subagent is its own character, managed by the main agent, and the handoff is a message between them.
  const [registered, handoff] = translate(fixture('subagent-start'));
  assert.equal(registered.agentId, subId);
  assert.equal(registered.payload.managerId, ids.mainAgentId);
  assert.equal(registered.payload.workspace, 'research_area');
  assert.match(registered.payload.name, /^Explore [0-9a-f]{4}$/);
  assert.equal(handoff.agentId, ids.mainAgentId);
  assert.equal(handoff.payload.targetAgentId, subId);
});

test('Claude hook: ignores events it does not show and malformed input', () => {
  assert.deepEqual(translate({}), []);
  assert.deepEqual(translate({ hook_event_name: 'Stop' }), [], 'no session id');
  assert.deepEqual(translate({ hook_event_name: 'PreCompact', session_id: 's' }), []);
  assert.deepEqual(translate({ hook_event_name: 'Notification', session_id: 's', notification_type: 'auth_success' }), []);
  // Internal agents (prompt suggestions, side questions) report an empty agent type.
  assert.deepEqual(translate({ hook_event_name: 'SubagentStop', session_id: 's', agent_id: 'x', agent_type: '' }), []);
  assert.deepEqual(translate({ hook_event_name: 'PreToolUse', session_id: 's' }), [], 'no tool name');
  // Unknown stop failure kinds are not echoed back.
  const failure = translate({ hook_event_name: 'StopFailure', session_id: 's', error: 'SECRET weird' });
  assert.match(failure[0].payload.statusText, /\(unknown\)/);
});

test('Claude hook: tool events get stable ids so a repeated hook is deduplicated', () => {
  const first = translate(fixture('pre-tool-use'))[0];
  const second = translate(fixture('pre-tool-use'))[0];
  assert.equal(first.id, second.id);
  assert.notEqual(first.id, translate(fixture('post-tool-use'))[0].id);
});

/** Runs the hook as Claude Code does: a new process with the hook JSON on stdin. */
function runHook(args, input, env = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    const child = spawn(process.execPath, [cliEntry, 'claude-hook', ...args], {
      env: { ...process.env, AGENT_VIEWER_HOME: path.join(repoRoot, 'node_modules', '.cache', 'agent-viewer-test-none'), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: performance.now() - started }));
    child.stdin.end(JSON.stringify(input));
  });
}

function closedPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('Claude hook process: exits 0 fast and silently when the server is down', async () => {
  const port = await closedPort();
  const result = await runHook(['--url', `http://127.0.0.1:${port}`], fixture('pre-tool-use'));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '', 'nothing on stdout: Claude Code would add it to the conversation');
  assert.ok(result.ms < 500, `took ${Math.round(result.ms)} ms`);
});

test('Claude hook process: exits 0 within 500 ms when the server accepts but never answers', async () => {
  const sockets = new Set();
  const server = http.createServer(() => { /* never answers */ });
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const result = await runHook(['--url', `http://127.0.0.1:${port}`], fixture('stop'));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.ok(result.ms < 500, `took ${Math.round(result.ms)} ms`);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.close();
  }
});

test('Claude hook process: exits 0 on invalid JSON and on bad flags', async () => {
  const child = spawn(process.execPath, [cliEntry, 'claude-hook'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stdin.end('{not json');
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.equal(stdout, '');

  const bad = await runHook(['--no-such-flag'], fixture('stop'));
  assert.equal(bad.code, 0);
  assert.equal(bad.stdout, '');
});

test('Claude hook process: posts the translated events to the server with the token', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"accepted":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const result = await runHook(['--url', `http://127.0.0.1:${port}`, '--token', 'hook-token'], fixture('subagent-start'));
    assert.equal(result.code, 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/api/v1/events/batch');
    assert.equal(received[0].auth, 'Bearer hook-token');
    assert.equal(received[0].body.length, 3);
    assert.doesNotMatch(JSON.stringify(received[0].body), /SECRET/);
  } finally {
    server.close();
  }
});

test('Claude hook: the entry point arms the hard stop before it evaluates any other module', () => {
  const source = readFileSync(new URL('../cli/index.ts', import.meta.url), 'utf8');
  const valueImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)';/gm)].map((match) => match[1]);
  assert.deepEqual(valueImports, ['./hookBudget.ts'], 'static imports run before the guard, so only the budget module may be one');
  const guard = source.indexOf("if (process.argv[2] === 'claude-hook') armHookGuard();");
  assert.ok(guard > 0);
  assert.ok(guard < source.indexOf('await import('), 'the guard is armed before the parser loads');
});

test('Claude hook: the translator imports no file system or process module', () => {
  const source = readFileSync(path.join(repoRoot, 'cli', 'claudeHook.ts'), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:(fs|fs\/promises|child_process)['"]/);
  assert.doesNotMatch(source, /import\(['"]node:(fs|fs\/promises|child_process)['"]\)/);
});

test('Claude hook process: never opens transcript_path', {
  skip: process.platform === 'win32' ? 'mkfifo is POSIX only' : false,
}, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'av-fifo-'));
  // Opening a FIFO that has no writer blocks, so a hook that read the transcript would never finish.
  const fifo = path.join(dir, 'transcript.jsonl');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'mkfifo works');
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push(body);
      res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    for (const name of ['stop', 'session-start', 'pre-tool-use']) {
      const input = { ...fixture(name), transcript_path: fifo };
      const result = await runHook(['--url', `http://127.0.0.1:${port}`, '--token', 'fifo-token'], input);
      assert.equal(result.code, 0, name);
      assert.equal(result.stdout, '', name);
      assert.ok(result.ms < 500, `${name} took ${Math.round(result.ms)} ms`);
    }
    assert.ok(received.length >= 3, 'every hook posted its events');
    assert.ok(received.every((body) => !body.includes(fifo)), 'the transcript path never leaves the machine');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
