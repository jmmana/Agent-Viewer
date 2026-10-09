import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { app } from '../server/index.ts';

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

test('REST API: /health and /ready endpoints', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.service, 'agent-viewer');
    assert.equal(healthJson.schemaVersion, '1.0');

    const readyRes = await fetch(`${baseUrl}/ready`);
    assert.equal(readyRes.status, 200);
    const readyJson = await readyRes.json();
    assert.deepEqual(readyJson, { ok: true, ready: true, storage: 'memory' });
  } finally {
    server.close();
  }
});

test('REST API: /ready includes schema info only when SQLite is the active store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-ready-'));
  const file = path.join(dir, 'ready.db');
  const code = `
    import http from 'node:http';
    import { app } from './server/index.ts';
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', async () => {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/ready');
      console.log(JSON.stringify(await response.json()));
      server.close();
    });
  `;
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, AGENT_VIEWER_STORAGE: 'sqlite', AGENT_VIEWER_SQLITE_PATH: file, AGENT_VIEWER_SQLITE_BACKUP: 'off' },
    });
    assert.equal(result.status, 0, result.stderr);
    const ready = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(ready.ok, true);
    assert.equal(ready.storage, 'sqlite');
    assert.deepEqual(ready.database, {
      schemaVersion: 1,
      latestKnownSchemaVersion: 1,
      appliedAt: ready.database.appliedAt,
    });
    assert.equal(typeof ready.database.appliedAt, 'number');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('REST API: POST /api/v1/events single event and idempotency', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const event = {
      schemaVersion: '1.0',
      id: 'evt_api_test_1',
      type: 'agent.status.changed',
      timestamp: Date.now(),
      runtimeId: 'rt_test',
      sessionId: 'ses_test',
      source: 'agent:alice',
      agentId: 'alice',
      summary: 'Alice status changed',
      payload: { status: 'THINKING' },
    };

    // First emission
    const postRes1 = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    assert.equal(postRes1.status, 202);
    const json1 = await postRes1.json();
    assert.equal(json1.accepted, true);
    assert.equal(json1.duplicate, false);

    // Second emission (duplicate check)
    const postRes2 = await fetch(`${baseUrl}/api/v1/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    assert.equal(postRes2.status, 200);
    const json2 = await postRes2.json();
    assert.equal(json2.accepted, true);
    assert.equal(json2.duplicate, true);
  } finally {
    server.close();
  }
});

test('REST API: POST /api/v1/events/batch batch processing', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const batch = {
      events: [
        {
          schemaVersion: '1.0',
          id: 'evt_batch_1',
          type: 'agent.registered',
          timestamp: Date.now(),
          source: 'agent:bob',
          agentId: 'bob',
          summary: 'Registered Bob',
          payload: { name: 'Bob', roleTitle: 'Dev' },
        },
        {
          schemaVersion: '1.0',
          id: 'evt_batch_2',
          type: 'tool.started',
          timestamp: Date.now(),
          source: 'agent:bob',
          agentId: 'bob',
          summary: 'Bob using git',
          payload: { tool: 'git.commit' },
        },
      ],
    };

    const res = await fetch(`${baseUrl}/api/v1/events/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    assert.equal(res.status, 202);
    const json = await res.json();
    assert.equal(json.accepted, 2);
    assert.equal(json.total, 2);
    assert.equal(json.results.length, 2);
  } finally {
    server.close();
  }
});

test('REST API: /api/v1/snapshot contains aggregated state', async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const res = await fetch(`${baseUrl}/api/v1/snapshot`);
    assert.equal(res.status, 200);
    const snapshot = await res.json();
    assert.equal(snapshot.schemaVersion, '1.0');
    assert.ok(Array.isArray(snapshot.agents));
    assert.ok(Array.isArray(snapshot.runtimes));
    assert.ok(Array.isArray(snapshot.sessions));
  } finally {
    server.close();
  }
});
