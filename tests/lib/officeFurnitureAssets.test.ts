import { describe, expect, it, vi } from 'vitest';
import { DEVELOPMENT_ARTWORK, OfficeFurnitureAssets } from '../../src/engine/officeFurnitureAssets';

const props = [
  { id: 'f_dev_kanban', file: 'assets/furniture/kanban-board.svg', width: 150, height: 116 },
  { id: 'f_dev_palm', file: 'assets/furniture/plant-floor.svg', width: 72, height: 102 },
  { id: 'f_dev_lamp', file: 'assets/furniture/desk-lamp.svg', width: 58, height: 70 },
];
const manifest = props.map(item => ({
  id: DEVELOPMENT_ARTWORK[item.id].assetId,
  kind: 'furniture',
  file: item.file,
  logicalSize: { width: item.width, height: item.height },
  anchor: { x: 0.5, y: 0.93 },
}));

function harness() {
  const images: HTMLImageElement[] = [];
  const factory = vi.fn(() => {
    const image = { src: '', naturalWidth: 72, onload: null, onerror: null } as unknown as HTMLImageElement;
    images.push(image);
    return image;
  });
  const urls = Object.fromEntries(props.map(p => [p.file, 'data:image/svg+xml,' + p.id]));
  const assets = new OfficeFurnitureAssets(manifest, urls, factory);
  const drawImage = vi.fn();
  const ctx = { drawImage } as unknown as CanvasRenderingContext2D;
  const draw = (id: string, x = 360, y = 336) => assets.draw(ctx, { id }, x, y, 48);
  return { images, factory, assets, drawImage, ctx, draw };
}

describe('Illustrated development furniture', () => {
  it('starts with procedural fallback while art loads, then draws at the existing tile', () => {
    const h = harness();
    expect(h.draw('f_dev_kanban')).toBe(false);
    expect(h.images).toHaveLength(1);
    expect(h.draw('f_dev_kanban')).toBe(false);
    expect(h.factory).toHaveBeenCalledTimes(1);
    h.images[0].onload?.call(h.images[0], new Event('load'));
    expect(h.draw('f_dev_kanban')).toBe(true);
    const [image, x, y, width, height] = h.drawImage.mock.lastCall!;
    expect(image).toBe(h.images[0]);
    expect(width).toBeCloseTo(78);
    expect(height).toBeCloseTo(78 * 116 / 150);
    expect(x + width / 2).toBeCloseTo(384);
    expect(y + height * 0.93).toBeCloseTo(384);
  });

  it('reuses the same plant SVG for two actual furniture placements', () => {
    const h = harness();
    expect(h.draw('f_dev_palm')).toBe(false);
    expect(h.draw('f_dev_snake_1')).toBe(false);
    expect(h.factory).toHaveBeenCalledTimes(1);
    h.images[0].onload?.call(h.images[0], new Event('load'));
    expect(h.draw('f_dev_palm')).toBe(true);
    const palmWidth = h.drawImage.mock.lastCall![3];
    expect(h.draw('f_dev_snake_1')).toBe(true);
    expect(h.drawImage.mock.lastCall![3]).toBeLessThan(palmWidth);
  });

  it('keeps all workstations and unknown pieces procedural', () => {
    const h = harness();
    for (const id of ['f_backend_desk', 'f_frontend_desk', 'f_sec_desk', 'f_dev_dock', 'f_boss_desk']) {
      expect(h.draw(id)).toBe(false);
    }
    expect(h.images).toHaveLength(0);
    expect(Object.keys(DEVELOPMENT_ARTWORK)).toHaveLength(4);
  });

  it('falls back on unavailable or failed image and detaches handlers when disposed', () => {
    const h = harness();
    expect(h.draw('f_dev_lamp')).toBe(false);
    h.images[0].onerror?.call(h.images[0], new Event('error'));
    expect(h.draw('f_dev_lamp')).toBe(false);
    expect(h.factory).toHaveBeenCalledTimes(1);
    h.assets.dispose();
    expect(h.draw('f_dev_lamp')).toBe(false);
    expect(h.images.every(i => i.onload === null && i.onerror === null)).toBe(true);
    expect(h.drawImage).not.toHaveBeenCalled();
  });
});
