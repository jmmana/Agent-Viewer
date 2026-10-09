import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {CREW_CEO_BLINK,validateCrewClip} from '../src/crew/crewAnimation.ts';

test('atlas de parpadeo preserva hash, dimensiones RGBA y trazabilidad sin aprobar arte',()=>{
  const metadata=JSON.parse(readFileSync(new URL('../assets/crew/clips/ceo-blink-front-v1.json',import.meta.url),'utf8'));
  const bytes=readFileSync(new URL('../assets/crew/clips/ceo-blink-front-v1.png',import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),metadata.sha256);
  assert.equal(bytes.readUInt32BE(16),CREW_CEO_BLINK.width);
  assert.equal(bytes.readUInt32BE(20),CREW_CEO_BLINK.height);
  assert.equal(bytes[24],8);
  assert.equal(bytes[25],6);
  assert.equal(metadata.id,CREW_CEO_BLINK.id);
  assert.equal(metadata.status,'prototype');
  assert.equal(metadata.license,'MIT');
  assert.equal(metadata.frames.length,CREW_CEO_BLINK.frames.length);
  assert.equal(new Set(metadata.frames.map(frame=>frame.rgbaSha256)).size,4);
  assert.equal(validateCrewClip(CREW_CEO_BLINK),true);
});
