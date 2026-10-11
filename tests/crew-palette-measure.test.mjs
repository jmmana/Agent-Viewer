import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodePng, measureRoleSwatch, measureAllNonCeoRoles, NON_CEO_ROLES } from '../scripts/crew-palette-measure.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const idleFrontPath = role => new URL(`../assets/crew/bank/characters/${role}/idle-front.png`, import.meta.url);

test('decodePng reconstruye el tamaño y alfa real de los PNG del banco Crew', () => {
  const { width, height, data } = decodePng(readFileSync(idleFrontPath('ceo')));
  assert.equal(width, 256);
  assert.equal(height, 352);
  assert.equal(data.length, width * height * 4);
  // Al menos un porcentaje relevante de píxeles opacos: no es un lienzo vacío mal decodificado.
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] >= 200) opaque++;
  assert.ok(opaque > width * height * 0.1, 'se esperaba contenido dibujado en el sprite');
});

// Valores bloqueados por esta prueba: si el arte prototipo de un rol cambia, esta prueba debe
// fallar hasta que se actualicen a la vez el valor aquí y la ficha del rol en
// docs/crew/visual-style-contract.md / .es.md (sección 6). No declara estos valores "ratificados";
// la ratificación de dirección de arte sigue pendiente (sección 13 del contrato).
const EXPECTED_SWATCH_BY_ROLE = {
  analyst: '#085868',
  developer: '#1848C8',
  finance: '#283838',
  planner: '#482888',
  reviewer: '#C85838',
};

test('NON_CEO_ROLES enumera exactamente los cinco roles sin CEO', () => {
  assert.deepEqual([...NON_CEO_ROLES].sort(), Object.keys(EXPECTED_SWATCH_BY_ROLE).sort());
});

for (const role of NON_CEO_ROLES) {
  test(`la prenda de ${role} mide el swatch documentado en la ficha del rol`, () => {
    const { hex, sampleCount } = measureRoleSwatch(readFileSync(idleFrontPath(role)));
    assert.equal(hex, EXPECTED_SWATCH_BY_ROLE[role]);
    // Debe provenir de una región real de la prenda, no de un puñado de píxeles sueltos.
    assert.ok(sampleCount > 200, `conteo de muestras sospechosamente bajo para ${role}: ${sampleCount}`);
  });
}

test('measureAllNonCeoRoles mide los cinco roles contra el banco real del repositorio', () => {
  const results = measureAllNonCeoRoles(root);
  assert.deepEqual(Object.keys(results).sort(), NON_CEO_ROLES.slice().sort());
  for (const role of NON_CEO_ROLES) assert.equal(results[role].hex, EXPECTED_SWATCH_BY_ROLE[role]);
});

test('measureRoleSwatch rechaza un PNG con formato no soportado', () => {
  const grayscalePngHeader = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    (() => {
      const chunk = Buffer.alloc(8 + 13 + 4);
      chunk.writeUInt32BE(13, 0);
      chunk.write('IHDR', 4);
      chunk.writeUInt32BE(1, 8); // width
      chunk.writeUInt32BE(1, 12); // height
      chunk[16] = 8; // bit depth
      chunk[17] = 0; // color type (grayscale, no soportado)
      chunk[20] = 0; // interlace
      return chunk;
    })(),
  ]);
  assert.throws(() => decodePng(grayscalePngHeader), /no soportado/);
});
