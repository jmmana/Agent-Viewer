import { describe, expect, it, vi } from 'vitest';
import { OfficeCrewAssets, crewClip, crewDrawBounds, crewFacing, crewFrameIndex, crewRole, type CrewAsset } from '../../src/engine/officeCrewAssets';
import { buildOfficeSnapshot } from '../../src/lib/officeStore';
import { registered, T0 } from './fixtures';
import { findOfficeAgentAtPoint, renderOfficeScene } from '../../src/engine/canvasRenderer';
import { gridToScreen } from '../../src/engine/officeModel';
import { cameraCenter } from '../../src/engine/visualLayout';
import { createOfficeTranslator } from '../../src/content/officeMessages';

const agent = () => ({ ...buildOfficeSnapshot([registered('ceo', 'CEO')], { mode: 'professional', now: T0 }).agents[0], role: 'boss' as const, facing: 'SW' as const });
const asset = (clip = 'idle', extras: Partial<CrewAsset> = {}): CrewAsset => ({
  id: `character.ceo.${clip}.front`, kind: 'character', role: 'ceo', clip, facing: 'front',
  file: `assets/characters/ceo/${clip}-front.svg`, logicalSize: { width: 64, height: 88 },
  anchor: { x: 0.5, y: 0.94 }, frames: 1, fps: 0, loop: false, ...extras,
});

function harness(assets: CrewAsset[]) {
  const images: HTMLImageElement[] = [];
  const urls = Object.fromEntries(assets.flatMap(a => (a.frameFiles ?? [a.file]).map(file => [file, `data:test/${file}`])));
  const factory = vi.fn(() => {
    const image = { src: '', naturalWidth: 64, onload: null, onerror: null } as unknown as HTMLImageElement;
    images.push(image);
    return image;
  });
  const cache = new OfficeCrewAssets(assets, urls, factory);
  const drawImage = vi.fn();
  const ctx = { drawImage } as unknown as CanvasRenderingContext2D;
  const draw = (time = 0, changed = {}, reducedMotion = false) => cache.draw(ctx, { ...agent(), ...changed }, 0, 120, 200, time, T0, reducedMotion);
  const load = () => images.forEach(image => image.onload?.call(image, new Event('load')));
  return { cache, ctx, draw, drawImage, images, factory, load };
}

describe('Office Crew sprite loading and projection', () => {
  it('keeps labels and speech cards clear of the complete sprite at different zooms', () => {
    const h = harness([asset()]);
    h.draw(); h.load();
    const speaking = { ...agent(), x: 5, y: 5, speechBubble: { text: 'SPRITE SPEECH', expiresAt: T0 + 5000 } };
    for (const zoom of [0.6, 1, 1.8]) {
      const cards = new Map<string, { x: number; y: number; width: number; height: number }>();
      let currentRect = { x: 0, y: 0, width: 0, height: 0 };
      const ctx = new Proxy({} as CanvasRenderingContext2D, {
        get(_target, property) {
          if (property === 'roundRect') return (x: number, y: number, width: number, height: number) => { currentRect = { x, y, width, height }; };
          if (property === 'fillText') return (text: string) => cards.set(text, { ...currentRect });
          if (property === 'measureText') return (text: string) => ({ width: text.length * 6 });
          if (property === 'createLinearGradient' || property === 'createRadialGradient') return () => ({ addColorStop() {} });
          return () => undefined;
        },
        set() { return true; },
      });
      renderOfficeScene({ ctx, agents: [speaking], camera: { x: -100, y: -100, rotation: 0, zoom },
        width: 1400, height: 1000, selectedAgentId: speaking.id, hoveredAgentId: null, activeMeetingId: null,
        timeMs: 100, nowMs: T0, theme: 'dark', crewAssets: h.cache,
        translate: createOfficeTranslator({ messages: { 'role.boss': 'SPRITE LABEL' } }),
      });
      const world = h.cache.boundsFor(speaking.id)!;
      const center = cameraCenter(1400, 1000);
      const sprite = { x: center.x + (world.x - 100) * zoom, y: center.y + (world.y - 100) * zoom,
        width: world.width * zoom, height: world.height * zoom };
      for (const text of ['SPRITE LABEL', 'SPRITE SPEECH']) {
        const card = cards.get(text)!;
        expect(card, text).toBeDefined();
        const overlaps = card.x < sprite.x + sprite.width && card.x + card.width > sprite.x
          && card.y < sprite.y + sprite.height && card.y + card.height > sprite.y;
        expect(overlaps, `${text} at zoom ${zoom}`).toBe(false);
      }
    }
  });

  it('uses the whole drawn sprite for pointer hits, including its top corners and visual crowd offsets', () => {
    const h = harness([asset()]);
    h.draw(); h.load();
    const a = agent();
    const { x, y } = gridToScreen(a.x, a.y, 0);
    h.cache.draw(h.ctx, a, 0, x + 29, y + 39, 100, T0); // position includes a crowd offset
    const bounds = h.cache.boundsFor(a.id)!;
    expect(findOfficeAgentAtPoint([a], 0, bounds.x + 1, bounds.y + 1, h.cache)?.id).toBe(a.id);
    expect(findOfficeAgentAtPoint([a], 0, bounds.x + bounds.width - 1, bounds.y + bounds.height - 1, h.cache)?.id).toBe(a.id);
    expect(findOfficeAgentAtPoint([a], 0, bounds.x - 1, bounds.y, h.cache)).toBeNull();
    // Disposal restores the original geometry; the artwork's upper left is beyond its old radius.
    h.cache.dispose();
    expect(findOfficeAgentAtPoint([a], 0, bounds.x + 1, bounds.y + 1, h.cache)).toBeNull();
    expect(findOfficeAgentAtPoint([a], 0, x + 24, y + 8)?.id).toBe(a.id);
  });

  it('resolves real runtime PNG imports through Vite without including vector studies or source artwork', () => {
    const runtime = asset('idle', { file: 'assets/characters/ceo/idle-front.png' });
    const image = { src: '', naturalWidth: 192, onload: null, onerror: null } as unknown as HTMLImageElement;
    const factory = vi.fn(() => image);
    // Leave URLs undefined to exercise the actual Vite glob rather than the synthetic harness URLs.
    const cache = new OfficeCrewAssets([runtime], undefined, factory);
    const drawImage = vi.fn();
    const ctx = { drawImage } as unknown as CanvasRenderingContext2D;
    expect(cache.draw(ctx, agent(), 0, 120, 200, 0, T0)).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(image.src).toMatch(/(?:idle-front.*\.png|^data:image\/png)/);
    image.onload?.call(image, new Event('load'));
    expect(cache.draw(ctx, agent(), 0, 120, 200, 100, T0)).toBe(true);
    expect(drawImage).toHaveBeenCalledWith(image, 96, 137.96, 48, 66);
    cache.dispose();

    const excludedFactory = vi.fn(() => image);
    for (const file of ['assets/characters/ceo/vector-study/idle-front/00.svg', 'assets/characters/ceo/source/idle-front.png']) {
      const excluded = new OfficeCrewAssets([asset('idle', { file })], undefined, excludedFactory);
      expect(excluded.draw(ctx, agent(), 0, 120, 200, 0, T0)).toBe(false);
      excluded.dispose();
    }
    expect(excludedFactory).not.toHaveBeenCalled();
  });

  it('keeps pending and failed images on the procedural fallback without repeated loads', () => {
    const h = harness([asset()]);
    expect(h.draw()).toBe(false);
    expect(h.draw()).toBe(false);
    expect(h.factory).toHaveBeenCalledTimes(1);
    h.images[0].onerror?.call(h.images[0], new Event('error'));
    expect(h.draw(2000)).toBe(false);
    expect(h.drawImage).not.toHaveBeenCalled();
    expect(h.factory).toHaveBeenCalledTimes(1);
  });

  it('draws ready frames anchored to the foot point and preserves the runtime agent', () => {
    const h = harness([asset()]);
    const original = agent();
    h.cache.draw(h.ctx, original, 0, 120, 200, 0, T0); // initiate load
    h.load();
    expect(h.draw(100)).toBe(true);
    const bounds = crewDrawBounds(asset(), 120, 200);
    expect(h.drawImage).toHaveBeenLastCalledWith(h.images[0], bounds.x, bounds.y, 48, 66);
    expect(bounds.x + bounds.width * 0.5).toBe(120);
    expect(bounds.y + bounds.height * 0.94).toBe(200);
    expect(original).toEqual(agent());
  });

  it('falls back to idle while a clip fails and skips missing bundle files', () => {
    const h = harness([asset('walk'), asset()]);
    h.draw(0, { isWalking: true });
    h.images[0].onerror?.call(h.images[0], new Event('error'));
    h.images[1].onload?.call(h.images[1], new Event('load'));
    expect(h.draw(100, { isWalking: true })).toBe(true);
    expect(h.drawImage.mock.calls[0][0]).toBe(h.images[1]);
    const unavailable = new OfficeCrewAssets([asset()], {});
    expect(unavailable.draw({} as CanvasRenderingContext2D, agent(), 0, 0, 0, 0, T0)).toBe(false);
  });

  it('ends finite completed animations in idle and restarts only after the action changes', () => {
    const completed = asset('completed', { frames: 2, fps: 10, loop: false, frameFiles: ['frame-a.svg', 'frame-b.svg'] });
    const h = harness([completed, asset()]);
    h.draw(0, { status: 'DONE' });
    h.load();
    expect(h.draw(100, { status: 'DONE' })).toBe(true);
    expect(h.drawImage.mock.lastCall?.[0]).toBe(h.images[1]);
    expect(h.draw(1000, { status: 'DONE' })).toBe(true);
    expect(h.drawImage.mock.lastCall?.[0]).toBe(h.images[2]);
    h.draw(1100, { status: 'IDLE' });
    h.draw(1200, { status: 'DONE' });
    expect(h.drawImage.mock.lastCall?.[0]).toBe(h.images[0]);
  });

  it('plays multi-frame raster clips, loops deterministically and respects reduced motion', () => {
    const frames = [
      'assets/animations/ceo/walk-front/00.png',
      'assets/animations/ceo/walk-front/01.png',
      'assets/animations/ceo/walk-front/02.png',
    ];
    const h = harness([asset('walk', {
      file: frames[0], frameFiles: frames, frames: 3, fps: 5, loop: true,
    }), asset()]);
    expect(h.draw(0, { isWalking: true })).toBe(false); // async image loads
    expect(h.images).toHaveLength(3); // preloads the entire raster sequence
    h.load();
    expect(h.draw(0, { isWalking: true })).toBe(true);
    expect(h.drawImage.mock.lastCall?.[0]).toBe(h.images[0]);
    expect(h.draw(200, { isWalking: true })).toBe(true);
    expect(h.drawImage.mock.lastCall?.[0]).toBe(h.images[1]);
    expect(h.draw(400, { isWalking: true })).toBe(true);
    expect(h.drawImage.mock.lastCall?.[0]).toBe(h.images[2]);
    expect(h.draw(600, { isWalking: true })).toBe(true);
    expect(h.drawImage.mock.lastCall?.[0]).toBe(h.images[0]);
    expect(h.draw(800, { isWalking: true }, true)).toBe(true);
    expect(h.drawImage.mock.lastCall?.[0]).toBe(h.images[0]);
    expect(h.factory).toHaveBeenCalledTimes(3);
  });

  it('holds the first animation frame with reduced motion and detaches pending callbacks on disposal', () => {
    const h = harness([asset('walk', { frames: 2, fps: 10, loop: true, frameFiles: ['frame-a.svg', 'frame-b.svg'] })]);
    h.draw(0, { isWalking: true });
    h.load();
    h.draw(100, { isWalking: true }, true);
    expect(h.drawImage.mock.lastCall?.[0]).toBe(h.images[0]);
    const lateLoad = h.images[0].onload;
    h.cache.dispose();
    expect(h.images.every(image => image.onload === null && image.onerror === null)).toBe(true);
    lateLoad?.call(h.images[0], new Event('load'));
    expect(h.draw(200, { isWalking: true })).toBe(false);
  });

  it('rotates facings in the same direction as grid coordinates, including negative turns', () => {
    expect(['SE', 'SW', 'NW', 'NE'].map(f => crewFacing(f as 'SE', 0))).toEqual(['right', 'front', 'left', 'back']);
    expect([0, 1, 2, 3].map(rot => crewFacing('SE', rot))).toEqual(['right', 'front', 'left', 'back']);
    expect(crewFacing('SW', -1)).toBe('right');
    expect(crewFacing('NW', 5)).toBe('back');
  });

  it('projects roles and authoritative states without inventing runtime work', () => {
    expect(crewRole({ role: 'custom', roleTitle: 'Finance' })).toBe('finance');
    expect(crewRole({ role: 'qa_engineer', roleTitle: '' })).toBe('reviewer');
    expect(crewRole({ role: 'backend_engineer', roleTitle: '' })).toBe('developer');
    expect(crewRole({ role: 'tech_lead', roleTitle: '' })).toBe('planner');
    expect(crewRole({ role: 'research_lead', roleTitle: '' })).toBe('analyst');
    expect(crewRole({ role: 'boss', roleTitle: '' })).toBe('ceo');
    expect(crewClip({ ...agent(), status: 'PHONE_CALL' }, T0)).toBe('phone');
    expect(crewClip({ ...agent(), status: 'WAITING_APPROVAL' }, T0)).toBe('idle');
    expect(crewClip({ ...agent(), status: 'CODING', isWalking: true }, T0)).toBe('walk');
    expect(crewFrameIndex({ frames: 6, fps: 10, loop: false }, 3000)).toBe(5);
    expect(crewFrameIndex({ frames: 6, fps: 10, loop: true }, 700)).toBe(1);
    expect(crewFrameIndex({ frames: 6, fps: 10, loop: true }, 700, true)).toBe(0);
  });
});
