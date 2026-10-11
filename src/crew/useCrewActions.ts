import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../types/agent';
import type { CrewRoomDefinition, CrewView } from './crewModel';
import { crewClipSample } from './crewAnimation';
import { crewActionClip, crewTurnClip, loadCrewAction } from './crewActionRegistry';
import { updateCrewActorActions, type CrewActorAction, type CrewActionId } from './crewActorActions';
import { crewSpriteView } from './crewSprites';
import type { CrewSpriteBlink } from './crewSpriteLayer';

/** Reloj por escena: animación de presentación, sin escritura al dominio. */
export function useCrewActions(agents: readonly Agent[], room: CrewRoomDefinition, view: CrewView, reducedMotion = false) {
  const history = useRef<{ roomId: string; actions: CrewActorAction[] }>({ roomId: room.id, actions: [] });
  const [state, setState] = useState(history.current);
  const [images, setImages] = useState<Partial<Record<CrewActionId, HTMLImageElement>>>({});
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(0);
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  const hiddenAt = useRef<number | null>(null);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(media.matches);
    const visibility = () => {
      const time = performance.now();
      if (document.hidden) hiddenAt.current = time;
      else if (hiddenAt.current !== null) {
        const pause = time - hiddenAt.current;
        history.current = { ...history.current, actions: history.current.actions.map(action => ({ ...action, startedAt: action.startedAt + pause })) };
        setState(history.current); hiddenAt.current = null;
      }
      setVisible(!document.hidden);
    };
    media.addEventListener('change', motion); document.addEventListener('visibilitychange', visibility);
    return () => { media.removeEventListener('change', motion); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => {
    const time = performance.now();
    history.current = { roomId: room.id, actions: updateCrewActorActions(agents, room,
      history.current.roomId === room.id ? history.current.actions : [], time) };
    setState(history.current); setNow(time);
  }, [agents, room]);
  const current = useMemo(() => state.roomId === room.id ? state.actions : [], [state, room.id]);
  const active = !reduced && !reducedMotion;
  const key = active ? [...new Set(current.flatMap(action => action.clip
    ? action.clip === 'turn' ? ['turn'] : ['sit', 'stand', 'typing'] : []))].sort().join(',') : '';
  useEffect(() => {
    setImages({}); setFailed(false);
    if (!key) return;
    let disposed = false;
    const cancels = key.split(',').map(value => {
      const action = value as CrewActionId;
      return loadCrewAction(action, image => { if (!disposed) setImages(previous => ({ ...previous, [action]: image })); },
        () => { if (!disposed) setFailed(true); });
    });
    return () => { disposed = true; cancels.forEach(cancel => cancel()); };
  }, [key, room.id]);
  useEffect(() => {
    if (!active || !visible || !key) return;
    const tick = () => {
      const time = performance.now();
      history.current = { roomId: room.id, actions: updateCrewActorActions(agents, room, history.current.actions, time) };
      setState(history.current); setNow(time);
    };
    const timer = setInterval(tick, 50);
    return () => clearInterval(timer);
  }, [agents, room, active, visible, key]);
  const frames = useMemo(() => {
    const result: Record<string, CrewSpriteBlink | undefined> = {};
    if (active) for (const action of current) {
      const facing = crewSpriteView({ role: 'boss', facing: action.facing }, view);
      const image = action.clip ? images[action.clip] : undefined;
      if (!action.clip || !facing || !image) continue;
      const from = action.turnFrom && crewSpriteView({ role: 'boss', facing: action.turnFrom }, view);
      const clip = action.clip === 'turn' && from ? crewTurnClip(from, facing) : crewActionClip(action.clip, facing);
      result[action.id] = { image, frame: clip.frames[crewClipSample(clip, now - action.startedAt).index] };
    }
    return result;
  }, [current, images, active, view, now]);
  return { actions: current, frames, failed: active && failed };
}
