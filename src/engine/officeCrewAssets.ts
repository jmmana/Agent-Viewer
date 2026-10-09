/// <reference types="vite/client" />
import type { Agent } from '../types/agent';

/** A presentation choice only; it never changes the event-driven office state. */
export type CharacterStyle = 'procedural' | 'office-crew';
export type CrewRole = 'ceo' | 'planner' | 'developer' | 'analyst' | 'reviewer' | 'finance';
export type CrewFacing = 'front' | 'back' | 'left' | 'right';
export interface CrewAsset {
  id: string;
  kind: string;
  role?: string;
  clip?: string;
  facing?: string;
  file: string;
  frameFiles?: string[];
  logicalSize: { width: number; height: number };
  anchor: { x: number; y: number };
  frames: number;
  fps: number;
  loop: boolean;
}

// Vite rewrites these imports for both the demo app and the published library. No fetches, absolute
// public-directory URLs or runtime dependencies on the repository's assets directory are necessary.
const manifests = import.meta.glob<{ assets: CrewAsset[] }>('../../assets/asset-manifest.json', { eager: true, import: 'default' });
// Only finished runtime artwork is imported. High-resolution sources and vector motion studies
// stay unbundled; raster atlas frames may now live under assets/animations/<role>/<clip-facing>/.
const bundledUrls = import.meta.glob<string>([
  '../../assets/characters/*/*.{svg,png,webp}',
  '../../assets/animations/**/*.{png,webp}',
], { eager: true, query: '?url', import: 'default' });
const manifest = Object.values(manifests)[0];
const assetUrls = Object.fromEntries(Object.entries(bundledUrls).map(([path, url]) => [path.replace('../../', ''), url]));

export function crewRole(agent: Pick<Agent, 'role' | 'roleTitle'>): CrewRole {
  // Custom titles allow finance and the six art roles without expanding the canonical runtime role enum.
  if (agent.role === 'custom') {
    const title = agent.roleTitle.toLowerCase();
    if (/finance|finanz|contab|accountant|treasur/.test(title)) return 'finance';
    if (/ceo|director|executive/.test(title)) return 'ceo';
    if (/planner|planific|project manager/.test(title)) return 'planner';
    if (/develop|desarroll|engineer/.test(title)) return 'developer';
    if (/review|revisor|qa|quality/.test(title)) return 'reviewer';
    return 'analyst';
  }
  const roles: Record<Exclude<Agent['role'], 'custom'>, CrewRole> = {
    boss: 'ceo', tech_lead: 'planner', research_lead: 'analyst', backend_engineer: 'developer',
    frontend_engineer: 'developer', qa_engineer: 'reviewer', security_analyst: 'analyst',
  };
  return roles[agent.role];
}

/** Runtime SE means +gridX, SW means +gridY; apply the same clockwise turn as rotateGrid. */
export function crewFacing(facing: Agent['facing'], rotation: number): CrewFacing {
  const order: CrewFacing[] = ['right', 'front', 'left', 'back'];
  const index = { SE: 0, SW: 1, NW: 2, NE: 3 }[facing];
  return order[((index + Math.trunc(rotation)) % 4 + 4) % 4];
}

export function crewClip(agent: Agent, nowMs: number): string {
  if (agent.isWalking || agent.status === 'WALKING') return 'walk';
  if (agent.status === 'PHONE_CALL') return 'phone';
  if (agent.status === 'COFFEE_BREAK' || agent.presentationActivity === 'coffee_break') return 'coffee';
  if (agent.speechBubble && agent.speechBubble.expiresAt > nowMs
      || agent.ambientBubble && agent.ambientBubble.expiresAt > nowMs) return 'talk';
  if (agent.status === 'DONE') return 'completed';
  if (agent.status === 'BLOCKED' || agent.status === 'ERROR') return 'blocked';
  if (agent.status === 'THINKING') return 'think';
  if (['REVIEWING', 'TESTING', 'READING', 'RESEARCHING'].includes(agent.status)) return 'review';
  if (['CODING', 'WRITING', 'USING_TOOL'].includes(agent.status)) return 'work';
  if (agent.status === 'DELEGATING' || agent.status === 'CHATTING' || agent.presentationActivity === 'chatting') return 'talk';
  if (agent.status === 'IN_MEETING') return 'meeting';
  return 'idle';
}

export function crewFrameIndex(asset: Pick<CrewAsset, 'frames' | 'fps' | 'loop'>, elapsedMs: number, reducedMotion = false): number {
  if (reducedMotion || asset.frames <= 1 || asset.fps <= 0) return 0;
  const index = Math.floor(Math.max(0, elapsedMs) * asset.fps / 1000);
  return asset.loop ? index % asset.frames : Math.min(asset.frames - 1, index);
}

export function crewDrawBounds(asset: Pick<CrewAsset, 'logicalSize' | 'anchor'>, x: number, ground: number) {
  // Existing office furniture has a 48px footprint. 75% of the source box fits the same tile while
  // leaving room for expressions and carried props; the feet remain on the existing ground plane.
  const width = asset.logicalSize.width * 0.75;
  const height = asset.logicalSize.height * 0.75;
  return { x: x - width * asset.anchor.x, y: ground - height * asset.anchor.y, width, height };
}

type ImageEntry = { image: HTMLImageElement; state: 'pending' | 'ready' | 'failed' };
export type CrewImageFactory = () => HTMLImageElement;

/** Per-canvas cache: dispose detaches pending callbacks and prevents late loads from reviving it. */
export class OfficeCrewAssets {
  private images = new Map<string, ImageEntry>();
  private timelines = new Map<string, { key: string; start: number }>();
  private disposed = false;
  private drawnBounds = new Map<string, ReturnType<typeof crewDrawBounds>>();
  constructor(
    private assets: readonly CrewAsset[] = manifest?.assets ?? [],
    private urls: Readonly<Record<string, string>> = assetUrls,
    private createImage: CrewImageFactory = () => new Image(),
  ) {}

  private image(file: string): HTMLImageElement | null {
    if (this.disposed) return null;
    const cached = this.images.get(file);
    if (cached) return cached.state === 'ready' ? cached.image : null;
    const url = this.urls[file];
    if (!url) return null;
    let image: HTMLImageElement;
    try { image = this.createImage(); } catch { return null; }
    const entry: ImageEntry = { image, state: 'pending' };
    this.images.set(file, entry);
    image.onload = () => { if (!this.disposed) entry.state = image.naturalWidth > 0 ? 'ready' : 'failed'; };
    image.onerror = () => { entry.state = 'failed'; };
    try { image.src = url; } catch { entry.state = 'failed'; }
    return entry.state === 'ready' ? image : null;
  }

  /** False asks the renderer to use its procedural character, including while frames are loading. */
  draw(ctx: CanvasRenderingContext2D, agent: Agent, rotation: number, x: number, ground: number, timeMs: number, nowMs: number, reducedMotion = false): boolean {
    this.drawnBounds.delete(agent.id);
    if (this.disposed) return false;
    const role = crewRole(agent);
    const facing = crewFacing(agent.facing, rotation);
    const clip = crewClip(agent, nowMs);
    const timelineKey = `${role}.${clip}`; // Rotating the camera must not restart a finite action.
    let timeline = this.timelines.get(agent.id);
    if (!timeline || timeline.key !== timelineKey || timeMs < timeline.start) {
      timeline = { key: timelineKey, start: timeMs };
      this.timelines.set(agent.id, timeline);
    }
    const elapsed = timeMs - timeline.start;
    const candidates = [
      this.assets.find(a => a.kind === 'character' && a.role === role && a.clip === clip && a.facing === facing),
      this.assets.find(a => a.kind === 'character' && a.role === role && a.clip === 'idle' && a.facing === facing),
      this.assets.find(a => a.kind === 'character' && a.role === role && a.clip === 'idle' && a.facing === 'front'),
    ];
    for (const asset of candidates) {
      if (!asset) continue;
      // A finite celebration ends in idle rather than looping whenever DONE remains authoritative.
      if (!reducedMotion && !asset.loop && asset.frames > 1 && asset.fps > 0 && elapsed >= asset.frames / asset.fps * 1000) continue;
      const files = asset.frameFiles?.length ? asset.frameFiles : [asset.file];
      const frame = crewFrameIndex({ ...asset, frames: files.length }, elapsed, reducedMotion);
      const image = this.image(files[frame]);
      // Preload all clip frames once visited; fallback stays visible until the selected frame is ready.
      for (const file of files) this.image(file);
      if (!image) continue;
      const bounds = crewDrawBounds(asset, x, ground);
      try { ctx.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height); } catch { continue; }
      this.drawnBounds.set(agent.id, bounds);
      return true;
    }
    return false;
  }

  /** The bounds of the sprite actually drawn this frame; absent when the procedural fallback was used. */
  boundsFor(agentId: string) { return this.drawnBounds.get(agentId); }

  retainAgents(ids: readonly string[]) {
    const active = new Set(ids);
    for (const id of this.timelines.keys()) if (!active.has(id)) this.timelines.delete(id);
    for (const id of this.drawnBounds.keys()) if (!active.has(id)) this.drawnBounds.delete(id);
  }

  dispose() {
    this.disposed = true;
    for (const { image } of this.images.values()) { image.onload = null; image.onerror = null; }
    this.images.clear();
    this.timelines.clear();
    this.drawnBounds.clear();
  }
}
