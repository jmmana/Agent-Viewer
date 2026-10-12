import { drawCrewAmbience } from './crewAmbienceLayer';
import type { CrewAmbience } from './crewAmbience';
import { drawCrewWorkstation } from './crewWorkstationLayer';
import { crewProject, type CrewRoomDefinition, type CrewView } from './crewModel';
import type { CrewWorkstation } from './crewActorActions';
import type { CrewPresenceMarker } from './crewPresence';
import type { CrewCamera } from './crewCamera';
import { crewSpriteView, type CrewSpriteImages } from './crewSprites';
import type { CrewPoint } from './crewRenderPrimitives';
import { drawCrewBackground, drawCrewDoors, drawCrewFloorGrid, drawCrewRoomShell, type CrewSceneGeometry } from './crewSceneLayer';
import { drawCrewProp, type CrewPropImageSpec } from './crewPropsLayer';
import { drawCrewSprite, type CrewSpriteBlink } from './crewSpriteLayer';
import { drawCrewPresenceBadge } from './crewHudLayer';
import { drawCrewCallOverlay, type CrewCallOverlayStyle } from './crewCallLayer';
import { CREW_PROP_IMAGE_SIZE, CREW_ROOM_PROP_IMAGES, type CrewPropImageId } from './crewPropImages';
import { crewIsPointCulled, crewVisibleLocalBounds } from './crewCulling';

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
  ambience?: CrewAmbience;
  workstationImage?: HTMLImageElement;
  seats?: readonly CrewWorkstation[];
  actions?: Readonly<Record<string, CrewSpriteBlink | undefined>>;
  walks?: Readonly<Record<string, CrewSpriteBlink | undefined>>;
  /** Imágenes reales del banco Crew por mueble, alcance acotado de #115 (ver `CREW_ROOM_PROP_IMAGES`). */
  propImages?: Partial<Record<CrewPropImageId, HTMLImageElement>>;
  /** Estilo de la superposición de llamada (#145) por id de marcador; sin entrada, no se dibuja nada. */
  calls?: Readonly<Record<string, CrewCallOverlayStyle>>;
  /** Icono compartido de llamada (`effects/call.svg`); sin él, la superposición usa su glifo de respaldo. */
  callIcon?: HTMLImageElement;
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
export function renderCrewRoom({ ctx, width, height, room, camera, markers = [], sprites = {}, blink, highContrast = false, ambience = 'day', walks = {}, actions = {}, propImages, seats = [], workstationImage, calls = {}, callIcon }: CrewRenderInput): void {
  const { view, zoom, pan } = camera;
  const roomSize = crewViewSize(room, view);
  const bounds = crewGeometryBounds(room, view);
  const fit = crewFitScale(room, view, width, height);
  ctx.save();
  drawCrewBackground(ctx, width, height, highContrast, ambience);
  ctx.translate(width/2+pan.x,height/2+pan.y);
  ctx.scale(fit*zoom,fit*zoom);
  ctx.translate(-bounds.centerX,-bounds.centerY);

  const geometry: CrewSceneGeometry = { isoPoint: crewIsoPoint, wallHeight: CREW_WALL_HEIGHT };
  drawCrewRoomShell(ctx, room, roomSize.width, roomSize.depth, geometry, highContrast, ambience);
  drawCrewFloorGrid(ctx, roomSize.width, roomSize.depth, geometry, highContrast);
  drawCrewAmbience(ctx, room, view, geometry, ambience, highContrast);
  drawCrewDoors(ctx, room, view, geometry);

  // Project every furniture anchor and marker from ORIGINAL room-local coordinates;
  // sorted by rotated depth so props and actors interleave correctly in 2.5D.
  const fitted = workstationImage && room.id === 'ceo' ? seats.filter(seat => {
    const marker = markers.find(item => item.id === seat.actorId);
    const facing = marker && crewSpriteView(marker, view);
    return marker && facing && sprites[facing] && actions[marker.id] && !walks[marker.id];
  }) : [];
  // Culling de actores y mobiliario fuera de vista (issue #158, "batch/culling de
  // actores/partículas"): el área visible se calcula una sola vez por cuadro, en el
  // mismo espacio local que `point` (post `crewIsoPoint`), y cada item fuera de ella
  // se descarta antes de ordenar y de dibujar, sin emitir ningún `drawImage`/`fillText`.
  const visibleBounds = crewVisibleLocalBounds(width, height, fit, zoom, pan, { x: bounds.centerX, y: bounds.centerY });
  const visible = [
    ...room.furniture.filter(item => !fitted.some(seat => item.id === seat.deskId || item.id === seat.chairId)).map(item => {
      const seat = seats.find(station => station.chairId === item.id);
      const p = crewProject(seat?.x ?? item.x,seat?.y ?? item.y,room,view);
      const point = crewIsoPoint(p.x, p.y);
      return {x:p.x,y:p.y,point,draw:()=>drawCrewProp(ctx, item, p.x, p.y, view, crewIsoPoint, highContrast,
        resolveCrewPropImage(item.id, propImages), ambience)};
    }),
    ...markers.map(marker => {
      const p = crewProject(marker.x,marker.y,room,view);
      const point = crewIsoPoint(p.x,p.y);
      return {x:p.x,y:p.y,point,draw:()=>{
        const direction = crewSpriteView(marker, view);
        const seat = fitted.find(item => item.actorId === marker.id);
        let spriteDrawn: boolean;
        if (seat && direction && workstationImage) {
          drawCrewWorkstation(ctx, point, direction, workstationImage, sprites, actions[marker.id]!);
          spriteDrawn = true;
        } else spriteDrawn = drawCrewSprite(ctx, point, direction, sprites, blink, walks[marker.id], actions[marker.id]);
        drawCrewPresenceBadge(ctx, point, marker, spriteDrawn);
        const call = calls[marker.id];
        if (call) drawCrewCallOverlay(ctx, point, spriteDrawn, { ...call, icon: callIcon });
      }};
    }),
  ]
    .filter(entry => !crewIsPointCulled(entry.point, visibleBounds))
    .sort((a,b)=>(a.x+a.y)-(b.x+b.y));
  for (const item of visible) item.draw();
  ctx.restore();
}
