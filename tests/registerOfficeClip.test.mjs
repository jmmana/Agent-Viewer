import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRegistrationArgs, collectClipFrames, registerClip } from '../scripts/register-office-clip.mjs';

function fixture(t, count = 6, { identical = false, rgba = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'office-clip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'assets', 'animations', 'ceo', 'walk-front');
  mkdirSync(dir, { recursive: true });
  const manifestPath = join(root, 'assets', 'asset-manifest.json');
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: '1.0.0', assets: [] }));
  for (let i = 0; i < count; i++) {
    const buffer = Buffer.alloc(128);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
    buffer.writeUInt32BE(256, 16);
    buffer.writeUInt32BE(352, 20);
    buffer[25] = rgba ? 6 : 2;
    buffer[64] = identical ? 42 : 42 + i;
    writeFileSync(join(dir, `${String(i).padStart(2, '0')}.png`), buffer);
  }
  return { root, manifestPath };
}

test('a walk cycle registers all ordered raster frames without claiming approval', t => {
  const { root, manifestPath } = fixture(t);
  const opts = parseRegistrationArgs(['ceo', 'walk', 'front', '10']);
  const result = registerClip(root, opts);
  assert.equal(result.id, 'character.ceo.walk.front');
  assert.equal(result.frames, 6);
  assert.equal(result.files[0], 'assets/animations/ceo/walk-front/00.png');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].status, 'prototype');
  assert.equal(manifest.assets[0].loop, true);
  assert.equal(manifest.assets[0].frameFiles.length, 6);
  assert.throws(() => registerClip(root, opts), /already exists/);
  assert.equal(registerClip(root, { ...opts, replace: true }).frames, 6);
});

test('rejects non-animated, missing and opaque/inconsistent sequences', t => {
  const still = fixture(t, 6, { identical: true });
  const opts = parseRegistrationArgs(['ceo', 'walk', 'front', '10']);
  assert.throws(() => collectClipFrames(still.root, opts), /identical/);
});

test('rejects a walk with too few frames', t => {
  const { root } = fixture(t, 5);
  assert.throws(() => collectClipFrames(root, parseRegistrationArgs(['ceo', 'walk', 'front', '10'])), /at least 6/);
});

test('rejects a non-RGBA frame', t => {
  const { root } = fixture(t, 6, { rgba: false });
  assert.throws(() => collectClipFrames(root, parseRegistrationArgs(['ceo', 'walk', 'front', '10'])), /RGBA PNG/);
});

test('validates role, facing, fps and refuses unrecognized options', () => {
  assert.throws(() => parseRegistrationArgs(['wrong', 'walk', 'front', '10']), /role/);
  assert.throws(() => parseRegistrationArgs(['ceo', 'walk', 'diagonal', '10']), /facing/);
  assert.throws(() => parseRegistrationArgs(['ceo', 'walk', 'front', '0']), /FPS/);
  assert.throws(() => parseRegistrationArgs(['ceo', 'walk', 'front', '10', '--unsafe']), /Unknown flag/);
});
