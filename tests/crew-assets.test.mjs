import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateCrewAssets } from '../scripts/crew-assets.mjs';

const root = fileURLToPath(new URL('../',import.meta.url));
const manifest = () => JSON.parse(readFileSync(new URL('../assets/crew/asset-manifest.json',import.meta.url),'utf8'));

test('banco Crew conserva 53 originales y una referencia con hashes y dimensiones válidos', () => {
  assert.deepEqual(validateCrewAssets(root),{
    assets:53,counts:{character:11,furniture:20,electronics:13,effect:9},reference:'reference.ceo',
  });
});

for (const [name,mutate,pattern] of [
  ['hash alterado',m=>m.assets[0].sha256='0'.repeat(64),/Hash diferente/],
  ['archivo repetido',m=>m.assets.push({...m.assets[0]}),/duplicado/],
  ['ruta ajena',m=>m.assets[0].file='../README.md',/Ruta inválida/],
  ['licencia desconocida',m=>m.assets[0].license='unknown',/licencia/],
  ['aprobación automática',m=>m.assets[0].status='approved',/no aprueba/],
  ['clip inventado',m=>m.assets[0].frames=6,/pose estática/],
  ['dimensiones alteradas',m=>m.assets[0].width=1,/Dimensiones/],
  ['perspectiva inventada',m=>m.assets[0].viewAvailability.back='prototype',/Perspectiva/],
  ['anclaje fuera del sprite',m=>m.assets[0].anchor.x=2,/Anclaje/],
]) {
  test(`banco Crew rechaza ${name}`,()=>{
    const value=manifest();mutate(value);
    assert.throws(()=>validateCrewAssets(root,value),pattern);
  });
}
