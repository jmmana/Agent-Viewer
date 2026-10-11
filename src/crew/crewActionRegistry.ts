import catalog from '../../assets/crew/clips/actions.v1.json';
import type { CrewAnimationClip } from './crewAnimation';
import type { CrewActionId } from './crewActorActions';
import type { CrewView } from './crewModel';
import { loadCrewImage } from './crewSprites';

export interface CrewActionClip extends CrewAnimationClip {
  clip: CrewActionId;
  facing: CrewView;
  status: 'prototype';
}
export const CREW_ACTION_CLIPS: readonly CrewActionClip[] = catalog.clips as CrewActionClip[];
const sources = {
  turn: () => import('./sprites/ceo-turn'),
  sit: () => import('./sprites/ceo-sit'),
  stand: () => import('./sprites/ceo-stand'),
  typing: () => import('./sprites/ceo-typing'),
};
export function crewActionClip(action: CrewActionId, facing: CrewView): CrewActionClip {
  return CREW_ACTION_CLIPS.find(clip => clip.clip === action && clip.facing === facing)!;
}
export function loadCrewAction(action: CrewActionId, ready: (image: HTMLImageElement) => void, failed: () => void) {
  return loadCrewImage(async () => (await sources[action]()).default, crewActionClip(action, 'front'), ready, failed);
}

/** Cuartos de giro dibujados; inversión temporal, nunca reflejo del PNG. */
export function crewTurnClip(from: CrewView, to: CrewView): CrewAnimationClip {
  const order: CrewView[] = ['front', 'right', 'back', 'left'];
  const start = order.indexOf(from), end = order.indexOf(to);
  const distance = (end - start + 4) % 4;
  const target = crewActionClip('turn', to);
  const frames = distance === 3 ? [...crewActionClip('turn', from).frames].reverse()
    : distance === 2 ? [...crewActionClip('turn', order[(start + 1) % 4]).frames, ...target.frames]
    : target.frames;
  return { ...target, frames: frames.map(frame => ({ ...frame, durationMs: 800 / frames.length })) };
}
