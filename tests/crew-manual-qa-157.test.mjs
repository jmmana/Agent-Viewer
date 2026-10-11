// Issue #157 (Epic #114, VIS-43): el propio PR de wiring de accesibilidad (ver
// "Continuación #157" en docs/crew/IMPLEMENTATION-STATUS.md) deja un solo pendiente real y
// explícito: la verificación manual con un lector de pantalla físico (VoiceOver/NVDA), que
// ningún agente de código puede ejecutar de verdad. Esta prueba NO certifica esa verificación
// manual; certifica que el documento que la describe (docs/crew/MANUAL-QA-157-SCREEN-READER.md)
// nunca describe un control, id o comportamiento que no exista de verdad hoy en el código fuente
// real de CrewStage.tsx/CrewRoomSelector.tsx/crewPreferences.ts/crewContrast.ts, y que el
// documento es honesto: no afirma que la verificación manual ya se hizo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const EM_DASH = '—';
const DOC_RELATIVE_PATH = 'docs/crew/MANUAL-QA-157-SCREEN-READER.md';
const DOC_PATH = `${repoRoot}${DOC_RELATIVE_PATH}`;

function readRepoFile(relativePath) {
  return readFileSync(`${repoRoot}${relativePath}`, 'utf8');
}

function readDoc() {
  return readFileSync(DOC_PATH, 'utf8');
}

// Deriva, del código fuente real, el conjunto de ids que CrewStage/CrewRoomSelector construyen
// como `${idPrefix}-algo`. Con idPrefix por defecto 'crew' (ver test de docs-crew-public-guide),
// esto da el nombre real de cada control en la app: crew-room, crew-high-contrast, etc.
function realCrewIds() {
  const stageSource = readRepoFile('src/crew/CrewStage.tsx');
  const roomSelectorSource = readRepoFile('src/crew/CrewRoomSelector.tsx');
  const ids = new Set();
  for (const source of [stageSource, roomSelectorSource]) {
    for (const match of source.matchAll(/\$\{idPrefix\}-([a-zA-Z0-9-]+?)[`$]/g)) {
      // Descarta el prefijo dinámico de "crew-call-dismiss-" (una id por agente, no un control fijo).
      if (!match[1].endsWith('-')) ids.add(`crew-${match[1]}`);
    }
  }
  return ids;
}

const CONTROL_IDS_DOC_MUST_NAME = [
  'crew-high-contrast',
  'crew-subtitles',
  'crew-muted',
  'crew-volume',
  'crew-hud-size',
  'crew-a11y-preset',
  'crew-reduced-motion',
  'crew-room',
  'crew-room-search',
  'crew-view',
  'crew-focus',
  'crew-captions',
  'crew-audio-toggle',
  'crew-audio-status',
];

test('docs/crew/MANUAL-QA-157-SCREEN-READER.md existe', () => {
  assert.ok(existsSync(DOC_PATH), `${DOC_RELATIVE_PATH} debe existir: es la entrega documental de #157`);
});

test('el documento no usa el carácter guión largo (regla de estilo del repositorio)', () => {
  const content = readDoc();
  const offenders = content
    .split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.includes(EM_DASH));
  assert.deepEqual(offenders, [], `${DOC_RELATIVE_PATH} no debe contener el carácter em dash (U+2014)`);
});

test('todo id "#crew-..." que el documento menciona como control existe de verdad en el código fuente', () => {
  const content = readDoc();
  const valid = realCrewIds();
  // Solo cuenta como "referencia a un id de control" la notación `#crew-algo`, la misma que usa
  // el documento en todo momento que señala un id real (estilo selector CSS). Rutas de archivo
  // como "tests/e2e/crew-accessibility-157.spec.ts" no empiezan con "#" y no se confunden con ids.
  const mentioned = new Set([...content.matchAll(/#(crew-[a-zA-Z0-9-]+)/g)].map((m) => m[1]));
  assert.ok(mentioned.size > 0, 'el documento debe mencionar al menos un id real de control de Crew con notación "#crew-algo"');
  for (const id of mentioned) {
    assert.ok(
      valid.has(id),
      `${DOC_RELATIVE_PATH} menciona "#${id}", que no corresponde a ningún id real derivado de CrewStage.tsx/CrewRoomSelector.tsx (ids reales: ${[...valid].sort().join(', ')})`,
    );
  }
});

test('el documento cubre todos los controles centrales de accesibilidad del wiring de #157', () => {
  const content = readDoc();
  const valid = realCrewIds();
  for (const id of CONTROL_IDS_DOC_MUST_NAME) {
    assert.ok(valid.has(id), `control de cordura: "${id}" ya no existe en el código fuente real; actualizar esta lista junto con el código`);
    assert.ok(content.includes(id), `${DOC_RELATIVE_PATH} debe documentar el control real "#${id}"`);
  }
});

test('el documento referencia el atributo real data-crew-captions de la región de subtítulos', () => {
  const stageSource = readRepoFile('src/crew/CrewStage.tsx');
  assert.ok(stageSource.includes('data-crew-captions="true"'), 'control de cordura: CrewStage.tsx ya no expone data-crew-captions');
  const content = readDoc();
  assert.ok(content.includes('data-crew-captions'), `${DOC_RELATIVE_PATH} debe mencionar el atributo real data-crew-captions`);
});

test('el documento describe los valores de color reales del tema de alto contraste (crewContrast.ts)', () => {
  const contrastSource = readRepoFile('src/crew/crewContrast.ts');
  const content = readDoc();
  // Estos hex concretos son los que CREW_HIGH_CONTRAST_THEME usa hoy; si el documento cita otros,
  // un verificador humano comparando con el DOM real encontraría una discrepancia.
  for (const hex of ['#000000', '#ffffff', '#ffd400']) {
    assert.ok(contrastSource.toLowerCase().includes(hex), `control de cordura: crewContrast.ts ya no usa ${hex} en CREW_HIGH_CONTRAST_THEME`);
    assert.ok(content.toLowerCase().includes(hex), `${DOC_RELATIVE_PATH} debe citar el color real ${hex} del tema de alto contraste`);
  }
});

test('el documento nombra los tres presets de accesibilidad reales de crewPreferences.ts', () => {
  const preferencesSource = readRepoFile('src/crew/crewPreferences.ts');
  const content = readDoc();
  for (const preset of ['none', 'screenReader', 'lowVision']) {
    assert.ok(preferencesSource.includes(`'${preset}'`), `control de cordura: crewPreferences.ts ya no declara el preset "${preset}"`);
  }
  // El documento usa las etiquetas visibles en inglés de la UI (las mismas que un lector de
  // pantalla real anunciaría en el <select>), no los valores internos en camelCase.
  for (const label of ['Screen reader', 'Low vision', 'None']) {
    assert.ok(content.includes(label), `${DOC_RELATIVE_PATH} debe citar la etiqueta visible real "${label}" del preset de accesibilidad`);
  }
});

test('el documento referencia la cobertura E2E automatizada existente de #157 sin suplantarla', () => {
  const e2ePath = 'tests/e2e/crew-accessibility-157.spec.ts';
  assert.ok(existsSync(`${repoRoot}${e2ePath}`), `control de cordura: ${e2ePath} debe seguir existiendo`);
  const content = readDoc();
  assert.ok(content.includes(e2ePath), `${DOC_RELATIVE_PATH} debe enlazar la prueba E2E automatizada real como lo que ya cubre teclado, no lectores de pantalla reales`);
});

test('el documento es honesto: no afirma que la verificación con lector de pantalla real ya se ejecutó', () => {
  const content = readDoc();
  const lower = content.toLowerCase();
  assert.ok(lower.includes('voiceover'), `${DOC_RELATIVE_PATH} debe mencionar VoiceOver`);
  assert.ok(lower.includes('nvda'), `${DOC_RELATIVE_PATH} debe mencionar NVDA`);
  // Frases que afirmarían falsamente que la verificación manual ya ocurrió.
  const dishonestClaims = [
    'ya se verificó con lector de pantalla',
    'ya se probó con voiceover',
    'ya se probó con nvda',
    'verificado con lector de pantalla real',
  ];
  for (const claim of dishonestClaims) {
    assert.ok(!lower.includes(claim), `${DOC_RELATIVE_PATH} no debe afirmar "${claim}": esa verificación no se ha ejecutado todavía`);
  }
  assert.ok(/pendiente/.test(lower), `${DOC_RELATIVE_PATH} debe declarar explícitamente que la ejecución manual sigue pendiente`);
});

test('el documento define un criterio explícito de aprobado y de fallo para cada paso', () => {
  const content = readDoc();
  const lower = content.toLowerCase();
  assert.ok(lower.includes('aprobado'), `${DOC_RELATIVE_PATH} debe usar la palabra "aprobado" para marcar el criterio de éxito`);
  assert.ok(/fallo|falla\b/.test(lower), `${DOC_RELATIVE_PATH} debe usar "fallo"/"falla" para marcar el criterio de incumplimiento`);
});

test('el documento referencia la trazabilidad real: issue #157, epic #114 y el registro canónico', () => {
  const content = readDoc();
  assert.ok(content.includes('#157'), `${DOC_RELATIVE_PATH} debe referenciar el issue #157`);
  assert.ok(content.includes('#114'), `${DOC_RELATIVE_PATH} debe referenciar el epic #114`);
  assert.ok(content.includes('IMPLEMENTATION-STATUS.md'), `${DOC_RELATIVE_PATH} debe enlazar docs/crew/IMPLEMENTATION-STATUS.md como registro canónico`);
});

test('docs/crew/IMPLEMENTATION-STATUS.md enlaza el nuevo documento de QA manual', () => {
  const content = readRepoFile('docs/crew/IMPLEMENTATION-STATUS.md');
  assert.ok(content.includes(DOC_RELATIVE_PATH), 'IMPLEMENTATION-STATUS.md debe enlazar docs/crew/MANUAL-QA-157-SCREEN-READER.md para que no quede huérfano del registro canónico');
});
