import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {validateCrewWalkManifest,importCrewWalkManifest} from '../scripts/crew-clip-assets.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const manifest=()=>JSON.parse(readFileSync(new URL('../assets/crew/clips/manifest.v1.json',import.meta.url),'utf8'));
test('los cuatro atlas originales tienen 32 cuadros íntegros, RGBA real y procedencia del prompt',()=>{
  assert.deepEqual(validateCrewWalkManifest(root),{clips:4,frames:32});
});
for(const [name,mutate,pattern] of [
  ['catálogo vacío',m=>m.clips=[],/exactamente/],
  ['orientación ausente',m=>m.clips.pop(),/exactamente/],
  ['orientación repetida',m=>m.clips[1].facing='front',/exactamente/],
  ['aprobación automática',m=>m.clips[0].status='approved',/no aprueba/],
  ['rol ajeno al piloto',m=>m.clips[0].role='developer',/Identidad/],
  ['versión inválida',m=>m.clips[0].version=0,/version/],
  ['hash cambiado',m=>m.clips[0].sha256='0'.repeat(64),/Hash del atlas/],
  ['prompt cambiado',m=>m.clips[0].provenance.promptSha256='0'.repeat(64),/Hash del prompt/],
  ['ruta ajena',m=>m.clips[0].file='../README.md',/Ruta inválida/],
  ['archivo repetido',m=>m.clips[1].file=m.clips[0].file,/duplicado/],
  ['dimensiones falsas',m=>m.clips[0].width=256,/Dimensiones/],
  ['anclaje lógico distinto',m=>m.clips[0].anchor.x=.4,/Contrato lógico/],
  ['cuadros insuficientes',m=>m.clips[0].frames.length=5,/6\+/],
  ['rectángulo fuera del atlas',m=>m.clips[0].frames[0].x=9999,/Rectángulo/],
  ['duración nula',m=>m.clips[0].frames[0].durationMs=0,/Anclaje\/duración/],
  ['anclaje fuera del cuadro',m=>m.clips[0].frames[0].anchor.y=9999,/Anclaje\/duración/],
  ['fotograma cambiado',m=>m.clips[0].frames[0].rgbaSha256='0'.repeat(64),/Hash de fotograma/],
  ['fotograma repetido',m=>m.clips[0].frames[1]={...m.clips[0].frames[0]},/Fotograma duplicado/],
  ['revisión visual ausente',m=>delete m.clips[0].review,/revisión visual/],
]) test(`el pipeline rechaza ${name}`,()=>{const value=manifest();mutate(value);assert.throws(()=>validateCrewWalkManifest(root,value),pattern);});

test('importar es idempotente, solo prototype y nunca reemplaza otro catálogo válido',()=>{
  const candidate=manifest();candidate.clips.forEach(clip=>clip.status='approved');
  assert.deepEqual(importCrewWalkManifest(root,candidate),manifest());
  candidate.clips[0].review.notes+=' Otro catálogo.';
  assert.throws(()=>importCrewWalkManifest(root,candidate),/no se reemplaza/);
});
