import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_COMMIT = '355e9194bd83d8b741bc65d5b58a897d320ee584';
const MANIFEST = 'assets/crew/asset-manifest.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function imageSize(bytes, mimeType) {
  if (mimeType === 'image/png') {
    if (!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.length < 33) throw new Error('PNG inválido');
    if (![4,6].includes(bytes[25])) throw new Error('El PNG debe incluir canal alfa');
    return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
  }
  if (mimeType !== 'image/svg+xml') throw new Error('Formato no admitido');
  const svg = bytes.toString('utf8');
  if (/<(?:script|foreignObject)\b|\bon\w+\s*=|(?:href|src)\s*=|url\s*\(/i.test(svg)) throw new Error('SVG con contenido externo o activo');
  const width = Number(svg.match(/\bwidth="([\d.]+)"/)?.[1]);
  const height = Number(svg.match(/\bheight="([\d.]+)"/)?.[1]);
  if (!width || !height || !/<svg\b/.test(svg)) throw new Error('Dimensiones SVG inválidas');
  return {width,height};
}

function writePreserving(root, file, bytes) {
  if (!file.startsWith('assets/crew/') || file.includes('..') || file.includes('\\')) throw new Error('Ruta de importación inválida');
  const path = resolve(root,file);
  if (existsSync(path)) {
    if (!readFileSync(path).equals(bytes)) throw new Error(`No se sobrescribe un archivo diferente: ${file}`);
    return;
  }
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,bytes,{flag:'wx'});
}

/** Rescata bytes exactos del commit auditado; no importa código ni estudios vectoriales. */
export function importCrewAssets(root = process.cwd()) {
  const source = file => execFileSync('git',['show',`${SOURCE_COMMIT}:${file}`],{cwd:root,maxBuffer:20_000_000});
  const original = JSON.parse(source('assets/asset-manifest.json').toString('utf8'));
  const copy = (sourceFile,file,mimeType) => {
    const bytes = source(sourceFile);
    const size = imageSize(bytes,mimeType);
    writePreserving(root,file,bytes);
    return {file,sourceFile,sourceCommit:SOURCE_COMMIT,sha256:sha256(bytes),mimeType,...size};
  };
  const assets = original.assets.map(asset => {
    if (asset.status !== 'prototype' || asset.frames !== 1) throw new Error('La fuente cambió: revisar la migración antes de continuar');
    const file = asset.file.replace(/^assets\//,'assets/crew/bank/');
    const copied = copy(asset.file,file,asset.mimeType);
    return {
      id:asset.id,kind:asset.kind,status:'prototype',...copied,
      license:asset.license,provenance:asset.provenance,
      ...(asset.role ? {role:asset.role,clip:asset.clip,facing:asset.facing} : {}),
      logicalSize:asset.logicalSize,anchor:asset.anchor,frames:1,fps:0,loop:false,
      viewAvailability:Object.fromEntries(['front','right','back','left'].map(view => [view,
        asset.kind === 'character' ? (view === asset.facing ? 'prototype' : 'missing') : 'unverified'])),
    };
  });
  const reference = {
    id:'reference.ceo',status:'reference',license:'MIT',
    ...copy('assets/references/ceo-approved-concept.png','assets/crew/references/ceo-approved-concept.png','image/png'),
  };
  const manifest = {
    schemaVersion:1,source:{repository:'jmmana/Agent-Viewer',pullRequest:43,commit:SOURCE_COMMIT},
    usage:'source-bank',reference,assets,
  };
  writePreserving(root,MANIFEST,Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
  return manifest;
}

/** Validación offline: integridad, dimensiones, licencia y clasificación sin aprobación automática. */
export function validateCrewAssets(root = process.cwd(), suppliedManifest) {
  const manifest = suppliedManifest ?? JSON.parse(readFileSync(resolve(root,MANIFEST),'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.source?.commit !== SOURCE_COMMIT || manifest.usage !== 'source-bank') throw new Error('Contrato de banco Crew inválido');
  if (!Array.isArray(manifest.assets) || !manifest.reference) throw new Error('Inventario incompleto');
  const ids = new Set(), files = new Set(), counts = {};
  const bankRoot = realpathSync(resolve(root,'assets/crew'))+sep;
  for (const asset of [...manifest.assets,manifest.reference]) {
    if (ids.has(asset.id) || files.has(asset.file)) throw new Error('ID o archivo duplicado');
    ids.add(asset.id); files.add(asset.file);
    if (typeof asset.file !== 'string' || !asset.file.startsWith('assets/crew/') || asset.file.includes('..') || asset.file.includes('\\')) throw new Error('Ruta inválida');
    const path = realpathSync(resolve(root,asset.file));
    if (!path.startsWith(bankRoot)) throw new Error('Ruta fuera del banco');
    if (asset.sourceCommit !== SOURCE_COMMIT || asset.license !== 'MIT') throw new Error('Procedencia/licencia no verificada');
    const isReference = asset === manifest.reference;
    if (asset.status !== (isReference ? 'reference' : 'prototype')) throw new Error('La migración no aprueba arte automáticamente');
    const bytes = readFileSync(path);
    if (sha256(bytes) !== asset.sha256) throw new Error(`Hash diferente: ${asset.id}`);
    const size = imageSize(bytes,asset.mimeType);
    if (size.width !== asset.width || size.height !== asset.height) throw new Error('Dimensiones inconsistentes');
    if (!isReference) {
      if (!['character','furniture','electronics','effect'].includes(asset.kind)) throw new Error('Categoría inválida');
      if (asset.frames !== 1 || asset.fps !== 0 || asset.loop !== false) throw new Error('Una pose estática no es un clip animado');
      if (!Number.isFinite(asset.logicalSize?.width) || !Number.isFinite(asset.logicalSize?.height)
        || asset.logicalSize.width <= 0 || asset.logicalSize.height <= 0) throw new Error('Tamaño lógico inválido');
      if (![asset.anchor?.x,asset.anchor?.y].every(value=>Number.isFinite(value) && value>=0 && value<=1)) throw new Error('Anclaje inválido');
      for (const view of ['front','right','back','left']) {
        const expected = asset.kind === 'character' ? (view === asset.facing ? 'prototype' : 'missing') : 'unverified';
        if (asset.viewAvailability?.[view] !== expected) throw new Error('Perspectiva no verificada');
      }
      counts[asset.kind] = (counts[asset.kind] ?? 0)+1;
    }
  }
  return {assets:manifest.assets.length,counts,reference:manifest.reference.id};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'import') importCrewAssets();
    else if (process.argv[2] && process.argv[2] !== 'check') throw new Error('Uso: node scripts/crew-assets.mjs [import|check]');
    console.log(JSON.stringify(validateCrewAssets(),null,2));
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
