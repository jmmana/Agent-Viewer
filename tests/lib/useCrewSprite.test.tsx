import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCrewSprite } from '../../src/crew/useCrewSprite';

vi.mock('../../src/crew/sprites/ceo-phone-front', () => ({ default: '/fixture-phone-front.png' }));

function fakeImage() {
  return { naturalWidth: 256, naturalHeight: 352, src: '', onload: null as (() => void) | null,
    onerror: null, removeAttribute: vi.fn() } as unknown as HTMLImageElement;
}

describe('useCrewSprite: pose de teléfono del CEO (#145)', () => {
  it('con phoneCall y vista front, usa la URL de ceo-phone-front en vez de la pose normal', async () => {
    const createImage = vi.fn(fakeImage);
    const originalImage = globalThis.Image;
    globalThis.Image = createImage;
    try {
      const { result, rerender } = renderHook(({ phoneCall }: { phoneCall: boolean }) => useCrewSprite('front', phoneCall),
        { initialProps: { phoneCall: true } });
      await waitFor(() => expect(createImage).toHaveBeenCalledTimes(1));
      const created = createImage.mock.results.at(-1)?.value as HTMLImageElement | undefined;
      expect(created?.src).toBe('/fixture-phone-front.png');
      act(() => { created!.onload!(new Event('load') as never); });
      expect(result.current.image).toBe(created);
      // Al dejar de estar en llamada, vuelve a cargar la pose normal (otra URL, no la de teléfono).
      rerender({ phoneCall: false });
      await waitFor(() => expect(createImage).toHaveBeenCalledTimes(2));
      const createdAfter = createImage.mock.results.at(-1)?.value as HTMLImageElement | undefined;
      expect(createdAfter?.src).not.toBe('/fixture-phone-front.png');
    } finally {
      globalThis.Image = originalImage;
    }
  });

  it('phoneCall no afecta otras vistas: right/back/left nunca importan el módulo de teléfono', async () => {
    const createImage = vi.fn(fakeImage);
    const originalImage = globalThis.Image;
    globalThis.Image = createImage;
    try {
      renderHook(() => useCrewSprite('right', true));
      await waitFor(() => expect(createImage).toHaveBeenCalledTimes(1));
      const created = createImage.mock.results.at(-1)?.value as HTMLImageElement | undefined;
      expect(created?.src).not.toBe('/fixture-phone-front.png');
    } finally {
      globalThis.Image = originalImage;
    }
  });
});
