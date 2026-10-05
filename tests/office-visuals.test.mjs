import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OfficeMotion } from '../src/engine/visualMotion.ts';
import { isSpeechActive, placeOverlay, overlapArea, wrapText } from '../src/engine/visualLayout.ts';

const walker = { id: 'walker', x: 0, y: 0, targetX: 8, targetY: 0, isWalking: true, facing: 'SE' };

test('walking uses elapsed time and never mutates event state', () => {
  const source = Object.freeze({ ...walker });
  const positions = [30, 60, 120].map(fps => {
    const motion = new OfficeMotion();
    let pose;
    for (let i = 0; i < fps; i++) pose = motion.update([source], 1000 / fps)[0];
    return pose.x;
  });
  positions.forEach(x => assert.ok(Math.abs(x - 3) < 1e-9));
  assert.equal(source.x, 0);
});

test('walking finishes, reset is respected, and reduced motion jumps to the destination', () => {
  const motion = new OfficeMotion();
  let pose;
  for (let i = 0; i < 100; i++) pose = motion.update([{ ...walker, targetX: 0.5 }], 16)[0];
  assert.equal(pose.x, 0.5);
  assert.equal(pose.isWalking, false);
  assert.equal(motion.update([{ ...walker, isWalking: false }], 16)[0].x, 0);
  assert.equal(motion.update([walker], 16, true)[0].x, 8);
});

test('hidden-tab elapsed time cannot teleport a walking character', () => {
  assert.ok(new OfficeMotion().update([walker], 100000)[0].x <= 0.15);
});

test('speech expires against the event wall clock, including the exact expiry', () => {
  const now = 1790000000000;
  const speech = { text: 'Review complete', expiresAt: now + 4000 };
  assert.equal(isSpeechActive(speech, now), true);
  assert.equal(isSpeechActive(speech, now + 4000), false);
  assert.equal(isSpeechActive(speech, now + 5000), false);
  assert.equal(isSpeechActive({ text: '  ', expiresAt: now + 1000 }, now), false);
});

test('crowded cards find free space and remain within the viewport', () => {
  const viewport = { width: 600, height: 500 };
  const preferred = { x: 235, y: 230, width: 130, height: 38 };
  const occupied = [];
  for (let i = 0; i < 7; i++) {
    const placed = placeOverlay(preferred, occupied, viewport);
    assert.ok(placed.x >= 8 && placed.x + placed.width <= viewport.width - 8);
    assert.ok(placed.y >= 8 && placed.y + placed.height <= viewport.height - 8);
    assert.ok(occupied.every(other => overlapArea(placed, other) === 0));
    occupied.push(placed);
  }
});

test('cards at canvas edges stay visible', () => {
  const placed = placeOverlay({ x: -200, y: -200, width: 250, height: 64 }, [], { width: 320, height: 200 });
  assert.equal(placed.x, 8);
  assert.equal(placed.y, 8);
});

test('long tool names and URLs fit the two-line bubble with an ellipsis', () => {
  const measure = text => text.length * 7;
  const lines = wrapText('https://example.com/' + 'a'.repeat(150), 100, measure);
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => measure(line) <= 100));
  assert.ok(lines[1].endsWith('…'));
});

test('ordinary dialogue wraps at word boundaries', () => {
  assert.deepEqual(wrapText('Review the API contract before implementation', 21, text => text.length, 3), ['Review the API', 'contract before', 'implementation']);
});
