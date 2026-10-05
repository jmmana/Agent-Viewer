import { Agent, WorkspaceZone } from '../types/agent';
import {
  FurnitureItem,
  GRID_COLS,
  GRID_ROWS,
  gridToScreen,
  OFFICE_FURNITURE,
  OFFICE_HALLWAYS,
  OFFICE_ROOMS,
  rotateGrid,
  RoomZone,
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
}

/**
 * Renders the full 2.5D Rectangular Architectural Office.
 * Screen-aligned, rectangular layout (NO diamond / rhombus!) that fills the viewport cleanly.
 */
export function renderOfficeScene(rc: RenderContext) {
  const { ctx, width, height, camera, agents, selectedAgentId, hoveredAgentId, activeMeetingId, timeMs, theme } = rc;
  const rot = ((camera.rotation % 4) + 4) % 4;

  ctx.clearRect(0, 0, width, height);

  // Background field
  ctx.fillStyle = theme === 'dark' ? '#090d16' : '#f8fafc';
  ctx.fillRect(0, 0, width, height);

  // Apply camera pan, zoom and center transform to exact visual center of available area
  ctx.save();
  const effectiveCenterX = width / 2;
  const effectiveCenterY = height / 2 - 12;
  ctx.translate(effectiveCenterX, effectiveCenterY);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(camera.x, camera.y);

  // 1. Exterior Window Skyline & Building Ambient Contact Shadow
  drawBuildingBackdrop(ctx, rot, theme, timeMs);

  // 2. Floor tiles for rooms and designated interconnecting hallways
  drawFloorRooms(ctx, rot, theme, activeMeetingId, timeMs);

  // 3. Architectural interior walls, glass partitions & doorways
  drawArchitecturalWalls(ctx, rot, theme);

  // 4. Depth-sorted Entities (Furniture and Agents rendered in 2.5D perspective)
  drawDepthSortedEntities(ctx, rot, agents, selectedAgentId, hoveredAgentId, activeMeetingId, timeMs, theme);

  // 5. Speech bubbles above agents
  drawSpeechBubbles(ctx, rot, agents, timeMs);

  ctx.restore();
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
            : (theme === 'dark' ? '#27225d' : '#e0e7ff');
        } else if (room.floorPattern === 'concrete') {
          // Raised server floor grid
          ctx.fillStyle = (gx + gy) % 2 === 0
            ? (theme === 'dark' ? '#0f172a' : '#cbd5e1')
            : (theme === 'dark' ? '#141d33' : '#d8e1ea');
        } else if (room.floorPattern === 'carpet') {
          // Acoustic woven carpet
          ctx.fillStyle = (gx + gy) % 2 === 0
            ? (theme === 'dark' ? '#151d30' : '#e2e8f0')
            : (theme === 'dark' ? '#1a243b' : '#dbeafe');
        } else if (room.floorPattern === 'wood') {
          // Natural warm oak planks
          ctx.fillStyle = (gx + gy) % 2 === 0
            ? (theme === 'dark' ? '#1b2230' : '#fef3c7')
            : (theme === 'dark' ? '#1e2637' : '#fde68a');
        } else {
          // Modern kitchen / lab ceramic tile
          ctx.fillStyle = (gx + gy) % 2 === 0
            ? (theme === 'dark' ? '#111827' : '#ffffff')
            : (theme === 'dark' ? '#161f30' : '#f8fafc');
        }

        ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);

        ctx.strokeStyle = theme === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.04)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
      }
    }

    // Room Label positioned at the top-left of the room rect
    const roomRect = getRoomScreenRect(room.gridX, room.gridY, room.width, room.height, rot);
    ctx.save();
    ctx.font = '700 11px "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = theme === 'dark' ? 'rgba(148, 163, 184, 0.65)' : 'rgba(71, 85, 105, 0.75)';
    ctx.textAlign = 'left';
    ctx.fillText(room.name.toUpperCase(), roomRect.x + 10, roomRect.y + 16);
    ctx.restore();
  }

  // Draw Area Rugs with rich ambient colors
  // 1. Executive Geometric Area Rug in Boss Office
  drawRectAreaRug(ctx, 1, 1, 5, 4, rot, '#2e1065', '#a855f7');
  // 2. Emerald Plush Rug in Team Lounge
  drawRectAreaRug(ctx, 18, 13, 5, 2.8, rot, '#134e4a', '#14b8a6');
  // 3. Antique Warm Rug in RAG Research Library
  drawRectAreaRug(ctx, 3, 13, 3, 2.8, rot, '#3b1d11', '#b45309');
  // 4. Yellow/Black Security Hazard Stripes along Server Vault threshold
  drawServerHazardStripes(ctx, 17, 5, 7, 1, rot);
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
  theme: 'dark' | 'light'
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
      renderAgentItem(ctx, ent.agent, rot, selectedAgentId, hoveredAgentId, timeMs, theme);
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
    renderPlant(ctx, x, y, item.plantType || 'monstera');
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
    const rgbHue = (timeMs / 8) % 360;
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
  if (item.label) {
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
      ctx.fillText('RFC 7636 PKCE REVIEW', px + 7, py + 14);

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
    ctx.fillText('CI/CD: 48/48 PASS', px + 6, py + 13);
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(px + 6, py + 18, 48, 4);
  } else if (item.id === 'f_server_noc') {
    // NOC Server Vault Monitor
    ctx.fillStyle = '#090d16';
    ctx.fillRect(px + 4, py + 4, sw - 8, sh - 8);

    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
    ctx.fillText('NOC UPTIME 99.99%', px + 6, py + 13);

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
  type: 'monstera' | 'snake' | 'palm' | 'fig' | 'succulent' | 'bamboo'
) {
  const px = x + 24;
  const py = y + 24;

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
  ctx: CanvasRenderingContext2D,
  agent: Agent,
  rot: number,
  selectedAgentId: string | null,
  hoveredAgentId: string | null,
  timeMs: number,
  theme: 'dark' | 'light'
) {
  if (agent.isWalking) {
    const dx = agent.targetX - agent.x;
    const dy = agent.targetY - agent.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 0.08) {
      agent.x = agent.targetX;
      agent.y = agent.targetY;
      agent.isWalking = false;
    } else {
      const step = 0.05;
      agent.x += (dx / dist) * step;
      agent.y += (dy / dist) * step;

      if (Math.abs(dx) > Math.abs(dy)) {
        agent.facing = dx > 0 ? 'SE' : 'NW';
      } else {
        agent.facing = dy > 0 ? 'SW' : 'NE';
      }
    }
  }

  const { x, y } = gridToScreen(agent.x, agent.y, rot);
  const charCenterX = x + TILE_SIZE / 2;
  const charCenterY = y + TILE_SIZE / 2;

  const isSelected = agent.id === selectedAgentId;
  const isHovered = agent.id === hoveredAgentId;

  ctx.save();

  // Shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.beginPath();
  ctx.ellipse(charCenterX, charCenterY + 12, 13, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // Selection target ring
  if (isSelected || isHovered) {
    ctx.strokeStyle = isSelected ? '#38bdf8' : '#818cf8';
    ctx.lineWidth = isSelected ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.ellipse(charCenterX, charCenterY + 12, 16, 8, 0, 0, Math.PI * 2);
    ctx.stroke();

    if (isSelected) {
      const pulse = Math.sin(timeMs / 200) * 3 + 18;
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
      ctx.beginPath();
      ctx.ellipse(charCenterX, charCenterY + 12, pulse, pulse / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  const bob = agent.isWalking ? Math.sin(timeMs / 110) * 3.5 : Math.sin(timeMs / 600) * 1;
  const charY = charCenterY - 14 + bob;

  // Legs with walk cycle
  const legPhase = agent.isWalking ? Math.sin(timeMs / 90) * 5 : 0;
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.moveTo(charCenterX - 3.5, charY + 12);
  ctx.lineTo(charCenterX - 4 + legPhase, charY + 20);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(charCenterX + 3.5, charY + 12);
  ctx.lineTo(charCenterX + 4 - legPhase, charY + 20);
  ctx.stroke();

  // Torso / Clothing
  ctx.fillStyle = agent.clothingColor;
  ctx.beginPath();
  ctx.roundRect(charCenterX - 7.5, charY, 15, 14, 4);
  ctx.fill();

  // Accessories
  if (agent.accessory === 'tie') {
    ctx.fillStyle = '#dc2626';
    ctx.beginPath();
    ctx.moveTo(charCenterX, charY + 2);
    ctx.lineTo(charCenterX - 2, charY + 10);
    ctx.lineTo(charCenterX, charY + 13);
    ctx.lineTo(charCenterX + 2, charY + 10);
    ctx.closePath();
    ctx.fill();
  } else if (agent.accessory === 'badge') {
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(charCenterX + 2, charY + 4, 3, 4);
  }

  // Head & Skin
  ctx.fillStyle = '#fcd34d';
  ctx.beginPath();
  ctx.arc(charCenterX, charY - 6, 7.5, 0, Math.PI * 2);
  ctx.fill();

  // Hair
  ctx.fillStyle = agent.hairColor;
  ctx.beginPath();
  ctx.arc(charCenterX, charY - 9, 7.8, Math.PI * 0.9, Math.PI * 2.1);
  ctx.fill();

  // Eyes
  ctx.fillStyle = '#1e293b';
  const faceOffset = agent.facing === 'SE' ? 1.5 : -1.5;
  ctx.beginPath();
  ctx.arc(charCenterX - 2 + faceOffset, charY - 6, 1.2, 0, Math.PI * 2);
  ctx.arc(charCenterX + 2 + faceOffset, charY - 6, 1.2, 0, Math.PI * 2);
  ctx.fill();

  // Typing hands when coding/testing
  if (agent.status === 'CODING' || agent.status === 'TESTING' || agent.status === 'USING_TOOL') {
    const typeHand = Math.sin(timeMs / 80) * 2;
    ctx.fillStyle = '#fcd34d';
    ctx.beginPath();
    ctx.arc(charCenterX - 5, charY + 6 + typeHand, 2, 0, Math.PI * 2);
    ctx.arc(charCenterX + 5, charY + 6 - typeHand, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Floating Status Badge Above Head
  drawAgentStatusBadge(ctx, agent, charCenterX, charY - 22, timeMs);

  ctx.restore();
}

function drawAgentStatusBadge(
  ctx: CanvasRenderingContext2D,
  agent: Agent,
  x: number,
  y: number,
  timeMs: number
) {
  const status = agent.status;
  const firstName = agent.name.split(' ')[0];

  // Format short role
  let shortRole = 'Agent';
  if (agent.role === 'boss') shortRole = 'Executive';
  else if (agent.role === 'tech_lead') shortRole = 'Tech Lead';
  else if (agent.role === 'research_lead') shortRole = 'Research';
  else if (agent.role === 'backend_engineer') shortRole = 'Backend';
  else if (agent.role === 'frontend_engineer') shortRole = 'Frontend';
  else if (agent.role === 'security_analyst') shortRole = 'Security';
  else if (agent.role === 'qa_engineer') shortRole = 'QA Lead';

  // Status configuration with clean color palette
  let statusColor = '#94a3b8'; // IDLE = slate/azulado
  let icon = '●';
  let statusText = 'IDLE';

  if (status === 'CODING') {
    statusColor = '#34d399'; // WORKING = verde/teal
    icon = '⚡';
    statusText = 'CODING';
  } else if (status === 'IN_MEETING') {
    statusColor = '#c084fc'; // MEETING = morado/cian
    icon = '👥';
    statusText = 'MEETING';
  } else if (status === 'TESTING') {
    statusColor = '#38bdf8'; // TESTING = cyan/teal
    icon = '🧪';
    statusText = 'TESTING';
  } else if (status === 'RESEARCHING' || status === 'USING_TOOL') {
    statusColor = '#38bdf8'; // TOOL = sky
    icon = '🔍';
    statusText = status === 'USING_TOOL' ? 'TOOL' : 'RESEARCH';
  } else if (status === 'BLOCKED') {
    const pulse = Math.sin(timeMs / 150) > 0;
    statusColor = pulse ? '#f43f5e' : '#fb7185'; // BLOCKED = rojo/naranja
    icon = '⚠️';
    statusText = 'BLOCKED';
  } else if (status === 'DONE') {
    statusColor = '#4ade80';
    icon = '✓';
    statusText = 'DONE';
  } else if (status === 'DELIVERING' || status === 'DELEGATING') {
    statusColor = '#fbbf24';
    icon = '📦';
    statusText = status;
  } else if (status === 'THINKING') {
    statusColor = '#facc15'; // THINKING = amarillo sutil
    icon = '💭';
    statusText = 'THINKING';
  }

  // Two-tier typography calculation
  ctx.font = 'bold 9.5px "Plus Jakarta Sans", sans-serif';
  const nameWidth = ctx.measureText(firstName).width;
  ctx.font = '600 7.5px "JetBrains Mono", monospace';
  const roleStatusText = `${shortRole} · ${icon} ${statusText}`;
  const subWidth = ctx.measureText(roleStatusText).width;

  const cardW = Math.max(nameWidth, subWidth) + 16;
  const cardH = 25;
  const cardX = x - cardW / 2;
  const cardY = y - cardH;

  // Drop Shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.beginPath();
  ctx.roundRect(cardX + 1.5, cardY + 1.5, cardW, cardH, 5);
  ctx.fill();

  // Dark glass background
  ctx.fillStyle = 'rgba(10, 15, 29, 0.94)';
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, 5);
  ctx.fill();

  // Subtle accent border
  ctx.strokeStyle = statusColor;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Downward pointer notch towards the agent
  ctx.fillStyle = 'rgba(10, 15, 29, 0.94)';
  ctx.beginPath();
  ctx.moveTo(x - 3.5, cardY + cardH);
  ctx.lineTo(x, cardY + cardH + 4);
  ctx.lineTo(x + 3.5, cardY + cardH);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = statusColor;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Row 1: Agent Name (Bold, white, prominent)
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 9.5px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(firstName, x, cardY + 10.5);

  // Row 2: Short role + status indicator
  ctx.fillStyle = statusColor;
  ctx.font = '600 7.5px "JetBrains Mono", monospace';
  ctx.fillText(roleStatusText, x, cardY + 20.5);
}

function drawSpeechBubbles(
  ctx: CanvasRenderingContext2D,
  rot: number,
  agents: Agent[],
  timeMs: number
) {
  for (const agent of agents) {
    if (!agent.speechBubble || agent.speechBubble.expiresAt < timeMs) continue;

    const { x, y } = gridToScreen(agent.x, agent.y, rot);
    const bubbleCenterX = x + TILE_SIZE / 2;
    // Position cleanly above the persistent status badge (badge top is ~ y - 48)
    const bubbleY = y - 56;
    const text = agent.speechBubble.text;

    ctx.save();
    ctx.font = '500 10.5px "Plus Jakarta Sans", sans-serif';

    const maxBubbleWidth = 210;
    const words = text.split(' ');
    let lines: string[] = [];
    let currentLine = '';

    for (const w of words) {
      const testLine = currentLine ? `${currentLine} ${w}` : w;
      if (ctx.measureText(testLine).width > maxBubbleWidth) {
        lines.push(currentLine);
        currentLine = w;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) lines.push(currentLine);

    // Limit to max 2 lines for clean, non-intrusive bubbles
    if (lines.length > 2) {
      lines = lines.slice(0, 2);
      lines[1] += '...';
    }

    const lineHeight = 13;
    const bubbleHeight = lines.length * lineHeight + 12;
    const longestLineWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const bubbleWidth = longestLineWidth + 18;
    const bubbleX = bubbleCenterX - bubbleWidth / 2;

    // Soft drop shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.beginPath();
    ctx.roundRect(bubbleX + 2, bubbleY - bubbleHeight + 2, bubbleWidth, bubbleHeight, 7);
    ctx.fill();

    // Dark sleek glass card
    ctx.fillStyle = 'rgba(15, 23, 42, 0.96)';
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.roundRect(bubbleX, bubbleY - bubbleHeight, bubbleWidth, bubbleHeight, 7);
    ctx.fill();
    ctx.stroke();

    // Speech arrow pointer down
    ctx.fillStyle = 'rgba(15, 23, 42, 0.96)';
    ctx.beginPath();
    ctx.moveTo(bubbleCenterX - 4, bubbleY);
    ctx.lineTo(bubbleCenterX, bubbleY + 6);
    ctx.lineTo(bubbleCenterX + 4, bubbleY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#38bdf8';
    ctx.stroke();

    // Bubble text
    ctx.fillStyle = '#f8fafc';
    ctx.textAlign = 'left';
    lines.forEach((line, idx) => {
      ctx.fillText(line, bubbleX + 9, bubbleY - bubbleHeight + 14 + idx * lineHeight);
    });

    ctx.restore();
  }
}
