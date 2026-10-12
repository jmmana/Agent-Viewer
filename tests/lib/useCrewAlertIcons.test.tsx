import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCrewAlertIcons } from '../../src/crew/useCrewAlertIcons';
import { crewSharedImageCache } from '../../src/crew/crewAssetCache';
import { CREW_ALERT_ICON_SIZE } from '../../src/crew/crewAlertIcon';
import type { CrewAlertIconName } from '../../src/crew/crewAlertBridge';

const ICON_NAMES: readonly CrewAlertIconName[] = ['wifi', 'check', 'blocked', 'tool', 'thought', 'alert', 'sync', 'terminal'];

/**
 * `useCrewAlertIcons` (#153) carga los 8 iconos del catálogo de alertas Crew una sola vez,
 * compartidos por toda la escena: a diferencia de `useCrewCallIcon` (un solo icono de
 * llamada), aquí hacen falta todos a la vez porque agentes distintos pueden tener alertas
 * de tipo distinto activas al mismo tiempo. Reutiliza `loadCrewAlertIcon`/
 * `crewSharedImageCache` sin reimplementar la carga (#158).
 */
describe('useCrewAlertIcons (#153): carga compartida de los 8 iconos de alerta', () => {
  afterEach(() => { crewSharedImageCache.clear(); });

  it('carga y expone los 8 iconos reales del banco, cada uno bajo su propio nombre', async () => {
    // `function`, no arrow: `vi.fn()` solo soporta `new` sobre funciones/clases reales
    // (igual que `useCrewPropImages.test.tsx`).
    const created: HTMLImageElement[] = [];
    function fakeIconImage() {
      const image = {
        naturalWidth: 0, naturalHeight: 0, src: '',
        onload: null as (() => void) | null, onerror: null as (() => void) | null, removeAttribute: vi.fn(),
      } as unknown as HTMLImageElement;
      created.push(image);
      return image;
    }
    const originalImage = globalThis.Image;
    globalThis.Image = vi.fn(fakeIconImage) as unknown as typeof Image;
    try {
      const { result } = renderHook(() => useCrewAlertIcons());
      // La carga real usa `import()` dinámico por icono (igual que `crewAlertIcon.test.ts`):
      // puede tardar más de un par de microtareas en resolver los 8 a la vez.
      await waitFor(() => expect(created.length).toBe(ICON_NAMES.length), { timeout: 2000 });

      act(() => {
        for (const image of created) {
          (image as { naturalWidth: number }).naturalWidth = CREW_ALERT_ICON_SIZE.width;
          (image as { naturalHeight: number }).naturalHeight = CREW_ALERT_ICON_SIZE.height;
          image.onload!(new Event('load'));
        }
      });

      await waitFor(() => {
        for (const name of ICON_NAMES) expect(result.current.images[name]).toBeDefined();
      });
      // Cada icono resuelve a un recurso real y distinto del banco (en el entorno de
      // pruebas, el SVG real inlined como data URI); nunca los 8 comparten la misma fuente.
      const sources = ICON_NAMES.map(name => result.current.images[name]!.src);
      for (const src of sources) expect(src.startsWith('data:image/svg+xml')).toBe(true);
      expect(new Set(sources).size).toBe(ICON_NAMES.length);
      expect(result.current.failed).toEqual({});
    } finally {
      globalThis.Image = originalImage;
    }
  });

  it('reporta el fallo por icono sin bloquear la carga de los demás', async () => {
    const created: HTMLImageElement[] = [];
    // Dimensión 1x1 nunca coincide con `CREW_ALERT_ICON_SIZE` (40x40): cada carga falla
    // al disparar `onload`, sin tirar abajo el render ni dejar el hook a medias.
    function fakeMismatchedImage() {
      const image = {
        naturalWidth: 1, naturalHeight: 1, src: '',
        onload: null as (() => void) | null, onerror: null as (() => void) | null, removeAttribute: vi.fn(),
      } as unknown as HTMLImageElement;
      created.push(image);
      return image;
    }
    const originalImage = globalThis.Image;
    globalThis.Image = vi.fn(fakeMismatchedImage) as unknown as typeof Image;
    try {
      const { result } = renderHook(() => useCrewAlertIcons());
      await waitFor(() => expect(created.length).toBe(ICON_NAMES.length), { timeout: 2000 });
      act(() => { for (const image of created) image.onload!(new Event('load')); });
      await waitFor(() => {
        for (const name of ICON_NAMES) expect(result.current.failed[name]).toBe(true);
      });
      expect(result.current.images).toEqual({});
    } finally {
      globalThis.Image = originalImage;
    }
  });
});
