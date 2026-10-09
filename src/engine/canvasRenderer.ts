import { bubbleExitStyle, cameraCenter, fitBubbleNames, isSpeechActive, placeOverlay, wrapText, type OverlayRect } from './visualLayout';
import type { Agent } from '../types/agent';
import type { OfficeCrewAssets } from './officeCrewAssets';
import type { OfficeFurnitureAssets } from './officeFurnitureAssets';
import { isOfficeMessageKey, type OfficeTranslate } from '../content/officeMessages';
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
  /** Every visible text on the canvas goes through this function. */
  translate: OfficeTranslate;
  /**
   * Draw token and cost telemetry aggregated from the agents (demo app). Embedded views leave it off:
   * the canvas then never adds up tokens or costs and the Model Ops room is only decoration.
   */
  usageTelemetry?: boolean;
  nowMs: number;
  reducedMotion?: boolean;
  /** Optional per-canvas sprite cache; absent keeps the procedural renderer. */
  crewAssets?: OfficeCrewAssets;
  /** Opt-in original illustrated props. Existing geometry and work displays remain unchanged. */
  furnitureAssets?: OfficeFurnitureAssets;
}

/** Text settings shared by every drawing helper. */
interface SceneText {
  translate: OfficeTranslate;
  usageTelemetry: boolean;
}

/** Label of a furniture item from the catalog. Items without a catalog entry draw no text. */
function furnitureLabel(item: FurnitureItem, scene: SceneText): string | undefined {
  if (!item.label) return undefined;
  // Model Ops furniture only names itself when usage telemetry is on: embedded views never mention tokens.
  if (item.id.startsWith('f_server_') && !scene.usageTelemetry) return undefined;
  const key = `furniture.${item.id}`;
  return isOfficeMessageKey(key) ? scene.translate(key) : undefined;
}

/**
 * Renders the full 2.5D Rectangular Architectural Office.
 * Screen-aligned, rectangular layout (NO diamond / rhombus!) that fills the viewport cleanly.
 */
export function renderOfficeScene(rc: RenderContext) {
  const { ctx, width, height, camera, agents, selectedAgentId, hoveredAgentId, activeMeetingId, timeMs, theme, nowMs } = rc;
  const rot = ((camera.rotation % 4) + 4) % 4;
  const scene: SceneText = { translate: rc.translate, usageTelemetry: rc.usageTelemetry ?? false };

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

  drawRoomAtmosphere(ctx, rot, theme);
  drawModelOpsTelemetry(ctx, rot, theme, agents, timeMs, scene);
  drawMessageConnections(ctx, rot, agents, timeMs, nowMs);

  // 3. Architectural interior walls, glass partitions & doorways
  drawArchitecturalWalls(ctx, rot, theme);

  // 4. Depth-sorted Entities (Furniture and Agents rendered in 2.5D perspective)
  drawDepthSortedEntities(ctx, rot, agents, selectedAgentId, hoveredAgentId, activeMeetingId, timeMs, theme, nowMs, scene, rc.crewAssets, rc.reducedMotion, rc.furnitureAssets);
  // Room plaques are intentionally rendered after furniture/agents so static decoration can never cover them.
  drawRoomPlaques(ctx, rot, theme, scene.translate);

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
  timeMs: number,
  scene: SceneText
) {
  const room = OFFICE_ROOMS.find((item) => item.id === 'server_room');
  if (!room) return;

  ctx.save();

  // 1. Fiber Optic Data Conduits on Floor (linking server racks to NOC display)
  // Racks at gx: 18, 20, 22. NOC at gx: 20, gy: 0.
  const rackCoords = [
    { gx: 18, gy: 1, color: '#10a37f' },
    { gx: 20, gy: 1, color: '#d97706' },
    { gx: 22, gy: 1, color: '#2563eb' },
    { gx: 22, gy: 3, color: '#a855f7' },
  ];

  const nocScreenPos = gridToScreen(20, 0.5, rot);

  for (const rack of rackCoords) {
    const rackPos = gridToScreen(rack.gx, rack.gy, rot);
    ctx.strokeStyle = theme === 'dark' ? 'rgba(15, 23, 42, 0.8)' : 'rgba(203, 213, 225, 0.8)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(rackPos.x + 24, rackPos.y + 24);
    ctx.lineTo(nocScreenPos.x + 24, nocScreenPos.y + 24);
    ctx.stroke();

    // Glowing core pulse
    ctx.strokeStyle = rack.color;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Data packet light traveling along the fiber
    const packetProgress = (timeMs / 1200 + (rack.gx * 0.3)) % 1;
    const packetX = rackPos.x + 24 + (nocScreenPos.x + 24 - (rackPos.x + 24)) * (1 - packetProgress);
    const packetY = rackPos.y + 24 + (nocScreenPos.y + 24 - (rackPos.y + 24)) * (1 - packetProgress);

    ctx.fillStyle = rack.color;
    ctx.beginPath();
    ctx.arc(packetX, packetY, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (!scene.usageTelemetry) {
    ctx.restore();
    return;
  }

  const providers = aggregateModelUsage(agents);
  const totalTokens = providers.reduce((sum, provider) => sum + provider.totalTokens, 0);
  const totalCost = providers.reduce((sum, provider) => sum + provider.cost, 0);

  // 2. High-Tech Floor Telemetry Runner Plaque at entrance threshold (gy: 5)
  const threshPos = gridToScreen(18, 5, rot);
  const hudW = 200;
  const hudH = 26;
  const hudX = threshPos.x + 8;
  const hudY = threshPos.y + 12;

  // Background banner with neon glow
  ctx.fillStyle = theme === 'dark' ? 'rgba(2, 6, 23, 0.94)' : 'rgba(248, 250, 252, 0.96)';
  ctx.strokeStyle = theme === 'dark' ? 'rgba(34, 211, 238, 0.6)' : 'rgba(8, 145, 178, 0.6)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(hudX, hudY, hudW, hudH, 6);
  ctx.fill();
  ctx.stroke();

  // Cyan pulsing indicator light
  const pulse = 0.5 + Math.sin(timeMs / 250) * 0.5;
  ctx.fillStyle = `rgba(34, 211, 238, ${pulse})`;
  ctx.beginPath();
  ctx.arc(hudX + 12, hudY + 13, 3, 0, Math.PI * 2);
  ctx.fill();

  // Title & live token stats
  ctx.font = '700 8px "JetBrains Mono", monospace';
  ctx.fillStyle = theme === 'dark' ? '#38bdf8' : '#0284c7';
  ctx.textAlign = 'left';
  ctx.fillText(scene.translate('screen.telemetry'), hudX + 22, hudY + 11, hudW - 84);

  ctx.font = '700 7.5px "JetBrains Mono", monospace';
  ctx.fillStyle = '#22c55e';
  ctx.fillText(`${compactTokens(totalTokens)} t · $${totalCost.toFixed(3)}`, hudX + 22, hudY + 21);

  // Click CTA badge
  ctx.fillStyle = theme === 'dark' ? '#083344' : '#cffafe';
  ctx.beginPath();
  ctx.roundRect(hudX + hudW - 58, hudY + 5, 52, 16, 4);
  ctx.fill();
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  ctx.font = '700 6.5px "Plus Jakarta Sans", sans-serif';
  ctx.fillStyle = theme === 'dark' ? '#67e8f9' : '#0e7490';
  ctx.textAlign = 'center';
  ctx.fillText(scene.translate('screen.open'), hudX + hudW - 32, hudY + 15.5, 46);

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

export function getAgentVisualOffsets(agents: Agent[]): Map<string, { ox: number; oy: number }> {
  const offsets = new Map<string, { ox: number; oy: number }>();
  for (let i = 0; i < agents.length; i++) {
    const a1 = agents[i];
    let clusterIndex = 0;
    let clusterSize = 1;
    for (let j = 0; j < agents.length; j++) {
      if (i === j) continue;
      const a2 = agents[j];
      if (Math.hypot(a1.x - a2.x, a1.y - a2.y) < 0.35) {
        clusterSize++;
        if (j < i) clusterIndex++;
      }
    }
    if (clusterSize > 1) {
      const totalSpread = (clusterSize - 1) * 20;
      const ox = -totalSpread / 2 + clusterIndex * 20;
      offsets.set(a1.id, { ox, oy: 0 });
    } else {
      offsets.set(a1.id, { ox: 0, oy: 0 });
    }
  }
  return offsets;
}

/** Shared hover/click/double-click geometry, matching the sprites actually drawn on the ground plane. */
export function findOfficeAgentAtPoint(
  agents: Agent[], rotation: number, worldX: number, worldY: number,
  crewAssets?: OfficeCrewAssets, radius = 32,
): Agent | null {
  const offsets = getAgentVisualOffsets(agents);
  let result: Agent | null = null;
  let nearest = Infinity;
  for (const agent of agents) {
    const sprite = crewAssets?.boundsFor(agent.id);
    const world = gridToScreen(agent.x, agent.y, rotation);
    const offset = offsets.get(agent.id) ?? { ox: 0, oy: 0 };
    const cx = sprite ? sprite.x + sprite.width / 2 : world.x + TILE_SIZE / 2 + offset.ox;
    const cy = sprite ? sprite.y + sprite.height / 2 : world.y + 8 + offset.oy;
    const distance = Math.hypot(worldX - cx, worldY - cy);
    const hit = sprite
      ? worldX >= sprite.x && worldX <= sprite.x + sprite.width && worldY >= sprite.y && worldY <= sprite.y + sprite.height
      : distance < radius;
    if (hit && distance < nearest) { nearest = distance; result = agent; }
  }
  return result;
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
  nowMs: number,
  scene: SceneText,
  crewAssets?: OfficeCrewAssets,
  reducedMotion = false,
  furnitureAssets?: OfficeFurnitureAssets,
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

  const visualOffsets = getAgentVisualOffsets(agents);

  for (const ent of entities) {
    if (ent.kind === 'furniture') {
      renderFurnitureItem(ctx, ent.item, rot, timeMs, theme, activeMeetingId, scene, agents, furnitureAssets);
    } else {
      const offset = visualOffsets.get(ent.agent.id) ?? { ox: 0, oy: 0 };
      renderAgentItem(ctx, ent.agent, rot, selectedAgentId, hoveredAgentId, timeMs, theme, nowMs, offset, crewAssets, reducedMotion);
    }
  }
}

function renderFurnitureItem(
  ctx: CanvasRenderingContext2D,
  item: FurnitureItem,
  rot: number,
  timeMs: number,
  theme: 'dark' | 'light',
  activeMeetingId: string | null,
  scene: SceneText,
  agents: Agent[] = [],
  furnitureAssets?: OfficeFurnitureAssets,
) {
  const { x, y } = gridToScreen(item.gridX, item.gridY, rot);
  ctx.save();
  const scale = item.scale ?? (item.type === 'desk' ? 1.35 : item.type === 'meeting_table' ? (item.subType === 'cafe_round' ? 1.0 : 1.65) : item.type === 'plant' ? 1.2 : 1);
  const cx = x + TILE_SIZE / 2;
  const cy = y + TILE_SIZE / 2;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);
  // Only replace selected static props. Desks and monitors remain procedural, so
  // their live operational screens are not replaced with static illustration.
  if (furnitureAssets?.draw(ctx, item, x, y, TILE_SIZE)) {
    ctx.restore();
    return;
  }
  // Ground contact gives every object a place in the room.
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.beginPath();
  ctx.ellipse(cx + 2, cy + 13, item.type === 'meeting_table' ? (item.subType === 'cafe_round' ? 24 : 65) : 21, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  if (item.type === 'desk') {
    renderDesk(ctx, x, y, item, timeMs, theme, scene);
  } else if (item.type === 'chair') {
    renderChair(ctx, x, y, item, theme);
  } else if (item.type === 'meeting_table') {
    if (item.subType === 'cafe_round') {
      renderCafeRoundTable(ctx, x, y, theme, furnitureLabel(item, scene));
    } else {
      renderMeetingTable(ctx, x, y, theme);
    }
  } else if (item.type === 'screen') {
    renderWallScreen(ctx, x, y, item, activeMeetingId, timeMs, scene, agents);
  } else if (item.type === 'whiteboard') {
    renderWhiteboard(ctx, x, y, item);
  } else if (item.type === 'server_rack') {
    renderServerRack(ctx, x, y, item, timeMs, scene, agents);
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
  theme: 'dark' | 'light',
  scene: SceneText
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
  const deskLabel = item.assignedAgentId ? undefined : furnitureLabel(item, scene);
  if (deskLabel) {
    ctx.font = '600 8.5px "JetBrains Mono", monospace';
    ctx.fillStyle = theme === 'dark' ? '#94a3b8' : '#64748b';
    ctx.textAlign = 'left';
    ctx.fillText(deskLabel, posX - 2, posY + deskH + 9, deskW + 4);
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

function renderCafeRoundTable(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  theme: 'dark' | 'light',
  label?: string
) {
  const cx = x + 24;
  const cy = y + 24;

  // Drop shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.beginPath();
  ctx.ellipse(cx + 1, cy + 5, 23, 16, 0, 0, Math.PI * 2);
  ctx.fill();

  // Polished Warm Wood Round Cafe Tabletop
  ctx.fillStyle = theme === 'dark' ? '#3b251a' : '#8d6e63';
  ctx.strokeStyle = theme === 'dark' ? '#d97706' : '#b45309';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.arc(cx, cy, 21, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Inlaid Ring
  ctx.strokeStyle = theme === 'dark' ? 'rgba(217, 119, 6, 0.4)' : 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, 16, 0, Math.PI * 2);
  ctx.stroke();

  // Ceramic Espresso Cups
  ctx.fillStyle = '#f8fafc';
  ctx.beginPath();
  ctx.arc(cx - 7, cy - 6, 3.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#6f4e37'; // crema
  ctx.beginPath();
  ctx.arc(cx - 7, cy - 6, 2.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#f8fafc';
  ctx.beginPath();
  ctx.arc(cx + 7, cy - 5, 3.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#78350f';
  ctx.beginPath();
  ctx.arc(cx + 7, cy - 5, 2.5, 0, Math.PI * 2);
  ctx.fill();

  // Pastry dish in center
  ctx.fillStyle = '#f1f5f9';
  ctx.beginPath();
  ctx.arc(cx, cy + 6, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f59e0b';
  ctx.beginPath();
  ctx.arc(cx - 1, cy + 6, 3, 0, Math.PI * 2);
  ctx.fill();

  // Table label
  if (label) {
    ctx.font = '700 8px "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = theme === 'dark' ? '#fbbf24' : '#92400e';
    ctx.textAlign = 'center';
    ctx.fillText(label, cx, cy + 34, 52);
  }
}

function renderWallScreen(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  item: FurnitureItem,
  activeMeetingId: string | null,
  timeMs: number,
  scene: SceneText,
  agents: Agent[] = []
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
      ctx.fillText(scene.translate('screen.meetingActive'), px + 7, py + 14, sw - 14);

      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(px + 7, py + 18, 24, 5);
      ctx.fillStyle = '#22c55e';
      ctx.fillRect(px + 35, py + 18, 30, 5);
    } else {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(px + 4, py + 4, sw - 8, sh - 8);

      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 8px "JetBrains Mono", monospace';
      ctx.fillText(scene.translate('screen.meetingIdle'), px + 6, py + 16, sw - 12);
    }
  } else if (item.id === 'f_qa_screen') {
    // QA Automated CI/CD Screen
    ctx.fillStyle = '#022c22';
    ctx.fillRect(px + 4, py + 4, sw - 8, sh - 8);

    ctx.fillStyle = '#4ade80';
    ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
    ctx.fillText(scene.translate('screen.qa'), px + 6, py + 13, sw - 12);
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(px + 6, py + 18, 48, 4);
  } else if (item.id === 'f_server_noc') {
    // Model Ops Wall NOC Multi-Monitor Display
    ctx.fillStyle = '#020617';
    ctx.fillRect(px + 3, py + 3, sw - 6, sh - 6);

    // Top status strip
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(px + 4, py + 4, sw - 8, 9);
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 6px "JetBrains Mono", monospace';
    ctx.fillText(scene.translate(scene.usageTelemetry ? 'screen.tokenFlow' : 'screen.status'), px + 6, py + 11, sw - 12);

    // Live Animated Oscilloscope / Spectrogram of Token Traffic
    const waveColors = ['#10b981', '#38bdf8', '#f59e0b', '#a855f7'];
    for (let ch = 0; ch < 2; ch++) {
      ctx.strokeStyle = waveColors[ch];
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let wx = 6; wx < sw - 6; wx += 4) {
        const freq = timeMs / 180 + wx * 0.2 + ch * 1.5;
        const amp = Math.sin(freq) * 3.5 * Math.cos(timeMs / 400 + wx * 0.1);
        const wy = py + 17 + amp;
        if (wx === 6) ctx.moveTo(px + wx, wy);
        else ctx.lineTo(px + wx, wy);
      }
      ctx.stroke();
    }

    if (!scene.usageTelemetry) return;

    // Mini provider indicators & real-time token throughput
    const totalTok = agents.reduce((s, a) => s + a.tokensInput + a.tokensOutput, 0);
    ctx.font = 'bold 5.5px "JetBrains Mono", monospace';
    ctx.fillStyle = '#10a37f';
    ctx.fillText('OAI', px + 5, py + sh - 4);
    ctx.fillStyle = '#d97706';
    ctx.fillText('ANT', px + 18, py + sh - 4);
    ctx.fillStyle = '#2563eb';
    ctx.fillText('GEM', px + 31, py + sh - 4);
    ctx.fillStyle = '#a855f7';
    ctx.fillText('LOC', px + 44, py + sh - 4);

    ctx.fillStyle = '#22c55e';
    ctx.font = 'bold 5.5px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${compactTokens(totalTok)} t`, px + sw - 6, py + sh - 4);
    ctx.textAlign = 'left';
  } else {
    // Boss KPI or Lounge Screen
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(px + 4, py + 4, sw - 8, sh - 8);
    ctx.fillStyle = '#f59e0b';
    ctx.font = 'bold 7.5px "JetBrains Mono", monospace';
    ctx.fillText(furnitureLabel(item, scene) ?? scene.translate('screen.status'), px + 6, py + 16, sw - 12);
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
  timeMs: number,
  scene: SceneText,
  agents: Agent[] = []
) {
  const rx = x + 4;
  const ry = y + 2;
  const rw = 40;
  const rh = 44;

  // Determine provider metadata for this rack
  let providerColor = '#0284c7';
  let providerTag = 'SERVER';
  let modelTag = 'gpt-4o';
  let tokenCount = 0;

  if (item.id === 'f_server_rack_1') {
    providerColor = '#10a37f'; // OpenAI
    providerTag = 'OpenAI';
    modelTag = 'gpt-4o / o1';
    const pAgents = agents.filter(a => a.provider === 'OpenAI');
    tokenCount = pAgents.reduce((s, a) => s + a.tokensInput + a.tokensOutput, 0);
  } else if (item.id === 'f_server_rack_2') {
    providerColor = '#d97706'; // Anthropic
    providerTag = 'Anthropic';
    modelTag = 'claude-3.5';
    const pAgents = agents.filter(a => a.provider === 'Anthropic');
    tokenCount = pAgents.reduce((s, a) => s + a.tokensInput + a.tokensOutput, 0);
  } else if (item.id === 'f_server_rack_3') {
    providerColor = '#2563eb'; // Google Gemini
    providerTag = 'Gemini';
    modelTag = 'gemini-2.5';
    const pAgents = agents.filter(a => a.provider === 'Google Gemini');
    tokenCount = pAgents.reduce((s, a) => s + a.tokensInput + a.tokensOutput, 0);
  } else if (item.id === 'f_server_rack_4') {
    providerColor = '#a855f7'; // Local / Ollama
    providerTag = 'Local';
    modelTag = 'llama-3.3';
    const pAgents = agents.filter(a => a.provider.toLowerCase().includes('local'));
    tokenCount = pAgents.reduce((s, a) => s + a.tokensInput + a.tokensOutput, 0);
  }

  // Dark metallic server rack chassis with provider accent glow
  ctx.fillStyle = '#030712';
  ctx.strokeStyle = providerColor;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.roundRect(rx, ry, rw, rh, 3);
  ctx.fill();
  ctx.stroke();

  // Top header with provider badge & active model label
  ctx.fillStyle = providerColor;
  ctx.fillRect(rx + 1, ry + 1, rw - 2, 5);

  if (scene.usageTelemetry) {
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 5px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(modelTag, rx + rw / 2, ry + 4.8);
    ctx.textAlign = 'left';
  }

  // 6 Server Blades per rack
  for (let s = 0; s < 6; s++) {
    const sy = ry + 7 + s * 5.6;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(rx + 3, sy, rw - 6, 4.6);

    // Multi-color blinking LEDs
    const pulseSpeed = 160 + s * 30;
    const led1 = Math.sin(timeMs / pulseSpeed + s * 1.5) > 0;
    const led2 = Math.cos(timeMs / (pulseSpeed + 40) + s * 2.3) > 0;

    ctx.fillStyle = led1 ? providerColor : '#1e293b';
    ctx.beginPath();
    ctx.arc(rx + 6, sy + 2.3, 1.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = led2 ? '#38bdf8' : '#1e293b';
    ctx.beginPath();
    ctx.arc(rx + 10, sy + 2.3, 1.2, 0, Math.PI * 2);
    ctx.fill();

    // VU meter bar on right of blade showing dynamic traffic
    const vuIntensity = Math.abs(Math.sin(timeMs / 250 + s * 0.9));
    const vuWidth = Math.floor(vuIntensity * 16);
    ctx.fillStyle = led1 ? providerColor : '#334155';
    ctx.fillRect(rx + rw - 20, sy + 1.6, vuWidth, 1.5);
  }

  if (!scene.usageTelemetry) return;

  // Mini token badge under rack
  ctx.fillStyle = '#020617';
  ctx.fillRect(rx - 3, ry + rh + 1, rw + 6, 11);
  ctx.strokeStyle = providerColor;
  ctx.lineWidth = 0.8;
  ctx.strokeRect(rx - 3, ry + rh + 1, rw + 6, 11);

  ctx.fillStyle = providerColor;
  ctx.font = 'bold 5.5px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  const displayLabel = tokenCount > 0 ? `${providerTag}: ${compactTokens(tokenCount)} t` : providerTag;
  ctx.fillText(displayLabel, rx + rw / 2, ry + rh + 8.5);
  ctx.textAlign = 'left';
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
  timeMs: number, theme: 'dark' | 'light', nowMs: number,
  visualOffset: { ox: number; oy: number } = { ox: 0, oy: 0 },
  crewAssets?: OfficeCrewAssets, reducedMotion = false
) {
  const { x, y } = gridToScreen(agent.x, agent.y, rot);
  const cx = x + TILE_SIZE / 2 + visualOffset.ox;
  const ground = y + TILE_SIZE / 2 + 12 + visualOffset.oy;
  const phase = [...agent.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const walking = agent.isWalking;
  const speaking = isSpeechActive(agent.speechBubble ?? agent.ambientBubble, nowMs);
  const typing = !walking && ['CODING', 'TESTING', 'USING_TOOL', 'WRITING'].includes(agent.status);
  const seated = !walking && (typing || agent.status === 'IN_MEETING' || agent.status === 'COFFEE_BREAK' || agent.presentationActivity === 'coffee_break' || agent.presentationActivity === 'chatting');
  const selected = agent.id === selectedAgentId;
  const hovered = agent.id === hoveredAgentId;
  const cycle = timeMs / 130 + phase;
  const bob = walking ? Math.sin(cycle * 2) * 1.5 : Math.sin(timeMs / 950 + phase) * 0.45;
  const torsoY = ground - (seated ? 23 : 28) + bob;
  const skin = ['#e8b89a', '#c58e6f', '#f2cfb1', '#ad7656'][phase % 4];
  const palette = { color: statusColor(agent.status) };
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
  if (crewAssets?.draw(ctx, agent, rot, cx, ground, timeMs, nowMs, reducedMotion)) {
    ctx.restore();
    return;
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
  ctx.strokeStyle = '#97664e'; ctx.lineWidth = 0.9;
  ctx.beginPath();
  if (agent.mood === 'annoyed' || agent.mood === 'frustrated') {
    ctx.arc(cx + faceOffset, headY + 6, 1.8, Math.PI, Math.PI * 2);
  } else if (agent.mood === 'happy' || agent.mood === 'amused' || agent.mood === 'excited') {
    ctx.arc(cx + faceOffset, headY + 3.5, speaking ? 2.0 : 1.7, 0, Math.PI);
  } else if (agent.mood === 'surprised') {
    ctx.arc(cx + faceOffset, headY + 4.5, 1.5, 0, Math.PI * 2);
  } else {
    ctx.arc(cx + faceOffset, headY + 4, speaking ? 1.5 : 1.1, 0, Math.PI);
  }
  ctx.stroke();
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

function statusColor(status: Agent['status']): string {
  const colors: Partial<Record<Agent['status'], string>> = {
    CODING: '#34d399', WRITING: '#34d399', DONE: '#4ade80',
    TESTING: '#38bdf8', USING_TOOL: '#38bdf8', RESEARCHING: '#38bdf8', READING: '#38bdf8',
    IN_MEETING: '#c4b5fd', REVIEWING: '#c4b5fd',
    BLOCKED: '#fb923c', WAITING_APPROVAL: '#fbbf24', ERROR: '#fb7185',
    DELEGATING: '#fbbf24', DELIVERING: '#fbbf24', THINKING: '#facc15',
    PHONE_CALL: '#a78bfa', WALKING: '#94a3b8', COFFEE_BREAK: '#f59e0b', CHATTING: '#fb7185', AVAILABLE: '#86efac',
  };
  return colors[status] ?? '#94a3b8';
}

function statusAppearance(status: Agent['status'], translate: OfficeTranslate) {
  return { color: statusColor(status), label: translate(`status.${status}`) };
}

/** Agents from events carry their own role title; the demo team uses the built-in role names. */
export function agentRoleLabel(agent: Agent, translate: OfficeTranslate): string {
  if (agent.role === 'custom') return agent.roleTitle.trim();
  return translate(`role.${agent.role}`);
}

function agentDisplayName(agent: Agent, translate: OfficeTranslate): string {
  return agent.role === 'boss' ? translate('role.boss') : agent.name;
}

function drawAgentOverlays(rc: RenderContext) {
  const { ctx, agents, camera, width, height, nowMs, timeMs, theme, translate } = rc;
  const center = cameraCenter(width, height);
  const visualOffsets = getAgentVisualOffsets(agents);
  const visibleBodies = agents.map(agent => {
    const world = gridToScreen(agent.x, agent.y, camera.rotation);
    const offset = visualOffsets.get(agent.id) ?? { ox: 0, oy: 0 };
    const sprite = rc.crewAssets?.boundsFor(agent.id);
    const x = center.x + (world.x + TILE_SIZE / 2 + offset.ox + camera.x) * camera.zoom;
    const y = center.y + ((sprite?.y ?? world.y - 13 + offset.oy) + camera.y) * camera.zoom;
    const body = sprite ? {
      x: center.x + (sprite.x + camera.x) * camera.zoom,
      y: center.y + (sprite.y + camera.y) * camera.zoom,
      width: sprite.width * camera.zoom, height: sprite.height * camera.zoom,
    } : { x: x - 15, y: y - 5, width: 30, height: 46 };
    return { agent, x, y, body };
  }).filter(a => a.body.x + a.body.width > 0 && a.body.x < width && a.body.y + a.body.height > 0 && a.body.y < height);
  const anchors = visibleBodies.filter(a => camera.zoom >= 0.55 || a.agent.id === rc.selectedAgentId || a.agent.id === rc.hoveredAgentId || isSpeechActive(a.agent.speechBubble ?? a.agent.ambientBubble, nowMs));
  // Reserve the complete drawn sprites, including heads and props, even when their labels are hidden.
  const occupied: OverlayRect[] = visibleBodies.map(a => a.body);
  occupied.push(...roomPlaqueScreenRects(ctx, rc));
  const labels = new Map<string, OverlayRect>();
  const foreground = theme === 'dark' ? '#f1f5f9' : '#0f172a';
  const background = theme === 'dark' ? '#0d1524' : '#ffffff';
  ctx.save();
  for (const a of [...anchors].sort((a, b) => a.y - b.y)) {
    const { color, label } = statusAppearance(a.agent.status, translate);
    const name = agentDisplayName(a.agent, translate);
    ctx.font = '600 10px "Plus Jakarta Sans", sans-serif';
    const role = agentRoleLabel(a.agent, translate);
    const subtitle = role ? role + ' · ' + label : label;
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
    const speech = a.agent.speechBubble ?? a.agent.ambientBubble;
    if (!isSpeechActive(speech, nowMs)) continue;
    ctx.font = '500 12px "Plus Jakarta Sans", sans-serif';
    const maxWidth = Math.min(250, width - 32);
    const lines = wrapText(speech!.text, maxWidth - 24, t => ctx.measureText(t).width, 2);
    const badge = labels.get(a.agent.id)!;
    const card = placeOverlay({ x: a.x - maxWidth / 2, y: badge.y - (lines.length * 17 + 40), width: maxWidth, height: lines.length * 17 + 32 }, occupied, { width, height });
    occupied.push(card);
    const exit = bubbleExitStyle(speech!.expiresAt - nowMs, rc.reducedMotion);
    const { color } = statusAppearance(a.agent.status, translate);
    ctx.strokeStyle = color; ctx.lineWidth = 1.2;
    ctx.globalAlpha = exit.outlineAlpha;
    ctx.beginPath(); ctx.moveTo(card.x + card.width / 2, card.y + card.height + exit.offsetY); ctx.lineTo(a.x, a.y - 4); ctx.stroke();
    // Leaving bubbles shrink toward their pointer; the card and the text are never translucent.
    ctx.save();
    const pivotX = card.x + card.width / 2;
    const pivotY = card.y + card.height;
    ctx.translate(pivotX, pivotY + exit.offsetY); ctx.scale(exit.scale, exit.scale); ctx.translate(-pivotX, -pivotY);
    ctx.globalAlpha = exit.cardAlpha;
    ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 4;
    ctx.fillStyle = background; ctx.beginPath(); ctx.roundRect(card.x, card.y, card.width, card.height, 11); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.globalAlpha = exit.outlineAlpha; ctx.stroke(); ctx.globalAlpha = exit.cardAlpha;
    const speaker = agentDisplayName(a.agent, translate);
    const simulated = speech === a.agent.ambientBubble && speech !== a.agent.speechBubble;
    const kind = simulated ? undefined : a.agent.speechBubble?.kind;
    // The label says what the message is; it never depends on the agent's status for real messages.
    const activityLabel =
      simulated ? translate('bubble.social')
      : kind ? translate(`kind.${kind}`)
      : a.agent.status === 'IN_MEETING' ? translate('bubble.meeting')
      : a.agent.status === 'PHONE_CALL' ? translate('bubble.phone')
      : translate('bubble.activity');
    // Label first so it is never truncated; the names take the remaining width.
    const headerColor = theme === 'dark' ? color : '#3730a3';
    const headerMax = card.width - 40;
    ctx.font = '800 9px "Plus Jakarta Sans", sans-serif'; ctx.fillStyle = headerColor;
    const labelText = wrapText(activityLabel, headerMax, t => ctx.measureText(t).width, 1)[0];
    ctx.fillText(labelText, card.x + 12, card.y + 16);
    const labelWidth = ctx.measureText(labelText + '  ').width;
    ctx.font = '600 9px "Plus Jakarta Sans", sans-serif'; ctx.fillStyle = theme === 'dark' ? '#cbd5e1' : '#334155';
    if (headerMax - labelWidth > 20) {
      // Long names are shortened fairly (both to two words, then both with an ellipsis), never just the target.
      const names = fitBubbleNames(speaker, speech!.targetAgentName, headerMax - labelWidth, t => ctx.measureText(t).width);
      ctx.fillText(names, card.x + 12 + labelWidth, card.y + 16);
    }
    ctx.font = '500 12px "Plus Jakarta Sans", sans-serif'; ctx.fillStyle = foreground;
    lines.forEach((line, i) => ctx.fillText(line, card.x + 12, card.y + 34 + i * 17));
    // Speaker dots follow a real, unexpired message, not invented dialogue.
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(card.x + card.width - 23 + i * 5, card.y + 13, 1.3 + Math.max(0, Math.sin(timeMs / 220 - i)) * 0.7, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawMessageConnections(ctx: CanvasRenderingContext2D, rot: number, agents: Agent[], timeMs: number, nowMs: number) {
  ctx.save();
  for (const agent of agents) {
    const bubble = agent.speechBubble ?? agent.ambientBubble;
    if (!isSpeechActive(bubble, nowMs) || !bubble?.targetAgentName) continue;
    const target = agents.find(a => a.id !== agent.id && (a.name === bubble!.targetAgentName || a.name.startsWith(bubble!.targetAgentName!)));
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

function drawRoomAtmosphere(ctx: CanvasRenderingContext2D, rot: number, theme: 'dark' | 'light') {
  ctx.save();
  for (const room of OFFICE_ROOMS) {
    const rect = getRoomScreenRect(room.gridX, room.gridY, room.width, room.height, rot);
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x + 3, rect.y + 3, rect.width - 6, rect.height - 6);
    ctx.clip();
    const warm = ['wood', 'executive'].includes(room.floorPattern) || room.id === 'break_room';
    const glow = ctx.createRadialGradient(
      rect.x + rect.width * 0.65,
      rect.y + rect.height * 0.35,
      1,
      rect.x + rect.width * 0.65,
      rect.y + rect.height * 0.35,
      Math.max(rect.width, rect.height) * 0.7,
    );
    glow.addColorStop(0, warm ? 'rgba(251,191,113,0.08)' : 'rgba(56,189,248,0.07)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    if (room.floorPattern === 'wood' || room.floorPattern === 'executive') {
      ctx.strokeStyle = theme === 'dark' ? 'rgba(225,195,155,0.05)' : 'rgba(115,82,52,0.08)';
      ctx.lineWidth = 1;
      for (let yy = rect.y + 8; yy < rect.y + rect.height; yy += 12) {
        ctx.beginPath();
        ctx.moveTo(rect.x + 4, yy);
        ctx.lineTo(rect.x + rect.width - 4, yy);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  ctx.restore();
}

/** Room plaque geometry in world space; shared by the plaque drawing and the overlay layout. */
function roomPlaqueRect(ctx: CanvasRenderingContext2D, room: (typeof OFFICE_ROOMS)[number], rot: number, label: string) {
  const rect = getRoomScreenRect(room.gridX, room.gridY, room.width, room.height, rot);
  ctx.font = '700 10px "Plus Jakarta Sans", sans-serif';
  return {
    x: rect.x + 9,
    y: rect.y + 7,
    width: Math.min(rect.width - 18, ctx.measureText(label).width + 29),
    height: 22,
  };
}

function roomPlaqueScreenRects(ctx: CanvasRenderingContext2D, rc: RenderContext): OverlayRect[] {
  const { camera, width, height, translate } = rc;
  const rot = ((camera.rotation % 4) + 4) % 4;
  const center = cameraCenter(width, height);
  const rects: OverlayRect[] = [];
  ctx.save();
  for (const room of OFFICE_ROOMS) {
    const roomKey = `rooms.${room.id}`;
    if (!isOfficeMessageKey(roomKey)) continue;
    const label = translate(roomKey);
    if (!label) continue;
    const plaque = roomPlaqueRect(ctx, room, rot, label);
    rects.push({
      x: center.x + (plaque.x + camera.x) * camera.zoom,
      y: center.y + (plaque.y + camera.y) * camera.zoom,
      width: plaque.width * camera.zoom,
      height: plaque.height * camera.zoom,
    });
  }
  ctx.restore();
  return rects;
}

function drawRoomPlaques(
  ctx: CanvasRenderingContext2D,
  rot: number,
  theme: 'dark' | 'light',
  translate: OfficeTranslate,
) {
  const accents: Record<string, string> = {
    boss_office: '#b8a3e6',
    meeting_room: '#818cf8',
    meeting_room_b: '#a78bfa',
    server_room: '#38bdf8',
    leads_area: '#a5b4fc',
    development: '#34d399',
    qa_lab: '#38bdf8',
    research_area: '#d8b48a',
    break_room: '#e6b77a',
    lounge: '#5eead4',
  };

  ctx.save();
  for (const room of OFFICE_ROOMS) {
    const roomKey = `rooms.${room.id}`;
    const label = isOfficeMessageKey(roomKey) ? translate(roomKey) : '';
    if (!label) continue;
    const accent = accents[room.id] ?? '#94a3b8';

    const plaque = roomPlaqueRect(ctx, room, rot, label);
    const plaqueWidth = plaque.width;
    const plaqueX = plaque.x;
    const plaqueY = plaque.y;

    ctx.fillStyle = theme === 'dark' ? 'rgba(7,12,22,0.96)' : 'rgba(255,255,255,0.98)';
    ctx.strokeStyle = theme === 'dark' ? 'rgba(148,163,184,0.35)' : 'rgba(71,85,105,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(plaqueX, plaqueY, plaqueWidth, 22, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.fillRect(plaqueX + 6, plaqueY + 6, 3, 10);
    ctx.textAlign = 'left';
    ctx.fillStyle = theme === 'dark' ? '#e2e8f0' : '#334155';
    ctx.fillText(label, plaqueX + 15, plaqueY + 15, plaqueWidth - 20);
  }
  ctx.restore();
}
