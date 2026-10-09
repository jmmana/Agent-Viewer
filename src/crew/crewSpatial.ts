import type { CrewRoomDefinition } from './crewModel';

export const CREW_PROP_SIZE = {
  desk: {width:1.5,depth:.9,height:28},
  chair: {width:.7,depth:.7,height:22},
  plant: {width:.6,depth:.6,height:34},
  screen: {width:.9,depth:.35,height:48},
} as const;

export interface CrewLocalPoint { x: number; y: number }
export const CREW_PRESENCE_RADIUS = .3;

/** Huellas locales compartidas con el renderer; no usa coordenadas de Caricatura. */
export function crewPointIsFree(room: CrewRoomDefinition, point: CrewLocalPoint, radius = CREW_PRESENCE_RADIUS): boolean {
  if (point.x < radius || point.y < radius || point.x > room.width-radius || point.y > room.depth-radius) return false;
  return room.furniture.every(item => {
    const size = CREW_PROP_SIZE[item.type];
    const closestX = Math.max(item.x-size.width/2, Math.min(item.x+size.width/2,point.x));
    const closestY = Math.max(item.y-size.depth/2, Math.min(item.y+size.depth/2,point.y));
    return Math.hypot(point.x-closestX,point.y-closestY) > radius;
  });
}

/** Anclajes provisionales de presencia, no rutas ni reservas de silla. */
export function crewPresenceSlots(room: CrewRoomDefinition): CrewLocalPoint[] {
  const points: CrewLocalPoint[] = [];
  for (let y=.75;y<=room.depth-.75;y+=1) {
    for (let x=.75;x<=room.width-.75;x+=1) {
      if (crewPointIsFree(room,{x,y})) points.push({x,y});
    }
  }
  return points;
}
