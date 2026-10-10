import { describe, expect, it } from 'vitest';
import { CREW_ROOMS } from '../../src/crew/crewModel';
import { renderCrewRoom, type CrewRenderInput } from '../../src/crew/renderCrewRoom';
import type { CrewPresenceMarker } from '../../src/crew/crewPresence';

/**
 * Compuerta de regresion de rendimiento para el renderer Crew (issue #158).
 *
 * Mide el costo JS puro de `renderCrewRoom` (proyeccion isometrica, orden por
 * profundidad y recorrido de mobiliario/marcadores) con un contexto 2D
 * no-op, para separar ese costo del rasterizado real del navegador. No mide
 * FPS pintados ni memoria de heap: ese reporte, mas amplio y con numeros
 * reales de Chromium, vive en `scripts/crew-perf-benchmark.mjs` (las once
 * salas x 0/6/20/50 agentes) y en `scripts/crew-perf-browser.mjs` (FPS
 * pintados y heap en un navegador real). Ver docs/crew/PERFORMANCE.md.
 *
 * Umbral propuesto (el issue no fija un numero para este costo puro): 8ms,
 * un cuarto del piso de 30 FPS (33.3ms), dejando el resto del presupuesto de
 * cuadro para rasterizado y composicion reales. Si esta prueba falla, algo
 * volvio el render de una sala mas costoso que un recorrido lineal de su
 * mobiliario y marcadores (por ejemplo, un costo cuadrático accidental).
 */
const JS_FRAME_BUDGET_MS = 8;
const WORST_CASE_AGENT_COUNT = 50;

function makeMarkers(count: number): CrewPresenceMarker[] {
  const facings = ['SE', 'SW', 'NW', 'NE'] as const;
  return Array.from({ length: count }, (_, i) => ({
    id: `perf-${i}`,
    name: `Perf ${i}`,
    role: i % 3 === 0 ? 'boss' as const : 'custom' as const,
    facing: facings[i % facings.length],
    status: 'IDLE' as const,
    x: (i % 10) + 0.5,
    y: Math.floor(i / 10) + 0.5,
    number: i + 1,
  }));
}

function noopContext(): CanvasRenderingContext2D {
  return new Proxy({}, { get: () => () => {}, set: () => true }) as CanvasRenderingContext2D;
}

describe('Presupuesto de rendimiento del renderer Crew #158', () => {
  it.each(CREW_ROOMS.map(room => room.id))('%s se mantiene bajo el presupuesto JS con 50 agentes', roomId => {
    const room = CREW_ROOMS.find(r => r.id === roomId)!;
    const input: CrewRenderInput = {
      ctx: noopContext(), width: 1280, height: 800, room,
      camera: { view: 'front', zoom: 1, pan: { x: 0, y: 0 } },
      markers: makeMarkers(WORST_CASE_AGENT_COUNT),
    };
    for (let i = 0; i < 5; i++) renderCrewRoom(input); // calentamiento del JIT
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      renderCrewRoom(input);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    expect(median).toBeLessThan(JS_FRAME_BUDGET_MS);
  });

  it('el costo no crece de forma acelerada entre 0 y 50 agentes (sin O(n^2) accidental)', () => {
    const room = CREW_ROOMS.find(r => r.id === 'development')!;
    const costFor = (count: number) => {
      const input: CrewRenderInput = {
        ctx: noopContext(), width: 1280, height: 800, room,
        camera: { view: 'front', zoom: 1, pan: { x: 0, y: 0 } }, markers: makeMarkers(count),
      };
      for (let i = 0; i < 5; i++) renderCrewRoom(input);
      const samples: number[] = [];
      for (let i = 0; i < 30; i++) {
        const start = performance.now();
        renderCrewRoom(input);
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      return samples[Math.floor(samples.length / 2)];
    };
    const at0 = Math.max(costFor(0), 0.001);
    const at50 = costFor(50);
    // Un recorrido lineal con 50 marcadores no deberia ser mas de 50x el costo base;
    // un margen generoso de 400x solo atrapa una regresion algoritmica real.
    expect(at50).toBeLessThan(at0 * 400 + JS_FRAME_BUDGET_MS);
  });
});
