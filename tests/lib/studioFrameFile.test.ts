import { describe, expect, it } from 'vitest';
import { studioFrameFile, findCharacter } from '../../src/visual-studio/assets';

const raster = {
  file: 'assets/animations/ceo/walk-front/00.png',
  frameFiles: [
    'assets/animations/ceo/walk-front/00.png',
    'assets/animations/ceo/walk-front/01.png',
    'assets/animations/ceo/walk-front/02.png',
  ],
  fps: 10,
  loop: true,
};

describe('Office Crew showroom frame selection', () => {
  it('cycles actual files rather than bouncing an idle pose', () => {
    expect(studioFrameFile(raster, 0)).toBe(raster.frameFiles[0]);
    expect(studioFrameFile(raster, 0.1)).toBe(raster.frameFiles[1]);
    expect(studioFrameFile(raster, 0.2)).toBe(raster.frameFiles[2]);
    expect(studioFrameFile(raster, 0.3)).toBe(raster.frameFiles[0]);
    expect(studioFrameFile(raster, 0.4, true)).toBe(raster.frameFiles[0]);
  });

  it('holds the last frame on finite clips and does not invent missing frames', () => {
    const finite = { ...raster, loop: false };
    expect(studioFrameFile(finite, 42)).toBe(raster.frameFiles[2]);
    expect(studioFrameFile({ file: 'static.png', fps: 0, loop: false }, 99)).toBe('static.png');
  });

  it('does not claim that an actual CEO walk raster exists yet', () => {
    const asset = findCharacter('ceo', 'walk', 'front');
    expect(asset?.file).toMatch(/^assets\/characters\/ceo\//);
    expect(asset?.clip).toBe('idle');
    expect(asset?.frameFiles).toBeUndefined();
  });
});
