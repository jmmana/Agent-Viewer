import { crewProject, type CrewRoomDefinition, type CrewView } from './crewModel';
import { crewPolygon, type CrewPoint } from './crewRenderPrimitives';
import { crewLampIsOn, type CrewLamp, type CrewLampModes } from './crewLamps';
import type { CrewAmbience } from './crewAmbience';

type Projection = (x: number, y: number, z?: number) => CrewPoint;

/** Bounded flat pools, beneath props/actors. No blur filter, animation or image load. */
export function drawCrewLampPools(ctx: CanvasRenderingContext2D, room: CrewRoomDefinition, view: CrewView,
  lamps: readonly CrewLamp[], modes: CrewLampModes, ambience: CrewAmbience, isoPoint: Projection, highContrast: boolean): void {
  if (highContrast) return;
  ctx.save();
  for (const lamp of lamps) {
    if (!crewLampIsOn(modes[lamp.id], ambience)) continue;
    // Concentric polygons give soft light without expensive canvas shadow blur.
    for (const fraction of [1, .7, .4]) {
      const radius = lamp.kind === 'ceiling' ? Math.min(3, lamp.radius) : lamp.radius;
      const points = Array.from({ length: 20 }, (_, i) => {
        const angle = i * Math.PI / 10;
        const p = crewProject(Math.max(0, Math.min(room.width, lamp.x + Math.cos(angle) * radius * fraction)),
          Math.max(0, Math.min(room.depth, lamp.y + Math.sin(angle) * radius * fraction)), room, view);
        return isoPoint(p.x, p.y);
      });
      crewPolygon(ctx, points, 'rgba(255,221,130,.07)', 'rgba(255,221,130,.02)');
    }
    // Small fixture shadow on the floor; no projection over labels or actors.
    const p = crewProject(lamp.x, lamp.y, room, view);
    const point = isoPoint(p.x, p.y);
    ctx.fillStyle = 'rgba(23,32,48,.13)';
    ctx.beginPath(); ctx.ellipse(point.x + 5, point.y + 3, 10, 3, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/** Original four fixture silhouettes; positions are already rotated by the room camera. */
export function drawCrewLamp(ctx: CanvasRenderingContext2D, lamp: CrewLamp, x: number, y: number,
  isoPoint: Projection, on: boolean, highContrast: boolean): void {
  const base = isoPoint(x, y, lamp.baseZ), bulb = isoPoint(x, y, lamp.bulbZ);
  const metal = highContrast ? '#ffffff' : '#526e87';
  const shade = highContrast ? '#000000' : lamp.kind === 'reception' ? '#bf9360' : '#567d8d';
  const light = on ? (highContrast ? '#ffff00' : '#ffe2a0') : (highContrast ? '#000000' : '#889bab');
  ctx.save();
  if (on && !highContrast) {
    ctx.fillStyle = 'rgba(255,222,139,.14)';
    ctx.beginPath(); ctx.ellipse(bulb.x, bulb.y, 14, 9, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = metal; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(bulb.x, bulb.y); ctx.stroke();
  const width = lamp.kind === 'ceiling' ? 13 : lamp.kind === 'wall' ? 6 : 10;
  crewPolygon(ctx, [
    { x: bulb.x - width, y: bulb.y + 2 }, { x: bulb.x + width, y: bulb.y + 2 },
    { x: bulb.x + width * .55, y: bulb.y - 7 }, { x: bulb.x - width * .55, y: bulb.y - 7 },
  ], shade, metal);
  ctx.fillStyle = light; ctx.strokeStyle = metal;
  ctx.beginPath(); ctx.ellipse(bulb.x, bulb.y + 2, width, 3, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  if (lamp.kind === 'desk' || lamp.kind === 'reception') {
    ctx.fillStyle = metal;
    ctx.beginPath(); ctx.ellipse(base.x, base.y, 7, 2, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
