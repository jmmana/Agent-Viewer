#!/usr/bin/env node
/**
 * Agent Viewer Office Crew: validate the visual asset registry.
 * Usage: node scripts/validate-visual-assets.mjs
 *
 * This checks files and metadata; it does NOT claim that prototype art is
 * approved or that walking/meeting clips have been implemented.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
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
  if (rel.startsWith('..') || rel.startsWith('/') || !rel.startsWith('assets/')) {
    errors.push(`${where}.file escapes assets root: ${asset.file}`);
    continue;
  }
  if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
    errors.push(`${where} referenced asset does not exist: ${asset.file}`);
    continue;
  }
  const content = readFileSync(assetPath);
  check(asset.logicalSize?.width > 0 && asset.logicalSize?.height > 0, `${where} invalid logicalSize`);
  check(asset.anchor?.x >= 0 && asset.anchor?.x <= 1 && asset.anchor?.y >= 0 && asset.anchor?.y <= 1, `${where} normalized anchor required`);
  check(asset.license === 'MIT' && typeof asset.provenance === 'string', `${where} missing original asset provenance/license`);
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
    check(!/\/(source|vector-study)\//.test(asset.file), `${where} source artwork/studies must not enter runtime catalog`);
    check(typeof asset.role === 'string' && asset.role.length > 0, `${where} missing role`);
    check(typeof asset.clip === 'string' && asset.clip.length > 0, `${where} missing clip`);
    check(allowFacings.has(asset.facing), `${where} invalid facing`);
    check(asset.logicalSize?.width > 0 && asset.logicalSize?.height > 0, `${where} invalid logicalSize`);
    check(asset.anchor?.x >= 0 && asset.anchor?.x <= 1 && asset.anchor?.y >= 0 && asset.anchor?.y <= 1, `${where} normalized anchor required`);
    check(Number.isInteger(asset.frames) && asset.frames >= 1, `${where} invalid frames`);
    check(Number.isFinite(asset.fps) && asset.fps >= 0, `${where} invalid fps`);
    if (asset.frameFiles) {
      check(Array.isArray(asset.frameFiles) && asset.frameFiles.length === asset.frames, `${where} frameFiles count does not match frames`);
      check(asset.frameFiles[0] === asset.file, `${where} first frame must match file`);
      const frameBytes = [];
      for (const [frameIndex, frame] of asset.frameFiles.entries()) {
        const isValidPath = typeof frame === 'string'
          && /^(?:assets\/characters|assets\/animations)\/[a-z0-9_-]+\/.+\.(?:png|webp)$/.test(frame)
          && !/\/(?:source|vector-study)\//.test(frame);
        const framePath = isValidPath ? resolve(root, frame) : null;
        if (!framePath || !relative(root, framePath).startsWith('assets/')
            || !existsSync(framePath) || !statSync(framePath).isFile()) {
          errors.push(`${where}.frameFiles[${frameIndex}] missing/unsafe runtime frame: ${frame}`);
          continue;
        }
        const buffer = readFileSync(framePath);
        const frameExt = extname(frame).toLowerCase();
        if (frameExt === '.png') {
          const isPNG = buffer.length >= 26
            && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
          check(isPNG, `${where}.frameFiles[${frameIndex}] invalid PNG header`);
          if (isPNG) {
            check(buffer.readUInt32BE(16) === 256 && buffer.readUInt32BE(20) === 352,
              `${where}.frameFiles[${frameIndex}] must be 256x352 pixels`);
            check(buffer[25] === 6,
              `${where}.frameFiles[${frameIndex}] requires RGBA alpha`);
          }
        } else {
          check(buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF'
            && buffer.toString('ascii', 8, 12) === 'WEBP',
            `${where}.frameFiles[${frameIndex}] invalid WebP header`);
        }
        frameBytes.push(buffer);
      }
      // All-identical frames are a static pose repeated, not an animated production clip.
      if (asset.frames > 1 && frameBytes.length === asset.frames) {
        check(frameBytes.some(buffer => !buffer.equals(frameBytes[0])),
          `${where} animation has identical frame images; no visible frame-by-frame motion`);
      }
    }
    if (ext === '.png') {
      check(content.readUInt32BE(16) === 256 && content.readUInt32BE(20) === 352, `${where} runtime PNG must be 256×352`);
      check(content[25] === 6, `${where} runtime PNG requires RGBA alpha`);
    }
  }
}

// Layouts live in assets/rooms/<id>/layout.json. Validate every current/future
// room, not the unused legacy assets/rooms/<id>.json path.
const roomsDir = resolve(root, 'assets/rooms');
for (const roomId of existsSync(roomsDir)
  ? readdirSync(roomsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  : []) {
  const file = resolve(roomsDir, roomId, 'layout.json');
  if (!existsSync(file)) { errors.push(`${roomId}: missing layout.json`); continue; }
  try {
    const layout = JSON.parse(readFileSync(file, 'utf8'));
    check(layout.id === roomId, `${roomId}: layout id must match its directory`);
    check(layout.size?.width > 0 && layout.size?.height > 0, `${roomId}: invalid room dimensions`);
    check(Array.isArray(layout.placements), `${roomId}: placements must be an array`);
    const placements = new Set();
    for (const placement of layout.placements ?? []) {
      check(ids.has(placement.assetId), `${roomId}: unknown asset ${placement.assetId}`);
      check(!placements.has(placement.id), `${roomId}: duplicate placement ${placement.id}`);
      placements.add(placement.id);
      check(Number.isFinite(placement.x) && Number.isFinite(placement.y), `${roomId}: invalid placement coordinates`);
      check(placement.x >= 0 && placement.y >= 0
        && placement.x <= layout.size?.width && placement.y <= layout.size?.height,
        `${roomId}: placement outside room bounds: ${placement.id}`);
    }
    for (const placement of layout.placements ?? []) {
      if (placement.supportPlacementId) {
        check(placements.has(placement.supportPlacementId),
          `${roomId}: missing support placement: ${placement.supportPlacementId}`);
        check(placement.supportPlacementId !== placement.id,
          `${roomId}: placement cannot support itself: ${placement.id}`);
      }
    }
  } catch (error) { errors.push(`${roomId}: invalid layout: ${error.message}`); }
}

if (errors.length) {
  for (const err of errors) console.error('FAIL:', err);
  console.error(`Asset validation failed: ${errors.length} problem(s).`);
  process.exit(1);
}
console.log(`OK: ${ids.size} visual asset(s), all references exist. Approval/animation readiness not inferred.`);
