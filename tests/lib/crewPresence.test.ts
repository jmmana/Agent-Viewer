import { describe, expect, it } from 'vitest';
import { CREW_ROOMS } from '../../src/crew/crewModel';
import { projectCrewPresence } from '../../src/crew/crewPresence';
import { crewPointIsFree, crewPresenceSlots, CREW_PRESENCE_RADIUS } from '../../src/crew/crewSpatial';

const room = CREW_ROOMS[1];
const agent = (index: number) => Object.freeze({id:`agent-${index}`,name:`Fixture ${index}`,workspace:'development' as const,status:'CODING' as const});

describe('Presencia espacial Crew de solo lectura', () => {
  it('no crea presencia cuando no hay eventos o la sala no corresponde', () => {
    expect(projectCrewPresence([],room)).toEqual({markers:[],unplaced:[]});
    expect(projectCrewPresence([agent(1)],CREW_ROOMS[0]).markers).toHaveLength(0);
    expect(projectCrewPresence([{...agent(1),workspace:'unknown' as never}],room).markers).toHaveLength(0);
  });
  it('ubica 50 agentes reales del snapshot sin superponerlos con muebles ni entre ellos', () => {
    const agents = Object.freeze(Array.from({length:50},(_,i)=>agent(i)));
    const before = JSON.stringify(agents);
    const result = projectCrewPresence(agents,room);
    expect(result.markers).toHaveLength(50);
    expect(result.unplaced).toHaveLength(0);
    for (const marker of result.markers) {
      expect(crewPointIsFree(room,marker)).toBe(true);
      for (const other of result.markers.filter(item=>item.id!==marker.id)) {
        expect(Math.hypot(marker.x-other.x,marker.y-other.y)).toBeGreaterThan(2*CREW_PRESENCE_RADIUS);
      }
    }
    expect(JSON.stringify(agents)).toBe(before);
  });
  it('repite la misma proyección al reproducir el snapshot o cambiar su orden', () => {
    const agents = [agent(9),agent(3),agent(18)];
    expect(projectCrewPresence(agents,room)).toEqual(projectCrewPresence([...agents].reverse(),room));
  });
  it('hace explícita la capacidad excedida en lugar de superponer marcadores', () => {
    const agents = Array.from({length:500},(_,i)=>agent(i));
    const result = projectCrewPresence(agents,room);
    expect(result.markers).toHaveLength(crewPresenceSlots(room).length);
    expect(result.markers.length+result.unplaced.length).toBe(500);
    expect(new Set(result.markers.map(item=>`${item.x},${item.y}`)).size).toBe(result.markers.length);
  });
  it('excluye paredes y huellas de muebles, incluso cerca de sus esquinas', () => {
    expect(crewPointIsFree(room,{x:0,y:2})).toBe(false);
    const desk = room.furniture[0];
    expect(crewPointIsFree(room,desk)).toBe(false);
    expect(crewPointIsFree(room,{x:desk.x+.8,y:desk.y+.5})).toBe(false);
    expect(crewPointIsFree(room,{x:room.width+1,y:room.depth+1})).toBe(false);
  });
});
