import { useEffect, useState } from 'react';
import { CREW_CEO_BLINK, crewClipSample } from './crewAnimation';
import { loadCrewImage } from './crewSprites';

/** Parpadeo cosmético. Se detiene al salir, ocultar la pestaña o reducir movimiento. */
export function useCrewBlink(enabled: boolean, roomId: string, reducedMotion = false) {
  const [reduced,setReduced] = useState(() => typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [visible,setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  const [image,setImage] = useState<HTMLImageElement>();
  const [index,setIndex] = useState(0);
  useEffect(() => {
    const media=window.matchMedia('(prefers-reduced-motion: reduce)');
    const update=()=>setReduced(media.matches);
    const visibility=()=>setVisible(!document.hidden);
    media.addEventListener('change',update);
    document.addEventListener('visibilitychange',visibility);
    return () => {
      media.removeEventListener('change',update);
      document.removeEventListener('visibilitychange',visibility);
    };
  }, []);
  const active=enabled && !reduced && !reducedMotion;
  useEffect(() => {
    setImage(undefined);
    if (!active) return;
    return loadCrewImage(async () => (await import('./sprites/ceo-blink-front')).default,
      CREW_CEO_BLINK,setImage,()=>setImage(undefined));
  }, [active,roomId]);
  useEffect(() => {
    setIndex(0);
    if (!active || !visible || !image) return;
    const start=performance.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick=()=>{
      const sample=crewClipSample(CREW_CEO_BLINK,performance.now()-start);
      setIndex(sample.index);
      if(sample.nextInMs !== null) timer=setTimeout(tick,Math.max(1,sample.nextInMs));
    };
    tick();
    return () => clearTimeout(timer);
  }, [active,visible,image,roomId]);
  return active && image ? {image,frame:CREW_CEO_BLINK.frames[visible ? index : 0]} : undefined;
}
