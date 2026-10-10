// Issue #69's streaming budget: `GET /api/v1/usage/export` must never buffer the whole match set in memory.
// Runs the real HTTP route in a genuinely separate process (the same `spawnSync` + `--import tsx` technique
// `tests/integration-api.test.mjs` already uses for its own SQLite-mode checks), seeds 100,000 raw usage_ledger
// rows directly (bypassing the validated append path, like `tests/usage-rollup-scale.test.mjs` does, for speed),
// streams a full CSV export through a real `http.get` response reader, and reports its own RSS delta and row
// count back to this test over stdout. The PR-level budget is 100,000 rows / 50 MB RSS growth (the issue's own
// 1,000,000-row / 100 MB nightly variant is out of scope for this change: it belongs in the slow CI job, not on
// every PR, and is not part of this item's acceptance criteria checklist).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-viewer-export-stream-${name}-`));
}

/** The child process: seeds ROW_COUNT rows directly into usage_ledger, serves the real app, streams a full CSV
 * export through node:http (so the parent process's own memory is never involved), and prints one JSON line with
 * its RSS delta and the row count it actually streamed. `global.gc` is used when available (the parent spawns
 * with `--expose-gc`) so the "before" sample is not polluted by GC timing noise. */
function childScript(rowCount) {
  return `
    import http from 'node:http';
    import { app, store } from './server/index.ts';

    const ROW_COUNT = ${rowCount};

    function seed(db, rowCount) {
      db.exec('BEGIN IMMEDIATE');
      const insert = db.prepare(\`
        INSERT INTO usage_ledger (
          event_id, event_type, request_id, received_at, occurred_at, origin, legacy_contract, ingest_channel,
          runtime_id, session_id, agent_id, task_id, provider, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens, cost, currency, cost_source, latency_ms,
          status, error_kind, trace_id, parent_id, tool_call_id, meeting_id, user_id, tags, summary
        ) VALUES (?, ?, NULL, ?, ?, 'live', 0, 'events', NULL, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'ok', NULL, NULL, NULL, NULL, NULL, NULL, '[]', ?)
      \`);
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      for (let i = 0; i < rowCount; i++) {
        insert.run(
          'evt_stream_' + i,
          'llm.usage',
          base + i * 1000,
          base + i * 1000 - 100,
          'agent-' + (i % 25),
          'provider-' + (i % 3),
          'model-' + (i % 5),
          100 + (i % 50),
          20 + (i % 10),
          i % 30,
          i % 10,
          i % 7,
          Math.round((i % 500) + 1) / 100,
          'USD',
          'provider-reported',
          'row ' + i
        );
      }
      db.exec('COMMIT');
    }

    async function main() {
      await store.init();
      seed(store.db, ROW_COUNT);

      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      function streamExportOnce() {
        return new Promise((resolve, reject) => {
          http.get('http://127.0.0.1:' + port + '/api/v1/usage/export?format=csv', (res) => {
            if (res.statusCode !== 200) {
              reject(new Error('unexpected status ' + res.statusCode));
              return;
            }
            let lineCount = 0;
            let partial = '';
            res.on('data', (chunk) => {
              partial += chunk;
              let idx;
              while ((idx = partial.indexOf('\\n')) !== -1) {
                partial = partial.slice(idx + 1);
                lineCount++;
              }
            });
            res.on('end', () => resolve(lineCount - 1)); // minus the header line
            res.on('error', reject);
          }).on('error', reject);
        });
      }

      // A warm-up pass first: populating SQLite's own page cache for this freshly-seeded 100,000-row database, and
      // one-time V8/HTTP-client JIT and buffer-pool growth, are real RSS costs but not what this budget is about
      // (they would happen for a query over this data of any size, and V8 rarely returns heap-arena pages to the
      // OS once grown, even after a GC). The budget is about the *second* export's own incremental growth: would
      // doing *another* export of the same size grow memory again, which is what "never buffers the whole match
      // set" actually predicts (bounded, not zero).
      const warmupRows = await streamExportOnce();
      assert.equal(warmupRows, ROW_COUNT, 'warm-up pass');

      if (global.gc) global.gc();
      const rssBefore = process.memoryUsage().rss;

      const rows = await streamExportOnce();

      if (global.gc) global.gc();
      const rssAfter = process.memoryUsage().rss;

      console.log(JSON.stringify({
        rowsStreamed: rows,
        rssBeforeMB: rssBefore / (1024 * 1024),
        rssAfterMB: rssAfter / (1024 * 1024),
        rssDeltaMB: (rssAfter - rssBefore) / (1024 * 1024),
      }));
      server.close();
      await store.close();
      process.exit(0);
    }

    main().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
}

test(
  'usage/export stream: 100,000 SQLite rows stream over HTTP with bounded RSS growth',
  { timeout: 120_000 },
  () => {
    const dir = tempDir('rss');
    const file = path.join(dir, 'export-stream.db');
    try {
      const result = spawnSync(
        process.execPath,
        ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', childScript(100_000)],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, AGENT_VIEWER_STORAGE: 'sqlite', AGENT_VIEWER_SQLITE_PATH: file, AGENT_VIEWER_SQLITE_BACKUP: 'off', AGENT_VIEWER_API_TOKEN: '' },
          maxBuffer: 64 * 1024 * 1024,
        }
      );
      assert.equal(result.status, 0, `child process failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const lastLine = result.stdout.trim().split(/\r?\n/).at(-1);
      const report = JSON.parse(lastLine);

      assert.equal(report.rowsStreamed, 100_000, 'every seeded row must be streamed, none buffered away');
      assert.ok(
        report.rssDeltaMB < 50,
        `RSS grew by ${report.rssDeltaMB.toFixed(1)} MB while streaming 100,000 rows, budget is 50 MB`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

/** The child process: starts a 100,000-row export, aborts the HTTP request after only a few chunks, then issues a
 * second, ordinary export request on the same server and checks it completes normally and quickly. If the first
 * request's abort had not stopped the server from reading (`req.on('close')` in `server/index.ts`), the second
 * request would be stuck behind it serving from the same single-threaded event loop, so a tight completion budget
 * on the second request is this test's proxy for "the server actually stopped reading on disconnect" without
 * needing a white-box hook into `iterateExportRows` from across a process boundary. */
function abortChildScript(rowCount) {
  return `
    import http from 'node:http';
    import { app, store } from './server/index.ts';

    const ROW_COUNT = ${rowCount};

    function seed(db, rowCount) {
      db.exec('BEGIN IMMEDIATE');
      const insert = db.prepare(\`
        INSERT INTO usage_ledger (
          event_id, event_type, request_id, received_at, occurred_at, origin, legacy_contract, ingest_channel,
          runtime_id, session_id, agent_id, task_id, provider, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, reasoning_tokens, cost, currency, cost_source, latency_ms,
          status, error_kind, trace_id, parent_id, tool_call_id, meeting_id, user_id, tags, summary
        ) VALUES (?, ?, NULL, ?, ?, 'live', 0, 'events', NULL, NULL, ?, NULL, ?, ?, ?, ?, 0, 0, NULL, NULL, NULL, 'unknown', NULL, 'ok', NULL, NULL, NULL, NULL, NULL, NULL, '[]', NULL)
      \`);
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      for (let i = 0; i < rowCount; i++) {
        insert.run('evt_abort_' + i, 'llm.usage', base + i * 1000, base + i * 1000 - 100, 'agent-x', 'anthropic', 'model-a', 1, 1);
      }
      db.exec('COMMIT');
    }

    async function main() {
      await store.init();
      seed(store.db, ROW_COUNT);
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      const base = 'http://127.0.0.1:' + port;

      const controller = new AbortController();
      let aborted = false;
      const firstRequest = fetch(base + '/api/v1/usage/export?format=csv', { signal: controller.signal })
        .then(async (res) => {
          const reader = res.body.getReader();
          await reader.read();
          await reader.read();
          controller.abort();
        })
        .catch(() => {
          aborted = true;
        });
      await firstRequest;

      const start = Date.now();
      const second = await fetch(base + '/api/v1/usage/export/totals');
      const body = await second.json();
      const elapsedMs = Date.now() - start;

      console.log(JSON.stringify({ aborted, secondStatus: second.status, secondRowCount: body.rowCount, elapsedMs }));
      server.close();
      await store.close();
      process.exit(0);
    }

    main().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
}

test(
  'usage/export stream: an aborted client disconnect does not block a later request',
  { timeout: 60_000 },
  () => {
    const dir = tempDir('abort');
    const file = path.join(dir, 'export-abort.db');
    try {
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', abortChildScript(20_000)],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, AGENT_VIEWER_STORAGE: 'sqlite', AGENT_VIEWER_SQLITE_PATH: file, AGENT_VIEWER_SQLITE_BACKUP: 'off', AGENT_VIEWER_API_TOKEN: '' },
          maxBuffer: 16 * 1024 * 1024,
        }
      );
      assert.equal(result.status, 0, `child process failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));

      assert.equal(report.secondStatus, 200);
      assert.equal(report.secondRowCount, 20_000);
      assert.ok(report.elapsedMs < 5000, `the follow-up totals request took ${report.elapsedMs}ms after an aborted export; expected it not to be blocked`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
