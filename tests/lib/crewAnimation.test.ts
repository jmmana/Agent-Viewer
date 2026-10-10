import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { CREW_CEO_BLINK, crewClipSample, validateCrewClip } from '../../src/crew/crewAnimation';
import { useCrewBlink } from '../../src/crew/useCrewBlink';

vi.mock('../../src/crew/crewSprites',()=>({loadCrewImage:vi.fn((_url,_size,ready)=>{
  ready({} as HTMLImageElement); return vi.fn();
})}));
afterEach(()=>vi.useRealTimers());

describe('Reloj y ciclo de vida de clips Crew',()=>{
  it('respeta duraciones, límites exactos y repetición sin velocidad ligada a FPS',()=>{
    expect(validateCrewClip(CREW_CEO_BLINK)).toBe(true);
    expect([0,3199,3200,3280,3380,3460,6920].map(t=>crewClipSample(CREW_CEO_BLINK,t).index))
      .toEqual([0,0,1,2,3,0,0]);
    expect(crewClipSample(CREW_CEO_BLINK,3250).nextInMs).toBe(30);
    expect(crewClipSample(CREW_CEO_BLINK,-10).index).toBe(0);
    expect(crewClipSample(CREW_CEO_BLINK,NaN).index).toBe(0);
  });
  it('detiene clips no repetidos y fija el primer cuadro para movimiento reducido',()=>{
    expect(crewClipSample({...CREW_CEO_BLINK,loop:false},9000)).toEqual({index:3,nextInMs:null});
    expect(crewClipSample(CREW_CEO_BLINK,3300,true)).toEqual({index:0,nextInMs:null});
  });
  it('rechaza rectángulos, duraciones y anclajes inválidos',()=>{
    for(const update of [{durationMs:0},{x:-1},{width:2000},{anchor:{x:NaN,y:10}}]) {
      const clip={...CREW_CEO_BLINK,frames:[{...CREW_CEO_BLINK.frames[0],...update}]};
      expect(validateCrewClip(clip)).toBe(false);
      expect(()=>crewClipSample(clip,0)).toThrow();
    }
  });
  it('programa un único cambio de cuadro y cancela al desmontar',()=>{
    vi.useFakeTimers();
    const {result,unmount}=renderHook(()=>useCrewBlink(true,'ceo'));
    expect(result.current?.frame).toBe(CREW_CEO_BLINK.frames[0]);
    act(()=>vi.advanceTimersByTime(3280));
    expect(result.current?.frame).toBe(CREW_CEO_BLINK.frames[2]);
    expect(vi.getTimerCount()).toBe(1);
    unmount();expect(vi.getTimerCount()).toBe(0);
  });
  it('no programa movimiento para salas sin CEO y cancela al cambiar de vista',()=>{
    vi.useFakeTimers();
    const {result,rerender,unmount}=renderHook(({enabled})=>useCrewBlink(enabled,'ceo'),{initialProps:{enabled:false}});
    expect(result.current).toBeUndefined();expect(vi.getTimerCount()).toBe(0);
    rerender({enabled:true});expect(vi.getTimerCount()).toBe(1);
    rerender({enabled:false});expect(vi.getTimerCount()).toBe(0);
    unmount();
  });
  it('pausa al ocultar la pestaña y vuelve al primer cuadro al regresar',()=>{
    vi.useFakeTimers();
    const hidden=vi.spyOn(document,'hidden','get').mockReturnValue(false);
    const {result,unmount}=renderHook(()=>useCrewBlink(true,'ceo'));
    act(()=>vi.advanceTimersByTime(3280));
    hidden.mockReturnValue(true);
    act(()=>document.dispatchEvent(new Event('visibilitychange')));
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current?.frame).toBe(CREW_CEO_BLINK.frames[0]);
    hidden.mockReturnValue(false);
    act(()=>document.dispatchEvent(new Event('visibilitychange')));
    expect(vi.getTimerCount()).toBe(1);
    expect(result.current?.frame).toBe(CREW_CEO_BLINK.frames[0]);
    unmount();hidden.mockRestore();
  });
});
