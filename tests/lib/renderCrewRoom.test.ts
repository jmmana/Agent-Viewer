import { describe, expect, it } from 'vitest';
import { CREW_ROOMS } from '../../src/crew/crewModel';
import { crewGeometryBounds, crewIsoPoint, crewViewSize, renderCrewRoom } from '../../src/crew/renderCrewRoom';

describe('Crew native 2.5D renderer', () => {
  it('reproyecta el umbral de la puerta local al cambiar de cámara', () => {
    let path: unknown[][] = [];
    let fill = '';
    const doors: unknown[][][] = [];
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get(_target,key) {
        if (key === 'beginPath') return () => { path = []; };
        if (key === 'moveTo' || key === 'lineTo') return (...args:unknown[]) => path.push(args);
        if (key === 'fill') return () => { if (fill === '#263b4d') doors.push([...path]); };
        return () => {};
      },
      set(_target,key,value) { if (key === 'fillStyle') fill = value; return true; },
    });
    for (const view of ['front','right'] as const) renderCrewRoom({ctx,width:900,height:600,room:CREW_ROOMS[0],
      camera:{view,zoom:1,pan:{x:0,y:0}}});
    expect(doors).toHaveLength(2);
    expect(doors[0][0]).toEqual(Object.values(crewIsoPoint(.25,8)));
    expect(doors[1][0]).toEqual(Object.values(crewIsoPoint(0,.25)));
    expect(doors[0]).not.toEqual(doors[1]);
  });
  it('selecciona imagen por actor y aplica parpadeo solo al rostro visible', () => {
    const drawn: unknown[][]=[];
    const ctx=new Proxy({} as CanvasRenderingContext2D,{
      get(_target,key){return key==='drawImage' ? (...args:unknown[])=>drawn.push(args) : ()=>{};},
      set(){return true;},
    });
    const front={} as HTMLImageElement, back={} as HTMLImageElement, atlas={} as HTMLImageElement;
    const markers=[
      {id:'a',name:'A',role:'boss' as const,facing:'NE' as const,status:'IDLE' as const,x:2,y:2,number:1},
      {id:'b',name:'B',role:'boss' as const,facing:'SW' as const,status:'IDLE' as const,x:4,y:4,number:2},
    ];
    renderCrewRoom({ctx,width:900,height:600,room:CREW_ROOMS[0],markers,
      camera:{view:'right',zoom:1,pan:{x:0,y:0}},sprites:{front,back},
      blink:{image:atlas,frame:{x:0,y:0,width:535,height:735,anchor:{x:267.5,y:678},durationMs:100}}});
    expect(drawn.map(call=>call[0])).toEqual([atlas,back]);
    expect(drawn[0]).toHaveLength(9);
    expect(drawn[1]).toHaveLength(5);
  });
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
    renderCrewRoom({...input,sprites:{front:sprite}});
    expect(drawn).toHaveLength(1);
    expect(drawn[0][0]).toBe(sprite);
    renderCrewRoom({...input,sprites:{front:sprite},markers:[]});
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
  // Piloto acotado de #115: escritorio y planta de Dirección reciben la imagen real
  // del banco en las cuatro cámaras; el resto de las salas no pide ni dibuja imagen.
  it('dibuja el escritorio y la planta de Dirección con la imagen real del banco en las cuatro cámaras', () => {
    const [ceo] = CREW_ROOMS;
    const desk = {} as HTMLImageElement, plant = {} as HTMLImageElement;
    for (const view of ['front', 'right', 'back', 'left'] as const) {
      const drawn: unknown[][] = [];
      const ctx = new Proxy({} as CanvasRenderingContext2D, {
        get(_target, key) { return key === 'drawImage' ? (...args: unknown[]) => drawn.push(args) : () => {}; },
        set() { return true; },
      });
      renderCrewRoom({ ctx, width: 900, height: 600, room: ceo, camera: { view, zoom: 1, pan: { x: 0, y: 0 } },
        propImages: { 'desk-executive': desk, 'plant-floor': plant } });
      expect(drawn.map(call => call[0])).toEqual(expect.arrayContaining([desk, plant]));
      expect(drawn).toHaveLength(2);
    }
  });

  it('conserva el bloque 2.5D de un mueble de Dirección si su imagen todavía no cargó', () => {
    const [ceo] = CREW_ROOMS;
    const drawnImages: unknown[][] = [];
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get(_target, key) { return key === 'drawImage' ? (...args: unknown[]) => drawnImages.push(args) : () => {}; },
      set() { return true; },
    });
    // Sin propImages (carga en curso o falla): ningún drawImage de mobiliario, el bloque 2.5D sigue intacto.
    renderCrewRoom({ ctx, width: 900, height: 600, room: ceo, camera: { view: 'front', zoom: 1, pan: { x: 0, y: 0 } } });
    expect(drawnImages).toHaveLength(0);
    renderCrewRoom({ ctx, width: 900, height: 600, room: ceo, camera: { view: 'front', zoom: 1, pan: { x: 0, y: 0 } },
      propImages: { 'desk-executive': undefined, 'plant-floor': undefined } });
    expect(drawnImages).toHaveLength(0);
  });

  it('no pide ni dibuja imagen de mobiliario en una sala fuera del alcance acotado', () => {
    const development = CREW_ROOMS.find(room => room.id === 'development')!;
    const drawn: unknown[][] = [];
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get(_target, key) { return key === 'drawImage' ? (...args: unknown[]) => drawn.push(args) : () => {}; },
      set() { return true; },
    });
    renderCrewRoom({ ctx, width: 900, height: 600, room: development, camera: { view: 'front', zoom: 1, pan: { x: 0, y: 0 } },
      propImages: { 'desk-executive': {} as HTMLImageElement, 'plant-floor': {} as HTMLImageElement } });
    expect(drawn).toHaveLength(0);
  });

  // Superposición de llamada (#145): se ancla al mismo punto ya proyectado por la
  // cámara que el resto del marcador, así que zoom/pan/las cuatro vistas no requieren
  // ningún cálculo adicional aquí; solo se dibuja para el marcador con registro.
  it('dibuja la superposición de llamada solo para el marcador con un registro activo', () => {
    const arcs: unknown[][] = [];
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get(_target, key) { return key === 'arc' ? (...args: unknown[]) => arcs.push(args) : () => {}; },
      set() { return true; },
    });
    const markers = [
      { id: 'in-call', name: 'In call', role: 'custom' as const, status: 'PHONE_CALL' as const, x: 2, y: 3, number: 1 },
      { id: 'idle', name: 'Idle', role: 'custom' as const, status: 'IDLE' as const, x: 4, y: 3, number: 2 },
    ];
    renderCrewRoom({ ctx, width: 900, height: 600, room: CREW_ROOMS[0],
      camera: { view: 'front', zoom: 1, pan: { x: 0, y: 0 } }, markers,
      calls: { 'in-call': { phase: 'talking', pulseT: 0, opacity: 1 } } });
    // Fondo 2.5D no agrega arcos; la única fuente de `arc` aquí es la superposición de llamada
    // (anillo + glifo de respaldo, ver crewCallLayer.test.ts), y solo para el marcador en llamada.
    expect(arcs.length).toBeGreaterThan(0);
    renderCrewRoom({ ctx: new Proxy({} as CanvasRenderingContext2D, { get() { return () => {}; }, set() { return true; } }),
      width: 900, height: 600, room: CREW_ROOMS[0], camera: { view: 'front', zoom: 1, pan: { x: 0, y: 0 } },
      markers: [markers[1]], calls: { 'in-call': { phase: 'talking', pulseT: 0, opacity: 1 } } });
  });

  it('no dibuja nada de la superposición de llamada sin la prop `calls`, aunque el status real sea PHONE_CALL', () => {
    const arcs: unknown[][] = [];
    const ctx = new Proxy({} as CanvasRenderingContext2D, {
      get(_target, key) { return key === 'arc' ? (...args: unknown[]) => arcs.push(args) : () => {}; },
      set() { return true; },
    });
    const markers = [{ id: 'in-call', name: 'In call', role: 'custom' as const, status: 'PHONE_CALL' as const, x: 2, y: 3, number: 1 }];
    renderCrewRoom({ ctx, width: 900, height: 600, room: CREW_ROOMS[0], camera: { view: 'front', zoom: 1, pan: { x: 0, y: 0 } }, markers });
    expect(arcs).toHaveLength(0);
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
