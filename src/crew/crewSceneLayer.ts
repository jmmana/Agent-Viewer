import { crewProject, type CrewRoomDefinition, type CrewView } from './crewModel';
import { crewPolygon, type CrewPoint } from './crewRenderPrimitives';
import { CREW_BACKGROUND_COLOR, CREW_DOOR_COLOR, CREW_FLOOR_GRID_STYLE, CREW_WALL_SHADES, crewFloorColor } from './crewLightingLayer';

/**
 * Capa de escena: estructura fija de una sala Crew (fondo, paredes traseras, piso,
 * cuadrícula y umbrales de puerta). No dibuja props, sprites ni HUD; eso vive en
 * `crewPropsLayer`, `crewSpriteLayer` y `crewHudLayer`. Nunca importa el renderer
 * ni la cuadrícula de la oficina Caricatura.
 */
export interface CrewSceneGeometry {
  /** Proyección isométrica compartida con props y sprites (mismos ejes y escala). */
  isoPoint: (x: number, y: number, z?: number) => CrewPoint;
  wallHeight: number;
}

/** Fondo de cámara en píxeles de pantalla, antes de aplicar la transformación de escena. */
export function drawCrewBackground(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.fillStyle = CREW_BACKGROUND_COLOR;
  ctx.fillRect(0, 0, width, height);
}

/** Dos paredes traseras con altura 2.5D y el piso de la sala; las frontales se omiten (cutaway). */
export function drawCrewRoomShell(ctx: CanvasRenderingContext2D, room: Pick<CrewRoomDefinition, 'id'>,
  width: number, depth: number, { isoPoint, wallHeight }: CrewSceneGeometry): void {
  const corners = [isoPoint(0, 0), isoPoint(width, 0), isoPoint(width, depth), isoPoint(0, depth)];
  crewPolygon(ctx, [corners[0], corners[1], isoPoint(width, 0, wallHeight), isoPoint(0, 0, wallHeight)], CREW_WALL_SHADES.xWall);
  crewPolygon(ctx, [corners[3], corners[0], isoPoint(0, 0, wallHeight), isoPoint(0, depth, wallHeight)], CREW_WALL_SHADES.yWall);
  crewPolygon(ctx, corners, crewFloorColor(room));
}

/** Cuadrícula de piso cada unidad local; es ayuda visual, no un contrato de celdas. */
export function drawCrewFloorGrid(ctx: CanvasRenderingContext2D, width: number, depth: number, { isoPoint }: CrewSceneGeometry): void {
  ctx.strokeStyle = CREW_FLOOR_GRID_STYLE.stroke;
  ctx.lineWidth = CREW_FLOOR_GRID_STYLE.lineWidth;
  for (let x = 0; x <= width; x++) {
    const p = isoPoint(x, 0), q = isoPoint(x, depth);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }
  for (let y = 0; y <= depth; y++) {
    const p = isoPoint(0, y), q = isoPoint(width, y);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }
}

/** Umbral de cada puerta local, reproyectado con la cámara de la sala, nunca con el mapa global. */
export function drawCrewDoors(ctx: CanvasRenderingContext2D, room: CrewRoomDefinition, view: CrewView,
  { isoPoint }: CrewSceneGeometry): void {
  for (const door of room.doors) {
    const start = crewProject(door.offset - door.width / 2, room.depth, room, view);
    const end = crewProject(door.offset + door.width / 2, room.depth, room, view);
    crewPolygon(ctx, [isoPoint(start.x, start.y), isoPoint(end.x, end.y),
      isoPoint(end.x, end.y, 38), isoPoint(start.x, start.y, 38)], CREW_DOOR_COLOR.fill, CREW_DOOR_COLOR.stroke);
  }
}
