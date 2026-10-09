#!/usr/bin/env node
/**
 * Benchmark determinista del renderer Crew (issue #158).
 *
 * Mide el coste real en JavaScript de `renderCrewRoom` para cada una de las
 * once salas del catalogo, en cuatro niveles de agentes (0/6/20/50), usando un
 * contexto 2D "no-op" (sin rasterizado real). Esto aisla el coste de
 * proyeccion isometrica, orden por profundidad y recorrido de mobiliario y
 * marcadores, que es el unico costo que el renderer controla directamente.
 *
 * No mide FPS pintados por el navegador ni memoria de heap real: para eso,
 * usa `scripts/crew-perf-browser.mjs` (requiere Chromium via Playwright y el
 * servidor de desarrollo corriendo). Ver docs/crew/PERFORMANCE.md.
 *
 * Uso: npm run crew:perf:bench
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { CREW_ROOMS } from '../src/crew/crewModel.ts';
import { renderCrewRoom } from '../src/crew/renderCrewRoom.ts';

/** Perfil de agentes acordado en el issue #158: piso 0, carga tipica 6/20, techo 50. */
const AGENT_TIERS = [0, 6, 20, 50];
const WARMUP_ITERATIONS = 20;
const SAMPLE_ITERATIONS = 200;
const FACINGS = ['SE', 'SW', 'NW', 'NE'];
const STATUSES = ['IDLE', 'CODING', 'THINKING', 'ERROR', 'WALKING'];

/** Umbrales propuestos (el issue #158 no da numeros concretos para este costo puro). */
const BUDGET_TARGET_MS = 1000 / 60; // 16.67ms: objetivo 60 FPS
const BUDGET_FLOOR_MS = 1000 / 30; // 33.33ms: piso 30 FPS
/** Margen reservado para rasterizado/composicion real del navegador, no medido aqui. */
const JS_BUDGET_FRACTION = 0.25;

function makeMarkers(room, count) {
  const markers = [];
  for (let i = 0; i < count; i++) {
    markers.push({
      id: `perf-${i}`,
      name: `Perf ${i}`,
      role: i % 3 === 0 ? 'boss' : 'custom',
      facing: FACINGS[i % FACINGS.length],
      status: STATUSES[i % STATUSES.length],
      x: (i % room.width) + 0.5,
      y: (Math.floor(i / room.width) % room.depth) + 0.5,
      number: i + 1,
    });
  }
  return markers;
}

/** Contexto 2D que no dibuja nada: aisla el costo JS del render del costo de rasterizado. */
function makeNoopContext() {
  return new Proxy({}, {
    get(_target, key) {
      if (key === 'save' || key === 'restore' || key === 'beginPath' || key === 'closePath'
        || key === 'moveTo' || key === 'lineTo' || key === 'fill' || key === 'stroke'
        || key === 'translate' || key === 'scale' || key === 'drawImage' || key === 'fillRect'
        || key === 'fillText' || key === 'ellipse') return () => {};
      return () => {};
    },
    set() { return true; },
  });
}

function percentile(sorted, p) {
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index];
}

function benchmarkRoom(room, agentCount) {
  const markers = makeMarkers(room, agentCount);
  const ctx = makeNoopContext();
  const input = { ctx, width: 1280, height: 800, room, camera: { view: 'front', zoom: 1, pan: { x: 0, y: 0 } }, markers };
  for (let i = 0; i < WARMUP_ITERATIONS; i++) renderCrewRoom(input);
  const samples = [];
  for (let i = 0; i < SAMPLE_ITERATIONS; i++) {
    const start = performance.now();
    renderCrewRoom(input);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  return { median, p95, max: samples[samples.length - 1] };
}

async function main() {
  const results = [];
  for (const room of CREW_ROOMS) {
    for (const agentCount of AGENT_TIERS) {
      const stat = benchmarkRoom(room, agentCount);
      const jsBudget = BUDGET_FLOOR_MS * JS_BUDGET_FRACTION;
      const pass = stat.p95 <= jsBudget;
      results.push({ room: room.id, agentCount, ...stat, jsBudgetMs: jsBudget, pass });
    }
  }

  const header = ['sala', 'agentes', 'mediana(ms)', 'p95(ms)', 'max(ms)', 'presupuesto(ms)', 'estado'];
  const rows = results.map(r => [r.room, String(r.agentCount), r.median.toFixed(3), r.p95.toFixed(3),
    r.max.toFixed(3), r.jsBudgetMs.toFixed(3), r.pass ? 'OK' : 'FALLA']);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(row => row[i].length)));
  const printRow = cells => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(printRow(header));
  console.log(widths.map(w => '-'.repeat(w)).join('  '));
  for (const row of rows) console.log(printRow(row));

  const failed = results.filter(r => !r.pass);
  console.log('');
  console.log(`Objetivo 60 FPS: frame <= ${BUDGET_TARGET_MS.toFixed(2)}ms. Piso 30 FPS: frame <= ${BUDGET_FLOOR_MS.toFixed(2)}ms.`);
  console.log(`Presupuesto JS propuesto (${Math.round(JS_BUDGET_FRACTION * 100)}% del piso, reservando el resto para rasterizado/composicion del navegador): ${(BUDGET_FLOOR_MS * JS_BUDGET_FRACTION).toFixed(2)}ms.`);
  console.log(`${results.length - failed.length}/${results.length} combinaciones sala x agentes dentro del presupuesto propuesto.`);

  await mkdir('docs/crew/perf', { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    method: 'renderCrewRoom con contexto 2D no-op (sin rasterizado real); mide solo costo JS',
    budgets: { targetFpsMs: BUDGET_TARGET_MS, floorFpsMs: BUDGET_FLOOR_MS, jsBudgetMs: BUDGET_FLOOR_MS * JS_BUDGET_FRACTION },
    results,
  };
  await writeFile('docs/crew/perf/latest.json', JSON.stringify(report, null, 2) + '\n');
  console.log('\nReporte escrito en docs/crew/perf/latest.json');

  if (failed.length > 0) {
    console.error(`\n${failed.length} combinacion(es) superan el presupuesto JS propuesto.`);
    process.exitCode = 1;
  }
}

await main();
