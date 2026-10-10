import { describe, expect, it, vi } from 'vitest';
import { CREW_CALL_ICON_SIZE, loadCrewCallIcon } from '../../src/crew/crewCallIcon';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const fakeImage = (width: number, height: number) => ({ naturalWidth: width, naturalHeight: height, src: '',
  onload: null, onerror: null, removeAttribute: vi.fn() }) as unknown as HTMLImageElement;

describe('Icono de llamada Crew (#145): carga real del banco con respaldo vectorial', () => {
  it('carga el icono con las dimensiones reales del SVG del banco', async () => {
    const image = fakeImage(CREW_CALL_ICON_SIZE.width, CREW_CALL_ICON_SIZE.height);
    const ready = vi.fn(), failed = vi.fn(), url = vi.fn(async () => '/fixture-call.svg');
    const stop = loadCrewCallIcon(ready, failed, url, () => image);
    await flush();
    expect(url).toHaveBeenCalledOnce();
    expect(image.src).toBe('/fixture-call.svg');
    image.onload!(new Event('load'));
    expect(ready).toHaveBeenCalledExactlyOnceWith(image);
    expect(failed).not.toHaveBeenCalled();
    stop();
    expect(image.onload).toBeNull();
  });

  it('reporta el fallo (fallback vectorial del llamador) si el recurso no está disponible', async () => {
    const failed = vi.fn();
    loadCrewCallIcon(vi.fn(), failed, async () => { throw new Error('offline'); });
    await flush(); await flush();
    expect(failed).toHaveBeenCalledOnce();
  });

  it('conserva el aviso de respaldo si las dimensiones no coinciden con el original del banco', async () => {
    const image = fakeImage(1, 1);
    const ready = vi.fn(), failed = vi.fn();
    loadCrewCallIcon(ready, failed, async () => '/bad.svg', () => image);
    await flush();
    image.onload!(new Event('load'));
    expect(ready).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledOnce();
  });
});
