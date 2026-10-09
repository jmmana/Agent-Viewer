/// <reference types="vite/client" />
import type { FurnitureItem } from './officeModel';
import manifest from '../../assets/asset-manifest.json';

interface FurnitureArtwork {
  id: string;
  kind: string;
  file: string;
  logicalSize: { width: number; height: number };
  anchor: { x: number; y: number };
}

interface ImageEntry {
  image: HTMLImageElement;
  state: 'pending' | 'ready' | 'failed';
}

/**
 * Hand-picked substitutions for existing production-office objects.
 * Keep their original coordinates and collision footprint; never place
 * a second desk/monitor over an operational workstation.
 */
export const DEVELOPMENT_ARTWORK: Readonly<Record<string, { assetId: string; width: number }>> = {
  f_dev_kanban: { assetId: 'furniture.kanban-board', width: 78 },
  f_dev_palm: { assetId: 'furniture.plant-floor', width: 43 },
  f_dev_snake_1: { assetId: 'furniture.plant-floor', width: 36 },
  f_dev_lamp: { assetId: 'furniture.desk-lamp', width: 35 },
};

const importedUrls = import.meta.glob<string>('../../assets/furniture/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
});
const urlsByFile = Object.fromEntries(
  Object.entries(importedUrls).map(([path, url]) => [path.replace('../../', ''), url]),
);

/**
 * Per-canvas asynchronous SVG image cache. Missing/pending/failed imagery returns
 * false, so the existing procedural furniture can render as a safe fallback.
 * This is presentation-only: it does not modify navigation or agent events.
 */
export class OfficeFurnitureAssets {
  private readonly images = new Map<string, ImageEntry>();
  private disposed = false;

  constructor(
    private readonly assets: readonly FurnitureArtwork[] = manifest.assets,
    private readonly urls: Readonly<Record<string, string>> = urlsByFile,
    private readonly createImage: () => HTMLImageElement = () => new Image(),
  ) {}

  draw(
    ctx: CanvasRenderingContext2D,
    item: Pick<FurnitureItem, 'id'>,
    tileX: number,
    tileY: number,
    tileSize: number,
  ): boolean {
    if (this.disposed) return false;
    const variant = DEVELOPMENT_ARTWORK[item.id];
    if (!variant) return false;
    const asset = this.assets.find(a => a.id === variant.assetId && a.kind === 'furniture');
    if (!asset || asset.logicalSize.width <= 0 || asset.logicalSize.height <= 0) return false;

    let entry = this.images.get(asset.file);
    if (!entry) {
      const url = this.urls[asset.file];
      if (!url) return false;
      let image: HTMLImageElement;
      try {
        image = this.createImage();
      } catch {
        return false;
      }
      entry = { image, state: 'pending' };
      const tracked = entry;
      image.onload = () => {
        if (!this.disposed) tracked.state = image.naturalWidth > 0 ? 'ready' : 'failed';
      };
      image.onerror = () => {
        tracked.state = 'failed';
      };
      this.images.set(asset.file, entry);
      try { image.src = url; } catch { tracked.state = 'failed'; }
    }
    if (entry.state !== 'ready') return false;

    // Art is anchored to the current tile; coordinates and collision remain authoritative
    // in OFFICE_FURNITURE.  Height derives from the SVG aspect ratio rather than stretching.
    const width = Math.min(variant.width, tileSize * 1.65);
    const height = width * asset.logicalSize.height / asset.logicalSize.width;
    const groundX = tileX + tileSize * 0.5;
    const groundY = tileY + tileSize;
    const x = groundX - width * asset.anchor.x;
    const y = groundY - height * asset.anchor.y;
    try {
      ctx.drawImage(entry.image, x, y, width, height);
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const { image } of this.images.values()) {
      image.onload = null;
      image.onerror = null;
    }
    this.images.clear();
  }
}
