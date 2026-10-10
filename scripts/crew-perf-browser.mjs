#!/usr/bin/env node
/**
 * Captura informativa de FPS pintados y memoria de heap en Chromium real
 * (issue #158). Complementa a `scripts/crew-perf-benchmark.mjs`, que solo
 * mide el costo JS puro con un contexto 2D no-op.
 *
 * Requiere el servidor de desarrollo activo (`npm run dev`) en
 * http://127.0.0.1:3000 (o CREW_CAPTURE_URL) y Chromium instalado para
 * Playwright. No se ejecuta en CI: los numeros de un navegador headless
 * varian segun la maquina y no son una compuerta de regresion fiable: se
 * documentan como referencia, se ejecutan a mano y se pegan en el PR.
 *
 * Uso: npm run dev (en otra terminal) y luego node scripts/crew-perf-browser.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const BASE_URL = process.env.CREW_CAPTURE_URL || 'http://127.0.0.1:3000';
const ROOMS = ['ceo', 'development', 'planning', 'research', 'qa', 'finance', 'meeting',
  'infrastructure', 'coffee', 'lounge', 'reception'];
const PAN_DURATION_MS = 2000;
const MOUNT_CYCLES = 100;

async function openCrew(page) {
  await page.goto(BASE_URL, { waitUntil: 'load' });
  await page.getByRole('button', { name: 'Crew · Beta', exact: true }).click();
  await page.locator('canvas').first().waitFor({ state: 'visible' });
}

/** Cuenta cuadros realmente pintados contando llamadas a getContext('2d') mientras se mueve la camara. */
async function measurePannedFps(page, roomId) {
  await page.locator('#crew-room').selectOption(roomId);
  await page.waitForTimeout(150);
  const frames = await page.evaluate(async durationMs => {
    let count = 0;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function patched(...args) {
      if (args[0] === '2d') count++;
      return original.apply(this, args);
    };
    const canvas = document.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const start = performance.now();
    let angle = 0;
    await new Promise(resolve => {
      function tick() {
        angle += 0.12;
        const event = new WheelEvent('wheel', {
          clientX: rect.left + rect.width / 2 + Math.sin(angle) * 40,
          clientY: rect.top + rect.height / 2 + Math.cos(angle) * 40,
          deltaY: Math.sin(angle * 3) * 12,
          bubbles: true, cancelable: true,
        });
        canvas.dispatchEvent(event);
        if (performance.now() - start < durationMs) requestAnimationFrame(tick);
        else resolve(undefined);
      }
      requestAnimationFrame(tick);
    });
    HTMLCanvasElement.prototype.getContext = original;
    return { count, elapsedMs: performance.now() - start };
  }, PAN_DURATION_MS);
  return { fps: frames.count / (frames.elapsedMs / 1000), frames: frames.count, elapsedMs: frames.elapsedMs };
}

async function heapSize(page) {
  return page.evaluate(() => (performance).memory ? performance.memory.usedJSHeapSize : null);
}

async function forceGc(client) {
  try { await client.send('HeapProfiler.collectGarbage'); } catch { /* no disponible fuera de Chromium */ }
}

async function main() {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  try { await client.send('HeapProfiler.enable'); } catch { /* no disponible */ }

  await openCrew(page);
  const fpsResults = [];
  for (const roomId of ROOMS) {
    const sample = await measurePannedFps(page, roomId);
    fpsResults.push({ room: roomId, ...sample });
    console.log(`FPS pintados (${roomId}): ${sample.fps.toFixed(1)} (${sample.frames} cuadros en ${sample.elapsedMs.toFixed(0)}ms)`);
  }

  console.log('\nCiclo de montaje/desmontaje: cambia de sala 100 veces y mide heap cada 10 ciclos.');
  await forceGc(client);
  const heapSamples = [{ cycle: 0, heap: await heapSize(page) }];
  for (let i = 1; i <= MOUNT_CYCLES; i++) {
    const roomId = ROOMS[i % ROOMS.length];
    await page.locator('#crew-room').selectOption(roomId);
    await page.waitForTimeout(20);
    if (i % 10 === 0) {
      await forceGc(client);
      const heap = await heapSize(page);
      heapSamples.push({ cycle: i, heap });
      console.log(`Ciclo ${i}: heap=${heap === null ? 'no disponible' : (heap / 1024 / 1024).toFixed(2) + 'MB'}`);
    }
  }

  const validHeap = heapSamples.filter(s => s.heap !== null).map(s => s.heap);
  const heapGrowth = validHeap.length >= 2 ? validHeap[validHeap.length - 1] - validHeap[0] : null;
  const canvasCount = await page.locator('canvas').count();

  await mkdir('docs/crew/perf', { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    fpsResults,
    heapSamples,
    heapGrowthBytes: heapGrowth,
    canvasCountAfterCycles: canvasCount,
    caveats: 'performance.memory es una aproximacion de Chromium; los numeros varian segun la maquina y la carga del proceso. No es una compuerta de CI.',
  };
  await writeFile('docs/crew/perf/browser-latest.json', JSON.stringify(report, null, 2) + '\n');
  console.log(`\nCanvas visibles al terminar: ${canvasCount} (se espera 1).`);
  if (heapGrowth !== null) console.log(`Crecimiento de heap entre ciclo 0 y ${MOUNT_CYCLES}: ${(heapGrowth / 1024 / 1024).toFixed(2)}MB.`);
  console.log('Reporte escrito en docs/crew/perf/browser-latest.json');

  await browser.close();
}

await main();
