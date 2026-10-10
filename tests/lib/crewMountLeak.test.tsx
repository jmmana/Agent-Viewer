import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { CrewStage } from '../../src/crew/CrewStage';
import { CREW_ROOMS } from '../../src/crew/crewModel';

/**
 * Fugas de memoria al cambiar de sala repetidamente (issue #158).
 *
 * El renderer Crew no corre un bucle continuo de requestAnimationFrame: pinta
 * una vez por montaje y por cada cambio de estado relevante (ver
 * `src/crew/CrewStage.tsx`). Esto hace que la fuga tipica de este tipo de
 * escena no sea "FPS que cae", sino que un `requestAnimationFrame` o un
 * listener de una sala desmontada sigan vivos y se acumulen al cambiar de
 * sala muchas veces. Esta prueba monta y desmonta la escena Crew 100 veces,
 * recorriendo las once salas del catalogo, y verifica con temporizadores
 * falsos que no queda ningun `requestAnimationFrame` pendiente tras cada
 * desmontaje y que los listeners de `window`/`document` quedan balanceados
 * (tantas altas como bajas) al terminar el ciclo completo.
 */
const MOUNT_CYCLES = 100;

describe('Ciclo de montaje/desmontaje de salas Crew #158', () => {
  let windowAdds = 0, windowRemoves = 0, documentAdds = 0, documentRemoves = 0;

  beforeEach(() => {
    windowAdds = windowRemoves = documentAdds = documentRemoves = 0;
    const originalWindowAdd = window.addEventListener.bind(window);
    const originalWindowRemove = window.removeEventListener.bind(window);
    const originalDocumentAdd = document.addEventListener.bind(document);
    const originalDocumentRemove = document.removeEventListener.bind(document);
    vi.spyOn(window, 'addEventListener').mockImplementation((...args: Parameters<Window['addEventListener']>) => {
      windowAdds++;
      return originalWindowAdd(...args);
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation((...args: Parameters<Window['removeEventListener']>) => {
      windowRemoves++;
      return originalWindowRemove(...args);
    });
    vi.spyOn(document, 'addEventListener').mockImplementation((...args: Parameters<Document['addEventListener']>) => {
      // React adjunta su propio listener global de 'selectionchange' a `document` una
      // sola vez por documento (no por componente) la primera vez que monta un campo
      // controlado; no se libera entre pruebas y no pertenece al ciclo de vida de
      // CrewStage, asi que se excluye del conteo de fugas de esta escena.
      if (args[0] !== 'selectionchange') documentAdds++;
      return originalDocumentAdd(...args);
    });
    vi.spyOn(document, 'removeEventListener').mockImplementation((...args: Parameters<Document['removeEventListener']>) => {
      if (args[0] !== 'selectionchange') documentRemoves++;
      return originalDocumentRemove(...args);
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('no acumula requestAnimationFrame ni listeners tras 100 cambios de sala/camara', () => {
    const baselineTimers = vi.getTimerCount();
    for (let cycle = 0; cycle < MOUNT_CYCLES; cycle++) {
      const room = CREW_ROOMS[cycle % CREW_ROOMS.length];
      const { unmount } = render(
        <CrewStage locale="es" selectedRoomId={room.id} persistCamera={false} showRoomLink={false} idPrefix={`perf-${cycle}`} />,
      );
      // Una escena recien montada solo tiene su requestAnimationFrame de primer pintado pendiente.
      expect(vi.getTimerCount()).toBe(baselineTimers + 1);
      unmount();
      // Al desmontar, ese requestAnimationFrame se cancela: no debe quedar ninguno pendiente.
      expect(vi.getTimerCount()).toBe(baselineTimers);
    }
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
    expect(windowAdds).toBe(windowRemoves);
    expect(documentAdds).toBe(documentRemoves);
    expect(windowAdds).toBeGreaterThan(0);
    expect(documentAdds).toBeGreaterThan(0);
  });

  it('nunca muestra mas de un canvas a la vez mientras cambia de sala', () => {
    let roomId = CREW_ROOMS[0].id;
    const { rerender, unmount } = render(<CrewStage locale="es" selectedRoomId={roomId} persistCamera={false} showRoomLink={false} />);
    for (const room of CREW_ROOMS) {
      roomId = room.id;
      rerender(<CrewStage locale="es" selectedRoomId={roomId} persistCamera={false} showRoomLink={false} />);
      expect(document.querySelectorAll('canvas')).toHaveLength(1);
    }
    unmount();
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
  });
});
