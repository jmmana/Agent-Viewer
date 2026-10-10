import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountCrewScene } from '../../src/crew/crewSceneLifecycle';
import { CREW_ROOMS } from '../../src/crew/crewModel';
import { renderCrewRoom } from '../../src/crew/renderCrewRoom';

function fakeRaf() {
  let nextId = 1;
  const scheduled = new Map<number, FrameRequestCallback>();
  const raf = vi.fn((cb: FrameRequestCallback) => { const id = nextId++; scheduled.set(id, cb); return id; });
  const caf = vi.fn((id: number) => { scheduled.delete(id); });
  const flush = () => { const entries = [...scheduled.entries()]; scheduled.clear(); for (const [, cb] of entries) cb(0); };
  return { raf, caf, flush };
}

describe('Crew scene lifecycle (montar, actualizar, desmontar)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('monta y ejecuta un primer cuadro con la función de render inicial', () => {
    const { raf, caf, flush } = fakeRaf();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);
    vi.stubGlobal('ResizeObserver', undefined);
    const canvas = document.createElement('canvas');
    const render = vi.fn();
    const handle = mountCrewScene(canvas, render);
    expect(raf).toHaveBeenCalledTimes(1);
    flush();
    expect(render).toHaveBeenCalledTimes(1);
    handle.unmount();
    expect(caf).toHaveBeenCalledTimes(1);
  });

  it('actualizar reprograma el cuadro con la nueva función y cancela el anterior sin ejecutarlo', () => {
    const { raf, caf, flush } = fakeRaf();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);
    vi.stubGlobal('ResizeObserver', undefined);
    const canvas = document.createElement('canvas');
    const first = vi.fn();
    const handle = mountCrewScene(canvas, first);
    const second = vi.fn();
    handle.update(second);
    expect(caf).toHaveBeenCalledTimes(1);
    flush();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    handle.unmount();
  });

  it('desmontar cancela el cuadro pendiente y ningún cuadro posterior ejecuta render', () => {
    const { raf, caf, flush } = fakeRaf();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);
    vi.stubGlobal('ResizeObserver', undefined);
    const canvas = document.createElement('canvas');
    const render = vi.fn();
    const handle = mountCrewScene(canvas, render);
    handle.unmount();
    flush();
    expect(render).not.toHaveBeenCalled();
  });

  it('observa el tamaño del canvas y vuelve a dibujar en cada cambio, hasta desconectarse en unmount', () => {
    const { raf, caf, flush } = fakeRaf();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);
    let observedCallback: (() => void) | null = null;
    let observedElement: Element | null = null;
    let disconnected = false;
    class FakeResizeObserver {
      constructor(callback: () => void) { observedCallback = callback; }
      observe(element: Element) { observedElement = element; }
      disconnect() { disconnected = true; }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const canvas = document.createElement('canvas');
    const render = vi.fn();
    const onResize = vi.fn();
    const handle = mountCrewScene(canvas, render, onResize);
    flush();
    expect(observedElement).toBe(canvas);
    observedCallback!();
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(2);
    handle.unmount();
    expect(disconnected).toBe(true);
  });

  it('cuando no existe ResizeObserver (jsdom) la escena igual monta y desmonta sin fallar', () => {
    const { raf, caf, flush } = fakeRaf();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);
    vi.stubGlobal('ResizeObserver', undefined);
    const canvas = document.createElement('canvas');
    const render = vi.fn();
    expect(() => {
      const handle = mountCrewScene(canvas, render);
      flush();
      handle.unmount();
    }).not.toThrow();
  });

  it('ciclo de vida completo de una escena Crew real: montar dibuja la sala, actualizar cambia de sala, desmontar detiene el dibujo', () => {
    const { raf, caf, flush } = fakeRaf();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);
    vi.stubGlobal('ResizeObserver', undefined);
    const canvas = document.createElement('canvas');
    const draws: Array<{ roomId: string; rects: number }> = [];
    let roomId = CREW_ROOMS[0].id;
    const makeRender = () => () => {
      const room = CREW_ROOMS.find(r => r.id === roomId)!;
      let rects = 0;
      const ctx = new Proxy({} as CanvasRenderingContext2D, {
        get(_target, key) {
          if (key === 'fillRect') return () => { rects += 1; };
          return () => {};
        },
        set() { return true; },
      });
      renderCrewRoom({ ctx, width: 900, height: 600, room, camera: { view: 'front', zoom: 1, pan: { x: 0, y: 0 } } });
      draws.push({ roomId, rects });
    };
    const handle = mountCrewScene(canvas, makeRender());
    flush();
    expect(draws).toEqual([{ roomId: 'ceo', rects: 1 }]);

    roomId = CREW_ROOMS[1].id;
    handle.update(makeRender());
    flush();
    expect(draws).toEqual([{ roomId: 'ceo', rects: 1 }, { roomId: 'development', rects: 1 }]);

    handle.unmount();
    flush();
    expect(draws).toHaveLength(2);
  });
});
