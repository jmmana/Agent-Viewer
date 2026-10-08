import { assetUrls, findCharacter, roomLayouts, studioAssets, type StudioAsset } from './assets';

export const WORLD = { width: 1280, height: 760 };
export const sceneViews = {
  all: { x: 0, y: 0, width: WORLD.width, height: WORLD.height },
  director: { x: 20, y: 30, width: 554, height: 394 },
  meeting: { x: 602, y: 30, width: 652, height: 448 },
  coffee: { x: 20, y: 417, width: 450, height: 314 },
};
const rooms = [
  { id: 'director-suite', x: 38, y: 62, scale: .9, title: 'DIRECCIÓN', tint: '#f4eadb' },
  { id: 'meeting-room', x: 620, y: 62, scale: .9, title: 'SALA DE EQUIPO', tint: '#e2efeb' },
  { id: 'coffee-area', x: 38, y: 445, scale: .7, title: 'CAFÉ & DESCANSO', tint: '#f2e7dc' },
];
const points = [
  { t: 0, x: 290, y: 279 }, { t: 14, x: 290, y: 279 },
  { t: 16, x: 290, y: 428 }, { t: 18, x: 696, y: 480 },
  { t: 20, x: 727, y: 421 }, { t: 22, x: 852, y: 405 },
  { t: 30, x: 852, y: 405 }, { t: 32, x: 727, y: 480 },
  { t: 34, x: 444, y: 488 }, { t: 36, x: 220, y: 574 },
  { t: 38, x: 220, y: 574 }, { t: 40, x: 290, y: 428 },
  { t: 44, x: 290, y: 279 },
];
export function directorPosition(seconds: number) {
  const endIndex = Math.max(1, points.findIndex(point => point.t > seconds));
  const from = points[endIndex - 1];
  const to = points[endIndex];
  const progress = Math.max(0, Math.min(1, (seconds - from.t) / (to.t - from.t)));
  const moving = from.x !== to.x || from.y !== to.y;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const facing = !moving ? 'front' : Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 'right' : 'left' : dy > 0 ? 'front' : 'back';
  return { x: from.x + dx * progress, y: from.y + dy * progress, moving, facing };
}

export async function loadStudioImages() {
  const cache = new Map<string, HTMLImageElement>();
  const failed: string[] = [];
  await Promise.all(Object.entries(assetUrls).map(async ([file, url]) => {
    const img = new Image();
    await new Promise<void>(resolve => {
      img.onload = () => { cache.set(file, img); resolve(); };
      img.onerror = () => { failed.push(file); resolve(); };
      img.src = url;
    });
  }));
  return { cache, failed };
}

function roundBox(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, color: string, radius = 14) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
}
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color = '#52606a', size = 12, align: CanvasTextAlign = 'left') {
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
}

export function drawScene(ctx: CanvasRenderingContext2D, images: Map<string, HTMLImageElement>, seconds: number, reduced: boolean, selectedRole: string) {
  ctx.clearRect(0, 0, WORLD.width, WORLD.height);
  roundBox(ctx, 0, 0, WORLD.width, WORLD.height, '#edf0ec', 0);
  // Warm cutaway walls and floor tiles establish a shared ground plane without hiding the artwork.
  for (const room of rooms) {
    const layout = roomLayouts[room.id];
    if (!layout) continue;
    const width = layout.size.width * room.scale;
    const height = layout.size.height * room.scale;
    roundBox(ctx, room.x + 5, room.y + 8, width, height, '#d8ddd7');
    roundBox(ctx, room.x, room.y, width, height, room.tint);
    roundBox(ctx, room.x, room.y, width, 47, '#fafbf6', 12);
    ctx.save();
    ctx.beginPath();
    ctx.rect(room.x + 1, room.y + 47, width - 2, height - 48);
    ctx.clip();
    ctx.strokeStyle = '#ffffff65';
    ctx.lineWidth = 1;
    for (let x = room.x; x <= room.x + width; x += 43) {
      ctx.beginPath(); ctx.moveTo(x, room.y + 47); ctx.lineTo(x, room.y + height); ctx.stroke();
    }
    for (let y = room.y + 47; y <= room.y + height; y += 43) {
      ctx.beginPath(); ctx.moveTo(room.x, y); ctx.lineTo(room.x + width, y); ctx.stroke();
    }
    ctx.restore();
    label(ctx, room.title, room.x + 18, room.y - 13, '#566360', 13);
    // A small window belongs to the environment, not to the source characters.
    roundBox(ctx, room.x + width - 119, room.y + 11, 94, 26, '#d4e8ee', 4);
    ctx.fillStyle = '#f8fcfd'; ctx.fillRect(room.x + width - 73, room.y + 11, 3, 26);
  }
  label(ctx, 'PASILLO', 526, 439, '#89928a', 11, 'center');
  label(ctx, 'OFFICE CREW / ESCENA SIMULADA', 1250, 734, '#738179', 11, 'right');

  type DrawItem = { depth: number; render: () => void };
  const items: DrawItem[] = [];
  const drawAsset = (asset: StudioAsset | undefined, x: number, y: number, scale: number) => {
    if (!asset) return;
    const image = images.get(asset.file);
    if (!image) return;
    const width = asset.logicalSize.width * scale;
    const height = asset.logicalSize.height * scale;
    const left = x - width * asset.anchor.x;
    const top = y - height * asset.anchor.y;
    ctx.drawImage(image, left, top, width, height);
    if (asset.id === 'electronics.tv-display' && asset.screenRect) {
      const rect = asset.screenRect;
      const sx = left + rect.x * scale;
      const sy = top + rect.y * scale;
      const sw = rect.width * scale;
      const sh = rect.height * scale;
      roundBox(ctx, sx, sy, sw, sh, '#172d3a', 2);
      ctx.save();
      ctx.beginPath(); ctx.rect(sx, sy, sw, sh); ctx.clip();
      label(ctx, 'AV NEWS · FICCIÓN', sx + 5, sy + 12, '#7ee7d0', 7.5);
      const news = ['Equipo prepara una entrega', 'Nueva sala de trabajo disponible', 'Revisión visual en progreso'];
      label(ctx, news[Math.floor(seconds / 5) % news.length], sx + 5, sy + 24, '#ffffff', 6.5);
      label(ctx, `${String(Math.floor(seconds)).padStart(2, '0')}s · DATOS ILUSTRATIVOS`, sx + 5, sy + 35, '#c4d3df', 6.5);
      ctx.restore();
    }
  };
  for (const room of rooms) {
    const layout = roomLayouts[room.id];
    if (!layout) continue;
    type Placement = (typeof layout.placements)[number];
    const parentOf = (placement: Placement) => placement.supportPlacementId
      ? layout.placements.find(entry => entry.id === placement.supportPlacementId)
      : placement.supportAssetId ? layout.placements.find(entry => entry.assetId === placement.supportAssetId) : undefined;
    const drawPlacement = (placement: Placement, visited = new Set<Placement>()) => {
      if (visited.has(placement)) return;
      visited.add(placement);
      const asset = studioAssets.find(entry => entry.id === placement.assetId);
      drawAsset(asset, room.x + placement.x * room.scale, room.y + placement.y * room.scale, room.scale);
      // Attached monitors/phones use the support's depth while retaining their source-local position.
      for (const child of layout.placements.filter(entry => parentOf(entry) === placement)) drawPlacement(child, visited);
    };
    for (const placement of layout.placements.filter(entry => !parentOf(entry))) {
      items.push({ depth: room.y + placement.y * room.scale, render: () => drawPlacement(placement) });
    }
  }
  const actor = (role: string, x: number, y: number, clip = 'idle', facing = 'front', moving = false) => {
    const asset = findCharacter(role, clip, facing);
    items.push({ depth: y, render: () => {
      if (role === selectedRole) {
        ctx.strokeStyle = '#14a68b'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(x, y - 1, 34, 9, 0, 0, Math.PI * 2); ctx.stroke();
      }
      const bob = moving && !reduced ? Math.sin(seconds * 14) * 1.6 : 0;
      drawAsset(asset, x, y + bob, 1.08);
      if (!asset || !images.has(asset.file)) label(ctx, `${role}: recurso pendiente`, x, y - 48, '#646f76', 10, 'center');
      label(ctx, role === 'ceo' ? 'Director' : role.charAt(0).toUpperCase() + role.slice(1), x, y + 17, '#47534f', 10, 'center');
    } });
  };
  actor('planner', 780, 219);
  actor('analyst', 1045, 326);
  actor('reviewer', 1110, 350);
  actor('finance', 310, 695);
  actor('developer', 405, 354);
  const director = directorPosition(seconds);
  actor('ceo', director.x, director.y, seconds < 7 ? 'work' : seconds < 14 ? 'phone' : 'idle', director.facing, director.moving);
  for (const item of items.sort((a, b) => a.depth - b.depth)) item.render();
  if (seconds >= 7 && seconds < 14) {
    drawAsset(studioAssets.find(asset => asset.id === 'effect.call'), director.x + 48, director.y - 76, .85);
    drawAsset(studioAssets.find(asset => asset.id === 'effect.wifi'), director.x - 48, director.y - 76, .75);
  }
  if (seconds >= 22 && seconds < 30) {
    roundBox(ctx, director.x - 87, director.y - 132, 173, 37, '#fffef9');
    label(ctx, 'Revisemos la siguiente tarea', director.x, director.y - 109, '#48605a', 10, 'center');
  }
  // Runtime illustrative activity panel. All content stays outside the artwork source files.
  roundBox(ctx, 541, 547, 683, 151, '#ffffff', 18);
  label(ctx, 'UNA OFICINA CON VIDA', 566, 581, '#29473d', 14);
  label(ctx, 'Personajes, muebles y efectos compuestos en tiempo real.', 566, 608, '#65756d', 13);
  const bars = [31, 48, 26, 61, 43, 67, 56, 76, 63, 81];
  bars.forEach((height, index) => {
    ctx.fillStyle = index < Math.floor(seconds / 4) ? '#3aa68d' : '#dceae2';
    ctx.fillRect(566 + index * 23, 678 - height * .62, 14, height * .62);
  });
  label(ctx, 'Actividad ilustrativa · sin consumo de tokens', 852, 657, '#738178', 12);
}
