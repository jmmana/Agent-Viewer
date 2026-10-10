import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {act,renderHook} from '@testing-library/react';
import {useCrewWalk} from '../../src/crew/useCrewWalk';
import {crewWalkClip,loadCrewWalk} from '../../src/crew/crewWalkRegistry';
import {crewClipSample,validateCrewClip} from '../../src/crew/crewAnimation';
import {drawCrewSprite} from '../../src/crew/crewSpriteLayer';
import type {CrewView} from '../../src/crew/crewModel';
import {CREW_ROOMS} from '../../src/crew/crewModel';
import {buildOfficeSnapshot} from '../../src/lib/officeStore';
import {projectCrewPresence} from '../../src/crew/crewPresence';
import {renderCrewRoom} from '../../src/crew/renderCrewRoom';
import {defaultCrewCamera} from '../../src/crew/crewCamera';
import {makeEvent} from './fixtures';

vi.mock('../../src/crew/crewWalkRegistry',async original=>({...await original<object>(),loadCrewWalk:vi.fn()}));
const load=vi.mocked(loadCrewWalk);
const image={} as HTMLImageElement;
beforeEach(()=>{vi.useFakeTimers();load.mockReset();load.mockImplementation((_direction,ready)=>{ready(image);return vi.fn();});});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

describe('caminar en el renderer Crew',()=>{
  it('reproduce ocho frames a 8 FPS para cada orientación real',()=>{
    for(const direction of ['front','right','back','left'] as const) {
      const clip=crewWalkClip(direction);expect(validateCrewClip(clip)).toBe(true);
      expect(Array.from({length:8},(_,index)=>crewClipSample(clip,index*125).index)).toEqual([0,1,2,3,4,5,6,7]);
      expect(crewClipSample(clip,1000).index).toBe(0);
    }
  });
  it('no carga sin caminar, deduplica facings y solo programa un reloj',()=>{
    const {result,rerender,unmount}=renderHook(({facings})=>useCrewWalk(facings,'ceo'),{initialProps:{facings:[] as CrewView[]}});
    expect(load).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    rerender({facings:['left','left','front']});expect(load.mock.calls.map(call=>call[0])).toEqual(['front','left']);
    expect(vi.getTimerCount()).toBe(1);
    act(()=>vi.advanceTimersByTime(250));expect(result.current.frames.left?.frame).toBe(crewWalkClip('left').frames[2]);
    rerender({facings:[]});expect(result.current.frames).toEqual({});expect(vi.getTimerCount()).toBe(0);unmount();
  });
  it('cancela al cambiar sala/ángulo y descarta callbacks tardíos',()=>{
    const cancel=vi.fn();let late!: (image:HTMLImageElement)=>void;
    load.mockImplementation((_view,ready)=>{late=ready;return cancel;});
    const {result,rerender,unmount}=renderHook(({view,room})=>useCrewWalk([view],room),{initialProps:{view:'front' as CrewView,room:'ceo'}});
    const frontCallback=late;
    rerender({view:'back',room:'development'});expect(cancel).toHaveBeenCalledOnce();
    act(()=>frontCallback(image));expect(result.current.frames).toEqual({});
    unmount();expect(cancel).toHaveBeenCalledTimes(2);act(()=>late(image));expect(vi.getTimerCount()).toBe(0);
  });
  it('respeta preferencia propia y pausa/reinicia en pestaña oculta',()=>{
    const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(false);
    const {result,rerender,unmount}=renderHook(({reduced})=>useCrewWalk(['front'],'ceo',reduced),{initialProps:{reduced:false}});
    act(()=>vi.advanceTimersByTime(375));expect(result.current.frames.front?.frame).toBe(crewWalkClip('front').frames[3]);
    hidden.mockReturnValue(true);act(()=>document.dispatchEvent(new Event('visibilitychange')));
    expect(vi.getTimerCount()).toBe(0);expect(result.current.frames.front?.frame).toBe(crewWalkClip('front').frames[0]);
    hidden.mockReturnValue(false);act(()=>document.dispatchEvent(new Event('visibilitychange')));expect(vi.getTimerCount()).toBe(1);
    rerender({reduced:true});expect(result.current.frames).toEqual({});expect(vi.getTimerCount()).toBe(0);unmount();
  });
  it('reporta fallo de atlas y conserva la pose sin frames',()=>{
    load.mockImplementation((_view,_ready,failed)=>{failed();return vi.fn();});
    const {result,unmount}=renderHook(()=>useCrewWalk(['right'],'ceo'));
    expect(result.current.failed).toBe(true);expect(result.current.frames).toEqual({});expect(vi.getTimerCount()).toBe(0);unmount();
  });
  it('dibuja rectángulo y anclaje medidos sin espejo en las cuatro vistas',()=>{
    const drawImage=vi.fn(),ctx={drawImage} as unknown as CanvasRenderingContext2D;
    for(const direction of ['front','right','back','left'] as const) {
      const frame=crewWalkClip(direction).frames[2],scale=76/frame.height;
      drawCrewSprite(ctx,{x:10,y:20},direction,{[direction]:image},undefined,{image,frame});
      expect(drawImage).toHaveBeenLastCalledWith(image,frame.x,frame.y,frame.width,frame.height,10-frame.anchor.x*scale,20-frame.anchor.y*scale,frame.width*scale,76);
    }
  });
  it('reproducir clips conserva eventos, privacidad y consumo de snapshots LIVE y REPLAY',()=>{
    const events=Object.freeze([
      makeEvent('agent.registered','fixture',{name:'Fixture CEO',role:'boss',workspace:'boss_office'}),
      makeEvent('agent.status.changed','fixture',{status:'THINKING'}),
      makeEvent('llm.usage','fixture',{provider:'fixture',model:'fixture',inputTokens:100,outputTokens:20,cost:.1,currency:'USD',costSource:'provider-reported'}),
    ]);
    const recorded=JSON.stringify(events),room=CREW_ROOMS[0];
    const ctx=new Proxy({} as CanvasRenderingContext2D,{get:()=>()=>{},set:()=>true});
    for(const selected of [events,events.slice(0,2)]) {
      const snapshot=Object.freeze(buildOfficeSnapshot(selected,{now:0}));
      const before=JSON.stringify(snapshot);
      const presence=projectCrewPresence(snapshot.agents,room);
      expect(presence.markers).toHaveLength(1);
      for(const frame of crewWalkClip('front').frames) renderCrewRoom({ctx,width:1280,height:900,room,
        camera:defaultCrewCamera(),markers:presence.markers,sprites:{front:image},walks:{fixture:{image,frame}}});
      expect(JSON.stringify(snapshot)).toBe(before);
      expect(JSON.stringify(events)).toBe(recorded);
    }
  });
});
