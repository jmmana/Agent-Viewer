import catalog from '../../assets/crew/clips/manifest.v1.json';
import type {CrewAnimationClip} from './crewAnimation';
import type {CrewView} from './crewModel';
import {loadCrewImage} from './crewSprites';

export interface CrewWalkClip extends CrewAnimationClip {
  role: 'ceo'; variant: 'default'; clip: 'walk'; facing: CrewView;
  version: number; status: 'prototype'; fps: number;
  resolution: {width:number;height:number}; anchor: {x:number;y:number};
}

/** Catálogo versionado del renderer Crew; no importa ningún estudio ni canvas antiguo. */
export const CREW_WALK_CLIPS: readonly CrewWalkClip[] = catalog.clips as CrewWalkClip[];
const sources = {
  front: () => import('./sprites/ceo-walk-front'),
  right: () => import('./sprites/ceo-walk-right'),
  back: () => import('./sprites/ceo-walk-back'),
  left: () => import('./sprites/ceo-walk-left'),
};

export function crewWalkClip(facing: CrewView): CrewWalkClip {
  return CREW_WALK_CLIPS.find(clip=>clip.facing===facing)!;
}

/** Precarga solo el módulo de la orientación elegida durante la transición. */
export async function preloadCrewWalk(facing: CrewView): Promise<string> {
  return (await sources[facing]()).default;
}

export function loadCrewWalk(facing: CrewView,ready: (image:HTMLImageElement)=>void,failed:()=>void) {
  return loadCrewImage(()=>preloadCrewWalk(facing),crewWalkClip(facing),ready,failed);
}
