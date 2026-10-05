import { cameraCenter, isSpeechActive, placeOverlay, wrapText, type OverlayRect } from './visualLayout';
import type { Agent } from '../types/agent';
import { Locale, t } from '../i18n';
import { aggregateModelUsage, compactTokens } from './modelOps';
import {
  FurnitureItem,
  GRID_COLS,
  GRID_ROWS,
  gridToScreen,
  OFFICE_FURNITURE,
  OFFICE_HALLWAYS,
  OFFICE_ROOMS,
  TILE_SIZE,
} from './officeModel';

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
  rotation: number; // 0: 0°, 1: 90°, 2: 180°, 3: 270°
}

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  camera: CameraState;
  agents: Agent[];
  selectedAgentId: string | null;
  hoveredAgentId: string | null;
  activeMeetingId: string | null;
  timeMs: number;
  theme: 'dark' | 'light';
  locale: Locale;
  nowMs: number;
  reducedMotion?: boolean;
}

/**
 * Renders the full 2.5D Rectangular Architectural Office.
 * Screen-aligned, rectangular layout (NO diamond / rhombus!) that fills the viewport cleanly.
 */
export function renderOfficeScene(rc: RenderContext) {
  const { ctx, width, height, camera, agents, selectedAgentId, hoveredAgentId, activeMeetingId, timeMs, theme, locale, nowMs } = rc;
  const rot = ((camera.rotation % 4) + 4) % 4;

  ctx.clearRect(0, 0, width, height);

  // Background field
  ctx.fillStyle = theme === 'dark' ? '#090d16' : '#f8fafc';
  ctx.fillRect(0, 0, width, height);

  // Apply camera pan, zoom and center transform to exact visual center of available area
  ctx.save();
  const center = cameraCenter(width, height);
  const effectiveCenterX = center.x;
  const effectiveCenterY = center.y;
  ctx.translate(effectiveCenterX, effectiveCenterY);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(camera.x, camera.y);

  // 1. Exterior Window Skyline & Building Ambient Contact Shadow
  drawBuildingBackdrop(ctx, rot, theme, timeMs);

  // 2. Floor tiles for rooms and designated interconnecting hallways
  drawFloorRooms(ctx, rot, theme, activeMeetingId, timeMs);

  drawRoomAtmosphere(ctx, rot, theme, locale);
  drawModelOpsTelemetry(ctx, rot, theme, agents, timeMs);
  drawMessageConnections(ctx, rot, agents, timeMs, nowMs);

  // 3. Architectural interior walls, glass partitions & doorways
  drawArchitecturalWalls(ctx, rot, theme);

  // 4. Depth-sorted Entities (Furniture and Agents rendered in 2.5D perspective)
  drawDepthSortedEntities(ctx, rot, agents, selectedAgentId, hoveredAgentId, activeMeetingId, timeMs, theme, nowMs);

  ctx.restore();
  // Typography lives in screen space: readable at every camera zoom.
  drawAgentOverlays(rc);
}

function drawBuildingBackdrop(
  ctx: CanvasRenderingContext2D,
  rot: number,
  theme: 'dark' | 'light',
  timeMs: number
) {
  const isRotated90 = rot === 1 || rot === 3;
  const officeWidth = (isRotated90 ? GRID_ROWS : GRID_COLS) * TILE_SIZE;
  const officeHeight = (isRotated90 ? GRID_COLS : GRID_ROWS) * TILE_SIZE;

  ctx.save();

  // Subtle ambient floor drop shadow under the rectangular building perimeter
  ctx.fillStyle = theme === 'dark' ? 'rgba(0, 0, 0, 0.5)' : 'rgba(100, 116, 139, 0.18)';
  ctx.beginPath();
  ctx.roundRect(-8, -8, officeWidth + 16, officeHeight + 20, 12);
  ctx.fill();

  // Exterior Window Skyline Header (Panoramic view outside top floor)
  const windowHeight = 18;
  const skyGradient = ctx.createLinearGradient(0, -windowHeight, 0, 0);
  if (theme === 'dark') {
    skyGradient.addColorStop(0, '#030712');
    skyGradient.addColorStop(1, '#0f172a');
  } else {
    skyGradient.addColorStop(0, '#bae6fd');
    skyGradient.addColorStop(1, '#e0f2fe');
  }

  ctx.fillStyle = skyGradient;
  ctx.fillRect(0, -windowHeight, officeWidth, windowHeight);

  // Distant skyscraper silhouettes through top windows
  ctx.fillStyle = theme === 'dark' ? '#111827' : '#93c5fd';
  for (let s = 20; s < officeWidth - 40; s += 55) {
    const h = ((s * 13) % 10) + 6;
    ctx.fillRect(s, -h, 24, h);
  }

  ctx.restore();
}

function drawFloorRooms(
  ctx: CanvasRenderingContext2D,
  rot: number,
  theme: 'dark' | 'light',
  activeMeetingId: string | null,
  timeMs: number
) {
  // 1. Draw designated architectural connecting hallways (Terrazzo corridors)
  for (const h of OFFICE_HALLWAYS) {
    for (let gx = h.gridX; gx < h.gridX + h.width; gx++) {
      for (let gy = h.gridY; gy < h.gridY + h.height; gy++) {
        const { x, y } = gridToScreen(gx, gy, rot);

        // Terrazzo tile
        ctx.fillStyle = (gx + gy) % 2 === 0
          ? (theme === 'dark' ? '#111827' : '#f1f5f9')
          : (theme === 'dark' ? '#0f172a' : '#e2e8f0');
        ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);

        ctx.strokeStyle = theme === 'dark' ? 'rgba(56, 189, 248, 0.04)' : 'rgba(0,0,0,0.04)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  // 2. Draw defined architectural rooms
  for (const room of OFFICE_ROOMS) {
    for (let gx = room.gridX; gx < room.gridX + room.width; gx++) {
      for (let gy = room.gridY; gy < room.gridY + room.height; gy++) {
        const { x, y } = gridToScreen(gx, gy, rot);

        // Room Floor Patterns
        if (room.id === 'meeting_room' && activeMeetingId) {
          const glow = Math.sin(timeMs / 400) * 0.12 + 0.88;
          ctx.fillStyle = theme === 'dark' ? `rgba(30, 41, 75, ${glow})` : `rgba(224, 231, 255, ${glow})`;
        } else if (room.floorPattern === 'executive') {
          // Executive dark herringbone parquet
          ctx.fillStyle = (gx + gy) % 2 === 0
            ? (theme === 'dark' ? '#1e1b4b' : '#ede9fe')
            : (theme === 'dark' ? '#201d49' : '#e9e5fb');
        } else if (room.floorPattern === 'concrete') {
          // Raised server floor grid
          ctx.fillStyle = (gx + gy) % 2 === 0
            ? (theme === 'dark' ? '#0f172a' : '#cbd5e1')
            : (theme === 'dark' ? '#111b2c' : '#d3dce6');
        } else if (room.floorPattern === 'carpet') {
          // Acoustic woven carpet
          ctx.fillStyle = (gx + gy) % 2 === 0
            ? (theme === 'dark' ? '#151d30' : '#e2e8f0')
            : (theme === 'dark' ? '#172033' : '#dfe7ef');
        } else if (room.floorPattern === 'wood') {
          // Natural warm oak planks
          ctx.fillStyle = (gx + gy) % 2 === 0
            ? (theme === 'dark' ? '#29282c' : '#efe4d3')
            : (theme === 'dark' ? '#2c2a2d' : '#f2e8da');
        } else {
          // Modern kitchen / lab ceramic tile
          ctx.fillStyle = (gx + gy) % 2 === 0
            ? (theme === 'dark' ? '#111827' : '#ffffff')
            : (theme === 'dark' ? '#141c2b' : '#f8fafc');
        }

        ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);

        ctx.strokeStyle = theme === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.04)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
      }
    }


  }

  // Draw Area Rugs with rich ambient colors
  // 1. Executive Geometric Area Rug in Boss Office
  drawRectAreaRug(ctx, 1, 1, 5, 4, rot, theme === 'dark' ? '#282244' : '#e4dcf5', '#63557e');
  // 2. Emerald Plush Rug in Team Lounge
  drawRectAreaRug(ctx, 18, 13, 5, 2.8, rot, theme === 'dark' ? '#1a3a3e' : '#d1e9df', '#4b7975');
  // 3. Antique Warm Rug in RAG Research Library
  drawRectAreaRug(ctx, 3, 13, 3, 2.8, rot, theme === 'dark' ? '#382d29' : '#ead9c5', '#8b6d55');
  // 4. Yellow/Black Security Hazard Stripes along Server Vault threshold
  drawServerHazardStripes(ctx, 17, 5, 7, 1, rot);
}


function drawModelOpsTelemetry(
  ctx: CanvasRenderingContext2D,
  rot: number,
  theme: 'dark' | 'light',
  agents: Agent[],
  timeMs: number
) {
  const room = OFFICE_ROOMS.find((item) => item.id === 'server_room');
  if (!room) return;

  const rect = getRoomScreenRect(room.gridX, room.gridY, room.width, room.height, rot);
  const providers = aggregateModelUsage(agents).slice(0, 4);
  const totalTokens = providers.reduce((sum, provider) => sum + provider.totalTokens, 0);
  const totalCost = providers.reduce((sum, provider) => sum + provider.cost, 0);
  const panelX = rect.x + 10;
  const panelY = rect.y + 36;
  const panelW = Math.max(120, rect.width - 20);
  const rowH = 28;

  ctx.save();
  ctx.fillStyle = theme === 'dark' ? 'rgba(2, 8, 23, 0.88)' : 'rgba(248,250,252,0.94)';
  ctx.strokeStyle = theme === 'dark' ? 'rgba(34,211,238,0.45)' : 'rgba(8,145,178,0.45)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(panelX, panelY, panelW, 34 + providers.length * rowH, 8);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.font = '700 8px "Plus Jakarta Sans", sans-serif';
  ctx.fillStyle = theme === 'dark' ? '#67e8f9' : '#0e7490';
  ctx.fillText('LIVE MODEL FLOW', panelX + 8, panelY + 12);

  ctx.font = '600 8px "Plus Jakarta Sans", sans-serif';
  ctx.fillStyle = theme === 'dark' ? '#cbd5e1' : '#334155';
  ctx.fillText(`${compactTokens(totalTokens)} TOKENS  ·  $${totalCost.toFixed(3)}`, panelX + 8, panelY + 24);

  providers.forEach((provider, index) => {
    const y = panelY + 34 + index * rowH;
    const pulse = 0.55 + Math.sin(timeMs / 450 + index) * 0.25;
    const max = Math.max(totalTokens, 1);
    const fraction = Math.max(0.04, provider.totalTokens / max);

    ctx.fillStyle = theme === 'dark' ? 'rgba(15,23,42,0.9)' : 'rgba(226,232,240,0.95)';
    ctx.beginPath();
    ctx.roundRect(panelX + 6, y, panelW - 12, 22, 5);
    ctx.fill();

    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#22d3ee';
    ctx.beginPath();
    ctx.arc(panelX + 14, y + 7, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.font = '700 7.5px "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = theme === 'dark' ? '#e2e8f0' : '#0f172a';
    const model = provider.models[0]?.model ?? '—';
    ctx.fillText(`${provider.provider} · ${model}`, panelX + 21, y + 9);

    ctx.font = '600 7px "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = theme === 'dark' ? '#94a3b8' : '#64748b';
    ctx.fillText(`${compactTokens(provider.totalTokens)} · $${provider.cost.toFixed(3)} · ${provider.activeAgents} agents`, panelX + 21, y + 18);

    ctx.fillStyle = theme === 'dark' ? '#164e63' : '#a5f3fc';
    ctx.fillRect(panelX + panelW - 62, y + 4, 50, 3);
    ctx.fillStyle = '#22d3ee';
    ctx.fillRect(panelX + panelW - 62, y + 4, 50 * fraction, 3);
  });

  ctx.restore();
}

function drawServerHazardStripes(
  ctx: CanvasRenderingContext2D,
  gx: number,
  gy: number,
  w: number,
  h: number,
  rot: number
) {
  const rect = getRoomScreenRect(gx, gy, w, h, rot);
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x + 2, rect.y + rect.height - 6, rect.width - 4, 5);
  ctx.clip();
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(rect.x + 2, rect.y + rect.height - 6, rect.width - 4, 5);

  ctx.fillStyle = '#eab308';
  for (let sx = rect.x - 20; sx < rect.x + rect.width + 20; sx += 14) {
    ctx.beginPath();
    ctx.moveTo(sx, rect.y + rect.height - 1);
    ctx.lineTo(sx + 7, rect.y + rect.height - 1);
    ctx.lineTo(sx + 13, rect.y + rect.height - 6);
    ctx.lineTo(sx + 6, rect.y + rect.height - 6);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Calculates screen-space bounding rectangle of any room or zone, invariant to 90° rotation.
 */
export function getRoomScreenRect(gx: number, gy: number, w: number, h: number, rot = 0) {
  const c0 = gridToScreen(gx, gy, rot);
  const c1 = gridToScreen(gx + w - 1, gy, rot);
  const c2 = gridToScreen(gx, gy + h - 1, rot);
  const c3 = gridToScreen(gx + w - 1, gy + h - 1, rot);

  const minX = Math.min(c0.x, c1.x, c2.x, c3.x);
  const maxX = Math.max(c0.x, c1.x, c2.x, c3.x) + TILE_SIZE;
  const minY = Math.min(c0.y, c1.y, c2.y, c3.y);
  const maxY = Math.max(c0.y, c1.y, c2.y, c3.y) + TILE_SIZE;

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function drawRectAreaRug(
  ctx: CanvasRenderingContext2D,
  gx: number,
  gy: number,
  w: number,
  h: number,
  rot: number,
  fillColor: string,
  borderColor: string
) {
  const rugRect = getRoomScreenRect(gx, gy, w, h, rot);
  ctx.save();
  ctx.fillStyle = fillColor;
  ctx.beginPath();
  ctx.roundRect(rugRect.x + 6, rugRect.y + 6, Math.max(rugRect.width - 12, 10), Math.max(rugRect.height - 12, 10), 8);
  ctx.fill();

  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawArchitecturalWalls(ctx: CanvasRenderingContext2D, rot: number, theme: 'dark' | 'light') {
  ctx.save();

  // Glass Partitions & Room Dividing Walls for each architectural room
  for (const room of OFFICE_ROOMS) {
    const rect = getRoomScreenRect(room.gridX, room.gridY, room.width, room.height, rot);

    // Modern glass partition wall frame
    ctx.strokeStyle = theme === 'dark' ? 'rgba(56, 189, 248, 0.35)' : 'rgba(14, 165, 233, 0.45)';
    ctx.lineWidth = 2;
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

    // Subtle frosted glass accent
    ctx.strokeStyle = theme === 'dark' ? 'rgba(56, 189, 248, 0.10)' : 'rgba(14, 165, 233, 0.12)';
    ctx.lineWidth = 5;
    ctx.strokeRect(rect.x + 2, rect.y + 2, rect.width - 4, rect.height - 4);
  }

  // Exterior Building Outline Border
  const isRotated90 = rot === 1 || rot === 3;
  const officeWidth = (isRotated90 ? GRID_ROWS : GRID_COLS) * TILE_SIZE;
  const officeHeight = (isRotated90 ? GRID_COLS : GRID_ROWS) * TILE_SIZE;

  // Foundation border
  ctx.strokeStyle = theme === 'dark' ? '#334155' : '#94a3b8';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, officeWidth, officeHeight);

  // Exterior structural corner pillars
  ctx.fillStyle = theme === 'dark' ? '#475569' : '#64748b';
  const pillarSize = 10;
  ctx.fillRect(-2, -2, pillarSize, pillarSize);
  ctx.fillRect(officeWidth - pillarSize + 2, -2, pillarSize, pillarSize);
  ctx.fillRect(-2, officeHeight - pillarSize + 2, pillarSize, pillarSize);
  ctx.fillRect(officeWidth - pillarSize + 2, officeHeight - pillarSize + 2, pillarSize, pillarSize);

  ctx.restore();
}

function drawDepthSortedEntities(
  ctx: CanvasRenderingContext2D,
  rot: number,
  agents: Agent[],
  selectedAgentId: string | null,
  hoveredAgentId: string | null,
  activeMeetingId: string | null,
  timeMs: number,
  theme: 'dark' | 'light',
  nowMs: number
) {
  type DepthEntity =
    | { kind: 'furniture'; item: FurnitureItem; depth: number }
    | { kind: 'agent'; agent: Agent; depth: number };

  const entities: DepthEntity[] = [];

  for (const f of OFFICE_FURNITURE) {
    const { y } = gridToScreen(f.gridX, f.gridY, rot);
    entities.push({ kind: 'furniture', item: f, depth: y });
  }

  for (const a of agents) {
    const { y } = gridToScreen(a.x, a.y, rot);
    entities.push({ kind: 'agent', agent: a, depth: y });
  }

  // Sort by Y coordinate so entities in front overlap those behind
  entities.sort((a, b) => a.depth - b.depth);

  for (const ent of entities) {
    if (ent.kind === 'furniture') {
      renderFurnitureItem(ctx, ent.item, rot, timeMs, theme, activeMeetingId);
    } else {
      renderAgentItem(ctx, ent.agent, rot, selectedAgentId, hoveredAgentId, timeMs, theme, nowMs);
    }
  }
}

function renderFurnitureItem(
  ctx: CanvasRenderingContext2D,
  item: FurnitureItem,
  rot: number,
  timeMs: number,
  theme: 'dark' | 'light',
  activeMeetingId: string | null
) {
  const { x, y } = gridToScreen(item.gridX, item.gridY, rot);
  ctx.save();
  const scale = item.scale ?? (item.type === 'desk' ? 1.35 : item.type === 'meeting_table' ? 1.65 : item.type === 'plant' ? 1.2 : 1);
  const cx = x + TILE_SIZE / 2;
  const cy = y + TILE_SIZE / 2;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);
  // Ground contact gives every object a place in the room.
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.beginPath();
  ctx.ellipse(cx + 2, cy + 13, item.type === 'meeting_table' ? 65 : 21, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  if (item.type === 'desk') {
    renderDesk(ctx, x, y, item, timeMs, theme);
  } else if (item.type === 'chair') {
    renderChair(ctx, x, y, item, theme);
  } else if (item.type === 'meeting_table') {
    renderMeetingTable(ctx, x, y, theme);
  } else if (item.type === 'screen') {
    renderWallScreen(ctx, x, y, item, activeMeetingId, timeMs);
  } else if (item.type === 'whiteboard') {
    renderWhiteboard(ctx, x, y, item);
  } else if (item.type === 'server_rack') {
    renderServerRack(ctx, x, y, item, timeMs);
  } else if (item.type === 'bookshelf') {
    renderBookshelf(ctx, x, y);
  } else if (item.type === 'credenza') {
    renderCredenza(ctx, x, y, theme);
  } else if (item.type === 'kanban') {
    renderKanban(ctx, x, y);
  } else if (item.type === 'device_bench') {
    renderDeviceBench(ctx, x, y, timeMs);
  } else if (item.type === 'terminal_podium') {
    renderTerminalPodium(ctx, x, y, timeMs);
  } else if (item.type === 'plant') {
    renderPlant(ctx, x, y, item.plantType || 'monstera', timeMs);
  } else if (item.type === 'coffee_machine') {
    renderEspressoMachine(ctx, x, y, timeMs);
  } else if (item.type === 'water_cooler') {
    renderWaterCooler(ctx, x, y, timeMs);
  } else if (item.type === 'kitchen_counter') {
    renderKitchenCounter(ctx, x, y, theme);
  } else if (item.type === 'fridge') {
    renderFridge(ctx, x, y);
  } else if (item.type === 'sofa') {
    renderSofa(ctx, x, y);
  } else if (item.type === 'snack_table') {
    renderSnackTable(ctx, x, y);
  } else if (item.type === 'lamp') {
    renderFloorLamp(ctx, x, y, theme);
  } else if (item.type === 'hvac') {
    renderHVAC(ctx, x, y, timeMs);
  }

  ctx.restore();
}

function renderDesk(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  item: FurnitureItem,
  timeMs: number,
  theme: 'dark' | 'light'
) {
  const deskW = 44;
  const deskH = 26;
  const posX = x + 2;
  const posY = y + 10;

  // Ambient Drop Shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.beginPath();
  ctx.roundRect(posX + 2, posY + 3, deskW, deskH, 4);
  ctx.fill();

  // Desktop Tabletop Surface & Bevel
  if (item.deskStyle === 'boss') {
    // Executive Rich Walnut with Golden Brass Bevel
    ctx.fillStyle = theme === 'dark' ? '#2d1810' : '#5c3826';
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(posX, posY, deskW, deskH, 4);
    ctx.fill();
    ctx.stroke();

    // Dark Leather Executive Desk Pad
    ctx.fillStyle = '#1c1917';
    ctx.fillRect(posX + 8, posY + 4, deskW - 16, deskH - 8);

    // Dual Curved Ultrawide Display
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(posX + 10, posY - 9, 24, 11);
    ctx.fillStyle = '#0284c7';
    ctx.fillRect(posX + 11, posY - 8, 22, 9);

    // Glowing KPI line chart on screen
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(posX + 12, posY - 2);
    ctx.lineTo(posX + 17, posY - 5);
    ctx.lineTo(posX + 22, posY - 3);
    ctx.lineTo(posX + 30, posY - 7);
    ctx.stroke();

    // Executive Laptop & Brass Lamp
    ctx.fillStyle = '#94a3b8';
    ctx.fillRect(posX + 14, posY + 8, 11, 7);

    // Lamp with warm golden glow
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(posX + 36, posY + 7, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(245, 158, 11, 0.25)';
    ctx.beginPath();
    ctx.arc(posX + 36, posY + 7, 8, 0, Math.PI * 2);
    ctx.fill();
  } else if (item.deskStyle === 'dev_rgb') {
    // Elena's Backend Engineering Pod
    ctx.fillStyle = theme === 'dark' ? '#0f172a' : '#f1f5f9';
    ctx.strokeStyle = '#0284c7';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.roundRect(posX, posY, deskW, deskH, 3);
    ctx.fill();
    ctx.stroke();

    // Desk Mat
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(posX + 6, posY + 5, deskW - 12, deskH - 10);

    // Vertical Code Monitor (Left) showing syntax highlighted code
    ctx.fillStyle = '#020617';
    ctx.fillRect(posX + 6, posY - 11, 10, 15);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(posX + 6, posY - 11, 10, 15);

    // Animated syntax code lines
    const colors = ['#22c55e', '#38bdf8', '#f59e0b', '#ec4899'];
    for (let c = 0; c < 4; c++) {
      const lineY = posY - 9 + c * 3;
      const cIdx = (c + Math.floor(timeMs / 400)) % colors.length;
      ctx.fillStyle = colors[cIdx];
      ctx.fillRect(posX + 8, lineY, 6, 1.2);
    }

    // Horizontal Main Monitor (Right)
    ctx.fillStyle = '#020617';
    ctx.fillRect(posX + 18, posY - 8, 20, 11);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(posX + 19, posY - 7, 18, 9);
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(posX + 21, posY - 5, 14, 1.5);

    // Mechanical Keyboard with animated RGB backlighting
    const rgbHue = 200 + Math.sin(timeMs / 2400) * 30;
    ctx.fillStyle = `hsl(${rgbHue}, 85%, 60%)`;
    ctx.fillRect(posX + 17, posY + 10, 14, 5);
  } else if (item.deskStyle === 'dev_figma') {
    // Kenji's Frontend Design Pod
    ctx.fillStyle = theme === 'dark' ? '#0f172a' : '#f1f5f9';
    ctx.strokeStyle = '#a855f7';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.roundRect(posX, posY, deskW, deskH, 3);
    ctx.fill();
    ctx.stroke();

    // Dual Designer Displays (Figma purple theme)
    ctx.fillStyle = '#020617';
    ctx.fillRect(posX + 8, posY - 8, 28, 11);
    ctx.fillStyle = '#2e1065';
    ctx.fillRect(posX + 9, posY - 7, 26, 9);
    // UI Mockup frames on screen
    ctx.fillStyle = '#a855f7';
    ctx.fillRect(posX + 11, posY - 5, 6, 5);
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(posX + 19, posY - 5, 7, 5);
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(posX + 28, posY - 5, 5, 5);

    // Minimalist keyboard & mousepad
    ctx.fillStyle = '#475569';
    ctx.fillRect(posX + 14, posY + 10, 13, 5);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(posX + 30, posY + 11, 4, 3);
  } else if (item.deskStyle === 'sec_console') {
    // Marcus's Security Ops Console
    ctx.fillStyle = theme === 'dark' ? '#090d16' : '#e2e8f0';
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.roundRect(posX, posY, deskW, deskH, 3);
    ctx.fill();
    ctx.stroke();

    // Triple Terminal Displays (Matrix Green & Security Audit)
    ctx.fillStyle = '#020617';
    ctx.fillRect(posX + 2, posY - 8, 11, 10);
    ctx.fillRect(posX + 15, posY - 9, 14, 11);
    ctx.fillRect(posX + 31, posY - 8, 11, 10);

    ctx.fillStyle = '#10b981';
    ctx.fillRect(posX + 3, posY - 7, 9, 8);
    ctx.fillStyle = '#059669';
    ctx.fillRect(posX + 16, posY - 8, 12, 9);
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(posX + 32, posY - 7, 9, 8);

    // Security badge on desk
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(posX + 6, posY + 10, 5, 4);
    ctx.fillStyle = '#334155';
    ctx.fillRect(posX + 15, posY + 10, 14, 5);
  } else if (item.deskStyle === 'qa_lab') {
    // Zoe's QA Diagnostic Station
    ctx.fillStyle = theme === 'dark' ? '#131b2e' : '#e2e8f0';
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.roundRect(posX, posY, deskW, deskH, 3);
    ctx.fill();
    ctx.stroke();

    // Oscilloscope & Diagnostic Monitor
    ctx.fillStyle = '#020617';
    ctx.fillRect(posX + 10, posY - 8, 24, 11);
    ctx.fillStyle = '#1e1b4b';
    ctx.fillRect(posX + 11, posY - 7, 22, 9);

    // Waveform line on testing monitor
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const wave = Math.sin(timeMs / 120);
    ctx.moveTo(posX + 12, posY - 2);
    ctx.lineTo(posX + 17, posY - 2 + wave * 3);
    ctx.lineTo(posX + 23, posY - 2 - wave * 3);
    ctx.lineTo(posX + 31, posY - 2);
    ctx.stroke();

    // Test tablet on desk
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(posX + 8, posY + 8, 8, 11);
    ctx.fillStyle = '#334155';
    ctx.fillRect(posX + 18, posY + 10, 14, 5);
  } else if (item.deskStyle === 'research') {
    // Dr. Maya's Research Desk / Library Study Table
    ctx.fillStyle = theme === 'dark' ? '#262626' : '#e7e5e4';
    ctx.strokeStyle = '#b45309';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.roundRect(posX, posY, deskW, deskH, 3);
    ctx.fill();
    ctx.stroke();

    // Study Lamp & Ultrawide Display
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(posX + 12, posY - 8, 20, 11);
    ctx.fillStyle = '#042f2e';
    ctx.fillRect(posX + 13, posY - 7, 18, 9);

    // Research paper stacks on desk
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(posX + 6, posY + 6, 7, 9);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(posX + 6, posY + 6, 7, 9);

    // Brass reading lamp
    ctx.fillStyle = '#b45309';
    ctx.beginPath();
    ctx.arc(posX + 37, posY + 6, 3, 0, Math.PI * 2);
    ctx.fill();
  } else if (item.deskStyle === 'standing') {
    // Alex's Tech Lead Standing Desk
    ctx.fillStyle = theme === 'dark' ? '#1e293b' : '#f8fafc';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.roundRect(posX, posY, deskW, deskH, 3);
    ctx.fill();
    ctx.stroke();

    // Dual High Standing Monitors
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(posX + 8, posY - 9, 13, 11);
    ctx.fillRect(posX + 23, posY - 9, 13, 11);

    ctx.fillStyle = '#0369a1';
    ctx.fillRect(posX + 9, posY - 8, 11, 9);
    ctx.fillStyle = '#0284c7';
    ctx.fillRect(posX + 24, posY - 8, 11, 9);

    // Coffee mug
    ctx.fillStyle = '#0ea5e9';
    ctx.beginPath();
    ctx.arc(posX + 38, posY + 8, 2.5, 0, Math.PI * 2);
    ctx.fill();
  } else if (item.deskStyle === 'sysadmin') {
    // Cloud Vault Sysadmin Station
    ctx.fillStyle = '#090d16';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.roundRect(posX, posY, deskW, deskH, 3);
    ctx.fill();
    ctx.stroke();

    // Dual terminal displays showing live server stats
    ctx.fillStyle = '#020617';
    ctx.fillRect(posX + 6, posY - 8, 14, 10);
    ctx.fillRect(posX + 22, posY - 8, 16, 10);

    ctx.fillStyle = '#10b981';
    ctx.fillRect(posX + 7, posY - 7, 12, 8);
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(posX + 23, posY - 7, 14, 8);
  } else {
    // Modern Hotdesk / Round Cafe Table
    ctx.fillStyle = theme === 'dark' ? '#1e293b' : '#e2e8f0';
    ctx.strokeStyle = theme === 'dark' ? '#334155' : '#cbd5e1';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(posX, posY, deskW, deskH, 4);
    ctx.fill();
    ctx.stroke();

    // Laptop & cup
    ctx.fillStyle = '#64748b';
    ctx.fillRect(posX + 16, posY + 6, 12, 8);
    ctx.fillStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.arc(posX + 34, posY + 9, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Label under desk
  if (item.label && !item.assignedAgentId) {
    ctx.font = '600 8.5px "JetBrains Mono", monospace';
    ctx.fillStyle = theme === 'dark' ? '#94a3b8' : '#64748b';
    ctx.textAlign = 'left';
    ctx.fillText(item.label, posX - 2, posY + deskH + 9);
  }
}

function renderChair(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  item: FurnitureItem,
  theme: 'dark' | 'light'
) {
  const cx = x + 24;
  const cy = y + 24;

  if (item.subType === 'executive') {
    // Executive Leather High-Back Chair
    ctx.fillStyle = '#1c1917';
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // High Headrest
    ctx.fillStyle = '#292524';
    ctx.beginPath();
    ctx.roundRect(cx - 7, cy - 12, 14, 6, 3);
    ctx.fill();
  } else if (item.subType === 'armchair') {
    // Plush Armchair
    ctx.fillStyle = theme === 'dark' ? '#334155' : '#64748b';
    ctx.beginPath();
    ctx.roundRect(cx - 8, cy - 8, 16, 16, 5);
    ctx.fill();
    ctx.strokeStyle = theme === 'dark' ? '#475569' : '#94a3b8';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  } else if (item.subType === 'stool') {
    // Chrome Bistro / Bar Stool
    ctx.fillStyle = '#475569';
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else {
    // Modern Ergonomic Mesh Task Chair
    ctx.fillStyle = theme === 'dark' ? '#334155' : '#64748b';
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fill();

    // Curved Lumbar Backrest
    ctx.fillStyle = theme === 'dark' ? '#1e293b' : '#475569';
    ctx.beginPath();
    ctx.roundRect(cx - 6, cy - 9, 12, 4, 2);
    ctx.fill();
  }
}

function renderMeetingTable(ctx: CanvasRenderingContext2D, x: number, y: number, theme: 'dark' | 'light') {
  // Long 8-Seater Boardroom Table
  const tableW = 120;
  const tableH = 48;
  const px = x - 36;
  const py = y + 10;

  // Drop Shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.beginPath();
  ctx.roundRect(px + 3, py + 3, tableW, tableH, 12);
  ctx.fill();

  // Premium Indigo / Royal Wood Tabletop
  ctx.fillStyle = theme === 'dark' ? '#1e1b4b' : '#dbeafe';
  ctx.strokeStyle = theme === 'dark' ? '#6366f1' : '#60a5fa';
  ctx.lineWidth = 2.5;

  ctx.beginPath();
  ctx.roundRect(px, py, tableW, tableH, 12);
  ctx.fill();
  ctx.stroke();

  // Glass Veneer Center Inlay
  ctx.fillStyle = theme === 'dark' ? '#312e81' : '#bfdbfe';
  ctx.beginPath();
  ctx.roundRect(px + 14, py + 10, tableW - 28, tableH - 20, 6);
  ctx.fill();

  // Central Audio Conference Speaker Puck
  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  ctx.arc(px + tableW / 2, py + tableH / 2, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Microphones and tablets around table
  ctx.fillStyle = '#22c55e';
  ctx.beginPath();
  ctx.arc(px + 32, py + tableH / 2, 2.5, 0, Math.PI * 2);
  ctx.arc(px + tableW - 32, py + tableH / 2, 2.5, 0, Math.PI * 2);
  ctx.fill();

  // Two collaboration tablets on table
  ctx.fillStyle = '#38bdf8';
  ctx.fillRect(px + 45, py + 14, 8, 6);
  ctx.fillRect(px + tableW - 53, py + 14, 8, 6);
}

function renderWallScreen(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  item: FurnitureItem,
  activeMeetingId: string | null,
  timeMs: number
) {
  const sw = 76;
  const sh = 32;
  const px = x - 14;
  const py = y + 2;

  // Screen Ambient Halo / Bezel
  ctx.fillStyle = '#020617';
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.roundRect(px, py, sw, sh, 5);
  ctx.fill();
  ctx.stroke();

  if (item.id === 'f_conf_screen') {
    // Boardroom 85" Ultra-HD Display
    if (activeMeetingId) {
      ctx.fillStyle = '#0369a1';
      ctx.fillRect(px + 4, py + 4, sw - 8, sh - 8);

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 8.5px "Plus Jakarta Sans", sans-serif';
      ctx.fillText('TEAM COORDINATION', px + 7, py + 14);

      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(px + 7, py + 18, 24, 5);
      ctx.fillStyle = '#22c55e';
      ctx.fillRect(px + 35, py + 18, 30, 5);
    } else {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + 4, py + 4, sw - 8, sh - 8);

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 8px "JetBrains Mono", monospace';
      ctx.fillText('CONFERENCE READY', px + 6, py + 16);
    }
  } else if (item.id === 'f_qa_screen') {
    // QA Automated CI/CD Screen
    ctx.fillStyle = '#022c22';
    ctx.fillRect(px + 4, py + 4, sw - 8, sh - 8);

    ctx.fillStyle = '#4ade80';
    ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
    ctx.fillText('TEST AUTOMATION', px + 6, py + 13);
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(px + 6, py + 18, 48, 4);
  } else if (item.id === 'f_server_noc') {
    // NOC Server Vault Monitor
    ctx.fillStyle = '#090d16';
    ctx.fillRect(px + 4, py + 4, sw - 8, sh - 8);

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
    ctx.fillText('INFRASTRUCTURE', px + 6, py + 13);

    // Heartbeat ping graph
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px + 6, py + 22);
    ctx.lineTo(px + 24, py + 22);
    ctx.lineTo(px + 28, py + 17);
    ctx.lineTo(px + 32, py + 25);
    ctx.lineTo(px + 36, py + 22);
    ctx.lineTo(px + 68, py + 22);
    ctx.stroke();
  } else {
    // Boss KPI or Lounge Screen
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(px + 4, py + 4, sw - 8, sh - 8);
    ctx.fillStyle = '#f59e0b';
    ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
    ctx.fillText(item.label || 'SYSTEM STATUS', px + 6, py + 16);
  }
}

function renderWhiteboard(ctx: CanvasRenderingContext2D, x: number, y: number, item: FurnitureItem) {
  const wx = x + 6;
  const wy = y + 6;
  const ww = 36;
  const wh = 28;

  // Aluminum Whiteboard Frame
  ctx.fillStyle = '#f8fafc';
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 2;
  ctx.fillRect(wx, wy, ww, wh);
  ctx.strokeRect(wx, wy, ww, wh);

  // Architecture flowchart diagrams on board
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 1;
  ctx.strokeRect(wx + 4, wy + 4, 8, 6);
  ctx.strokeRect(wx + 22, wy + 4, 8, 6);
  ctx.beginPath();
  ctx.moveTo(wx + 12, wy + 7);
  ctx.lineTo(wx + 22, wy + 7);
  ctx.stroke();

  // Colorful sticky notes (yellow, pink, green)
  ctx.fillStyle = '#facc15';
  ctx.fillRect(wx + 5, wy + 14, 6, 6);
  ctx.fillStyle = '#f43f5e';
  ctx.fillRect(wx + 14, wy + 14, 6, 6);
  ctx.fillStyle = '#22c55e';
  ctx.fillRect(wx + 23, wy + 14, 6, 6);

  // Bottom Marker Tray with 3 colored markers
  ctx.fillStyle = '#475569';
  ctx.fillRect(wx + 8, wy + wh, 20, 2);
}

function renderKanban(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const kx = x + 4;
  const ky = y + 4;
  const kw = 40;
  const kh = 30;

  ctx.fillStyle = '#0f172a';
  ctx.strokeStyle = '#0284c7';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(kx, ky, kw, kh, 4);
  ctx.fill();
  ctx.stroke();

  // Columns: TODO, WIP, DONE
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(kx + 13, ky);
  ctx.lineTo(kx + 13, ky + kh);
  ctx.moveTo(kx + 26, ky);
  ctx.lineTo(kx + 26, ky + kh);
  ctx.stroke();

  // Column sticky notes
  ctx.fillStyle = '#f59e0b';
  ctx.fillRect(kx + 3, ky + 6, 7, 5);
  ctx.fillRect(kx + 3, ky + 14, 7, 5);
  ctx.fillStyle = '#38bdf8';
  ctx.fillRect(kx + 16, ky + 8, 7, 5);
  ctx.fillStyle = '#22c55e';
  ctx.fillRect(kx + 29, ky + 6, 7, 5);
}

function renderDeviceBench(ctx: CanvasRenderingContext2D, x: number, y: number, timeMs: number) {
  const bx = x + 4;
  const by = y + 10;

  // Metallic Test Matrix Bench
  ctx.fillStyle = '#1e293b';
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(bx, by, 40, 24, 3);
  ctx.fill();
  ctx.stroke();

  // 3 Test Devices (Mobile, Tablet) mounted on stand
  ctx.fillStyle = '#020617';
  ctx.fillRect(bx + 5, by + 4, 7, 13);
  ctx.fillStyle = '#22c55e';
  ctx.fillRect(bx + 6, by + 5, 5, 10);

  ctx.fillStyle = '#020617';
  ctx.fillRect(bx + 16, by + 3, 9, 15);
  ctx.fillStyle = '#38bdf8';
  ctx.fillRect(bx + 17, by + 4, 7, 12);

  ctx.fillStyle = '#020617';
  ctx.fillRect(bx + 28, by + 4, 7, 13);
  ctx.fillStyle = '#f59e0b';
  ctx.fillRect(bx + 29, by + 5, 5, 10);
}

function renderTerminalPodium(ctx: CanvasRenderingContext2D, x: number, y: number, timeMs: number) {
  const px = x + 16;
  const py = y + 10;

  // Futuristic Angled Pedestal
  ctx.fillStyle = '#0f172a';
  ctx.strokeStyle = '#0284c7';
  ctx.lineWidth = 1.5;
  ctx.fillRect(px, py + 8, 16, 20);

  // Angled Touch Screen with glowing blue search graph
  ctx.fillStyle = '#0284c7';
  ctx.fillRect(px - 2, py + 2, 20, 8);
  ctx.fillStyle = '#38bdf8';
  const pulse = Math.sin(timeMs / 200) * 1.5;
  ctx.fillRect(px + 2, py + 4, 12 + pulse, 3);
}

function renderCredenza(ctx: CanvasRenderingContext2D, x: number, y: number, theme: 'dark' | 'light') {
  const cx = x + 4;
  const cy = y + 4;
  const cw = 40;
  const ch = 38;

  ctx.fillStyle = theme === 'dark' ? '#261b15' : '#78350f';
  ctx.strokeStyle = '#92400e';
  ctx.lineWidth = 1.5;
  ctx.fillRect(cx, cy, cw, ch);
  ctx.strokeRect(cx, cy, cw, ch);

  // Gold Trophies & Awards on top shelf
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.arc(cx + 12, cy + 8, 3, 0, Math.PI * 2);
  ctx.rect(cx + 10, cy + 11, 4, 5);
  ctx.fill();

  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(cx + 26, cy + 7, 8, 9);
  ctx.strokeStyle = '#f59e0b';
  ctx.strokeRect(cx + 26, cy + 7, 8, 9);

  // Books on bottom shelves
  const colors = ['#dc2626', '#2563eb', '#16a34a', '#d97706'];
  for (let b = 0; b < 6; b++) {
    ctx.fillStyle = colors[b % colors.length];
    ctx.fillRect(cx + 6 + b * 5, cy + 24, 4, 10);
  }
}

function renderServerRack(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  item: FurnitureItem,
  timeMs: number
) {
  const rx = x + 4;
  const ry = y + 2;
  const rw = 40;
  const rh = 44;

  // Dark metallic server rack chassis
  ctx.fillStyle = '#090d16';
  ctx.strokeStyle = '#0284c7';
  ctx.lineWidth = 1.8;
  ctx.fillRect(rx, ry, rw, rh);
  ctx.strokeRect(rx, ry, rw, rh);

  // 6 Server Blades per rack
  for (let s = 0; s < 6; s++) {
    const sy = ry + 4 + s * 6.5;
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(rx + 3, sy, rw - 6, 5);

    // Multi-color blinking LEDs
    const led1 = Math.sin(timeMs / 180 + s * 1.5) > 0;
    const led2 = Math.cos(timeMs / 220 + s * 2.3) > 0;
    const led3 = Math.sin(timeMs / 140 + s * 0.8) > 0;

    ctx.fillStyle = led1 ? '#22c55e' : '#14532d';
    ctx.beginPath();
    ctx.arc(rx + 6, sy + 2.5, 1.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = led2 ? '#38bdf8' : '#075985';
    ctx.beginPath();
    ctx.arc(rx + 11, sy + 2.5, 1.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = led3 ? '#f59e0b' : '#78350f';
    ctx.beginPath();
    ctx.arc(rx + 16, sy + 2.5, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Server Rack Name tag
  if (item.label) {
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 7px "JetBrains Mono", monospace';
    ctx.fillText(item.label, rx + 2, ry + rh + 8);
  }
}

function renderBookshelf(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = '#292524';
  ctx.fillRect(x + 4, y + 4, 40, 40);
  ctx.strokeStyle = '#57534e';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + 4, y + 4, 40, 40);

  const colors = ['#dc2626', '#2563eb', '#16a34a', '#d97706', '#9333ea', '#0284c7', '#ea580c'];
  for (let shelf = 0; shelf < 3; shelf++) {
    const sy = y + 7 + shelf * 12;
    for (let b = 0; b < 7; b++) {
      ctx.fillStyle = colors[(shelf * 7 + b) % colors.length];
      const h = 7 + ((b * 3) % 4);
      ctx.fillRect(x + 6 + b * 5, sy + (10 - h), 4, h);
    }
  }
}

function renderPlant(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  type: 'monstera' | 'snake' | 'palm' | 'fig' | 'succulent' | 'bamboo',
  timeMs: number
) {
  const px = x + 24;
  const py = y + 24;

  // Slow, slight leaf movement; the pot remains grounded.
  ctx.save();
  ctx.translate(Math.sin(timeMs / 2800 + x * 0.02) * 0.7, 0);
  // Plant Pot
  ctx.fillStyle = type === 'fig' ? '#9a3412' : '#f8fafc';
  ctx.beginPath();
  ctx.arc(px, py + 2, 7.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1;
  ctx.stroke();

  if (type === 'snake') {
    // Tall Architectural Snake Plant Leaves
    ctx.fillStyle = '#15803d';
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 0.8;
    for (let l = -5; l <= 5; l += 3) {
      const h = 16 - Math.abs(l) * 1.5;
      ctx.beginPath();
      ctx.moveTo(px + l - 1.5, py);
      ctx.lineTo(px + l, py - h);
      ctx.lineTo(px + l + 1.5, py);
      ctx.fill();
      ctx.stroke();
    }
  } else if (type === 'fig') {
    // Fiddle Leaf Fig Tree
    ctx.fillStyle = '#166534';
    ctx.beginPath();
    ctx.arc(px - 5, py - 9, 6.5, 0, Math.PI * 2);
    ctx.arc(px + 5, py - 11, 7.5, 0, Math.PI * 2);
    ctx.arc(px, py - 18, 9, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === 'bamboo') {
    // Bamboo Acoustic Stalks
    ctx.fillStyle = '#65a30d';
    for (let b = -6; b <= 6; b += 3) {
      ctx.fillRect(px + b, py - 18, 1.5, 18);
    }
    ctx.fillStyle = '#84cc16';
    ctx.beginPath();
    ctx.arc(px, py - 16, 7, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === 'succulent') {
    // Desktop Bonsai / Succulent
    ctx.fillStyle = '#10b981';
    ctx.beginPath();
    ctx.arc(px, py - 4, 5, 0, Math.PI * 2);
    ctx.arc(px - 3, py - 7, 4, 0, Math.PI * 2);
    ctx.arc(px + 3, py - 7, 4, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Monstera / Palm
    ctx.fillStyle = '#16a34a';
    ctx.beginPath();
    ctx.arc(px - 6, py - 6, 7, 0, Math.PI * 2);
    ctx.arc(px + 6, py - 7, 8, 0, Math.PI * 2);
    ctx.arc(px, py - 15, 8.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function renderEspressoMachine(ctx: CanvasRenderingContext2D, x: number, y: number, timeMs: number) {
  // Italian Chrome Espresso Machine
  ctx.fillStyle = '#475569';
  ctx.fillRect(x + 10, y + 8, 28, 22);
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + 10, y + 8, 28, 22);

  // Dual Groupheads & Gauges
  ctx.fillStyle = '#0ea5e9';
  ctx.fillRect(x + 14, y + 13, 20, 5);

  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.arc(x + 16, y + 23, 2, 0, Math.PI * 2);
  ctx.arc(x + 32, y + 23, 2, 0, Math.PI * 2);
  ctx.fill();

  // Animated Steam Wisps
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  const steamOffset = Math.sin(timeMs / 250) * 3;
  ctx.beginPath();
  ctx.arc(x + 24, y + 3 + steamOffset, 3, 0, Math.PI * 2);
  ctx.arc(x + 26, y - 3 + steamOffset, 4, 0, Math.PI * 2);
  ctx.fill();
}

function renderWaterCooler(ctx: CanvasRenderingContext2D, x: number, y: number, timeMs: number) {
  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(x + 16, y + 16, 16, 20);

  // Cold Water Bottle with air bubble
  ctx.fillStyle = '#38bdf8';
  ctx.beginPath();
  ctx.arc(x + 24, y + 10, 7.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  const bubbleY = Math.sin(timeMs / 300) * 3;
  ctx.beginPath();
  ctx.arc(x + 25, y + 10 + bubbleY, 1.5, 0, Math.PI * 2);
  ctx.fill();
}

function renderKitchenCounter(ctx: CanvasRenderingContext2D, x: number, y: number, theme: 'dark' | 'light') {
  // Marble Countertop with Sink
  ctx.fillStyle = theme === 'dark' ? '#1e293b' : '#cbd5e1';
  ctx.fillRect(x + 4, y + 8, 40, 26);
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + 4, y + 8, 40, 26);

  // Stainless Undermount Sink
  ctx.fillStyle = '#64748b';
  ctx.fillRect(x + 14, y + 13, 18, 14);
  ctx.fillStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.arc(x + 23, y + 11, 2, 0, Math.PI * 2);
  ctx.fill();
}

function renderFridge(ctx: CanvasRenderingContext2D, x: number, y: number) {
  // Stainless Double Refrigerator
  ctx.fillStyle = '#94a3b8';
  ctx.fillRect(x + 10, y + 4, 28, 38);
  ctx.strokeStyle = '#64748b';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x + 10, y + 4, 28, 38);

  // Door handles
  ctx.fillStyle = '#334155';
  ctx.fillRect(x + 22, y + 10, 2, 10);
  ctx.fillRect(x + 25, y + 10, 2, 10);
}

function renderSofa(ctx: CanvasRenderingContext2D, x: number, y: number) {
  // Modern Sectional Sofa in Rich Teal
  ctx.fillStyle = '#0f766e';
  ctx.beginPath();
  ctx.roundRect(x + 4, y + 12, 40, 24, 6);
  ctx.fill();

  // Padded Backrest
  ctx.fillStyle = '#115e59';
  ctx.beginPath();
  ctx.roundRect(x + 4, y + 6, 40, 10, 4);
  ctx.fill();

  // Accent Throw Pillows
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.roundRect(x + 8, y + 14, 8, 8, 2);
  ctx.fill();
}

function renderSnackTable(ctx: CanvasRenderingContext2D, x: number, y: number) {
  // Round Bistro Table with Donuts & Coffee
  ctx.fillStyle = '#78350f';
  ctx.beginPath();
  ctx.arc(x + 24, y + 24, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#b45309';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Pastry Box / Donuts
  ctx.fillStyle = '#f43f5e';
  ctx.fillRect(x + 18, y + 18, 12, 9);
  ctx.fillStyle = '#fde047';
  ctx.fillRect(x + 20, y + 20, 8, 5);
}

function renderHVAC(ctx: CanvasRenderingContext2D, x: number, y: number, timeMs: number) {
  ctx.fillStyle = '#e2e8f0';
  ctx.fillRect(x + 8, y + 2, 32, 12);
  ctx.fillStyle = '#38bdf8';
  const flow = Math.sin(timeMs / 200) * 2;
  ctx.fillRect(x + 12, y + 8 + flow, 24, 1.5);
}

function renderAgentItem(
  ctx: CanvasRenderingContext2D, agent: Agent, rot: number,
  selectedAgentId: string | null, hoveredAgentId: string | null,
  timeMs: number, theme: 'dark' | 'light', nowMs: number
) {
  const { x, y } = gridToScreen(agent.x, agent.y, rot);
  const cx = x + TILE_SIZE / 2;
  const ground = y + TILE_SIZE / 2 + 12;
  const phase = [...agent.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const walking = agent.isWalking;
  const speaking = isSpeechActive(agent.speechBubble, nowMs);
  const typing = !walking && ['CODING', 'TESTING', 'USING_TOOL', 'WRITING'].includes(agent.status);
  const seated = !walking && (typing || agent.status === 'IN_MEETING');
  const selected = agent.id === selectedAgentId;
  const hovered = agent.id === hoveredAgentId;
  const cycle = timeMs / 130 + phase;
  const bob = walking ? Math.sin(cycle * 2) * 1.5 : Math.sin(timeMs / 950 + phase) * 0.45;
  const torsoY = ground - (seated ? 23 : 28) + bob;
  const skin = ['#e8b89a', '#c58e6f', '#f2cfb1', '#ad7656'][phase % 4];
  const palette = statusAppearance(agent.status);
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.beginPath(); ctx.ellipse(cx, ground + 1, 13, 5, 0, 0, Math.PI * 2); ctx.fill();
  if (selected || hovered || speaking) {
    ctx.strokeStyle = selected ? '#38bdf8' : speaking ? palette.color : '#a5b4fc';
    ctx.lineWidth = selected ? 2 : 1.2;
    ctx.globalAlpha = speaking ? 0.65 + Math.sin(timeMs / 350) * 0.15 : 0.8;
    ctx.beginPath(); ctx.ellipse(cx, ground + 1, 17, 7, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // Chair and bent legs make working and meeting poses distinct from standing.
  if (seated) {
    ctx.fillStyle = theme === 'dark' ? '#475569' : '#94a3b8';
    ctx.beginPath(); ctx.roundRect(cx - 10, torsoY + 4, 20, 18, 6); ctx.fill();
    ctx.strokeStyle = '#64748b'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(cx, torsoY + 20); ctx.lineTo(cx, ground + 3); ctx.stroke();
  }
  ctx.strokeStyle = '#27344c'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    const stride = walking ? Math.sin(cycle) * 5 * side : 0;
    ctx.beginPath(); ctx.moveTo(cx + side * 3.5, torsoY + 13);
    ctx.lineTo(cx + side * (seated ? 7 : 4) + stride, ground - 2); ctx.stroke();
    ctx.fillStyle = '#111827';
    ctx.beginPath(); ctx.roundRect(cx + side * (seated ? 7 : 4) + stride - 3, ground - 3, 7, 3.5, 1.5); ctx.fill();
  }
  const cloth = ctx.createLinearGradient(cx - 8, torsoY, cx + 8, torsoY + 15);
  cloth.addColorStop(0, agent.clothingColor); cloth.addColorStop(1, agent.avatarColor);
  ctx.fillStyle = cloth;
  ctx.beginPath(); ctx.roundRect(cx - 8, torsoY, 16, 15, 5); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(cx, torsoY + 4); ctx.lineTo(cx, torsoY + 13); ctx.stroke();
  // Arms: relaxed, walking, typing, or gesturing during an emitted message.
  for (const side of [-1, 1]) {
    const lift = walking ? Math.sin(cycle) * 3 * -side : typing ? Math.sin(timeMs / 100 + side) * 1.5 : speaking ? 4 + Math.sin(timeMs / 260 + side) * 2 : 0;
    const handX = cx + side * (typing ? 5 : speaking ? 13 : 10);
    const handY = torsoY + (typing ? 7 : speaking ? 4 : 12) - lift;
    ctx.strokeStyle = agent.clothingColor; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(cx + side * 6, torsoY + 3); ctx.lineTo(handX, handY); ctx.stroke();
    ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(handX, handY, 2.2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = skin; ctx.fillRect(cx - 2, torsoY - 3, 4, 5);
  const headY = torsoY - 8;
  ctx.fillStyle = skin; ctx.beginPath(); ctx.ellipse(cx, headY, 7.4, 8.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = agent.hairColor;
  ctx.beginPath(); ctx.arc(cx, headY - 1, 7.6, Math.PI, Math.PI * 2); ctx.lineTo(cx + 6, headY - 2); ctx.quadraticCurveTo(cx, headY - 6, cx - 6, headY - 2); ctx.fill();
  const blink = (timeMs + phase * 31) % 4700 < 130;
  const faceOffset = agent.facing === 'SE' || agent.facing === 'NE' ? 1 : -1;
  ctx.fillStyle = '#242b3a';
  for (const eye of [-1, 1]) {
    ctx.beginPath(); ctx.ellipse(cx + eye * 2.3 + faceOffset, headY + 1, 0.8, blink ? 0.2 : 1.1, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = '#97664e'; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.arc(cx + faceOffset, headY + 4, speaking ? 1.5 : 1.1, 0, Math.PI); ctx.stroke();
  if (agent.accessory === 'glasses') {
    ctx.strokeStyle = '#334155'; ctx.lineWidth = 1;
    ctx.strokeRect(cx - 5 + faceOffset, headY - 1, 4, 3.5); ctx.strokeRect(cx + 1 + faceOffset, headY - 1, 4, 3.5);
    ctx.beginPath(); ctx.moveTo(cx - 1 + faceOffset, headY); ctx.lineTo(cx + 1 + faceOffset, headY); ctx.stroke();
  } else if (agent.accessory === 'headphones') {
    ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, headY - 1, 8.5, Math.PI, 0); ctx.stroke();
    ctx.fillStyle = agent.avatarColor; ctx.fillRect(cx - 9, headY - 2, 3, 6); ctx.fillRect(cx + 6, headY - 2, 3, 6);
  } else if (agent.accessory === 'tie') {
    ctx.fillStyle = '#e2e8f0'; ctx.beginPath(); ctx.moveTo(cx - 4, torsoY); ctx.lineTo(cx, torsoY + 4); ctx.lineTo(cx + 4, torsoY); ctx.fill();
    ctx.fillStyle = '#fb7185'; ctx.beginPath(); ctx.moveTo(cx, torsoY + 3); ctx.lineTo(cx - 2, torsoY + 10); ctx.lineTo(cx, torsoY + 12); ctx.lineTo(cx + 2, torsoY + 10); ctx.fill();
  } else if (agent.accessory === 'hoodie') {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - 3, torsoY + 2); ctx.lineTo(cx - 3, torsoY + 7); ctx.moveTo(cx + 3, torsoY + 2); ctx.lineTo(cx + 3, torsoY + 7); ctx.stroke();
  } else if (agent.accessory === 'badge') {
    ctx.fillStyle = '#e2e8f0'; ctx.fillRect(cx + 2, torsoY + 5, 4, 5);
    ctx.fillStyle = agent.avatarColor; ctx.fillRect(cx + 3, torsoY + 6, 2, 2);
  }
  if (!walking && agent.status === 'THINKING') {
    ctx.fillStyle = '#fbbf24';
    for (let i = 0; i < 3; i++) { ctx.globalAlpha = 0.3 + (Math.sin(timeMs / 300 - i) + 1) * 0.3; ctx.beginPath(); ctx.arc(cx + 12 + i * 4, headY - 3, 1.7, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

function statusAppearance(status: Agent['status']) {
  const colors: Partial<Record<Agent['status'], string>> = {
    CODING: '#34d399', WRITING: '#34d399', DONE: '#4ade80',
    TESTING: '#38bdf8', USING_TOOL: '#38bdf8', RESEARCHING: '#38bdf8', READING: '#38bdf8',
    IN_MEETING: '#c4b5fd', REVIEWING: '#c4b5fd',
    BLOCKED: '#fb923c', WAITING_APPROVAL: '#fbbf24', ERROR: '#fb7185',
    DELEGATING: '#fbbf24', DELIVERING: '#fbbf24', THINKING: '#facc15',
  };
  return { color: colors[status] ?? '#94a3b8', label: status.replaceAll('_', ' ') };
}

function shortRole(agent: Agent) {
  const roles: Record<Agent['role'], string> = { boss: 'Director', tech_lead: 'Tech lead', research_lead: 'Research', backend_engineer: 'Backend', frontend_engineer: 'Frontend', qa_engineer: 'QA', security_analyst: 'Security' };
  return roles[agent.role];
}

function drawAgentOverlays(rc: RenderContext) {
  const { ctx, agents, camera, width, height, nowMs, timeMs, theme } = rc;
  const center = cameraCenter(width, height);
  const anchors = agents.filter(agent => camera.zoom >= 0.55 || agent.id === rc.selectedAgentId || agent.id === rc.hoveredAgentId || isSpeechActive(agent.speechBubble, nowMs)).map(agent => {
    const world = gridToScreen(agent.x, agent.y, camera.rotation);
    return { agent, x: center.x + (world.x + TILE_SIZE / 2 + camera.x) * camera.zoom,
      y: center.y + (world.y - 13 + camera.y) * camera.zoom };
  }).filter(anchor => anchor.x > -20 && anchor.x < width + 20 && anchor.y > -20 && anchor.y < height + 20);
  // Reserve heads before laying out cards, so labels cannot hide another character.
  const occupied: OverlayRect[] = anchors.map(a => ({ x: a.x - 15, y: a.y - 5, width: 30, height: 46 }));
  const labels = new Map<string, OverlayRect>();
  const foreground = theme === 'dark' ? '#f1f5f9' : '#0f172a';
  const background = theme === 'dark' ? 'rgba(13,21,36,0.96)' : 'rgba(255,255,255,0.97)';
  ctx.save();
  for (const a of [...anchors].sort((a, b) => a.y - b.y)) {
    const { color, label } = statusAppearance(a.agent.status);
    const name = a.agent.role === 'boss' ? 'Director' : a.agent.name;
    ctx.font = '600 10px "Plus Jakarta Sans", sans-serif';
    const subtitle = shortRole(a.agent) + ' · ' + label;
    const subtitleWidth = ctx.measureText(subtitle).width + 26;
    ctx.font = '700 11px "Plus Jakarta Sans", sans-serif';
    const cardWidth = Math.max(112, Math.min(190, Math.max(subtitleWidth, ctx.measureText(name).width + 34)));
    const card = placeOverlay({ x: a.x - cardWidth / 2, y: a.y - 46, width: cardWidth, height: 38 }, occupied, { width, height });
    occupied.push(card); labels.set(a.agent.id, card);
    ctx.strokeStyle = color; ctx.globalAlpha = 0.4; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(card.x + card.width / 2, card.y + card.height); ctx.lineTo(a.x, a.y); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 9; ctx.shadowOffsetY = 3;
    ctx.fillStyle = background; ctx.beginPath(); ctx.roundRect(card.x, card.y, card.width, card.height, 9); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.strokeStyle = a.agent.id === rc.selectedAgentId ? '#38bdf8' : theme === 'dark' ? '#334155' : '#cbd5e1'; ctx.stroke();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(card.x + 12, card.y + 12, 3, 0, Math.PI * 2); ctx.fill();
    ctx.font = '700 11px "Plus Jakarta Sans", sans-serif'; ctx.fillStyle = foreground; ctx.textAlign = 'left';
    ctx.fillText(wrapText(name, card.width - 34, t => ctx.measureText(t).width, 1)[0], card.x + 21, card.y + 16);
    ctx.font = '500 9px "Plus Jakarta Sans", sans-serif'; ctx.fillStyle = theme === 'dark' ? '#a9b7ca' : '#526176';
    ctx.fillText(wrapText(subtitle, card.width - 20, t => ctx.measureText(t).width, 1)[0], card.x + 10, card.y + 30);
  }
  for (const a of anchors) {
    if (!isSpeechActive(a.agent.speechBubble, nowMs)) continue;
    const speech = a.agent.speechBubble!;
    ctx.font = '500 12px "Plus Jakarta Sans", sans-serif';
    const maxWidth = Math.min(250, width - 32);
    const lines = wrapText(speech.text, maxWidth - 24, t => ctx.measureText(t).width, 2);
    const badge = labels.get(a.agent.id)!;
    const card = placeOverlay({ x: a.x - maxWidth / 2, y: badge.y - (lines.length * 17 + 40), width: maxWidth, height: lines.length * 17 + 32 }, occupied, { width, height });
    occupied.push(card);
    const remaining = speech.expiresAt - nowMs;
    ctx.globalAlpha = Math.min(1, remaining / 250);
    const { color } = statusAppearance(a.agent.status);
    ctx.strokeStyle = color; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(card.x + card.width / 2, card.y + card.height); ctx.lineTo(a.x, a.y - 4); ctx.stroke();
    ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 4;
    ctx.fillStyle = background; ctx.beginPath(); ctx.roundRect(card.x, card.y, card.width, card.height, 11); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; ctx.stroke();
    ctx.font = '700 9px "Plus Jakarta Sans", sans-serif'; ctx.fillStyle = color;
    const speaker = a.agent.role === 'boss' ? 'Director' : a.agent.name.split(' ')[0];
    const header = speech.targetAgentName ? speaker + ' → ' + speech.targetAgentName : speaker + (a.agent.status === 'IN_MEETING' ? ' · MEETING' : ' · ACTIVITY');
    ctx.fillText(wrapText(header, card.width - 34, t => ctx.measureText(t).width, 1)[0], card.x + 12, card.y + 16);
    ctx.font = '500 12px "Plus Jakarta Sans", sans-serif'; ctx.fillStyle = foreground;
    lines.forEach((line, i) => ctx.fillText(line, card.x + 12, card.y + 34 + i * 17));
    // Speaker dots follow a real, unexpired message, not invented dialogue.
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(card.x + card.width - 23 + i * 5, card.y + 13, 1.3 + Math.max(0, Math.sin(timeMs / 220 - i)) * 0.7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawMessageConnections(ctx: CanvasRenderingContext2D, rot: number, agents: Agent[], timeMs: number, nowMs: number) {
  ctx.save();
  for (const agent of agents) {
    if (!isSpeechActive(agent.speechBubble, nowMs) || !agent.speechBubble?.targetAgentName) continue;
    const target = agents.find(a => a.id !== agent.id && (a.name === agent.speechBubble!.targetAgentName || a.name.startsWith(agent.speechBubble!.targetAgentName!)));
    if (!target) continue;
    const from = gridToScreen(agent.x, agent.y, rot); const to = gridToScreen(target.x, target.y, rot);
    const ax = from.x + 24, ay = from.y + 24, bx = to.x + 24, by = to.y + 24;
    ctx.strokeStyle = '#a5b4fc'; ctx.globalAlpha = 0.35; ctx.lineWidth = 1.5; ctx.setLineDash([4, 6]); ctx.lineDashOffset = -timeMs / 80;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
    const t = (timeMs / 1800) % 1;
    ctx.globalAlpha = 0.8; ctx.fillStyle = '#c4b5fd'; ctx.beginPath(); ctx.arc(ax + (bx - ax) * t, ay + (by - ay) * t, 2.8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function renderFloorLamp(ctx: CanvasRenderingContext2D, x: number, y: number, theme: 'dark' | 'light') {
  const cx = x + 24, cy = y + 28;
  ctx.fillStyle = '#475569'; ctx.beginPath(); ctx.ellipse(cx, cy, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#94a3b8'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - 26); ctx.stroke();
  const halo = ctx.createRadialGradient(cx, cy - 23, 1, cx, cy - 23, 25);
  halo.addColorStop(0, theme === 'dark' ? 'rgba(251,191,113,0.22)' : 'rgba(251,191,113,0.12)'); halo.addColorStop(1, 'rgba(251,191,113,0)');
  ctx.fillStyle = halo; ctx.fillRect(cx - 25, cy - 48, 50, 50);
  ctx.fillStyle = '#f0d5a3'; ctx.beginPath(); ctx.moveTo(cx - 7, cy - 26); ctx.lineTo(cx + 7, cy - 26); ctx.lineTo(cx + 11, cy - 16); ctx.lineTo(cx - 11, cy - 16); ctx.closePath(); ctx.fill();
}

function drawRoomAtmosphere(ctx: CanvasRenderingContext2D, rot: number, theme: 'dark' | 'light', locale: Locale) {
  const names: Record<string, string> = Object.fromEntries(OFFICE_ROOMS.map((room) => [room.id, t(locale, `rooms.${room.id}` as Parameters<typeof t>[1])]));
  const accents: Record<string, string> = { boss_office: '#b8a3e6', meeting_room: '#818cf8', server_room: '#38bdf8', leads_area: '#a5b4fc', development: '#34d399', qa_lab: '#38bdf8', research_area: '#d8b48a', break_room: '#e6b77a', lounge: '#5eead4' };
  ctx.save();
  for (const room of OFFICE_ROOMS) {
    const rect = getRoomScreenRect(room.gridX, room.gridY, room.width, room.height, rot);
    ctx.save(); ctx.beginPath(); ctx.rect(rect.x + 3, rect.y + 3, rect.width - 6, rect.height - 6); ctx.clip();
    const warm = ['wood', 'executive'].includes(room.floorPattern) || room.id === 'break_room';
    const glow = ctx.createRadialGradient(rect.x + rect.width * 0.65, rect.y + rect.height * 0.35, 1, rect.x + rect.width * 0.65, rect.y + rect.height * 0.35, Math.max(rect.width, rect.height) * 0.7);
    glow.addColorStop(0, warm ? 'rgba(251,191,113,0.08)' : 'rgba(56,189,248,0.07)'); glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow; ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    if (room.floorPattern === 'wood' || room.floorPattern === 'executive') {
      ctx.strokeStyle = theme === 'dark' ? 'rgba(225,195,155,0.05)' : 'rgba(115,82,52,0.08)'; ctx.lineWidth = 1;
      for (let yy = rect.y + 8; yy < rect.y + rect.height; yy += 12) { ctx.beginPath(); ctx.moveTo(rect.x + 4, yy); ctx.lineTo(rect.x + rect.width - 4, yy); ctx.stroke(); }
    }
    ctx.restore();
    const accent = accents[room.id];
    ctx.fillStyle = theme === 'dark' ? 'rgba(12,19,32,0.9)' : 'rgba(255,255,255,0.94)';
    ctx.font = '700 10px "Plus Jakarta Sans", sans-serif';
    const label = names[room.id]; const plaqueWidth = Math.min(rect.width - 18, ctx.measureText(label).width + 29);
    ctx.beginPath(); ctx.roundRect(rect.x + 9, rect.y + 7, plaqueWidth, 22, 6); ctx.fill();
    ctx.fillStyle = accent; ctx.fillRect(rect.x + 15, rect.y + 13, 3, 10);
    ctx.textAlign = 'left'; ctx.fillStyle = theme === 'dark' ? '#b7c6d9' : '#475569'; ctx.fillText(label, rect.x + 24, rect.y + 22);
  }
  ctx.restore();
}
