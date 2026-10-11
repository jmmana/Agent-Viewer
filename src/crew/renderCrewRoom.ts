import { crewProject, type CrewRoomDefinition, type CrewView } from './crewModel';
import type { CrewPresenceMarker } from './crewPresence';
import type { CrewCamera } from './crewCamera';
import { crewSpriteView, type CrewSpriteImages } from './crewSprites';
import type { CrewPoint } from './crewRenderPrimitives';
import { drawCrewBackground, drawCrewDoors, drawCrewFloorGrid, drawCrewRoomShell, type CrewSceneGeometry } from './crewSceneLayer';
import { drawCrewProp, type CrewPropImageSpec } from './crewPropsLayer';
import { drawCrewSprite, type CrewSpriteBlink } from './crewSpriteLayer';
import { drawCrewPresenceBadge } from './crewHudLayer';
import { CREW_PROP_IMAGE_SIZE, CREW_ROOM_PROP_IMAGES, type CrewPropImageId } from './crewPropImages';

/**
 * A standalone 2.5D Crew renderer prototype.
 *
 * It draws ONE room in local coordinates, with physical cutaway walls and
 * separate depth-sorted props. The old office grid/renderer is never imported.
 * Geometry is provisional; illustrated actors require actual room presence.
 *
 * Es solo el orquestador: calcula cámara y proyección, y delega el dibujo en
 * capas independientes y testeadas por separado: `crewSceneLayer` (estructura de
 * la sala), `crewPropsLayer` (muebles), `crewSpriteLayer` (actores) y
 * `crewHudLayer` (insignia de presencia). `crewLightingLayer` centraliza los
 * tonos que escena y props comparten.
 */
export interface CrewRenderInput {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  room: CrewRoomDefinition;
  camera: CrewCamera;
  locale?: string;
  markers?: readonly CrewPresenceMarker[];
  sprites?: CrewSpriteImages;
  blink?: CrewSpriteBlink;
  /** Tema de alto contraste de la preferencia de accesibilidad Crew (#157). */
  highContrast?: boolean;
  actions?: Readonly<Record<string, CrewSpriteBlink | undefined>>;
  walks?: Readonly<Record<string, CrewSpriteBlink | undefined>>;
  /** Imágenes reales del banco Crew por mueble, alcance acotado de #115 (ver `CREW_ROOM_PROP_IMAGES`). */
  propImages?: Partial<Record<CrewPropImageId, HTMLImageElement>>;
}

/** Resuelve la imagen real (si existe y ya cargó) para un mueble puntual, sin mutar el input. */
function resolveCrewPropImage(itemId: string,
  propImages?: Partial<Record<CrewPropImageId, HTMLImageElement>>): CrewPropImageSpec | undefined {
  const imageId = CREW_ROOM_PROP_IMAGES[itemId];
  const image = imageId && propImages ? propImages[imageId] : undefined;
  return image ? { image, ...CREW_PROP_IMAGE_SIZE[imageId] } : undefined;
}
export const CREW_TILE_X = 34;
export const CREW_TILE_Y = 18;
export const CREW_WALL_HEIGHT = 64;

export type { CrewPoint };
export function crewIsoPoint(x: number, y: number, z = 0): CrewPoint {
  return { x: (x - y) * CREW_TILE_X, y: (x + y) * CREW_TILE_Y - z };
}
export function crewViewSize(room: CrewRoomDefinition, view: CrewView) {
  return view === 'front' || view === 'back'
    ? { width: room.width, depth: room.depth }
    : { width: room.depth, depth: room.width };
}
export function crewGeometryBounds(room: CrewRoomDefinition, view: CrewView) {
  const { width, depth } = crewViewSize(room, view);
  const points = [
    crewIsoPoint(0, 0, CREW_WALL_HEIGHT), crewIsoPoint(width, 0, CREW_WALL_HEIGHT),
    crewIsoPoint(width, depth), crewIsoPoint(0, depth),
    crewIsoPoint(0, 0), crewIsoPoint(width, 0), crewIsoPoint(width, depth), crewIsoPoint(0, depth),
  ];
  const minX = Math.min(...points.map(p => p.x));
  const maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y));
  const maxY = Math.max(...points.map(p => p.y));
  return { minX, maxX, minY, maxY, width: maxX-minX, height: maxY-minY,
    centerX: (minX+maxX)/2, centerY: (minY+maxY)/2 };
}

/** Escala compartida por encuadre y foco, expresada en píxeles CSS. */
export function crewFitScale(room: CrewRoomDefinition, view: CrewView, width: number, height: number): number {
  const bounds = crewGeometryBounds(room, view);
  return Math.max(.15, Math.min((width - 72) / bounds.width, (height - 72) / bounds.height, 2));
}

/** Render only this room, with no clock, fake agents, usage or side-effects. */
export function renderCrewRoom({ ctx, width, height, room, camera, markers = [], sprites = {}, blink, highContrast = false, walks = {}, actions = {}, propImages }: CrewRenderInput): void {
  const { view, zoom, pan } = camera;
  const roomSize = crewViewSize(room, view);
  const bounds = crewGeometryBounds(room, view);
  const fit = crewFitScale(room, view, width, height);
  ctx.save();
  drawCrewBackground(ctx, width, height, highContrast);
  ctx.translate(width/2+pan.x,height/2+pan.y);
  ctx.scale(fit*zoom,fit*zoom);
  ctx.translate(-bounds.centerX,-bounds.centerY);

  const geometry: CrewSceneGeometry = { isoPoint: crewIsoPoint, wallHeight: CREW_WALL_HEIGHT };
  drawCrewRoomShell(ctx, room, roomSize.width, roomSize.depth, geometry, highContrast);
  drawCrewFloorGrid(ctx, roomSize.width, roomSize.depth, geometry, highContrast);
  drawCrewDoors(ctx, room, view, geometry);

  // Project every furniture anchor and marker from ORIGINAL room-local coordinates;
  // sorted by rotated depth so props and actors interleave correctly in 2.5D.
  const visible = [
    ...room.furniture.map(item => {
      const p = crewProject(item.x,item.y,room,view);
      return {x:p.x,y:p.y,draw:()=>drawCrewProp(ctx, item, p.x, p.y, view, crewIsoPoint, highContrast,
        resolveCrewPropImage(item.id, propImages))};
    }),
    ...markers.map(marker => {
      const p = crewProject(marker.x,marker.y,room,view);
      return {x:p.x,y:p.y,draw:()=>{
        const point = crewIsoPoint(p.x,p.y);
        const direction = crewSpriteView(marker, view);
        const spriteDrawn = drawCrewSprite(ctx, point, direction, sprites, blink, walks[marker.id], actions[marker.id]);
        drawCrewPresenceBadge(ctx, point, marker, spriteDrawn);
      }};
    }),
  ].sort((a,b)=>(a.x+a.y)-(b.x+b.y));
  for (const item of visible) item.draw();
  ctx.restore();
}
