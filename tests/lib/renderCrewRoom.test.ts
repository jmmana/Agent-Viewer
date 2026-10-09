import { describe, expect, it } from 'vitest';
import { CREW_ROOMS } from '../../src/crew/crewModel';
import { crewGeometryBounds, crewIsoPoint, crewViewSize, renderCrewRoom } from '../../src/crew/renderCrewRoom';

describe('Crew native 2.5D renderer', () => {
  it('dibuja el original solo para el CEO presente y conserva marcadores si falta la imagen', () => {
    const drawn: unknown[][] = [];
    const labels: unknown[][] = [];
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get(_target,key) {
        if (key === 'drawImage') return (...args: unknown[]) => drawn.push(args);
        if (key === 'fillText') return (...args: unknown[]) => labels.push(args);
        return () => {};
      },
      set() { return true; },
    });
    const markers = [
      {id:'ceo',name:'Fixture CEO',role:'boss' as const,status:'IDLE' as const,x:2,y:3,number:1},
      {id:'other',name:'Fixture other',role:'custom' as const,status:'IDLE' as const,x:4,y:3,number:2},
    ];
    const input = {ctx,width:900,height:600,room:CREW_ROOMS[0],
      camera:{view:'front' as const,zoom:1,pan:{x:0,y:0}},markers};
    renderCrewRoom(input);
    expect(drawn).toHaveLength(0);
    expect(labels).toHaveLength(2);
    const sprite = {} as HTMLImageElement;
    renderCrewRoom({...input,sprite});
    expect(drawn).toHaveLength(1);
    expect(drawn[0][0]).toBe(sprite);
    renderCrewRoom({...input,sprite,markers:[]});
    expect(drawn).toHaveLength(1);
  });
  it('projects floor and wall height into separate axes', () => {
    expect(crewIsoPoint(2, 1)).toEqual({ x: 34, y: 54 });
    expect(crewIsoPoint(2, 1, 20)).toEqual({ x: 34, y: 34 });
  });
  it('keeps room-local dimensions and changes them for side views', () => {
    const [ceo, dev] = CREW_ROOMS;
    expect(crewViewSize(ceo, 'front')).toEqual({ width: 11, depth: 8 });
    expect(crewViewSize(ceo, 'right')).toEqual({ width: 8, depth: 11 });
    const bounds = crewGeometryBounds(dev, 'left');
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    expect(crewGeometryBounds(ceo, 'front')).not.toEqual(crewGeometryBounds(dev, 'front'));
  });
  it('draws exactly the selected room, without consulting legacy office', () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get(_target, key) {
        if (key === 'fillText') return (...args: unknown[]) => { calls.push(['text', ...args]); };
        if (key === 'fillRect') return (...args: unknown[]) => { calls.push(['rect', ...args]); };
        return () => {};
      },
      set() { return true; },
    });
    renderCrewRoom({ ctx, width: 900, height: 600, room: CREW_ROOMS[0],
      camera: { view: 'front', zoom: 1, pan: { x: 0, y: 0 } }, locale: 'es' });
    expect(calls.filter(row => row[0] === 'text')).toHaveLength(0);
    expect(calls.filter(row => row[0]==='rect')).toHaveLength(1);
  });
});
