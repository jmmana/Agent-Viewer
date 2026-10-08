#!/usr/bin/env node
/**
 * Agent Viewer Office Crew: validate the visual asset registry.
 * Usage: node scripts/validate-visual-assets.mjs
 *
 * This checks files and metadata; it does NOT claim that prototype art is
 * approved or that walking/meeting clips have been implemented.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const catalogPath = resolve(root, 'assets/asset-manifest.json');
const errors = [];
const check = (test, message) => { if (!test) errors.push(message); };

let catalog;
try {
  catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
} catch (error) {
  console.error('Invalid assets/asset-manifest.json:', error.message);
  process.exit(1);
}
check(catalog.schemaVersion === '1.0.0', 'Unsupported schemaVersion (expected 1.0.0)');
check(catalog.coordinateSystem?.tileSize === 48, 'Initial coordinate contract expects 48 px grid tiles');
check(Array.isArray(catalog.assets), 'assets must be an array');
const ids = new Set();
const allowKinds = new Set(['character', 'furniture', 'electronics', 'room', 'effect']);
const allowStates = new Set(['prototype', 'approved']);
const allowFacings = new Set(['front', 'back', 'left', 'right']);

for (const [index, asset] of (catalog.assets ?? []).entries()) {
  const where = `assets[${index}]`;
  check(typeof asset.id === 'string' && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(asset.id), `${where}.id must be a lowercase stable id`);
  check(!ids.has(asset.id), `Duplicate asset id: ${asset.id}`);
  ids.add(asset.id);
  check(allowKinds.has(asset.kind), `${where} invalid kind`);
  check(allowStates.has(asset.status), `${where} invalid status`);
  check(typeof asset.file === 'string' && asset.file.startsWith('assets/'), `${where}.file must live under assets/`);
  if (typeof asset.file !== 'string') continue;
  const assetPath = resolve(root, asset.file);
  const rel = relative(root, assetPath);
  if (rel.startsWith('..') || rel.startsWith('/') || !asset.file.startsWith('assets/')) {
    errors.push(`${where}.file escapes assets root: ${asset.file}`);
    continue;
  }
  if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
    errors.push(`${where} referenced asset does not exist: ${asset.file}`);
    continue;
  }
  const content = readFileSync(assetPath);
  check(content.length > 100, `${where} file is unexpectedly small`);
  const ext = extname(asset.file).toLowerCase();
  if (ext === '.svg') {
    const xml = content.toString('utf8');
    check(/<svg\b/.test(xml) && /<\/svg>/.test(xml), `${where} not a standalone SVG`);
    check(!/<script\b|<foreignObject\b|onload\s*=|https?:\/\//i.test(xml.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')), `${where} SVG contains scripts, external URLs or foreign content`);
  } else if (ext === '.png') {
    check(content.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), `${where} invalid PNG header`);
  } else if (ext === '.webp') {
    check(content.toString('ascii',0,4)==='RIFF' && content.toString('ascii',8,12)==='WEBP', `${where} invalid WebP header`);
  } else {
    errors.push(`${where} unsupported media extension: ${ext}`);
  }
  if (asset.kind === 'character') {
    check(typeof asset.role === 'string' && asset.role.length > 0, `${where} missing role`);
    check(typeof asset.clip === 'string' && asset.clip.length > 0, `${where} missing clip`);
    check(allowFacings.has(asset.facing), `${where} invalid facing`);
    check(asset.logicalSize?.width > 0 && asset.logicalSize?.height > 0, `${where} invalid logicalSize`);
    check(asset.anchor?.x >= 0 && asset.anchor?.x <= 1 && asset.anchor?.y >= 0 && asset.anchor?.y <= 1, `${where} normalized anchor required`);
    check(Number.isInteger(asset.frames) && asset.frames >= 1, `${where} invalid frames`);
    check(Number.isFinite(asset.fps) && asset.fps >= 0, `${where} invalid fps`);
  }
}

if (errors.length) {
  for (const err of errors) console.error('FAIL:', err);
  console.error(`Asset validation failed: ${errors.length} problem(s).`);
  process.exit(1);
}
console.log(`OK: ${ids.size} visual asset(s), all references exist. Approval/animation readiness not inferred.`);
