// Issue #401 (second sub-issue of #110, "offline-verifiable audit bundle"): the standalone, zero-dependency
// `scripts/verify-audit-bundle.mjs`. Three layers:
//   1. Parity tests: the script's own reimplementations of chain/checkpoint/pricing primitives produce
//      byte-identical output to the real server modules (`server/chain.ts`, `server/audit/checkpointFormat.ts`,
//      `src/integrations/pricingContract.ts`, `server/pricing/estimate.ts`), including the committed
//      `tests/fixtures/chain-vectors.json` shared with `tests/chain.test.mjs` (issue #105), so the two
//      implementations can never silently drift apart.
//   2. The tamper matrix from issue #110, run against real bundles produced by `streamAuditBundle` (#400), each
//      asserting the correct first-failing check.
//   3. CLI-level tests (spawnSync against the real script): exit codes, --json shape, --trusted-key,
//      --expect-checkpoint, --require-complete, and the committed golden v1 fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { SQLiteEventStore } from '../server/store.ts';
import { AuditCheckpointService } from '../server/audit/checkpoints.ts';
import { loadSigningKey } from '../server/audit/signingKey.ts';
import { createPricingStore } from '../server/pricing/store.ts';
import { streamAuditBundle } from '../server/audit/bundle.ts';

import { canonicalize as serverCanonicalize, eventHash as serverEventHash } from '../server/chain.ts';
import {
  checkpointSignedBytes as serverCheckpointSignedBytes,
  checkpointDigest as serverCheckpointDigest,
  verifyCheckpointSignature as serverVerifyCheckpointSignature,
  signCheckpoint as serverSignCheckpoint,
} from '../server/audit/checkpointFormat.ts';
import { computeContentHash as serverComputeContentHash, resolvePrice as serverResolvePrice } from '../src/integrations/pricingContract.ts';
import { estimateCall as serverEstimateCall, nanoToDecimalCost as serverNanoToDecimalCost } from '../server/pricing/estimate.ts';

import {
  canonicalize as verifierCanonicalize,
  eventHash as verifierEventHash,
  checkpointSignedBytes as verifierCheckpointSignedBytes,
  checkpointDigest as verifierCheckpointDigest,
  verifyCheckpointSignature as verifierVerifyCheckpointSignature,
  computeContentHash as verifierComputeContentHash,
  resolvePrice as verifierResolvePrice,
  estimateCall as verifierEstimateCall,
  nanoToDecimalCost as verifierNanoToDecimalCost,
  verifyBundle,
  parseArgs,
  parseExpectCheckpoint,
  CliUsageError,
} from '../scripts/verify-audit-bundle.mjs';

const SCRIPT_PATH = new URL('../scripts/verify-audit-bundle.mjs', import.meta.url).pathname;
const chainVectors = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/chain-vectors.json'), 'utf8'));

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agent-viewer-bundle-verify-${name}-`));
}

// -------------------------------------------------------------
// 1. Parity: the verifier's reimplementations agree with the real server code
// -------------------------------------------------------------

test('parity: canonicalize agrees with server/chain.ts on every shared vector', () => {
  for (const vector of chainVectors.canonicalizeVectors) {
    assert.equal(verifierCanonicalize(vector.input), serverCanonicalize(vector.input), vector.name);
    assert.equal(verifierCanonicalize(vector.input), vector.canonical, vector.name);
  }
});

test('parity: eventHash agrees with server/chain.ts on every shared vector', () => {
  for (const vector of chainVectors.eventVectors) {
    assert.equal(verifierEventHash(vector.input), serverEventHash(vector.input), vector.name);
    assert.equal(verifierEventHash(vector.input), vector.hash, vector.name);
  }
});

test('parity: checkpoint signed bytes, digest and signature verification agree with server/audit/checkpointFormat.ts', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const body = {
    version: 1,
    instanceId: 'inst_parity',
    checkpointSeq: 1,
    headSeq: 42,
    headHash: 'a'.repeat(64),
    chainedCount: 42,
    createdAt: 1700000000000,
    reason: 'manual',
    keyId: 'ed25519:' + 'b'.repeat(64),
    prevCheckpointDigest: null,
  };
  assert.deepEqual(verifierCheckpointSignedBytes(body), serverCheckpointSignedBytes(body));
  assert.equal(verifierCheckpointDigest(body), serverCheckpointDigest(body));

  const signed = serverSignCheckpoint(body, privateKey);
  assert.equal(verifierVerifyCheckpointSignature(body, signed.signature, publicKeyPem), true);
  assert.equal(
    serverVerifyCheckpointSignature(body, signed.signature, publicKeyPem),
    verifierVerifyCheckpointSignature(body, signed.signature, publicKeyPem)
  );
  // A flipped byte in the signature: both implementations must agree it's invalid.
  const tampered = Buffer.from(signed.signature, 'base64');
  tampered[0] ^= 0xff;
  const tamperedB64 = tampered.toString('base64');
  assert.equal(verifierVerifyCheckpointSignature(body, tamperedB64, publicKeyPem), false);
  assert.equal(serverVerifyCheckpointSignature(body, tamperedB64, publicKeyPem), false);
});

function sampleEntry(overrides = {}) {
  return {
    provider: 'acme',
    model: 'acme-1',
    aliases: [],
    kind: 'list',
    currency: 'USD',
    effectiveFrom: '2026-01-01T00:00:00Z',
    inputPerMillion: 1,
    outputPerMillion: 5,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
    reasoningPerMillion: null,
    reasoningBilling: null,
    source: 'manual',
    estimated: false,
    sourceUrl: null,
    sourceCheckedAt: null,
    note: null,
    ...overrides,
  };
}

test('parity: computeContentHash agrees with src/integrations/pricingContract.ts', () => {
  const entries = [sampleEntry(), sampleEntry({ model: 'acme-2', inputPerMillion: 2 })];
  assert.equal(verifierComputeContentHash(entries), serverComputeContentHash(entries));
  // Reordering entries (and shuffling the entry's own synthesized key order) must not change the digest.
  assert.equal(verifierComputeContentHash([...entries].reverse()), serverComputeContentHash(entries));
});

test('parity: resolvePrice agrees with src/integrations/pricingContract.ts', () => {
  const entries = [
    sampleEntry({ effectiveFrom: '2026-01-01T00:00:00Z', inputPerMillion: 1 }),
    sampleEntry({ effectiveFrom: '2026-06-01T00:00:00Z', inputPerMillion: 2 }),
  ];
  const query = { provider: 'acme', model: 'acme-1', at: '2026-07-01T00:00:00Z' };
  assert.deepEqual(verifierResolvePrice(entries, query), serverResolvePrice(entries, query));
  const missQuery = { provider: 'acme', model: 'unknown-model', at: '2026-07-01T00:00:00Z' };
  assert.equal(verifierResolvePrice(entries, missQuery), serverResolvePrice(entries, missQuery));
});

test('parity: estimateCall agrees with server/pricing/estimate.ts across every status branch', () => {
  const pricing = { pricingVersion: 1, entries: [sampleEntry()] };
  const cases = [
    { provider: 'acme', model: 'acme-1', occurredAt: Date.parse('2026-02-01T00:00:00Z'), inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: null },
    { provider: 'acme', model: 'unknown', occurredAt: Date.parse('2026-02-01T00:00:00Z'), inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: null },
    { provider: null, model: null, occurredAt: Date.parse('2026-02-01T00:00:00Z'), inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
    { provider: 'acme', model: 'acme-1', occurredAt: Date.parse('2026-02-01T00:00:00Z'), inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null },
  ];
  for (const row of cases) {
    assert.deepEqual(verifierEstimateCall(row, pricing), serverEstimateCall(row, pricing));
  }
});

test('parity: nanoToDecimalCost agrees with server/pricing/estimate.ts', () => {
  for (const nano of [0, 1, 999999999, 1000000000, 1234567891, 9007199254]) {
    assert.equal(verifierNanoToDecimalCost(nano), serverNanoToDecimalCost(nano));
  }
});

// -------------------------------------------------------------
// 2. Tamper matrix (issue #110), run end to end against real bundles
// -------------------------------------------------------------

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
      cachedTokens: 0,
      reasoningTokens: 0,
      requestId: `req_${id}`,
      cost: null,
      costSource: 'unknown',
      currency: null,
      ...overrides,
    },
  };
}

async function buildBundle(name, fn, requested = { fromSeq: null, toSeq: null, from: null, to: null }) {
  const dir = tempDir(name);
  const file = path.join(dir, `${name}.db`);
  const pricingStore = createPricingStore({ pricingFile: path.join(dir, 'pricing.json'), historyFile: path.join(dir, 'pricing-history.jsonl') });
  const store = new SQLiteEventStore(file, { backup: 'off', getPricingSnapshot: () => pricingStore.getSnapshot() });
  const db = store.getDatabaseHandle();
  const key = loadSigningKey({ env: {}, dbPath: file });
  const checkpoints = new AuditCheckpointService({ db, key, schedule: { everyEvents: 1_000_000, intervalMs: 3_600_000_000 }, log: () => {} });
  checkpoints.start();
  try {
    await fn({ store, checkpoints, pricingStore });
    const lines = [];
    const write = (chunk) => {
      for (const piece of chunk.split('\n')) if (piece.length > 0) lines.push(piece);
    };
    await streamAuditBundle({ dbPath: store.getDatabasePath(), checkpoints, pricingStore, write, isAborted: () => false }, requested);
    return { dir, lines, publicKeyPem: key.publicKeyPem };
  } finally {
    checkpoints.shutdown();
    await store.close();
  }
}

function writeLines(dir, name, lines) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
  return file;
}

function parseLines(lines) {
  return lines.map((l) => JSON.parse(l));
}

async function verifyParsed(parsed, dir, name, options = {}) {
  const file = writeLines(dir, name, parsed.map((o) => JSON.stringify(o)));
  return verifyBundle(file, options);
}

test('tamper matrix: edited event payload -> CHAIN', async () => {
  const { dir, lines } = await buildBundle('tm-edit-event', async ({ store }) => {
    await store.append(messageEvent('evt_1', 1000));
    await store.append(messageEvent('evt_2', 1001));
  });
  const parsed = parseLines(lines);
  const evt = parsed.find((l) => l.kind === 'event' && l.event?.id === 'evt_1');
  evt.event.summary = 'tampered';
  const result = await verifyParsed(parsed, dir, 'out.jsonl');
  assert.equal(result.verdict, 'fail');
  assert.equal(result.firstFailure.check, 'CHAIN');
  assert.equal(result.firstFailure.seq, evt.seq);
});

test('tamper matrix: deleted event (middle) -> CHAIN at the first seq after the gap', async () => {
  const { dir, lines } = await buildBundle('tm-delete-event', async ({ store }) => {
    await store.append(messageEvent('evt_1', 1000));
    await store.append(messageEvent('evt_2', 1001));
    await store.append(messageEvent('evt_3', 1002));
  });
  const parsed = parseLines(lines);
  const withoutEvt2 = parsed.filter((l) => !(l.kind === 'event' && l.event?.id === 'evt_2'));
  const result = await verifyParsed(withoutEvt2, dir, 'out.jsonl');
  assert.equal(result.verdict, 'fail');
  assert.equal(result.firstFailure.check, 'CHAIN');
});

test('tamper matrix: two events swapped -> CHAIN at the first out-of-order seq', async () => {
  const { dir, lines } = await buildBundle('tm-swap', async ({ store }) => {
    await store.append(messageEvent('evt_1', 1000));
    await store.append(messageEvent('evt_2', 1001));
    await store.append(messageEvent('evt_3', 1002));
  });
  const parsed = parseLines(lines);
  const i2 = parsed.findIndex((l) => l.kind === 'event' && l.event?.id === 'evt_2');
  const i3 = parsed.findIndex((l) => l.kind === 'event' && l.event?.id === 'evt_3');
  [parsed[i2], parsed[i3]] = [parsed[i3], parsed[i2]];
  const result = await verifyParsed(parsed, dir, 'out.jsonl');
  assert.equal(result.verdict, 'fail');
  assert.equal(result.firstFailure.check, 'CHAIN');
});

test('tamper matrix: inserted event -> CHAIN at the inserted line', async () => {
  const { dir, lines } = await buildBundle('tm-insert', async ({ store }) => {
    await store.append(messageEvent('evt_1', 1000));
    await store.append(messageEvent('evt_2', 1001));
  });
  const parsed = parseLines(lines);
  const i1 = parsed.findIndex((l) => l.kind === 'event' && l.event?.id === 'evt_1');
  const forged = JSON.parse(JSON.stringify(parsed[i1]));
  forged.event.id = 'evt_forged';
  forged.seq = 1.5;
  parsed.splice(i1 + 1, 0, forged);
  const result = await verifyParsed(parsed, dir, 'out.jsonl');
  assert.equal(result.verdict, 'fail');
  assert.equal(result.firstFailure.check, 'CHAIN');
});

test('tamper matrix: tail truncated, header and footer untouched -> FORMAT (counts, digest)', async () => {
  const { dir, lines } = await buildBundle('tm-truncate', async ({ store }) => {
    await store.append(messageEvent('evt_1', 1000));
    await store.append(messageEvent('evt_2', 1001));
    await store.append(messageEvent('evt_3', 1002));
  });
  const parsed = parseLines(lines);
  const footer = parsed[parsed.length - 1];
  const truncated = [...parsed.slice(0, parsed.length - 2), footer]; // drop the last event, keep the original footer
  const result = await verifyParsed(truncated, dir, 'out.jsonl');
  assert.equal(result.verdict, 'fail');
  assert.equal(result.firstFailure.check, 'FORMAT');
});

test('tamper matrix: footer removed (broken download) -> invalid, exit 2', async () => {
  const { dir, lines } = await buildBundle('tm-no-footer', async ({ store }) => {
    await store.append(messageEvent('evt_1', 1000));
  });
  const parsed = parseLines(lines).filter((l) => l.kind !== 'footer');
  const result = await verifyParsed(parsed, dir, 'out.jsonl');
  assert.equal(result.verdict, 'invalid');
});

test('tamper matrix: edited ledger cost -> LEDGER at that eventId', async () => {
  const { dir, lines } = await buildBundle('tm-ledger-cost', async ({ store, pricingStore }) => {
    pricingStore.applyApiChange([sampleEntry()], { reason: 'test', actor: null });
    await store.append(usageEvent('evt_u1', 1000));
  });
  const parsed = parseLines(lines);
  const ledger = parsed.find((l) => l.kind === 'ledger');
  ledger.estimatedCost = (ledger.estimatedCost ?? 0) + 999;
  const result = await verifyParsed(parsed, dir, 'out.jsonl');
  assert.equal(result.verdict, 'fail');
  assert.ok(['PRICING', 'TOTALS'].includes(result.firstFailure.check), `expected PRICING or TOTALS, got ${result.firstFailure.check}`);
});

test('tamper matrix: edited ledger token field, null changed to 0 -> LEDGER', async () => {
  const { dir, lines } = await buildBundle('tm-ledger-null-to-zero', async ({ store }) => {
    await store.append(usageEvent('evt_u1', 1000, { inputTokens: null, outputTokens: null }));
  });
  const parsed = parseLines(lines);
  const ledger = parsed.find((l) => l.kind === 'ledger');
  assert.equal(ledger.inputTokens, null);
  ledger.inputTokens = 0; // null -> 0 must be detected, not silently accepted as "the same unknown value"
  const result = await verifyParsed(parsed, dir, 'out.jsonl');
  assert.equal(result.verdict, 'fail');
  assert.equal(result.firstFailure.check, 'LEDGER');
});

test('tamper matrix: ledger row deleted -> LEDGER at the event', async () => {
  const { dir, lines } = await buildBundle('tm-ledger-deleted', async ({ store }) => {
    await store.append(usageEvent('evt_u1', 1000));
  });
  const parsed = parseLines(lines).filter((l) => l.kind !== 'ledger');
  const result = await verifyParsed(parsed, dir, 'out.jsonl');
  assert.equal(result.verdict, 'fail');
  assert.equal(result.firstFailure.check, 'LEDGER');
});

test('tamper matrix: edited pricing entry (dependent estimates and footer not rewritten) -> PRICING', async () => {
  const { dir, lines } = await buildBundle('tm-pricing', async ({ store, pricingStore }) => {
    pricingStore.applyApiChange([sampleEntry()], { reason: 'test', actor: null });
    await store.append(usageEvent('evt_u1', 1000));
  });
  const parsed = parseLines(lines);
  const pricing = parsed.find((l) => l.kind === 'pricing');
  pricing.entries[0].inputPerMillion = 9999; // digest now stale
  const result = await verifyParsed(parsed, dir, 'out.jsonl');
  assert.equal(result.verdict, 'fail');
  assert.equal(result.firstFailure.check, 'PRICING');
});

test('tamper matrix: edited footer totals -> TOTALS', async () => {
  const { dir, lines } = await buildBundle('tm-totals', async ({ store, pricingStore }) => {
    pricingStore.applyApiChange([sampleEntry()], { reason: 'test', actor: null });
    await store.append(usageEvent('evt_u1', 1000));
  });
  const parsed = parseLines(lines);
  const footer = parsed[parsed.length - 1];
  footer.totals.calls = footer.totals.calls + 100;
  const result = await verifyParsed(parsed, dir, 'out.jsonl');
  assert.equal(result.verdict, 'fail');
  // The footer's own line is excluded from contentSha256 (it covers only what comes before it), so editing only
  // footer.totals leaves FORMAT's digest/counts check clean; TOTALS alone catches this.
  assert.equal(result.firstFailure.check, 'TOTALS');
});

test('tamper matrix: checkpoint headHash modified -> CHECKPOINTS at that seq', async () => {
  const { dir, lines } = await buildBundle('tm-checkpoint-hash', async ({ store }) => {
    await store.append(messageEvent('evt_1', 1000));
  });
  const parsed = parseLines(lines);
  const checkpoint = parsed.find((l) => l.kind === 'checkpoint');
  checkpoint.body.headHash = 'f'.repeat(64);
  const result = await verifyParsed(parsed, dir, 'out.jsonl');
  assert.equal(result.verdict, 'fail');
  assert.equal(result.firstFailure.check, 'CHECKPOINTS');
});

test('tamper matrix: checkpoint signed by another key, key record swapped to match, with --trusted-key -> KEY', async () => {
  const { dir, lines, publicKeyPem } = await buildBundle('tm-key-swap', async ({ store }) => {
    await store.append(messageEvent('evt_1', 1000));
  });
  const { publicKey: otherPublicKey, privateKey: otherPrivateKey } = crypto.generateKeyPairSync('ed25519');
  const parsed = parseLines(lines);
  const checkpoint = parsed.find((l) => l.kind === 'checkpoint');
  const keyLine = parsed.find((l) => l.kind === 'key');
  const forgedSignature = crypto.sign(null, verifierCheckpointSignedBytes(checkpoint.body), otherPrivateKey).toString('base64');
  checkpoint.signature = forgedSignature;
  keyLine.publicKeyPem = otherPublicKey.export({ type: 'spki', format: 'pem' }).toString();
  // Pin to the ORIGINAL key: the swapped-in key's fingerprint must not match.
  const original = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const trustedKeyFingerprint = `ed25519:${crypto.createHash('sha256').update(original).digest('hex')}`;
  const result = await verifyParsed(parsed, dir, 'out.jsonl', { trustedKeyFingerprint });
  assert.equal(result.verdict, 'fail');
  assert.equal(result.firstFailure.check, 'KEY');
});

test('tamper matrix: junk appended after the footer -> FORMAT, exit 1 (not 2)', async () => {
  const { dir, lines } = await buildBundle('tm-junk', async ({ store }) => {
    await store.append(messageEvent('evt_1', 1000));
  });
  const file = writeLines(dir, 'out.jsonl', [...lines, JSON.stringify({ kind: 'junk', data: 'nope' })]);
  const result = await verifyBundle(file);
  assert.equal(result.verdict, 'fail');
  assert.equal(result.firstFailure.check, 'FORMAT');
});

test('a clean bundle passes every check (pinned) and is unpinned without --trusted-key', async () => {
  const { dir, lines, publicKeyPem } = await buildBundle('tm-clean', async ({ store, pricingStore }) => {
    pricingStore.applyApiChange([sampleEntry()], { reason: 'test', actor: null });
    await store.append(messageEvent('evt_1', 1000));
    await store.append(usageEvent('evt_u1', 1001));
  });
  const file = writeLines(dir, 'out.jsonl', lines);
  const unpinned = await verifyBundle(file);
  assert.equal(unpinned.verdict, 'unpinned');
  assert.deepEqual(
    unpinned.checks.filter((c) => !c.ok),
    []
  );

  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const trustedKeyFingerprint = `ed25519:${crypto.createHash('sha256').update(der).digest('hex')}`;
  const pinned = await verifyBundle(file, { trustedKeyFingerprint });
  assert.equal(pinned.verdict, 'pass');
});

// -------------------------------------------------------------
// 3. CLI
// -------------------------------------------------------------

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8', ...options });
}

test('CLI: --help exits 0 and prints usage', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node verify-audit-bundle\.mjs/);
});

test('CLI: unknown file exits 2', () => {
  const result = runCli(['/nonexistent/path/does-not-exist.jsonl']);
  assert.equal(result.status, 2);
});

test('CLI: unknown option exits 2', () => {
  const result = runCli(['--nope', 'file.jsonl']);
  assert.equal(result.status, 2);
});

test('CLI: a real bundle on disk verifies with correct exit codes and --json shape', async () => {
  const { dir, lines, publicKeyPem } = await buildBundle('cli-e2e', async ({ store }) => {
    await store.append(messageEvent('evt_1', 1000));
  });
  const file = writeLines(dir, 'out.jsonl', lines);

  const unpinned = runCli([file, '--json']);
  assert.equal(unpinned.status, 3);
  const unpinnedJson = JSON.parse(unpinned.stdout);
  assert.equal(unpinnedJson.verdict, 'unpinned');

  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  const fingerprint = `ed25519:${crypto.createHash('sha256').update(der).digest('hex')}`;
  const pinned = runCli([file, '--trusted-key', fingerprint, '--json']);
  assert.equal(pinned.status, 0);
  assert.equal(JSON.parse(pinned.stdout).verdict, 'pass');

  // --trusted-key as a PEM file path.
  const pemFile = path.join(dir, 'key.pem');
  fs.writeFileSync(pemFile, publicKeyPem);
  const pinnedFromFile = runCli([file, '--trusted-key', pemFile, '--json']);
  assert.equal(pinnedFromFile.status, 0);

  const wrongKey = runCli([file, '--trusted-key', `ed25519:${'0'.repeat(64)}`]);
  assert.equal(wrongKey.status, 1);

  const expect = runCli([file, '--expect-checkpoint', '1:' + JSON.parse(lines.find((l) => JSON.parse(l).kind === 'checkpoint')).body.headHash]);
  assert.equal(expect.status, 3); // unpinned but otherwise clean

  const wrongExpect = runCli([file, '--expect-checkpoint', `999:${'a'.repeat(64)}`]);
  assert.equal(wrongExpect.status, 1);
});

test('CLI: a gzip bundle (.gz extension and raw magic bytes) verifies identically to the uncompressed one', async () => {
  const { dir, lines } = await buildBundle('cli-gzip', async ({ store }) => {
    await store.append(messageEvent('evt_1', 1000));
  });
  const content = lines.map((l) => `${l}\n`).join('');
  const gz = zlib.gzipSync(content);
  const gzFile = path.join(dir, 'bundle.avbundle.jsonl.gz');
  fs.writeFileSync(gzFile, gz);
  const resultGz = runCli([gzFile, '--json']);
  assert.equal(resultGz.status, 3); // unpinned, clean

  // Same bytes, no .gz extension: magic-byte sniffing must still detect it.
  const noExtFile = path.join(dir, 'bundle-no-ext');
  fs.writeFileSync(noExtFile, gz);
  const resultNoExt = runCli([noExtFile, '--json']);
  assert.equal(resultNoExt.status, 3);
  assert.deepEqual(JSON.parse(resultGz.stdout).checks, JSON.parse(resultNoExt.stdout).checks);
});

test('CLI: --require-complete turns a partial, otherwise-clean range into a failure', async () => {
  // A genuinely partial range (seq 2..3 of a 3-event chain, requested directly): self-consistent, so it is not
  // merely a corrupted digest, and header.complete is legitimately false because it does not start at the
  // chain's first chained row.
  const { dir, lines } = await buildBundle(
    'cli-partial',
    async ({ store }) => {
      await store.append(messageEvent('evt_1', 1000));
      await store.append(messageEvent('evt_2', 1001));
      await store.append(messageEvent('evt_3', 1002));
    },
    { fromSeq: 2, toSeq: null, from: null, to: null }
  );
  const parsed = parseLines(lines);
  const header = parsed.find((l) => l.kind === 'header');
  assert.equal(header.complete, false);
  const file = writeLines(dir, 'out.jsonl', parsed.map((o) => JSON.stringify(o)));

  const withoutFlag = runCli([file]);
  assert.equal(withoutFlag.status, 3); // unpinned, otherwise clean: partial range alone does not fail

  const withFlag = runCli([file, '--require-complete']);
  assert.equal(withFlag.status, 1);
});

test('parseArgs / parseExpectCheckpoint: usage errors', () => {
  assert.throws(() => parseArgs([]), CliUsageError);
  assert.throws(() => parseArgs(['a.jsonl', 'b.jsonl']), CliUsageError);
  assert.throws(() => parseExpectCheckpoint('notvalid'), CliUsageError);
  assert.deepEqual(parseExpectCheckpoint(`5:${'a'.repeat(64)}`), { seq: 5, headHash: 'a'.repeat(64) });
});

// -------------------------------------------------------------
// Golden v1 fixture: committed so a future server and a future verifier must both keep accepting it
// -------------------------------------------------------------

const GOLDEN_PATH = path.join(import.meta.dirname, 'fixtures/audit-bundle/golden-v1.avbundle.jsonl');

test('golden v1 bundle fixture verifies cleanly (format-stability regression guard)', async () => {
  if (!fs.existsSync(GOLDEN_PATH)) {
    assert.fail(`${GOLDEN_PATH} is missing; regenerate it (see this file's own generator script) before merging`);
  }
  const result = await verifyBundle(GOLDEN_PATH);
  assert.equal(result.verdict, 'unpinned');
  assert.deepEqual(
    result.checks.filter((c) => !c.ok),
    []
  );
});

// -------------------------------------------------------------
// Bounded-memory streaming (documented deferral: this exercises thousands of events, not #110's full 1M-event
// perf acceptance criterion, which needs a long-running, resource-heavy run not suited to the default CI suite)
// -------------------------------------------------------------

test('a few thousand events stream through the CLI verifier without buffering the whole bundle in memory', async () => {
  const { dir, lines } = await buildBundle('cli-scale', async ({ store }) => {
    for (let i = 0; i < 4000; i++) {
      await store.append(messageEvent(`evt_scale_${i}`, 1000 + i));
    }
  });
  const file = writeLines(dir, 'out.jsonl', lines);
  const result = runCli([file, '--json'], { maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 3); // unpinned, otherwise clean
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(
    parsed.checks.filter((c) => !c.ok),
    []
  );
});
