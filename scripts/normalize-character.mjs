#!/usr/bin/env node
/** Mechanical RGBA runtime export; original artwork is never overwritten.
 * Optional source-art tooling: npm install --no-save sharp
 * node scripts/normalize-character.mjs <source.png> <runtime.png>
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const sharp = createRequire(import.meta.url)('sharp');
const [source, target] = process.argv.slice(2);
if (!source || !target || resolve(source) === resolve(target)) throw new Error('Provide different source and output paths.');
const cropped = await sharp(source).trim({ background: '#00000000', threshold: 16 }).png().toBuffer();
const content = await sharp(cropped).resize({ width: 216, height: 312, fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
await sharp({ create: { width: 256, height: 352, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: content.data, left: Math.round((256 - content.info.width) / 2), top: 330 - content.info.height }])
  .png().toFile(target);
console.log(`Exported ${target}: 256×352 RGBA; ground y=330, logical frame 64×88.`);
