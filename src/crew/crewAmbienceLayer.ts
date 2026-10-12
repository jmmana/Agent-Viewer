import { CREW_AMBIENCE_PALETTES, type CrewAmbience } from './crewAmbience';
import { crewProject, type CrewRoomDefinition, type CrewView } from './crewModel';
import { crewPolygon } from './crewRenderPrimitives';
import type { CrewSceneGeometry } from './crewSceneLayer';

/** Four fixed room-local windows. Only windows on the two uncut walls are drawn.
 * Everything shares the room projection/zoom; skyline is original procedural art.
 * No image requests, random state, animation, or sensitive outside-world data.
 */
export function drawCrewAmbience(ctx: CanvasRenderingContext2D, room: CrewRoomDefinition,
  view: CrewView, { isoPoint }: CrewSceneGeometry, ambience: CrewAmbience, highContrast = false): void {
  const palette = CREW_AMBIENCE_PALETTES[ambience];
  const windows = [
    [{ x: room.width * .3, y: 0 }, { x: room.width * .65, y: 0 }],
    [{ x: room.width, y: room.depth * .3 }, { x: room.width, y: room.depth * .65 }],
    [{ x: room.width * .3, y: room.depth }, { x: room.width * .65, y: room.depth }],
    [{ x: 0, y: room.depth * .3 }, { x: 0, y: room.depth * .65 }],
  ];
  ctx.save();
  ctx.lineWidth = 1.5;
  for (const [a, b] of windows) {
    const start = crewProject(a.x, a.y, room, view);
    const end = crewProject(b.x, b.y, room, view);
    const onXWall = start.y === 0 && end.y === 0;
    const onYWall = start.x === 0 && end.x === 0;
    if (!onXWall && !onYWall) continue;
    const point = (t: number, z: number) => isoPoint(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t, z);
    const panel = (left: number, right: number, bottom: number, top: number, fill: string, stroke?: string) =>
      crewPolygon(ctx, [point(left, bottom), point(right, bottom), point(right, top), point(left, top)], fill, stroke ?? fill);
    panel(0, 1, 23, 56, highContrast ? '#000000' : palette.sky, highContrast ? '#ffffff' : '#dce8f0');
    // Six buildings with deterministic heights; clipped by construction to the glass.
    for (let i = 0; i < 6; i++) {
      const left = .025 + i * .16;
      const top = 30 + [4, 11, 7, 15, 9, 5][i];
      panel(left, left + .12, 24, top, highContrast ? '#555555' : palette.skyline);
      if (ambience === 'night') panel(left + .025, left + .065, top - 5, top - 2, highContrast ? '#ffffff' : '#efd7a2');
    }
    panel(.485, .515, 23, 56, highContrast ? '#ffffff' : '#dce8f0');
    panel(0, 1, 37, 38, highContrast ? '#ffffff' : '#dce8f0');
    if (!highContrast) {
      // Flat, bounded floor light/shadow, below all actors/props and their labels.
      const inward = onXWall ? { x: 0, y: 1 } : { x: 1, y: 0 };
      const reach = ambience === 'day' ? 1.4 : 2.2;
      ctx.globalAlpha = ambience === 'night' ? .06 : .16;
      crewPolygon(ctx, [isoPoint(start.x, start.y), isoPoint(end.x, end.y),
        isoPoint(end.x + inward.x * reach, end.y + inward.y * reach),
        isoPoint(start.x + inward.x * reach, start.y + inward.y * reach)], palette.glass, palette.glass);
      ctx.globalAlpha = 1;
      crewPolygon(ctx, [isoPoint(start.x + inward.x * reach, start.y + inward.y * reach),
        isoPoint(end.x + inward.x * reach, end.y + inward.y * reach),
        isoPoint(end.x + inward.x * (reach + .12), end.y + inward.y * (reach + .12)),
        isoPoint(start.x + inward.x * (reach + .12), start.y + inward.y * (reach + .12))], palette.shadow, palette.shadow);
    }
  }
  ctx.restore();
}
