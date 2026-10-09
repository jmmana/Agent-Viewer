// The store is created when the server module is imported, so the storage mode and file are set first.
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDuplicateConflictScenario, runServerIdConcurrencyScenario } from './helpers/concurrencyScenario.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-concurrency-'));
process.env.AGENT_VIEWER_STORAGE = 'sqlite';
process.env.AGENT_VIEWER_SQLITE_PATH = path.join(dir, 'concurrency.db');
process.env.AGENT_VIEWER_SQLITE_BACKUP = 'off';
process.env.AGENT_VIEWER_RATE_LIMIT = '100000';
const { app, store } = await import('../server/index.ts');

test.after(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SQLite mode: 200 concurrent agents, PATCH and runtimes requests with a frozen clock store and stream 200 events each', async (t) => {
  await runServerIdConcurrencyScenario(t, { app, mode: 'sqlite' });
});

test('SQLite mode: an identical re-send is a duplicate and a different event under the same id is a 409', async () => {
  await runDuplicateConflictScenario({ app, mode: 'sqlite' });
});
