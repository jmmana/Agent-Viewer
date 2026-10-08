#!/usr/bin/env node
/**
 * Register a complete, approved-style raster sequence for Office Crew.
 *
 * Usage:
 *   node scripts/register-office-clip.mjs ceo walk front 10
 *   node scripts/register-office-clip.mjs ceo idle front 6 --replace
 *
 * Put 256x352 transparent PNGs (00.png, 01.png, ...) in:
 *   assets/animations/<role>/<clip>-<facing>/
 * The tool changes the manifest only; images must have been drawn and approved separately.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROLES = new Set(['ceo', 'planner', 'developer', 'analyst', 'reviewer', 'finance']);
const FACINGS = new Set(['front', 'back', 'left', 'right']);
const CLIPS = new Set(['idle', 'walk', 'think', 'talk', 'work', 'review', 'phone',
  'blocked', 'completed', 'sit', 'stand', 'approve', 'coffee', 'dance', 'stretch']);
const LOOPING = new Set(['idle', 'walk', 'think', 'talk', 'work', 'review', 'phone', 'blocked',
  'coffee', 'dance', 'stretch']);
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function parseRegistrationArgs(args) {
  const [role, clip, facing, fpsText, ...flags] = args;
  if (!ROLES.has(role)) throw new Error('Expected role: ceo/planner/developer/analyst/reviewer/finance');
  if (!CLIPS.has(clip)) throw new Error('Unsupported clip; see scripts/register-office-clip.mjs');
  if (!FACINGS.has(facing)) throw new Error('Expected facing: front/back/left/right');
  const fps = Number(fpsText);
  if (!Number.isInteger(fps) || fps < 1 || fps > 24) throw new Error('FPS must be an integer from 1 to 24');
  if (flags.some(flag => flag !== '--replace')) throw new Error('Unknown flag; only --replace is supported');
  return { role, clip, facing, fps, replace: flags.includes('--replace') };
}

function assertRasterFrame(buffer, filename) {
  if (buffer.length < 100 || !buffer.subarray(0, 8).equals(PNG_MAGIC))
    throw new Error(`Invalid PNG frame: ${filename}`);
  if (buffer.readUInt32BE(16) !== 256 || buffer.readUInt32BE(20) !== 352 || buffer[25] !== 6)
    throw new Error(`Frame must be 256x352 RGBA PNG: ${filename}`);
}

export function collectClipFrames(root, { role, clip, facing }) {
  if (!ROLES.has(role) || !CLIPS.has(clip) || !FACINGS.has(facing)) throw new Error('Invalid role/clip/facing');
  const folder = resolve(root, 'assets', 'animations', role, `${clip}-${facing}`);
  if (!existsSync(folder)) throw new Error(`Missing raster sequence folder: ${folder}`);
  const names = readdirSync(folder).filter(name => name.endsWith('.png')).sort();
  const minimum = clip === 'walk' ? 6 : 2;
  if (names.length < minimum) throw new Error(`${role}.${clip}.${facing} needs at least ${minimum} distinct frames`);
  if (names.some((name, index) => name !== `${String(index).padStart(2, '0')}.png`))
    throw new Error('Frames must have sequential names starting at 00.png, with no gaps');
  const contents = names.map(name => {
    const path = join(folder, name);
    const content = readFileSync(path);
    assertRasterFrame(content, name);
    return content;
  });
  if (!contents.some(content => !content.equals(contents[0])))
    throw new Error('All frames are identical; cannot register a static image as an animation');
  const files = names.map(name => relative(root, join(folder, name)).replaceAll('\\', '/'));
  if (files.some(file => !file.startsWith(`assets/animations/${role}/`)))
    throw new Error('Unexpected unsafe frame path');
  return files;
}

export function registerClip(root, options) {
  const frameFiles = collectClipFrames(root, options);
  const manifestPath = resolve(root, 'assets/asset-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.assets)) throw new Error('Invalid asset manifest');
  const id = `character.${options.role}.${options.clip}.${options.facing}`;
  const existingIndex = manifest.assets.findIndex(asset => asset.id === id);
  if (existingIndex >= 0 && !options.replace)
    throw new Error(`${id} already exists; use --replace to explicitly replace a prototype entry`);
  const entry = {
    id,
    kind: 'character',
    role: options.role,
    clip: options.clip,
    facing: options.facing,
    file: frameFiles[0],
    frameFiles,
    mimeType: 'image/png',
    status: 'prototype', // NEVER auto-approve artwork on import
    logicalSize: { width: 64, height: 88 },
    anchor: { x: 0.5, y: 0.9375 },
    frames: frameFiles.length,
    fps: options.fps,
    loop: LOOPING.has(options.clip),
    license: 'MIT',
    provenance: 'original-agent-viewer-raster-animation-awaiting-visual-approval',
    artFamily: 'office-beans-approved-reference',
    styleReference: 'assets/references/ceo-approved-concept.png',
  };
  if (existingIndex >= 0) manifest.assets[existingIndex] = entry;
  else manifest.assets.push(entry);
  // Write atomically; source artwork is never touched.
  const tmp = manifestPath + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    renameSync(tmp, manifestPath);
  } catch (error) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw error;
  }
  return { id, frames: frameFiles.length, fps: options.fps, files: frameFiles };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseRegistrationArgs(process.argv.slice(2));
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    console.log(JSON.stringify(registerClip(root, options), null, 2));
    console.log('Run npm run validate:assets; register only art that matches the approved CEO reference.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
