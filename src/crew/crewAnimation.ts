export interface CrewAnimationFrame {
  x: number; y: number; width: number; height: number;
  anchor: { x: number; y: number };
  durationMs: number;
}
export interface CrewAnimationClip {
  id: string;
  width: number;
  height: number;
  loop: boolean;
  frames: readonly CrewAnimationFrame[];
}

/** Rectángulos y anclajes en píxeles del original, sin reescribir el atlas. */
export const CREW_CEO_BLINK: CrewAnimationClip = {
  id: 'ceo.blink.front.v1', width: 1070, height: 1470, loop: true,
  frames: [
    {x:0,y:0,width:535,height:735,anchor:{x:267.5,y:678},durationMs:3200},
    {x:535,y:0,width:535,height:735,anchor:{x:260,y:678},durationMs:80},
    {x:0,y:735,width:535,height:735,anchor:{x:267.5,y:679},durationMs:100},
    {x:535,y:735,width:535,height:735,anchor:{x:259.5,y:679},durationMs:80},
  ],
};

export function validateCrewClip(clip: CrewAnimationClip): boolean {
  return Number.isInteger(clip.width) && clip.width > 0 && Number.isInteger(clip.height) && clip.height > 0
    && clip.frames.length > 0 && clip.frames.every(frame =>
      [frame.x,frame.y,frame.width,frame.height].every(Number.isInteger)
      && frame.x >= 0 && frame.y >= 0 && frame.width > 0 && frame.height > 0
      && frame.x + frame.width <= clip.width && frame.y + frame.height <= clip.height
      && Number.isFinite(frame.durationMs) && frame.durationMs > 0
      && Number.isFinite(frame.anchor.x) && Number.isFinite(frame.anchor.y)
      && frame.anchor.x >= 0 && frame.anchor.x <= frame.width
      && frame.anchor.y >= 0 && frame.anchor.y <= frame.height);
}

/** Reloj de presentación puro: no consume ni produce eventos de agentes. */
export function crewClipSample(clip: CrewAnimationClip, elapsedMs: number, reducedMotion = false) {
  if (!validateCrewClip(clip)) throw new Error('Clip Crew inválido');
  const total = clip.frames.reduce((sum,frame) => sum + frame.durationMs,0);
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0,elapsedMs) : 0;
  if (reducedMotion) return {index:0, nextInMs:null};
  if (!clip.loop && elapsed >= total) return {index:clip.frames.length-1,nextInMs:null};
  let remaining = clip.loop ? elapsed % total : elapsed;
  for (const [index,frame] of clip.frames.entries()) {
    if (remaining < frame.durationMs) return {index,nextInMs:frame.durationMs-remaining};
    remaining -= frame.durationMs;
  }
  return {index:0,nextInMs:null};
}
