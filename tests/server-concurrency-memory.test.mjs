// The store is created when the server module is imported, so the storage mode is set first.
import test from 'node:test';
import { runDuplicateConflictScenario, runServerIdConcurrencyScenario } from './helpers/concurrencyScenario.mjs';

process.env.AGENT_VIEWER_STORAGE = 'memory';
process.env.AGENT_VIEWER_RATE_LIMIT = '100000';
const { app } = await import('../server/index.ts');

test('memory mode: 200 concurrent agents, PATCH and runtimes requests with a frozen clock store and stream 200 events each', async (t) => {
  await runServerIdConcurrencyScenario(t, { app, mode: 'memory' });
});

test('memory mode: an identical re-send is a duplicate and a different event under the same id is a 409', async () => {
  await runDuplicateConflictScenario({ app, mode: 'memory' });
});
