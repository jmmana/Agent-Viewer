// Issue #400 (first sub-issue of #110, "offline-verifiable audit bundle"): the NDJSON bundle format and
// `GET /api/v1/audit/bundle`. The standalone verifier (#401) and the `agent-viewer audit` CLI (#402) are separate,
// not-yet-shipped sub-issues; this file tests the format and the export endpoint only, by parsing the raw NDJSON
// lines directly rather than reimplementing a verifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { SQLiteEventStore } from '../server/store.ts';
import { eventHash } from '../server/chain.ts';
import { AuditCheckpointService } from '../server/audit/checkpoints.ts';
import { loadSigningKey } from '../server/audit/signingKey.ts';
import { createPricingStore } from '../server/pricing/store.ts';
import { streamAuditBundle, parseAuditBundleQuery, AuditBundleRangeError, AuditBundleUnsupportedError } from '../server/audit/bundle.ts';

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-viewer-audit-bundle-${name}-`));
}

function messageEvent(id, timestamp, overrides = {}) {
  return {
    schemaVersion: '1.0',
    id,
    type: 'agent.message.sent',
    timestamp,
    source: 'agent:writer',
    agentId: 'writer',
    severity: 'normal',
    summary: `Message ${id}`,
    payload: { text: `Text ${id}` },
    ...overrides,
  };
}

function usageEvent(id, timestamp, overrides = {}) {
  return {
    schemaVersion: '1.0',
    id,
    type: 'llm.usage',
    timestamp,
    source: 'agent:writer',
    agentId: 'writer',
    severity: 'normal',
    summary: `Usage ${id}`,
    payload: {
      provider: 'acme',
      model: 'acme-1',
      inputTokens: 100,
      outputTokens: 50,
      requestId: `req_${id}`,
      ...overrides,
    },
  };
}

async function withEnv(name, options, fn) {
  const dir = tempDir(name);
  const file = path.join(dir, `${name}.db`);
  const pricingStore = createPricingStore({
    pricingFile: path.join(dir, 'pricing.json'),
    historyFile: path.join(dir, 'pricing-history.jsonl'),
  });
  const store = new SQLiteEventStore(file, { backup: 'off', getPricingSnapshot: () => pricingStore.getSnapshot() });
  const db = store.getDatabaseHandle();
  const key = loadSigningKey({ env: {}, dbPath: file });
  const checkpoints = options.noCheckpoints
    ? null
    : new AuditCheckpointService({
        db,
        key,
        schedule: { everyEvents: options.everyEvents ?? 1_000_000, intervalMs: 3_600_000_000 },
        log: () => {},
      });
  checkpoints?.start();
  const lines = [];
  const write = (chunk) => {
    for (const piece of chunk.split('\n')) {
      if (piece.length > 0) lines.push(JSON.parse(piece));
    }
  };
  try {
    await fn({ dir, file, store, db, checkpoints, pricingStore, lines, write });
  } finally {
    checkpoints?.shutdown();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function byKind(lines, kind) {
  return lines.filter((l) => l.kind === kind);
}

test('parseAuditBundleQuery: valid combinations and rejections', () => {
  assert.deepEqual(parseAuditBundleQuery({}), { fromSeq: null, toSeq: null, from: null, to: null });
  assert.deepEqual(parseAuditBundleQuery({ fromSeq: '1', toSeq: '5' }), { fromSeq: 1, toSeq: 5, from: null, to: null });
  assert.deepEqual(parseAuditBundleQuery({ from: '1000', to: '2000' }), { fromSeq: null, toSeq: null, from: 1000, to: 2000 });
  assert.throws(() => parseAuditBundleQuery({ fromSeq: '5', toSeq: '1' }), AuditBundleRangeError);
  assert.throws(() => parseAuditBundleQuery({ fromSeq: '1', from: '100' }), AuditBundleRangeError);
  assert.throws(() => parseAuditBundleQuery({ fromSeq: '0' }), AuditBundleRangeError);
  assert.throws(() => parseAuditBundleQuery({ fromSeq: 'abc' }), AuditBundleRangeError);
  assert.throws(() => parseAuditBundleQuery({ from: '-1' }), AuditBundleRangeError);
});

test('streamAuditBundle: section order, event+ledger pairing, footer null-handling and content digest', async () => {
  await withEnv('shape', {}, async ({ store, checkpoints, pricingStore, lines, write }) => {
    await store.append(messageEvent('evt_1', 1000));
    await store.append(usageEvent('evt_2', 1001));
    await store.append(usageEvent('evt_3', 1002, { inputTokens: null, outputTokens: null, requestId: 'req_evt_3' }));

    const result = await streamAuditBundle(
      { dbPath: store.getDatabasePath(), checkpoints, pricingStore, write, isAborted: () => false },
      { fromSeq: null, toSeq: null, from: null, to: null }
    );
    assert.equal(result.aborted, false);
    assert.equal(result.events, 3);
    assert.equal(result.ledgerRows, 2);

    const kinds = lines.map((l) => l.kind);
    // header, then (key*, pricing*, checkpoint*, tombstone*) in that relative order, then event/ledger pairs, then footer.
    assert.equal(kinds[0], 'header');
    assert.equal(kinds[kinds.length - 1], 'footer');
    const bodyKinds = kinds.slice(1, -1);
    let seenPricing = false;
    let seenCheckpoint = false;
    for (const kind of bodyKinds) {
      if (kind === 'key') assert.ok(!seenPricing && !seenCheckpoint, 'key lines come before pricing/checkpoint');
      if (kind === 'pricing') seenPricing = true;
      if (kind === 'checkpoint') {
        assert.ok(seenPricing, 'checkpoint lines come after pricing lines');
        seenCheckpoint = true;
      }
      if (kind === 'event' || kind === 'ledger') assert.ok(seenCheckpoint || bodyKinds.every((k) => k !== 'checkpoint'), 'event/ledger lines come after checkpoints');
    }

    const header = lines[0];
    assert.equal(header.format, 'agent-viewer-audit-bundle');
    assert.equal(header.formatVersion, 1);
    assert.equal(header.range.fromSeq, 1);
    assert.equal(header.range.toSeq, 3);
    assert.equal(header.complete, true);

    // evt_2's ledger row immediately follows its event line.
    const idx2 = lines.findIndex((l) => l.kind === 'event' && l.event?.id === 'evt_2');
    assert.equal(lines[idx2 + 1].kind, 'ledger');
    assert.equal(lines[idx2 + 1].eventId, 'evt_2');

    // evt_3 has null tokens: never substituted with 0, and the footer's sum must still reflect evt_2's real value.
    const ledger3 = lines.find((l) => l.kind === 'ledger' && l.eventId === 'evt_3');
    assert.equal(ledger3.inputTokens, null);
    assert.equal(ledger3.outputTokens, null);

    const footer = lines[lines.length - 1];
    assert.equal(footer.kind, 'footer');
    assert.equal(footer.counts.events, 3);
    assert.equal(footer.counts.ledger, 2);
    assert.equal(footer.totals.calls, 2);
    assert.equal(footer.totals.tokens.inputTokens.sum, 100); // only evt_2 reported a value
    assert.equal(footer.totals.tokens.inputTokens.knownCalls, 1);
    assert.equal(footer.totals.tokens.inputTokens.unknownCalls, 1);
    assert.match(footer.contentSha256, /^[0-9a-f]{64}$/);

    // The digest is exactly the SHA-256 of every line up to (and including the newline after) the line before the footer.
    const crypto = await import('node:crypto');
    const expected = crypto.createHash('sha256');
    for (const line of lines.slice(0, -1)) {
      expected.update(JSON.stringify(line), 'utf8');
      expected.update('\n', 'utf8');
    }
    assert.equal(footer.contentSha256, expected.digest('hex'));
  });
});

test('streamAuditBundle: event hash lines recompute correctly with eventHash', async () => {
  await withEnv('hash', {}, async ({ store, checkpoints, pricingStore, lines, write }) => {
    await store.append(messageEvent('evt_a', 1000));
    await store.append(messageEvent('evt_b', 1001));
    await streamAuditBundle(
      { dbPath: store.getDatabasePath(), checkpoints, pricingStore, write, isAborted: () => false },
      { fromSeq: null, toSeq: null, from: null, to: null }
    );
    const events = byKind(lines, 'event');
    assert.equal(events.length, 2);
    for (const line of events) {
      const recomputed = eventHash({
        seq: line.seq,
        prevHash: line.prevHash ?? '',
        receivedAt: line.receivedAt,
        submitterId: line.submitterId ?? '',
        event: line.event,
      });
      assert.equal(recomputed, line.hash);
    }
    assert.equal(events[0].prevHash, lines[0].range?.prevHash ?? events[0].prevHash);
    assert.equal(events[1].prevHash, events[0].hash);
  });
});

test('streamAuditBundle: empty range is valid, zero events, headHash equals prevHash', async () => {
  await withEnv('empty', {}, async ({ store, checkpoints, pricingStore, lines, write }) => {
    await store.append(messageEvent('evt_1', 1000));
    // A range starting after the current head resolves empty (toSeq defaults to the head, 1, which is < fromSeq).
    const result = await streamAuditBundle(
      { dbPath: store.getDatabasePath(), checkpoints, pricingStore, write, isAborted: () => false },
      { fromSeq: 10, toSeq: null, from: null, to: null }
    );
    assert.equal(result.events, 0);
    const header = lines[0];
    assert.equal(header.range.toSeq, header.range.fromSeq - 1);
    assert.equal(header.range.headHash, header.range.prevHash);
    assert.equal(byKind(lines, 'checkpoint').length, 0);
  });
});

test('streamAuditBundle: tail anchoring forces a fresh checkpoint at toSeq when the latest one is stale', async () => {
  await withEnv('anchor', { everyEvents: 1_000_000 }, async ({ store, checkpoints, pricingStore, lines, write }) => {
    await store.append(messageEvent('evt_1', 1000));
    await store.append(messageEvent('evt_2', 1001));
    assert.equal(checkpoints.latest(), null); // nothing signed yet, periodic cadence is effectively off
    await streamAuditBundle(
      { dbPath: store.getDatabasePath(), checkpoints, pricingStore, write, isAborted: () => false },
      { fromSeq: null, toSeq: null, from: null, to: null }
    );
    const checkpointLines = byKind(lines, 'checkpoint');
    assert.equal(checkpointLines.length, 1);
    assert.equal(checkpointLines[0].body.headSeq, 2);

    // A later export of a strictly smaller historical range reuses the checkpoint that already covers it, without
    // needing a second one signed at the smaller toSeq.
    await store.append(messageEvent('evt_3', 1002));
    const lines2 = [];
    const write2 = (chunk) => {
      for (const piece of chunk.split('\n')) if (piece.length > 0) lines2.push(JSON.parse(piece));
    };
    await streamAuditBundle(
      { dbPath: store.getDatabasePath(), checkpoints, pricingStore, write: write2, isAborted: () => false },
      { fromSeq: 1, toSeq: 2, from: null, to: null }
    );
    const checkpointLines2 = byKind(lines2, 'checkpoint');
    assert.equal(checkpointLines2.length, 1);
    assert.equal(checkpointLines2[0].body.headSeq, 2);
  });
});

test('streamAuditBundle: without a configured checkpoint service, no checkpoint line is forced or required', async () => {
  await withEnv('nocheckpoint', { noCheckpoints: true }, async ({ store, pricingStore, lines, write }) => {
    await store.append(messageEvent('evt_1', 1000));
    const result = await streamAuditBundle(
      { dbPath: store.getDatabasePath(), checkpoints: null, pricingStore, write, isAborted: () => false },
      { fromSeq: null, toSeq: null, from: null, to: null }
    );
    assert.equal(result.events, 1);
    assert.equal(byKind(lines, 'checkpoint').length, 0);
    assert.equal(lines[lines.length - 1].kind, 'footer');
  });
});

test('streamAuditBundle: memory storage (no chain tables) throws AuditBundleUnsupportedError', async () => {
  const dir = tempDir('nochain');
  const file = path.join(dir, 'plain.db');
  try {
    // A bare node:sqlite database with no migrations at all has no chain_checkpoints table.
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE placeholder (id INTEGER)');
    raw.close();
    await assert.rejects(
      () =>
        streamAuditBundle(
          { dbPath: file, checkpoints: null, pricingStore: createPricingStore({ pricingFile: path.join(dir, 'p.json'), historyFile: path.join(dir, 'p.jsonl') }), write: () => {}, isAborted: () => false },
          { fromSeq: null, toSeq: null, from: null, to: null }
        ),
      AuditBundleUnsupportedError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('streamAuditBundle: aborting mid-export stops early and reports aborted', async () => {
  await withEnv('abort', {}, async ({ store, checkpoints, pricingStore, lines, write }) => {
    for (let i = 1; i <= 5; i++) await store.append(messageEvent(`evt_${i}`, 1000 + i));
    let seen = 0;
    const result = await streamAuditBundle(
      {
        dbPath: store.getDatabasePath(),
        checkpoints,
        pricingStore,
        write: (chunk) => {
          seen++;
          write(chunk);
        },
        isAborted: () => seen > 3,
        pageSize: 1,
      },
      { fromSeq: null, toSeq: null, from: null, to: null }
    );
    assert.equal(result.aborted, true);
    assert.ok(byKind(lines, 'footer').length === 0, 'an aborted export never writes a footer');
  });
});

test('streamAuditBundle: a pricing version referenced by a ledger row in range gets its own pricing line', async () => {
  await withEnv('pricing', {}, async ({ store, checkpoints, pricingStore, lines, write }) => {
    const applied = pricingStore.applyApiChange(
      [
        {
          provider: 'acme',
          model: 'acme-1',
          kind: 'list',
          currency: 'USD',
          effectiveFrom: '2026-01-01T00:00:00Z',
          inputPerMillion: 1,
          outputPerMillion: 5,
        },
      ],
      { reason: 'test', actor: null }
    );
    assert.equal(applied.changed, true);
    await store.append(usageEvent('evt_priced', 1000));
    await streamAuditBundle(
      { dbPath: store.getDatabasePath(), checkpoints, pricingStore, write, isAborted: () => false },
      { fromSeq: null, toSeq: null, from: null, to: null }
    );
    const ledgerRow = byKind(lines, 'ledger')[0];
    assert.ok(ledgerRow.pricingVersion !== null, 'the ledger row estimated against a real pricing version');
    const pricingLines = byKind(lines, 'pricing');
    assert.equal(pricingLines.length, 1);
    assert.equal(pricingLines[0].pricingVersion, ledgerRow.pricingVersion);
    assert.equal(pricingLines[0].digest, pricingStore.getVersion(ledgerRow.pricingVersion).contentHash);
  });
});

// -------------------------------------------------------------
// HTTP route
// -------------------------------------------------------------

test('GET /api/v1/audit/bundle (memory storage): 409 audit_requires_chain', async () => {
  const { app } = await import('../server/index.ts');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${baseUrl}/api/v1/audit/bundle`);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'audit_requires_chain');
  } finally {
    server.close();
  }
});

test('GET /api/v1/audit/bundle (SQLite): auth/scope, invalid range, gzip, concurrency cap', () => {
  const dir = tempDir('http');
  try {
    const serverUrl = new URL('../server/index.ts', import.meta.url).href;
    const script = `
      const http = await import('node:http');
      const zlib = await import('node:zlib');
      const { app, shutdown } = await import(${JSON.stringify(serverUrl)});
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = 'http://127.0.0.1:' + server.address().port;
      const admin = { Authorization: 'Bearer bundle-secret', 'Content-Type': 'application/json' };
      const out = {};

      out.noAuth = (await fetch(baseUrl + '/api/v1/audit/bundle')).status;

      const mkKey = async (scopes) => {
        const res = await fetch(baseUrl + '/api/v1/keys', { method: 'POST', headers: admin, body: JSON.stringify({ name: 'k-' + scopes.join('-') + '-' + Math.random(), scopes }) });
        return (await res.json()).token;
      };
      const ingestToken = await mkKey(['ingest']);
      const auditToken = await mkKey(['audit']);

      out.ingestOnly = (await fetch(baseUrl + '/api/v1/audit/bundle', { headers: { Authorization: 'Bearer ' + ingestToken } })).status;

      // Enough rows (> one bundle page of 1000) that streamAuditBundle yields via setImmediate between pages,
      // so two concurrent exports genuinely overlap in time instead of completing fully synchronously one after
      // another (which would make the concurrency cap below untestable from a single process).
      for (let batch = 0; batch < 11; batch++) {
        const events = Array.from({ length: 200 }, (_, i) => {
          const n = batch * 200 + i;
          return { schemaVersion: '1.0', id: 'evt_bh_' + n, type: 'agent.message.sent', timestamp: Date.now(), source: 'agent:w', agentId: 'w', summary: 'hi', payload: { text: 'hi' } };
        });
        await fetch(baseUrl + '/api/v1/events/batch', { method: 'POST', headers: admin, body: JSON.stringify(events) });
      }

      const okAudit = await fetch(baseUrl + '/api/v1/audit/bundle', { headers: { Authorization: 'Bearer ' + auditToken } });
      out.auditOk = { status: okAudit.status, contentType: okAudit.headers.get('content-type') };
      const text = await okAudit.text();
      out.lineCount = text.trim().split('\\n').length;

      out.badRange = (await fetch(baseUrl + '/api/v1/audit/bundle?fromSeq=5&toSeq=1', { headers: admin })).status;
      out.mixedParams = (await fetch(baseUrl + '/api/v1/audit/bundle?fromSeq=1&from=100', { headers: admin })).status;

      const gz = await fetch(baseUrl + '/api/v1/audit/bundle?gzip=1', { headers: admin });
      out.gzipContentType = gz.headers.get('content-type');
      const buf = Buffer.from(await gz.arrayBuffer());
      const inflated = zlib.gunzipSync(buf).toString('utf8');
      out.gzipFirstKind = JSON.parse(inflated.trim().split('\\n')[0]).kind;

      const slow = fetch(baseUrl + '/api/v1/audit/bundle', { headers: admin });
      const slow2 = fetch(baseUrl + '/api/v1/audit/bundle', { headers: admin });
      const slow3 = fetch(baseUrl + '/api/v1/audit/bundle', { headers: admin });
      const results = await Promise.all([slow, slow2, slow3]);
      out.concurrentStatuses = results.map((r) => r.status).sort();
      for (const r of results) await r.text();

      server.close();
      await shutdown();
      console.log(JSON.stringify(out));
      process.exit(0);
    `;
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      AGENT_VIEWER_STORAGE: 'sqlite',
      AGENT_VIEWER_SQLITE_PATH: path.join(dir, 'http.db'),
      AGENT_VIEWER_API_TOKEN: 'bundle-secret',
      AGENT_VIEWER_AUDIT_MAX_CONCURRENT: '1',
      AGENT_VIEWER_MAX_BATCH_SIZE: '500',
    };
    delete env.AGENT_VIEWER_API_KEY;
    delete env.AGENT_VIEWER_AUDIT_SIGNING_KEY;
    delete env.AGENT_VIEWER_AUDIT_KEY_FILE;
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout.trim().split('\n').pop());

    assert.equal(out.noAuth, 401);
    assert.equal(out.ingestOnly, 403);
    assert.equal(out.auditOk.status, 200);
    assert.equal(out.auditOk.contentType, 'application/x-ndjson; charset=utf-8');
    assert.ok(out.lineCount >= 2); // at least header + footer
    assert.equal(out.badRange, 400);
    assert.equal(out.mixedParams, 400);
    assert.equal(out.gzipContentType, 'application/gzip');
    assert.equal(out.gzipFirstKind, 'header');
    // AGENT_VIEWER_AUDIT_MAX_CONCURRENT=1: at most one of the 3 overlapping exports succeeds, the rest get 503.
    const okCount = out.concurrentStatuses.filter((s) => s === 200).length;
    const busyCount = out.concurrentStatuses.filter((s) => s === 503).length;
    assert.equal(okCount + busyCount, 3);
    assert.ok(okCount >= 1, 'expected at least one of the 3 concurrent requests to succeed');
    assert.ok(busyCount >= 1, `expected at least one of the 3 concurrent requests to be rejected as busy, got statuses ${out.concurrentStatuses}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
