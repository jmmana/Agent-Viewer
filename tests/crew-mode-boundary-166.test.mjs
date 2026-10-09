// Contrato de arquitectura de dos modos (#166): Caricatura y Crew son árboles de renderizado
// independientes. Esta prueba escanea el código fuente real (no una lista mantenida a mano) para
// que una regresión de import quede atrapada en CI, no solo documentada en el ADR.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Lista todos los archivos .ts/.tsx bajo `dir` (relativo a `root`), recursivamente. */
function listSourceFiles(dir) {
  const absolute = join(root, dir);
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
  };
  walk(absolute);
  return out;
}

function importSpecifiers(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const specifiers = [];
  const importRe = /\bimport\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g;
  const dynamicRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [importRe, dynamicRe]) {
    let match;
    while ((match = re.exec(content)) !== null) specifiers.push(match[1]);
  }
  return specifiers;
}

const legacyDirs = ['src/engine', 'src/components'];
const crewFiles = listSourceFiles('src/crew');
const legacyFiles = legacyDirs.flatMap((dir) => listSourceFiles(dir));

test('Caricatura (src/engine y src/components) nunca importa el árbol Crew', () => {
  const offenders = [];
  for (const file of legacyFiles) {
    for (const specifier of importSpecifiers(file)) {
      if (specifier.includes('/crew/') || specifier.endsWith('/crew') || specifier.includes('../crew')) {
        offenders.push(`${relative(root, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'El renderer legado Caricatura no debe depender de src/crew');
});

test('Crew nunca importa el renderer, la cuadrícula ni el componente de Caricatura', () => {
  const forbidden = [
    { pattern: /engine\/canvasRenderer/, label: 'engine/canvasRenderer (bucle visual y renderFurnitureItem de Caricatura)' },
    { pattern: /engine\/livingOfficeEngine/, label: 'engine/livingOfficeEngine (oficina viva simulada de Caricatura)' },
    { pattern: /engine\/visualLayout/, label: 'engine/visualLayout (cuadrícula visual antigua)' },
    { pattern: /engine\/visualMotion/, label: 'engine/visualMotion (interpolación de movimiento de Caricatura)' },
    { pattern: /components\/OfficeCanvas/, label: 'components/OfficeCanvas (componente Canvas2D legado)' },
  ];
  const offenders = [];
  for (const file of crewFiles) {
    for (const specifier of importSpecifiers(file)) {
      for (const { pattern, label } of forbidden) {
        if (pattern.test(specifier)) offenders.push(`${relative(root, file)} -> ${specifier} (${label})`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'Crew debe seguir siendo un renderer aislado, sin reutilizar el pipeline de Caricatura');
});

test('renderFurnitureItem del renderer Caricatura no se exporta fuera de canvasRenderer', () => {
  const content = readFileSync(join(root, 'src/engine/canvasRenderer.ts'), 'utf8');
  assert.match(content, /\nfunction renderFurnitureItem\(/, 'debe seguir siendo una función privada del módulo');
  assert.doesNotMatch(content, /export\s+(?:function|const)\s+renderFurnitureItem/, 'no debe exportarse: Crew no puede reutilizarla');
});

test('CrewStage no importa OfficeCanvas ni el renderer de Caricatura desde la biblioteca embebida', () => {
  const content = readFileSync(join(root, 'src/lib/AgentOffice.tsx'), 'utf8');
  // Ambos renderers coexisten en AgentOffice (el punto de selección del modo), pero cada uno vive en su
  // propio módulo: CrewStage no debe importar símbolos internos de OfficeCanvas ni viceversa.
  assert.match(content, /import \{ CrewStage \} from '\.\.\/crew\/CrewStage'/);
  assert.match(content, /import \{ OfficeCanvas \} from '\.\.\/components\/OfficeCanvas'/);
});
