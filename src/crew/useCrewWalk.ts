import {useEffect,useMemo,useState} from 'react';
import {crewClipSample} from './crewAnimation';
import {crewWalkClip,loadCrewWalk} from './crewWalkRegistry';
import type {CrewView} from './crewModel';
import type {CrewSpriteBlink} from './crewSpriteLayer';

/** Presentación de isWalking: no mueve agentes ni produce eventos, tareas o consumo. */
export function useCrewWalk(facings: readonly CrewView[],roomId:string,reducedMotion=false) {
  const key=Array.from(new Set(facings)).sort().join(',');
  const [loaded,setLoaded]=useState<{key:string;roomId:string;images:Partial<Record<CrewView,HTMLImageElement>>}>();
  const [failed,setFailed]=useState<{key:string;roomId:string;value:boolean}>();
  const [elapsed,setElapsed]=useState(0);
  const [reduced,setReduced]=useState(()=>typeof window!=='undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [visible,setVisible]=useState(()=>typeof document==='undefined' || !document.hidden);
  useEffect(()=>{
    const media=window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion=()=>setReduced(media.matches),visibility=()=>setVisible(!document.hidden);
    media.addEventListener('change',motion);document.addEventListener('visibilitychange',visibility);
    return ()=>{media.removeEventListener('change',motion);document.removeEventListener('visibilitychange',visibility);};
  },[]);
  const active=!!key && !reduced && !reducedMotion;
  useEffect(()=>{
    setLoaded(undefined);setFailed(undefined);
    if(!active) return;
    let disposed=false;
    const stop=key.split(',').map(direction=>{
      const facing=direction as CrewView;
      return loadCrewWalk(facing,image=>{
        if(!disposed) setLoaded(previous=>({key,roomId,images:{...(previous?.key===key && previous.roomId===roomId?previous.images:{}),[facing]:image}}));
      },()=>{if(!disposed) setFailed({key,roomId,value:true});});
    });
    return ()=>{disposed=true;stop.forEach(cancel=>cancel());};
  },[active,key,roomId]);
  const images=active && loaded?.key===key && loaded.roomId===roomId?loaded.images:undefined;
  useEffect(()=>{
    setElapsed(0);
    if(!images || !visible) return;
    const start=performance.now();let timer:ReturnType<typeof setTimeout>;
    const tick=()=>{
      const time=performance.now()-start;setElapsed(time);
      const next=Object.keys(images).map(facing=>crewClipSample(crewWalkClip(facing as CrewView),time).nextInMs).filter((value):value is number=>value!==null);
      if(next.length) timer=setTimeout(tick,Math.max(1,Math.min(...next)));
    };
    tick();return ()=>clearTimeout(timer);
  },[images,visible,key,roomId]);
  const frames=useMemo(()=>{
    const result:Partial<Record<CrewView,CrewSpriteBlink>>={};
    if(images) for(const direction of Object.keys(images)) {
      const facing=direction as CrewView,clip=crewWalkClip(facing);
      result[facing]={image:images[facing]!,frame:clip.frames[crewClipSample(clip,visible?elapsed:0).index]};
    }
    return result;
  },[images,visible,elapsed]);
  return {frames,failed:active && failed?.key===key && failed.roomId===roomId && failed.value};
}
