// Issue #161 (Epic #114, VIS-47): este issue es explícitamente de proceso/gobierno, no de arte. Consolida
// qué quedó realmente integrado del PR #43 (`feat/visual-assets-v1`) como banco de arte de referencia para
// Crew, y define un gate de retiro de Caricatura verificable: una lista de condiciones objetivas bajo las
// cuales algún día se podría evaluar retirar el modo legado, sin retirarlo ahora (el EPIC #114 es explícito
// en que "Caricatura NO se elimina automáticamente").
//
// Esta prueba no aprueba ni certifica ningún criterio: solo falla si el documento de consolidación deja de
// existir, si pierde su enlace a los documentos canónicos que ya auditó #172, o si alguna ruta de archivo
// que el gate cita como evidencia verificable desaparece del repositorio (lo que convertiría al gate en una
// lista de afirmaciones no verificables). También falla si el documento se desalinea del hecho real, hoy
// comprobable en disco, de que ningún recurso del banco tiene todavía `status: 'approved'`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const DOC_RELATIVE_PATH = 'docs/crew/PR43-CONSOLIDATION.md';
const DOC_PATH = `${repoRoot}${DOC_RELATIVE_PATH}`;
const EM_DASH = '—';

function readDoc() {
  return readFileSync(DOC_PATH, 'utf8');
}

test('el documento de consolidación del PR #43 (#161) existe en docs/crew/', () => {
  assert.ok(existsSync(DOC_PATH), `${DOC_RELATIVE_PATH} debe existir: es la entrega documental de #161`);
});

test('el documento no usa el carácter guión largo (regla de estilo del repositorio)', () => {
  const content = readDoc();
  const offenders = content
    .split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.includes(EM_DASH));
  assert.deepEqual(offenders, [], `${DOC_RELATIVE_PATH} no debe contener el carácter em dash (U+2014)`);
});

test('el documento enlaza y no contradice la auditoría canónica ya cerrada de #172', () => {
  const content = readDoc();
  assert.match(content, /ASSET-MIGRATION-PR43\.md/, 'debe referenciar la matriz de migración ya auditada por #172');
  assert.match(content, /ISSUE-172-ACCEPTANCE\.md/, 'debe referenciar la aceptación ya cerrada de #172');
  assert.ok(
    existsSync(`${repoRoot}docs/crew/ASSET-MIGRATION-PR43.md`),
    'el documento que #161 referencia como fuente de la matriz de migración debe existir de verdad',
  );
  assert.ok(
    existsSync(`${repoRoot}docs/crew/ISSUE-172-ACCEPTANCE.md`),
    'el documento que #161 referencia como auditoría cerrada de #172 debe existir de verdad',
  );
});

test('el documento declara el estado real del banco de arte: 53 recursos, ninguno "approved"', () => {
  const content = readDoc();
  const manifest = JSON.parse(readFileSync(`${repoRoot}assets/crew/asset-manifest.json`, 'utf8'));
  const total = manifest.assets.length;
  const approved = manifest.assets.filter((asset) => asset.status === 'approved').length;
  assert.equal(total, 53, 'control de cordura: el manifest real sigue teniendo 53 recursos runtime');
  assert.equal(approved, 0, 'control de cordura: ningún recurso del banco real es "approved" todavía');
  assert.match(
    content,
    new RegExp(String(total)),
    'el documento debe citar el conteo real de recursos del banco (53), no un número inventado',
  );
  assert.match(
    content,
    /ning[uú]n.{0,40}approved|cero.{0,40}approved|status.{0,10}prototype/i,
    'el documento debe declarar que ningún recurso del banco está aprobado como arte final todavía',
  );
});

test('el documento declara que #43 sigue sin fusionarse a main como reemplazo total', () => {
  const content = readDoc();
  assert.match(
    content,
    /draft|borrador/i,
    'el documento debe reflejar que el PR #43 permanece en borrador (estado real verificado con gh pr view 43)',
  );
  assert.match(
    content,
    /no se ha fusionado|no fusionar|no se fusiona/i,
    'el documento debe declarar explícitamente que #43 no se ha fusionado como reemplazo de Caricatura',
  );
});

test('el gate de retiro de Caricatura declara explícitamente que este documento no retira nada', () => {
  const content = readDoc();
  assert.match(
    content,
    /no se elimina autom[aá]ticamente/i,
    'debe citar la regla explícita del EPIC #114: Caricatura NO se elimina automáticamente',
  );
  assert.match(
    content,
    /aprobaci[oó]n expl[ií]cita/i,
    'el gate debe exigir aprobación explícita y posterior del propietario antes de cualquier retiro real',
  );
  assert.match(
    content,
    /este documento no (retira|decide el retiro|autoriza)/i,
    'el documento debe declarar, en su propio texto, que no ejecuta ni decide ningún retiro',
  );
});

test('cada ruta de archivo citada como evidencia en la tabla del gate de retiro existe de verdad en el repositorio', () => {
  const content = readDoc();
  const gateHeadingMatch = content.match(/^##.*Gate de retiro de Caricatura.*$/m);
  assert.ok(gateHeadingMatch, 'el documento debe tener una sección de encabezado "## ... Gate de retiro de Caricatura"');
  const gateStart = content.indexOf(gateHeadingMatch[0]);
  const nextHeading = content.indexOf('\n## ', gateStart + 1);
  const gateSection = nextHeading === -1 ? content.slice(gateStart) : content.slice(gateStart, nextHeading);

  // Extrae rutas de archivo citadas entre backticks dentro de la sección del gate, por ejemplo
  // `src/crew/crewCamera.ts` o `tests/e2e/crew-camera.spec.ts`. Ignora rutas que no parecen archivos
  // del repositorio (sin extensión reconocible) para no exigir que cada identificador técnico sea un path.
  const codeSpanPattern = /`([^`]+)`/g;
  const filePathPattern = /^[\w./-]+\.(ts|tsx|mjs|js|json|md)$/;
  const referencedPaths = new Set();
  let match;
  while ((match = codeSpanPattern.exec(gateSection)) !== null) {
    const candidate = match[1].trim();
    if (filePathPattern.test(candidate)) {
      referencedPaths.add(candidate);
    }
  }

  assert.ok(
    referencedPaths.size >= 8,
    `el gate debe citar al menos 8 rutas de evidencia verificable distintas (encontradas: ${referencedPaths.size})`,
  );

  const missing = [...referencedPaths].filter((relativePath) => !existsSync(`${repoRoot}${relativePath}`));
  assert.deepEqual(
    missing,
    [],
    `estas rutas citadas como evidencia del gate ya no existen en el repositorio: ${missing.join(', ')}`,
  );
});

test('el gate de retiro cubre los nueve ejes exigidos literalmente por el issue #161', () => {
  const content = readDoc();
  const requiredTopics = [
    /requisitos.{0,20}(completos|literales).{0,20}epic/i,
    /10-?11 escenas funcionales|10 escenas funcionales|diez escenas funcionales|11 salas|once salas/i,
    /c[aá]mara.{0,15}por sala/i,
    /animaci[oó]n(es)? (reales|cuadro a cuadro)/i,
    /seis roles|6 roles/i,
    /LIVE.{0,200}REPLAY|ficticios/i,
    /accesibilidad/i,
    /rendimiento|perf/i,
    /E2E dual|dos modos/i,
    /respaldo|rollback|reversi[oó]n/i,
    /aprobaci[oó]n expl[ií]cita/i,
  ];
  const missingTopics = requiredTopics.filter((pattern) => !pattern.test(content));
  assert.deepEqual(
    missingTopics.map((pattern) => pattern.source),
    [],
    'el gate debe cubrir cada eje que el issue #161 exige literalmente (requisitos del Epic, escenas, cámara, animación, roles, LIVE/REPLAY, accesibilidad, rendimiento, E2E dual-mode, respaldo/rollback y aprobación explícita)',
  );
});
