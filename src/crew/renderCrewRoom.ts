import { crewProject, type CrewRoomDefinition, type CrewView } from './crewModel';
import { CREW_PROP_SIZE } from './crewSpatial';
import type { CrewPresenceMarker } from './crewPresence';
import type { CrewCamera } from './crewCamera';
import { CREW_CEO_SPRITE, crewSpriteView } from './crewSprites';

/**
 * A standalone 2.5D Crew renderer prototype.
 *
 * It draws ONE room in local coordinates, with physical cutaway walls and
 * separate depth-sorted props. The old office grid/renderer is never imported.
 * Geometry is provisional; illustrated actors require actual room presence.
 */
export interface CrewRenderInput {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  room: CrewRoomDefinition;
  camera: CrewCamera;
  locale?: string;
  markers?: readonly CrewPresenceMarker[];
  sprite?: HTMLImageElement;
  sprites?: Partial<Record<CrewView, HTMLImageElement>>;
}
export const CREW_TILE_X = 34;
export const CREW_TILE_Y = 18;
export const CREW_WALL_HEIGHT = 64;

export interface CrewPoint { x: number; y: number }
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
function polygon(ctx: CanvasRenderingContext2D, points: readonly CrewPoint[], fill: string, stroke = '#334155') {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke();
}
function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, d: number, h: number,
  color: { top: string; side: string; front: string }) {
  const a = crewIsoPoint(x-w/2,y-d/2), b = crewIsoPoint(x+w/2,y-d/2);
  const c = crewIsoPoint(x+w/2,y+d/2), e = crewIsoPoint(x-w/2,y+d/2);
  const at = crewIsoPoint(x-w/2,y-d/2,h), bt = crewIsoPoint(x+w/2,y-d/2,h);
  const ct = crewIsoPoint(x+w/2,y+d/2,h), et = crewIsoPoint(x-w/2,y+d/2,h);
  polygon(ctx,[e,c,ct,et],color.front);
  polygon(ctx,[b,c,ct,bt],color.side);
  polygon(ctx,[at,bt,ct,et],color.top);
}
const color = {
  desk: { top: '#b98050', side: '#62462f', front: '#8c603e' },
  chair: { top: '#7f9cc2', side: '#2c4969', front: '#496a92' },
  plant: { top: '#39b878', side: '#1c754a', front: '#2d925d' },
  screen: { top: '#4bb8d7', side: '#1c3548', front: '#214b64' },
} as const;

/** Escala compartida por encuadre y foco, expresada en píxeles CSS. */
export function crewFitScale(room: CrewRoomDefinition, view: CrewView, width: number, height: number): number {
  const bounds = crewGeometryBounds(room, view);
  return Math.max(.15, Math.min((width - 72) / bounds.width, (height - 72) / bounds.height, 2));
}

/** Render only this room, with no clock, fake agents, usage or side-effects. */
export function renderCrewRoom({ ctx, width, height, room, camera, markers = [], sprite, sprites }: CrewRenderInput): void {
  const { view, zoom, pan } = camera;
  const roomSize = crewViewSize(room, view);
  const bounds = crewGeometryBounds(room, view);
  const fit = crewFitScale(room, view, width, height);
  ctx.save();
  ctx.fillStyle = '#142339'; ctx.fillRect(0,0,width,height);
  ctx.translate(width/2+pan.x,height/2+pan.y);
  ctx.scale(fit*zoom,fit*zoom);
  ctx.translate(-bounds.centerX,-bounds.centerY);

  // Two back walls with correct 2.5D height; front walls omitted for cutaway visibility.
  const w=roomSize.width, d=roomSize.depth;
  const corners = [crewIsoPoint(0,0),crewIsoPoint(w,0),crewIsoPoint(w,d),crewIsoPoint(0,d)];
  polygon(ctx,[corners[0],corners[1],crewIsoPoint(w,0,CREW_WALL_HEIGHT),
    crewIsoPoint(0,0,CREW_WALL_HEIGHT)],'#90a5b4');
  polygon(ctx,[corners[3],corners[0],crewIsoPoint(0,0,CREW_WALL_HEIGHT),
    crewIsoPoint(0,d,CREW_WALL_HEIGHT)],'#607c95');
  polygon(ctx,corners,room.id==='ceo'?'#d9c6a9':'#b3bdc7');

  ctx.strokeStyle='rgba(71,85,105,.26)';ctx.lineWidth=.65;
  for(let x=0;x<=w;x++){
    const p=crewIsoPoint(x,0),q=crewIsoPoint(x,d);
    ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();
  }
  for(let y=0;y<=d;y++){
    const p=crewIsoPoint(0,y),q=crewIsoPoint(w,y);
    ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();
  }

  // Project every furniture anchor from ORIGINAL room-local coordinates; sorted
  // by rotated depth. This is a new renderer, not legacy furniture overlay.
  const visible = [
    ...room.furniture.map(item => {
      const p = crewProject(item.x,item.y,room,view);
      return {x:p.x,y:p.y,draw:()=>{
        const size = CREW_PROP_SIZE[item.type];
        const sideView = view === 'left' || view === 'right';
        box(ctx,p.x,p.y,sideView?size.depth:size.width,sideView?size.width:size.depth,size.height,color[item.type]);
      }};
    }),
    ...markers.map(marker => {
      const p = crewProject(marker.x,marker.y,room,view);
      return {x:p.x,y:p.y,draw:()=>{
        const point = crewIsoPoint(p.x,p.y);
        const poseView = crewSpriteView(marker, view);
        const pose = poseView ? sprites?.[poseView] ?? (poseView === view ? sprite : undefined) : undefined;
        if (pose) {
          const spec = CREW_CEO_SPRITE;
          const height = spec.displayHeight, width = height * spec.width / spec.height;
          ctx.drawImage(pose,point.x-width*spec.anchor.x,point.y-height*spec.anchor.y,width,height);
        }
        const badgeY = point.y + (pose ? 9 : 0);
        ctx.beginPath();
        ctx.ellipse(point.x,badgeY,12,8,0,0,Math.PI*2);
        ctx.fillStyle = marker.status === 'ERROR' || marker.status === 'BLOCKED' ? '#b91c1c' : '#1d4ed8';
        ctx.fill();
        ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(marker.number),point.x,badgeY);
      }};
    }),
  ].sort((a,b)=>(a.x+a.y)-(b.x+b.y));
  for (const item of visible) item.draw();
  ctx.restore();
}
