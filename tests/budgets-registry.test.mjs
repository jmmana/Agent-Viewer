// Issue #303 (sub-issue of #85): BudgetRegistry storage. Exercises `createMemoryBudgetRegistry` and
// `createSqliteBudgetRegistry` (server/budgets.ts) against the same contract (CRUD, validation, append-only
// revisions with actor/auth, soft delete, and the evaluation cache keyed on (ledger write sequence, window
// start, budget revision)), a memory-vs-SQLite parity run with a fixed clock and explicit ids, and SQLite
// persistence across a process restart (close the file, reopen a fresh DatabaseSync, run migrations again).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../server/db/migrations.ts';
import { readPackageVersion } from '../server/version.ts';
import {
  createMemoryBudgetRegistry,
  createSqliteBudgetRegistry,
  BudgetValidationError,
} from '../server/budgets.ts';

const appVersion = readPackageVersion();

function tempDbFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-budgets-registry-'));
  return path.join(dir, 'budgets.db');
}

function openMigratedDb(file) {
  const db = new DatabaseSync(file);
  runMigrations(db, { appVersion, filePath: file, backup: 'off' });
  return db;
}

function withMemoryRegistry(now, fn) {
  return fn(createMemoryBudgetRegistry({ now }));
}

function withSqliteRegistry(now, fn) {
  const file = tempDbFile();
  const db = openMigratedDb(file);
  try {
    return fn(createSqliteBudgetRegistry(db, { now }), { db, file });
  } finally {
    db.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

const OPEN = { actor: null, auth: 'open' };
const TOKEN = (actor) => ({ actor, auth: 'token' });

function budgetInput(overrides = {}) {
  return {
    name: 'Monthly agents',
    scope: { type: 'all', value: null },
    period: 'month',
    currency: 'USD',
    basis: 'reported',
    limit: 100,
    ...overrides,
  };
}

const BACKENDS = [
  { name: 'memory', withRegistry: withMemoryRegistry },
  { name: 'sqlite', withRegistry: withSqliteRegistry },
];

for (const backend of BACKENDS) {
  test(`${backend.name}: create applies documented defaults and starts at revision 1`, () => {
    backend.withRegistry(() => 1000, (registry) => {
      const budget = registry.create(budgetInput({ id: 'bud_fixed' }), OPEN);
      assert.equal(budget.id, 'bud_fixed');
      assert.equal(budget.timezone, 'UTC');
      assert.equal(budget.warningRatio, 0.8);
      assert.equal(budget.enabled, true);
      assert.equal(budget.revision, 1);
      assert.equal(budget.createdAt, 1000);
      assert.equal(budget.updatedAt, 1000);
      assert.equal(registry.get('bud_fixed').name, 'Monthly agents');
    });
  });

  test(`${backend.name}: create without an id mints a "bud_" prefixed id, never reused`, () => {
    backend.withRegistry(() => 1000, (registry) => {
      const a = registry.create(budgetInput(), OPEN);
      const b = registry.create(budgetInput({ name: 'Second' }), OPEN);
      assert.match(a.id, /^bud_/);
      assert.notEqual(a.id, b.id);
    });
  });

  test(`${backend.name}: create rejects an id that already exists, even if soft-deleted`, () => {
    backend.withRegistry(() => 1000, (registry) => {
      registry.create(budgetInput({ id: 'bud_dup' }), OPEN);
      assert.throws(() => registry.create(budgetInput({ id: 'bud_dup' }), OPEN), BudgetValidationError);
      registry.delete('bud_dup', OPEN);
      assert.throws(() => registry.create(budgetInput({ id: 'bud_dup' }), OPEN), BudgetValidationError);
    });
  });

  test(`${backend.name}: create validates name, scope, currency, limit and warningRatio`, () => {
    backend.withRegistry(() => 1000, (registry) => {
      assert.throws(() => registry.create(budgetInput({ name: '' }), OPEN), BudgetValidationError);
      assert.throws(() => registry.create(budgetInput({ name: 'x'.repeat(121) }), OPEN), BudgetValidationError);
      assert.throws(() => registry.create(budgetInput({ scope: { type: 'agent', value: null } }), OPEN), BudgetValidationError);
      assert.throws(() => registry.create(budgetInput({ scope: { type: 'all', value: 'oops' } }), OPEN), BudgetValidationError);
      assert.throws(() => registry.create(budgetInput({ currency: 'usd' }), OPEN), BudgetValidationError);
      assert.throws(() => registry.create(budgetInput({ currency: 'US' }), OPEN), BudgetValidationError);
      assert.throws(() => registry.create(budgetInput({ limit: 0 }), OPEN), BudgetValidationError);
      assert.throws(() => registry.create(budgetInput({ limit: -5 }), OPEN), BudgetValidationError);
      assert.throws(() => registry.create(budgetInput({ limit: 1e13 }), OPEN), BudgetValidationError);
      assert.throws(() => registry.create(budgetInput({ warningRatio: 0 }), OPEN), BudgetValidationError);
      assert.throws(() => registry.create(budgetInput({ warningRatio: 1 }), OPEN), BudgetValidationError);
      assert.throws(() => registry.create(budgetInput({ timezone: 'Not/AZone' }), OPEN), BudgetValidationError);
      assert.throws(() => registry.create(budgetInput(), { actor: 'x'.repeat(101), auth: 'open' }), BudgetValidationError);
    });
  });

  test(`${backend.name}: update merges fields, bumps revision and updatedAt, leaves createdAt alone`, () => {
    let tick = 1000;
    backend.withRegistry(() => tick, (registry) => {
      const created = registry.create(budgetInput({ id: 'bud_u' }), OPEN);
      tick = 2000;
      const updated = registry.update('bud_u', { limit: 200 }, TOKEN('alice'));
      assert.equal(updated.limit, 200);
      assert.equal(updated.name, created.name);
      assert.equal(updated.revision, 2);
      assert.equal(updated.createdAt, 1000);
      assert.equal(updated.updatedAt, 2000);
    });
  });

  test(`${backend.name}: update returns null for an unknown or soft-deleted id, and never creates a revision for it`, () => {
    backend.withRegistry(() => 1000, (registry) => {
      assert.equal(registry.update('bud_missing', { limit: 5 }, OPEN), null);
      registry.create(budgetInput({ id: 'bud_gone' }), OPEN);
      registry.delete('bud_gone', OPEN);
      assert.equal(registry.update('bud_gone', { limit: 5 }, OPEN), null);
      assert.equal(registry.listRevisions('bud_gone').length, 2); // create + delete only
    });
  });

  test(`${backend.name}: update replaces scope as a whole, never merges its sub-fields`, () => {
    backend.withRegistry(() => 1000, (registry) => {
      registry.create(budgetInput({ id: 'bud_s', scope: { type: 'agent', value: 'agent-1' } }), OPEN);
      const updated = registry.update('bud_s', { scope: { type: 'model', value: 'claude' } }, OPEN);
      assert.deepEqual(updated.scope, { type: 'model', value: 'claude' });
    });
  });

  test(`${backend.name}: delete soft-deletes: excluded from get/list, false on a second delete, revision still bumps`, () => {
    backend.withRegistry(() => 1000, (registry) => {
      registry.create(budgetInput({ id: 'bud_d' }), OPEN);
      registry.create(budgetInput({ id: 'bud_keep', name: 'Keep me' }), OPEN);
      assert.equal(registry.delete('bud_d', TOKEN('bob')), true);
      assert.equal(registry.get('bud_d'), null);
      assert.deepEqual(registry.list().map((b) => b.id), ['bud_keep']);
      assert.equal(registry.delete('bud_d', OPEN), false);
      assert.equal(registry.delete('bud_missing', OPEN), false);
    });
  });

  test(`${backend.name}: list is ordered oldest createdAt first, ties broken by id`, () => {
    let tick = 1000;
    backend.withRegistry(() => tick, (registry) => {
      registry.create(budgetInput({ id: 'bud_b' }), OPEN);
      tick = 500; // an earlier clock reading than the first create; still a tie-break case when equal
      registry.create(budgetInput({ id: 'bud_a' }), OPEN);
      const ids = registry.list().map((b) => b.id);
      assert.deepEqual(ids, ['bud_a', 'bud_b']);
    });
  });

  test(`${backend.name}: revisions are append-only, one per create/update/delete, with actor and auth recorded`, () => {
    let tick = 1000;
    backend.withRegistry(() => tick, (registry) => {
      registry.create(budgetInput({ id: 'bud_r' }), TOKEN('alice'));
      tick = 1500;
      registry.update('bud_r', { limit: 50 }, OPEN);
      tick = 2000;
      registry.delete('bud_r', TOKEN('bob'));

      const revisions = registry.listRevisions('bud_r');
      assert.equal(revisions.length, 3);
      assert.deepEqual(revisions.map((r) => r.action), ['create', 'update', 'delete']);
      assert.deepEqual(revisions.map((r) => r.revision), [1, 2, 3]);
      assert.equal(revisions[0].actor, 'alice');
      assert.equal(revisions[0].auth, 'token');
      assert.equal(revisions[1].actor, null);
      assert.equal(revisions[1].auth, 'open');
      assert.equal(revisions[2].actor, 'bob');
      assert.equal(revisions[1].snapshot.limit, 50);
      assert.equal(revisions[2].snapshot.limit, 50);
    });
  });

  test(`${backend.name}: listRevisions is empty for an unknown budget id`, () => {
    backend.withRegistry(() => 1000, (registry) => {
      assert.deepEqual(registry.listRevisions('bud_never'), []);
    });
  });

  test(`${backend.name}: evaluation cache hits only on an exact (ledgerSeq, windowStart, revision) match`, () => {
    backend.withRegistry(() => 1000, (registry) => {
      registry.create(budgetInput({ id: 'bud_c' }), OPEN);
      const key = { ledgerSeq: 10, windowStart: 123, revision: 1 };
      const status = { state: 'ok', evaluatedAt: 1000 };

      assert.equal(registry.getCachedStatus('bud_c', key), null);
      registry.setCachedStatus('bud_c', key, status);
      assert.deepEqual(registry.getCachedStatus('bud_c', key), status);

      assert.equal(registry.getCachedStatus('bud_c', { ...key, ledgerSeq: 11 }), null);
      assert.equal(registry.getCachedStatus('bud_c', { ...key, windowStart: 124 }), null);
      assert.equal(registry.getCachedStatus('bud_c', { ...key, revision: 2 }), null);

      const newer = { ...status, state: 'warning' };
      const newerKey = { ledgerSeq: 20, windowStart: 123, revision: 1 };
      registry.setCachedStatus('bud_c', newerKey, newer);
      assert.equal(registry.getCachedStatus('bud_c', key), null);
      assert.deepEqual(registry.getCachedStatus('bud_c', newerKey), newer);
    });
  });

  // Issue #305: `getLastStatus` reads the same row as `getCachedStatus`/`setCachedStatus`, but ignores the key
  // entirely, so a stale key (one that would be a `getCachedStatus` miss) still comes back.
  test(`${backend.name}: getLastStatus ignores the cache key and returns null only when nothing was ever written`, () => {
    backend.withRegistry(() => 1000, (registry) => {
      registry.create(budgetInput({ id: 'bud_last' }), OPEN);
      assert.equal(registry.getLastStatus('bud_last'), null, 'nothing written yet');
      assert.equal(registry.getLastStatus('bud_never_existed'), null, 'unknown id');

      const key = { ledgerSeq: 1, windowStart: 100, revision: 1 };
      const status = { state: 'ok', evaluatedAt: 1000 };
      registry.setCachedStatus('bud_last', key, status);
      assert.deepEqual(registry.getLastStatus('bud_last'), status);

      // A key that would be a `getCachedStatus` miss (a different window, as a real rollover would produce) still
      // comes back from `getLastStatus`: that staleness is exactly what "the previous state" must mean for #305's
      // live-transition diffing.
      const staleKey = { ...key, windowStart: 200 };
      assert.equal(registry.getCachedStatus('bud_last', staleKey), null);
      assert.deepEqual(registry.getLastStatus('bud_last'), status);

      const newerStatus = { state: 'warning', evaluatedAt: 2000 };
      registry.setCachedStatus('bud_last', staleKey, newerStatus);
      assert.deepEqual(registry.getLastStatus('bud_last'), newerStatus, 'the most recent write wins, same as getCachedStatus');
    });
  });
}

test('sqlite: data, revisions and the evaluation cache survive closing and reopening the database file', () => {
  const file = tempDbFile();
  try {
    const db1 = openMigratedDb(file);
    const registry1 = createSqliteBudgetRegistry(db1, { now: () => 1000 });
    registry1.create(budgetInput({ id: 'bud_restart' }), TOKEN('alice'));
    registry1.update('bud_restart', { limit: 250 }, OPEN);
    registry1.setCachedStatus('bud_restart', { ledgerSeq: 5, windowStart: 1, revision: 2 }, { state: 'ok', evaluatedAt: 1000 });
    db1.close();

    const db2 = openMigratedDb(file);
    const registry2 = createSqliteBudgetRegistry(db2, { now: () => 2000 });

    const budget = registry2.get('bud_restart');
    assert.ok(budget);
    assert.equal(budget.limit, 250);
    assert.equal(budget.revision, 2);

    const revisions = registry2.listRevisions('bud_restart');
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0].actor, 'alice');

    const cached = registry2.getCachedStatus('bud_restart', { ledgerSeq: 5, windowStart: 1, revision: 2 });
    assert.deepEqual(cached, { state: 'ok', evaluatedAt: 1000 });

    db2.close();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('sqlite: budget_revisions is append-only at the database level (UPDATE and DELETE are rejected)', () => {
  const file = tempDbFile();
  try {
    const db = openMigratedDb(file);
    const registry = createSqliteBudgetRegistry(db, { now: () => 1000 });
    registry.create(budgetInput({ id: 'bud_guard' }), OPEN);
    assert.throws(() => db.exec("UPDATE budget_revisions SET actor = 'hacked' WHERE budget_id = 'bud_guard'"), /append-only/);
    assert.throws(() => db.exec("DELETE FROM budget_revisions WHERE budget_id = 'bud_guard'"), /append-only/);
    db.close();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test('parity: memory and SQLite registries agree on create/update/delete/list/listRevisions for the same operations', () => {
  const file = tempDbFile();
  try {
    const db = openMigratedDb(file);
    let tick = 1000;
    const clock = () => tick;
    const memory = createMemoryBudgetRegistry({ now: clock });
    const sqlite = createSqliteBudgetRegistry(db, { now: clock });

    function runOps(registry) {
      registry.create(budgetInput({ id: 'bud_p1', scope: { type: 'agent', value: 'agent-1' } }), TOKEN('alice'));
      tick += 100;
      registry.create(budgetInput({ id: 'bud_p2', name: 'Second', limit: 50 }), OPEN);
      tick += 100;
      registry.update('bud_p1', { limit: 75, warningRatio: 0.5 }, TOKEN('bob'));
      tick += 100;
      registry.delete('bud_p2', OPEN);
      return {
        list: registry.list(),
        revisionsP1: registry.listRevisions('bud_p1'),
        revisionsP2: registry.listRevisions('bud_p2'),
        p1: registry.get('bud_p1'),
        p2: registry.get('bud_p2'),
      };
    }

    const memoryResult = runOps(memory);
    tick = 1000;
    const sqliteResult = runOps(sqlite);

    assert.deepEqual(sqliteResult.list, memoryResult.list);
    assert.deepEqual(sqliteResult.p1, memoryResult.p1);
    assert.deepEqual(sqliteResult.p2, memoryResult.p2);
    assert.deepEqual(
      sqliteResult.revisionsP1.map(({ id: _id, ...rest }) => rest),
      memoryResult.revisionsP1.map(({ id: _id, ...rest }) => rest)
    );
    assert.deepEqual(
      sqliteResult.revisionsP2.map(({ id: _id, ...rest }) => rest),
      memoryResult.revisionsP2.map(({ id: _id, ...rest }) => rest)
    );

    db.close();
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
