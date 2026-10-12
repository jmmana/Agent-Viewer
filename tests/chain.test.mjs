import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalize, sha256Hex, eventHash, checkpointHash, EMPTY_DIGEST, UnchainedDigest } from '../server/chain.ts';
import { specCanonicalize, specSha256Hex, specEventHash, specCheckpointHash } from './helpers/chainSpec.mjs';

const vectors = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/chain-vectors.json'), 'utf8'));

test('canonicalize: golden vectors (key order, numbers, unicode, nesting)', () => {
  for (const vector of vectors.canonicalizeVectors) {
    assert.equal(canonicalize(vector.input), vector.canonical, `canonical mismatch for ${vector.name}`);
    assert.equal(sha256Hex(vector.canonical), vector.sha256, `sha256 mismatch for ${vector.name}`);
    // Independently recomputed from the spec, not from the module under test.
    assert.equal(specCanonicalize(vector.input), vector.canonical, `independent canonical mismatch for ${vector.name}`);
    assert.equal(specSha256Hex(vector.canonical), vector.sha256, `independent sha256 mismatch for ${vector.name}`);
  }
});

test('eventHash: golden vectors, cross-checked against an independent recompute', () => {
  for (const vector of vectors.eventVectors) {
    assert.equal(eventHash(vector.input), vector.hash, `hash mismatch for ${vector.name}`);
    assert.equal(specEventHash(vector.input), vector.hash, `independent hash mismatch for ${vector.name}`);
  }
});

test('checkpointHash: golden vectors, cross-checked against an independent recompute', () => {
  for (const vector of vectors.checkpointVectors) {
    assert.equal(checkpointHash(vector.input), vector.hash, `hash mismatch for ${vector.name}`);
    assert.equal(specCheckpointHash(vector.input), vector.hash, `independent hash mismatch for ${vector.name}`);
  }
});

test('canonicalize: object keys sorted by UTF-16 code unit at every level', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalize({ outer: { z: 1, a: 2 } }), '{"outer":{"a":2,"z":1}}');
});

test('canonicalize: arrays keep order, objects inside arrays still get sorted keys', () => {
  assert.equal(canonicalize([{ b: 1, a: 2 }, 3, 1]), '[{"a":2,"b":1},3,1]');
});

test('canonicalize: -0 renders as 0, matching JCS', () => {
  assert.equal(canonicalize(-0), '0');
  assert.equal(canonicalize({ x: -0 }), '{"x":0}');
});

test('canonicalize: a present key with an undefined value is dropped, matching JSON.stringify', () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalize({ a: undefined }), '{}');
});

test('canonicalize: an undefined array element is written as null, matching JSON.stringify', () => {
  assert.equal(canonicalize([1, undefined, 3]), '[1,null,3]');
});

test('canonicalize: rejects a bare top-level undefined', () => {
  assert.throws(() => canonicalize(undefined), TypeError);
});

test('canonicalize: rejects NaN and Infinity', () => {
  assert.throws(() => canonicalize(Number.NaN), TypeError);
  assert.throws(() => canonicalize(Number.POSITIVE_INFINITY), TypeError);
  assert.throws(() => canonicalize(Number.NEGATIVE_INFINITY), TypeError);
  assert.throws(() => canonicalize({ x: Number.NaN }), TypeError);
});

test('canonicalize: rejects functions, symbols and BigInt', () => {
  assert.throws(() => canonicalize(() => {}), TypeError);
  assert.throws(() => canonicalize(Symbol('x')), TypeError);
  assert.throws(() => canonicalize(10n), TypeError);
});

test('canonicalize: rejects a lone UTF-16 surrogate, accepts a valid surrogate pair', () => {
  assert.throws(() => canonicalize('\ud800'), TypeError);
  assert.throws(() => canonicalize({ '\ud800': 'x' }), TypeError);
  assert.doesNotThrow(() => canonicalize('😀')); // a real emoji, a valid pair
});

test('canonicalize: rejects a circular structure', () => {
  const obj = {};
  obj.self = obj;
  assert.throws(() => canonicalize(obj), TypeError);
});

test('sha256Hex: matches an independent SHA-256 implementation', () => {
  assert.equal(sha256Hex(''), EMPTY_DIGEST);
  assert.equal(sha256Hex('x'), specSha256Hex('x'));
});

test('UnchainedDigest: empty input yields EMPTY_DIGEST, order matters, matches independent recompute', () => {
  const empty = new UnchainedDigest();
  assert.equal(empty.digest(), EMPTY_DIGEST);

  const forward = new UnchainedDigest();
  forward.update('evt_a', { id: 'evt_a' });
  forward.update('evt_b', { id: 'evt_b' });
  const forwardDigest = forward.digest();

  const backward = new UnchainedDigest();
  backward.update('evt_b', { id: 'evt_b' });
  backward.update('evt_a', { id: 'evt_a' });
  assert.notEqual(forwardDigest, backward.digest());

  const independent = specSha256Hex(
    `evt_a\n${specSha256Hex(specCanonicalize({ id: 'evt_a' }))}\n` +
      `evt_b\n${specSha256Hex(specCanonicalize({ id: 'evt_b' }))}\n`
  );
  assert.equal(forwardDigest, independent);
});

test('eventHash: changing any hashed input changes the hash', () => {
  const base = { seq: 1, prevHash: 'a'.repeat(64), receivedAt: 1000, submitterId: 'shared-token', event: { id: 'evt_1' } };
  const baseHash = eventHash(base);
  assert.notEqual(eventHash({ ...base, seq: 2 }), baseHash);
  assert.notEqual(eventHash({ ...base, prevHash: 'b'.repeat(64) }), baseHash);
  assert.notEqual(eventHash({ ...base, receivedAt: 1001 }), baseHash);
  assert.notEqual(eventHash({ ...base, submitterId: 'anonymous' }), baseHash);
  assert.notEqual(eventHash({ ...base, event: { id: 'evt_2' } }), baseHash);
});
