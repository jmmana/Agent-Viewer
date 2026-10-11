// Issue #83 (sub-issue: pricing file store, lifecycle and CLI wiring, issue #271). Exercises
// `createPricingStore` directly against a temp directory per test, per #83's own test list: first-start
// seeding, a pre-written file, version numbering, no-op detection, file reload with source forcing, invalid
// file handling, a stale file after an interrupted write, regeneration of a deleted pricing.json, torn and
// corrupted history lines, write failures at the temp-file and history-append steps, a rename failure
// (fileInSync: false), restart persistence independent of AGENT_VIEWER_STORAGE, and serialized writes.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPricingStore,
  resolveHistoryFilePath,
  resolvePricingFilePath,
  isPricingReadonly,
  PricingStoreUnwritableError,
} from '../server/pricing/store.ts';
import starter from '../server/pricing/starter.json' with { type: 'json' };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'av-pricing-store-'));
}

function storePaths(dir) {
  return { pricingFile: path.join(dir, 'pricing.json'), historyFile: path.join(dir, 'pricing-history.jsonl') };
}

function inputEntry(overrides = {}) {
  return {
    provider: 'acme',
    model: 'acme-1',
    kind: 'list',
    currency: 'USD',
    effectiveFrom: '2026-01-01T00:00:00Z',
    inputPerMillion: 1,
    outputPerMillion: 5,
    ...overrides,
  };
}

function readPricingFile(dir) {
  return JSON.parse(fs.readFileSync(storePaths(dir).pricingFile, 'utf8'));
}

function writePricingFile(dir, content) {
  fs.writeFileSync(storePaths(dir).pricingFile, JSON.stringify(content, null, 2));
}

function withTempDir(fn) {
  const dir = tempDir();
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('first start with no files seeds the bundled starter as version 1 and writes both files', () => {
  withTempDir((dir) => {
    const store = createPricingStore(storePaths(dir));
    const snapshot = store.getSnapshot();
    assert.equal(snapshot.status, 'ok');
    assert.equal(snapshot.pricingVersion, 1);
    assert.equal(snapshot.parentVersion, null);
    assert.equal(snapshot.origin, 'starter');
    assert.equal(snapshot.starterAsOf, starter.starter.asOf);
    assert.ok(snapshot.entries.length > 0);
    assert.ok(fs.existsSync(storePaths(dir).pricingFile));
    const historyLines = fs.readFileSync(storePaths(dir).historyFile, 'utf8').trim().split('\n');
    assert.equal(historyLines.length, 1);
  });
});

test('first start with a pre-written valid pricing.json adopts it as version 1, origin file; the starter is not applied', () => {
  withTempDir((dir) => {
    writePricingFile(dir, { schema: 'agent-viewer.pricing/1', entries: [inputEntry()] });
    const store = createPricingStore(storePaths(dir));
    const snapshot = store.getSnapshot();
    assert.equal(snapshot.pricingVersion, 1);
    assert.equal(snapshot.origin, 'file');
    assert.equal(snapshot.starterAsOf, null);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].source, 'file');
  });
});

test('an invalid pre-written pricing.json at first start reports file_invalid with no version, never the starter', () => {
  withTempDir((dir) => {
    writePricingFile(dir, { schema: 'agent-viewer.pricing/1', entries: [{ provider: 'a' }] });
    const store = createPricingStore(storePaths(dir));
    const snapshot = store.getSnapshot();
    assert.equal(snapshot.status, 'file_invalid');
    assert.equal(snapshot.pricingVersion, null);
    assert.deepEqual(snapshot.entries, []);
    assert.ok(snapshot.issues.length > 0);
  });
});

test('reload with an unchanged file is a no-op: no new version is created', () => {
  withTempDir((dir) => {
    const store = createPricingStore(storePaths(dir));
    store.getSnapshot();
    const reloaded = store.reload();
    assert.equal(reloaded.pricingVersion, 1);
    assert.equal(store.listVersions().length, 1);
  });
});

test('editing pricing.json and reloading creates version 2, origin file, with source forcing', () => {
  withTempDir((dir) => {
    const store = createPricingStore(storePaths(dir));
    store.getSnapshot();
    const raw = readPricingFile(dir);
    assert.ok(raw.entries.length >= 2, 'the starter table needs at least two entries for this test');
    const untouchedKey = { provider: raw.entries[1].provider, model: raw.entries[1].model };
    const changedKey = { provider: raw.entries[0].provider, model: raw.entries[0].model };
    raw.entries[0].inputPerMillion = 999;
    raw.entries.push(inputEntry());
    writePricingFile(dir, raw);

    const result = store.reload();
    assert.equal(result.pricingVersion, 2);
    assert.equal(result.parentVersion, 1);
    assert.equal(result.origin, 'file');

    const changed = result.entries.find((e) => e.provider === changedKey.provider && e.model === changedKey.model);
    assert.equal(changed.inputPerMillion, 999);
    assert.equal(changed.source, 'file', 'a modified entry is forced to source: file');
    const added = result.entries.find((e) => e.provider === 'acme');
    assert.equal(added.source, 'file', 'a brand-new entry is source: file');
    const untouched = result.entries.find((e) => e.provider === untouchedKey.provider && e.model === untouchedKey.model);
    assert.equal(untouched.source, 'starter', 'an untouched entry keeps its original source');
  });
});

test('an invalid pricing.json after a good version keeps that version active and reports file_invalid with issues', () => {
  withTempDir((dir) => {
    const store = createPricingStore(storePaths(dir));
    store.getSnapshot();
    fs.writeFileSync(storePaths(dir).pricingFile, '{ not valid json');
    const result = store.reload();
    assert.equal(result.status, 'file_invalid');
    assert.equal(result.pricingVersion, 1);
    assert.ok(result.entries.length > 0, 'the last good version stays active and resolvable');
    assert.ok(result.issues.length > 0);
  });
});

test('deleting pricing.json and reloading regenerates it from history without creating a new version', () => {
  withTempDir((dir) => {
    const store = createPricingStore(storePaths(dir));
    store.getSnapshot();
    fs.unlinkSync(storePaths(dir).pricingFile);
    const result = store.reload();
    assert.equal(result.pricingVersion, 1);
    assert.equal(store.listVersions().length, 1);
    assert.ok(fs.existsSync(storePaths(dir).pricingFile));
    assert.equal(result.fileInSync, true);
  });
});

test('a rename failure commits the version but leaves fileInSync false; a later reload heals the stale file with no new version', () => {
  withTempDir((dir) => {
    const store = createPricingStore(storePaths(dir));
    store.getSnapshot();
    const raw = readPricingFile(dir);
    raw.entries[0].inputPerMillion = 777;
    writePricingFile(dir, raw);

    const renameMock = mock.method(fs, 'renameSync', () => {
      throw new Error('simulated EBUSY');
    });
    let afterFailedRename;
    try {
      afterFailedRename = store.reload();
    } finally {
      renameMock.mock.restore();
    }
    assert.equal(afterFailedRename.pricingVersion, 2, 'the new version is authoritative even though the rename failed');
    assert.equal(afterFailedRename.fileInSync, false);
    assert.equal(readPricingFile(dir).basedOnVersion, 1, 'the file on disk still holds the previous version');

    const healed = store.reload();
    assert.equal(healed.pricingVersion, 2, 'healing a stale file never creates a new version');
    assert.equal(healed.fileInSync, true);
    assert.equal(store.listVersions().length, 2);
    assert.equal(readPricingFile(dir).basedOnVersion, 2);
  });
});

test('a temp-file write failure throws pricing_store_unwritable and leaves the active version unchanged', () => {
  withTempDir((dir) => {
    const store = createPricingStore(storePaths(dir));
    store.getSnapshot();
    const raw = readPricingFile(dir);
    raw.entries[0].inputPerMillion = 5555;
    writePricingFile(dir, raw);

    const writeMock = mock.method(fs, 'writeFileSync', () => {
      throw new Error('simulated ENOSPC');
    });
    try {
      assert.throws(() => store.reload(), PricingStoreUnwritableError);
    } finally {
      writeMock.mock.restore();
    }
    assert.equal(store.getSnapshot().pricingVersion, 1);
    const leftoverTempFiles = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftoverTempFiles, []);
  });
});

test('a history-append failure throws pricing_store_unwritable, removes the temp file and truncates any partial line', () => {
  withTempDir((dir) => {
    const store = createPricingStore(storePaths(dir));
    store.getSnapshot();
    const raw = readPricingFile(dir);
    raw.entries[0].inputPerMillion = 4321;
    writePricingFile(dir, raw);

    const historySizeBefore = fs.statSync(storePaths(dir).historyFile).size;
    const fsyncMock = mock.method(fs, 'fsyncSync', () => {
      throw new Error('simulated EIO');
    });
    try {
      assert.throws(() => store.reload(), PricingStoreUnwritableError);
    } finally {
      fsyncMock.mock.restore();
    }
    assert.equal(fs.statSync(storePaths(dir).historyFile).size, historySizeBefore, 'no partial line survives');
    assert.equal(store.getSnapshot().pricingVersion, 1);
    const leftoverTempFiles = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftoverTempFiles, []);
  });
});

test('a torn final history line (no trailing newline, invalid JSON) is dropped with a warning; earlier versions still load', () => {
  withTempDir((dir) => {
    const store1 = createPricingStore(storePaths(dir));
    store1.getSnapshot();
    const raw = readPricingFile(dir);
    raw.entries[0].inputPerMillion = 11;
    writePricingFile(dir, raw);
    store1.reload();

    // Simulates a crash mid-append of a third version: an incomplete line with no trailing newline.
    fs.appendFileSync(storePaths(dir).historyFile, '{"pricingVersion":3,"parentVersion":2,"createdAt":"2026-01-01T00:00:00.000Z","orig');

    const warn = mock.method(console, 'warn', () => {});
    try {
      const store2 = createPricingStore(storePaths(dir));
      const snapshot = store2.getSnapshot();
      assert.equal(snapshot.status, 'ok');
      assert.equal(snapshot.pricingVersion, 2);
      assert.equal(store2.listVersions().length, 2);
    } finally {
      warn.mock.restore();
    }
    assert.ok(fs.readFileSync(storePaths(dir).historyFile, 'utf8').endsWith('\n'), 'the torn line was truncated out of the file');
  });
});

test('a corrupted (non-final) history line sets history_invalid, with no active version', () => {
  withTempDir((dir) => {
    const store1 = createPricingStore(storePaths(dir));
    store1.getSnapshot();
    const raw = readPricingFile(dir);
    raw.entries[0].inputPerMillion = 22;
    writePricingFile(dir, raw);
    store1.reload();

    const lines = fs.readFileSync(storePaths(dir).historyFile, 'utf8').trimEnd().split('\n');
    const firstVersion = JSON.parse(lines[0]);
    firstVersion.contentHash = `sha256:${'0'.repeat(64)}`;
    lines[0] = JSON.stringify(firstVersion);
    fs.writeFileSync(storePaths(dir).historyFile, `${lines.join('\n')}\n`);

    const store2 = createPricingStore(storePaths(dir));
    const snapshot = store2.getSnapshot();
    assert.equal(snapshot.status, 'history_invalid');
    assert.equal(snapshot.pricingVersion, null);
    assert.deepEqual(snapshot.entries, []);
    assert.ok(snapshot.issues.length > 0);

    // The module never guesses: an explicit reload while history_invalid changes nothing.
    assert.equal(store2.reload().status, 'history_invalid');
  });
});

for (const storageMode of ['memory', 'sqlite']) {
  test(`pricing persists across a restart independent of AGENT_VIEWER_STORAGE (${storageMode})`, () => {
    withTempDir((dir) => {
      const previous = process.env.AGENT_VIEWER_STORAGE;
      process.env.AGENT_VIEWER_STORAGE = storageMode;
      try {
        const store1 = createPricingStore(storePaths(dir));
        const before = store1.getSnapshot();
        // A fresh store instance against the same files, as a process restart would create.
        const store2 = createPricingStore(storePaths(dir));
        const after = store2.getSnapshot();
        assert.equal(after.pricingVersion, before.pricingVersion);
        assert.deepEqual(after.entries, before.entries);
      } finally {
        if (previous === undefined) delete process.env.AGENT_VIEWER_STORAGE;
        else process.env.AGENT_VIEWER_STORAGE = previous;
      }
    });
  });
}

test('two reload calls back to back on one changed file only ever commit one new version (writes are serialized in-process)', async () => {
  // Not using withTempDir here: it only awaits a synchronous callback's return value, and this one is async.
  const dir = tempDir();
  try {
    const store = createPricingStore(storePaths(dir));
    store.getSnapshot();
    const raw = readPricingFile(dir);
    raw.entries[0].inputPerMillion = 33;
    writePricingFile(dir, raw);

    const [a, b] = await Promise.all([
      Promise.resolve().then(() => store.reload()),
      Promise.resolve().then(() => store.reload()),
    ]);
    assert.equal(a.pricingVersion, 2);
    assert.equal(b.pricingVersion, 2, 'the second call sees the already-committed version, never a duplicate 3');
    assert.equal(store.listVersions().length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getVersion returns the exact entries of an earlier version after a later change', () => {
  withTempDir((dir) => {
    const store = createPricingStore(storePaths(dir));
    store.getSnapshot();
    const v1Entries = store.getVersion(1).entries;
    const raw = readPricingFile(dir);
    raw.entries[0].inputPerMillion = 55;
    writePricingFile(dir, raw);
    store.reload();
    assert.deepEqual(store.getVersion(1).entries, v1Entries);
    assert.equal(store.getVersion(3), null);
  });
});

test('the readonly option is reported in the snapshot but never blocks reload', () => {
  withTempDir((dir) => {
    const store = createPricingStore({ ...storePaths(dir), readonly: true });
    const snapshot = store.getSnapshot();
    assert.equal(snapshot.readonly, true);
    const raw = readPricingFile(dir);
    raw.entries[0].inputPerMillion = 44;
    writePricingFile(dir, raw);
    const reloaded = store.reload();
    assert.equal(reloaded.pricingVersion, 2, 'reload stays available in readonly mode');
  });
});

test('an injected clock controls createdAt', () => {
  withTempDir((dir) => {
    const fixed = Date.parse('2026-05-01T00:00:00.000Z');
    const store = createPricingStore({ ...storePaths(dir), now: () => fixed });
    const snapshot = store.getSnapshot();
    assert.equal(snapshot.createdAt, new Date(fixed).toISOString());
  });
});

test('default pricing paths sit next to AGENT_VIEWER_SQLITE_PATH, matching the Docker data volume', () => {
  const env = { AGENT_VIEWER_SQLITE_PATH: '/app/data/agent-viewer.db' };
  assert.equal(resolvePricingFilePath(env), path.join('/app/data', 'pricing.json'));
  assert.equal(resolveHistoryFilePath(env), path.join('/app/data', 'pricing-history.jsonl'));
  assert.equal(isPricingReadonly(env), false);
  assert.equal(isPricingReadonly({ AGENT_VIEWER_PRICING_READONLY: '1' }), true);
});

test('explicit pricing env vars override the derived defaults', () => {
  const env = {
    AGENT_VIEWER_PRICING_FILE: '/custom/prices.json',
    AGENT_VIEWER_PRICING_HISTORY_FILE: '/custom/history.jsonl',
  };
  assert.equal(resolvePricingFilePath(env), '/custom/prices.json');
  assert.equal(resolveHistoryFilePath(env), '/custom/history.jsonl');
});
