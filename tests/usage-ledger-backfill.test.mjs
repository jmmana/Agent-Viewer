// Issue #65: the usage ledger backfill and startup catch-up. Builds legacy-shaped SQLite databases by hand (the
// same way tests/event-store.test.mjs builds its pre-0.2.0 fixture), the way a real pre-0.4.0 database looks,
// and checks the migration's one-time backfill and the startup catch-up both reach the documented rows and
// skips: legacy zero defaults become NULL, request-id duplicates and conflicts are detected without a
// requestId-aware events-level dedup, webhook retries with no requestId are never merged by guesswork, a corrupt
// row is skipped as unparseable without stopping the migration, and both passes are idempotent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteEventStore } from '../server/store.ts';
import { runUsageLedgerBackfill, dbRowToLedgerRowInput } from '../server/usageLedger.ts';

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-ledger-backfill-'));
  return { dir, file: path.join(dir, `${name}.db`) };
}

/** A database shaped like a pre-0.2.0 server wrote it: the original events table, no event_json, no
 * schema_migrations, no content_hash/request_provider/duplicate_of/seq columns. `SQLiteEventStore` adds every
 * one of those through its normal migration chain, culminating in migration 6's usage ledger backfill. */
function buildLegacyDb(file, rows) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      runtime_id TEXT,
      session_id TEXT,
      agent_id TEXT,
      task_id TEXT,
      severity TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  const insert = db.prepare(
    'INSERT INTO events (id, type, timestamp, runtime_id, session_id, agent_id, task_id, severity, summary, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.type ?? 'llm.usage',
      row.timestamp ?? 1_700_000_000_000,
      row.runtimeId ?? null,
      row.sessionId ?? null,
      row.agentId ?? 'auditor',
      row.taskId ?? null,
      row.severity ?? 'normal',
      row.summary ?? 'legacy row',
      row.payloadRaw ?? JSON.stringify(row.payload ?? {}),
      row.createdAt ?? 1_700_000_000_500
    );
  }
  db.close();
}

function ledgerRows(store) {
  return store.db.prepare('SELECT * FROM usage_ledger ORDER BY seq').all().map(dbRowToLedgerRowInput);
}

function ledgerSkips(store) {
  return store.db.prepare('SELECT * FROM usage_ledger_skips ORDER BY event_id').all();
}

test('Backfill: legacy zero defaults, request-id duplicate/conflict, webhook retries, and a corrupt payload', async () => {
  const { dir, file } = tempDbPath('legacy-021');
  buildLegacyDb(file, [
    // Pre-0.2.x "unknown reported as 0" rows (issue #46's own description of the bug this fixed going forward).
    {
      id: 'evt_legacy_zero',
      payload: { provider: 'anthropic', model: 'claude', inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0 },
      createdAt: 1_700_000_000_100,
    },
    // Two SDK events sharing one requestId, same figures: one row (lowest rowid), one duplicate skip.
    {
      id: 'evt_sdk_dup_a',
      payload: { provider: 'OpenAI', model: 'gpt', requestId: 'req-dup-1', inputTokens: 20, outputTokens: 4, cost: 0.02, currency: 'USD', costSource: 'provider-reported' },
      createdAt: 1_700_000_000_200,
    },
    {
      id: 'evt_sdk_dup_b',
      payload: { provider: ' openai ', model: 'gpt', requestId: ' req-dup-1 ', inputTokens: 20, outputTokens: 4, cost: 0.02, currency: 'USD', costSource: 'provider-reported' },
      createdAt: 1_700_000_000_210,
    },
    // Two SDK events sharing one requestId, different figures: one row, one conflict skip referencing it.
    {
      id: 'evt_sdk_conflict_a',
      payload: { provider: 'google', model: 'gemini', requestId: 'req-conflict-1', inputTokens: 50, outputTokens: 9 },
      createdAt: 1_700_000_000_300,
    },
    {
      id: 'evt_sdk_conflict_b',
      payload: { provider: 'google', model: 'gemini', requestId: 'req-conflict-1', inputTokens: 51, outputTokens: 9 },
      createdAt: 1_700_000_000_310,
    },
    // Two webhook retries of one call, random ids, no requestId: two rows, never merged by guesswork.
    {
      id: 'evt_wh_usage_retry1',
      payload: { provider: 'anthropic', model: 'claude', inputTokens: 0, outputTokens: 0 },
      createdAt: 1_700_000_000_400,
    },
    {
      id: 'evt_wh_usage_retry2',
      payload: { provider: 'anthropic', model: 'claude', inputTokens: 0, outputTokens: 0 },
      createdAt: 1_700_000_000_410,
    },
    // A row whose payload cannot be parsed: an unparseable skip, migration continues.
    {
      id: 'evt_corrupt',
      payloadRaw: '{not valid json',
      createdAt: 1_700_000_000_500,
    },
    // A pre-0.3.0 webhook usage event with no provider and no model (the 0.2.1 webhook schema let every usage
    // field through optionally): accepted, with provider and model NULL, never rejected.
    {
      id: 'evt_wh_usage_noprovider',
      payload: { inputTokens: 1, outputTokens: 1 },
      createdAt: 1_700_000_000_450,
    },
    // An llm.failed row, to confirm the backfill also covers it.
    {
      id: 'evt_legacy_failed',
      type: 'llm.failed',
      payload: { provider: 'anthropic', model: 'claude', errorKind: 'timeout' },
      createdAt: 1_700_000_000_600,
    },
    // Not a usage/failed event: must never produce a row or a skip.
    {
      id: 'evt_legacy_status',
      type: 'agent.status.changed',
      payload: { status: 'IDLE' },
      createdAt: 1_700_000_000_700,
    },
  ]);

  const store = new SQLiteEventStore(file, { backup: 'off' });
  try {
    const rows = ledgerRows(store);
    const byId = Object.fromEntries(rows.map((r) => [r.eventId, r]));

    // legacy_zero, sdk_dup_a, sdk_conflict_a, wh_usage_retry1, wh_usage_retry2, legacy_failed, wh_usage_noprovider = 7.
    assert.equal(rows.length, 7);
    assert.ok(!byId.evt_sdk_dup_b, 'the duplicate never gets its own row');
    assert.ok(!byId.evt_sdk_conflict_b, 'the conflict never gets its own row');
    assert.ok(!byId.evt_corrupt);
    assert.ok(!byId.evt_legacy_status);

    for (const row of rows) {
      assert.equal(row.origin, 'backfill');
      assert.equal(row.legacyContract, true, `${row.eventId} must be legacy_contract=1`);
    }

    const zero = byId.evt_legacy_zero;
    assert.equal(zero.cacheReadTokens, null, '0 cachedTokens means unknown under the legacy rule');
    assert.equal(zero.reasoningTokens, null);

    const dupA = byId.evt_sdk_dup_a;
    assert.equal(dupA.provider, 'openai', 'normalized provider');
    assert.equal(dupA.requestId, 'req-dup-1');

    const whRetry1 = byId.evt_wh_usage_retry1;
    const whRetry2 = byId.evt_wh_usage_retry2;
    assert.equal(whRetry1.ingestChannel, 'webhook');
    assert.equal(whRetry2.ingestChannel, 'webhook');
    assert.equal(whRetry1.requestId, null);
    assert.equal(whRetry2.requestId, null);
    // The legacy webhook zero rule applies: a reported 0 input/output means unknown on these rows.
    assert.equal(whRetry1.inputTokens, null);
    assert.equal(whRetry1.outputTokens, null);

    const failed = byId.evt_legacy_failed;
    assert.equal(failed.status, 'timeout');
    assert.equal(failed.errorKind, 'timeout');

    const noProvider = byId.evt_wh_usage_noprovider;
    assert.equal(noProvider.ingestChannel, 'webhook');
    assert.equal(noProvider.provider, null, 'a pre-0.3.0 webhook usage event without provider is accepted');
    assert.equal(noProvider.model, null);

    const skips = ledgerSkips(store);
    const skipById = Object.fromEntries(skips.map((s) => [s.event_id, s]));
    assert.equal(skipById.evt_sdk_dup_b.reason, 'duplicate');
    assert.equal(skipById.evt_sdk_dup_b.kept_event_id, 'evt_sdk_dup_a');
    assert.equal(skipById.evt_sdk_conflict_b.reason, 'conflict');
    assert.equal(skipById.evt_sdk_conflict_b.kept_event_id, 'evt_sdk_conflict_a');
    assert.equal(skipById.evt_corrupt.reason, 'unparseable');
    assert.equal(skipById.evt_corrupt.kept_event_id, null);

    const status = await store.usageLedgerStatus();
    assert.equal(status.rows, 7);
    assert.equal(status.rowsByOrigin.backfill, 7);
    assert.equal(status.rowsByOrigin.live, 0);
    assert.equal(status.legacyRows, 7);
    assert.deepEqual(status.skips, { duplicate: 1, conflict: 1, unparseable: 1 });
    assert.ok(status.migration);
    assert.match(status.migration.id, /usage_ledger$/);

    // Idempotent re-open: a second store over the same file adds no rows and no skips.
    await store.close();
    const reopened = new SQLiteEventStore(file, { backup: 'off' });
    try {
      assert.equal(ledgerRows(reopened).length, 7);
      assert.equal(ledgerSkips(reopened).length, 3);
    } finally {
      await reopened.close();
    }
  } finally {
    try {
      await store.close();
    } catch {
      // Already closed above in the idempotent-reopen branch.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Backfill: a pre-0.2.0 database with no event_json still backfills from the payload column', async () => {
  const { dir, file } = tempDbPath('pre-020');
  buildLegacyDb(file, [
    { id: 'evt_pre020_usage', payload: { provider: 'p', model: 'm', inputTokens: 7, outputTokens: 2 }, createdAt: 1_700_000_000_000 },
  ]);
  const store = new SQLiteEventStore(file, { backup: 'off' });
  try {
    const columns = store.db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
    assert.ok(columns.includes('event_json'), 'the baseline migration adds event_json even to a pre-0.2.0 table');
    const [row] = ledgerRows(store);
    assert.equal(row.eventId, 'evt_pre020_usage');
    assert.equal(row.provider, 'p');
    assert.equal(row.inputTokens, 7);
    assert.equal(row.legacyContract, true);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Startup catch-up: a row written directly to events after the ledger exists is picked up on restart', async () => {
  const { dir, file } = tempDbPath('catchup');
  const first = new SQLiteEventStore(file, { backup: 'off' });
  await first.append({
    schemaVersion: '1.0',
    id: 'evt_live_before',
    type: 'llm.usage',
    timestamp: 1_700_000_000_000,
    source: 'agent:a',
    agentId: 'a',
    severity: 'normal',
    summary: 's',
    payload: { provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1 },
  });
  await first.close();

  // Simulate an older server (or a direct writer) inserting straight into `events`, bypassing the ledger.
  const raw = new DatabaseSync(file);
  raw
    .prepare(
      'INSERT INTO events (id, type, timestamp, runtime_id, session_id, agent_id, task_id, severity, summary, payload, created_at, event_json) VALUES (?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, NULL)'
    )
    .run('evt_bypassed', 'llm.usage', 1_700_000_001_000, 'b', 'normal', 's', JSON.stringify({ provider: 'p2', model: 'm2', inputTokens: 9, outputTokens: 3 }), 1_700_000_001_500);
  raw.close();

  const second = new SQLiteEventStore(file, { backup: 'off' });
  try {
    const rows = ledgerRows(second);
    const bypassed = rows.find((r) => r.eventId === 'evt_bypassed');
    assert.ok(bypassed, 'the restart must fill exactly the missing row');
    assert.equal(bypassed.origin, 'backfill');
    assert.equal(rows.length, 2);

    // Re-running catch-up again (a third open) adds nothing further.
    await second.close();
    const third = new SQLiteEventStore(file, { backup: 'off' });
    try {
      assert.equal(ledgerRows(third).length, 2);
    } finally {
      await third.close();
    }
  } finally {
    try {
      await second.close();
    } catch {
      // Already closed above.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runUsageLedgerBackfill: paging over several small pages matches a single-pass result (smaller dataset standing in for the issue\'s 100,000-row case)', async () => {
  const totalRows = 25;
  const pageSize = 10; // forces 3 pages (10 + 10 + 5), the same shape as the issue's "three rowid ranges"

  const buildRows = () =>
    Array.from({ length: totalRows }, (_, i) => ({
      id: `evt_page_${i}`,
      payload: { provider: 'p', model: 'm', requestId: `req-page-${i}`, inputTokens: i, outputTokens: i },
      createdAt: 1_700_000_000_000 + i,
    }));

  const single = tempDbPath('paging-single');
  const paged = tempDbPath('paging-multi');
  try {
    buildLegacyDb(single.file, buildRows());
    buildLegacyDb(paged.file, buildRows());

    // Give both files the tables the backfill writes into, and a baseline row so legacyContractCutoff resolves,
    // without going through the full migration runner (this test targets the backfill function in isolation).
    for (const file of [single.file, paged.file]) {
      const db = new DatabaseSync(file);
      db.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL, app_version TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES (1, 'baseline', 1700000000050, 'test');
        CREATE TABLE usage_ledger (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL,
          request_id TEXT, received_at INTEGER NOT NULL, occurred_at INTEGER NOT NULL, origin TEXT NOT NULL,
          legacy_contract INTEGER NOT NULL DEFAULT 0, ingest_channel TEXT NOT NULL, runtime_id TEXT, session_id TEXT,
          agent_id TEXT, task_id TEXT, provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
          cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, cost REAL, currency TEXT,
          cost_source TEXT NOT NULL, latency_ms INTEGER, status TEXT NOT NULL, error_kind TEXT, trace_id TEXT,
          parent_id TEXT, tool_call_id TEXT, meeting_id TEXT, user_id TEXT, tags TEXT NOT NULL DEFAULT '[]',
          summary TEXT
        );
        CREATE UNIQUE INDEX ux_usage_ledger_request ON usage_ledger(provider, request_id) WHERE request_id IS NOT NULL;
        CREATE TABLE usage_ledger_skips (
          event_id TEXT PRIMARY KEY, reason TEXT NOT NULL, kept_event_id TEXT, detected_at INTEGER NOT NULL, origin TEXT NOT NULL
        );
      `);
      db.close();
    }

    const singleDb = new DatabaseSync(single.file);
    const singleStats = runUsageLedgerBackfill(singleDb, { origin: 'backfill', legacyContractCutoff: 1_700_000_000_050 }, { pageSize: 1_000_000, log: () => {} });
    const singleRows = singleDb.prepare('SELECT event_id FROM usage_ledger ORDER BY event_id').all();
    singleDb.close();

    const pagedDb = new DatabaseSync(paged.file);
    const pageLines = [];
    const pagedStats = runUsageLedgerBackfill(pagedDb, { origin: 'backfill', legacyContractCutoff: 1_700_000_000_050 }, { pageSize, log: (line) => pageLines.push(line) });
    const pagedRows = pagedDb.prepare('SELECT event_id FROM usage_ledger ORDER BY event_id').all();
    // Re-running must add nothing (idempotent).
    const rerunStats = runUsageLedgerBackfill(pagedDb, { origin: 'backfill', legacyContractCutoff: 1_700_000_000_050 }, { pageSize, log: () => {} });
    pagedDb.close();

    assert.equal(singleStats.inserted, totalRows);
    assert.equal(pagedStats.inserted, totalRows);
    assert.equal(pagedStats.pages, 3, 'ceil(25 / 10) = 3 pages');
    assert.deepEqual(pagedRows, singleRows);
    assert.equal(rerunStats.inserted, 0);
    assert.equal(rerunStats.scanned, 0);
    // One progress line per page, plus the final summary line.
    assert.equal(pageLines.filter((l) => l.includes('page ')).length, 3);
    assert.equal(pageLines.filter((l) => !l.includes('page ')).length, 1);
  } finally {
    fs.rmSync(single.dir, { recursive: true, force: true });
    fs.rmSync(paged.dir, { recursive: true, force: true });
  }
});
