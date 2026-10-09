import { describe, expect, it } from 'vitest';
import { BUBBLE_EXIT_MS, bubbleExitStyle, ellipsize, fitBubbleNames } from '../../src/engine/visualLayout';

/** 6 px per character, like the recording canvas of the renderer tests. */
const measure = (text: string) => text.length * 6;

describe('speech bubble header names', () => {
  it('keeps both full names when they fit', () => {
    expect(fitBubbleNames('Ana Rivas', 'Bruno Díaz', 200, measure)).toBe('Ana Rivas → Bruno Díaz');
    expect(fitBubbleNames('Ana Rivas', undefined, 200, measure)).toBe('Ana Rivas');
  });

  it('shortens both names to their first two words before cutting anything', () => {
    const names = fitBubbleNames('María José Fernández Ortega', 'Juan Carlos Pérez Gómez', 150, measure);
    expect(names).toBe('María José → Juan Carlos');
  });

  it('cuts both names fairly with an ellipsis, never only the target', () => {
    const names = fitBubbleNames('Alexandrina Montgomery', 'Bartholomew Fitzgerald', 120, measure);
    const [speaker, target] = names.split(' → ');
    expect(measure(names)).toBeLessThanOrEqual(120);
    expect(speaker.endsWith('…')).toBe(true);
    expect(target.endsWith('…')).toBe(true);
    expect(Math.abs(speaker.length - target.length)).toBeLessThanOrEqual(1);
  });

  it('gives the space a short speaker does not need to the target', () => {
    const names = fitBubbleNames('Zoe', 'Bartholomew Fitzgerald Montgomery', 90, measure);
    expect(names.startsWith('Zoe → ')).toBe(true);
    expect(measure(names)).toBeLessThanOrEqual(90);
    expect(names.endsWith('…')).toBe(true);
  });

  it('ellipsizes a single long speaker', () => {
    expect(fitBubbleNames('Bartholomew Fitzgerald Montgomery', undefined, 60, measure)).toBe(ellipsize('Bartholomew Fitzgerald', 60, measure));
  });
});

describe('speech bubble exit', () => {
  it('keeps the card fully opaque at every moment of the exit', () => {
    for (let remaining = BUBBLE_EXIT_MS + 100; remaining >= 0; remaining -= 10) {
      expect(bubbleExitStyle(remaining).cardAlpha).toBe(1);
    }
  });

  it('only animates during the last milliseconds and then shrinks and fades the outline', () => {
    expect(bubbleExitStyle(BUBBLE_EXIT_MS + 1)).toEqual({ scale: 1, offsetY: 0, cardAlpha: 1, outlineAlpha: 1 });
    const end = bubbleExitStyle(1);
    expect(end.scale).toBeLessThan(0.7);
    expect(end.outlineAlpha).toBeLessThan(0.05);
  });

  it('does not move with reduced motion', () => {
    expect(bubbleExitStyle(10, true)).toEqual({ scale: 1, offsetY: 0, cardAlpha: 1, outlineAlpha: 1 });
  });
});
