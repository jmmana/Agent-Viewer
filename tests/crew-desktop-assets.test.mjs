import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeCrewPng, inspectCrewFrame, sha256 } from '../scripts/crew-clip-assets.mjs';
const catalog = JSON.parse(readFileSync(new URL('../assets/crew/clips/actions.v1.json', import.meta.url)));
test('CEO desktop originals retain actual dimensions, alpha, provenance and 64 distinct crops', () => {
  const images = new Map(), ids = new Set(), hashes = new Set();
  assert.equal(catalog.schemaVersion, 1); assert.equal(catalog.clips.length, 16);
  for (const clip of catalog.clips) {
    assert.ok(!ids.has(clip.id)); ids.add(clip.id);
    const bytes = readFileSync(new URL(`../${clip.file}`, import.meta.url));
    if (!images.has(clip.file)) images.set(clip.file, decodeCrewPng(bytes));
    const png = images.get(clip.file);
    assert.equal(sha256(bytes), clip.sha256); assert.equal(png.width, clip.width); assert.equal(png.height, clip.height);
    assert.equal(clip.status, 'prototype'); assert.equal(clip.variant, 'default'); assert.equal(clip.frames.length, 4);
    assert.equal(sha256(readFileSync(new URL(`../${clip.provenance.prompt}`, import.meta.url))), clip.provenance.promptSha256);
    for (const frame of clip.frames) {
      assert.ok(frame.x >= 0 && frame.y >= 0 && frame.x + frame.width <= png.width && frame.y + frame.height <= png.height);
      const inspected = inspectCrewFrame(png, frame);
      assert.ok(inspected.transparent > 100 && inspected.opaque > 100);
      assert.equal(inspected.rgbaSha256, frame.sha256); hashes.add(frame.sha256);
      assert.ok(frame.anchor.y <= frame.height && frame.referenceHeight > 0);
    }
  }
  assert.equal(images.size, 4); assert.equal(hashes.size, 64);
});
