import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeCrewPng, inspectCrewFrame, sha256 } from '../scripts/crew-clip-assets.mjs';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url));
test('puesto CEO conserva original RGBA, contactos, ocho recortes y procedencia', () => {
 const manifest = JSON.parse(read('assets/crew/props/workstation.v1.json'));
 const bytes = read(manifest.file), png = decodeCrewPng(bytes);
 assert.equal(sha256(bytes), manifest.sha256);
 assert.equal(sha256(read(manifest.prompt)), manifest.promptSha256);
 assert.equal(png.width, manifest.width); assert.equal(png.height, manifest.height);
 assert.equal(manifest.status, 'prototype'); assert.equal(manifest.parts.length, 8);
 for (const part of manifest.parts) {
  const inspected = inspectCrewFrame(png, part.rect);
  assert.equal(inspected.rgbaSha256, part.rgbaSha256);
  assert.ok(inspected.transparent > 100 && inspected.opaque > 100);
  assert.ok(part.contact.x >= 0 && part.contact.x <= part.rect.width);
  assert.ok(part.contact.y >= 0 && part.contact.y <= part.rect.height);
 }
});
