// Issue #388 (second sub-issue of the chain-verification theme): GET /api/v1/audit/entries/:seq. One chained
// row's identity and hashes, nothing else, so agent-viewer verify --checkpoints <file> can cross-check an
// exported checkpoint file against a live server one seq at a time without ever uploading the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

test('GET /api/v1/audit/entries/:seq (memory storage): 409 audit_requires_chain', async () => {
  const { app } = await import('../server/index.ts');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${baseUrl}/api/v1/audit/entries/1`);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'audit_requires_chain');
  } finally {
    server.close();
  }
});

test('GET /api/v1/audit/entries/:seq (SQLite): shape, 404, auth/scope, validation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-audit-entries-'));
  try {
    const serverUrl = new URL('../server/index.ts', import.meta.url).href;
    const script = `
      const http = await import('node:http');
      const { app, shutdown } = await import(${JSON.stringify(serverUrl)});
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = 'http://127.0.0.1:' + server.address().port;
      const admin = { Authorization: 'Bearer entries-secret', 'Content-Type': 'application/json' };
      const out = {};

      out.noAuth = (await fetch(baseUrl + '/api/v1/audit/entries/1')).status;

      const mkKey = async (scopes) => {
        const res = await fetch(baseUrl + '/api/v1/keys', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'k-' + scopes.join('-') + '-' + Math.random(), scopes }) });
        return (await res.json()).token;
      };
      const ingestToken = await mkKey(['ingest']);
      const auditToken = await mkKey(['audit']);
      out.ingestOnly = (await fetch(baseUrl + '/api/v1/audit/entries/1', { headers: { Authorization: 'Bearer ' + ingestToken } })).status;

      // Creating the two named keys above already chained their own audit.key.created events (issue #107), so
      // the row this test cares about is not necessarily seq 1: read the chain head instead of assuming it.
      await fetch(baseUrl + '/api/v1/events', {
        method: 'POST', headers: admin,
        body: JSON.stringify({ schemaVersion: '1.0', id: 'evt_entries_1', type: 'agent.message.sent', timestamp: Date.now(), source: 'agent:w', agentId: 'w', summary: 'hi', payload: { text: 'hi' } }),
      });
      const chainRes = await fetch(baseUrl + '/api/v1/audit/chain', { headers: { Authorization: 'Bearer ' + auditToken } });
      const chain = await chainRes.json();
      out.headSeq = chain.head.seq;
      out.expectedEventId = chain.head.eventId;
      out.expectedHash = chain.head.hash;

      const entryRes = await fetch(baseUrl + '/api/v1/audit/entries/' + chain.head.seq, { headers: { Authorization: 'Bearer ' + auditToken } });
      out.entry = { status: entryRes.status, cache: entryRes.headers.get('cache-control'), body: await entryRes.json() };

      const prevEntryRes = await fetch(baseUrl + '/api/v1/audit/entries/' + (chain.head.seq - 1), { headers: { Authorization: 'Bearer ' + auditToken } });
      out.expectedPrevHash = (await prevEntryRes.json()).entryHash;

      out.notFound = (await fetch(baseUrl + '/api/v1/audit/entries/999999', { headers: admin })).status;
      out.zero = (await fetch(baseUrl + '/api/v1/audit/entries/0', { headers: admin })).status;
      out.notAnInt = (await fetch(baseUrl + '/api/v1/audit/entries/abc', { headers: admin })).status;

      server.close();
      await shutdown();
      console.log(JSON.stringify(out));
      process.exit(0);
    `;
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      AGENT_VIEWER_STORAGE: 'sqlite',
      AGENT_VIEWER_SQLITE_PATH: path.join(dir, 'entries.db'),
      AGENT_VIEWER_API_TOKEN: 'entries-secret',
    };
    delete env.AGENT_VIEWER_API_KEY;
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').pop());

    assert.equal(out.noAuth, 401);
    assert.equal(out.ingestOnly, 403);
    assert.equal(out.entry.status, 200);
    assert.equal(out.entry.cache, 'no-store');
    assert.equal(out.expectedEventId, 'evt_entries_1');
    assert.deepEqual(out.entry.body, {
      seq: out.headSeq,
      eventId: 'evt_entries_1',
      entryHash: out.expectedHash,
      prevHash: out.expectedPrevHash,
    });
    assert.equal(out.notFound, 404);
    assert.equal(out.zero, 400);
    assert.equal(out.notAnInt, 400);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
