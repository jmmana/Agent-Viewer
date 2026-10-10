import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CREW_CEO_SPRITE } from '../src/crew/crewSprites.ts';
import { validateCrewAssets, CREW_CHARACTER_CANVAS, CREW_CHARACTER_ANCHOR } from '../scripts/crew-assets.mjs';

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
  ['lienzo de personaje fuera del contrato visual',m=>{m.assets.find(asset=>asset.kind==='furniture').kind='character';},/contrato visual Crew exige lienzo/],
  ['anclaje de personaje fuera del contrato visual',m=>m.assets[0].anchor={x:.4,y:.9375},/contrato visual Crew exige lienzo/],
]) {
  test(`banco Crew rechaza ${name}`,()=>{
    const value=manifest();mutate(value);
    assert.throws(()=>validateCrewAssets(root,value),pattern);
  });
}

test('el contrato visual Crew exige lienzo 256x352 y anclaje 0.5/0.9375 en los once personajes', () => {
  const characters = manifest().assets.filter(asset => asset.kind === 'character');
  assert.equal(characters.length, 11);
  for (const asset of characters) {
    assert.equal(asset.width, CREW_CHARACTER_CANVAS.width);
    assert.equal(asset.height, CREW_CHARACTER_CANVAS.height);
    assert.deepEqual(asset.anchor, CREW_CHARACTER_ANCHOR);
  }
});

test('el piloto CEO conserva dimensiones y anclaje del banco en sus cuatro vistas', () => {
  for (const view of ['front','right','back','left']) {
    const entry=manifest().assets.find(asset=>asset.id===`character.ceo.idle.${view}`);
    assert.equal(entry.width,CREW_CEO_SPRITE.width);
    assert.equal(entry.height,CREW_CEO_SPRITE.height);
    assert.deepEqual(entry.anchor,CREW_CEO_SPRITE.anchor);
  }
});
