// Issue #66's migration (`usage-rollup`, version 8): backfills `usage_ledger_tags` from the existing
// `usage_ledger.tags` JSON column, adds the tag-join indexes, and keeps the tag table in sync with the ledger
// going forward (new rows write their own tags, a deleted ledger row cascades). Builds a database staged at
// schema version 7 (as if written by a 0.4.0 server that had #65 and #67 but not yet #66), the same way
// tests/usage-ledger-backfill.test.mjs stages a pre-0.4.0 fixture, then reopens it with every migration to
// trigger migration 8. Staged at version 7, not 6: #67's own migration (`usage-calls-indexes`) merged first and
// claimed version 7, and its constructor unconditionally reads the `usage_ledger_meta` table that migration
// creates, so a store can only ever be opened once every migration up to the one it depends on has run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteEventStore } from '../server/store.ts';
import { MIGRATIONS } from '../server/db/migrations.ts';

function tempDbPath(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-viewer-rollup-migration-'));
  return { dir, file: path.join(dir, `${name}.db`) };
}

const noopLogger = { info() {}, warn() {}, error() {} };

test('migration usage-rollup: backfills usage_ledger_tags from existing tags JSON, with the right indexes', async () => {
  const { dir, file } = tempDbPath('stage7');

  // Stage a database at schema version 7: every migration except usage-rollup itself.
  const stagedMigrations = MIGRATIONS.slice(0, 7);
  assert.equal(stagedMigrations.at(-1).name, 'usage-calls-indexes');
  const staging = new SQLiteEventStore(file, { backup: 'off', migrations: stagedMigrations, logger: noopLogger });
  await staging.init();

  // Insert ledger rows directly, with tags, as #65 would have written them.
  const db = staging.db;
  db.prepare(
    `INSERT INTO usage_ledger (
      event_id, event_type, request_id, received_at, occurred_at, origin, legacy_contract, ingest_channel,
      cost, cost_source, status, tags
    ) VALUES (?, 'llm.usage', NULL, ?, ?, 'live', 0, 'events', NULL, 'unknown', 'ok', ?)`
  ).run('evt_mig_a', 1000, 1000, JSON.stringify(['alpha', 'beta']));
  db.prepare(
    `INSERT INTO usage_ledger (
      event_id, event_type, request_id, received_at, occurred_at, origin, legacy_contract, ingest_channel,
      cost, cost_source, status, tags
    ) VALUES (?, 'llm.usage', NULL, ?, ?, 'live', 0, 'events', NULL, 'unknown', 'ok', ?)`
  ).run('evt_mig_b', 2000, 2000, JSON.stringify(['beta']));
  db.prepare(
    `INSERT INTO usage_ledger (
      event_id, event_type, request_id, received_at, occurred_at, origin, legacy_contract, ingest_channel,
      cost, cost_source, status, tags
    ) VALUES (?, 'llm.usage', NULL, ?, ?, 'live', 0, 'events', NULL, 'unknown', 'ok', ?)`
  ).run('evt_mig_c', 3000, 3000, JSON.stringify([]));

  // Confirm usage_ledger_tags does not exist yet at this schema version.
  const tableBefore = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_ledger_tags'").get();
  assert.equal(tableBefore, undefined);
  await staging.close();

  // Reopen with every migration: this runs migration 7 (usage-rollup), including its own backfill.
  const upgraded = new SQLiteEventStore(file, { backup: 'off', logger: noopLogger });
  await upgraded.init();
  try {
    assert.equal(upgraded.migration.toVersion, MIGRATIONS.length);
    const udb = upgraded.db;

    const tagRows = udb.prepare('SELECT ledger_seq, tag FROM usage_ledger_tags ORDER BY ledger_seq, tag').all();
    const bySeq = new Map();
    for (const row of tagRows) {
      const list = bySeq.get(row.ledger_seq) ?? [];
      list.push(row.tag);
      bySeq.set(row.ledger_seq, list);
    }
    const seqByEvent = Object.fromEntries(
      udb.prepare('SELECT event_id, seq FROM usage_ledger').all().map((r) => [r.event_id, r.seq])
    );
    assert.deepEqual(bySeq.get(seqByEvent.evt_mig_a), ['alpha', 'beta']);
    assert.deepEqual(bySeq.get(seqByEvent.evt_mig_b), ['beta']);
    assert.equal(bySeq.has(seqByEvent.evt_mig_c), false, 'a row with no tags gets no tag rows');

    // Indexes exist for the EXPLAIN QUERY PLAN budget.
    const indexNames = new Set(
      udb.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((r) => r.name)
    );
    for (const name of ['ix_usage_ledger_tags_tag', 'ix_usage_ledger_model_received', 'ix_usage_ledger_task', 'ix_usage_ledger_user']) {
      assert.ok(indexNames.has(name), `missing index ${name}`);
    }

    // Append-only: an UPDATE on usage_ledger_tags must fail.
    assert.throws(() => udb.prepare("UPDATE usage_ledger_tags SET tag = 'x'").run(), /append-only/);

    // Cascade: deleting a ledger row deletes its tag rows (the no-FK-but-still-cascading rule from #65/#66).
    const seqA = seqByEvent.evt_mig_a;
    udb.prepare('DELETE FROM usage_ledger WHERE seq = ?').run(seqA);
    const remaining = udb.prepare('SELECT COUNT(*) AS n FROM usage_ledger_tags WHERE ledger_seq = ?').get(seqA);
    assert.equal(remaining.n, 0);
  } finally {
    await upgraded.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration usage-rollup: a new live-path row writes its tags in the same transaction, and reopening the store again is a no-op', async () => {
  const { dir, file } = tempDbPath('live-tags');
  const store = new SQLiteEventStore(file, { backup: 'off', logger: noopLogger });
  await store.init();
  try {
    const { validateCanonicalEvent } = await import('../src/integrations/canonicalContract.ts');
    const result = validateCanonicalEvent({
      id: 'evt_live_tags',
      type: 'llm.usage',
      timestamp: 1_700_000_000_000,
      source: 'agent:tagger',
      agentId: 'tagger',
      summary: 'tagged call',
      payload: {
        provider: 'p',
        model: 'm',
        inputTokens: 1,
        outputTokens: 1,
        cost: 1,
        currency: 'USD',
        costSource: 'provider-reported',
        tags: ['live-a', 'live-b'],
      },
    });
    assert.equal(result.success, true);
    await store.append(result.data);

    const tags = store.db
      .prepare(
        'SELECT t.tag FROM usage_ledger_tags t JOIN usage_ledger l ON l.seq = t.ledger_seq WHERE l.event_id = ? ORDER BY t.tag'
      )
      .all('evt_live_tags')
      .map((r) => r.tag);
    assert.deepEqual(tags, ['live-a', 'live-b']);
  } finally {
    await store.close();
  }

  // Reopening an already-fully-migrated file must not re-run migration 7's one-time backfill or error.
  const reopened = new SQLiteEventStore(file, { backup: 'off', logger: noopLogger });
  await reopened.init();
  try {
    assert.equal(reopened.migration.applied.length, 0, 'no migration should re-apply on a second open');
    const count = reopened.db.prepare('SELECT COUNT(*) AS n FROM usage_ledger_tags').get();
    assert.equal(count.n, 2);
  } finally {
    await reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
